/**
 * album-art-workshop.js
 *
 * Album-Art Workshop — finds albums (folders) that have NO cover art, fetches
 * cover suggestions from the enabled art services (Discogs / Deezer / iTunes)
 * and lets an admin review and approve them. Approving writes cover.jpg into the
 * album folder, caches the image + thumbnails, and points every track in that
 * folder at it. Nothing is written without approval unless `albumArt.autoApprove`
 * is set.
 *
 * The suggestion pass runs through the bg-broker in chunks of a few albums, so it
 * never runs while a library scan is in progress and never blocks other
 * background tasks for the length of a whole pass. With `albumArt.autoSuggestNewContent`
 * enabled it re-runs automatically after every scan to pick up newly added,
 * art-less folders.
 *
 * Source priority: MusicBrainz / Cover Art Archive first (when a release id is
 * known and CAA holds the cover), else Discogs → Deezer → iTunes. Applies are
 * snapshotted so any cover can be restored, and any album (even one that already
 * has art) can be fixed via the find / fix-suggest endpoints.
 *
 *   GET  /api/v1/admin/art/status
 *   GET  /api/v1/admin/art/candidates?offset=&limit=&status=&source=&q=
 *   POST /api/v1/admin/art/scan        — { source? } start a pass (source:'musicbrainz' = CAA-only)
 *   POST /api/v1/admin/art/stop        — request the running pass to stop
 *   POST /api/v1/admin/art/suggest     — { albumKey } refetch one album
 *   POST /api/v1/admin/art/apply       — { albumKey, releaseId|coverUrl } (snapshots prior art)
 *   POST /api/v1/admin/art/apply-batch — { albumKeys[] } apply top suggestion for many
 *   POST /api/v1/admin/art/restore     — { albumKey } undo an applied cover
 *   GET  /api/v1/admin/art/find?q=     — search ANY album (incl. ones with art) to fix
 *   POST /api/v1/admin/art/fix-suggest — { albumKey } all-source suggestions for one album
 *   POST /api/v1/admin/art/skip        — { albumKey }
 *   POST /api/v1/admin/art/config      — { autoApprove?, autoSuggestNewContent?, coverArtArchive? }
 *   GET  /api/v1/admin/art/shelves     — list shelved folder prefixes
 *   POST /api/v1/admin/art/shelve      — { vpath, prefix } hide a whole folder
 *   POST /api/v1/admin/art/unshelve    — { vpath, prefix } un-hide a folder
 */

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as broker from '../state/bg-task-broker.js';
import { onEveryScanEnd, isScanRunning } from '../state/scan-lock.js';
import { resolvePathWithinRoot } from '../util/path-security.js';
import { rootFolders } from '../util/vpath.js';
import { artFileName, writeArtWithThumbs } from '../util/art-cache.js';
import { fetchPublicUrlBuffer, isPrivateHost } from '../util/ssrf-check.js';
import { suggestCovers, getReleaseCoverBuf } from './discogs.js';
import { joiValidate } from '../util/validation.js';

const PER_RUN_CAP      = 200;        // albums per suggestion pass
const PACE_MS          = 1500;       // delay between albums (Discogs rate limit)
const CHUNK_SIZE       = 10;         // albums per broker task, so other tasks get a turn
const SUGGESTED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // re-query a suggested/notfound album after 30d
const ERROR_TTL_MS     = 24 * 60 * 60 * 1000;       // retry an errored album after 24h

const _state = {
  running:      false,
  stopping:     false,
  startedAt:    null,
  currentAlbum: null,
  processed:    0,
  lastRunAt:    null,
  lastError:    null,
};

// A folder is shelved if any shelf prefix equals the album dir or is a parent of it.
function _isShelved(shelves, vpath, dir) {
  return shelves.some(s => s.vpath === vpath && (dir === s.prefix || dir.startsWith(s.prefix + '/')));
}

// Set of "container" folders — any folder that has a sub-folder containing audio
// (e.g. the letter bucket "12 inches A-Z/M"). These are not real album folders:
// a cover.jpg there is meaningless, so they must never become candidates. Built
// as the set of every proper ancestor of every audio file's directory.
function _containerDirs() {
  const set = new Set();
  for (const r of db.artWorkshopAudioFilepaths()) {
    const dir = _dirOf(r.filepath);
    let idx = dir.indexOf('/');
    while (idx !== -1) {
      set.add(r.vpath + '\u0000' + dir.slice(0, idx));
      idx = dir.indexOf('/', idx + 1);
    }
  }
  return set;
}

function _dirOf(filepath) {
  const i = filepath.lastIndexOf('/');
  return i > 0 ? filepath.slice(0, i) : '';
}

// Bidi/zero-width marks that sneak into ripped folder names (e.g. "JX ‎- ...").
const _BIDI_MARKS = /[​-‏‪-‮⁦-⁩]/g;

function _clean(s) {
  return String(s || '').replace(_BIDI_MARKS, '').replace(/\s+/g, ' ').trim();
}

// Drop release noise that wrecks a cover search: (1994), [Web], (CDM), format tags.
function _stripReleaseNoise(s) {
  return _clean(s)
    .replace(/[[(][^\])]*[\])]/g, ' ')
    .replace(/\b(?:CDM|CDS|CDR|CDEP|WEB|Vinyl|FLAC|MP3|320|192|EP|Single|Maxi|Promo|Remaster(?:ed)?|Reissue)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Prefer the folder's "Artist - Title" structure over the noisy embedded album
// tag. For "JX - Son Of A Gun (1994)(CDM)" → { artist:'JX', title:'Son Of A Gun' }.
function _deriveQuery(row) {
  const leaf = _clean((row.dir || '').split('/').pop());
  let artist = _clean(row.artist);
  let title;
  const m = leaf.match(/^(.*?)\s[-–—]\s(.+)$/);
  if (m) {
    if (!artist) artist = m[1].trim();
    title = m[2].trim();
  } else {
    title = leaf;
  }
  title = _stripReleaseNoise(title) || _stripReleaseNoise(row.album) || leaf;
  return { artist, title };
}

function _albumKey(vpath, albumId) { return `${vpath}|${albumId}`; }

// Sync the workshop table with the current art-less album set: insert new
// candidates as 'pending', and drop rows whose album now has art (resolved
// elsewhere) unless they were explicitly applied/skipped.
function _reconcileCandidates() {
  const shelves    = db.artWorkshopShelves();
  const containers = _containerDirs();
  const knownVpaths = new Set(Object.keys(rootFolders()));
  const candidates = [];
  for (const r of db.artWorkshopArtlessAlbums()) {
    if (!knownVpaths.has(r.vpath)) continue;
    const dir = _dirOf(r.sample_filepath);
    if (_isShelved(shelves, r.vpath, dir)) continue;
    if (containers.has(r.vpath + '\u0000' + dir)) continue;
    candidates.push({ albumKey: _albumKey(r.vpath, r.album_id), vpath: r.vpath, albumId: r.album_id, dir, album: r.album, artist: r.artist });
  }
  db.artWorkshopReconcile(candidates);
  return candidates.length;
}

function _needsSuggest(row, now) {
  if (row.status === 'pending' || row.status === null) return true;
  if (row.status === 'error')    return now - (row.last_attempt_ts || 0) > ERROR_TTL_MS;
  if (row.status === 'suggested' || row.status === 'notfound') {
    return now - (row.last_attempt_ts || 0) > SUGGESTED_TTL_MS;
  }
  return false; // applied / skipped — never re-query
}

function _suggestPass(opts = {}) {
  const caaOnly = !!opts.caaOnly;
  const nowMs = Date.now();
  let rows = null;
  return async () => {
    const more = await _runSuggestChunk(nowMs, caaOnly, rows ?? (rows = _beginSuggestPass(nowMs, caaOnly)));
    if (!more) _endSuggestPass();
    return more;
  };
}

function _beginSuggestPass(nowMs, caaOnly) {
  _state.running   = true;
  _state.startedAt = nowMs;
  _state.processed = 0;
  _state.lastError = null;
  try {
    _reconcileCandidates();
    let rows = db.artWorkshopAllRows().filter(r => _needsSuggest(r, nowMs));
    // MusicBrainz-only pass: only albums that carry a release id can resolve a CAA cover.
    if (caaOnly) rows = rows.filter(r => !!db.artWorkshopReleaseId(r.vpath, r.album_id));
    return rows.slice(0, PER_RUN_CAP);
  } catch (e) {
    _state.lastError = e.message;
    winston.error(`[album-art] suggestion pass error: ${e.message}`);
    return [];
  }
}

function _endSuggestPass() {
  if (!_state.lastError) _state.lastRunAt = Date.now();
  _state.running      = false;
  _state.stopping     = false;
  _state.currentAlbum = null;
}

// Takes up to CHUNK_SIZE rows off `rows`; true while more remain.
async function _runSuggestChunk(nowMs, caaOnly, rows) {
  try {
    for (const row of rows.splice(0, CHUNK_SIZE)) {
      if (_state.stopping) return false;
      _state.currentAlbum = `${row.artist || '?'} — ${row.album || row.dir}`;
      let suggestions = [];
      let status = 'notfound';
      try {
        const q = _deriveQuery(row);
        suggestions = await suggestCovers({
          artist:   q.artist,
          album:    q.title,
          title:    q.title,
          filepath: `${row.vpath}/${row.dir}/x`,
          mbReleaseId: db.artWorkshopReleaseId(row.vpath, row.album_id),
          onlyCaa:  caaOnly,
        });
        status = suggestions.length ? 'suggested' : 'notfound';
      } catch (e) {
        status = 'error';
        winston.warn(`[album-art] suggest failed for ${row.album_key}: ${e.message}`);
      }
      db.artWorkshopSaveSuggestions(row.album_key, suggestions, status, nowMs);

      if (status === 'suggested' && config.program.albumArt?.autoApprove) {
        try { await _applyCover(row.album_key, suggestions[0]); } catch (e) {
          winston.warn(`[album-art] auto-approve failed for ${row.album_key}: ${e.message}`);
        }
      }
      _state.processed += 1;
      await new Promise(r => setTimeout(r, PACE_MS));
    }
    return rows.length > 0 && !_state.stopping;
  } catch (e) {
    _state.lastError = e.message;
    winston.error(`[album-art] suggestion pass error: ${e.message}`);
    return false;
  }
}

function _sniffImageExt(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

async function _downloadCover(choice) {
  if (choice.releaseId) return getReleaseCoverBuf(choice.releaseId);
  if (!choice.coverUrl) throw new Error('No releaseId or coverUrl in suggestion');
  let parsed;
  try { parsed = new URL(choice.coverUrl); } catch { throw new Error('Invalid coverUrl'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('coverUrl must be http(s)');
  if (isPrivateHost(parsed.hostname)) throw new Error('coverUrl resolves to a private address');
  const opts = {
    headers: { 'User-Agent': 'Velvet/dev +https://github.com/aroundmyroom/Velvet' },
    maxContentLength: 20 * 1024 * 1024,
  };
  // Cover Art Archive serves each size as a separate derivative on the archive.org
  // CDN; a single size sometimes 500s while the others work. Try a few before
  // failing so a flaky derivative doesn't block the apply.
  const caa = parsed.hostname === 'coverartarchive.org'
    && choice.coverUrl.match(/^(https:\/\/coverartarchive\.org\/(?:release|release-group)\/[0-9a-f-]+\/front)(?:-\d+)?$/i);
  if (caa) {
    let lastErr;
    for (const u of [...new Set([choice.coverUrl, caa[1] + '-500', caa[1] + '-1200', caa[1], caa[1] + '-250'])]) {
      try { const b = await fetchPublicUrlBuffer(u, opts); if (b && b.length > 100) return b; }
      catch (e) { lastErr = e; }
    }
    throw new Error('Cover Art Archive image is temporarily unavailable (upstream archive.org error). Try again, or pick another source.');
  }
  return fetchPublicUrlBuffer(choice.coverUrl, opts);
}

async function _checkWritable(dir) {
  const probe = path.join(dir, `.velvet-art-probe-${crypto.randomBytes(4).toString('hex')}`);
  try {
    await fsp.writeFile(probe, '', { flag: 'wx' });
    await fsp.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

// Download → write cover.jpg into the album folder → cache + thumbnails → point
// every track in that folder at the cached image.
async function _applyCover(albumKey, choice) {
  const row = db.artWorkshopRow(albumKey);
  if (!row) throw new Error('Unknown albumKey');
  const root = rootFolders()[row.vpath];
  if (!root) throw new Error(`vpath ${row.vpath} is not a root folder`);

  const folderAbs = resolvePathWithinRoot(root, row.dir);
  if (!fs.existsSync(folderAbs)) throw new Error('Album folder not found on disk');
  if (!await _checkWritable(folderAbs)) {
    throw new Error(
      `Cannot write cover to ${folderAbs} — folder is not writable by the current process user. ` +
      `Grant write access to uid=${process.getuid()} on the host, or set PUID/PGID in your Compose file.`
    );
  }

  const srcBuf = await _downloadCover(choice);
  if (!_sniffImageExt(srcBuf)) throw new Error('Downloaded data is not a recognised image');

  // Snapshot the album's current art BEFORE overwriting, so a wrong apply can be
  // restored exactly. The old cached aaFile is intentionally NOT deleted here.
  const prevRow = db.artWorkshopAlbumArt(row.vpath, row.album_id) || {};
  const hadArt = prevRow.aaFile ? 1 : 0;
  let prevCoverBackup = row.prev_cover_backup || null;
  const coverPathPre = resolvePathWithinRoot(folderAbs, 'cover.jpg');
  if (fs.existsSync(coverPathPre) && !prevCoverBackup) {
    try {
      const bakName = 'cover.velvet-prev.jpg';
      fs.copyFileSync(coverPathPre, resolvePathWithinRoot(folderAbs, bakName));
      prevCoverBackup = bakName;
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  }

  const { default: sharp } = await import('sharp');
  const jpeg = await sharp(srcBuf)
    .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();

  const coverPath = resolvePathWithinRoot(folderAbs, 'cover.jpg');
  fs.writeFileSync(coverPath, jpeg);

  const artDir  = config.program.storage.albumArtDirectory;
  const aaFile  = artFileName(jpeg, 'jpg');
  if (!await writeArtWithThumbs(artDir, jpeg, aaFile)) console.debug('[velvet] art workshop: could not make thumbnails for', aaFile);

  db.artWorkshopSetAlbumArt(row.vpath, row.album_id, aaFile, 'workshop', 'cover.jpg');

  // First apply for this album snapshots the ORIGINAL art; applied_aaFile/status always reflect the latest apply.
  const firstApply = !row.applied_aaFile;
  db.artWorkshopMarkApplied(albumKey, {
    source: choice.source || 'manual',
    ts: Date.now(),
    aaFile,
    prev: {
      aaFile:    firstApply ? (prevRow.aaFile || null) : null,
      artSource: firstApply ? (prevRow.art_source || null) : null,
      coverFile: firstApply ? (prevRow.cover_file || null) : null,
    },
    prevCoverBackup,
    hadArt,
  });

  return { aaFile, cover: 'cover.jpg' };
}

// Reverse the most recent apply: restore the album's tracks to their snapshotted
// art and put the folder cover.jpg back (from the backup, or remove it if the
// album had no art before). Returns the album to 'suggested' so it can be re-fixed.
async function _restoreCover(albumKey) {
  const row = db.artWorkshopRow(albumKey);
  if (!row) throw new Error('Unknown albumKey');
  if (!row.applied_aaFile) throw new Error('Nothing to restore');
  const root = rootFolders()[row.vpath];
  const folderAbs = root ? resolvePathWithinRoot(root, row.dir) : null;

  // Restore the folder cover.jpg.
  if (folderAbs && fs.existsSync(folderAbs)) {
    const coverPath = resolvePathWithinRoot(folderAbs, 'cover.jpg');
    if (row.prev_cover_backup) {
      const bak = resolvePathWithinRoot(folderAbs, row.prev_cover_backup);
      try { if (fs.existsSync(bak)) { fs.copyFileSync(bak, coverPath); fs.unlinkSync(bak); } } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    } else if (!row.had_art) {
      try { if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }
  }

  // Restore the DB art pointers on every track of the album.
  db.artWorkshopSetAlbumArt(row.vpath, row.album_id, row.prev_aaFile || null, row.prev_art_source || null, row.prev_cover_file || null);

  // Re-open the album for fixing; clear the apply snapshot.
  const back = (row.suggestions && JSON.parse(row.suggestions).length) ? 'suggested' : 'pending';
  db.artWorkshopClearApplied(albumKey, back, Date.now());

  return { ok: true, status: back, restoredAaFile: row.prev_aaFile || null };
}

function _statusCounts() {
  const c = { pending: 0, suggested: 0, applied: 0, skipped: 0, notfound: 0, error: 0 };
  for (const r of db.artWorkshopStatusCounts()) if (r.status in c) c[r.status] = r.n;
  return c;
}

// Counts of currently-suggested albums grouped by primary source — drives the
// source filter chips (All / MusicBrainz / Discogs / Deezer / iTunes).
function _sourceCounts() {
  const c = { all: 0, musicbrainz: 0, discogs: 0, deezer: 0, itunes: 0 };
  for (const r of db.artWorkshopSourceCounts()) { c.all += r.n; if (r.s in c) c[r.s] += r.n; }
  return c;
}

async function _persistAlbumArtConfig(patch) {
  config.program.albumArt = { ...(config.program.albumArt || {}), ...patch };
  await config.updateConfigFile(c => { c.albumArt = { ...c.albumArt, ...patch }; });
}

function _startPass(opts = {}) {
  if (_state.running) return 'already_running';
  _state.stopping = false;
  const label = opts.caaOnly ? 'Album-Art MusicBrainz pass' : 'Album-Art suggestion pass';
  broker.submitChunks('album-art-suggest', label, _suggestPass(opts));
  return 'queued';
}

export function setup(app) {
  try { db.artWorkshopEnsureTables(); } catch (e) { winston.warn('[album-art] table init failed: ' + e.message); }

  // After every scan, refresh candidates and (if enabled) auto-fetch suggestions
  // for newly added art-less folders.
  onEveryScanEnd(() => {
    try { _reconcileCandidates(); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    if (config.program.albumArt?.autoSuggestNewContent && !_state.running) _startPass();
  });

  // Sync candidates once after boot so resolved/shelved/container folders are
  // pruned without waiting for the next library scan.
  setImmediate(() => {
    try { if (!isScanRunning()) _reconcileCandidates(); }
    catch (e) { winston.warn('[album-art] boot reconcile failed: ' + e.message); }
  });

  const adminOnly = (req, res) => {
    if (!req.user?.admin) { res.status(403).json({ error: 'Admin required' }); return false; }
    return true;
  };

  app.get('/api/v1/admin/art/status', (req, res) => {
    if (!adminOnly(req, res)) return;
    res.json({
      running:        _state.running,
      stopping:       _state.stopping,
      startedAt:      _state.startedAt,
      currentAlbum:   _state.currentAlbum,
      processed:      _state.processed,
      lastRunAt:      _state.lastRunAt,
      lastError:      _state.lastError,
      scanRunning:    isScanRunning(),
      counts:         _statusCounts(),
      sourceCounts:   _sourceCounts(),
      config: {
        autoApprove:           config.program.albumArt?.autoApprove === true,
        autoSuggestNewContent: config.program.albumArt?.autoSuggestNewContent === true,
        coverArtArchive:       config.program.albumArt?.coverArtArchive !== false,
      },
    });
  });

  app.get('/api/v1/admin/art/candidates', (req, res) => {
    if (!adminOnly(req, res)) return;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const status = String(req.query.status || '').trim();
    const q      = String(req.query.q || '').trim();
    const source = String(req.query.source || '').trim();
    const filter = { status, source, q };

    // Lightweight mode: return every matching folder (no pagination, no suggestions)
    // so the UI can "select all found" across pages for bulk shelve.
    if (req.query.keys === '1') {
      const keyRows = db.artWorkshopCandidateKeys(filter);
      return res.json({ keys: keyRows.map(r => ({ albumKey: r.album_key, vpath: r.vpath, dir: r.dir })) });
    }

    // For the Applied view, surface the live cover (aaFile) so the user can SEE
    // what was stored, plus whether a restore is possible.
    const { total, rows } = db.artWorkshopCandidates(filter, limit, offset);
    res.json({
      total,
      candidates: rows.map(r => ({
        albumKey:    r.album_key,
        vpath:       r.vpath,
        dir:         r.dir,
        album:       r.album,
        artist:      r.artist,
        status:      r.status,
        appliedCover: r.applied_cover,
        topSource:   r.top_source,
        appliedAaFile: r.status === 'applied' ? (r.liveAaFile || r.applied_aaFile || null) : null,
        canRestore:  r.status === 'applied' && !!r.applied_aaFile,
        lastAttempt: r.last_attempt_ts,
        suggestions: r.suggestions ? JSON.parse(r.suggestions) : [],
      })),
    });
  });

  app.post('/api/v1/admin/art/scan', (req, res) => {
    if (!adminOnly(req, res)) return;
    const caaOnly = String(req.body?.source || '').toLowerCase() === 'musicbrainz';
    res.json({ status: _startPass({ caaOnly }) });
  });

  app.post('/api/v1/admin/art/stop', (req, res) => {
    if (!adminOnly(req, res)) return;
    if (!_state.running) return res.json({ status: 'not_running' });
    _state.stopping = true;
    res.json({ status: 'stopping' });
  });

  app.post('/api/v1/admin/art/suggest', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const { error, value } = Joi.object({
      albumKey:   Joi.string().required(),
      allSources: Joi.boolean(),
    }).validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    const row = db.artWorkshopRow(value.albumKey);
    if (!row) return res.status(404).json({ error: 'Unknown albumKey' });
    try {
      const q = _deriveQuery(row);
      const suggestions = await suggestCovers({
        artist: q.artist, album: q.title, title: q.title,
        filepath: `${row.vpath}/${row.dir}/x`,
        mbReleaseId: db.artWorkshopReleaseId(row.vpath, row.album_id),
        allSources: value.allSources,
      });
      const status = suggestions.length ? 'suggested' : 'notfound';
      db.artWorkshopSaveSuggestions(value.albumKey, suggestions, status, Date.now());
      res.json({ status, suggestions });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post('/api/v1/admin/art/apply', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const schema = Joi.object({
      albumKey:  Joi.string().required(),
      releaseId: Joi.number().integer(),
      coverUrl:  Joi.string().uri({ scheme: ['http', 'https'] }),
      source:    Joi.string().allow('').optional(),
    }).or('releaseId', 'coverUrl');
    try { joiValidate(schema, req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const result = await _applyCover(req.body.albumKey, {
        releaseId: req.body.releaseId,
        coverUrl:  req.body.coverUrl,
        source:    req.body.source || (req.body.releaseId ? 'discogs' : 'manual'),
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Batch-apply the top (preferred) suggestion for each selected album — applies
  // the Cover Art Archive cover where present, else the best fallback suggestion.
  app.post('/api/v1/admin/art/apply-batch', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const schema = Joi.object({ albumKeys: Joi.array().items(Joi.string()).min(1).max(500).required() });
    try { joiValidate(schema, req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    const applied = [];
    const failed = [];
    for (const albumKey of req.body.albumKeys) {
      const row = db.artWorkshopRow(albumKey);
      const top = row?.suggestions ? (JSON.parse(row.suggestions)[0] || null) : null;
      if (!top) { failed.push({ albumKey, error: 'no suggestion' }); continue; }
      try {
        await _applyCover(albumKey, { releaseId: top.releaseId, coverUrl: top.coverUrl, source: top.source || 'manual' });
        applied.push(albumKey);
      } catch (e) {
        failed.push({ albumKey, error: e.message });
      }
    }
    res.json({ ok: true, applied, failed, appliedCount: applied.length, failedCount: failed.length });
  });

  // Undo an applied cover — restore the album's previous art exactly.
  app.post('/api/v1/admin/art/restore', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const { error, value } = Joi.object({ albumKey: Joi.string().required() }).validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    try {
      res.json(await _restoreCover(value.albumKey));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Search ANY album (even ones that already have art) so a wrong cover can be
  // fixed. Returns each album's current cover so the user can see what's there.
  app.get('/api/v1/admin/art/find', (req, res) => {
    if (!adminOnly(req, res)) return;
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ albums: [] });
    const rows = db.artWorkshopFindAlbums(q);
    res.json({
      albums: rows.map(r => ({
        albumKey: _albumKey(r.vpath, r.album_id),
        vpath:    r.vpath,
        dir:      _dirOf(r.sample_filepath),
        album:    r.album,
        artist:   r.artist,
        aaFile:   r.aaFile || null,
        hasArt:   !!r.aaFile,
        trackCount: r.track_count,
      })),
    });
  });

  // Fetch all-source suggestions for one album (used by the Fix-a-cover panel).
  // Upserts a workshop row so the standard apply/restore path can be reused.
  app.post('/api/v1/admin/art/fix-suggest', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const { error, value } = Joi.object({ albumKey: Joi.string().required() }).validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    const i = value.albumKey.lastIndexOf('|');
    if (i < 1) return res.status(400).json({ error: 'bad albumKey' });
    const vpath = value.albumKey.slice(0, i);
    const albumId = value.albumKey.slice(i + 1);
    const info = db.artWorkshopAlbumInfo(vpath, albumId);
    if (!info?.sample) return res.status(404).json({ error: 'Album not found' });
    const dir = _dirOf(info.sample);
    db.artWorkshopUpsertCandidate({ albumKey: value.albumKey, vpath, albumId, dir, album: info.album, artist: info.artist });
    try {
      const q = _deriveQuery({ dir, artist: info.artist, album: info.album });
      const suggestions = await suggestCovers({
        artist: q.artist, album: q.title, title: q.title,
        filepath: `${vpath}/${dir}/x`,
        mbReleaseId: db.artWorkshopReleaseId(vpath, albumId),
        allSources: true,
      });
      const status = suggestions.length ? 'suggested' : 'notfound';
      db.artWorkshopSaveSuggestions(value.albumKey, suggestions, status, Date.now());
      res.json({ status, suggestions, current: { aaFile: info.aaFile || null, hasArt: !!info.aaFile } });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post('/api/v1/admin/art/skip', (req, res) => {
    if (!adminOnly(req, res)) return;
    const { error, value } = Joi.object({ albumKey: Joi.string().required() }).validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    const changed = db.artWorkshopSkip(value.albumKey, Date.now());
    if (!changed) return res.status(404).json({ error: 'Unknown albumKey' });
    res.json({ ok: true });
  });

  app.post('/api/v1/admin/art/config', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const { error, value } = Joi.object({
      autoApprove:           Joi.boolean(),
      autoSuggestNewContent: Joi.boolean(),
      coverArtArchive:       Joi.boolean(),
    }).min(1).validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    try {
      await _persistAlbumArtConfig(value);
      res.json({ ok: true, config: config.program.albumArt });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/v1/admin/art/shelves', (req, res) => {
    if (!adminOnly(req, res)) return;
    const shelves = db.artWorkshopShelves();
    const artless = db.artWorkshopArtlessAlbums();
    res.json({
      shelves: shelves.map(s => ({
        vpath:  s.vpath,
        prefix: s.prefix,
        ts:     s.ts,
        albums: artless.filter(r => _isShelved([s], r.vpath, _dirOf(r.sample_filepath))).length,
      })),
    });
  });

  const _shelfSchema = Joi.object({
    vpath:   Joi.string(),
    prefix:  Joi.string().allow(''),
    folders: Joi.array().items(Joi.object({
      vpath:  Joi.string().required(),
      prefix: Joi.string().allow('').required(),
    })).min(1),
  }).or('folders', 'vpath').with('vpath', 'prefix');

  const _shelfList = (value) =>
    (value.folders || [{ vpath: value.vpath, prefix: value.prefix }])
      .map(f => ({ vpath: f.vpath, prefix: String(f.prefix).replace(/\/+$/, '') }));

  app.post('/api/v1/admin/art/shelve', (req, res) => {
    if (!adminOnly(req, res)) return;
    const { error, value } = _shelfSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    const list = _shelfList(value);
    const removed = db.artWorkshopShelve(list, Date.now());
    res.json({ ok: true, removed, count: list.length });
  });

  app.post('/api/v1/admin/art/unshelve', (req, res) => {
    if (!adminOnly(req, res)) return;
    const { error, value } = _shelfSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    const changed = db.artWorkshopUnshelve(_shelfList(value));
    if (!changed) return res.status(404).json({ error: 'Shelf entry not found' });
    try { _reconcileCandidates(); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    res.json({ ok: true, count: changed });
  });
}
