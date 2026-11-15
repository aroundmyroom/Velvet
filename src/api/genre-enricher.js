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
 *   genre_user_reviewed   INTEGER — 1 once the admin decided in the compare screen
 *
 * The queries live in src/db/sqlite-backend.js (genreEnricher*).
 *
 * Endpoints (admin-only):
 *   GET  /api/v1/admin/genre-enricher/status
 *   POST /api/v1/admin/genre-enricher/start
 *   POST /api/v1/admin/genre-enricher/stop
 *   POST /api/v1/admin/genre-enricher/reset-errors        body: { source? }
 *   POST /api/v1/admin/genre-enricher/reset-not-found     body: { source? }
 *   POST /api/v1/admin/genre-enricher/reset-source        body: { source }
 *   POST /api/v1/admin/genre-enricher/reset-all
 *   GET  /api/v1/admin/genre-enricher/compare   ?filter&limit&offset&search&currentGenre
 *   POST /api/v1/admin/genre-enricher/apply               body: { items: [{artist, source}] }
 *   POST /api/v1/admin/genre-enricher/apply-all-consensus
 *   POST /api/v1/admin/genre-enricher/apply-all-majority
 *   POST /api/v1/admin/genre-enricher/apply-all-empty     body: { source }
 *   POST /api/v1/admin/genre-enricher/set-genre           body: { artist, genre }
 */

import path from 'node:path';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { getDirname } from '../util/esm-helpers.js';
import { stripDigitPrefix } from '../util/artist-normalize.js';
import { createWorkerController } from '../util/worker-controller.js';
import { discogsCredentials } from './discogs.js';

const __dirname = getDirname(import.meta.url);

const _VALID_SOURCES = new Set(['lastfm', 'mb', 'discogs']);

// ── Worker state ──────────────────────────────────────────────────────────────
let _currentArtist  = null;
let _currentPhase   = null;
let _processedCount = 0;

function _lastfmKey() {
  return config.program?.lastFM?.apiKey?.trim() || '';
}

function _workerData() {
  return {
    dbPath: db.dbFilePath(),
    lastfmApiKey: _lastfmKey(),
    discogs: discogsCredentials(),
  };
}

const _ge = createWorkerController({
  name: 'genre-enricher',
  path: path.join(__dirname, '../util/genre-enricher-worker.mjs'),
  workerData: _workerData,
  queued: () => (_lastfmKey().length >= 4 ? db.genreEnricherArtistsQueued() : 0),
  autoStartAfterEveryScan: true,
  stopTimeoutMs: 15_000,
  onSpawn() { _processedCount = 0; },
  onReset() { _currentArtist = null; _currentPhase = null; },
  onMessage(msg) {
    if (msg.type === 'progress') {
      _currentArtist  = msg.currentArtist || null;
      _currentPhase   = msg.currentPhase  || null;
      _processedCount = msg.processedCount ?? _processedCount;
    }
    if (msg.type === 'fileError') winston.warn(`[genre-enricher] ${msg.message}`);
  },
});

function _migrateSchema() {
  try {
    const r = db.genreEnricherMigrate();
    if (r.legacyMigrated > 0) winston.info(`[genre-enricher] Legacy migration: updated ${r.legacyMigrated} rows from genre_lastfm_src sentinels`);
    if (r.legacyCleared > 0) winston.info(`[genre-enricher] Legacy migration: cleared ${r.legacyCleared} genre_lastfm_src sentinels (one-shot)`);
    if (r.lowercased > 0) winston.info(`[genre-enricher] Lowercase sweep: normalised ${r.lowercased} rows`);
    if (r.nulFixed > 0) winston.warn(`[genre-enricher] Null-byte cleanup: repaired ${r.nulFixed} corrupt tag values — rebuilt artist index`);
    if (r.junkSkipped > 0) winston.info(`[genre-enricher] Junk artist cleanup: skipped ${r.junkSkipped} pure-digit artist values`);
  } catch (e) { winston.warn(`[genre-enricher] Schema migration failed: ${e.message}`); }
}

// ── Express setup ─────────────────────────────────────────────────────────────
export function setup(velvet) {
  _migrateSchema();
  // 60 s delay at boot so DB is fully initialised before the first check.
  setTimeout(() => _ge.autoStart(), 60_000).unref();
  velvet.all('/api/v1/admin/genre-enricher/{*path}', (req, res, next) => {
    if (req.user?.admin !== true) return res.status(403).json({ error: 'Admin only' });
    next();
  });

  velvet.get('/api/v1/admin/genre-enricher/status', (req, res) => {
    try {
      res.json({
        running:        _ge.running,
        stopping:       _ge.stopping,
        pendingStart:   _ge.pendingStart,
        startedAt:      _ge.startedAt,
        currentArtist:  _currentArtist,
        currentPhase:   _currentPhase,
        processedCount: _processedCount,
        stats:          db.genreEnricherStats(),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  velvet.post('/api/v1/admin/genre-enricher/start', async (req, res) => {
    if (_lastfmKey().length < 4) {
      return res.status(400).json({ error: 'No Last.fm API key configured. Add it in External Services → Last.fm.' });
    }
    const status = await _ge.start();
    if (status === 'already_running') return res.json({ ok: true, message: 'Already running' });
    if (status === 'pending') return res.json({ ok: true, pending: true });
    res.json({ ok: true });
  });

  velvet.post('/api/v1/admin/genre-enricher/stop', (req, res) => {
    const status = _ge.stop();
    if (status === 'pending_cancelled') return res.json({ ok: true, message: 'Pending start cancelled' });
    if (status === 'not_running') return res.json({ ok: true, message: 'Not running' });
    if (status === 'already_stopping') return res.json({ ok: true, message: 'Already stopping' });
    res.json({ ok: true });
  });

  const resetState = value => (req, res) => {
    if (_ge.running) return res.status(400).json({ error: 'Stop the enricher first' });
    const source = req.body?.source;
    if (source && !_VALID_SOURCES.has(source)) return res.status(400).json({ error: 'source must be lastfm, mb, or discogs' });
    try {
      res.json({ ok: true, reset: db.genreEnricherClearState(value, source) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
  velvet.post('/api/v1/admin/genre-enricher/reset-errors', resetState('error'));
  velvet.post('/api/v1/admin/genre-enricher/reset-not-found', resetState('nf'));

  // Wipes ALL state + genre for a single source so it gets re-fetched from
  // scratch. Useful to rescan MB or Discogs after the user enables those keys.
  velvet.post('/api/v1/admin/genre-enricher/reset-source', (req, res) => {
    if (_ge.running) return res.status(400).json({ error: 'Stop the enricher first' });
    const source = req.body?.source;
    if (!_VALID_SOURCES.has(source)) return res.status(400).json({ error: 'source must be lastfm, mb, or discogs' });
    try {
      const reset = db.genreEnricherResetSource(source);
      winston.info(`[genre-enricher] reset-source ${source}: ${reset} rows`);
      res.json({ ok: true, reset });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  velvet.post('/api/v1/admin/genre-enricher/reset-all', (req, res) => {
    if (_ge.running) return res.status(400).json({ error: 'Stop the enricher first' });
    try {
      res.json({ ok: true, reset: db.genreEnricherResetAll() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // filter: enriched (all 3 sources processed, not reviewed) | empty (same, blank genre) | applied (reviewed)
  velvet.get('/api/v1/admin/genre-enricher/compare', (req, res) => {
    const filter = ['enriched', 'empty', 'applied'].includes(req.query.filter) ? req.query.filter : 'enriched';
    const limit  = Math.min(200, Math.max(1, Number(req.query.limit)  || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const search       = typeof req.query.search       === 'string' ? req.query.search.trim()       : '';
    const currentGenre = typeof req.query.currentGenre === 'string' ? req.query.currentGenre.trim() : '';
    try {
      const { total, rows } = db.genreEnricherCompare({ filter, search, currentGenre, limit, offset });
      // Artists with no artists_normalized mapping yet: strip a track-number prefix ("01. Lady Gaga")
      for (const r of rows) {
        if (!r.display_name) {
          const stripped = stripDigitPrefix(r.artist || '');
          if (stripped && stripped !== r.artist) r.display_name = stripped;
        }
      }
      res.json({ total, offset, rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // source = 'lastfm' | 'mb' | 'discogs' | 'keep' ('keep' marks the artist reviewed without changing the genre)
  velvet.post('/api/v1/admin/genre-enricher/apply', (req, res) => {
    const VALID_WITH_KEEP = new Set([..._VALID_SOURCES, 'keep']);
    const items = (Array.isArray(req.body?.items) ? req.body.items : [])
      .filter(it => it && typeof it.artist === 'string' && VALID_WITH_KEEP.has(it.source));
    if (!items.length) return res.status(400).json({ error: 'items array required: [{artist, source}]' });
    try {
      res.json({ ok: true, updated: db.genreEnricherApply(items) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Every unreviewed artist where Last.fm, MusicBrainz and Discogs returned the same genre
  velvet.post('/api/v1/admin/genre-enricher/apply-all-consensus', (req, res) => {
    try {
      res.json({ ok: true, updated: db.genreEnricherApplyConsensus() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Every unreviewed artist where exactly 2 of 3 sources agree and the third has no value
  velvet.post('/api/v1/admin/genre-enricher/apply-all-majority', (req, res) => {
    try {
      res.json({ ok: true, updated: db.genreEnricherApplyMajority() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // source = 'lastfm' | 'mb' | 'discogs' | 'preferred' (default: MusicBrainz → Discogs → Last.fm)
  velvet.post('/api/v1/admin/genre-enricher/apply-all-empty', (req, res) => {
    const source = req.body?.source || 'preferred';
    if (source !== 'preferred' && !_VALID_SOURCES.has(source)) {
      return res.status(400).json({ error: 'source must be preferred, lastfm, mb, or discogs' });
    }
    try {
      res.json({ ok: true, updated: db.genreEnricherApplyAllEmpty(source), source });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Overwrites the genre of every file by this artist; blank clears it. Lowercased like every genre.
  velvet.post('/api/v1/admin/genre-enricher/set-genre', (req, res) => {
    const artist = typeof req.body?.artist === 'string' ? req.body.artist.trim() : '';
    if (!artist) return res.status(400).json({ error: 'artist required' });
    const raw = typeof req.body?.genre === 'string' ? req.body.genre.trim() : '';
    const value = raw ? raw.toLowerCase() : null;
    try {
      res.json({ ok: true, updated: db.genreEnricherSetGenre(artist, value), value });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
