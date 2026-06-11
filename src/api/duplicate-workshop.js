/**
 * duplicate-workshop.js
 *
 * Admin tool for finding and removing duplicate songs and folder-duplicate
 * groups in the library. Three tiers of detection:
 *
 *   Exact   — same file hash (byte-for-byte identical)
 *   Audio   — same audio hash but different file (re-tagged or transcoded)
 *   Similar — same artist+title with very close duration
 *
 * Folder duplicates: albums where the same artist+album appears under
 * more than one distinct directory path.
 *
 * Endpoints (admin-only):
 *   GET  /api/v1/admin/dup-workshop/status
 *   POST /api/v1/admin/dup-workshop/scan       body: { threshold? }
 *   POST /api/v1/admin/dup-workshop/cancel
 *   GET  /api/v1/admin/dup-workshop/songs      ?match=exact|audio|similar&limit&offset
 *   GET  /api/v1/admin/dup-workshop/folders    ?limit&offset
 *   POST /api/v1/admin/dup-workshop/delete     body: { filepaths: [] }
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as vpath from '../util/vpath.js';

// ── State ────────────────────────────────────────────────────────────────────
let _scanning    = false;
let _cancelling  = false;
let _scanAt      = null;   // ISO timestamp of last completed scan
let _threshold   = 90;     // similarity % threshold for "similar" tier
let _songGroups  = { exact: [], audio: [], similar: [] };
let _folderGroups = [];

// ── Scan Logic ───────────────────────────────────────────────────────────────
async function _scan(threshold) {
  _scanning   = true;
  _cancelling = false;
  _songGroups = { exact: [], audio: [], similar: [] };
  _folderGroups = [];

  try {
    const rawDb = db.getDB();

    if (_cancelling) { return; }

    // ── Tier 1: Exact (same hash) ────────────────────────────────────────
    const exactRows = rawDb.prepare(String.raw`
      SELECT
        hash,
        COUNT(*) AS c,
        GROUP_CONCAT(vpath || '/' || filepath, '||') AS paths,
        GROUP_CONCAT(COALESCE(format,''), '||') AS fmts,
        MIN(duration) AS min_dur,
        MAX(duration) AS max_dur,
        COALESCE(MIN(title),'') AS title,
        COALESCE(MIN(artist),'') AS artist,
        COALESCE(MIN(album),'') AS album
      FROM files
      WHERE hash IS NOT NULL AND hash != ''
        AND duration IS NOT NULL AND duration > 0
      GROUP BY hash
      HAVING c > 1
      ORDER BY c DESC
    `).all();

    const exactHashes = new Set(exactRows.map(r => r.hash));

    _songGroups.exact = exactRows.map(r => ({
      matchType: 'exact',
      similarity: 100,
      title:  r.title,
      artist: r.artist,
      album:  r.album,
      duration: r.min_dur,
      paths: r.paths.split('||'),
      formats: r.fmts.split('||'),
    }));

    if (_cancelling) { return; }

    // ── Tier 2: Audio (same audio_hash, different file hash) ─────────────
    const audioRows = rawDb.prepare(String.raw`
      SELECT
        audio_hash,
        COUNT(*) AS c,
        GROUP_CONCAT(vpath || '/' || filepath, '||') AS paths,
        GROUP_CONCAT(COALESCE(format,''), '||') AS fmts,
        MIN(duration) AS min_dur,
        MAX(duration) AS max_dur,
        COALESCE(MIN(title),'') AS title,
        COALESCE(MIN(artist),'') AS artist,
        COALESCE(MIN(album),'') AS album
      FROM files
      WHERE audio_hash IS NOT NULL AND audio_hash != ''
        AND duration IS NOT NULL AND duration > 0
        AND (hash IS NULL OR hash = '' OR hash NOT IN (SELECT hash FROM files WHERE hash IS NOT NULL AND hash != '' AND duration > 0 GROUP BY hash HAVING COUNT(*) > 1))
      GROUP BY audio_hash
      HAVING c > 1
      ORDER BY c DESC
    `).all();

    // Filter out groups where all hashes are already caught by exact tier
    _songGroups.audio = audioRows
      .filter(r => {
        // Only keep if NOT all paths are already in an exact group
        const filePaths = r.paths.split('||');
        const rowHashes = rawDb.prepare(
          `SELECT hash FROM files WHERE vpath || '/' || filepath IN (${filePaths.map(() => '?').join(',')}) AND hash IS NOT NULL AND hash != ''`
        ).all(...filePaths).map(x => x.hash);
        return !rowHashes.every(h => exactHashes.has(h));
      })
      .map(r => ({
        matchType: 'audio',
        similarity: 99,
        title:  r.title,
        artist: r.artist,
        album:  r.album,
        duration: r.min_dur,
        paths: r.paths.split('||'),
        formats: r.fmts.split('||'),
      }));

    if (_cancelling) { return; }

    // ── Tier 3: Similar (same normalised artist+title, close duration) ───
    const similarRows = rawDb.prepare(String.raw`
      SELECT
        lower(trim(COALESCE(artist,''))) AS a,
        lower(trim(COALESCE(title,'')))  AS t,
        COUNT(*) AS c,
        MIN(duration) AS min_dur,
        MAX(duration) AS max_dur,
        GROUP_CONCAT(vpath || '/' || filepath, '||') AS paths,
        GROUP_CONCAT(COALESCE(format,''), '||') AS fmts,
        COALESCE(MIN(artist),'') AS artist_display,
        COALESCE(MIN(title),'')  AS title_display,
        COALESCE(MIN(album),'')  AS album_display
      FROM files
      WHERE artist IS NOT NULL AND artist != '' AND artist != 'Artist'
        AND title  IS NOT NULL AND title  != ''
        AND duration IS NOT NULL AND duration > 0
      GROUP BY a, t
      HAVING c > 1
      ORDER BY c DESC
    `).all();

    _songGroups.similar = similarRows
      .filter(r => {
        if (!r.max_dur || !r.min_dur) return false;
        const avg = (r.max_dur + r.min_dur) / 2;
        if (!avg) return false;
        const sim = Math.max(0, Math.min(100, 100 - ((r.max_dur - r.min_dur) / avg * 100)));
        return sim >= threshold;
      })
      .map(r => {
        const avg = (r.max_dur + r.min_dur) / 2 || 1;
        const sim = Math.max(0, Math.min(100, Math.round(100 - ((r.max_dur - r.min_dur) / avg * 100))));
        return {
          matchType: 'similar',
          similarity: sim,
          title:  r.title_display,
          artist: r.artist_display,
          album:  r.album_display,
          duration: r.min_dur,
          paths: r.paths.split('||'),
          formats: r.fmts.split('||'),
        };
      });

    if (_cancelling) { return; }

    // ── Folder duplicates (content-based, 100% match) ────────────────────
    // Strategy: compute a "fingerprint" for every directory = the sorted list
    // of audio_hash values for all tracks in that folder. Two directories with
    // the same fingerprint contain 100% identical audio — regardless of folder
    // name or artist/album tags. This catches different rips of the same album
    // stored under different names.
    //
    // If a file has no audio_hash we fall back to file hash; tracks with
    // neither are skipped so partial results are still meaningful.
    const trackRows = rawDb.prepare(String.raw`
      SELECT
        vpath || '/' || filepath AS fullpath,
        COALESCE(NULLIF(audio_hash,''), NULLIF(hash,'')) AS content_hash,
        COALESCE(artist,'') AS artist,
        COALESCE(album,'')  AS album
      FROM files
      WHERE COALESCE(NULLIF(audio_hash,''), NULLIF(hash,'')) IS NOT NULL
    `).all();

    // Group tracks by parent directory
    const dirMap = new Map(); // dir → { hashes, artist, album }
    for (const row of trackRows) {
      const dir = path.dirname(row.fullpath);
      if (!dirMap.has(dir)) {
        dirMap.set(dir, { hashes: [], artist: row.artist, album: row.album });
      }
      dirMap.get(dir).hashes.push(row.content_hash);
    }

    // Build fingerprint per directory = sorted hashes joined
    const fpMap = new Map(); // fingerprint → [{dir, artist, album, count}]
    for (const [dir, entry] of dirMap) {
      if (entry.hashes.length < 2) continue; // skip single-track dirs
      const fp = entry.hashes.slice().sort((a, b) => a.localeCompare(b)).join('|');
      if (!fpMap.has(fp)) fpMap.set(fp, []);
      fpMap.get(fp).push({ dir, artist: entry.artist, album: entry.album, count: entry.hashes.length });
    }

    _folderGroups = [];
    for (const [, copies] of fpMap) {
      if (copies.length < 2) continue;
      _folderGroups.push({
        trackCount: copies[0].count,
        copies: copies.map(c => ({ dir: c.dir, artist: c.artist, album: c.album })),
      });
    }
    _folderGroups.sort((a, b) => b.copies.length - a.copies.length || b.trackCount - a.trackCount);

    _scanAt = new Date().toISOString();
    winston.info(`Duplicate Workshop scan complete: ${_songGroups.exact.length} exact, ${_songGroups.audio.length} audio, ${_songGroups.similar.length} similar, ${_folderGroups.length} folder groups`);
  } catch (e) {
    winston.error('Duplicate Workshop scan failed', { stack: e.stack ?? String(e) });
  } finally {
    _scanning   = false;
    _cancelling = false;
  }
}

function _summary() {
  const groups = _songGroups.exact.length + _songGroups.audio.length + _songGroups.similar.length + _folderGroups.length;
  // Count removable files: for each group, all paths except the first (keep one)
  let files = 0;
  for (const tier of Object.values(_songGroups)) {
    for (const g of tier) files += g.paths.length - 1;
  }
  return { groups, files };
}

// ── Route Setup ──────────────────────────────────────────────────────────────

export function setup(velvet) {

  // Admin-only guard
  velvet.all('/api/v1/admin/dup-workshop/{*path}', (req, res, next) => {
    if (req.user?.admin !== true) return res.status(403).json({ error: 'Admin only' });
    next();
  });

  // GET /status
  velvet.get('/api/v1/admin/dup-workshop/status', (_req, res) => {
    const doneOrIdle = _scanAt ? 'done' : 'idle';
    const state = _scanning ? 'scanning' : doneOrIdle;
    res.json({
      state,
      threshold: _threshold,
      summary: _scanAt ? _summary() : null,
      lastScan: _scanAt,
    });
  });

  // POST /scan — starts an async scan; returns 202 immediately
  velvet.post('/api/v1/admin/dup-workshop/scan', (req, res) => {
    if (_scanning) return res.status(409).json({ error: 'Scan already in progress' });
    const schema = Joi.object({ threshold: Joi.number().integer().min(50).max(100).default(90) });
    const { error, value } = schema.validate(req.body ?? {});
    if (error) return res.status(400).json({ error: error.message });
    _threshold = value.threshold;
    _scan(value.threshold); // fire-and-forget
    res.status(202).json({ started: true });
  });

  // POST /cancel
  velvet.post('/api/v1/admin/dup-workshop/cancel', (_req, res) => {
    if (!_scanning) return res.status(400).json({ error: 'No scan in progress' });
    _cancelling = true;
    res.json({ cancelling: true });
  });

  // GET /songs?match=exact|audio|similar&limit=25&offset=0
  velvet.get('/api/v1/admin/dup-workshop/songs', (req, res) => {
    const schema = Joi.object({
      match:  Joi.string().valid('exact', 'audio', 'similar').default('exact'),
      limit:  Joi.number().integer().min(1).max(500).default(25),
      offset: Joi.number().integer().min(0).default(0),
    });
    const { error, value } = schema.validate(req.query);
    if (error) return res.status(400).json({ error: error.message });
    const all = _songGroups[value.match] ?? [];
    const slice = all.slice(value.offset, value.offset + value.limit);
    res.json({ total: all.length, offset: value.offset, limit: value.limit, groups: slice });
  });

  // GET /folders?limit=25&offset=0
  velvet.get('/api/v1/admin/dup-workshop/folders', (req, res) => {
    const schema = Joi.object({
      limit:  Joi.number().integer().min(1).max(500).default(25),
      offset: Joi.number().integer().min(0).default(0),
    });
    const { error, value } = schema.validate(req.query);
    if (error) return res.status(400).json({ error: error.message });
    const slice = _folderGroups.slice(value.offset, value.offset + value.limit);
    res.json({ total: _folderGroups.length, offset: value.offset, limit: value.limit, groups: slice });
  });

  // POST /delete — body: { filepaths: ['vpath/rel/path.flac', ...] }
  velvet.post('/api/v1/admin/dup-workshop/delete', async (req, res) => {
    const schema = Joi.object({
      filepaths: Joi.array().items(Joi.string()).min(1).max(500).required(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const deleted = [];
    const failed  = [];

    for (const fp of value.filepaths) {
      let pathInfo;
      try {
        // Admin bypass: we pass a synthetic user with all vpaths
        const allVpaths = Object.keys(config.program.folders ?? {});
        pathInfo = vpath.getVPathInfo(fp, { vpaths: allVpaths });
      } catch (e) {
        failed.push({ fp, reason: e.message });
        continue;
      }

      try {
        await fs.unlink(pathInfo.fullPath);
        const dbFilepath = path.relative(pathInfo.vpath, fp);
        db.removeFileByPath(dbFilepath, pathInfo.vpath);
        deleted.push(fp);
        winston.info(`Duplicate Workshop: deleted ${pathInfo.fullPath}`);

        // Remove from in-memory song groups so the UI reflects the change
        for (const tier of Object.values(_songGroups)) {
          for (const g of tier) {
            const idx = g.paths.indexOf(fp);
            if (idx !== -1) {
              g.paths.splice(idx, 1);
              g.formats.splice(idx, 1);
            }
          }
        }
        // Prune groups that now have only 1 (or 0) paths
        for (const tierKey of Object.keys(_songGroups)) {
          _songGroups[tierKey] = _songGroups[tierKey].filter(g => g.paths.length > 1);
        }
      } catch (e) {
        if (e.code === 'ENOENT') {
          // File already gone — still remove DB row if present
          try {
            const dbFilepath = path.relative(pathInfo.vpath, fp);
            db.removeFileByPath(dbFilepath, pathInfo.vpath);
          } catch { /* no-op */ }
          deleted.push(fp);
        } else {
          winston.error(`Duplicate Workshop: failed to delete ${fp}`, { stack: e.stack ?? String(e) });
          failed.push({ fp, reason: e.message });
        }
      }
    }

    res.json({ deleted, failed });
  });
}
