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
 * The scan runs on the background task broker in short chunks, so requests
 * (streams included) keep being served and Cancel takes effect between chunks.
 * Results of the previous scan stay visible until a new scan completes.
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
import * as broker from '../state/bg-task-broker.js';

const AUDIO_GROUPS_PER_CHUNK = 200;
const TRACKS_PER_CHUNK = 20_000;

// ── State ────────────────────────────────────────────────────────────────────
let _run         = null;   // the scan in progress, null when idle
let _runSeq      = 0;
let _scanAt      = null;   // ISO timestamp of last completed scan
let _threshold   = 90;     // similarity % threshold for "similar" tier
let _songGroups  = { exact: [], audio: [], similar: [] };
let _folderGroups = [];

// ── Scan Logic ───────────────────────────────────────────────────────────────
function _group(matchType, similarity, r, title, artist, album) {
  return {
    matchType, similarity, title, artist, album,
    duration: r.min_dur,
    paths: r.paths.split('||'),
    formats: r.fmts.split('||'),
  };
}

function _similarity(r) {
  const avg = (r.max_dur + r.min_dur) / 2;
  return Math.max(0, Math.min(100, 100 - ((r.max_dur - r.min_dur) / avg * 100)));
}

// Each step does one slice of work and returns true while it has more to do.
const STEPS = [
  function exact(run) {
    const rows = db.dupExactGroups();
    run.exactHashes = new Set(rows.map(r => r.hash));
    run.songs.exact = rows.map(r => _group('exact', 100, r, r.title, r.artist, r.album));
    return false;
  },

  // Audio: same audio_hash, different file hash — skip groups the exact tier already covers
  function audio(run) {
    run.audioRows ??= db.dupAudioGroups();
    const end = Math.min(run.audioPos + AUDIO_GROUPS_PER_CHUNK, run.audioRows.length);
    for (; run.audioPos < end; run.audioPos++) {
      const r = run.audioRows[run.audioPos];
      const hashes = db.dupHashesForPaths(r.paths.split('||'));
      if (!hashes.every(h => run.exactHashes.has(h))) run.songs.audio.push(_group('audio', 99, r, r.title, r.artist, r.album));
    }
    return run.audioPos < run.audioRows.length;
  },

  function similar(run) {
    run.songs.similar = db.dupSimilarGroups()
      .filter(r => r.max_dur && r.min_dur && _similarity(r) >= run.threshold)
      .map(r => _group('similar', Math.round(_similarity(r)), r, r.title_display, r.artist_display, r.album_display));
    return false;
  },

  // Folder fingerprint = the sorted content hashes (audio_hash, else file hash) of
  // its tracks. Two directories with the same fingerprint hold identical audio,
  // whatever their names or tags — this catches different rips of one album.
  function folderTracks(run) {
    run.tracks ??= db.dupContentHashedTracks();
    const end = Math.min(run.trackPos + TRACKS_PER_CHUNK, run.tracks.length);
    for (; run.trackPos < end; run.trackPos++) {
      const row = run.tracks[run.trackPos];
      const dir = path.dirname(row.fullpath);
      if (!run.dirMap.has(dir)) run.dirMap.set(dir, { hashes: [], artist: row.artist, album: row.album });
      run.dirMap.get(dir).hashes.push(row.content_hash);
    }
    return run.trackPos < run.tracks.length;
  },

  function folderGroups(run) {
    const fpMap = new Map();
    for (const [dir, entry] of run.dirMap) {
      if (entry.hashes.length < 2) continue;
      const fp = entry.hashes.slice().sort((a, b) => a.localeCompare(b)).join('|');
      if (!fpMap.has(fp)) fpMap.set(fp, []);
      fpMap.get(fp).push({ dir, artist: entry.artist, album: entry.album, count: entry.hashes.length });
    }
    for (const copies of fpMap.values()) {
      if (copies.length < 2) continue;
      run.folders.push({
        trackCount: copies[0].count,
        copies: copies.map(c => ({ dir: c.dir, artist: c.artist, album: c.album })),
      });
    }
    run.folders.sort((a, b) => b.copies.length - a.copies.length || b.trackCount - a.trackCount);
    return false;
  },
];

function _startScan(threshold) {
  const run = {
    threshold, cancelled: false, step: 0,
    songs: { exact: [], audio: [], similar: [] }, folders: [],
    exactHashes: null, audioRows: null, audioPos: 0, tracks: null, trackPos: 0, dirMap: new Map(),
  };
  _run = run;
  broker.submitChunks(`dup-workshop-scan-${++_runSeq}`, 'Duplicate Workshop scan', () => {
    if (run.cancelled) return false;
    try {
      if (STEPS[run.step](run)) return true;
      if (++run.step < STEPS.length) return true;
    } catch (e) {
      winston.error('Duplicate Workshop scan failed', { stack: e.stack ?? String(e) });
      _run = null;
      return false;
    }
    _songGroups = run.songs;
    _folderGroups = run.folders;
    _scanAt = new Date().toISOString();
    _run = null;
    winston.info(`Duplicate Workshop scan complete: ${_songGroups.exact.length} exact, ${_songGroups.audio.length} audio, ${_songGroups.similar.length} similar, ${_folderGroups.length} folder groups`);
    return false;
  });
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
    const state = _run ? 'scanning' : doneOrIdle;
    res.json({
      state,
      threshold: _threshold,
      summary: _scanAt ? _summary() : null,
      lastScan: _scanAt,
    });
  });

  // POST /scan — queues the scan on the broker; returns 202 immediately
  velvet.post('/api/v1/admin/dup-workshop/scan', (req, res) => {
    if (_run) return res.status(409).json({ error: 'Scan already in progress' });
    const schema = Joi.object({ threshold: Joi.number().integer().min(50).max(100).default(90) });
    const { error, value } = schema.validate(req.body ?? {});
    if (error) return res.status(400).json({ error: error.message });
    _threshold = value.threshold;
    _startScan(value.threshold);
    res.status(202).json({ started: true });
  });

  // POST /cancel — stops before the next chunk; the previous results stay
  velvet.post('/api/v1/admin/dup-workshop/cancel', (_req, res) => {
    if (!_run) return res.status(400).json({ error: 'No scan in progress' });
    _run.cancelled = true;
    _run = null;
    winston.info('Duplicate Workshop scan cancelled');
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
