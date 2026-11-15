/**
 * rg-analysis.js
 *
 * ReplayGain 2.0 / EBU R128 measurement worker lifecycle + REST API.
 * All endpoints are admin-only.
 *
 *   POST /api/v1/admin/rg/start        — start measurement worker
 *   POST /api/v1/admin/rg/stop         — stop measurement worker
 *   GET  /api/v1/admin/rg/status       — worker status + DB counts
 *   GET  /api/v1/admin/rg/failed       — list failed files with detail
 *   POST /api/v1/admin/rg/reset-failed — reset failed rows so they are retried
 *   POST /api/v1/admin/rg/shelve       — shelve rows so they are never retried
 *   POST /api/v1/admin/rg/reset-all    — clear all measurements (with undo backup)
 *   POST /api/v1/admin/rg/undo-reset-all — restore measurements from backup
 */

import path from 'node:path';
import winston from 'winston';
import * as db from '../db/manager.js';
import { rsgainBin, rsgainAvailable, ensureRsgain } from '../util/rsgain-bootstrap.js';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';
import { getDirname } from '../util/esm-helpers.js';
import { rootFolders } from '../util/vpath.js';
import { createWorkerController } from '../util/worker-controller.js';
const __dirname   = getDirname(import.meta.url);

// ── Worker state ──────────────────────────────────────────────────────────────

let _lastStats      = null;
let _currentFile    = null;
let _processedCount = 0;

const _rg = createWorkerController({
  name: 'rg-analysis',
  path: path.join(__dirname, '../util/rg-analysis-worker.mjs'),
  workerData: () => ({
    dbPath:    db.dbFilePath(),
    folders:   rootFolders(),
    rsgainBin: rsgainAvailable() ? rsgainBin() : null,
    ffmpegBin: ffmpegBin(),
  }),
  // While an undo backup exists the admin has not decided yet; only an explicit
  // start may measure (and so discard the backup).
  queued: () => (db.getRgUndoInfo().count > 0 ? 0 : db.getRgStatus()?.queued ?? 0),
  autoStartAfterEveryScan: true,
  async beforeStart() {
    // rsgain is optional — on failure the worker falls back to ffmpeg.
    await ensureRsgain().catch(e => winston.warn('[rg-analysis] rsgain prefetch failed: ' + e.message));
  },
  onSpawn() { _processedCount = 0; },
  onReset() { _currentFile = null; },
  onMessage(msg) {
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
  },
});

// ── Setup (called once at server start) ───────────────────────────────────────

export function setup(app) {
  // 60 s delay: let the server finish booting before the first auto-check.
  setTimeout(() => _rg.autoStart(), 60_000);

  // ── POST /api/v1/admin/rg/start ───────────────────────────────────────────
  app.post('/api/v1/admin/rg/start', async (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    if (!_rg.running) db.clearRgBackup();
    const status = await _rg.start();
    if (status === 'pending') return res.json({ status, message: 'Start queued: file scan in progress' });
    res.json({ status });
  });

  // ── POST /api/v1/admin/rg/stop ────────────────────────────────────────────
  app.post('/api/v1/admin/rg/stop', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    const status = _rg.stop();
    res.json({ status: status === 'already_stopping' ? 'stopping' : status });
  });

  // ── GET /api/v1/admin/rg/status ───────────────────────────────────────────
  app.get('/api/v1/admin/rg/status', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    let dbStats;
    try { dbStats = db.getRgStatus(); } catch { dbStats = null; }
    let undoInfo = { count: 0, resetAt: null };
    try { undoInfo = db.getRgUndoInfo(); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    res.json({
      running:        _rg.running,
      stopping:       _rg.stopping,
      startedAt:      _rg.startedAt,
      currentFile:    _currentFile,
      processedCount: _processedCount,
      stats:          _lastStats || dbStats,
      tool:           rsgainAvailable() ? 'rsgain' : 'ffmpeg',
      undo:           { available: undoInfo.count > 0, count: undoInfo.count, resetAt: undoInfo.resetAt },
    });
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
  // Re-queues every failed row. Library rows are never deleted here: a file that
  // looks missing may sit on a mount that is offline, and only the scanner can
  // tell a gone file from an unreachable root.
  app.post('/api/v1/admin/rg/reset-failed', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    const reset = db.resetRgFailedByIds(db.getRgFailedRows().map(r => r.id));
    if (reset > 0) _lastStats = null;
    res.json({ reset });
  });

  // ── POST /api/v1/admin/rg/reset-all ──────────────────────────────────────
  app.post('/api/v1/admin/rg/reset-all', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    if (_rg.running) return res.status(409).json({ error: 'Stop the worker before resetting' });
    const { reset, backedUp } = db.resetRgAll();
    _lastStats      = null;
    _currentFile    = null;
    _processedCount = 0;
    res.json({ reset, backedUp });
  });

  // ── POST /api/v1/admin/rg/undo-reset-all ─────────────────────────────────
  app.post('/api/v1/admin/rg/undo-reset-all', (req, res) => {
    if (!req.user?.admin) return res.status(403).json({ error: 'Admin required' });
    if (_rg.running) return res.status(409).json({ error: 'Stop the worker before undoing' });
    const restored = db.undoRgAll();
    _lastStats      = null;
    _currentFile    = null;
    _processedCount = 0;
    res.json({ restored });
  });
}
