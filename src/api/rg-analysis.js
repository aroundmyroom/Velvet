/**
 * rg-analysis.js
 *
 * ReplayGain 2.0 / EBU R128 measurement worker lifecycle + REST API.
 * All endpoints are admin-only.
 *
 *   POST /api/v1/admin/rg/start        — start measurement worker
 *   POST /api/v1/admin/rg/stop         — stop measurement worker
 *   GET  /api/v1/admin/rg/status       — worker status + DB counts
 *   GET  /api/v1/admin/rg/tool         — which tool is available (rsgain/ffmpeg)
 *   GET  /api/v1/admin/rg/failed       — list failed files with detail
 *   POST /api/v1/admin/rg/reset-failed — reset failed rows so they are retried
 *   POST /api/v1/admin/rg/shelve       — shelve rows so they are never retried
 *   POST /api/v1/admin/rg/reset-all    — clear all measurements (with undo backup)
 *   POST /api/v1/admin/rg/undo-reset-all — restore measurements from backup
 */

import path from 'node:path';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { rsgainBin, rsgainAvailable, ensureRsgain } from '../util/rsgain-bootstrap.js';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';
import { getDirname } from '../util/esm-helpers.js';
import { resolvePathWithinRoot } from '../util/path-security.js';
import { isScanRunning, onScanEnd, onEveryScanEnd } from '../state/scan-lock.js';
const __dirname   = getDirname(import.meta.url);
const _workerPath = path.join(__dirname, '../util/rg-analysis-worker.mjs');

// ── Worker state ──────────────────────────────────────────────────────────────

let _worker         = null;
let _running        = false;
let _stopping       = false;
let _lastStats      = null;
let _startedAt      = null;
let _currentFile    = null;
let _processedCount = 0;
let _pendingStart   = false;

function _dbPath() {
  return path.join(config.program.storage.dbDirectory, 'velvet.sqlite');
}

function _rootFolders() {
  // Only ROOT vpaths are indexed in the DB.  A vpath is a root if no other
  // vpath's root is a strict prefix of its own root.
  const folders = config.program.folders || {};
  const roots = {};
  for (const [name, cfg] of Object.entries(folders)) {
    if (!cfg.root) continue;
    const myRoot = cfg.root.replace(/\/?$/, '/');
    const isChild = Object.entries(folders).some(([other, otherCfg]) => {
      if (other === name) return false;
      const otherRoot = (otherCfg.root || '').replace(/\/?$/, '/');
      return myRoot.startsWith(otherRoot) && myRoot !== otherRoot;
    });
    if (!isChild) roots[name] = cfg.root;
  }
  return roots;
}

function _spawnWorker() {
  if (_worker) return;

  // Discard the undo backup — the user committed to re-measurement.
  try { db.clearRgBackup(); } catch (e) { console.debug('[velvet]', e?.message ?? e); }

  const bin = rsgainAvailable() ? rsgainBin() : null;
  _worker    = new Worker(_workerPath, {
    workerData: {
      dbPath:    _dbPath(),
      folders:   _rootFolders(),
      rsgainBin: bin,
      ffmpegBin: ffmpegBin(),
    },
  });
  _running   = true;
  _stopping  = false;
  _startedAt = Date.now();

  _worker.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'status' || msg.type === 'ready') {
      if (msg.stats) {
        // Strip the worker's own tool field — the API always serves the
        // authoritative rsgainAvailable() value via the top-level 'tool' key
        const { tool: _, ...cleanStats } = msg.stats; // eslint-disable-line sonarjs/no-unused-vars
        _lastStats = cleanStats;
      }
      if (msg.processedCount != null) _processedCount = msg.processedCount;
    }
    if (msg.type === 'progress') {
      _currentFile = msg.vpath ? `${msg.vpath}/${msg.currentFile}` : msg.currentFile;
      if (msg.processedCount != null) _processedCount = msg.processedCount;
    }
    if (msg.type === 'stopped') {
      _running        = false;
      _stopping       = false;
      _startedAt      = null;
      _currentFile    = null;
      _worker         = null;
      winston.info('[rg-analysis] Worker stopped cleanly');
    }
    if (msg.type === 'error') {
      winston.error(`[rg-analysis] Worker error: ${msg.message}`);
      _running        = false;
      _stopping       = false;
      _startedAt      = null;
      _currentFile    = null;
      _worker         = null;
    }
    if (msg.type === 'log') {
      winston.info(msg.message);
    }
  });

  _worker.on('error', err => {
    winston.error(`[rg-analysis] Worker thread error: ${err.message}`);
    _running   = false;
    _stopping  = false;
    _startedAt = null;
    _worker    = null;
  });

  _worker.on('exit', code => {
    if (code !== 0) winston.warn(`[rg-analysis] Worker exited with code ${code}`);
    _running        = false;
    _stopping       = false;
    _startedAt      = null;
    _currentFile    = null;
    _worker         = null;
  });

  winston.info(`[rg-analysis] Worker started (tool: ${bin ? 'rsgain' : 'ffmpeg'})`);
}

async function _tryRgAutoStart() {
  try {
    if (_running) return;
    if (isScanRunning()) {
      onScanEnd(_tryRgAutoStart);
      return;
    }
    const status = db.getRgStatus();
    if (status && status.queued > 0) {
      if (status.queued >= 500) {
        winston.info(`[rg-analysis] Auto-start skipped: ${status.queued} files queued — backlog too large, start from Admin`);
        return;
      }
      await ensureRsgain().catch(() => {});
      if (!_running) {
        _spawnWorker();
        winston.info(`[rg-analysis] Auto-started: ${status.queued} files queued`);
      }
    }
  } catch (e) {
    winston.warn('[rg-analysis] Auto-start check failed: ' + e.message);
  }
}

// ── Setup (called once at server start) ───────────────────────────────────────

export function setup(app) {
  // ── Boot-time + post-scan auto-start ─────────────────────────────────────
  // 60 s delay: let the server finish booting before the first auto-check.
  setTimeout(_tryRgAutoStart, 60_000);
  // Re-check after every scan so newly added files are processed immediately.
  onEveryScanEnd(_tryRgAutoStart);

  // ── POST /api/v1/admin/rg/start ───────────────────────────────────────────
  app.post('/api/v1/admin/rg/start', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    if (_running) return res.json({ status: 'already_running' });
    if (isScanRunning()) {
      _pendingStart = true;
      onScanEnd(() => {
        if (!_pendingStart || _running) return;
        _pendingStart = false;
        ensureRsgain().then(() => {
          if (_running) return;
          _spawnWorker();
          winston.info('[rg-analysis] Deferred start executed after scan completion');
        }).catch(e => {
          winston.warn('[rg-analysis] Deferred start prefetch failed: ' + e.message);
          if (_running) return;
          _spawnWorker();
          winston.info('[rg-analysis] Deferred start executed after scan completion (ffmpeg fallback)');
        });
      });
      return res.json({ status: 'pending', message: 'Start queued: file scan in progress' });
    }
    ensureRsgain().then(() => {
      _spawnWorker();
      res.json({ status: 'started' });
    }).catch(e => {
      winston.warn('[rg-analysis] rsgain prefetch failed: ' + e.message);
      _spawnWorker(); // start anyway — ffmpeg fallback will be used
      res.json({ status: 'started' });
    });
  });

  // ── POST /api/v1/admin/rg/stop ────────────────────────────────────────────
  app.post('/api/v1/admin/rg/stop', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    if (_pendingStart && !_running) {
      _pendingStart = false;
      return res.json({ status: 'pending_cancelled' });
    }
    if (!_running || !_worker) return res.json({ status: 'not_running' });
    _stopping = true;
    _worker.postMessage({ type: 'stop' });
    res.json({ status: 'stopping' });
  });

  // ── GET /api/v1/admin/rg/status ───────────────────────────────────────────
  app.get('/api/v1/admin/rg/status', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    let dbStats;
    try { dbStats = db.getRgStatus(); } catch { dbStats = null; }
    let undoInfo = { count: 0, resetAt: null };
    try { undoInfo = db.getRgUndoInfo(); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    res.json({
      running:        _running,
      stopping:       _stopping,
      startedAt:      _startedAt,
      currentFile:    _currentFile,
      processedCount: _processedCount,
      stats:          _lastStats || dbStats,
      tool:           rsgainAvailable() ? 'rsgain' : 'ffmpeg',
      undo:           { available: undoInfo.count > 0, count: undoInfo.count, resetAt: undoInfo.resetAt },
    });
  });

  // ── GET /api/v1/admin/rg/tool ─────────────────────────────────────────────
  app.get('/api/v1/admin/rg/tool', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    res.json({ tool: rsgainAvailable() ? 'rsgain' : 'ffmpeg', available: rsgainAvailable() });
  });

  // ── GET /api/v1/admin/rg/failed ──────────────────────────────────────────
  app.get('/api/v1/admin/rg/failed', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    res.json({ files: db.getRgFailedDetail() });
  });

  // ── POST /api/v1/admin/rg/shelve ─────────────────────────────────────────
  // Body: { ids: [rowid, ...] }  — shelves those rows (rg_measured_ts = -2).
  // Shelved files stay in the library but are excluded from RG analysis.
  app.post('/api/v1/admin/rg/shelve', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Number.isInteger) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids array required' });
    const shelved = db.shelveRgRows(ids);
    if (shelved > 0) _lastStats = null;
    res.json({ shelved });
  });

  // ── POST /api/v1/admin/rg/reset-failed ───────────────────────────────────
  // For each failed row: check whether the file still exists on disk.
  //   • If it does → re-queue it (set rg_measured_ts = NULL)
  //   • If it doesn't → purge the DB row entirely (orphaned entry)
  // Returns { reset, purged } so the UI can show exactly what happened.
  app.post('/api/v1/admin/rg/reset-failed', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    const rootFolders = _rootFolders();
    const failed = db.getRgFailedRows();
    const toReset  = [];
    const toPurge  = [];
    for (const row of failed) {
      const rootDir = rootFolders[row.vpath];
      if (!rootDir) {
        // vpath no longer configured — purge
        toPurge.push(row.id);
        continue;
      }
      let absPath;
      try {
        absPath = resolvePathWithinRoot(rootDir, row.filepath);
      } catch {
        toPurge.push(row.id);
        continue;
      }
      if (fs.existsSync(absPath)) {
        toReset.push(row.id);
      } else {
        toPurge.push(row.id);
      }
    }
    const purged = db.purgeRgRowsByIds(toPurge);
    const reset  = db.resetRgFailedByIds(toReset);
    if (reset > 0 || purged > 0) _lastStats = null;
    res.json({ reset, purged });
  });

  // ── POST /api/v1/admin/rg/reset-all ──────────────────────────────────────
  app.post('/api/v1/admin/rg/reset-all', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    if (_running) return res.status(409).json({ error: 'Stop the worker before resetting' });
    const { reset, backedUp } = db.resetRgAll();
    _lastStats      = null;
    _currentFile    = null;
    _processedCount = 0;
    res.json({ reset, backedUp });
  });

  // ── POST /api/v1/admin/rg/undo-reset-all ─────────────────────────────────
  app.post('/api/v1/admin/rg/undo-reset-all', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    if (_running) return res.status(409).json({ error: 'Stop the worker before undoing' });
    const restored = db.undoRgAll();
    _lastStats      = null;
    _currentFile    = null;
    _processedCount = 0;
    res.json({ restored });
  });
}
