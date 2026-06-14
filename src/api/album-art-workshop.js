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
 * The suggestion pass runs through the bg-broker, so it is serialised and never
 * runs while a library scan is in progress. With `albumArt.autoSuggestNewContent`
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
import crypto from 'node:crypto';
import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as broker from '../state/bg-task-broker.js';
import * as admin from '../util/admin.js';
import { onEveryScanEnd, isScanRunning } from '../state/scan-lock.js';
import { resolvePathWithinRoot } from '../util/path-security.js';
import { fetchPublicUrlBuffer, isPrivateHost } from '../util/ssrf-check.js';
import { suggestCovers, getReleaseCoverBuf } from './discogs.js';
import { joiValidate } from '../util/validation.js';

const PER_RUN_CAP      = 200;        // albums per suggestion pass
const PACE_MS          = 1500;       // delay between albums (Discogs rate limit)
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

function _db() { return db.getDB(); }

function _ensureTable() {
  _db().exec(`
    CREATE TABLE IF NOT EXISTS album_art_workshop (
      album_key       TEXT PRIMARY KEY,
      vpath           TEXT NOT NULL,
      album_id        TEXT,
      dir             TEXT NOT NULL,
      album           TEXT,
      artist          TEXT,
      status          TEXT,
      suggestions     TEXT,
      last_attempt_ts INTEGER,
      attempts        INTEGER DEFAULT 0,
      outcome         TEXT,
      applied_cover   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_aaw_status ON album_art_workshop(status);
    CREATE TABLE IF NOT EXISTS album_art_shelf (
      vpath  TEXT NOT NULL,
      prefix TEXT NOT NULL,
      ts     INTEGER,
      PRIMARY KEY (vpath, prefix)
    );
  `);
  // Migrations: source filter + restore-snapshot columns (idempotent).
  for (const col of [
    'top_source TEXT',        // primary suggestion source — enables a paginated source filter
    'prev_aaFile TEXT',       // snapshot before apply — for true restore/undo
    'prev_art_source TEXT',
    'prev_cover_file TEXT',
    'prev_cover_backup TEXT', // filename of the backed-up folder cover (cover.velvet-prev.jpg)
    'applied_aaFile TEXT',    // the aaFile this workshop wrote (for the Applied view)
    'had_art INTEGER',        // 1 if the album already had art before this apply
  ]) {
    try { _db().exec(`ALTER TABLE album_art_workshop ADD COLUMN ${col}`); } catch { /* already exists */ }
  }
  _db().exec('CREATE INDEX IF NOT EXISTS idx_aaw_top_source ON album_art_workshop(top_source)');
}

function _loadShelves() {
  _ensureTable();
  return _db().prepare('SELECT vpath, prefix, ts FROM album_art_shelf ORDER BY vpath, prefix').all();
}

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
  const rows = _db().prepare("SELECT vpath, filepath FROM files WHERE format IS NOT NULL").all();
  for (const r of rows) {
    const dir = _dirOf(r.filepath);
    let idx = dir.indexOf('/');
    while (idx !== -1) {
      set.add(r.vpath + '\u0000' + dir.slice(0, idx));
      idx = dir.indexOf('/', idx + 1);
    }
  }
  return set;
}

function _rootFolders() {
  const folders = config.program.folders || {};
  const roots = {};
  for (const [name, cfg] of Object.entries(folders)) {
    if (!cfg.root) continue;
    const myRoot  = cfg.root.replace(/\/?$/, '/');
    const isChild = Object.entries(folders).some(([other, otherCfg]) => {
      if (other === name) return false;
      const otherRoot = (otherCfg.root || '').replace(/\/?$/, '/');
      return myRoot.startsWith(otherRoot) && myRoot !== otherRoot;
    });
    if (!isChild) roots[name] = cfg.root;
  }
  return roots;
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

// Albums (folder = album, via the folder-based album_id) where no track has art.
function _selectArtlessAlbums() {
  return _db().prepare(`
    SELECT vpath, album_id,
           MIN(filepath)                          AS sample_filepath,
           MAX(album)                             AS album,
           MAX(COALESCE(album_artist, artist))    AS artist,
           MAX(year)                              AS year,
           COUNT(*)                               AS track_count
    FROM files
    WHERE format IS NOT NULL
    GROUP BY vpath, album_id
    HAVING MAX(NULLIF(aaFile, '')) IS NULL
  `).all();
}

function _albumKey(vpath, albumId) { return `${vpath}|${albumId}`; }

// The MusicBrainz release id for an album folder (any track that carries one),
// used to fetch the official Cover Art Archive cover as the preferred source.
function _releaseIdForAlbum(vpath, albumId) {
  try {
    const r = _db().prepare(
      'SELECT mb_release_id FROM files WHERE vpath = ? AND album_id = ? AND mb_release_id IS NOT NULL LIMIT 1'
    ).get(vpath, albumId);
    return r?.mb_release_id || null;
  } catch { return null; }
}

// Sync the workshop table with the current art-less album set: insert new
// candidates as 'pending', and drop rows whose album now has art (resolved
// elsewhere) unless they were explicitly applied/skipped.
function _reconcileCandidates() {
  _ensureTable();
  const rows       = _selectArtlessAlbums();
  const shelves    = _loadShelves();
  const containers = _containerDirs();
  const rawDb      = _db();
  const existing = new Map(
    rawDb.prepare('SELECT album_key, status FROM album_art_workshop').all().map(r => [r.album_key, r.status])
  );
  const seen = new Set();
  const ins = rawDb.prepare(`
    INSERT INTO album_art_workshop (album_key, vpath, album_id, dir, album, artist, status, attempts)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)
    ON CONFLICT(album_key) DO UPDATE SET dir = excluded.dir, album = excluded.album, artist = excluded.artist
  `);
  rawDb.exec('BEGIN');
  try {
    for (const r of rows) {
      const dir = _dirOf(r.sample_filepath);
      if (_isShelved(shelves, r.vpath, dir)) continue;
      if (containers.has(r.vpath + '\u0000' + dir)) continue;
      const key = _albumKey(r.vpath, r.album_id);
      seen.add(key);
      ins.run(key, r.vpath, r.album_id, dir, r.album || null, r.artist || null);
    }
    // Forget rows that no longer match an art-less album, except applied/skipped
    // history we want to keep as a cooldown record.
    for (const [key, status] of existing) {
      if (!seen.has(key) && status !== 'applied' && status !== 'skipped') {
        rawDb.prepare('DELETE FROM album_art_workshop WHERE album_key = ?').run(key);
      }
    }
    rawDb.exec('COMMIT');
  } catch (e) {
    try { rawDb.exec('ROLLBACK'); } catch { /* no txn */ }
    throw e;
  }
  return seen.size;
}

function _needsSuggest(row, now) {
  if (row.status === 'pending' || row.status === null) return true;
  if (row.status === 'error')    return now - (row.last_attempt_ts || 0) > ERROR_TTL_MS;
  if (row.status === 'suggested' || row.status === 'notfound') {
    return now - (row.last_attempt_ts || 0) > SUGGESTED_TTL_MS;
  }
  return false; // applied / skipped — never re-query
}

async function _runSuggestPass(nowMs, opts = {}) {
  const caaOnly = !!opts.caaOnly;
  _state.running   = true;
  _state.startedAt = nowMs;
  _state.processed = 0;
  _state.lastError = null;
  try {
    _reconcileCandidates();
    let rows = _db().prepare(`
      SELECT album_key, vpath, album_id, dir, album, artist, status, last_attempt_ts
      FROM album_art_workshop
    `).all().filter(r => _needsSuggest(r, nowMs));
    // MusicBrainz-only pass: only albums that carry a release id can resolve a CAA cover.
    if (caaOnly) rows = rows.filter(r => !!_releaseIdForAlbum(r.vpath, r.album_id));
    rows = rows.slice(0, PER_RUN_CAP);

    for (const row of rows) {
      if (_state.stopping) break;
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
          mbReleaseId: _releaseIdForAlbum(row.vpath, row.album_id),
          onlyCaa:  caaOnly,
        });
        status = suggestions.length ? 'suggested' : 'notfound';
      } catch (e) {
        status = 'error';
        winston.warn(`[album-art] suggest failed for ${row.album_key}: ${e.message}`);
      }
      _db().prepare(`
        UPDATE album_art_workshop
        SET suggestions = ?, status = ?, last_attempt_ts = ?, attempts = attempts + 1, outcome = ?, top_source = ?
        WHERE album_key = ?
      `).run(JSON.stringify(suggestions), status, nowMs, status, suggestions[0]?.source || null, row.album_key);

      if (status === 'suggested' && config.program.albumArt?.autoApprove) {
        try { await _applyCover(row.album_key, suggestions[0]); } catch (e) {
          winston.warn(`[album-art] auto-approve failed for ${row.album_key}: ${e.message}`);
        }
      }
      _state.processed += 1;
      await new Promise(r => setTimeout(r, PACE_MS));
    }
    _state.lastRunAt = Date.now();
  } catch (e) {
    _state.lastError = e.message;
    winston.error(`[album-art] suggestion pass error: ${e.message}`);
  } finally {
    _state.running      = false;
    _state.stopping     = false;
    _state.currentAlbum = null;
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

// Download → write cover.jpg into the album folder → cache + thumbnails → point
// every track in that folder at the cached image.
async function _applyCover(albumKey, choice) {
  const row = _db().prepare('SELECT * FROM album_art_workshop WHERE album_key = ?').get(albumKey);
  if (!row) throw new Error('Unknown albumKey');
  const root = _rootFolders()[row.vpath];
  if (!root) throw new Error(`vpath ${row.vpath} is not a root folder`);

  const folderAbs = resolvePathWithinRoot(root, row.dir);
  if (!fs.existsSync(folderAbs)) throw new Error('Album folder not found on disk');

  const srcBuf = await _downloadCover(choice);
  if (!_sniffImageExt(srcBuf)) throw new Error('Downloaded data is not a recognised image');

  // Snapshot the album's current art BEFORE overwriting, so a wrong apply can be
  // restored exactly. The old cached aaFile is intentionally NOT deleted here.
  const prevRow = _db().prepare(
    'SELECT aaFile, art_source, cover_file FROM files WHERE vpath = ? AND album_id = ? LIMIT 1'
  ).get(row.vpath, row.album_id) || {};
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
  const aaFile  = crypto.createHash('sha256').update(jpeg).digest('hex') + '.jpg';
  const artPath = resolvePathWithinRoot(artDir, aaFile);
  if (!fs.existsSync(artPath)) fs.writeFileSync(artPath, jpeg);
  for (const [pref, sz] of [['zs-', 92], ['zl-', 256], ['zm-', 512]]) {
    try {
      await sharp(jpeg).resize(sz, sz, { fit: 'inside', withoutEnlargement: true })
        .toFile(resolvePathWithinRoot(artDir, pref + aaFile));
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  }

  _db().prepare(
    `UPDATE files SET aaFile = ?, art_source = 'workshop', cover_file = 'cover.jpg' WHERE vpath = ? AND album_id = ?`
  ).run(aaFile, row.vpath, row.album_id);

  // First apply for this album snapshots the ORIGINAL art (COALESCE keeps it across
  // re-applies); applied_aaFile/status always reflect the latest apply.
  const firstApply = !row.applied_aaFile;
  _db().prepare(
    `UPDATE album_art_workshop SET
       status = 'applied', applied_cover = ?, outcome = 'applied', last_attempt_ts = ?,
       applied_aaFile = ?,
       prev_aaFile      = COALESCE(prev_aaFile, ?),
       prev_art_source  = COALESCE(prev_art_source, ?),
       prev_cover_file  = COALESCE(prev_cover_file, ?),
       prev_cover_backup= COALESCE(prev_cover_backup, ?),
       had_art          = COALESCE(had_art, ?)
     WHERE album_key = ?`
  ).run(
    choice.source || 'manual', Date.now(), aaFile,
    firstApply ? (prevRow.aaFile || null) : null,
    firstApply ? (prevRow.art_source || null) : null,
    firstApply ? (prevRow.cover_file || null) : null,
    prevCoverBackup,
    hadArt,
    albumKey,
  );

  return { aaFile, cover: 'cover.jpg' };
}

// Reverse the most recent apply: restore the album's tracks to their snapshotted
// art and put the folder cover.jpg back (from the backup, or remove it if the
// album had no art before). Returns the album to 'suggested' so it can be re-fixed.
async function _restoreCover(albumKey) {
  const row = _db().prepare('SELECT * FROM album_art_workshop WHERE album_key = ?').get(albumKey);
  if (!row) throw new Error('Unknown albumKey');
  if (!row.applied_aaFile) throw new Error('Nothing to restore');
  const root = _rootFolders()[row.vpath];
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
  _db().prepare(
    'UPDATE files SET aaFile = ?, art_source = ?, cover_file = ? WHERE vpath = ? AND album_id = ?'
  ).run(row.prev_aaFile || null, row.prev_art_source || null, row.prev_cover_file || null, row.vpath, row.album_id);

  // Re-open the album for fixing; clear the apply snapshot.
  const back = (row.suggestions && JSON.parse(row.suggestions).length) ? 'suggested' : 'pending';
  _db().prepare(
    `UPDATE album_art_workshop SET status = ?, applied_cover = NULL, outcome = NULL,
       applied_aaFile = NULL, prev_aaFile = NULL, prev_art_source = NULL,
       prev_cover_file = NULL, prev_cover_backup = NULL, had_art = NULL, last_attempt_ts = ?
     WHERE album_key = ?`
  ).run(back, Date.now(), albumKey);

  return { ok: true, status: back, restoredAaFile: row.prev_aaFile || null };
}

function _statusCounts() {
  _ensureTable();
  const rows = _db().prepare(
    'SELECT status, COUNT(*) AS n FROM album_art_workshop GROUP BY status'
  ).all();
  const c = { pending: 0, suggested: 0, applied: 0, skipped: 0, notfound: 0, error: 0 };
  for (const r of rows) if (r.status in c) c[r.status] = r.n;
  return c;
}

// Counts of currently-suggested albums grouped by primary source — drives the
// source filter chips (All / MusicBrainz / Discogs / Deezer / iTunes).
function _sourceCounts() {
  _ensureTable();
  const rows = _db().prepare(
    "SELECT top_source AS s, COUNT(*) AS n FROM album_art_workshop WHERE status = 'suggested' GROUP BY top_source"
  ).all();
  const c = { all: 0, musicbrainz: 0, discogs: 0, deezer: 0, itunes: 0 };
  for (const r of rows) { c.all += r.n; if (r.s in c) c[r.s] += r.n; }
  return c;
}

async function _persistAlbumArtConfig(patch) {
  config.program.albumArt = { ...(config.program.albumArt || {}), ...patch };
  const loadConfig = await admin.loadFile(config.configFile);
  loadConfig.albumArt = { ...(loadConfig.albumArt || {}), ...patch };
  await admin.saveFile(loadConfig, config.configFile);
}

function _startPass(opts = {}) {
  if (_state.running) return 'already_running';
  _state.stopping = false;
  const label = opts.caaOnly ? 'Album-Art MusicBrainz pass' : 'Album-Art suggestion pass';
  broker.submit('album-art-suggest', label, () => _runSuggestPass(Date.now(), opts));
  return 'queued';
}

export function setup(app) {
  try { _ensureTable(); } catch (e) { winston.warn('[album-art] table init failed: ' + e.message); }

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
    _ensureTable();
    const clauses = [];
    const filter  = [];
    if (status) { clauses.push('status = ?'); filter.push(status); }
    if (source) { clauses.push('top_source = ?'); filter.push(source); }
    if (q) {
      clauses.push('(dir LIKE ? OR album LIKE ? OR artist LIKE ?)');
      const like = '%' + q + '%';
      filter.push(like, like, like);
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

    // Lightweight mode: return every matching folder (no pagination, no suggestions)
    // so the UI can "select all found" across pages for bulk shelve.
    if (req.query.keys === '1') {
      const keyRows = _db().prepare(`
        SELECT album_key, vpath, dir FROM album_art_workshop ${where}
        ORDER BY (status = 'suggested') DESC, artist, album
      `).all(...filter);
      return res.json({ keys: keyRows.map(r => ({ albumKey: r.album_key, vpath: r.vpath, dir: r.dir })) });
    }

    const rows = _db().prepare(`
      SELECT album_key, vpath, album_id, dir, album, artist, status, suggestions, applied_cover,
             applied_aaFile, top_source, last_attempt_ts
      FROM album_art_workshop ${where}
      ORDER BY (status = 'suggested') DESC, artist, album
      LIMIT ? OFFSET ?
    `).all(...filter, limit, offset);
    const total = _db().prepare(
      `SELECT COUNT(*) AS n FROM album_art_workshop ${where}`
    ).get(...filter).n;
    // For the Applied view, surface the live cover (aaFile) so the user can SEE
    // what was stored, plus whether a restore is possible.
    const liveArt = _db().prepare('SELECT aaFile FROM files WHERE vpath = ? AND album_id = ? AND aaFile IS NOT NULL LIMIT 1');
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
        appliedAaFile: r.status === 'applied' ? (liveArt.get(r.vpath, r.album_id)?.aaFile || r.applied_aaFile || null) : null,
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
    _ensureTable();
    const row = _db().prepare('SELECT * FROM album_art_workshop WHERE album_key = ?').get(value.albumKey);
    if (!row) return res.status(404).json({ error: 'Unknown albumKey' });
    try {
      const q = _deriveQuery(row);
      const suggestions = await suggestCovers({
        artist: q.artist, album: q.title, title: q.title,
        filepath: `${row.vpath}/${row.dir}/x`,
        mbReleaseId: _releaseIdForAlbum(row.vpath, row.album_id),
        allSources: value.allSources,
      });
      const status = suggestions.length ? 'suggested' : 'notfound';
      _db().prepare(`
        UPDATE album_art_workshop SET suggestions = ?, status = ?, last_attempt_ts = ?, attempts = attempts + 1, outcome = ?, top_source = ?
        WHERE album_key = ?
      `).run(JSON.stringify(suggestions), status, Date.now(), status, suggestions[0]?.source || null, value.albumKey);
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
    _ensureTable();
    const applied = [];
    const failed = [];
    for (const albumKey of req.body.albumKeys) {
      const row = _db().prepare('SELECT suggestions FROM album_art_workshop WHERE album_key = ?').get(albumKey);
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
    _ensureTable();
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
    const like = '%' + q + '%';
    const rows = _db().prepare(`
      SELECT vpath, album_id,
             MIN(filepath)                        AS sample_filepath,
             MAX(album)                           AS album,
             MAX(COALESCE(album_artist, artist))  AS artist,
             MAX(aaFile)                          AS aaFile,
             COUNT(*)                             AS track_count
      FROM files
      WHERE format IS NOT NULL AND (album LIKE ? OR artist LIKE ? OR album_artist LIKE ?)
      GROUP BY vpath, album_id
      ORDER BY artist, album
      LIMIT 40
    `).all(like, like, like);
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
    _ensureTable();
    const i = value.albumKey.lastIndexOf('|');
    if (i < 1) return res.status(400).json({ error: 'bad albumKey' });
    const vpath = value.albumKey.slice(0, i);
    const albumId = value.albumKey.slice(i + 1);
    const info = _db().prepare(`
      SELECT MIN(filepath) AS sample, MAX(album) AS album,
             MAX(COALESCE(album_artist, artist)) AS artist, MAX(aaFile) AS aaFile
      FROM files WHERE vpath = ? AND album_id = ?
    `).get(vpath, albumId);
    if (!info?.sample) return res.status(404).json({ error: 'Album not found' });
    const dir = _dirOf(info.sample);
    _db().prepare(`
      INSERT INTO album_art_workshop (album_key, vpath, album_id, dir, album, artist, status, attempts)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)
      ON CONFLICT(album_key) DO UPDATE SET dir = excluded.dir, album = excluded.album, artist = excluded.artist
    `).run(value.albumKey, vpath, albumId, dir, info.album || null, info.artist || null);
    try {
      const q = _deriveQuery({ dir, artist: info.artist, album: info.album });
      const suggestions = await suggestCovers({
        artist: q.artist, album: q.title, title: q.title,
        filepath: `${vpath}/${dir}/x`,
        mbReleaseId: _releaseIdForAlbum(vpath, albumId),
        allSources: true,
      });
      const status = suggestions.length ? 'suggested' : 'notfound';
      _db().prepare(`
        UPDATE album_art_workshop SET suggestions = ?, status = ?, last_attempt_ts = ?, attempts = attempts + 1, outcome = ?, top_source = ?
        WHERE album_key = ?
      `).run(JSON.stringify(suggestions), status, Date.now(), status, suggestions[0]?.source || null, value.albumKey);
      res.json({ status, suggestions, current: { aaFile: info.aaFile || null, hasArt: !!info.aaFile } });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  app.post('/api/v1/admin/art/skip', (req, res) => {
    if (!adminOnly(req, res)) return;
    const { error, value } = Joi.object({ albumKey: Joi.string().required() }).validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    _ensureTable();
    const changed = _db().prepare(
      `UPDATE album_art_workshop SET status = 'skipped', outcome = 'skipped', last_attempt_ts = ? WHERE album_key = ?`
    ).run(Date.now(), value.albumKey).changes;
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
    const shelves = _loadShelves();
    const artless = _selectArtlessAlbums();
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
    _ensureTable();
    const ins = _db().prepare(
      'INSERT INTO album_art_shelf (vpath, prefix, ts) VALUES (?, ?, ?) ON CONFLICT(vpath, prefix) DO NOTHING'
    );
    const del = _db().prepare(
      `DELETE FROM album_art_workshop WHERE vpath = ? AND (dir = ? OR dir LIKE ? || '/%') AND status != 'applied'`
    );
    const now = Date.now();
    let removed = 0;
    const list = _shelfList(value);
    for (const f of list) {
      ins.run(f.vpath, f.prefix, now);
      removed += del.run(f.vpath, f.prefix, f.prefix).changes;
    }
    res.json({ ok: true, removed, count: list.length });
  });

  app.post('/api/v1/admin/art/unshelve', (req, res) => {
    if (!adminOnly(req, res)) return;
    const { error, value } = _shelfSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    _ensureTable();
    const del = _db().prepare('DELETE FROM album_art_shelf WHERE vpath = ? AND prefix = ?');
    let changed = 0;
    for (const f of _shelfList(value)) changed += del.run(f.vpath, f.prefix).changes;
    if (!changed) return res.status(404).json({ error: 'Shelf entry not found' });
    try { _reconcileCandidates(); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    res.json({ ok: true, count: changed });
  });
}
