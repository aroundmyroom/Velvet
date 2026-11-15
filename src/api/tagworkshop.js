/**
 * tagworkshop.js
 *
 * MusicBrainz enrichment worker lifecycle + Tag Workshop REST API.
 *
 * All endpoints are admin-only.
 *
 * MB Enrichment worker:
 *   POST /api/v1/tagworkshop/enrich/start  — start MB lookup worker
 *   POST /api/v1/tagworkshop/enrich/stop   — stop MB lookup worker
 *
 * MB Text Search fallback worker:
 *   POST /api/v1/tagworkshop/text-search/start          — start text-search worker
 *   POST /api/v1/tagworkshop/text-search/stop           — stop text-search worker
 *   POST /api/v1/tagworkshop/text-search/retry-notfound — reset not_found rows for retry
 *
 * Tag Workshop:
 *   GET  /api/v1/tagworkshop/status
 *   GET  /api/v1/tagworkshop/albums?page=N&filter=all|missing|year|artist&sort=broken|tracks|alpha
 *   GET  /api/v1/tagworkshop/album/:mb_release_id
 *   POST /api/v1/tagworkshop/accept-track  { filepath, vpath, overrides? }
 *   POST /api/v1/tagworkshop/skip          { mb_release_id }
 *   POST /api/v1/tagworkshop/bulk-accept-casing
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { getDirname } from '../util/esm-helpers.js';
import { createWorkerController } from '../util/worker-controller.js';
import { resolvePathWithinRoot } from '../util/path-security.js';
import { rootVpathOf } from '../util/vpath.js';
import { writeTags } from '../util/ffmpeg-tags.js';

const __dirname         = getDirname(import.meta.url);

// Both workers query MusicBrainz; the controller's shared limiter keeps their
// combined rate at ≤1 req/s, so they may run at the same time.
const _enrich = createWorkerController({
  name: 'tagworkshop-enrich',
  path: path.join(__dirname, '../util/mb-enrich-worker.mjs'),
  workerData: () => ({ dbPath: db.dbFilePath() }),
  queued: () => db.getTagWorkshopStatus()?.mb?.queued ?? 0,
  autoStartAfterEveryScan: true,
});

const _textSearch = createWorkerController({
  name: 'tagworkshop-text-search',
  path: path.join(__dirname, '../util/mb-text-search-worker.mjs'),
  workerData: () => ({ dbPath: db.dbFilePath() }),
  queued: () => db.getTagWorkshopStatus()?.textSearch?.queued ?? 0,
  autoStartAfterEveryScan: true,
});

const STOP_REPLY = {
  pending_cancelled: { message: 'Pending start cancelled' },
  not_running:       { message: 'Not running' },
  already_stopping:  { message: 'Already stopping' },
  stopping:          {},
};

function _startReply(status) {
  if (status === 'already_running') return { ok: true, message: 'Already running' };
  if (status === 'pending') return { ok: true, pending: true, message: 'Start queued: file scan in progress' };
  return { ok: true };
}

// ── Tag writing ───────────────────────────────────────────────────────────────

const WRITABLE_FORMATS = new Set(['mp3', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'wav', 'wma', 'aiff', 'aif']);

/**
 * Write audio tags to a file using ffmpeg stream copy.
 * Writes to a temp file first, then atomically renames over the original.
 * Returns null on success, error message on failure.
 */
async function writeTagsToFile(absolutePath, format, tags) {
  const fmt = (format || path.extname(absolutePath).slice(1) || '').toLowerCase();
  if (!WRITABLE_FORMATS.has(fmt)) {
    return `Unsupported format: ${fmt}`;
  }

  try {
    await writeTags(absolutePath, {
      title: tags.title, artist: tags.artist, album_artist: tags.album_artist,
      album: tags.album, date: tags.year, track: tags.track,
    });
    return null;
  } catch (err) {
    return err.message || String(err);
  }
}

/**
 * Returns true if finalTags differ from the track's current DB values,
 * meaning a disk write is actually needed.  Equal tracks are still marked
 * accepted in the DB so they leave the review queue, but the file is not
 * touched and its mtime is preserved.
 */
function _tagsHaveDiff(t, finalTags) {
  const norm = s => String(s ?? '').replaceAll(/\s+/g, ' ').trim().toLowerCase();
  if (norm(finalTags.title)        !== norm(t.title))        return true;
  if (norm(finalTags.artist)       !== norm(t.artist))       return true;
  if (norm(finalTags.album_artist) !== norm(t.album_artist)) return true;
  if (norm(finalTags.album)        !== norm(t.album))        return true;
  if ((finalTags.year  ?? null) !== (t.year  ?? null)) return true;
  if ((finalTags.track ?? null) !== (t.track ?? null)) return true;
  return false;
}

/**
 * Resolve absolute path from vpath + relative filepath.
 * Returns null if vpath not found in config.
 */
function resolveAbsPath(vpath, filepath) {
  const root = config.program.folders?.[vpath]?.root;
  if (!root) return null;
  try {
    return resolvePathWithinRoot(root, filepath);
  } catch {
    return null;
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

export function setup(velvet) {

  // 15 s delay at boot so the DB finishes initialising before querying.
  setTimeout(() => { _enrich.autoStart(); _textSearch.autoStart(); }, 15_000).unref();

  // Guard — all endpoints are admin-only
  velvet.all('/api/v1/tagworkshop/{*path}', (req, res, next) => {
    if (req.user?.admin !== true) return res.status(403).json({ error: 'Admin only' });
    next();
  });

  // ── MB Enrichment worker control ──────────────────────────────────────────

  // POST /api/v1/tagworkshop/enrich/start
  velvet.post('/api/v1/tagworkshop/enrich/start', async (req, res) => {
    res.json(_startReply(await _enrich.start()));
  });

  // POST /api/v1/tagworkshop/enrich/stop
  velvet.post('/api/v1/tagworkshop/enrich/stop', (req, res) => {
    res.json({ ok: true, ...STOP_REPLY[_enrich.stop()] });
  });

  // ── MB Text Search worker control ─────────────────────────────────────────────────

  // POST /api/v1/tagworkshop/text-search/start
  velvet.post('/api/v1/tagworkshop/text-search/start', async (req, res) => {
    res.json(_startReply(await _textSearch.start()));
  });

  // POST /api/v1/tagworkshop/text-search/stop
  velvet.post('/api/v1/tagworkshop/text-search/stop', (req, res) => {
    res.json({ ok: true, ...STOP_REPLY[_textSearch.stop()] });
  });

  // POST /api/v1/tagworkshop/text-search/retry-notfound
  velvet.post('/api/v1/tagworkshop/text-search/retry-notfound', (req, res) => {
    const result = db.resetMbTextSearchNotFound();
    res.json({ ok: true, ...result });
  });

  // GET /api/v1/tagworkshop/text-search/errors
  velvet.get('/api/v1/tagworkshop/text-search/errors', (req, res) => {
    const rows = db.getMbTextSearchErrors(200);
    res.json({ errors: rows, total: rows.length });
  });

  // POST /api/v1/tagworkshop/text-search/retry-errors
  velvet.post('/api/v1/tagworkshop/text-search/retry-errors', (req, res) => {
    const result = db.retryMbTextSearchErrors();
    res.json({ ok: true, ...result });
  });

  // ── Tag Workshop endpoints ──────────────────────────────────────────────────────────────────

  // GET /api/v1/tagworkshop/status
  velvet.get('/api/v1/tagworkshop/status', (req, res) => {
    const status = db.getTagWorkshopStatus();
    res.json({
      ...status,
      enrich:     { running: _enrich.running, stopping: _enrich.stopping },
      textSearch: { ...status.textSearch, running: _textSearch.running, stopping: _textSearch.stopping },
    });
  });

  // GET /api/v1/tagworkshop/folder?path=Music/Albums/...
  // Returns all audio files (direct children only) in the given folder with
  // both their current DB tags and any MusicBrainz enrichment data.
  // path format: "<vpath>/<relative-path>" — same as the file explorer directory param.
  // IMPORTANT: handles child vpaths — their files are stored in the DB under the parent
  // ROOT vpath, so we detect the parent and adjust the filepath prefix accordingly.
  velvet.get('/api/v1/tagworkshop/folder', (req, res) => {
    const raw = typeof req.query.path === 'string'
      ? req.query.path.replaceAll(/^\/+|\/+$/g, '')
      : '';
    if (!raw) return res.status(400).json({ error: 'path required' });

    const slash = raw.indexOf('/');
    const vpathName  = slash === -1 ? raw : raw.slice(0, slash);
    const userRelPath = slash === -1 ? '' : raw.slice(slash + 1);

    const folders = config.program.folders || {};
    if (!folders[vpathName]) {
      return res.status(404).json({ error: 'Unknown vpath' });
    }

    // Child vpath files are stored in the DB under their ROOT vpath
    const { vpath: dbVpath, prefix } = rootVpathOf(vpathName, folders);
    const files = db.getTagWorkshopFolderFiles(dbVpath, prefix + userRelPath);
    res.json({ files });
  });

  // POST /api/v1/tagworkshop/enrich/files
  // Queue specific files for MusicBrainz enrichment (resets error/no_data status)
  // and ensures the enrichment worker is running.
  // Body: { files: [{ filepath, vpath }] }
  velvet.post('/api/v1/tagworkshop/enrich/files', async (req, res) => {
    const files = req.body?.files;
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files array required' });
    }
    // Validate entries
    const valid = files.filter(f =>
      typeof f.filepath === 'string' && f.filepath.length > 0 &&
      typeof f.vpath    === 'string' && f.vpath.length    > 0
    ).slice(0, 500); // hard cap
    if (valid.length === 0) return res.status(400).json({ error: 'No valid file entries' });

    // Reset mb_enrichment_status for eligible files (acoustid=found only)
    const queued = db.resetFilesForEnrichment(valid);

    // Start the worker if not already running
    const workerStarted = !_enrich.running;
    if (workerStarted) await _enrich.start({ remember: false });

    res.json({ ok: true, queued, workerStarted });
  });

  // GET /api/v1/tagworkshop/enrich/errors
  velvet.get('/api/v1/tagworkshop/enrich/errors', (req, res) => {
    const rows = db.getMbEnrichErrors(200);
    res.json({ errors: rows, total: rows.length });
  });

  // POST /api/v1/tagworkshop/enrich/retry-errors
  velvet.post('/api/v1/tagworkshop/enrich/retry-errors', (req, res) => {
    const result = db.retryMbEnrichErrors();
    res.json({ ok: true, ...result });
  });

  // GET /api/v1/tagworkshop/albums
  velvet.get('/api/v1/tagworkshop/albums', (req, res) => {
    const filter = ['all', 'missing', 'year', 'artist', 'junk'].includes(req.query.filter) ? req.query.filter : 'all';
    const sort   = ['broken', 'tracks', 'alpha'].includes(req.query.sort)   ? req.query.sort   : 'broken';
    const page   = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const search = typeof req.query.q === 'string' ? req.query.q.slice(0, 120) : '';
    const result = db.getTagWorkshopAlbums(filter, sort, page, search);
    res.json(result);
  });

  // GET /api/v1/tagworkshop/album/:mb_release_id
  velvet.get('/api/v1/tagworkshop/album/:mb_release_id', (req, res) => {
    const id = req.params.mb_release_id;
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ error: 'Invalid release ID' });
    const album_dir = typeof req.query.album_dir === 'string' ? req.query.album_dir : null;
    const tracks = db.getTagWorkshopAlbumTracks(id, album_dir);
    res.json({ tracks });
  });

  velvet.post('/api/v1/tagworkshop/accept-track', async (req, res) => {
    const { filepath, vpath, overrides } = req.body || {};
    if (!filepath || !vpath) return res.status(400).json({ error: 'filepath and vpath are required' });

    const t = db.getTrackForAccept(filepath, vpath);
    if (!t) return res.json({ ok: true, skipped: true });

    const finalTags = _buildTrackTags(t, overrides);
    const outcome   = await _applyTagsToTrack(t, finalTags);
    if (outcome.skippedEqual) return res.json({ ok: true, skippedEqual: true });
    res.json({ ok: !outcome.error, error: outcome.error || null });
  });

  // POST /api/v1/tagworkshop/skip
  velvet.post('/api/v1/tagworkshop/skip', (req, res) => {
    const { mb_release_id, album_dir } = req.body || {};
    if (!mb_release_id) return res.status(400).json({ error: 'mb_release_id required' });
    db.skipAlbumTags(mb_release_id, typeof album_dir === 'string' ? album_dir : null);
    res.json({ ok: true });
  });

  // POST /api/v1/tagworkshop/unshelve
  velvet.post('/api/v1/tagworkshop/unshelve', (req, res) => {
    const { mb_release_id, album_dir } = req.body || {};
    if (!mb_release_id) return res.status(400).json({ error: 'mb_release_id required' });
    db.unshelveAlbum(mb_release_id, typeof album_dir === 'string' ? album_dir : null);
    res.json({ ok: true });
  });

  // GET /api/v1/tagworkshop/shelved
  velvet.get('/api/v1/tagworkshop/shelved', (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    res.json(db.getShelvedAlbums(page));
  });

  velvet.post('/api/v1/tagworkshop/bulk-accept-casing', async (req, res) => {
    const candidates = db.getCasingOnlyCandidates();
    if (candidates.length === 0) return res.json({ ok: true, accepted: 0, dbOnly: 0, errors: [] });

    const results = { accepted: 0, dbOnly: 0, errors: [] };

    for (const t of candidates) {
      const finalTags = _buildFinalTags(t);
      const outcome   = await _applyTagsToTrack(t, finalTags);
      if (outcome.error) { results.errors.push({ filepath: t.filepath, error: outcome.error }); results.dbOnly++; }
      else               results.accepted++;
    }

    res.json({ ok: true, ...results });
  });
}

function _buildFinalTags(t) {
  return {
    title:        t.mb_title        ?? t.title,
    artist:       t.mb_artist       ?? t.artist,
    album_artist: t.mb_album_artist ?? t.album_artist    ?? null,
    album:        t.mb_album        ?? t.album,
    year:         t.mb_year         ?? t.year,
    track:        t.mb_track        ?? t.track,
  };
}

function _buildTrackTags(t, overrides) {
  return {
    title:        overrides?.title  || (t.mb_title        ?? t.title),
    artist:       overrides?.artist || (t.mb_artist       ?? t.artist),
    album_artist: t.mb_album_artist ?? t.album_artist     ?? null,
    album:        overrides?.album  || (t.mb_album        ?? t.album),
    year:         overrides?.year === undefined ? (t.mb_year ?? t.year) : (Number.parseInt(overrides.year, 10) || null),
    track:        t.mb_track  ?? t.track,
  };
}

async function _applyTagsToTrack(t, finalTags) {
  if (!_tagsHaveDiff(t, finalTags)) {
    try { db.markTrackAccepted(t.filepath, t.vpath); } catch (dbErr) {
      winston.error(`[tagworkshop] DB update failed ${t.filepath}: ${dbErr.message}`);
    }
    return { skippedEqual: true, error: null };
  }
  const absPath = resolveAbsPath(t.vpath, t.filepath);
  const diskErr = absPath ? await writeTagsToFile(absPath, t.format, finalTags) : 'vpath not found in config';
  if (diskErr) winston.warn(`[tagworkshop] Tag write failed ${t.filepath}: ${diskErr}`);
  try {
    db.updateFileTags(t.filepath, t.vpath, finalTags);
    db.markTrackAccepted(t.filepath, t.vpath);
    if (!diskErr && absPath) {
      try { db.updateFileModified(t.filepath, t.vpath, (await fs.stat(absPath)).mtime.getTime()); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }
  } catch (dbErr) { winston.error(`[tagworkshop] DB update failed ${t.filepath}: ${dbErr.message}`); }
  return { skippedEqual: false, error: diskErr };
}
