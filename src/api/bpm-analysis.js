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
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { getDirname } from '../util/esm-helpers.js';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';
import { createWorkerController } from '../util/worker-controller.js';

const __dirname = getDirname(import.meta.url);

// ── AB Worker (Tier 0) ────────────────────────────────────────────────────────

let _abCurrentFile = null;
let _abProcessedCount = 0;

const _ab = createWorkerController({
  name: 'bpm-ab',
  path: path.join(__dirname, '../util/ab-bpm-worker.mjs'),
  workerData: () => ({ dbPath: db.dbFilePath() }),
  queued: () => db.getBpmStats()?.ab_queued ?? 0,
  autoStartAfterEveryScan: true,
  stopTimeoutMs: 60_000,
  onSpawn() { _abProcessedCount = 0; },
  onReset() { _abCurrentFile = null; },
  onMessage(msg) {
    if (msg.type === 'progress') {
      _abCurrentFile    = msg.currentFile || null;
      _abProcessedCount = msg.processedCount || _abProcessedCount;
    }
  },
});

// ── Essentia Worker (Tier 2) ──────────────────────────────────────────────────

let _esCurrentFile     = null;
let _esProcessedCount  = 0;

function _esWorkerData() {
  const windowSec = Number(config.program.scanOptions?.analyzeBpmWindowSec ?? 60);
  return {
    dbPath:          db.dbFilePath(),
    folders:         config.program.folders || {},
    ffmpegBin:       ffmpegBin(),
    bpmWindowSec:    Number.isFinite(windowSec) && windowSec > 0 ? windowSec : 0,
  };
}

const _es = createWorkerController({
  name: 'bpm-essentia',
  path: path.join(__dirname, '../util/essentia-bpm-worker.mjs'),
  workerData: _esWorkerData,
  queued: () => db.getBpmStats()?.essentia_queued ?? 0,
  autoStartAfterEveryScan: true,
  // Essentia can be slow on large files
  stopTimeoutMs: 120_000,
  onSpawn() { _esProcessedCount = 0; },
  onReset() { _esCurrentFile = null; },
  onMessage(msg) {
    if (msg.type === 'progress') {
      _esCurrentFile    = msg.currentFile || null;
      _esProcessedCount = msg.processedCount ?? _esProcessedCount;
    }
    if (msg.type === 'idle') _esCurrentFile = null;
    if (msg.type === 'fileError') winston.warn(`[bpm-essentia] Analysis error: ${msg.message} — file: ${msg.file}`);
  },
});

const STOP_REPLY = {
  pending_cancelled: { message: 'Pending start cancelled' },
  not_running:       { message: 'Not running' },
  already_stopping:  { message: 'Already stopping' },
  stopping:          {},
};

function _startReply(status) {
  if (status === 'already_running') return { ok: true, status };
  if (status === 'pending') return { ok: true, status, message: 'Start queued: file scan in progress' };
  return { ok: true };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

export function setup(velvet) {
  // 90 s delay at boot: wait for AcoustID (15 s) and RG (60 s) to settle first.
  setTimeout(() => _ab.autoStart(), 90_000).unref();
  setTimeout(() => _es.autoStart(), 90_000).unref();

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
        running:        _ab.running,
        stopping:       _ab.stopping,
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
        running:        _es.running,
        stopping:       _es.stopping,
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
  velvet.post('/api/v1/admin/bpm/ab/start', async (req, res) => {
    res.json(_startReply(await _ab.start()));
  });

  // POST /api/v1/admin/bpm/ab/stop
  velvet.post('/api/v1/admin/bpm/ab/stop', (req, res) => {
    res.json({ ok: true, ...STOP_REPLY[_ab.stop()] });
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
    if (_ab.running) {
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
  velvet.post('/api/v1/admin/bpm/essentia/start', async (req, res) => {
    res.json(_startReply(await _es.start()));
  });

  // POST /api/v1/admin/bpm/essentia/stop
  velvet.post('/api/v1/admin/bpm/essentia/stop', (req, res) => {
    res.json({ ok: true, ...STOP_REPLY[_es.stop()] });
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
    if (_ab.running || _es.running) {
      return res.status(409).json({ error: 'Stop all workers before resetting' });
    }
    try {
      const count = db.resetAllBpmData();
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
    if (_es.running) {
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
    if (_es.running) {
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
    if (_es.running) {
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
