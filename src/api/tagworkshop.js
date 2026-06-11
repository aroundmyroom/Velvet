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
 *   GET  /api/v1/tagworkshop/text-search/status         — stats: queued/found/not_found/skipped/errors
 *   POST /api/v1/tagworkshop/text-search/retry-notfound — reset not_found rows for retry
 *
 * Tag Workshop:
 *   GET  /api/v1/tagworkshop/status
 *   GET  /api/v1/tagworkshop/albums?page=N&filter=all|missing|year|artist&sort=broken|tracks|alpha
 *   GET  /api/v1/tagworkshop/album/:mb_release_id
 *   POST /api/v1/tagworkshop/accept        { mb_release_id, overrides? }
 *   POST /api/v1/tagworkshop/skip          { mb_release_id }
 *   POST /api/v1/tagworkshop/bulk-accept-casing
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { ffmpegBin } from '../util/ffmpeg-bootstrap.js';
import { getDirname } from '../util/esm-helpers.js';
import { isScanRunning, onScanEnd, onEveryScanEnd } from '../state/scan-lock.js';
import { resolvePathWithinRoot } from '../util/path-security.js';

const __dirname         = getDirname(import.meta.url);
const _workerPath       = path.join(__dirname, '../util/mb-enrich-worker.mjs');
const _tsWorkerPath     = path.join(__dirname, '../util/mb-text-search-worker.mjs');
const execFileAsync = promisify(execFile);

// ── MB Enrichment worker state ────────────────────────────────────────────────

let _worker   = null;
let _running  = false;
let _stopping = false;
let _lastStats = null;

// ── MB Text Search worker state ───────────────────────────────────────────────

let _tsWorker   = null;
let _tsRunning  = false;
let _tsStopping = false;
let _tsLastStats = null;
let _pendingStart = false;
let _pendingTsStart = false;

function _dbPath() {
  return path.join(config.program.storage.dbDirectory, 'velvet.sqlite');
}

function _spawnWorker() {
  if (_worker) return;

  _worker   = new Worker(_workerPath, { workerData: { dbPath: _dbPath() } });
  _running  = true;
  _stopping = false;

  _worker.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'status' || msg.type === 'ready') {
      if (msg.stats) _lastStats = msg.stats;
    }
    if (msg.type === 'stopped') {
      _running = false; _stopping = false; _worker = null;
      winston.info('[tagworkshop] MB enrichment worker stopped');
    }
    if (msg.type === 'error') {
      winston.error(`[tagworkshop] Worker error: ${msg.message}`);
      _running = false; _stopping = false; _worker = null;
    }
  });

  _worker.on('error', err => {
    winston.error(`[tagworkshop] Worker thread error: ${err.message}`);
    _running = false; _stopping = false; _worker = null;
  });

  _worker.on('exit', code => {
    if (code !== 0) winston.warn(`[tagworkshop] Worker exited with code ${code}`);
    _running = false; _stopping = false; _worker = null;
  });

  winston.info('[tagworkshop] MB enrichment worker started');
}

function _spawnTextSearchWorker() {
  if (_tsWorker) return;

  _tsWorker   = new Worker(_tsWorkerPath, { workerData: { dbPath: _dbPath() } });
  _tsRunning  = true;
  _tsStopping = false;

  _tsWorker.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'status' || msg.type === 'ready') {
      if (msg.stats) _tsLastStats = msg.stats;
    }
    if (msg.type === 'stopped') {
      _tsRunning = false; _tsStopping = false; _tsWorker = null;
      winston.info('[tagworkshop] MB text-search worker stopped');
    }
    if (msg.type === 'error') {
      winston.error(`[tagworkshop] Text-search worker error: ${msg.message}`);
      _tsRunning = false; _tsStopping = false; _tsWorker = null;
    }
  });

  _tsWorker.on('error', err => {
    winston.error(`[tagworkshop] Text-search worker thread error: ${err.message}`);
    _tsRunning = false; _tsStopping = false; _tsWorker = null;
  });

  _tsWorker.on('exit', code => {
    if (code !== 0) winston.warn(`[tagworkshop] Text-search worker exited with code ${code}`);
    _tsRunning = false; _tsStopping = false; _tsWorker = null;
  });

  winston.info('[tagworkshop] MB text-search worker started');
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

  const ext    = path.extname(absolutePath);
  const tmpPath = absolutePath + '.tagtmp_' + Date.now() + ext;

  // WAV and AIFF muxers cannot hold video/picture streams (cover art).
  // Using '-map 0' on a file with embedded art causes:
  //   "[wav @ ...] wav muxer does not support any stream of type video"
  // Use audio-only mapping for those formats.
  const AUDIO_ONLY_FORMATS = new Set(['wav', 'aif', 'aiff']);
  const mapArg = AUDIO_ONLY_FORMATS.has(fmt) ? '0:a' : '0';

  const args = [
    '-y',
    '-i', absolutePath,
    '-c', 'copy',
    '-map', mapArg,
    '-map_metadata', '0',
  ];

  if (tags.title        != null) args.push('-metadata', `title=${tags.title}`);
  if (tags.artist       != null) args.push('-metadata', `artist=${tags.artist}`);
  if (tags.album_artist != null) args.push('-metadata', `album_artist=${tags.album_artist}`);
  if (tags.album        != null) args.push('-metadata', `album=${tags.album}`);
  if (tags.year         != null) args.push('-metadata', `date=${tags.year}`);
  if (tags.track        != null) args.push('-metadata', `track=${tags.track}`);

  // MP3-specific: ensure ID3v2.3 compatibility
  if (fmt === 'mp3') {
    args.push('-id3v2_version', '3');
  }

  args.push(tmpPath);

  try {
    await execFileAsync(ffmpegBin(), args, { timeout: 60_000 });
    await fs.rename(tmpPath, absolutePath);
    return null;
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
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

function _tryTwAutoStart() {
  try {
    if (isScanRunning()) {
      onScanEnd(_tryTwAutoStart);
      return;
    }
    const status = db.getTagWorkshopStatus();
    const mbQ = status?.mb?.queued ?? 0;
    const tsQ = status?.textSearch?.queued ?? 0;
    if (mbQ > 0 && !_running) {
      if (mbQ >= 500) {
        winston.info(`[tagworkshop] Auto-start skipped: ${mbQ} MB enrichment files queued — backlog too large, start from Admin`);
      } else {
        winston.info(`[tagworkshop] Auto-starting MB enrichment worker (${mbQ} files queued)`);
        _spawnWorker();
      }
    }
    if (tsQ > 0 && !_tsRunning) {
      if (tsQ >= 500) {
        winston.info(`[tagworkshop] Auto-start skipped: ${tsQ} text-search files queued — backlog too large, start from Admin`);
      } else {
        winston.info(`[tagworkshop] Auto-starting MB text-search worker (${tsQ} files queued)`);
        _spawnTextSearchWorker();
      }
    }
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

export function setup(velvet) {

  // Boot-time + post-scan auto-start: re-check after every scan for newly
  // matched files (AcoustID may have run and set mbid on newly added songs).
  // 15 s delay at boot so the DB finishes initialising before querying.
  setTimeout(_tryTwAutoStart, 15_000);
  // Re-check after every scan so newly added files are processed immediately.
  onEveryScanEnd(_tryTwAutoStart);

  // Guard — all endpoints are admin-only
  velvet.all('/api/v1/tagworkshop/{*path}', (req, res, next) => {
    if (req.user?.admin !== true) return res.status(403).json({ error: 'Admin only' });
    next();
  });

  // ── MB Enrichment worker control ──────────────────────────────────────────

  // POST /api/v1/tagworkshop/enrich/start
  velvet.post('/api/v1/tagworkshop/enrich/start', (req, res) => {
    if (_running) return res.json({ ok: true, message: 'Already running' });
    if (isScanRunning()) {
      _pendingStart = true;
      onScanEnd(() => {
        if (!_pendingStart || _running) return;
        _pendingStart = false;
        _spawnWorker();
        winston.info('[tagworkshop] Deferred MB enrichment start executed after scan completion');
      });
      return res.json({ ok: true, pending: true, message: 'Start queued: file scan in progress' });
    }
    _spawnWorker();
    res.json({ ok: true });
  });

  // POST /api/v1/tagworkshop/enrich/stop
  velvet.post('/api/v1/tagworkshop/enrich/stop', (req, res) => {
    if (_pendingStart && !_running) {
      _pendingStart = false;
      return res.json({ ok: true, message: 'Pending start cancelled' });
    }
    if (!_running || !_worker) return res.json({ ok: true, message: 'Not running' });
    if (_stopping) return res.json({ ok: true, message: 'Already stopping' });
    _stopping = true;
    _worker.postMessage('stop');
    res.json({ ok: true });
  });

  // ── MB Text Search worker control ─────────────────────────────────────────────────

  // POST /api/v1/tagworkshop/text-search/start
  velvet.post('/api/v1/tagworkshop/text-search/start', (req, res) => {
    if (_tsRunning) return res.json({ ok: true, message: 'Already running' });
    if (isScanRunning()) {
      _pendingTsStart = true;
      onScanEnd(() => {
        if (!_pendingTsStart || _tsRunning) return;
        _pendingTsStart = false;
        _spawnTextSearchWorker();
        winston.info('[tagworkshop] Deferred MB text-search start executed after scan completion');
      });
      return res.json({ ok: true, pending: true, message: 'Start queued: file scan in progress' });
    }
    _spawnTextSearchWorker();
    res.json({ ok: true });
  });

  // POST /api/v1/tagworkshop/text-search/stop
  velvet.post('/api/v1/tagworkshop/text-search/stop', (req, res) => {
    if (_pendingTsStart && !_tsRunning) {
      _pendingTsStart = false;
      return res.json({ ok: true, message: 'Pending start cancelled' });
    }
    if (!_tsRunning || !_tsWorker) return res.json({ ok: true, message: 'Not running' });
    if (_tsStopping) return res.json({ ok: true, message: 'Already stopping' });
    _tsStopping = true;
    _tsWorker.postMessage('stop');
    res.json({ ok: true });
  });

  // GET /api/v1/tagworkshop/text-search/status
  velvet.get('/api/v1/tagworkshop/text-search/status', (req, res) => {
    const stats = db.getMbTextSearchStats();
    res.json({ ...stats, running: _tsRunning, stopping: _tsStopping });
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
      enrich:     { running: _running,   stopping: _stopping   },
      textSearch: { ...status.textSearch, running: _tsRunning, stopping: _tsStopping },
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

    // Detect child vpath: a vpath whose root is a strict sub-path of another vpath's root.
    // Child vpath files are stored in the DB under the PARENT root vpath.
    const myRoot = folders[vpathName].root;
    const sep    = path.sep;
    const parentEntry = Object.entries(folders).find(([name, cfg]) =>
      name !== vpathName && cfg.root && myRoot.startsWith(cfg.root + sep)
    );

    let dbVpath, filepathPrefix;
    if (parentEntry) {
      // Child vpath — resolve query against the parent ROOT vpath
      const [parentName, parentCfg] = parentEntry;
      dbVpath = parentName;
      // childRelPrefix = relative path from parent root to child root (e.g. "Albums")
      const childRelPrefix = myRoot.slice(parentCfg.root.length + sep.length).replaceAll('\\', '/');
      filepathPrefix = userRelPath ? childRelPrefix + '/' + userRelPath : childRelPrefix;
    } else {
      // Root vpath — query directly
      dbVpath = vpathName;
      filepathPrefix = userRelPath;
    }

    const files = db.getTagWorkshopFolderFiles(dbVpath, filepathPrefix);
    res.json({ files });
  });

  // POST /api/v1/tagworkshop/enrich/files
  // Queue specific files for MusicBrainz enrichment (resets error/no_data status)
  // and ensures the enrichment worker is running.
  // Body: { files: [{ filepath, vpath }] }
  velvet.post('/api/v1/tagworkshop/enrich/files', (req, res) => {
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
    const workerStarted = !_running;
    if (!_running) _spawnWorker();

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

  // POST /api/v1/tagworkshop/accept
  velvet.post('/api/v1/tagworkshop/accept', async (req, res) => {
    const { mb_release_id, album_dir, overrides } = req.body || {};
    if (!mb_release_id) return res.status(400).json({ error: 'mb_release_id required' });
    const albumDirFilter = typeof album_dir === 'string' ? album_dir : null;

    const tracks = db.getTracksForAccept(mb_release_id, albumDirFilter);
    if (tracks.length === 0) return res.json({ ok: true, accepted: 0, errors: [] });

    const results = { accepted: 0, skippedEqual: 0, dbOnly: 0, errors: [] };

    for (const t of tracks) {
      const finalTags = _buildFinalTags(t, overrides);
      const outcome   = await _applyTagsToTrack(t, finalTags);
      if (outcome.skippedEqual)  results.skippedEqual++;
      else if (outcome.error)    { results.errors.push({ filepath: t.filepath, error: outcome.error }); results.dbOnly++; }
      else                       results.accepted++;
    }

    res.json({ ok: true, ...results });
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
      const finalTags = _buildFinalTags(t, {});
      const outcome   = await _applyTagsToTrack(t, finalTags);
      if (outcome.error) { results.errors.push({ filepath: t.filepath, error: outcome.error }); results.dbOnly++; }
      else               results.accepted++;
    }

    res.json({ ok: true, ...results });
  });
}

function _buildFinalTags(t, overrides) {
  return {
    title:        t.mb_title        ?? t.title,
    artist:       overrides?.artist ?? t.mb_artist       ?? t.artist,
    album_artist: t.mb_album_artist ?? t.album_artist    ?? null,
    album:        overrides?.album  ?? t.mb_album        ?? t.album,
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
    year:         overrides?.year === undefined ? (t.mb_year ?? t.year) : overrides.year,
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
