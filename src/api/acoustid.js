/**
 * acoustid.js
 *
 * AcoustID fingerprinting API and worker lifecycle manager.
 *
 * Endpoints (all admin-only, require req.user.admin === true):
 *   GET  /api/v1/acoustid/status  — progress stats + running state
 *   POST /api/v1/acoustid/start   — launch the worker thread
 *   POST /api/v1/acoustid/stop    — signal the worker to stop cleanly
 */

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as admin from '../util/admin.js';
import { fpcalcBin, ensureFpcalc } from '../util/fpcalc-bootstrap.js';
import { isScanning } from '../db/task-queue.js';
import { getDirname } from '../util/esm-helpers.js';
import { isScanRunning, onScanEnd, onEveryScanEnd } from '../state/scan-lock.js';

const __dirname = getDirname(import.meta.url);
const _workerPath = path.join(__dirname, '../util/acoustid-worker.mjs');

// ── Persist autostart flag to config file ────────────────────────────────────

async function _saveAutostart(value) {
  try {
    const loadConfig = await admin.loadFile(config.configFile);
    if (!loadConfig.acoustid) loadConfig.acoustid = {};
    loadConfig.acoustid.autostart = value;
    await admin.saveFile(loadConfig, config.configFile);
    if (!config.program.acoustid) config.program.acoustid = {};
    config.program.acoustid.autostart = value;
  } catch (err) {
    winston.warn(`[acoustid] Failed to save autostart flag: ${err.message}`);
  }
}

// ── Worker state ──────────────────────────────────────────────────────────────

let _worker    = null;
let _running   = false;
let _stopping  = false;
let _lastStats = null;
let _startedAt = null; // ms epoch when current run started
let _fpcalcReady = null; // null = not yet checked, true/false after ensureFpcalc()
let _pendingStart = false;

function _workerData() {
  const apiKey  = config.program.acoustid?.apiKey?.trim() || '';
  // Build vpath → absolute-root-path mapping from config
  const folders = {};
  for (const [vpath, folderCfg] of Object.entries(config.program.folders || {})) {
    if (folderCfg.root) folders[vpath] = folderCfg.root;
  }
  return {
    dbPath:    path.join(config.program.storage.dbDirectory, 'velvet.sqlite'),
    apiKey,
    fpcalcBin: fpcalcBin(),
    folders,
  };
}

function _spawnWorker() {
  if (_worker) return;

  const data = _workerData();
  _worker  = new Worker(_workerPath, { workerData: data });
  _running   = true;
  _stopping  = false;
  _startedAt = Date.now();

  _worker.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'status' || msg.type === 'ready') {
      if (msg.stats) _lastStats = msg.stats;
    }
    if (msg.type === 'stopped') {
      _running   = false;
      _stopping  = false;
      _startedAt = null;
      _worker    = null;
      winston.info('[acoustid] Worker stopped cleanly');
    }
    if (msg.type === 'error') {
      winston.error(`[acoustid] Worker error: ${msg.message}`);
      _running   = false;
      _stopping  = false;
      _startedAt = null;
      _worker    = null;
      // Restart after transient error (e.g. DB locked) unless user stopped it
      if (config.program.acoustid?.autostart === true) {
        winston.info('[acoustid] Restarting worker in 10s after error...');
        setTimeout(() => { if (!_running) _spawnWorker(); }, 10_000);
      }
    }
  });

  _worker.on('error', err => {
    winston.error(`[acoustid] Worker thread error: ${err.message}`);
    _running   = false;
    _stopping  = false;
    _startedAt = null;
    _worker    = null;
    if (config.program.acoustid?.autostart === true) {
      winston.info('[acoustid] Restarting worker in 10s after thread error...');
      setTimeout(() => { if (!_running) _spawnWorker(); }, 10_000);
    }
  });

  _worker.on('exit', code => {
    if (code !== 0) {
      winston.warn(`[acoustid] Worker exited with code ${code}`);
    }
    _running   = false;
    _stopping  = false;
    _startedAt = null;
    _worker    = null;
    // Only auto-restart on unexpected (non-zero) exits, not clean completion
    if (code !== 0 && config.program.acoustid?.autostart === true) {
      winston.info('[acoustid] Restarting worker in 10s after unexpected exit...');
      setTimeout(() => { if (!_running) _spawnWorker(); }, 10_000);
    }
  });

  winston.info('[acoustid] Worker started');
}

// ── Setup ─────────────────────────────────────────────────────────────────────

export function setup(velvet) {

  // Pre-check fpcalc availability at startup so status can report it immediately
  ensureFpcalc().then(ready => { _fpcalcReady = ready; }).catch(() => { _fpcalcReady = false; });

  // Guard — all endpoints are admin-only
  velvet.all('/api/v1/acoustid/{*path}', (req, res, next) => {
    if (req.user?.admin !== true) return res.status(403).json({ error: 'Admin only' });
    next();
  });

  // GET /api/v1/acoustid/status
  velvet.get('/api/v1/acoustid/status', (req, res) => {
    const stats = db.getAcoustidStats() || _lastStats || {
      total: 0, found: 0, not_found: 0, errors: 0, pending: 0, queued: 0,
    };

    const apiKey  = config.program.acoustid?.apiKey?.trim() || '';
    const enabled = config.program.acoustid?.enabled === true;
    const hasKey  = apiKey.length >= 4;

    res.json({
      enabled,
      hasKey,
      fpcalcAvailable: _fpcalcReady !== false, // true until proven otherwise
      running:    _running,
      stopping:   _stopping,
      startedAt:  _startedAt,
      scanActive: isScanning(),
      stats: {
        total:     stats.total     || 0,
        found:     stats.found     || 0,
        not_found: stats.not_found || 0,
        errors:    stats.errors    || 0,
        pending:   stats.pending   || 0,
        queued:    stats.queued    || 0,
      },
    });
  });

  // POST /api/v1/acoustid/start
  velvet.post('/api/v1/acoustid/start', async (req, res) => {
    const apiKey  = config.program.acoustid?.apiKey?.trim() || '';
    const enabled = config.program.acoustid?.enabled === true;

    if (!enabled) {
      return res.status(400).json({ error: 'AcoustID is not enabled in settings' });
    }
    if (apiKey.length < 4) {
      return res.status(400).json({ error: 'No valid AcoustID API key configured' });
    }
    if (_running) {
      return res.json({ ok: true, message: 'Already running' });
    }
    if (isScanRunning()) {
      _pendingStart = true;
      onScanEnd(async () => {
        if (!_pendingStart || _running) return;
        _pendingStart = false;
        try {
          const ready = await ensureFpcalc();
          _fpcalcReady = ready;
          if (!ready || _running) return;
          _spawnWorker();
          _saveAutostart(true);
          winston.info('[acoustid] Deferred start executed after scan completion');
        } catch (e) {
          winston.warn('[acoustid] Deferred start failed: ' + (e?.message ?? e));
        }
      });
      return res.json({ ok: true, pending: true, message: 'Start queued: file scan in progress' });
    }

    // Ensure fpcalc binary is available (non-blocking check/download)
    const fpcalcReady = await ensureFpcalc();
    _fpcalcReady = fpcalcReady;
    if (!fpcalcReady) {
      return res.status(500).json({
        error: 'fpcalc (Chromaprint) is not installed or could not be downloaded. ' +
               'On ARM64 Linux: apt install libchromaprint-tools (or apk add chromaprint). ' +
               'See server logs for details.',
      });
    }

    _spawnWorker();
    _saveAutostart(true);
    res.json({ ok: true });
  });

  // POST /api/v1/acoustid/stop
  velvet.post('/api/v1/acoustid/stop', (req, res) => {
    if (_pendingStart && !_running) {
      _pendingStart = false;
      return res.json({ ok: true, message: 'Pending start cancelled' });
    }
    if (!_running || !_worker) {
      return res.json({ ok: true, message: 'Not running' });
    }
    if (_stopping) {
      return res.json({ ok: true, message: 'Already stopping' });
    }
    _stopping = true;
    _worker.postMessage({ type: 'stop' });
    _saveAutostart(false);
    // Force-terminate the worker if it hasn't stopped cleanly within 30 s
    // (e.g. stuck in fpcalc or a long DB retry loop)
    setTimeout(() => {
      if (_worker && _stopping) {
        winston.warn('[acoustid] Worker did not stop in 30 s — force-terminating');
        _worker.terminate();
        _running  = false;
        _stopping = false;
        _worker   = null;
      }
    }, 30_000);
    res.json({ ok: true });
  });

  // POST /api/v1/acoustid/reset-errors
  // Clears acoustid_status='error' so those files are retried on the next worker pass.
  velvet.post('/api/v1/acoustid/reset-errors', (req, res) => {
    try {
      const count = db.resetAcoustidErrors();
      winston.info(`[acoustid] reset-errors: cleared ${count} error rows`);
      res.json({ ok: true, reset: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/v1/acoustid/reset-not-found
  // Re-queues all 'not_found' files with priority=1 so they are retried at the front of the queue.
  velvet.post('/api/v1/acoustid/reset-not-found', async (req, res) => {
    try {
      const count = db.resetNotFoundForAcoustid();
      winston.info(`[acoustid] reset-not-found: re-queued ${count} no-match rows with priority`);
      const workerStarted = !_running;
      if (!_running && count > 0) {
        if (isScanRunning()) {
          _pendingStart = true;
          onScanEnd(async () => {
            if (!_pendingStart || _running) return;
            _pendingStart = false;
            const ready = await ensureFpcalc().catch(() => false);
            if (ready && !_running) _spawnWorker();
          });
          return res.json({ ok: true, reset: count, workerStarted: false, pending: true });
        }
        const ready = await ensureFpcalc();
        if (ready) _spawnWorker();
      }
      res.json({ ok: true, reset: count, workerStarted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/v1/acoustid/scan-files
  // Queue specific files for AcoustID fingerprinting with priority=1 (processed before backlog).
  // Resets not_found/error status so previously-failed files are retried.
  // Body: { files: [{ filepath, vpath }] }
  velvet.post('/api/v1/acoustid/scan-files', async (req, res) => {
    const files = req.body?.files;
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files array required' });
    }
    const valid = files.filter(f =>
      typeof f.filepath === 'string' && f.filepath.length > 0 &&
      typeof f.vpath    === 'string' && f.vpath.length    > 0
    ).slice(0, 500);
    if (valid.length === 0) return res.status(400).json({ error: 'No valid file entries' });

    try {
      const queued = db.resetFilesForAcoustid(valid);

      // Ensure worker is running
      const workerStarted = !_running;
      if (!_running) {
        if (isScanRunning()) {
          _pendingStart = true;
          onScanEnd(async () => {
            if (!_pendingStart || _running) return;
            _pendingStart = false;
            const ready = await ensureFpcalc().catch(() => false);
            if (ready && !_running) _spawnWorker();
          });
          return res.json({ ok: true, queued, workerStarted: false, pending: true });
        }
        const ready = await ensureFpcalc();
        if (!ready) return res.status(503).json({ error: 'fpcalc binary not available' });
        _spawnWorker();
      }

      res.json({ ok: true, queued, workerStarted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Auto-start on server boot only if user had previously started it
  const bootApiKey = config.program.acoustid?.apiKey?.trim() || '';
  if (config.program.acoustid?.enabled === true && bootApiKey.length >= 4 && config.program.acoustid?.autostart === true) {
    if (isScanRunning()) {
      _pendingStart = true;
      onScanEnd(() => {
        if (!_pendingStart || _running) return;
        _pendingStart = false;
        ensureFpcalc().then(ready => {
          if (ready && !_running) _spawnWorker();
        }).catch(err => winston.warn(`[acoustid] Deferred auto-start skipped: ${err.message}`));
      });
    } else {
    ensureFpcalc().then(ready => {
      if (ready) {
        _spawnWorker();
      } else {
        winston.warn('[acoustid] Auto-start skipped: fpcalc binary not available');
      }
    }).catch(err => winston.warn(`[acoustid] Auto-start skipped: ${err.message}`));
    }
  }

  // Post-scan auto-start: re-check queue after every scan for newly added files.
  onEveryScanEnd(() => {
    try {
      if (_running) return;
      const apiKey = config.program.acoustid?.apiKey?.trim() || '';
      if (config.program.acoustid?.enabled !== true || apiKey.length < 4) return;
      const stats = db.getAcoustidStats();
      if (stats?.queued > 0) {
        if (stats.queued >= 500) {
          winston.info(`[acoustid] Auto-start skipped: ${stats.queued} files queued — backlog too large, start from Admin`);
          return;
        }
        ensureFpcalc().then(ready => {
          if (ready && !_running) {
            _spawnWorker();
            winston.info(`[acoustid] Post-scan auto-start: ${stats.queued} files queued`);
          }
        }).catch(() => {});
      }
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  });
}
