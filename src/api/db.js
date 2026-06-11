import crypto from 'node:crypto';
import Joi from 'joi';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import * as vpath from '../util/vpath.js';
import * as dbQueue from '../db/task-queue.js';
import * as db from '../db/manager.js';
import * as config from '../state/config.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';
import { mergeGenreRows } from '../util/genre-merge.js';
import { indexFileOnDemand } from '../util/on-demand-index.js';
import { ffprobeBin } from '../util/ffmpeg-bootstrap.js';
import { resolveChildPath, resolvePathWithinRoot } from '../util/path-security.js';
import { parseFile } from 'music-metadata';

function dbFilepath(vpath, filepath) {
  const left = String(vpath ?? '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  const right = String(filepath ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  return `${left}/${right}`;
}

/**
 * Returns excludeFilepathPrefixes for child vpaths that are defined in config
 * but that the requesting user does NOT have access to.
 *
 * Example: user has "Music" but NOT "12-inches" (a child of "Music" whose root
 * is /music/12\ inches/).  This returns [{ vpath:"Music", prefix:"12 inches/" }]
 * so DB queries on "Music" automatically exclude that sub-folder.
 */
function computeChildExclusions(userVpaths) {
  const allFolders = config.program.folders || {};
  const userSet = new Set(userVpaths);
  const exclusions = [];
  for (const [name, cfg] of Object.entries(allFolders)) {
    if (userSet.has(name)) continue; // user has access — nothing to exclude
    const childRoot = cfg.root.replace(/\/?$/, '/');
    // Find the user-accessible parent whose root is a strict prefix of this child
    const parentName = userVpaths.find(p => {
      const pr = (allFolders[p]?.root || '').replace(/\/?$/, '/');
      return pr.length > 0 && childRoot.startsWith(pr) && childRoot !== pr;
    });
    if (!parentName) continue;
    const prefix = childRoot.slice(allFolders[parentName].root.replace(/\/?$/, '/').length);
    if (prefix) exclusions.push({ vpath: parentName, prefix });
  }
  return exclusions;
}

function renderMetadataObj(row) {
  // Build rg object: trackGain uses full priority chain; albumGain is the raw
  // measured album value only (null = no album measurement, client falls back).
  const trackR = resolveTrackGain(row, 'track');
  const rgObj = trackR ? {
    trackGain: trackR.gain,
    truePeak:  trackR.peak,
    albumGain: row.rg_album_gain_db ?? null,
    albumPeak: row.rg_album_peak_dbfs ?? null,
    src:       trackR.src,
  } : null;

  return {
    "filepath": dbFilepath(row.vpath, row.filepath),
    "metadata": {
      "artist": row.artist || row.album_artist || null,
      "album-artist": row.album_artist || null,
      "hash": row.hash ? row.hash : null,
      "album": row.album ? row.album : null,
      "track": row.track ? row.track : null,
      "track-of": row.trackOf ? row.trackOf : null,
      "disk": row.disk ? row.disk : null,
      "title": row.title ? row.title : null,
      "year": row.year ? row.year : null,
      "album-art": row.aaFile ? row.aaFile : null,
      "rating": row.rating ? row.rating : null,
      "play-count": row.playCount ? row.playCount : null,
      "last-played": row.lastPlayed ? row.lastPlayed : null,
      "genre": row.genre || null,
      "replaygain-track-db": row.replaygainTrackDb ?? null,
      "duration": row.duration ?? null,
      "bitrate": row.bitrate ?? null,
      "sample-rate": row.sample_rate ?? null,
      "channels": row.channels ?? null,
      "bit-depth": row.bit_depth ?? null,
      "album-version": row.album_version || null,
      "bpm": row.bpm ?? null,
      "musical-key": row.musical_key || null
    },
    "rg": rgObj
  };
}

// Resolve a file by its child-vpath filepath, falling back to the parent vpath
// if the file is stored in the DB under the parent (scanned before the child
// vpath was added, or vice-versa).  Returns the DB row or null.
function resolveFile(pathInfo, user) {
  let result = db.findFileByPath(pathInfo.relativePath, pathInfo.vpath);
  if (!result) {
    const folders = config.program?.folders || {};
    const myRoot  = folders[pathInfo.vpath]?.root.replace(/\/?$/, '/');
    if (myRoot) {
      for (const [parentKey, parentFolder] of Object.entries(folders)) {
        if (parentKey === pathInfo.vpath) continue;
        if (user && !user.vpaths.includes(parentKey)) continue;
        const parentRoot = parentFolder.root.replace(/\/?$/, '/');
        if (myRoot.startsWith(parentRoot) && myRoot !== parentRoot) {
          const prefix = myRoot.slice(parentRoot.length);
          result = db.findFileByPath(prefix + pathInfo.relativePath, parentKey);
          if (result) break;
        }
      }
    }
  }
  return result;
}

/**
 * Resolve the best available ReplayGain gain value for a DB row.
 * Priority (track mode): rg_track_gain_db → r128_track_gain_db+5 → replaygainTrackDb → null
 * Priority (album mode): rg_album_gain_db → rg_track_gain_db → r128_track_gain_db+5 → replaygainTrackDb → null
 * Returns { gain (dB), peak (dBTP or null), src } or null if no data.
 */
export function resolveTrackGain(row, mode) {
  if (!row) return null;
  if (mode === 'album' && row.rg_album_gain_db != null) {
    return { gain: row.rg_album_gain_db, peak: row.rg_album_peak_dbfs ?? null, src: 'measured_album' };
  }
  if (row.rg_track_gain_db != null) {
    return { gain: row.rg_track_gain_db, peak: row.rg_true_peak_dbfs ?? null, src: 'measured' };
  }
  if (row.r128_track_gain_db != null) {
    return { gain: row.r128_track_gain_db + 5, peak: null, src: 'r128' };
  }
  if (row.replaygainTrackDb != null) {
    return { gain: row.replaygainTrackDb, peak: null, src: 'tag' };
  }
  return null;
}

export function pullMetaData(filepath, user) {
  const pathInfo = vpath.getVPathInfo(filepath, user);
  let result = db.getFileWithMetadata(pathInfo.relativePath, pathInfo.vpath, user.username);

  if (!result) {
    // This vpath may be a sub-folder of another vpath (e.g. "12-inches" lives
    // inside the "Music" root). Try to find the file via the parent vpath.
    const folders = config.program?.folders || {};
    const myRoot  = folders[pathInfo.vpath]?.root.replace(/\/?$/, '/');
    if (myRoot) {
      for (const [parentKey, parentFolder] of Object.entries(folders)) {
        if (parentKey === pathInfo.vpath) continue;
        if (!user.vpaths.includes(parentKey)) continue;
        const parentRoot = parentFolder.root.replace(/\/?$/, '/');
        if (myRoot.startsWith(parentRoot) && myRoot !== parentRoot) {
          const prefix = myRoot.slice(parentRoot.length);
          result = db.getFileWithMetadata(prefix + pathInfo.relativePath, parentKey, user.username);
          if (result) {
            // File is served from the parent vpath's static mount, so the
            // playback filepath must use the parent vpath, not the child name.
            const rendered = renderMetadataObj(result);
            rendered.filepath = parentKey + '/' + prefix + pathInfo.relativePath;
            return rendered;
          }
        }
      }
    }
  }

  if (!result) {
    return { "filepath": filepath, "metadata": null };
  }

  // Always return the original filepath so the song plays via the correct vpath
  const rendered = renderMetadataObj(result);
  rendered.filepath = filepath;
  return rendered;
}

export function pullMetaDataBatch(filepaths, user) {
  const out = {};
  if (!Array.isArray(filepaths) || filepaths.length === 0) return out;

  const groups = new Map(); // vpath -> [{ original, relative }]
  for (const fp of filepaths) {
    try {
      const info = vpath.getVPathInfo(fp, user);
      if (!groups.has(info.vpath)) groups.set(info.vpath, []);
      groups.get(info.vpath).push({ original: fp, relative: info.relativePath });
    } catch {
      // Keep shape-compatible fallback for malformed / inaccessible paths.
      out[fp] = { filepath: fp, metadata: null };
    }
  }

  for (const [vp, entries] of groups) {
    const rels = entries.map(e => e.relative);
    const rowMap = db.getFilesWithMetadataByPaths(rels, vp, user.username);

    for (const e of entries) {
      const row = rowMap.get(e.relative);
      if (row) {
        const rendered = renderMetadataObj(row);
        rendered.filepath = e.original;
        out[e.original] = rendered;
      } else {
        // Preserve existing parent-vpath fallback behavior.
        out[e.original] = pullMetaData(e.original, user);
      }
    }
  }

  return out;
}

// ── Album augmentation: also find albums BY matching artist ─────────────────
// Searching "Pink Floyd" in the album column only returns albums NAMED "Pink
// Floyd …". We also search the artist column, but grouped at the SQL level
// so LIMIT 50 counts unique ALBUMS rather than individual tracks.
function _augmentAlbumsByArtist(req, albums, posSearch, negativeTerms) {
  const needed = Math.max(0, SEARCH_API_MAX_RESULTS - albums.length);
  if (needed === 0) return;
  const byArtist = db.searchAlbumsByArtist(
    posSearch,
    req.user.vpaths,
    req.body.ignoreVPaths,
    req.body.filepathPrefix || null,
    req.body.excludeFilepathPrefixes,
    negativeTerms,
    _candidateLimit(needed)
  );
  const seenAlbums = new Set(albums.map(a => a.name));
  for (const a of byArtist) {
    if (albums.length >= SEARCH_API_MAX_RESULTS) break;
    if (a.album && !seenAlbums.has(a.album)) {
      seenAlbums.add(a.album);
      albums.push({ name: a.album, album_art_file: a.aaFile || null, album_version: a.album_version || null, filepath: false });
    }
  }
}

// Multi-word smart search: also run a cross-field FTS query so "chaka khan fate"
// finds songs where artist words and title words are spread across separate columns.
function _crossFieldSearch(req, title, positiveTerms, negativeTerms) {
  const needed = Math.max(0, SEARCH_API_MAX_RESULTS - title.length);
  if (needed === 0) return;
  const seenPaths = new Set(title.map(t => t.filepath));
  const crossRows = db.searchFilesAllWords(
    positiveTerms,
    req.user.vpaths,
    req.body.ignoreVPaths,
    req.body.filepathPrefix || null,
    req.body.excludeFilepathPrefixes,
    negativeTerms,
    _candidateLimit(needed)
  );
  for (const row of crossRows) {
    if (title.length >= SEARCH_API_MAX_RESULTS) break;
    const fp = dbFilepath(row.vpath, row.filepath);
    if (!seenPaths.has(fp)) {
      seenPaths.add(fp);
      title.push({ name: `${row.artist} - ${row.title}`, album_art_file: row.aaFile || null, filepath: fp });
    }
  }
}

const SEARCH_API_MAX_RESULTS = 30;
const SEARCH_DB_CANDIDATE_MULTIPLIER = 20;
const SEARCH_DB_CANDIDATE_FLOOR = 200;

function _candidateLimit(maxResults) {
  return Math.max(SEARCH_DB_CANDIDATE_FLOOR, Number(maxResults || 0) * SEARCH_DB_CANDIDATE_MULTIPLIER);
}

function searchByX(req, searchCol, resCol, posSearch, negativeTerms = [], maxResults = SEARCH_API_MAX_RESULTS) {
  if (!resCol) {
    resCol = searchCol;
  }

  const results = db.searchFiles(
    searchCol,
    posSearch,
    req.user.vpaths,
    req.body.ignoreVPaths,
    req.body.filepathPrefix || null,
    req.body.excludeFilepathPrefixes,
    negativeTerms,
    _candidateLimit(maxResults)
  );

  const returnThis = [];
  const store = {};
  for (const row of results) {
    if (!store[row[resCol]]) {
      let name = row[resCol];
      let filepath = false;

      if (searchCol === 'filepath') {
        name = path.join(row.vpath, row[resCol]).replaceAll('\\', '/');
        filepath = path.join(row.vpath, row[resCol]).replaceAll('\\', '/');
      } else if (searchCol === 'title') {
        name = `${row.artist} - ${row.title}`;
        filepath = path.join(row.vpath, row[resCol]).replaceAll('\\', '/');
      }

      returnThis.push({
        name: name,
        album_art_file: row.aaFile ? row.aaFile : null,
        album_version: (searchCol === 'album') ? (row.album_version || null) : null,
        filepath
      });
      store[row[resCol]] = true;
      if (returnThis.length >= maxResults) break;
    }
  }

  return returnThis;
}

// Parse raw search input into positive/negative term lists.
function parseSearchQuery(raw) {
  const parts = raw.trim().split(/\s+/);
  const positiveTerms = [], negativeTerms = [];
  let skipNext = false;
  for (const t of parts) {
    if (skipNext) { skipNext = false; continue; } // eslint-disable-line sonarjs/no-redundant-assignments
    // Skip tokens that contain no alphanumeric characters — the FTS5 unicode61
    // tokenizer strips them to nothing, producing an empty phrase query that
    // causes a 500 (e.g. "&", "-", "–" entered literally).
    if (!/[a-zA-Z0-9]/.test(t)) continue;
    if (t.startsWith('-') && t.length > 1) {
      // -word prefix → explicit negative term (must still contain alnum chars)
      const neg = t.slice(1);
      if (/[a-zA-Z0-9]/.test(neg)) negativeTerms.push(neg);
    } else {
      positiveTerms.push(t);
    }
  }
  return { positiveTerms, negativeTerms };
}




function _extractM4bChaptersOnDemand(filePath) {
  return new Promise(resolve => {
    const probe = ffprobeBin();
    if (!probe) return resolve(null);
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_chapters', filePath];
    execFile(probe, args, { maxBuffer: 2 * 1024 * 1024, timeout: 20000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const chapters = JSON.parse(stdout).chapters;
        if (!Array.isArray(chapters) || chapters.length < 2) return resolve(null);
        resolve(chapters.map((ch, i) => ({
          no: i + 1,
          title: (ch.tags?.title || `Chapter ${i + 1}`).trim(),
          t: Math.round(Number.parseFloat(ch.start_time) * 100) / 100 || 0,
        })).filter(cp => cp.t >= 0));
      } catch { resolve(null); }
    });
  });
}

function _extractSidecarCueSync(filePath) {
  try {
    const dir          = path.dirname(filePath);
    const base         = path.basename(filePath, path.extname(filePath));
    const audioFilename = path.basename(filePath);

    let cuePath;
    try {
      cuePath = resolveChildPath(dir, base + '.cue');
    } catch {
      return null;
    }
    if (!fs.existsSync(cuePath)) {
      let cueFiles;
      try { cueFiles = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.cue')); }
      catch { return null; }
      if (cueFiles.length !== 1) return null;
      try {
        cuePath = resolvePathWithinRoot(dir, cueFiles[0]);
      } catch {
        return null;
      }
    }

    const content = fs.readFileSync(cuePath, 'utf8');
    const fileLines = [...content.matchAll(/^FILE\s+"([^"]+)"/gim)];
    if (fileLines.length !== 1) return null;
    if (path.basename(fileLines[0][1]).toLowerCase() !== audioFilename.toLowerCase()) return null;

    const tracks = [];
    let cur = null;
    for (const line of content.split(/\r?\n/)) {
      const trackM = line.match(/^\s*TRACK\s+(\d+)\s+AUDIO/i);
      if (trackM) { cur = { no: Number.parseInt(trackM[1], 10), title: null }; continue; }
      if (!cur) continue;
      const titleM = line.match(/^\s*TITLE\s+"(.*)"/i);
      if (titleM) { cur.title = titleM[1]; continue; }
      const idxM = line.match(/^\s*INDEX\s+01\s+(\d+):(\d+):(\d+)/i);
      if (idxM) {
        const t = Number.parseInt(idxM[1], 10) * 60 + Number.parseInt(idxM[2], 10) + Number.parseInt(idxM[3], 10) / 75;
        tracks.push({ no: cur.no, title: cur.title, t: Math.round(t * 100) / 100 });
        cur = null;
      }
    }
    return tracks.length > 1 ? tracks : null;
  } catch { return null; }
}

async function _extractCueOnDemand(filePath) {
  // ── Embedded CUESHEET tag ──────────────────────────────────
  try {
    const parsed = await parseFile(filePath, { skipCovers: true, duration: false });
    const cue = parsed.common?.cuesheet;
    const sampleRate = parsed.format?.sampleRate || null;
    if (cue && Array.isArray(cue.tracks) && cue.tracks.length && sampleRate) {
      const pts = [];
      for (const tr of cue.tracks) {
        if (tr.number === 170) continue; // lead-out track
        const idx1 = Array.isArray(tr.indexes) && tr.indexes.find(i => i.number === 1);
        if (!idx1) continue;
        pts.push({ no: tr.number, title: tr.title || null,
          t: Math.round((idx1.offset / sampleRate) * 100) / 100 });
      }
      if (pts.length > 1) return pts;
    }
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }

  // ── Sidecar .cue file ──────────────────────────────────────
  try {
    const dir  = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));

    // Prefer exact-basename match, then sole .cue in directory
    let cuePath;
    try {
      cuePath = resolvePathWithinRoot(dir, base + '.cue');
    } catch {
      return null;
    }
    if (!fs.existsSync(cuePath)) {
      let cueFiles;
      try { cueFiles = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.cue')); }
      catch { return null; }
      if (cueFiles.length !== 1) return null;
      try {
        cuePath = resolvePathWithinRoot(dir, cueFiles[0]);
      } catch {
        return null;
      }
    }

    const content = fs.readFileSync(cuePath, 'utf8');

    // Only handle single-FILE sheets whose FILE line references this audio file
    const fileLines = [...content.matchAll(/^FILE\s+"([^"]+)"/gim)];
    if (fileLines.length !== 1) return null;
    const cueRef = path.basename(fileLines[0][1]);
    if (cueRef.toLowerCase() !== path.basename(filePath).toLowerCase()) return null;

    // Parse TRACK / TITLE / INDEX 01 MM:SS:FF
    const tracks = [];
    let cur = null;
    for (const line of content.split(/\r?\n/)) {
      const trackM = line.match(/^\s*TRACK\s+(\d+)\s+AUDIO/i);
      if (trackM) { cur = { no: Number.parseInt(trackM[1], 10), title: null }; continue; }
      if (!cur) continue;
      const titleM = line.match(/^\s*TITLE\s+"(.*)"/i);
      if (titleM) { cur.title = titleM[1]; continue; }
      const idxM = line.match(/^\s*INDEX\s+01\s+(\d+):(\d+):(\d+)/i);
      if (idxM) {
        const t = Number.parseInt(idxM[1], 10) * 60 + Number.parseInt(idxM[2], 10) + Number.parseInt(idxM[3], 10) / 75;
        tracks.push({ no: cur.no, title: cur.title, t: Math.round(t * 100) / 100 });
        cur = null;
      }
    }
    if (tracks.length > 1) return tracks;
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }

  return null;
}

export function setup(velvet) {
  velvet.get('/api/v1/db/status', (req, res) => {
    const total = db.countFilesByVpaths(req.user.vpaths);

    res.json({
      totalFileCount: total,
      locked: dbQueue.isScanning(),
      vpaths: req.user.vpaths,
      scanningVpaths: dbQueue.getScanningVpaths().filter(s => req.user.vpaths.includes(s.vpath))
    });
  });

  velvet.post('/api/v1/db/metadata', (req, res) => {
    res.json(pullMetaData(req.body.filepath, req.user));
  });

  velvet.post('/api/v1/db/metadata/batch', (req, res) => {
    res.json(pullMetaDataBatch(req.body, req.user));
  });

  // legacy enpoint, moved to POST
  velvet.get('/api/v1/db/artists', (req, res) => {
    res.json({ artists: db.getArtists(req.user.vpaths) });
  });

  velvet.post('/api/v1/db/artists', (req, res) => {
    res.json({ artists: db.getArtists(req.user.vpaths, req.body.ignoreVPaths, req.body.excludeFilepathPrefixes) });
  });

  velvet.post('/api/v1/db/artists-albums', (req, res) => {
    const albums = db.getArtistAlbums(req.body.artist, req.user.vpaths, req.body.ignoreVPaths, req.body.excludeFilepathPrefixes, req.body.includeFilepathPrefixes);
    res.json({ albums });
  });

  velvet.post('/api/v1/db/artists-albums-multi', (req, res) => {
    const schema = Joi.object({
      artists: Joi.array().items(Joi.string()).min(1).required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      excludeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().required(), prefix: Joi.string().required() })).optional(),
      includeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().required(), prefix: Joi.string().required() })).optional(),
    });
    joiValidate(schema, req.body);
    const _childExcl = computeChildExclusions(req.user.vpaths);
    const _excl = [...(req.body.excludeFilepathPrefixes || []), ..._childExcl];
    const albums = db.getArtistAlbumsMulti(req.body.artists, req.user.vpaths, req.body.ignoreVPaths, _excl.length ? _excl : undefined, req.body.includeFilepathPrefixes);
    res.json({ albums });
  });

  // Returns raw song rows for an artist, used by Artists2 "Songs" section.
  // Caller supplies excludeFilepathPrefixes / ignoreVPaths to strip albumsOnly paths.
  velvet.post('/api/v1/db/artist-folder-songs', (req, res) => {
    const schema = Joi.object({
      artists: Joi.array().items(Joi.string()).min(1).required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      excludeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().required(), prefix: Joi.string().required() })).optional(),
    });
    joiValidate(schema, req.body);
    const _childExcl = computeChildExclusions(req.user.vpaths);
    const _excl = [...(req.body.excludeFilepathPrefixes || []), ..._childExcl];
    const rows = db.getArtistFolderSongs(req.body.artists, req.user.vpaths, req.user.username, req.body.ignoreVPaths, _excl.length ? _excl : undefined);
    res.json(rows.map(r => renderMetadataObj(r)));
  });

  velvet.get('/api/v1/db/albums', (req, res) => {
    res.json({ albums: db.getAlbums(req.user.vpaths) });
  });

  velvet.post('/api/v1/db/albums', (req, res) => {
    res.json({ albums: db.getAlbums(req.user.vpaths, req.body.ignoreVPaths, req.body.excludeFilepathPrefixes, req.body.includeFilepathPrefixes) });
  });

  velvet.post('/api/v1/db/album-songs', (req, res) => {
    const _childExcl = computeChildExclusions(req.user.vpaths);
    const _excl = [...(req.body.excludeFilepathPrefixes || []), ..._childExcl];
    const results = db.getAlbumSongs(
      req.body.album ? String(req.body.album) : null,
      req.user.vpaths,
      req.user.username,
      { ignoreVPaths: req.body.ignoreVPaths, artist: req.body.artist, artists: req.body.artists, year: req.body.year, albumDir: req.body.albumDir || null, folderOnly: req.body.folderOnly === true, excludeFilepathPrefixes: _excl.length ? _excl : undefined, includeFilepathPrefixes: req.body.includeFilepathPrefixes }
    );

    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  velvet.post('/api/v1/db/search', (req, res) => {
    const schema = Joi.object({
      search: Joi.string().required(),
      noArtists: Joi.boolean().optional(),
      noAlbums: Joi.boolean().optional(),
      noTitles: Joi.boolean().optional(),
      noFiles: Joi.boolean().optional(),
      noFolders: Joi.boolean().optional(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      filepathPrefix: Joi.string().optional(),
      excludeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().required(), prefix: Joi.string().required() })).optional()
    });
    joiValidate(schema, req.body);

    const { positiveTerms, negativeTerms } = parseSearchQuery(req.body.search);
    if (!positiveTerms.length) { res.json({ artists: [], folders: [], albums: [], files: [], title: [] }); return; }
    const posSearch = positiveTerms.join(' ');

    // ── Artists: use normalized index (groups "01 Ben Liebrand" → "Ben Liebrand")
    const artists = req.body.noArtists === true ? [] : db.searchArtistsNormalized(posSearch, req.user.vpaths, req.body.ignoreVPaths);

    // ── Folders: search folder names via trigram FTS
    const folders = req.body.noFolders === true ? [] :
      db.searchFolders(posSearch, req.user.vpaths, req.body.ignoreVPaths).map(f => ({
        vpath:       f.vpath,
        dirpath:     f.dirpath,
        folder_name: f.folder_name,
        // Full path as expected by viewFiles(): "/vpath/dir/path"
        browse_path: '/' + f.vpath + '/' + f.dirpath,
      }));

    const albums = req.body.noAlbums === true ? [] : searchByX(req, 'album', undefined, posSearch, negativeTerms, SEARCH_API_MAX_RESULTS);
    if (req.body.noAlbums !== true) _augmentAlbumsByArtist(req, albums, posSearch, negativeTerms);

    const files = req.body.noFiles  === true ? [] : searchByX(req, 'filepath', undefined, posSearch, negativeTerms, SEARCH_API_MAX_RESULTS);
    const title = req.body.noTitles === true ? [] : searchByX(req, 'title', 'filepath', posSearch, negativeTerms, SEARCH_API_MAX_RESULTS);
    if (positiveTerms.length > 1) _crossFieldSearch(req, title, positiveTerms, negativeTerms);

    res.json({ artists, folders, albums, files, title });
  });



  // legacy endpoint, moved to POST
  velvet.get('/api/v1/db/rated', (req, res) => {
    const results = db.getRatedSongs(req.user.vpaths, req.user.username);
    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  velvet.post('/api/v1/db/rated', (req, res) => {
    const results = db.getRatedSongs(req.user.vpaths, req.user.username, req.body.ignoreVPaths, req.body.excludeFilepathPrefixes);
    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  velvet.post('/api/v1/db/rate-song', (req, res) => {
    const schema = Joi.object({
      filepath: Joi.string().required(),
      rating: Joi.number().integer().min(0).max(10).allow(null).required()
    });
    joiValidate(schema, req.body);

    if (/^https?:\/\//i.test(req.body.filepath)) { return res.status(400).json({ error: 'Cannot rate external URLs' }); }
    const pathInfo = vpath.getVPathInfo(req.body.filepath);
    const result = resolveFile(pathInfo, req.user);
    if (!result) { throw new Error('File Not Found'); }

    const result2 = db.findUserMetadata(result.hash, req.user.username);
    if (result2) {
      result2.rating = req.body.rating;
      db.updateUserMetadata(result2);
    } else {
      db.insertUserMetadata({
        user: req.user.username,
        hash: result.hash,
        rating: req.body.rating
      });
    }

    res.json({});
    db.saveUserDB();
  });

  velvet.post('/api/v1/db/recent/added', (req, res) => {
    const schema = Joi.object({
      limit: Joi.number().integer().min(1).required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      excludeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().required(), prefix: Joi.string().required() })).optional()
    });
    joiValidate(schema, req.body);

    const results = db.getRecentlyAdded(req.user.vpaths, req.user.username, req.body.limit, req.body.ignoreVPaths, { excludeFilepathPrefixes: req.body.excludeFilepathPrefixes });
    const songs = [];
    for (const row of results) {
      const s = renderMetadataObj(row);
      s.ts = row.ts ?? null; // expose for client-side same-day "new" filtering
      songs.push(s);
    }
    res.json(songs);
  });

  // ── recently added — grouped by day ───────────────────────────────
  // Returns up to maxDays distinct calendar days (most recent first), each with
  // up to maxFolders album-folder objects total. ts in DB is stored in seconds.
  velvet.post('/api/v1/db/recent/added/by-day', (req, res) => {
    const schema = Joi.object({
      maxDays:    Joi.number().integer().min(1).max(30).default(7),
      maxFolders: Joi.number().integer().min(1).max(1000).default(700),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      excludeFilepathPrefixes: Joi.array().items(
        Joi.object({ vpath: Joi.string().required(), prefix: Joi.string().required() })
      ).optional()
    });
    joiValidate(schema, req.body);
    const { maxDays, maxFolders, ignoreVPaths, excludeFilepathPrefixes } = req.body;

    // Fetch enough raw rows to fill maxFolders even with large multi-track albums.
    // getRecentlyAdded returns mapFileRow results (ts included, in seconds).
    const rawRows = db.getRecentlyAdded(
      req.user.vpaths, req.user.username,
      maxFolders * 20,
      ignoreVPaths,
      { excludeFilepathPrefixes }
    );

    // Collapse CD/Disc/Side sub-folders so multi-disc albums appear as one card
    const _songDir = fp => {
      if (!fp) return '';
      const parts = fp.split('/');
      let dir = parts.slice(1, -1).join('/');
      dir = dir.replace(/\/(CD|Disc|Disk|Side)\s*\d+\s*$/i, '');
      return dir;
    };

    // Group songs into folder objects, using max ts as the folder's representative ts
    const folderMap = new Map();
    for (const row of rawRows) {
      const fp = dbFilepath(row.vpath, row.filepath);
      const dir = _songDir(fp);
      const key = dir || fp;
      if (!folderMap.has(key)) {
        const folderName = dir ? (dir.split('/').pop() || dir) : (fp.split('/').pop() || fp);
        folderMap.set(key, { dir, label: folderName, artist: row.artist ?? null, art: row.aaFile ?? null, ts: row.ts ?? 0, _rows: [] });
      }
      const folder = folderMap.get(key);
      if (!folder.art && row.aaFile) folder.art = row.aaFile;
      if (row.ts && row.ts > folder.ts) folder.ts = row.ts;
      folder._rows.push({ ts: row.ts ?? 0, filepath: fp, rendered: renderMetadataObj(row) });
    }

    // For each folder, filter songs to those added on the same calendar day as
    // the folder's newest entry — older songs from the same folder that happen
    // to fall within the result window should NOT be marked as "newly added".
    // Also deduplicate by filepath (on-demand indexer can create duplicate rows).
    for (const folder of folderMap.values()) {
      const d = new Date(folder.ts * 1000);
      const dayStart = Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
      const dayEnd = dayStart + 86400;
      const seen = new Set();
      folder.songs = folder._rows
        .filter(r => r.ts >= dayStart && r.ts < dayEnd)
        .filter(r => { if (seen.has(r.filepath)) { return false; } seen.add(r.filepath); return true; })
        .map(r => r.rendered);
      delete folder._rows;
    }

    // Group folders by local calendar day, respecting maxDays + maxFolders caps
    const dayMap = new Map(); // dateStr (YYYY-MM-DD) → folder[]
    let totalFolders = 0;
    for (const folder of folderMap.values()) {
      if (totalFolders >= maxFolders) break;
      // ts is seconds → multiply to get ms for Date constructor
      const d = new Date((folder.ts ?? 0) * 1000);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!dayMap.has(dateStr)) {
        if (dayMap.size >= maxDays) break;
        dayMap.set(dateStr, []);
      }
      dayMap.get(dateStr).push(folder);
      totalFolders++;
    }

    // Build response — dayLabel format: "Monday (17-05)"
    const _DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const days = [];
    for (const [dateStr, folders] of dayMap) {
      const d = new Date(dateStr + 'T00:00:00');
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      days.push({ date: dateStr, dayLabel: `${_DAY_NAMES[d.getDay()]} (${dd}-${mm})`, folders });
    }
    res.json(days);
  });

  // ── home summary (stats strip + temporal "On This Day" sections) ──
  velvet.get('/api/v1/db/home-summary', (req, res) => {
    const now  = Date.now();
    const d    = new Date(now);
    // UTC midnight of today
    const todayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    // UTC midnight of Monday this week
    const dow = d.getUTCDay();
    const weekStart = todayStart - ((dow === 0 ? 6 : dow - 1)) * 86400000;

    // Yesterday: the full day before today
    const yesterdayStart = todayStart - 86400000;

    // Last week same day: same weekday 7 days ago
    const lastWeekStart  = todayStart - 7 * 86400000;
    const lastWeekEnd    = lastWeekStart + 86400000;

    // Last month same day: same date 1 month ago (handles month-length differences)
    const lmDate         = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, d.getUTCDate()));
    const lastMonthStart = lmDate.getTime();
    const lastMonthEnd   = lastMonthStart + 86400000;

    // Last year same day: same calendar date 1 year ago
    const lastYearStart  = Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate());
    const lastYearEnd    = lastYearStart + 86400000;

    const timeWindows = [
      { key: 'yesterday',        from: yesterdayStart, to: todayStart,    minDays: 1   },
      { key: 'lastWeekSameDay',  from: lastWeekStart,  to: lastWeekEnd,   minDays: 7   },
      { key: 'lastMonthSameDay', from: lastMonthStart, to: lastMonthEnd,  minDays: 30  },
      { key: 'lastYearSameDay',  from: lastYearStart,  to: lastYearEnd,   minDays: 365 },
    ];

    const summary = db.getHomeSummary(req.user.username, req.user.vpaths, todayStart, weekStart, timeWindows);

    // Enrich section songs with renderMetadataObj shape
    summary.sections = summary.sections.map(sec => ({
      key: sec.key,
      songs: sec.songs.map(r => ({
        filepath: path.join(r.vpath, r.filepath).replaceAll('\\', '/'),
        metadata: { title: r.title || null, artist: r.artist || null, album: r.album || null, 'album-art': r.aaFile || null }
      }))
    }));

    res.json(summary);
  });

  // ── log a play (always runs — independent of scrobbling) ────
  velvet.post('/api/v1/db/stats/log-play', async (req, res) => {
    const schema = Joi.object({ filePath: Joi.string().required() });
    joiValidate(schema, req.body);
    if (/^https?:\/\//i.test(req.body.filePath)) { return res.json({ ok: false }); }
    const pathInfo = vpath.getVPathInfo(req.body.filePath, req.user);
    let fileRow  = resolveFile(pathInfo, req.user);
    if (!fileRow) {
      fileRow = await indexFileOnDemand(pathInfo); // NOSONAR — indexFileOnDemand is async
    }
    if (!fileRow) { return res.json({ ok: false }); }
    const existing = db.findUserMetadata(fileRow.hash, req.user.username);
    if (existing) {
      existing.pc = (existing.pc && typeof existing.pc === 'number') ? existing.pc + 1 : 1;
      existing.lp = Date.now();
      db.updateUserMetadata(existing);
    } else {
      db.insertUserMetadata({ user: req.user.username, hash: fileRow.hash, pc: 1, lp: Date.now() });
    }
    db.saveUserDB();
    res.json({ ok: true });
  });

  velvet.post('/api/v1/db/stats/recently-played', (req, res) => {
    const schema = Joi.object({
      limit: Joi.number().integer().min(1).required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      excludeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().required(), prefix: Joi.string().required() })).optional()
    });
    joiValidate(schema, req.body);

    const results = db.getRecentlyPlayed(req.user.vpaths, req.user.username, req.body.limit, req.body.ignoreVPaths, { excludeFilepathPrefixes: req.body.excludeFilepathPrefixes });
    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  velvet.post('/api/v1/db/stats/most-played', (req, res) => {
    const schema = Joi.object({
      limit: Joi.number().integer().min(1).required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      excludeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().required(), prefix: Joi.string().required() })).optional()
    });
    joiValidate(schema, req.body);

    const results = db.getMostPlayed(req.user.vpaths, req.user.username, req.body.limit, req.body.ignoreVPaths, { excludeFilepathPrefixes: req.body.excludeFilepathPrefixes });
    const songs = [];
    for (const row of results) {
      songs.push(renderMetadataObj(row));
    }
    res.json(songs);
  });

  velvet.post('/api/v1/db/songs-by-artists', (req, res) => {
    const schema = Joi.object({
      artists: Joi.array().items(Joi.string()).min(1).max(50).required(),
      limit:   Joi.number().integer().min(1).max(50).default(20),
    });
    joiValidate(schema, req.body);
    const { artists, limit } = req.body;
    const _childExcl = computeChildExclusions(req.user.vpaths);
    const results = db.getAllFilesWithMetadata(req.user.vpaths, req.user.username, { artists, excludeFilepathPrefixes: _childExcl.length ? _childExcl : undefined });
    if (!results.length) return res.json([]);
    // Fisher-Yates shuffle
    for (let i = results.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1)); // NOSONAR: non-security random music shuffle
      const t = results[i]; results[i] = results[j]; results[j] = t;
    }
    // Cap at 2 songs per artist so no single artist dominates the shelf
    const artistCount = {};
    const deduped = [];
    for (const row of results) {
      const key = (row.artist || '').toLowerCase();
      artistCount[key] = (artistCount[key] || 0) + 1;
      if (artistCount[key] <= 2) deduped.push(row);
      if (deduped.length >= limit) break;
    }
    res.json(deduped.map(renderMetadataObj));
  });

  velvet.post('/api/v1/db/stats/reset-play-counts', (req, res) => {
    db.resetPlayCounts(req.user.username);
    db.saveUserDB();
    res.json({ success: true });
  });

  velvet.post('/api/v1/db/stats/reset-recently-played', (req, res) => {
    db.resetRecentlyPlayed(req.user.username);
    db.saveUserDB();
    res.json({ success: true });
  });

  velvet.post('/api/v1/db/unplayed-gems', (req, res) => {
    const { error, value } = Joi.object({
      ignoreVPaths: Joi.array().items(Joi.string()),
      limit:        Joi.number().integer().min(1).max(500).default(100),
    }).validate(req.body ?? {});
    if (error) return res.status(400).json({ error: error.message });

    try {
      const vpaths = req.user.vpaths;
      const songs  = db.getUnplayedGems(req.user.username, vpaths, value.ignoreVPaths, value.limit);
      const count  = db.countUnplayedGems(req.user.username, vpaths, value.ignoreVPaths);
      res.json({ songs: songs.map(s => renderMetadataObj(s)), count });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  velvet.post('/api/v1/db/random-songs', (req, res) => {
    const ignoreList = (req.body.ignoreList && Array.isArray(req.body.ignoreList)) ? req.body.ignoreList : [];
    let ignorePercentage = .5;
    if (req.body.ignorePercentage && typeof req.body.ignorePercentage === 'number' && req.body.ignorePercentage < 1 && !req.body.ignorePercentage < 0) {
      ignorePercentage = req.body.ignorePercentage;
    }

    const hasArtistFilter = Array.isArray(req.body.artists) && req.body.artists.length > 0;
    const bp = _parseBpmParams(req.body);

    // ── Genre filter: resolve display names → raw DB genre strings ──────────
    if (Array.isArray(req.body.genres) && req.body.genres.length > 0) {
      const { rawMap } = mergeGenreRows(db.getGenres(req.user.vpaths, req.body.ignoreVPaths));
      const rawStrings = [];
      for (const displayName of req.body.genres) {
        let rawSet = rawMap.get(displayName);
        if (!rawSet) {
          for (const [k, v] of rawMap) {
            if (k.toLowerCase() === displayName.toLowerCase()) { rawSet = v; break; }
          }
        }
        if (rawSet) for (const s of rawSet) rawStrings.push(s);
      }
      req.body._genreRawStrings = [...new Set(rawStrings)];
      req.body._genreMode = req.body.genreMode === 'blacklist' ? 'blacklist' : 'whitelist';
    }

    // ── Lean path: no artist filter → COUNT + single-row OFFSET fetch ──────
    // Avoids loading all 100k+ rows into heap just to pick one.
    if (!hasArtistFilter) {
      const leanResult = _leanRandomPick(db, req.user, req.body, bp, ignoreList, ignorePercentage);
      if (leanResult !== null) return res.json(leanResult);
      // null → fall through to full-load path (Loki or truly empty library)
    }

    // ── Full-load path: artist filter active, or Loki backend ────────────────
    let finalResults = db.getAllFilesWithMetadata(req.user.vpaths, req.user.username, {
      ignoreVPaths: req.body.ignoreVPaths,
      minRating: req.body.minRating,
      filepathPrefix: req.body.filepathPrefix || null,
      artists: hasArtistFilter ? req.body.artists : undefined,
      ignoreArtists: Array.isArray(req.body.ignoreArtists) ? req.body.ignoreArtists : undefined,
      excludeFilepathPrefixes: req.body.excludeFilepathPrefixes,
      genreRawStrings: req.body._genreRawStrings,
      genreMode: req.body._genreMode,
      ...bp.bpmOpts,
    });

    finalResults = _fullLoadFallbackChain(db, req.user, req.body, bp, hasArtistFilter, finalResults);
    finalResults = _qualityTierFilter(finalResults, bp);

    const count = finalResults.length;
    if (count === 0) { throw new WebError('No songs that match criteria', 400); }
    while (ignoreList.length > count * ignorePercentage) ignoreList.shift();

    const { song, idx } = _selectRandom(finalResults, ignoreList, hasArtistFilter);
    ignoreList.push(idx);
    res.json({ songs: [renderMetadataObj(song)], ignoreList });
  });


  velvet.post('/api/v1/playlist/load', (req, res) => {
    const playlist = String(req.body.playlistname);
    const returnThis = [];

    const results = db.loadPlaylistEntries(req.user.username, playlist);
    const lookup = pullMetaDataBatch(results.map(r => r.filepath), req.user);

    for (const row of results) {
      const meta = lookup[row.filepath] || { metadata: null };
      returnThis.push({ id: row.id, filepath: row.filepath, metadata: meta.metadata || {} });
    }

    res.json(returnThis);
  });

  // Returns embedded cue sheet track markers for a single file (used by the player seek bar)
  velvet.get('/api/v1/db/cuepoints', async (req, res) => {
    try {
      const pathInfo = vpath.getVPathInfo(req.query.fp, req.user);
      const row = db.findFileByPath(pathInfo.relativePath, pathInfo.vpath);

      // ── On-demand extraction for files whose cuepoints column is still NULL ──
      // (sentinel '[]' means already checked — don't retry embedded tag)
      if (row?.cuepoints === null) {
        // 1. M4B: extract chapters via ffprobe
        if (/\.m4b$/i.test(pathInfo.fullPath)) {
          const chapters = await _extractM4bChaptersOnDemand(pathInfo.fullPath);
          if (chapters && chapters.length >= 2) {
            db.updateFileCue(pathInfo.relativePath, pathInfo.vpath, JSON.stringify(chapters));
            return res.json({ cuepoints: chapters });
          }
        }
        // 2. All other files: try embedded CUESHEET tag then sidecar .cue file
        const cuepoints = await _extractCueOnDemand(pathInfo.fullPath);
        // Store result (real data or '[]' sentinel) so we don't re-run on every play
        db.updateFileCue(pathInfo.relativePath, pathInfo.vpath,
          cuepoints ? JSON.stringify(cuepoints) : '[]');
        if (cuepoints) return res.json({ cuepoints });
      }

      // ── Re-check sidecar .cue when sentinel '[]' is present ──────────────────
      // The sentinel blocks re-parsing the audio file, but the user may have
      // added or fixed a sidecar .cue file since the last scan. Sidecar check
      // is cheap (file existence + small read) so safe to do on every play.
      // Embedded CUE sheets are NOT re-checked here — they are baked into the
      // audio file and won't change without the file modtime changing (which
      // triggers a full re-parse at scan time).
      if (row?.cuepoints === '[]') {
        const sidecar = _extractSidecarCueSync(pathInfo.fullPath);
        if (sidecar) {
          db.updateFileCue(pathInfo.relativePath, pathInfo.vpath, JSON.stringify(sidecar));
          return res.json({ cuepoints: sidecar });
        }
      }

      res.json({ cuepoints: row?.cuepoints && row.cuepoints !== '[]' ? JSON.parse(row.cuepoints) : [] });
    } catch {
      res.json({ cuepoints: [] });
    }
  });


// Sidecar-only CUE check (synchronous, no music-metadata parsing).
// Used to bypass the '[]' sentinel for the sidecar case — the user may have
// added or fixed a .cue file without the audio file changing.
// Returns [{no, title, t}] (≥2 entries) or null.

// On-demand CUE extraction for non-M4B files:
// 1. Tries the embedded CUESHEET tag via music-metadata
// 2. Falls back to a sidecar .cue file in the same directory
// Returns [{no, title, t}] (≥2 entries) or null.


  // ── GENRE BROWSING ────────────────────────────────────────────
  velvet.get('/api/v1/db/genres', (req, res) => {
    const { genres } = mergeGenreRows(db.getGenres(req.user.vpaths));
    res.json({ genres });
  });

  velvet.post('/api/v1/db/genres', (req, res) => {
    const { genres } = mergeGenreRows(db.getGenres(req.user.vpaths, req.body.ignoreVPaths));
    res.json({ genres });
  });

  // ── GENRE GROUPS (custom display groupings configured by admin) ───────────
  velvet.get('/api/v1/db/genre-groups', (req, res) => {
    try {
      const savedGroups = db.getGenreGroups();
      const { genres: merged, rawMap } = mergeGenreRows(db.getGenres(req.user.vpaths));
      const cntMap = new Map(merged.map(g => [g.genre, g.cnt]));
      if (!savedGroups || savedGroups.length === 0) {
        return res.json({ groups: null, genres: merged });
      }
      // Build reverse map: raw DB string → merged display name (handles legacy raw strings in DB)
      const rawToDisplay = new Map();
      for (const [display, rawSet] of rawMap) for (const raw of rawSet) rawToDisplay.set(raw, display);
      const resolveGenre = g => {
        if (cntMap.has(g)) return g;
        const d = rawToDisplay.get(g);
        return (d && cntMap.has(d)) ? d : null;
      };
      const assignedGenres = new Set();
      const groups = savedGroups.map(grp => ({
        name: grp.name,
        genres: [...new Set(grp.genres.map(resolveGenre).filter(Boolean))]
          .map(g => ({ genre: g, cnt: cntMap.get(g) }))
          .filter(g => g.cnt > 0),
      })).filter(grp => grp.genres.length > 0);
      for (const grp of groups) for (const g of grp.genres) assignedGenres.add(g.genre);
      const otherGenres = merged.filter(g => !assignedGenres.has(g.genre));
      if (otherGenres.length > 0) {
        const existingOther = groups.find(g => g.name.toLowerCase() === 'other');
        if (existingOther) { existingOther.genres.push(...otherGenres); }
        else { groups.push({ name: 'Other', genres: otherGenres }); }
      }
      res.json({ groups, genres: merged });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  velvet.post('/api/v1/db/genre/songs', (req, res) => {
    const schema = Joi.object({
      genre: Joi.string().required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);
    // Re-derive the rawMap so we know which DB genre strings belong to this
    // merged display genre (handles "House, Trance, Chillout" multi-values).
    const { rawMap } = mergeGenreRows(db.getGenres(req.user.vpaths, req.body.ignoreVPaths));
    // Exact lookup first; case-insensitive fallback in case capitalisation drifts.
    let rawSet = rawMap.get(req.body.genre);
    if (!rawSet) {
      const needle = req.body.genre.toLowerCase();
      for (const [k, v] of rawMap) {
        if (k.toLowerCase() === needle) { rawSet = v; break; }
      }
    }
    if (!rawSet || rawSet.size === 0) return res.json([]);
    const results = db.getSongsByGenreRaw(rawSet, req.user.vpaths, req.user.username, req.body.ignoreVPaths);
    res.json(results.map(renderMetadataObj));
  });

  // ── DECADE BROWSING ───────────────────────────────────────────
  velvet.get('/api/v1/db/decades', (req, res) => {
    res.json({ decades: db.getDecades(req.user.vpaths) });
  });

  velvet.post('/api/v1/db/decades', (req, res) => {
    res.json({ decades: db.getDecades(req.user.vpaths, req.body.ignoreVPaths) });
  });

  velvet.post('/api/v1/db/decade/albums', (req, res) => {
    const schema = Joi.object({
      decade: Joi.number().integer().required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      excludeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().required(), prefix: Joi.string().required() })).optional()
    });
    joiValidate(schema, req.body);
    const albums = db.getAlbumsByDecade(Number(req.body.decade), req.user.vpaths, req.body.ignoreVPaths, req.body.excludeFilepathPrefixes);
    res.json({ albums });
  });

  velvet.post('/api/v1/db/decade/songs', (req, res) => {
    const schema = Joi.object({
      decade: Joi.number().integer().required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional()
    });
    joiValidate(schema, req.body);
    const songs = db.getSongsByDecade(Number(req.body.decade), req.user.vpaths, req.user.username, req.body.ignoreVPaths);
    res.json(songs.map(renderMetadataObj));
  });

  velvet.post('/api/v1/db/genre/albums', (req, res) => {
    const schema = Joi.object({
      genre: Joi.string().required(),
      ignoreVPaths: Joi.array().items(Joi.string()).optional(),
      excludeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().required(), prefix: Joi.string().required() })).optional()
    });
    joiValidate(schema, req.body);
    const { rawMap } = mergeGenreRows(db.getGenres(req.user.vpaths, req.body.ignoreVPaths));
    let rawSet = rawMap.get(req.body.genre);
    if (!rawSet) {
      const needle = req.body.genre.toLowerCase();
      for (const [k, v] of rawMap) {
        if (k.toLowerCase() === needle) { rawSet = v; break; }
      }
    }
    if (!rawSet || rawSet.size === 0) return res.json({ albums: [] });
    const albums = db.getAlbumsByGenre(rawSet, req.user.vpaths, req.body.ignoreVPaths, req.body.excludeFilepathPrefixes);
    res.json({ albums });
  });

  // GET /api/v1/db/similar?hash=<hash>&limit=<n>
  // Returns a list of songs similar to the given track hash, scored by BPM
  // proximity and musical key compatibility (Camelot wheel).
  // Requires: hash (content hash), optional limit (default 50, max 200).
  velvet.get('/api/v1/db/similar', (req, res) => {
    const hash = req.query.hash;
    if (!hash || typeof hash !== 'string' || !/^[a-f0-9]{32}$/i.test(hash)) {
      return res.status(400).json({ error: 'hash is required (32-char hex MD5)' });
    }
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit) || 50));
    try {
      const songs = db.getSimilarSongs(hash, limit);
      // Filter to user's accessible vpaths
      const filtered = songs.filter(s => req.user.vpaths.includes(s.vpath));
      res.json(filtered.map(s => renderMetadataObj(s)));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/v1/db/audio-features/:hash
  // Returns the audio_features row for the given track hash (BPM, key, MFCC vectors).
  velvet.get('/api/v1/db/audio-features/:hash', (req, res) => {
    const hash = req.params.hash;
    if (!hash || !/^[a-f0-9]{32}$/i.test(hash)) {
      return res.status(400).json({ error: 'Invalid hash' });
    }
    const features = db.getAudioFeatures(hash);
    if (!features) return res.status(404).json({ error: 'Not found' });
    res.json(features);
  });

  // ── Playback parse-error reporting ───────────────────────────────────────────
  // The player calls this when a file can't be decoded (MEDIA_ERR_DECODE /
  // MEDIA_ERR_SRC_NOT_SUPPORTED) so admins can find it in the Scan Error Workshop
  // and let ffmpeg remux it.  Available to all authenticated users (not admin-only).
  velvet.post('/api/v1/db/scan-errors/report-playback', (req, res) => {
    try {
      const schema = Joi.object({
        filepath: Joi.string().max(1024).required(),
        errorMsg: Joi.string().max(512).optional().allow(''),
      });
      joiValidate(schema, req.body);
      const { filepath, errorMsg } = req.body;
      // filepath includes vpath prefix: "Music/12 inches A-Z/Artist/track.flac"
      const slashIdx = filepath.indexOf('/');
      if (slashIdx < 1) return res.status(400).json({ error: 'Invalid filepath' });
      const vpathName = filepath.slice(0, slashIdx);
      const rel       = filepath.slice(slashIdx + 1);
      if (!rel) return res.status(400).json({ error: 'Invalid filepath' });
      if (!req.user.vpaths.includes(vpathName)) return res.status(403).json({ error: 'Access denied' });
      const guid = crypto.createHash('md5').update(`${rel}|parse`).digest('hex'); // NOSONAR: MD5 used as collision-free error-dedup key, not for security
      db.insertScanError(guid, rel, vpathName, 'parse', errorMsg || '', 'reported by player');
      res.json({ ok: true, guid });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });
  // ─────────────────────────────────────────────────────────────────────────────
}

// ── random-songs helpers ───────────────────────────────────────────────────────

/**
 * Parse BPM/key params from request body into option bundles used throughout
 * the lean-path and full-load fallback chains.
 */
function _parseBpmParams(body) {
  // bpmRanges: [{min, max}, ...] — supports octave equivalence (normal + half + double tempo)
  const rawRanges = Array.isArray(body.bpmRanges) && body.bpmRanges.length > 0
    ? body.bpmRanges.filter(r => r?.min != null && r?.max != null).map(r => ({ min: Number(r.min), max: Number(r.max) }))
    : undefined;
  // bpmRangesWide: client-sent expanded ranges (±(tol+2)) — used after all tight-range steps fail
  const rawWide = Array.isArray(body.bpmRangesWide) && body.bpmRangesWide.length > 0
    ? body.bpmRangesWide.filter(r => r?.min != null && r?.max != null).map(r => ({ min: Number(r.min), max: Number(r.max) }))
    : undefined;

  const requireBpm  = rawRanges ? undefined : (body.requireBpm || undefined);
  const _bpmMinVal  = body.bpmMin == null ? undefined : Number(body.bpmMin);
  const bpmMin      = rawRanges ? undefined : _bpmMinVal;
  const _bpmMaxVal  = body.bpmMax == null ? undefined : Number(body.bpmMax);
  const bpmMax      = rawRanges ? undefined : _bpmMaxVal;
  const bpmOpts = {
    bpmRanges:         rawRanges,
    requireBpm,
    bpmMin,
    bpmMax,
    requireMusicalKey: body.requireMusicalKey || undefined,
    musicalKeys:       Array.isArray(body.musicalKeys) && body.musicalKeys.length > 0 ? body.musicalKeys : undefined,
  };
  const bpmOnlyOpts   = { bpmRanges: bpmOpts.bpmRanges, requireBpm: bpmOpts.requireBpm, bpmMin: bpmOpts.bpmMin, bpmMax: bpmOpts.bpmMax };
  const bpmWideOpts   = rawWide ? { bpmRanges: rawWide, requireMusicalKey: bpmOpts.requireMusicalKey, musicalKeys: bpmOpts.musicalKeys } : null;
  const bpmWideOnly   = rawWide ? { bpmRanges: rawWide } : null;

  return {
    bpmOpts,
    bpmOnlyOpts,
    bpmWideOpts,
    bpmWideOnly,
    hasBpm:     bpmOpts.bpmRanges?.length > 0 || bpmOpts.requireBpm !== undefined || bpmOpts.bpmMin !== undefined,
    hasKey:     bpmOpts.requireMusicalKey !== undefined || bpmOpts.musicalKeys !== undefined,
    hasWide:    !!rawWide,
  };
}

/**
 * Try to pick a random song using the COUNT + OFFSET lean path.
 */
// Pick a song from the primary options, respecting the ignore list.
// Returns { songs, ignoreList } on success, null if count is 0.
function _leanPrimaryPick(db, user, primaryOpts, ignoreList, ignorePercentage) {
  const count = db.countFilesForRandom(user.vpaths, user.username, primaryOpts);
  if (count <= 0) return null;
  while (ignoreList.length > count * ignorePercentage) ignoreList.shift();
  const ignoredSet = new Set(ignoreList);
  if (count - ignoredSet.size <= 0) { ignoreList.length = 0; ignoredSet.clear(); }
  let attempts = 0, offset;
  do { offset = Math.floor(Math.random() * count); attempts++; } while (ignoredSet.has(offset) && attempts < count); // NOSONAR: non-security random music selection
  const row = db.pickFileAtOffset(user.vpaths, user.username, primaryOpts, offset);
  if (!row) throw new WebError('No songs that match criteria', 400);
  ignoreList.push(offset);
  return { songs: [renderMetadataObj(row)], ignoreList };
}

// Try each fallback entry in order and return the first result.
function _leanFallbackPick(db, user, fallbacks) {
  for (const [condition, opts] of fallbacks) {
    if (!condition) continue;
    const count = db.countFilesForRandom(user.vpaths, user.username, opts);
    if (count > 0) {
      const offset = Math.floor(Math.random() * count); // NOSONAR: non-security random music selection
      const row = db.pickFileAtOffset(user.vpaths, user.username, opts, offset);
      if (!row) throw new WebError('No songs that match criteria', 400);
      return { songs: [renderMetadataObj(row)], ignoreList: [offset] };
    }
  }
  return null;
}

/**
 * Runs the BPM/key fallback chain in order. Returns the response payload
 * `{ songs, ignoreList }` on success, or `null` if all counts returned 0
 * (Loki backend or empty library — caller should fall through to full-load).
 */
function _leanRandomPick(db, user, body, bp, ignoreList, ignorePercentage) {
  const base = { ignoreVPaths: body.ignoreVPaths, minRating: body.minRating, filepathPrefix: body.filepathPrefix || null, excludeFilepathPrefixes: body.excludeFilepathPrefixes, genreRawStrings: body._genreRawStrings, genreMode: body._genreMode };
  const ignoreArtists = Array.isArray(body.ignoreArtists) ? body.ignoreArtists : undefined;
  // baseNg: same as base but without genre constraint — used as last BPM resort
  // when the genre filter blocks all in-BPM-range songs. A correctly-BPM-tagged
  // song outside the configured genre is always better than a free pick (tier-3).
  const hasGenre = base.genreRawStrings?.length > 0;
  const baseNg = { ignoreVPaths: base.ignoreVPaths, minRating: base.minRating, filepathPrefix: base.filepathPrefix, excludeFilepathPrefixes: base.excludeFilepathPrefixes };

  // Primary: full BPM + Key constraints + ignoreArtists
  const primaryOpts = { ...base, ignoreArtists, ...bp.bpmOpts };
  const primary = _leanPrimaryPick(db, user, primaryOpts, ignoreList, ignorePercentage);
  if (primary) return primary;

  // Fallback sequence — each entry: [condition, opts]
  const fallbacks = [
    // ignoreArtists eliminated all candidates → retry without it (keep BPM+Key)
    [ignoreArtists?.length > 0,    { ...base, ...bp.bpmOpts }],
    // BPM+Key both active → keep BPM, drop key
    [bp.hasBpm && bp.hasKey,       { ...base, ignoreArtists, ...bp.bpmOnlyOpts }],
    // Expand BPM by ±2 — wide + Key
    [bp.hasWide && bp.hasKey,      { ...base, ignoreArtists, ...bp.bpmWideOpts }],
    // Expand BPM by ±2 — wide only (key dropped)
    [bp.hasWide,                   { ...base, ignoreArtists, ...bp.bpmWideOnly }],
    // Genre-relaxed BPM steps: when the genre filter blocks all BPM-matching songs
    // (e.g. songs at 118 BPM are tagged "Techno" but DJ genre is set to "Electronic"),
    // a correctly-BPM-tagged song from any genre is always better than a free pick.
    // Try with ignoreArtists first, then without.
    [bp.hasBpm && hasGenre,        { ...baseNg, ignoreArtists, ...bp.bpmOpts }],
    [bp.hasBpm && hasGenre,        { ...baseNg, ...bp.bpmOpts }],
    // NOTE: No "drop all BPM" step here — when BPM ranges are specified and all
    // genre-relaxed BPM steps also fail, the lean path returns null. The full-load
    // path is then tried; if that also finds nothing, the server throws 400 and
    // the client's tier-3 free pick takes over.
  ];
  return _leanFallbackPick(db, user, fallbacks);
}

// Similar-artist fallback steps (2–3b): progressively relax BPM/key constraints
// while keeping the artist filter active.
function _similarArtistFallbacks(query, bp, artists, ignoreArtists, r) {
  // Step 2: similar + BPM only
  if (!r.length && bp.hasBpm && bp.hasKey)
    r = query({ artists, ignoreArtists, ...bp.bpmOnlyOpts });
  // Step 2b: similar + BPM wide + Key
  if (!r.length && bp.hasWide && bp.hasKey)
    r = query({ artists, ignoreArtists, ...bp.bpmWideOpts });
  // Step 2c: similar + BPM wide only
  if (!r.length && bp.hasWide)
    r = query({ artists, ignoreArtists, ...bp.bpmWideOnly });
  // Step 3: similar only — Tier 0/1 guard
  if (!r.length && (bp.hasBpm || bp.hasKey)) {
    const step3 = query({ artists, ignoreArtists });
    if (_hasGoodBpmTier(step3, bp)) r = step3;
  }
  // Step 3b: similar (drop artist-cooldown) — same guard
  if (!r.length && ignoreArtists?.length > 0) {
    const step3b = query({ artists });
    if (_hasGoodBpmTier(step3b, bp)) r = step3b;
  }
  return r;
}

// No-similar fallback steps (4–5c): drop artist filter, then expand BPM/key.
function _noSimilarFallbacks(query, bp, ignoreArtists, hasArtistFilter, r) {
  // Step 4: no similar + BPM + Key
  if (!r.length && hasArtistFilter && (bp.hasBpm || bp.hasKey))
    r = query({ ignoreArtists, ...bp.bpmOpts });
  // Step 5: no similar + BPM only
  if (!r.length && bp.hasBpm && bp.hasKey)
    r = query({ ...bp.bpmOnlyOpts });
  // Step 5b: no similar + BPM wide + Key
  if (!r.length && bp.hasWide && bp.hasKey)
    r = query({ ignoreArtists, ...bp.bpmWideOpts });
  // Step 5c: no similar + BPM wide only
  if (!r.length && bp.hasWide)
    r = query({ ignoreArtists, ...bp.bpmWideOnly });
  // Step 6 intentionally removed: when BPM/key constraints are active and all
  // BPM-constrained steps fail, return empty so the server throws 400. The
  // client's tier-3 fallback (_djBpmFallbackCall(true)) is the correct place
  // for a truly unconstrained pick — keeping it here caused untagged or out-of-
  // range songs to bypass BPM continuity (their BPM was only known post-play).
  return r;
}

/**
 * Full-load fallback chain (steps 2–6).
 * Progressively relaxes artist / BPM / key constraints until results are found.
 *
 * Priority order:
 *   1. similar + BPM + Key            (caller's initial `results`)
 *   2. similar + BPM only             (drop harmonic/key)
 *   2b. similar + BPM wide + Key
 *   2c. similar + BPM wide only
 *   3. similar only                   (Tier 0/1 guard: skip if all songs are known-wrong BPM)
 *   3b. similar (drop artist-cooldown)
 *   4. no similar + BPM + Key
 *   5. no similar + BPM only
 *   5b. no similar + BPM wide + Key
 *   5c. no similar + BPM wide only
 *   (Step 6 "truly random" removed — server returns 400 when BPM constraints are
 *    active and exhausted; client tier-3 handles the unconstrained free pick)
 */
function _fullLoadFallbackChain(db, user, body, bp, hasArtistFilter, initial) {
  const base = { ignoreVPaths: body.ignoreVPaths, minRating: body.minRating, filepathPrefix: body.filepathPrefix || null, excludeFilepathPrefixes: body.excludeFilepathPrefixes, genreRawStrings: body._genreRawStrings, genreMode: body._genreMode };
  const ignoreArtists = Array.isArray(body.ignoreArtists) ? body.ignoreArtists : undefined;
  const artists = body.artists;
  const query = (extra) => db.getAllFilesWithMetadata(user.vpaths, user.username, { ...base, ...extra });

  let r = initial;
  if (hasArtistFilter) r = _similarArtistFallbacks(query, bp, artists, ignoreArtists, r);
  r = _noSimilarFallbacks(query, bp, ignoreArtists, hasArtistFilter, r);
  return r;
}

/**
 * Returns null if no filter applies, true if in-range/known-good, false if known-wrong.
 * Used by both _hasGoodBpmTier and _qualityTierFilter.
 */
function _calcBpmOk(song, bpmRanges) {
  if (!bpmRanges?.length) return null;
  if (song.bpm == null) return null;
  return bpmRanges.some(r => song.bpm >= r.min && song.bpm <= r.max);
}

function _calcKeyOk(song, keySet) {
  if (!keySet) return null;
  if (song.musical_key == null) return null;
  return keySet.has(song.musical_key);
}

/**
 * Returns true if `arr` contains at least one Tier 0 (in-range) or Tier 1
 * (unknown BPM/key) song — i.e. NOT all songs are known-wrong.
 * Used by the full-load chain to avoid stranding on Tier-2-only similar-artist sets.
 */
function _hasGoodBpmTier(arr, bp) {
  if (!arr.length) return false;
  if (!bp.hasBpm && !bp.hasKey) return true; // no filter → all Tier 0
  const bpmRanges = bp.bpmOpts.bpmRanges;
  const keySet    = bp.bpmOpts.musicalKeys ? new Set(bp.bpmOpts.musicalKeys) : null;
  return arr.some(song => {
    const bpmOk = _calcBpmOk(song, bpmRanges);
    const keyOk = _calcKeyOk(song, keySet);
    if (bpmOk === true && keyOk !== false) return true;  // Tier 0
    if (bpmOk !== false && keyOk === true) return true;  // Tier 0
    if (bpmOk !== false && keyOk !== false) return true; // Tier 1
    return false; // Tier 2
  });
}

/**
 * Filter `results` to the best available quality tier:
 *   Tier 0 — BPM/key known-good
 *   Tier 1 — BPM/key unknown (may be correct)
 *   Tier 2 — BPM/key known-wrong (last resort)
 * Returns the input array unchanged when no BPM/key constraints are active.
 */
function _classifySongTier(song, bpmRanges, keySet) {
  const bpmOk = _calcBpmOk(song, bpmRanges);
  const keyOk = _calcKeyOk(song, keySet);
  if (bpmOk === true  && keyOk !== false) return 'inRange'; // Tier 0
  if (bpmOk !== false && keyOk === true)  return 'inRange'; // Tier 0
  if (bpmOk !== false && keyOk !== false) return 'noTag';   // Tier 1
  return 'wrongTag'; // Tier 2
}

function _qualityTierFilter(results, bp) {
  if (!bp.hasBpm && !bp.hasKey) return results;
  const bpmRanges = bp.bpmOpts.bpmRanges;
  const keySet    = bp.bpmOpts.musicalKeys ? new Set(bp.bpmOpts.musicalKeys) : null;
  const inRange = [], noTag = [], wrongTag = [];
  for (const song of results) {
    const bucket = _classifySongTier(song, bpmRanges, keySet);
    if (bucket === 'inRange') inRange.push(song);
    else if (bucket === 'noTag') noTag.push(song);
    else wrongTag.push(song);
  }
  let preferred;
  if (inRange.length > 0)  preferred = inRange;
  else if (noTag.length > 0) preferred = noTag;
  else preferred = wrongTag;
  return preferred.length > 0 ? preferred : results;
}

/**
 * Pick one random song from `finalResults`, respecting the ignore list.
 * Uses artist-fair selection (pick artist first, then song) when `hasArtistFilter`.
 * Returns `{ song, idx }`.
 */
function _selectRandom(finalResults, ignoreList, hasArtistFilter) {
  const count = finalResults.length;
  if (hasArtistFilter) {
    // Collect available (non-ignored) indices; if all ignored, reset
    const available = [];
    for (let i = 0; i < count; i++) { if (!ignoreList.includes(i)) available.push(i); }
    const pickFrom = available.length > 0 ? available : Array.from({ length: count }, (_, i) => i);
    // Group by artist for fair selection
    const byArtist = new Map();
    for (const idx of pickFrom) {
      const a = (finalResults[idx].artist || '').trim().toLowerCase();
      if (!byArtist.has(a)) byArtist.set(a, []);
      byArtist.get(a).push(idx);
    }
    const artistKeys = [...byArtist.keys()];
    const chosen = artistKeys[Math.floor(Math.random() * artistKeys.length)]; // NOSONAR: non-security random music selection
    const indices = byArtist.get(chosen);
    const idx = indices[Math.floor(Math.random() * indices.length)]; // NOSONAR: non-security random music selection
    return { song: finalResults[idx], idx };
  }
  // Standard: pick random non-ignored index
  let idx = Math.floor(Math.random() * count); // NOSONAR: non-security random music selection
  while (ignoreList.indexOf(idx) > -1) { idx = Math.floor(Math.random() * count); } // NOSONAR: non-security random music selection
  return { song: finalResults[idx], idx };
}
