/**
 * genre-enricher.js
 *
 * Three-source genre enrichment pipeline. The worker thread fetches genre
 * tags INDEPENDENTLY from Last.fm, MusicBrainz, and Discogs for every
 * artist, so the user can compare results and decide which to apply.
 *
 * DB schema (per file row, but values are uniform per artist):
 *   genre_lastfm          TEXT  — Last.fm best genre (or NULL)
 *   genre_mb              TEXT  — MusicBrainz best genre (or NULL)
 *   genre_discogs         TEXT  — Discogs best genre (or NULL)
 *   genre_enrich_lastfm   TEXT  — 'ok' | 'nf' | 'error' | NULL (not run)
 *   genre_enrich_mb       TEXT  — same
 *   genre_enrich_discogs  TEXT  — same
 *
 * The legacy column `genre_lastfm_src` is kept for forward compatibility
 * but is no longer written by the worker.
 *
 * Endpoints (admin-only):
 *   GET  /api/v1/admin/genre-enricher/status
 *   POST /api/v1/admin/genre-enricher/start
 *   POST /api/v1/admin/genre-enricher/stop
 *   POST /api/v1/admin/genre-enricher/reset-errors        body: { source? }
 *   POST /api/v1/admin/genre-enricher/reset-not-found     body: { source? }
 *   POST /api/v1/admin/genre-enricher/reset-source        body: { source }
 *   POST /api/v1/admin/genre-enricher/reset-all
 *   GET  /api/v1/admin/genre-enricher/compare   ?filter&limit&offset
 *   POST /api/v1/admin/genre-enricher/apply               body: { items: [{artist, source}] }
 *   POST /api/v1/admin/genre-enricher/apply-all-empty     body: { source }
 *   POST /api/v1/admin/genre-enricher/set-genre           body: { artist, genre }
 */

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { getDirname } from '../util/esm-helpers.js';
import { stripDigitPrefix } from '../util/artist-normalize.js';
import { isScanRunning, onEveryScanEnd, onEveryScanStart } from '../state/scan-lock.js';
import * as broker from '../state/bg-task-broker.js';

const __dirname = getDirname(import.meta.url);
const _workerPath = path.join(__dirname, '../util/genre-enricher-worker.mjs');

const _VALID_SOURCES = new Set(['lastfm', 'mb', 'discogs']);
const _COL_GENRE = { lastfm: 'genre_lastfm', mb: 'genre_mb', discogs: 'genre_discogs' };
const _COL_STATE = { lastfm: 'genre_enrich_lastfm', mb: 'genre_enrich_mb', discogs: 'genre_enrich_discogs' };

// ── Worker state ──────────────────────────────────────────────────────────────
let _worker         = null;
let _running        = false;
let _stopping       = false;
let _currentArtist  = null;
let _currentPhase   = null;
let _processedCount = 0;
let _lastStats      = null;
let _startedAt      = null;
let _pausedByScan   = false; // true when a scan forcibly stopped the worker
let _startRequested = false; // true when admin explicitly requested a start and it has not started yet

function _workerData() {
  const lastfmApiKey = config.program?.lastFM?.apiKey?.trim() || '';
  const dc = config.program?.discogs;
  const discogs = dc?.apiKey
    ? { apiKey: dc.apiKey, apiSecret: dc.apiSecret || '', userAgentTag: dc.userAgentTag || '' }
    : null;
  return {
    dbPath: path.join(config.program.storage.dbDirectory, 'velvet.sqlite'),
    lastfmApiKey,
    discogs,
  };
}

function _spawnWorker() {
  if (_worker) return;
  _worker         = new Worker(_workerPath, { workerData: _workerData() });
  _running        = true;
  _stopping       = false;
  _startRequested = false;
  _startedAt      = Date.now();
  _processedCount = 0;

  _worker.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'progress') {
      _currentArtist  = msg.currentArtist || null;
      _currentPhase   = msg.currentPhase  || null;
      _processedCount = msg.processedCount ?? _processedCount;
      return;
    }
    if (msg.type === 'status' || msg.type === 'ready') {
      if (msg.stats) _lastStats = msg.stats;
      return;
    }
    if (msg.type === 'fileError') {
      winston.warn(`[genre-enricher] ${msg.message}`);
      return;
    }
    if (msg.type === 'stopped') {
      _resetWorkerState();
      winston.info('[genre-enricher] Worker stopped cleanly');
      return;
    }
    if (msg.type === 'error') {
      winston.error(`[genre-enricher] Worker error: ${msg.message}`);
      _resetWorkerState();
    }
  });

  _worker.on('error', err => {
    winston.error(`[genre-enricher] Worker thread error: ${err.message}`);
    _resetWorkerState();
  });

  _worker.on('exit', code => {
    if (code !== 0) winston.warn(`[genre-enricher] Worker exited with code ${code}`);
    _resetWorkerState();
  });

  winston.info('[genre-enricher] Worker started');
}

function _resetWorkerState() {
  _running       = false;
  _stopping      = false;
  _startedAt     = null;
  _currentArtist = null;
  _currentPhase  = null;
  _worker        = null;
}

// ── Live stats (DB) — used until worker emits first status ────────────────────
function _liveStats() {
  const rawDb = db.getDB();
  const c = sql => rawDb.prepare(sql).get()?.c ?? 0;
  const total = c("SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE artist IS NOT NULL AND trim(artist) != ''");
  const bucket = state => ({
    ok:     c(`SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE ${state} = 'ok'`),
    nf:     c(`SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE ${state} = 'nf'`),
    error:  c(`SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE ${state} = 'error'`),
    queued: c(`SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE ${state} IS NULL AND artist IS NOT NULL AND trim(artist) != ''`),
  });
  const lf = bucket('genre_enrich_lastfm');
  const mb = bucket('genre_enrich_mb');
  const dg = bucket('genre_enrich_discogs');
  const artistsQueued = c(`
    SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files
    WHERE (genre_enrich_lastfm IS NULL OR genre_enrich_mb IS NULL OR genre_enrich_discogs IS NULL)
      AND artist IS NOT NULL AND trim(artist) != ''`);
  const artistsNf = c(`
    SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files
    WHERE genre_enrich_lastfm = 'nf' AND genre_enrich_mb = 'nf' AND genre_enrich_discogs = 'nf'`);
  // Enriched: all 3 sources have been processed by the worker (not NULL =
  // ok/nf/error), but the user has NOT yet made a decision in the compare screen.
  const enriched = c(`
    SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files
    WHERE genre_enrich_lastfm IS NOT NULL
      AND genre_enrich_mb     IS NOT NULL
      AND genre_enrich_discogs IS NOT NULL
      AND (genre_user_reviewed IS NULL OR genre_user_reviewed = 0)
  `);
  // Applied: user explicitly made a decision (apply source / keep / custom).
  const applied = c(`
    SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files
    WHERE genre_user_reviewed = 1
  `);
  // Enriched with empty current genre (the "No genre yet" filter population).
  const fillableEmpty = c(`
    SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files
    WHERE genre_enrich_lastfm IS NOT NULL
      AND genre_enrich_mb     IS NOT NULL
      AND genre_enrich_discogs IS NOT NULL
      AND (genre_user_reviewed IS NULL OR genre_user_reviewed = 0)
      AND (genre IS NULL OR trim(genre) = '')
  `);
  // Artists where all 3 sources returned the same (non-empty) genre and user has NOT reviewed yet.
  const consensus = c(`
    SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files
    WHERE genre_enrich_lastfm IS NOT NULL
      AND genre_enrich_mb     IS NOT NULL
      AND genre_enrich_discogs IS NOT NULL
      AND (genre_user_reviewed IS NULL OR genre_user_reviewed = 0)
      AND genre_lastfm IS NOT NULL AND trim(genre_lastfm) != ''
      AND genre_mb     IS NOT NULL AND trim(genre_mb) != ''
      AND genre_discogs IS NOT NULL AND trim(genre_discogs) != ''
      AND lower(trim(genre_lastfm)) = lower(trim(genre_mb))
      AND lower(trim(genre_mb))     = lower(trim(genre_discogs))
  `);
  // Artists where exactly 2 of 3 sources agree and the third has no data yet.
  const majority = c(String.raw`
    SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files
    WHERE (genre_user_reviewed IS NULL OR genre_user_reviewed = 0)
    AND (
      (lower(trim(genre_lastfm)) = lower(trim(genre_mb))
        AND genre_lastfm IS NOT NULL AND trim(genre_lastfm) != ''
        AND genre_mb     IS NOT NULL AND trim(genre_mb)     != ''
        AND (genre_discogs IS NULL OR trim(genre_discogs) = '')
      ) OR (
       lower(trim(genre_lastfm)) = lower(trim(genre_discogs))
        AND genre_lastfm  IS NOT NULL AND trim(genre_lastfm)  != ''
        AND genre_discogs IS NOT NULL AND trim(genre_discogs) != ''
        AND (genre_mb IS NULL OR trim(genre_mb) = '')
      ) OR (
       lower(trim(genre_mb)) = lower(trim(genre_discogs))
        AND genre_mb      IS NOT NULL AND trim(genre_mb)      != ''
        AND genre_discogs IS NOT NULL AND trim(genre_discogs) != ''
        AND (genre_lastfm IS NULL OR trim(genre_lastfm) = '')
      )
    )
  `);
  // done: all 3 sources processed (any result); found: at least one genre discovered.
  const done = enriched + applied;
  const found = c(`
    SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files
    WHERE (genre_lastfm IS NOT NULL OR genre_mb IS NOT NULL OR genre_discogs IS NOT NULL)
      AND artist IS NOT NULL AND trim(artist) != ''`);
  return {
    total,
    byState: { lastfm: lf, mb, discogs: dg },
    enriched, applied,
    fillableEmpty, consensus, majority,
    artistsQueued,
    artistsNf,
    done, found,
    queued: lf.queued + mb.queued + dg.queued,
    lfQueue: lf.queued, mbQueue: mb.queued, dgQueue: dg.queued,
    not_found: lf.nf + mb.nf + dg.nf,
    errors: lf.error + mb.error + dg.error,
    bySource: { lastfm: lf.ok, mb: mb.ok, discogs: dg.ok },
  };
}

// ── Schema migration ──────────────────────────────────────────────────────────
function _migrateSchema() {
  const exec = sql => { try { db.getDB().exec(sql); } catch { /* exists */ } };
  exec('ALTER TABLE files ADD COLUMN genre_lastfm TEXT');
  exec('ALTER TABLE files ADD COLUMN genre_mb TEXT');
  exec('ALTER TABLE files ADD COLUMN genre_discogs TEXT');
  exec('ALTER TABLE files ADD COLUMN genre_enrich_lastfm TEXT');
  exec('ALTER TABLE files ADD COLUMN genre_enrich_mb TEXT');
  exec('ALTER TABLE files ADD COLUMN genre_enrich_discogs TEXT');
  exec('ALTER TABLE files ADD COLUMN genre_lastfm_src TEXT'); // legacy — kept

  // Indexes — critical for queue lookups (full-table scan otherwise)
  exec('CREATE INDEX IF NOT EXISTS idx_files_genre_enrich_lastfm  ON files(genre_enrich_lastfm)');
  exec('CREATE INDEX IF NOT EXISTS idx_files_genre_enrich_mb      ON files(genre_enrich_mb)');
  exec('CREATE INDEX IF NOT EXISTS idx_files_genre_enrich_discogs ON files(genre_enrich_discogs)');
  // Functional index so WHERE lower(trim(artist))=? uses an index seek instead
  // of a full table scan — speeds up apply, set-genre, and compare GROUP BY.
  exec('CREATE INDEX IF NOT EXISTS idx_files_artist_lc ON files(lower(trim(artist)))');
  // User-decision flag: set to 1 when the user explicitly applies/keeps a genre
  // via the compare screen.  0 / NULL = still in the Enriched (work) queue.
  exec('ALTER TABLE files ADD COLUMN genre_user_reviewed INTEGER DEFAULT 0');

  // Legacy migration — translate old `genre_lastfm_src` sentinels into per-
  // source state columns so existing data is not refetched. This MUST be
  // strictly one-shot: every UPDATE only matches rows where ALL three new
  // state columns are still NULL (i.e. the worker has not touched them yet),
  // and at the end we null out `genre_lastfm_src` so the migration can never
  // run again. Without this guard a second boot would clobber freshly-written
  // genre_lastfm values into genre_mb / genre_discogs columns.
  const rawDb = db.getDB();
  let totalMigrated = 0;
  try {
    const untouched = 'genre_enrich_lastfm IS NULL AND genre_enrich_mb IS NULL AND genre_enrich_discogs IS NULL';
    // src='lastfm' → genre_lastfm already holds the result, mark lf=ok
    let r = rawDb.prepare(`UPDATE files SET genre_enrich_lastfm = 'ok' WHERE genre_lastfm_src = 'lastfm' AND genre_lastfm IS NOT NULL AND ${untouched}`).run();
    totalMigrated += r.changes;
    // src='mb' → genre_lastfm column actually holds MB result; move it to genre_mb
    r = rawDb.prepare(`UPDATE files SET genre_mb = genre_lastfm, genre_enrich_mb = 'ok', genre_enrich_lastfm = 'nf', genre_lastfm = NULL WHERE genre_lastfm_src = 'mb' AND ${untouched}`).run();
    totalMigrated += r.changes;
    // src='discogs' → genre_lastfm holds Discogs result; move it
    r = rawDb.prepare(`UPDATE files SET genre_discogs = genre_lastfm, genre_enrich_discogs = 'ok', genre_enrich_lastfm = 'nf', genre_enrich_mb = 'nf', genre_lastfm = NULL WHERE genre_lastfm_src = 'discogs' AND ${untouched}`).run();
    totalMigrated += r.changes;
    // src='lastfm-nf' → Last.fm tried, nothing
    r = rawDb.prepare(`UPDATE files SET genre_enrich_lastfm = 'nf' WHERE genre_lastfm_src = 'lastfm-nf' AND ${untouched}`).run();
    totalMigrated += r.changes;
    // src='mb-nf' → Last.fm + MB tried, both nothing
    r = rawDb.prepare(`UPDATE files SET genre_enrich_lastfm = 'nf', genre_enrich_mb = 'nf' WHERE genre_lastfm_src = 'mb-nf' AND ${untouched}`).run();
    totalMigrated += r.changes;
    // src='nf' → all three tried, nothing
    r = rawDb.prepare(`UPDATE files SET genre_enrich_lastfm = 'nf', genre_enrich_mb = 'nf', genre_enrich_discogs = 'nf' WHERE genre_lastfm_src = 'nf' AND ${untouched}`).run();
    totalMigrated += r.changes;
    // src='error' → leave NULL so worker retries everything
    if (totalMigrated > 0) winston.info(`[genre-enricher] Legacy migration: updated ${totalMigrated} rows from genre_lastfm_src sentinels`);

    // CRITICAL: null out the legacy sentinel column AFTER successful translation
    // so the migration can never run again. Without this, a subsequent boot
    // would re-apply the moves on rows the worker has freshly written.
    const cleared = rawDb.prepare("UPDATE files SET genre_lastfm_src = NULL WHERE genre_lastfm_src IS NOT NULL").run();
    if (cleared.changes > 0) winston.info(`[genre-enricher] Legacy migration: cleared ${cleared.changes} genre_lastfm_src sentinels (one-shot)`);

    // One-time lowercase sweep: standardise capitalisation across all
    // genre columns so "Pop" (Discogs) and "pop" (Last.fm) compare equal
    // and so file-tag genres line up too. Runs on each boot but is a no-op
    // once every value is already lowercased.
    let lcTotal = 0;
    for (const col of ['genre', 'genre_lastfm', 'genre_mb', 'genre_discogs']) {
      try {
        const r = rawDb.prepare(
          `UPDATE files SET ${col} = lower(${col}) WHERE ${col} IS NOT NULL AND ${col} != lower(${col})`
        ).run();
        lcTotal += r.changes;
      } catch { /* column might not exist yet on a brand-new DB */ }
    }
    if (lcTotal > 0) winston.info(`[genre-enricher] Lowercase sweep: normalised ${lcTotal} rows`);

    // Null-byte cleanup: some encoders store multi-value ID3/APE frames with
    // NUL (char 0) separators.  The scanner now strips these on insert, but
    // existing DBs may still have corrupt rows.  Truncate every affected text
    // field at the first NUL byte.  Runs on each boot but is a no-op once
    // the data is already clean (the WHERE clause matches 0 rows).
    let nullFixed = 0;
    for (const col of ['artist', 'album_artist', 'title', 'album']) {
      try {
        const r = rawDb.prepare(
          `UPDATE files SET ${col} = substr(${col}, 1, instr(${col}, char(0)) - 1) WHERE instr(${col}, char(0)) > 0`
        ).run();
        nullFixed += r.changes;
      } catch { /* column might not exist on a brand-new DB */ }
    }
    if (nullFixed > 0) {
      winston.warn(`[genre-enricher] Null-byte cleanup: repaired ${nullFixed} corrupt tag values — rebuilding artist index`);
      try { rawDb.exec('REINDEX idx_files_artist_lc'); } catch { /* noop */ }
    }

    // Junk-artist pre-clear: artist values that are pure digits (years like 1989 /
    // 2021, track numbers, etc.) will never match anything on Last.fm, MusicBrainz
    // or Discogs — skip them immediately so they don't clog the queue.
    // GLOB '[0-9]...' covers 1–6 digit all-numeric strings; the check is
    // deliberately strict (only pure-digit) to avoid filtering "10cc" or "2Pac".
    try {
      const junkGlobs = ['[0-9]','[0-9][0-9]','[0-9][0-9][0-9]','[0-9][0-9][0-9][0-9]','[0-9][0-9][0-9][0-9][0-9]','[0-9][0-9][0-9][0-9][0-9][0-9]'];
      const junkWhere = junkGlobs.map(p => `trim(artist) GLOB '${p}'`).join(' OR ');
      const rj = rawDb.prepare(
        `UPDATE files SET genre_enrich_lastfm = 'nf', genre_enrich_mb = 'nf', genre_enrich_discogs = 'nf'
           WHERE (genre_enrich_lastfm IS NULL OR genre_enrich_mb IS NULL OR genre_enrich_discogs IS NULL)
             AND artist IS NOT NULL AND trim(artist) != ''
             AND (${junkWhere})`
      ).run();
      if (rj.changes > 0) winston.info(`[genre-enricher] Junk artist cleanup: skipped ${rj.changes} pure-digit artist values`);
    } catch { /* noop */ }
  } catch (e) { winston.warn(`[genre-enricher] Legacy migration failed: ${e.message}`); }
}

// ── Module-scope helpers (used by setup) ──────────────────────────────────────
function _queueGenreStart(reason, bypassQueueLimit = false, requireIntent = false) {
  broker.submit('genre-enricher-start', 'Genre Enricher start', async () => {
    try {
      if (_running || _stopping) return;
      if (requireIntent && !_startRequested) return;

      const apiKey = config.program?.lastFM?.apiKey?.trim() || '';
      if (apiKey.length < 4) return;

      const stats = _liveStats();
      if (stats.artistsQueued <= 0) {
        if (requireIntent) _startRequested = false;
        return;
      }
      if (!bypassQueueLimit && stats.artistsQueued >= 500) {
        winston.info(`[genre-enricher] Auto-start skipped: ${stats.artistsQueued} artists queued — backlog too large, start from Admin`);
        return;
      }

      _spawnWorker();
      winston.info(`[genre-enricher] ${reason}: ${stats.artistsQueued} artists queued`);
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  });
}

function _clearState(value, source) {
  const rawDb = db.getDB();
  if (source && !_VALID_SOURCES.has(source)) throw new Error(`Invalid source: ${source}`);
  const cols = source ? [_COL_STATE[source]] : Object.values(_COL_STATE);
  const genCols = source ? [_COL_GENRE[source]] : Object.values(_COL_GENRE);
  let total = 0;
  for (let i = 0; i < cols.length; i++) {
    const r = rawDb.prepare(
      `UPDATE files SET ${cols[i]} = NULL, ${genCols[i]} = NULL WHERE ${cols[i]} = ?`
    ).run(value);
    total += r.changes;
  }
  return total;
}

// ── Express setup ─────────────────────────────────────────────────────────────
export function setup(velvet) {
  _migrateSchema();
  // Boot-time + post-scan auto-start.
  // The genre enricher has no auto-start of its own — this adds one.
  // Requires a Last.fm API key (same gate as the manual start endpoint).
  // 60 s delay at boot so DB is fully initialised before the first check.
  setTimeout(() => _queueGenreStart('Auto-started'), 60_000);
  // When a scan starts, stop the enricher immediately so it doesn't fight the
  // scanner for DB write access (SQLITE_BUSY retries).
  onEveryScanStart(() => {
    if (!_running || !_worker) return;
    _pausedByScan = true;
    _startRequested = true;
    _stopping = true;
    _worker.postMessage({ type: 'stop' });
    winston.info('[genre-enricher] Paused: file scan started — will resume when scan finishes');
  });
  // Re-check after every scan so newly discovered artists are enriched.
  // If the enricher was paused by a scan, or a manual start was queued during
  // the scan, bypass the 500-artist queue limit and start immediately.
  onEveryScanEnd(() => {
    const wasPaused = _pausedByScan || _startRequested;
    _pausedByScan = false;
    if (wasPaused) {
      _queueGenreStart('Resumed after scan', true, true);
    } else {
      _queueGenreStart('Auto-started');
    }
  });
  // Admin-only guard
  velvet.all('/api/v1/admin/genre-enricher/{*path}', (req, res, next) => {
    if (req.user?.admin !== true) return res.status(403).json({ error: 'Admin only' });
    next();
  });

  // GET /status
  velvet.get('/api/v1/admin/genre-enricher/status', (req, res) => {
    try {
      res.json({
        running:        _running,
        stopping:       _stopping,
        pendingStart:   _startRequested && !_running,
        startedAt:      _startedAt,
        currentArtist:  _currentArtist,
        currentPhase:   _currentPhase,
        processedCount: _processedCount,
        stats:          _liveStats(),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /start
  velvet.post('/api/v1/admin/genre-enricher/start', (req, res) => {
    if (_running) return res.json({ ok: true, message: 'Already running' });
    const apiKey = config.program?.lastFM?.apiKey?.trim() || '';
    if (apiKey.length < 4) {
      return res.status(400).json({ error: 'No Last.fm API key configured. Add it in External Services → Last.fm.' });
    }
    _startRequested = true;
    _queueGenreStart('Started by admin', true, true);
    if (isScanRunning()) {
      winston.info('[genre-enricher] Start queued in broker: file scan in progress — will start when scan finishes');
      return res.json({ ok: true, pending: true });
    }
    res.json({ ok: true });
  });

  // POST /stop
  velvet.post('/api/v1/admin/genre-enricher/stop', (req, res) => {
    if (_startRequested) {
      _startRequested = false;
      winston.info('[genre-enricher] Pending start cancelled by admin');
      if (!_running) return res.json({ ok: true, message: 'Pending start cancelled' });
    }
    if (!_running || !_worker) return res.json({ ok: true, message: 'Not running' });
    if (_stopping) return res.json({ ok: true, message: 'Already stopping' });
    _stopping = true;
    _worker.postMessage({ type: 'stop' });
    winston.info('[genre-enricher] Stop signal sent');
    setTimeout(() => {
      if (_worker && _stopping) {
        winston.warn('[genre-enricher] Worker did not stop in 15 s — force-terminating');
        _worker.terminate();
        _resetWorkerState();
      }
    }, 15_000);
    res.json({ ok: true });
  });

  // POST /reset-errors  body: { source? }
  velvet.post('/api/v1/admin/genre-enricher/reset-errors', (req, res) => {
    if (_running) return res.status(400).json({ error: 'Stop the enricher first' });
    try {
      const count = _clearState('error', req.body?.source);
      res.json({ ok: true, reset: count });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /reset-not-found  body: { source? }
  velvet.post('/api/v1/admin/genre-enricher/reset-not-found', (req, res) => {
    if (_running) return res.status(400).json({ error: 'Stop the enricher first' });
    try {
      const count = _clearState('nf', req.body?.source);
      res.json({ ok: true, reset: count });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /reset-source  body: { source }
  // Wipes ALL state + genre for a single source so it gets re-fetched from
  // scratch. Useful to rescan MB or Discogs after the user enables those keys.
  velvet.post('/api/v1/admin/genre-enricher/reset-source', (req, res) => {
    if (_running) return res.status(400).json({ error: 'Stop the enricher first' });
    const source = req.body?.source;
    if (!_VALID_SOURCES.has(source)) return res.status(400).json({ error: 'source must be lastfm, mb, or discogs' });
    try {
      const r = db.getDB().prepare(
        `UPDATE files SET ${_COL_GENRE[source]} = NULL, ${_COL_STATE[source]} = NULL WHERE ${_COL_GENRE[source]} IS NOT NULL OR ${_COL_STATE[source]} IS NOT NULL`
      ).run();
      winston.info(`[genre-enricher] reset-source ${source}: ${r.changes} rows`);
      res.json({ ok: true, reset: r.changes });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /reset-all
  velvet.post('/api/v1/admin/genre-enricher/reset-all', (req, res) => {
    if (_running) return res.status(400).json({ error: 'Stop the enricher first' });
    try {
      const r = db.getDB().prepare(
        "UPDATE files SET genre_lastfm = NULL, genre_mb = NULL, genre_discogs = NULL, genre_enrich_lastfm = NULL, genre_enrich_mb = NULL, genre_enrich_discogs = NULL, genre_lastfm_src = NULL WHERE genre_lastfm IS NOT NULL OR genre_mb IS NOT NULL OR genre_discogs IS NOT NULL OR genre_enrich_lastfm IS NOT NULL OR genre_enrich_mb IS NOT NULL OR genre_enrich_discogs IS NOT NULL OR genre_lastfm_src IS NOT NULL"
      ).run();
      res.json({ ok: true, reset: r.changes });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /compare ?filter=enriched|empty|applied  ?limit&offset
  // enriched: all 3 sources processed, user has NOT yet reviewed
  // empty:    same as enriched, but only artists whose current genre is blank
  // applied:  user explicitly made a decision via the compare screen
  velvet.get('/api/v1/admin/genre-enricher/compare', (req, res) => {
    const filter = ['enriched', 'empty', 'applied'].includes(req.query.filter) ? req.query.filter : 'enriched';
    const limit  = Math.min(200, Math.max(1, Number(req.query.limit)  || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const search      = typeof req.query.search      === 'string' ? req.query.search.trim()      : '';
    const currentGenre = typeof req.query.currentGenre === 'string' ? req.query.currentGenre.trim() : '';
    try {
      const rawDb = db.getDB();
      let where;
      if (filter === 'enriched' || filter === 'empty') {
        where = 'genre_enrich_lastfm IS NOT NULL AND genre_enrich_mb IS NOT NULL AND genre_enrich_discogs IS NOT NULL' +
                ' AND (genre_user_reviewed IS NULL OR genre_user_reviewed = 0)';
        if (filter === 'empty') {
          where += " AND (genre IS NULL OR trim(genre) = '')";
        }
      } else {
        // applied
        where = 'genre_user_reviewed = 1';
      }
      const searchClause = search ? ` AND lower(trim(artist)) LIKE lower(trim(?))` : '';
      const searchParam  = search ? `%${search}%` : null;
      // currentGenre: exact case-insensitive match on the genre column
      const genreClause = currentGenre ? ` AND lower(trim(genre)) = lower(trim(?))` : '';
      const queryParams = [
        ...(searchParam    ? [searchParam]    : []),
        ...(currentGenre   ? [currentGenre]   : []),
      ];

      const countRow = rawDb.prepare(
        `SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE ${where}${searchClause}${genreClause}`
      ).get(...queryParams);
      const rows = rawDb.prepare(
        String.raw`SELECT artist,
                COUNT(*) AS file_count,
                MAX(genre) AS current_genre,
                MAX(genre_lastfm)  AS lastfm_genre,
                MAX(genre_mb)      AS mb_genre,
                MAX(genre_discogs) AS discogs_genre,
                MAX(genre_enrich_lastfm)  AS lf_state,
                MAX(genre_enrich_mb)      AS mb_state,
                MAX(genre_enrich_discogs) AS dg_state,
                /* Clean display name from the artist-normalisation index.
                   The artist_raw_variants column is a JSON array; we match
                   the raw value as a quoted JSON entry "<raw>". */
                (SELECT an.artist_clean FROM artists_normalized an
                   WHERE an.artist_raw_variants LIKE '%"' || replace(files.artist, '"', '\"') || '"%'
                   LIMIT 1) AS display_name
         FROM files
         WHERE ${where}${searchClause}${genreClause}
         GROUP BY lower(trim(artist))
         ORDER BY artist COLLATE NOCASE
         LIMIT ? OFFSET ?`
      ).all(...queryParams, limit, offset);

      // Apply a regex-based fallback for rows that have no mapping in
      // artists_normalized yet (e.g. an artist that only ever appears as
      // "01. Lady Gaga" in the library — strip the track-number prefix so
      // the compare UI shows a clean name).
      for (const r of rows) {
        if (!r.display_name) {
          const stripped = stripDigitPrefix(r.artist || '');
          if (stripped && stripped !== r.artist) r.display_name = stripped;
        }
      }

      res.json({ total: countRow?.c ?? 0, offset, rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /apply
  // Body: { items: [{ artist, source }] }  source = 'lastfm'|'mb'|'discogs'|'keep'
  // 'keep' marks the artist as reviewed without changing their genre.
  // Legacy: { artists: [...], source? }
  velvet.post('/api/v1/admin/genre-enricher/apply', (req, res) => {
    const body = req.body || {};
    let items = [];
    if (Array.isArray(body.items)) {
      items = body.items;
    } else if (Array.isArray(body.artists)) {
      const src = _VALID_SOURCES.has(body.source) ? body.source : 'lastfm';
      items = body.artists.map(a => ({ artist: a, source: src }));
    }
    const VALID_WITH_KEEP = new Set([..._VALID_SOURCES, 'keep']);
    items = items.filter(it => it && typeof it.artist === 'string' && VALID_WITH_KEEP.has(it.source));
    if (!items.length) return res.status(400).json({ error: 'items array required: [{artist, source}]' });

    try {
      const rawDb = db.getDB();
      let total = 0;
      for (const { artist, source } of items) {
        if (source === 'keep') {
          // Mark reviewed without touching genre
          rawDb.prepare(
            'UPDATE files SET genre_user_reviewed = 1 WHERE lower(trim(artist)) = lower(trim(?))'
          ).run(artist);
        } else {
          const col = _COL_GENRE[source];
          // Always lowercase the value we copy into `genre` so it matches the
          // canonical (lowercased) form used everywhere else.
          const r = rawDb.prepare(
            `UPDATE files SET genre = lower(${col}), genre_user_reviewed = 1 WHERE lower(trim(artist)) = lower(trim(?)) AND ${col} IS NOT NULL AND trim(${col}) != ''`
          ).run(artist);
          total += r.changes;
        }
      }
      res.json({ ok: true, updated: total });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /apply-all-consensus
  // Applies the agreed genre for every unreviewed artist where Last.fm, MB and
  // Discogs all returned the same non-empty genre value.
  velvet.post('/api/v1/admin/genre-enricher/apply-all-consensus', (req, res) => {
    try {
      const rawDb = db.getDB();
      const r = rawDb.prepare(String.raw`
        UPDATE files
           SET genre = lower(trim(genre_lastfm)), genre_user_reviewed = 1
         WHERE genre_lastfm  IS NOT NULL AND trim(genre_lastfm)  != ''
           AND genre_mb      IS NOT NULL AND trim(genre_mb)      != ''
           AND genre_discogs IS NOT NULL AND trim(genre_discogs) != ''
           AND lower(trim(genre_lastfm)) = lower(trim(genre_mb))
           AND lower(trim(genre_mb))     = lower(trim(genre_discogs))
           AND (genre_user_reviewed IS NULL OR genre_user_reviewed = 0)
      `).run();
      res.json({ ok: true, updated: r.changes });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /apply-all-majority
  // Applies the majority genre for every unreviewed artist where exactly 2 of 3
  // sources agree and the third source has no data yet.
  velvet.post('/api/v1/admin/genre-enricher/apply-all-majority', (req, res) => {
    try {
      const rawDb = db.getDB();
      const r = rawDb.prepare(String.raw`
        UPDATE files
           SET genre = lower(trim(
             CASE
               WHEN lower(trim(genre_lastfm)) = lower(trim(genre_mb))
                    AND genre_lastfm IS NOT NULL AND trim(genre_lastfm) != ''
                    AND genre_mb     IS NOT NULL AND trim(genre_mb)     != ''
                    AND (genre_discogs IS NULL OR trim(genre_discogs) = '')
               THEN genre_lastfm
               WHEN lower(trim(genre_lastfm)) = lower(trim(genre_discogs))
                    AND genre_lastfm  IS NOT NULL AND trim(genre_lastfm)  != ''
                    AND genre_discogs IS NOT NULL AND trim(genre_discogs) != ''
                    AND (genre_mb IS NULL OR trim(genre_mb) = '')
               THEN genre_lastfm
               WHEN lower(trim(genre_mb)) = lower(trim(genre_discogs))
                    AND genre_mb      IS NOT NULL AND trim(genre_mb)      != ''
                    AND genre_discogs IS NOT NULL AND trim(genre_discogs) != ''
                    AND (genre_lastfm IS NULL OR trim(genre_lastfm) = '')
               THEN genre_mb
             END
           )),
               genre_user_reviewed = 1
         WHERE (genre_user_reviewed IS NULL OR genre_user_reviewed = 0)
           AND (
             (lower(trim(genre_lastfm)) = lower(trim(genre_mb))
               AND genre_lastfm IS NOT NULL AND trim(genre_lastfm) != ''
               AND genre_mb     IS NOT NULL AND trim(genre_mb)     != ''
               AND (genre_discogs IS NULL OR trim(genre_discogs) = '')) OR
             (lower(trim(genre_lastfm)) = lower(trim(genre_discogs))
               AND genre_lastfm  IS NOT NULL AND trim(genre_lastfm)  != ''
               AND genre_discogs IS NOT NULL AND trim(genre_discogs) != ''
               AND (genre_mb IS NULL OR trim(genre_mb) = '')) OR
             (lower(trim(genre_mb)) = lower(trim(genre_discogs))
               AND genre_mb      IS NOT NULL AND trim(genre_mb)      != ''
               AND genre_discogs IS NOT NULL AND trim(genre_discogs) != ''
               AND (genre_lastfm IS NULL OR trim(genre_lastfm) = ''))
           )
      `).run();
      res.json({ ok: true, updated: r.changes });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /apply-all-empty  body: { source }
  // source = 'lastfm' | 'mb' | 'discogs' | 'preferred' (default)
  // 'preferred' uses MB → Discogs → Last.fm priority (MB is most curated).
  velvet.post('/api/v1/admin/genre-enricher/apply-all-empty', (req, res) => {
    const source = req.body?.source || 'preferred';
    if (source !== 'preferred' && !_VALID_SOURCES.has(source)) {
      return res.status(400).json({ error: 'source must be preferred, lastfm, mb, or discogs' });
    }
    try {
      const rawDb = db.getDB();
      let sql;
      if (source === 'preferred') {
        sql = "UPDATE files SET genre = lower(COALESCE(genre_mb, genre_discogs, genre_lastfm)) " +
              "WHERE (genre IS NULL OR trim(genre) = '') " +
              "AND COALESCE(genre_mb, genre_discogs, genre_lastfm) IS NOT NULL";
      } else {
        const col = _COL_GENRE[source];
        sql = `UPDATE files SET genre = lower(${col}) WHERE (genre IS NULL OR trim(genre) = '') AND ${col} IS NOT NULL AND trim(${col}) != ''`;
      }
      const r = rawDb.prepare(sql).run();
      res.json({ ok: true, updated: r.changes, source });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /set-genre  body: { artist, genre }
  // Overwrites the current `genre` column for every file by this artist with
  // the user-supplied value. Empty/whitespace clears it (sets NULL). Value is
  // lowercased to keep the dataset standardised.
  velvet.post('/api/v1/admin/genre-enricher/set-genre', (req, res) => {
    const artist = typeof req.body?.artist === 'string' ? req.body.artist.trim() : '';
    if (!artist) return res.status(400).json({ error: 'artist required' });
    const raw = typeof req.body?.genre === 'string' ? req.body.genre.trim() : '';
    const value = raw ? raw.toLowerCase() : null;
    try {
      const rawDb = db.getDB();
      const r = rawDb.prepare(
        'UPDATE files SET genre = ?, genre_user_reviewed = 1 WHERE lower(trim(artist)) = lower(trim(?))'
      ).run(value, artist);
      res.json({ ok: true, updated: r.changes, value });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
