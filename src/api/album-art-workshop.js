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
 *   GET  /api/v1/admin/art/status
 *   GET  /api/v1/admin/art/candidates?offset=&limit=&status=
 *   POST /api/v1/admin/art/scan        — start a suggestion pass
 *   POST /api/v1/admin/art/stop        — request the running pass to stop
 *   POST /api/v1/admin/art/suggest     — { albumKey } refetch one album
 *   POST /api/v1/admin/art/apply       — { albumKey, releaseId|coverUrl }
 *   POST /api/v1/admin/art/skip        — { albumKey }
 *   POST /api/v1/admin/art/config      — { autoApprove?, autoSuggestNewContent? }
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

async function _runSuggestPass(nowMs) {
  _state.running   = true;
  _state.startedAt = nowMs;
  _state.processed = 0;
  _state.lastError = null;
  try {
    _reconcileCandidates();
    const rows = _db().prepare(`
      SELECT album_key, vpath, dir, album, artist, status, last_attempt_ts
      FROM album_art_workshop
    `).all().filter(r => _needsSuggest(r, nowMs)).slice(0, PER_RUN_CAP);

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
        });
        status = suggestions.length ? 'suggested' : 'notfound';
      } catch (e) {
        status = 'error';
        winston.warn(`[album-art] suggest failed for ${row.album_key}: ${e.message}`);
      }
      _db().prepare(`
        UPDATE album_art_workshop
        SET suggestions = ?, status = ?, last_attempt_ts = ?, attempts = attempts + 1, outcome = ?
        WHERE album_key = ?
      `).run(JSON.stringify(suggestions), status, nowMs, status, row.album_key);

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
  return fetchPublicUrlBuffer(choice.coverUrl, {
    headers: { 'User-Agent': 'Velvet/dev +https://github.com/aroundmyroom/Velvet' },
    maxContentLength: 20 * 1024 * 1024,
  });
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

  _db().prepare(
    `UPDATE album_art_workshop SET status = 'applied', applied_cover = ?, outcome = 'applied', last_attempt_ts = ? WHERE album_key = ?`
  ).run(choice.source || 'manual', Date.now(), albumKey);

  return { aaFile, cover: 'cover.jpg' };
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

async function _persistAlbumArtConfig(patch) {
  config.program.albumArt = { ...(config.program.albumArt || {}), ...patch };
  const loadConfig = await admin.loadFile(config.configFile);
  loadConfig.albumArt = { ...(loadConfig.albumArt || {}), ...patch };
  await admin.saveFile(loadConfig, config.configFile);
}

function _startPass() {
  if (_state.running) return 'already_running';
  _state.stopping = false;
  broker.submit('album-art-suggest', 'Album-Art suggestion pass', () => _runSuggestPass(Date.now()));
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
      config: {
        autoApprove:           config.program.albumArt?.autoApprove === true,
        autoSuggestNewContent: config.program.albumArt?.autoSuggestNewContent === true,
      },
    });
  });

  app.get('/api/v1/admin/art/candidates', (req, res) => {
    if (!adminOnly(req, res)) return;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const status = String(req.query.status || '').trim();
    const q      = String(req.query.q || '').trim();
    _ensureTable();
    const clauses = [];
    const filter  = [];
    if (status) { clauses.push('status = ?'); filter.push(status); }
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
      SELECT album_key, vpath, dir, album, artist, status, suggestions, applied_cover, last_attempt_ts
      FROM album_art_workshop ${where}
      ORDER BY (status = 'suggested') DESC, artist, album
      LIMIT ? OFFSET ?
    `).all(...filter, limit, offset);
    const total = _db().prepare(
      `SELECT COUNT(*) AS n FROM album_art_workshop ${where}`
    ).get(...filter).n;
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
        lastAttempt: r.last_attempt_ts,
        suggestions: r.suggestions ? JSON.parse(r.suggestions) : [],
      })),
    });
  });

  app.post('/api/v1/admin/art/scan', (req, res) => {
    if (!adminOnly(req, res)) return;
    res.json({ status: _startPass() });
  });

  app.post('/api/v1/admin/art/stop', (req, res) => {
    if (!adminOnly(req, res)) return;
    if (!_state.running) return res.json({ status: 'not_running' });
    _state.stopping = true;
    res.json({ status: 'stopping' });
  });

  app.post('/api/v1/admin/art/suggest', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const { error, value } = Joi.object({ albumKey: Joi.string().required() }).validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    _ensureTable();
    const row = _db().prepare('SELECT * FROM album_art_workshop WHERE album_key = ?').get(value.albumKey);
    if (!row) return res.status(404).json({ error: 'Unknown albumKey' });
    try {
      const q = _deriveQuery(row);
      const suggestions = await suggestCovers({
        artist: q.artist, album: q.title, title: q.title,
        filepath: `${row.vpath}/${row.dir}/x`,
      });
      const status = suggestions.length ? 'suggested' : 'notfound';
      _db().prepare(`
        UPDATE album_art_workshop SET suggestions = ?, status = ?, last_attempt_ts = ?, attempts = attempts + 1, outcome = ?
        WHERE album_key = ?
      `).run(JSON.stringify(suggestions), status, Date.now(), status, value.albumKey);
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
