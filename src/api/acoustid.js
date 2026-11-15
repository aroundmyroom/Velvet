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
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { fpcalcBin, ensureFpcalc } from '../util/fpcalc-bootstrap.js';
import { isScanning } from '../db/task-queue.js';
import { getDirname } from '../util/esm-helpers.js';
import { createWorkerController, persistConfigValue } from '../util/worker-controller.js';

const __dirname = getDirname(import.meta.url);

let _lastStats = null;
let _fpcalcReady = null; // null = not yet checked, true/false after ensureFpcalc()

function _configured() {
  const apiKey = config.program.acoustid?.apiKey?.trim() || '';
  return config.program.acoustid?.enabled === true && apiKey.length >= 4;
}

function _workerData() {
  const apiKey  = config.program.acoustid?.apiKey?.trim() || '';
  // Build vpath → absolute-root-path mapping from config
  const folders = {};
  for (const [vpath, folderCfg] of Object.entries(config.program.folders || {})) {
    if (folderCfg.root) folders[vpath] = folderCfg.root;
  }
  return {
    dbPath:    db.dbFilePath(),
    apiKey,
    fpcalcBin: fpcalcBin(),
    folders,
  };
}

// AcoustID is opt-in: it only auto-starts (boot, post-scan, crash restart)
// after an admin pressed Start, and Stop switches that off again.
const _acoustid = createWorkerController({
  name: 'acoustid',
  path: path.join(__dirname, '../util/acoustid-worker.mjs'),
  workerData: _workerData,
  queued: () => (_configured() ? db.getAcoustidStats()?.queued ?? 0 : 0),
  autoStartAfterEveryScan: true,
  autostartFlag: {
    get: () => config.program.acoustid?.autostart === true,
    set: value => persistConfigValue(cfg => { cfg.acoustid = { ...cfg.acoustid, autostart: value }; }),
  },
  restartAfterCrash: () => config.program.acoustid?.autostart === true,
  async beforeStart() {
    _fpcalcReady = await ensureFpcalc().catch(() => false);
    if (!_fpcalcReady) winston.warn('[acoustid] Start skipped: fpcalc binary not available');
    return _fpcalcReady;
  },
  onMessage(msg) {
    if ((msg.type === 'status' || msg.type === 'ready') && msg.stats) _lastStats = msg.stats;
    if (msg.type === 'fileError') winston.warn(`[acoustid] File error: ${msg.message}`);
  },
});

// ── Setup ─────────────────────────────────────────────────────────────────────

const STOP_REPLY = {
  pending_cancelled: { message: 'Pending start cancelled' },
  not_running:       { message: 'Not running' },
  already_stopping:  { message: 'Already stopping' },
  stopping:          {},
};

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
      running:    _acoustid.running,
      stopping:   _acoustid.stopping,
      startedAt:  _acoustid.startedAt,
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
    const status = await _acoustid.start();
    if (status === 'already_running') return res.json({ ok: true, message: 'Already running' });
    if (status === 'pending') return res.json({ ok: true, pending: true, message: 'Start queued: file scan in progress' });
    if (status === 'unavailable') {
      return res.status(500).json({
        error: 'fpcalc (Chromaprint) is not installed or could not be downloaded. ' +
               'On ARM64 Linux: apt install libchromaprint-tools (or apk add chromaprint). ' +
               'See server logs for details.',
      });
    }
    res.json({ ok: true });
  });

  // POST /api/v1/acoustid/stop
  velvet.post('/api/v1/acoustid/stop', (req, res) => {
    res.json({ ok: true, ...STOP_REPLY[_acoustid.stop()] });
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
  // Re-queues all 'not_found' files (status cleared, so the worker fingerprints them again in normal queue order).
  velvet.post('/api/v1/acoustid/reset-not-found', async (req, res) => {
    try {
      const count = db.resetNotFoundForAcoustid();
      winston.info(`[acoustid] reset-not-found: re-queued ${count} no-match rows`);
      const workerStarted = !_acoustid.running;
      if (workerStarted && count > 0) {
        const status = await _acoustid.start({ remember: false });
        if (status === 'pending') return res.json({ ok: true, reset: count, workerStarted: false, pending: true });
      }
      res.json({ ok: true, reset: count, workerStarted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/v1/acoustid/scan-files
  // Queue specific files for AcoustID fingerprinting: resets their status so previously-failed files are retried.
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

      const workerStarted = !_acoustid.running;
      if (workerStarted) {
        const status = await _acoustid.start({ remember: false });
        if (status === 'pending') return res.json({ ok: true, queued, workerStarted: false, pending: true });
        if (status === 'unavailable') return res.status(503).json({ error: 'fpcalc binary not available' });
      }

      res.json({ ok: true, queued, workerStarted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  _acoustid.autoStart('Boot auto-start', { bypassCap: true });
}
