/**
 * bpm-analysis.js
 *
 * BPM & Musical Key analysis API — worker lifecycle management for
 * Tier 0 (AcousticBrainz) and Tier 2 (Essentia) analysis.
 *
 * Endpoints (all admin-only):
 *   GET  /api/v1/admin/bpm/status           — combined coverage + worker stats
 *   POST /api/v1/admin/bpm/ab/start         — start AB lookup worker
 *   POST /api/v1/admin/bpm/ab/stop          — stop AB worker after current file
 *   POST /api/v1/admin/bpm/ab/reset-failed  — reset ab_status='error' → NULL
 *   POST /api/v1/admin/bpm/essentia/start   — start Essentia worker (Tier 2)
 *   POST /api/v1/admin/bpm/essentia/stop    — stop Essentia worker
 *   POST /api/v1/admin/bpm/essentia/reset-failed  — reset bpm_status='error' → NULL
 *   POST /api/v1/admin/bpm/reset-all        — clear all BPM data (workers must be stopped)
 */

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { getDirname } from '../util/esm-helpers.js';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';
import { isScanRunning, onScanEnd, onEveryScanEnd } from '../state/scan-lock.js';

const __dirname = getDirname(import.meta.url);
const _abWorkerPath       = path.join(__dirname, '../util/ab-bpm-worker.mjs');
const _essentiaWorkerPath = path.join(__dirname, '../util/essentia-bpm-worker.mjs');

// ── AB Worker state ───────────────────────────────────────────────────────────

let _abWorker   = null;
let _abRunning  = false;
let _abStopping = false;
let _abLastStats = null;
let _abCurrentFile = null;
let _abProcessedCount = 0;
let _abPendingStart = false;

function _abWorkerData() {
  return {
    dbPath: path.join(config.program.storage.dbDirectory, 'velvet.sqlite'),
  };
}

function _spawnAbWorker() {
  if (_abWorker) return;

  _abWorker        = new Worker(_abWorkerPath, { workerData: _abWorkerData() });
  _abRunning       = true;
  _abStopping      = false;
  _abProcessedCount = 0;

  _abWorker.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'status' || msg.type === 'ready') {
      if (msg.stats) _abLastStats = msg.stats;
    }
    if (msg.type === 'progress') {
      _abCurrentFile    = msg.currentFile || null;
      _abProcessedCount = msg.processedCount || _abProcessedCount;
    }
    if (msg.type === 'stopped') {
      _abRunning    = false;
      _abStopping   = false;
      _abCurrentFile = null;
      _abWorker     = null;
      winston.info('[bpm-ab] Worker stopped cleanly');
    }
    if (msg.type === 'error') {
      winston.error(`[bpm-ab] Worker error: ${msg.message}`);
      _abRunning    = false;
      _abStopping   = false;
      _abCurrentFile = null;
      _abWorker     = null;
    }
    if (msg.type === 'log') {
      winston.info(msg.message);
    }
  });

  _abWorker.on('error', err => {
    winston.error(`[bpm-ab] Worker thread error: ${err.message}`);
    _abRunning    = false;
    _abStopping   = false;
    _abCurrentFile = null;
    _abWorker     = null;
  });

  _abWorker.on('exit', code => {
    if (code !== 0) winston.warn(`[bpm-ab] Worker exited with code ${code}`);
    _abRunning    = false;
    _abStopping   = false;
    _abCurrentFile = null;
    _abWorker     = null;
  });

  winston.info('[bpm-ab] Worker started');
}

// ── Essentia Worker state (Tier 2) ────────────────────────────────────────────

let _esWorker          = null;
let _esRunning         = false;
let _esStopping        = false;
let _esCurrentFile     = null;
let _esProcessedCount  = 0;
let _esLastStats       = null;
let _esPendingStart    = false;

function _esWorkerData() {
  return {
    dbPath:    path.join(config.program.storage.dbDirectory, 'velvet.sqlite'),
    folders:   config.program.folders || {},
    ffmpegBin: ffmpegBin(),
  };
}

function _spawnEssentiaWorker() {
  if (_esWorker) return;

  _esWorker         = new Worker(_essentiaWorkerPath, { workerData: _esWorkerData() });
  _esRunning        = true;
  _esStopping       = false;
  _esProcessedCount = 0;

  _esWorker.on('message', msg => {
    if (!msg) return;
    if (msg.stats) _esLastStats = msg.stats;
    if (msg.type === 'progress') {
      _esCurrentFile    = msg.currentFile || null;
      _esProcessedCount = msg.processedCount ?? _esProcessedCount;
    }
    if (msg.type === 'idle') {
      _esCurrentFile = null;
    }
    if (msg.type === 'error') {
      winston.warn(`[bpm-essentia] Analysis error: ${msg.message} — file: ${msg.file}`);
    }
    if (msg.type === 'stopped') {
      _esRunning     = false;
      _esStopping    = false;
      _esCurrentFile = null;
      _esWorker      = null;
      if (msg.error) winston.error(`[bpm-essentia] Worker stopped with error: ${msg.error}`);
      else winston.info(`[bpm-essentia] Worker stopped cleanly (processed: ${msg.processedCount ?? _esProcessedCount})`);
    }
  });

  _esWorker.on('error', err => {
    winston.error(`[bpm-essentia] Worker thread error: ${err.message}`);
    _esRunning     = false;
    _esStopping    = false;
    _esCurrentFile = null;
    _esWorker      = null;
  });

  _esWorker.on('exit', code => {
    if (code !== 0) winston.warn(`[bpm-essentia] Worker exited with code ${code}`);
    _esRunning     = false;
    _esStopping    = false;
    _esCurrentFile = null;
    _esWorker      = null;
  });

  winston.info('[bpm-essentia] Worker started');
}

// ── Setup ─────────────────────────────────────────────────────────────────────

export function setup(velvet) {
  // ── Boot-time + post-scan auto-start ─────────────────────────────────────
  // Named function so it can be called both at boot and after each scan.
  function _tryBpmAutoStart() {
    try {
      if (_abRunning) return;
      if (isScanRunning()) {
        // Scan is still running — defer until it ends rather than silently dropping.
        winston.info('[bpm-ab] Auto-start deferred — scan in progress');
        onScanEnd(_tryBpmAutoStart);
        return;
      }
      const stats = db.getBpmStats();
      if (stats && stats.ab_queued > 0) {
        if (stats.ab_queued >= 500) {
          winston.info(`[bpm-ab] Auto-start skipped: ${stats.ab_queued} files queued — backlog too large, start from Admin`);
          return;
        }
        _spawnAbWorker();
        winston.info(`[bpm-ab] Auto-started: ${stats.ab_queued} files queued`);
      }
    } catch (e) {
      winston.warn('[bpm-ab] Auto-start check failed: ' + e.message);
    }
  }
  // 90 s delay at boot: wait for AcoustID (15 s) and RG (60 s) to settle first.
  setTimeout(_tryBpmAutoStart, 90_000);
  // Re-check after every scan so newly added files are processed immediately.
  onEveryScanEnd(_tryBpmAutoStart);

  // Guard — all endpoints are admin-only
  velvet.all('/api/v1/admin/bpm/{*path}', (req, res, next) => {
    if (req.user?.admin !== true) return res.status(403).json({ error: 'Admin only' });
    next();
  });

  // GET /api/v1/admin/bpm/status
  velvet.get('/api/v1/admin/bpm/status', (req, res) => {
    let raw;
    try {
      raw = db.getBpmStats();
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({
      ab: {
        running:        _abRunning,
        stopping:       _abStopping,
        currentFile:    _abCurrentFile,
        processedCount: _abProcessedCount,
        stats: {
          total:     raw.ab_eligible   || 0,
          done:      raw.ab_done       || 0,
          not_found: raw.ab_not_found  || 0,
          errors:    raw.ab_errors     || 0,
          queued:    raw.ab_queued     || 0,
        },
      },
      essentia: {
        running:        _esRunning,
        stopping:       _esStopping,
        currentFile:    _esCurrentFile,
        processedCount: _esProcessedCount,
        binaryAvailable: true,
        stats: {
          total:  raw.total            || 0,
          done:   raw.essentia_done    || 0,
          errors: raw.essentia_errors  || 0,
          queued: raw.essentia_queued  || 0,
        },
      },
      coverage: {
        hasBpm:  raw.has_bpm  || 0,
        hasKey:  raw.has_key  || 0,
        total:   raw.total    || 0,
        bySource: {
          tag:            raw.source_tag      || 0,
          acousticbrainz: raw.source_ab       || 0,
          essentia:       raw.source_essentia || 0,
        },
      },
    });
  });

  // POST /api/v1/admin/bpm/ab/start
  velvet.post('/api/v1/admin/bpm/ab/start', (req, res) => {
    if (_abRunning) {
      return res.json({ ok: true, status: 'already_running' });
    }
    if (isScanRunning()) {
      _abPendingStart = true;
      onScanEnd(() => {
        if (!_abPendingStart || _abRunning) return;
        _abPendingStart = false;
        _spawnAbWorker();
        winston.info('[bpm-ab] Deferred start executed after scan completion');
      });
      return res.json({ ok: true, status: 'pending', message: 'Start queued: file scan in progress' });
    }
    _spawnAbWorker();
    res.json({ ok: true });
  });

  // POST /api/v1/admin/bpm/ab/stop
  velvet.post('/api/v1/admin/bpm/ab/stop', (req, res) => {
    if (_abPendingStart && !_abRunning) {
      _abPendingStart = false;
      return res.json({ ok: true, message: 'Pending start cancelled' });
    }
    if (!_abRunning || !_abWorker) {
      return res.json({ ok: true, message: 'Not running' });
    }
    if (_abStopping) {
      return res.json({ ok: true, message: 'Already stopping' });
    }
    _abStopping = true;
    _abWorker.postMessage('stop');
    // Force-terminate if not stopped within 60 s
    setTimeout(() => {
      if (_abWorker && _abStopping) {
        winston.warn('[bpm-ab] Worker did not stop in 60 s — force-terminating');
        _abWorker.terminate();
        _abRunning    = false;
        _abStopping   = false;
        _abWorker     = null;
        _abCurrentFile = null;
      }
    }, 60_000);
    res.json({ ok: true });
  });

  // POST /api/v1/admin/bpm/ab/reset-failed
  velvet.post('/api/v1/admin/bpm/ab/reset-failed', (req, res) => {
    try {
      const count = db.resetAbErrors();
      winston.info(`[bpm-ab] reset-failed: cleared ${count} error rows`);
      res.json({ ok: true, reset: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/v1/admin/bpm/ab/reset-not-found
  // Re-queues all files where AB returned 404 (ab_status='not_found') so they
  // will be retried on the next AB worker run. Useful after AB data has been
  // added upstream or when the initial run had network issues.
  velvet.post('/api/v1/admin/bpm/ab/reset-not-found', (req, res) => {
    if (_abRunning) {
      return res.status(409).json({ error: 'Stop the AB worker before resetting' });
    }
    try {
      const count = db.resetAbNotFound();
      winston.info(`[bpm-ab] reset-not-found: re-queued ${count} rows`);
      res.json({ ok: true, reset: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/v1/admin/bpm/essentia/start
  velvet.post('/api/v1/admin/bpm/essentia/start', (req, res) => {
    if (_esRunning) {
      return res.json({ ok: true, status: 'already_running' });
    }
    if (isScanRunning()) {
      _esPendingStart = true;
      onScanEnd(() => {
        if (!_esPendingStart || _esRunning) return;
        _esPendingStart = false;
        _spawnEssentiaWorker();
        winston.info('[bpm-essentia] Deferred start executed after scan completion');
      });
      return res.json({ ok: true, status: 'pending', message: 'Start queued: file scan in progress' });
    }
    _spawnEssentiaWorker();
    res.json({ ok: true });
  });

  // POST /api/v1/admin/bpm/essentia/stop
  velvet.post('/api/v1/admin/bpm/essentia/stop', (req, res) => {
    if (_esPendingStart && !_esRunning) {
      _esPendingStart = false;
      return res.json({ ok: true, message: 'Pending start cancelled' });
    }
    if (!_esRunning || !_esWorker) {
      return res.json({ ok: true, message: 'Not running' });
    }
    if (_esStopping) {
      return res.json({ ok: true, message: 'Already stopping' });
    }
    _esStopping = true;
    _esWorker.postMessage('stop');
    // Force-terminate if not stopped within 120 s (Essentia can be slow on large files)
    setTimeout(() => {
      if (_esWorker && _esStopping) {
        winston.warn('[bpm-essentia] Worker did not stop in 120 s — force-terminating');
        _esWorker.terminate();
        _esRunning     = false;
        _esStopping    = false;
        _esWorker      = null;
        _esCurrentFile = null;
      }
    }, 120_000);
    res.json({ ok: true });
  });

  // POST /api/v1/admin/bpm/essentia/reset-failed
  velvet.post('/api/v1/admin/bpm/essentia/reset-failed', (req, res) => {
    try {
      const count = db.resetEssentiaErrors();
      res.json({ ok: true, reset: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/v1/admin/bpm/reset-all
  // Requires both workers to be stopped (safety check).
  velvet.post('/api/v1/admin/bpm/reset-all', (req, res) => {
    if (_abRunning || _esRunning) {
      return res.status(409).json({ error: 'Stop all workers before resetting' });
    }
    try {
      const count = db.resetAllBpmData();
      _abLastStats      = null;
      _abProcessedCount = 0;
      _abCurrentFile    = null;
      winston.info(`[bpm] reset-all: cleared BPM data for ${count} files`);
      res.json({ ok: true, reset: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/v1/admin/bpm/genre-correct
  // Query param: ?dryRun=true for a preview without writing.
  // Only corrects bpm_source='essentia' rows using the genre-window matrix.
  velvet.post('/api/v1/admin/bpm/genre-correct', (req, res) => {
    if (_esRunning) {
      return res.status(409).json({ error: 'Stop the Essentia worker before running genre correction' });
    }
    const dryRun = req.query.dryRun === 'true' || req.query.dryRun === '1';
    try {
      const result = db.genreCorrectBpm(dryRun);
      if (!dryRun) {
        winston.info(`[bpm-genre-correct] Applied: ${result.changed} corrected, ${result.alreadyOk} already ok, ${result.noGenre} no-genre, ${result.noFamily} no-family`);
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/v1/admin/bpm/genre-correct-undo
  // Restores bpm_raw → bpm for all rows with bpm_status='genre-corrected'.
  velvet.post('/api/v1/admin/bpm/genre-correct-undo', (req, res) => {
    if (_esRunning) {
      return res.status(409).json({ error: 'Stop the Essentia worker before undoing' });
    }
    try {
      const count = db.genreCorrectBpmUndo();
      winston.info(`[bpm-genre-correct] Undone: ${count} rows restored`);
      res.json({ ok: true, restored: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/v1/admin/bpm/genre-correct-selected
  // Apply a user-chosen subset of dry-run corrections.
  // Body: { corrections: [{filepath, vpath, bpm, corrected}] }
  velvet.post('/api/v1/admin/bpm/genre-correct-selected', (req, res) => {
    if (_esRunning) {
      return res.status(409).json({ error: 'Stop the Essentia worker before applying corrections' });
    }
    const { corrections } = req.body ?? {};
    if (!Array.isArray(corrections) || !corrections.length) {
      return res.status(400).json({ error: 'No corrections provided' });
    }
    try {
      const applied = db.genreCorrectBpmSelected(corrections);
      winston.info(`[bpm-genre-correct] Selected: ${applied} of ${corrections.length} corrections applied`);
      res.json({ ok: true, applied });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
