/**
 * Subsonic REST API — 1.16.1 + Open Subsonic extensions
 *
 * All endpoints live under /rest/{action}(.view)?
 * Auth: both ?p=plaintext and ?t=md5token&s=salt are supported.
 * Response format: JSON (f=json) or XML (default).
 *
 * Open Subsonic extras included in every response:
 *   openSubsonic: true, type: "velvet", serverVersion: <pkg version>
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import winston from 'winston';
import sharp from 'sharp';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import * as scrobblerApi from './scrobbler.js';
import { ffmpegBin, ensureFfmpeg } from '../util/ffmpeg-bootstrap.js';
import { resolveChildPath, resolvePathWithinRoot } from '../util/path-security.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

const API_VERSION = '1.16.1';
const SERVER_TYPE = 'velvet';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Authenticate a Subsonic request.
 * Returns the username string on success, or null on failure.
 */
function _constantTimeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still run the comparison to avoid length-based timing leak
    timingSafeEqual(ba, Buffer.alloc(ba.length));
    return false;
  }
  return timingSafeEqual(ba, bb);
}

function authenticate(req) {
  const u = req.query.u || req.body?.u;
  if (!u) return null;

  const userObj = config.program.users[u];
  // In no-auth mode (no users configured) we accept any username with any password
  if (Object.keys(config.program.users).length === 0) {
    return u || 'velvet-user';
  }
  if (!userObj) return null;

  const storedPw = userObj['subsonic-password'];
  if (!storedPw) return null;

  // ?t=md5(password+nonce) &s=nonce
  const t = req.query.t || req.body?.t;
  const s = req.query.s || req.body?.s;
  if (t && s) {
    const expected = createHash('md5').update(storedPw + s).digest('hex'); // NOSONAR: Subsonic token authentication requires MD5 per protocol spec
    return _constantTimeEqual(expected, t) ? u : null;
  }

  // ?p=plaintext  or  ?p=enc:hex
  const p = req.query.p || req.body?.p;
  if (p) {
    let plain = p;
    if (plain.startsWith('enc:')) {
      plain = Buffer.from(plain.slice(4), 'hex').toString('utf8');
    }
    return _constantTimeEqual(plain, storedPw) ? u : null;
  }

  return null;
}

/** Build the common response wrapper */
function makeResponse(status = 'ok', extra = {}) {
  return {
    'subsonic-response': {
      xmlns: 'http://subsonic.org/restapi', // NOSONAR: XML namespace URI, not a transport URL
      status,
      version: API_VERSION,
      type: SERVER_TYPE,
      serverVersion: packageJson.version,
      openSubsonic: true,
      ...extra
    }
  };
}

function makeError(code, message) {
  return makeResponse('failed', { error: { code, message } });
}

const ERRORS = {
  GENERIC:       { code: 0,  message: 'A generic error.' },
  MISSING_PARAM: { code: 10, message: 'Required parameter is missing.' },
  BAD_VERSION:   { code: 20, message: 'Incompatible Subsonic REST protocol version. Client must upgrade.' },
  AUTH:          { code: 40, message: 'Wrong username or password.' },
  UNAUTH:        { code: 50, message: 'User is not authorized for the given operation.' },
  NOT_FOUND:     { code: 70, message: 'The requested data was not found.' },
};

/** Send response in XML or JSON based on ?f= query param */
function sendResponse(req, res, payload) {
  const fmt = (req.query.f || req.body?.f || 'xml').toLowerCase();
  if (fmt === 'json' || fmt === 'jsonp') {
    const wrapper = payload['subsonic-response'];
    const out = { 'subsonic-response': wrapper };
    if (fmt === 'jsonp') {
      const cb = req.query.callback || 'callback';
      res.type('application/javascript');
      return res.send(`${cb}(${JSON.stringify(out)})`);
    }
    return res.json(out);
  }
  // XML
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(toXml(payload));
}

/** Minimal JSON→XML serialiser */
function toXml(obj, tag = null, indent = '') {
  if (tag === null) {
    // root call — iterate top-level key
    const rootKey = Object.keys(obj)[0];
    const val = obj[rootKey];
    return `<?xml version="1.0" encoding="UTF-8"?>\n${toXml(val, rootKey, '')}`;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => toXml(item, tag, indent)).join('\n');
  }
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') {
    return `${indent}<${tag}>${xmlEscape(String(obj))}</${tag}>`;
  }

  const attrs = [];
  const children = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      children.push({ k, v });
    } else if (typeof v === 'object') {
      children.push({ k, v });
    } else {
      attrs.push(`${k}="${xmlEscape(String(v))}"`);
    }
  }

  const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
  if (children.length === 0) {
    return `${indent}<${tag}${attrStr}/>`;
  }
  const inner = children.map(({ k, v }) => toXml(v, k, indent + '  ')).join('\n');
  return `${indent}<${tag}${attrStr}>\n${inner}\n${indent}</${tag}>`;
}

function xmlEscape(s) {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** Return the vpaths a user is allowed to access */
function getUserVpaths(username) {
  if (Object.keys(config.program.users).length === 0) {
    return Object.keys(config.program.folders);
  }
  return config.program.users[username]?.vpaths ?? [];
}

/**
 * Encode a directory identity as an opaque ID for use in getMusicDirectory.
 * Format: "d:" + base64url(JSON.stringify({v: dbVpath, p: dirRelPath}))
 * dirRelPath has NO trailing slash.
 */
function makeDirId(dbVpath, dirRelPath) {
  return 'd:' + Buffer.from(JSON.stringify({ v: dbVpath, p: dirRelPath })).toString('base64url');
}

function parseDirId(id) {
  if (!id || !String(id).startsWith('d:')) return null;
  try {
    return JSON.parse(Buffer.from(String(id).slice(2), 'base64url').toString('utf8'));
  } catch { return null; }
}

/**
 * Build vpath metadata: detect child vpaths (sub-folders of another vpath).
 * Returns { [vpath]: { parentVpath, filepathPrefix } } where parentVpath/filepathPrefix
 * are non-null only when this vpath's root is inside another vpath's root.
 */
function getVpathMeta(username) {
  const allFolders = config.program.folders;
  const userVpaths = getUserVpaths(username);
  const meta = {};
  for (const vp of userVpaths) {
    if (!allFolders[vp]) { meta[vp] = { parentVpath: null, filepathPrefix: null }; continue; }
    const myRoot = allFolders[vp].root.replace(/\/?$/, '/');
    const parentVpath = userVpaths.find(other =>
      other !== vp &&
      allFolders[other] &&
      allFolders[other].root.replace(/\/?$/, '/') !== myRoot &&
      myRoot.startsWith(allFolders[other].root.replace(/\/?$/, '/'))
    );
    meta[vp] = {
      parentVpath: parentVpath || null,
      filepathPrefix: parentVpath
        ? myRoot.slice(allFolders[parentVpath].root.replace(/\/?$/, '/').length)
        : null
    };
  }
  return meta;
}

/**
 * Resolve the effective vpath list for a request.
 * If ?musicFolderId=N is present (1-based index into subsonicVpaths),
 * restrict to that single folder — this is how Subsonic clients filter
 * by music folder. Falls back to all allowed vpaths when absent/invalid.
 * Child vpaths (sub-folders) are resolved to their DB parent vpath.
 */
function resolveVpaths(req) {
  const rawId = req.query.musicFolderId ?? req.body?.musicFolderId;
  const meta = req.subsonicVpathMeta || {};
  let targetVpaths = req.subsonicVpaths;
  if (rawId !== undefined && rawId !== null && rawId !== '') {
    const id = Number.parseInt(rawId, 10);
    if (!Number.isNaN(id) && id >= 1 && id <= req.subsonicVpaths.length) {
      targetVpaths = [req.subsonicVpaths[id - 1]];
    }
  }
  // Resolve child vpaths to their DB parent so DB queries find actual rows
  const dbVpaths = new Set();
  for (const vp of targetVpaths) {
    dbVpaths.add(meta[vp]?.parentVpath || vp);
  }
  return [...dbVpaths];
}

/**
 * Return the filepath prefix for the selected musicFolderId, or null if
 * the folder is not a child vpath or no folder was selected.
 */
function resolvePrefix(req) {
  const rawId = req.query.musicFolderId ?? req.body?.musicFolderId;
  if (rawId === undefined || rawId === null || rawId === '') return null;
  const id = Number.parseInt(rawId, 10);
  if (Number.isNaN(id) || id < 1 || id > req.subsonicVpaths.length) return null;
  const vp = req.subsonicVpaths[id - 1];
  return req.subsonicVpathMeta?.[vp]?.filepathPrefix ?? null;
}

/**
 * When a ROOT vpath is selected, return filepath-prefix exclusions for ALL
 * its child vpaths. This prevents duplicate songs appearing in both the root
 * folder AND a child folder when a Subsonic client iterates all musicFolderIds.
 * Child vpaths have their own prefix filter and need no exclusions.
 */
function resolveExcludePrefixes(req) {
  const rawId = req.query.musicFolderId ?? req.body?.musicFolderId;
  if (rawId === undefined || rawId === null || rawId === '') return null;
  const id = Number.parseInt(rawId, 10);
  if (Number.isNaN(id) || id < 1 || id > req.subsonicVpaths.length) return null;
  const vp = req.subsonicVpaths[id - 1];
  const meta = req.subsonicVpathMeta || {};
  // Child vpath — already filtered by its own prefix, no additional exclusions
  if (meta[vp]?.parentVpath) return null;
  // Root vpath — exclude all direct child vpath filepath prefixes
  const excl = Object.entries(meta)
    .filter(([, m]) => m.parentVpath === vp && m.filepathPrefix)
    .map(([, m]) => ({ vpath: vp, prefix: m.filepathPrefix }));
  return excl.length > 0 ? excl : null;
}

// ── Song/Album/Artist object builders ────────────────────────────────────────

function isoOrNull(epochSec) {
  if (!epochSec) return null;
  return new Date(epochSec * 1000).toISOString().replaceAll('.000Z', 'Z');
}

// Format-based bitRate estimates (kbps) for uncompressed / lossless / lossy
const FORMAT_BITRATE = {
  wav: 1411, aiff: 1411, aif: 1411,
  flac: 800, ape: 700, wv: 700,
  mp3: 320, ogg: 192, opus: 192,
  aac: 256, m4a: 256, wma: 192, mpc: 192,
};

// Parse the cuepoints JSON column from a DB row (returns [] if absent/invalid).
function _parseCuepoints(row) {
  if (!row?.cuepoints) return [];
  try {
    const pts = typeof row.cuepoints === 'string' ? JSON.parse(row.cuepoints) : row.cuepoints;
    return Array.isArray(pts) ? pts : [];
  } catch { return []; }
}

// ── Subsonic song id encoding / resolution ───────────────────────────────────
// A song id is normally the file's content hash (files.hash = MD5 of the first
// 512 KB). That hash is NOT unique: duplicate files in different folders — and a
// legacy empty-read sentinel — share one hash, so a bare hash could resolve to the
// wrong physical file (wrong/foreign track, repeats, off-by-one during playback).
// To make playback exact we append the file's rowid when (and only when) the hash
// is shared:
//   "<hash>"                    unique hash (unchanged — keeps client caches valid)
//   "<hash>@<rowid>"            shared hash → exact file
//   "cue:<hash>[@<rowid>]:<idx>"  CUE virtual track
// decodeSongId understands the new and the legacy bare-hash forms, so older clients
// and previously-saved play queues keep resolving.
function decodeSongId(rawId) {
  let s = String(rawId ?? '').replace(/-preview-\d+$/, '');
  let cue = false;
  let cueIdx = null;
  if (s.startsWith('cue:')) {
    cue = true;
    const parts = s.split(':');          // ['cue', '<hash>[@<rowid>]', '<idx>']
    s = parts[1] || '';
    cueIdx = Number.parseInt(parts[2], 10);
  }
  let hash = s;
  let rowid = null;
  const at = s.indexOf('@');
  if (at !== -1) {
    hash = s.slice(0, at);
    const r = Number.parseInt(s.slice(at + 1), 10);
    rowid = Number.isInteger(r) ? r : null;
  }
  return { hash, rowid, cue, cueIdx };
}

// Resolve a raw song id to the exact file row. Prefers the rowid (exact file) and
// verifies its content hash still matches; falls back to deterministic hash lookup
// (covers legacy bare-hash ids and rows rescanned to a new rowid). For CUE ids this
// returns the underlying base file row.
function resolveSongRow(rawId, username) {
  const { hash, rowid } = decodeSongId(rawId);
  if (rowid != null) {
    const r = db.getSongByRowid(rowid, username);
    if (r && r.hash === hash) return r;
  }
  return hash ? db.getSongByHash(hash, username) : null;
}

// Batch resolver — Map<rawId, row>. Two batched queries (by rowid, by hash), then
// picks the exact-rowid row when present.
function resolveSongRows(rawIds, username) {
  const out = new Map();
  const decoded = rawIds.map(raw => ({ raw, ...decodeSongId(raw) }));
  const rowids = decoded.filter(d => d.rowid != null).map(d => d.rowid);
  const hashes = decoded.map(d => d.hash).filter(Boolean);
  const byRowid = rowids.length ? db.getSongsByRowids(rowids, username) : new Map();
  const byHash  = db.getSongsByHashes(hashes, username);
  for (const d of decoded) {
    let row = null;
    if (d.rowid != null) {
      const r = byRowid.get(d.rowid);
      if (r && r.hash === d.hash) row = r;
    }
    if (!row && d.hash) row = byHash.get(d.hash) || null;
    if (row) out.set(d.raw, row);
  }
  return out;
}

// Build the disambiguated Subsonic id for a file row. Bare hash when the hash is
// unique (keeps existing client/queue caches valid); "<hash>@<rowid>" when shared.
// Requires the row to carry `id` (the rowid alias every song query selects).
function encodeSongId(row) {
  const h = row?.hash;
  if (!h) return h;
  return (row.id != null && db.isDuplicatedHash(h)) ? `${h}@${row.id}` : h;
}

// Build a virtual Subsonic song entry for one CUE-sheet track.
// ID format: "cue:<baseHash>:<index>" — parsed in getSong / handleStream.
// The stream handler always transcodes the slice to FLAC (lossless re-mux with
// fresh STREAMINFO so the per-track duration sticks), so we advertise FLAC as
// the suffix/contentType regardless of the source file's container.
function buildCueSong(cp, nextCp, baseRow, index) {
  const base = buildSong(baseRow);
  const endDur = baseRow.duration ? Math.max(0, baseRow.duration - cp.t) : null;
  const durSec = nextCp == null ? endDur : Math.max(0, nextCp.t - cp.t);
  return {
    ...base,
    id:          `cue:${encodeSongId(baseRow)}:${index}`,
    title:       cp.title || `Track ${index + 1}`,
    track:       cp.no || (index + 1),
    suffix:      'flac',
    contentType: 'audio/flac',
    bitRate:     FORMAT_BITRATE.flac,
    ...(durSec == null ? {} : { duration: Math.round(durSec) }),
  };
}

// Expand a list of DB file rows for a directory listing.
// Files with ≥2 cuepoints are expanded into virtual CUE tracks (id: "cue:<hash>:<i>").
// Files without CUE data are returned as regular song entries.
function _expandDirFiles(files, parentId) {
  const out = [];
  for (const f of files) {
    const cps = _parseCuepoints(f);
    if (cps.length >= 2) {
      for (let i = 0; i < cps.length; i++) {
        out.push({ ...buildCueSong(cps[i], cps[i + 1] ?? null, f, i), isDir: false, parent: parentId });
      }
    } else {
      out.push({ ...buildSong(f), isDir: false, parent: parentId });
    }
  }
  return out;
}

function buildSong(row, _vpaths) {
  // contentType heuristic from format
  const fmt = (row.format || 'mp3').toLowerCase();
  const mimeMap = {
    mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
    opus: 'audio/opus', aac: 'audio/aac', m4a: 'audio/mp4',
    wav: 'audio/wav', wma: 'audio/x-ms-wma', aiff: 'audio/aiff',
    aif: 'audio/aiff', ape: 'audio/ape', wv: 'audio/x-wavpack',
    mpc: 'audio/musepack'
  };
  const contentType = mimeMap[fmt] || 'audio/mpeg';

  // Estimate bitRate from format average — avoids slow fs.statSync on network mounts
  const bitRate = FORMAT_BITRATE[fmt] || 128;

  // created: use file mtime stored in DB (milliseconds since epoch)
  const created = row.modified ? new Date(row.modified).toISOString() : null;

  // Normalise artist/album: treat whitespace-only as null so IDs don't orphan
  const artist      = row.artist?.trim()       || null;
  const albumArtist = row.album_artist?.trim() || null;
  const album       = row.album?.trim()        || null;
  const artistId    = artist ? (row.artist_id  || null) : null;
  const albumId     = album  ? (row.album_id   || null) : null;

  const song = {
    id: encodeSongId(row),
    parent: albumId || artistId || 'root',
    isDir: false,
    title: row.title || path.basename(row.filepath || '', path.extname(row.filepath || '')),
    contentType,
    suffix: fmt,
    bitRate,
    path: path.join(row.vpath, row.filepath).replaceAll('\\', '/'),
    isVideo: false,
    playCount: row.playCount || row.pc || 0,
    type: 'music',
    mediaType: 'song',
    ...(album ? { album } : {}),
    ...(artist ? { artist } : {}),
    ...(albumArtist && albumArtist !== artist ? { albumArtist } : {}),
    ...(albumId ? { albumId } : {}),
    ...(artistId ? { artistId } : {}),
    ...(row.track ? { track: row.track } : {}),
    ...(row.year ? { year: row.year } : {}),
    ...(row.genre ? { genre: row.genre } : {}),
    ...(row.aaFile ? { coverArt: row.aaFile } : {}),
    ...(row.duration ? { duration: Math.round(row.duration) } : {}),
    ...(created ? { created } : {}),
  };

  if (row.starred) {
    song.starred = isoOrNull(typeof row.starred === 'number' && row.starred === 1
      ? Math.floor(Date.now() / 1000) : row.starred) || new Date().toISOString().replaceAll('.000Z', 'Z');
  }
  if (row.lastPlayed || row.lp) {
    song.played = isoOrNull(row.lastPlayed || row.lp);
  }
  if (row.replaygainTrackDb != null || row['replaygain-track-db'] != null) {
    const rgVal = row.replaygainTrackDb ?? row['replaygain-track-db'];
    song.replayGain = { trackGain: rgVal };
  }
  if (row.rating) {
    song.userRating = Math.min(5, Math.round(row.rating / 2));
  }
  if (row.disk) song.discNumber = row.disk;

  return song;
}

function buildAlbum(albumRow, songs) {
  const songCount = songs ? songs.length : (albumRow.songCount || 0);
  const duration = songs
    ? songs.reduce((s, r) => s + (r.duration || 0), 0)
    : (albumRow.totalDuration ?? null);
  // Album name = the album's folder (what the user curates / sees in the web
  // ALBUMS view). Falls back to the album tag for tag-based/root albums.
  const albumName = db.albumFolderName(albumRow.album_id) || albumRow.album?.trim() || '(Unknown)';
  const artist    = (albumRow.album_artist || albumRow.artist)?.trim() || null;
  const album = {
    id: albumRow.album_id,
    name: albumName,
    songCount,
    // duration is REQUIRED by OpenSubsonic AlbumID3 spec — always send (default 0)
    duration: duration == null ? 0 : Math.round(duration),
    // created is REQUIRED by OpenSubsonic AlbumID3 spec — use ts from DB or now()
    created: isoOrNull(albumRow.ts) || new Date().toISOString().replaceAll('.000Z', 'Z'),
    ...(artist ? { artist } : {}),
    ...(artist && albumRow.artist_id ? { artistId: albumRow.artist_id } : {}),
    ...(albumRow.aaFile ? { coverArt: albumRow.aaFile } : {}),
    ...(albumRow.year ? { year: albumRow.year } : {}),
  };
  if (songs) {
    album.song = songs.map(s => buildSong(s));
  }
  return album;
}

// Serve a simple SVG folder icon for directory entries that have no art.
function serveFolderIcon(res) {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="512" height="512">',
    '<path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0',
    ' 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" fill="#5C6BC0"/>',
    '<path d="M12 10v3.5c-.3-.2-.6-.3-1-.3-1.1 0-2 .9-2 2s.9 2 2 2 2-.9',
    ' 2-2v-4h2v-1.2L12 10z" fill="white" opacity="0.85"/>',
    '</svg>',
  ].join('');
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
}

function buildArtist(artistRow, albums) {
  // Prefer ar-<artist_id> so getCoverArt serves the dedicated artist portrait;
  // fall back to aaFile (album cover) if no artist_id is available.
  const coverArtProp = artistRow.aaFile ? { coverArt: artistRow.aaFile } : {};
  const artist = {
    id: artistRow.artist_id,
    name: artistRow.artist?.trim() || '(Unknown)',
    albumCount: albums ? albums.length : (artistRow.albumCount || 0),
    ...(artistRow.artist_id ? { coverArt: 'ar-' + artistRow.artist_id } : coverArtProp),
  };
  if (albums) {
    artist.album = albums.map(a => buildAlbum(a, null));
  }
  return artist;
}

// ── Middleware: parse auth + attach user to req ──────────────────────────────

function subsonicAuth(req, res, next) {
  const username = authenticate(req);
  if (!username) {
    return sendResponse(req, res, makeError(ERRORS.AUTH.code, ERRORS.AUTH.message));
  }
  req.subsonicUser = username;
  req.subsonicVpaths = getUserVpaths(username);
  req.subsonicVpathMeta = getVpathMeta(username);
  next();
}

// ── Module-scope helpers (used by setup) ──────────────────────────────────────

/**
 * Resolve effective vpaths + filepathPrefix for album-list queries.
 *
 * NOTE: the albumsOnly scoping is intentionally DISABLED for the Subsonic API.
 * getMusicFolders exposes ALL of the user's folders, so restricting the global
 * album list to only albumsOnly folders produced an inconsistent client UX
 * (Nautilus etc. show every folder but display content for only some of them).
 * The album list now spans all of the user's folders, honouring musicFolderId
 * when the client selects a specific folder.
 *
 * (Album *grouping* inside albumsOnly folders is still folder-based — that lives
 * in the DB layer's album_id computation, not here, and does not hide content.)
 */
function resolveAlbumListScope(req) {
  return { vp: resolveVpaths(req), pfxValue: resolvePrefix(req) };
}

// Sanitise AI-generated playlist names (e.g. AudioMuse-AI "Path: Foo_instant" → "Foo")
function sanitizePlaylistName(raw) {
  let n = String(raw).trim();
  n = n.replace(/^path:\s*/i, '');
  n = n.replace(/_(instant|queue|session)$/i, '');
  n = n.replaceAll(/\s{2,}/g, ' ').trim();
  if (n.length > 120) n = n.slice(0, 120).replace(/\s+\S*$/, '').trim();
  return n || raw;
}

// Build artist-image URL for getArtistInfo; null when no image is registered.
function _buildArtistInfoImageUrl(req, artistId) {
  if (!artistId) return null;
  const imageFile = db.getArtistImageByArtistId(String(artistId));
  if (!imageFile) return null;
  const base = req.protocol + '://' + req.get('host');
  return base + '/rest/getCoverArt?id=ar-' + String(artistId) + '&v=1.16.1&c=velvet';
}

// Map an Velvet radio station row to a Subsonic internetRadioStation element.
function _buildRadioStation(s) {
  const obj = {
    id:        String(s.id),
    name:      s.name,
    streamUrl: s.link_a || '',
  };
  if (s.link_b) obj.homePageUrl = s.link_b;
  if (s.img && !s.img.startsWith('http')) obj.coverArt = s.img;
  return obj;
}

// ── Route handler factory ────────────────────────────────────────────────────

// In-memory now-playing store: key = username, value = { id, playerId, playerName, startedAt }
const nowPlayingStore = new Map();

// Hot-path cover-art ID lookups are repeatedly requested by Subsonic clients.
// Keep short-lived in-memory caches to avoid redundant DB lookups.
const COVER_ID_CACHE_TTL_MS = 5 * 60 * 1000;
const COVER_ID_CACHE_MAX = 20000;
const _aaFileByIdCache = new Map();      // id -> aaFile|null
const _artistImageCache = new Map();     // artistId -> imageFile|null
const _folderArtCache = new Map();       // user+folder id -> aaFile|null

export function setup(velvet) {
  // ── Debug request logger ────────────────────────────────────────────────────
  // Logs every incoming Subsonic request to the Velvet log files.
  // Password param is scrubbed. Disable by removing/commenting this block.
  velvet.use('/rest', (req, _res, next) => {
    const q = { ...req.query };
    if (q.p) q.p = '[scrubbed]';
    const action = req.path.replace(/^\//, '').replace(/\.view$/, '');
    const qs = Object.entries(q).map(([k, v]) => `${k}=${v}`).join(' ');
    let msg = `[SUBSONIC] ${req.method} ${action}`;
    if (qs) msg += ` | ${qs}`;
    if (req.method === 'POST' && req.body && Object.keys(req.body).length) {
      const b = { ...req.body };
      if (b.p) b.p = '[scrubbed]';
      msg += ` | body:${JSON.stringify(b)}`;
    }
    winston.info(msg);
    next();
  });

  // Subsonic endpoints accept both GET and POST
  // Pattern: /rest/<action>  and  /rest/<action>.view
  const router = (action, handler) => {
    velvet.all(`/rest/${action}`,      subsonicAuth, handler);
    velvet.all(`/rest/${action}.view`, subsonicAuth, handler);
  };

  // ── ping ────────────────────────────────────────────────────────────────────
  router('ping', (req, res) => {
    sendResponse(req, res, makeResponse());
  });

  // ── getLicense ──────────────────────────────────────────────────────────────
  const LICENSE_QUIPS = [
    'Fully licensed. Our lawyers are on vacation.',
    'Valid forever. We bribed the calendar.',
    'Licensed until the heat death of the universe (or 2099, whichever comes first).',
    'License: valid. Coffee supply: critically low.',
    'Genuine Velvet™ — not a Napster clone. Probably.',
    'License confirmed. No DRM was harmed in the making of this response.',
    'Your music, your server, your rules. Also: valid.',
    'Open source. The license IS the source.',
    'Licensed under the "it just works" clause.',
    'Valid. The accountants are asleep — play something loud.',
  ];
  router('getLicense', (req, res) => {
    const quip = LICENSE_QUIPS[Math.floor(Math.random() * LICENSE_QUIPS.length)]; // NOSONAR: non-security random selection
    sendResponse(req, res, makeResponse('ok', {
      license: { valid: true, email: quip, licenseExpires: '2099-12-31T00:00:00' }
    }));
  });

  // ── getMusicFolders ─────────────────────────────────────────────────────────
  router('getMusicFolders', (req, res) => {
    const folders = req.subsonicVpaths.map((vp, i) => ({ id: i + 1, name: vp }));
    sendResponse(req, res, makeResponse('ok', {
      musicFolders: { musicFolder: folders }
    }));
  });

  // ── getIndexes ──────────────────────────────────────────────────────────────
  // For folder-browsing clients (e.g. Substreamer Folders tab):
  //   - No musicFolderId → return vpaths as top-level entries (id = 1..N integer)
  //   - musicFolderId=N  → return first-level FS dirs of that vpath, A-Z indexed
  router('getIndexes', (req, res) => {
    const rawFolderId = req.query.musicFolderId ?? req.body?.musicFolderId;
    const buckets = {};

    if (!rawFolderId && rawFolderId !== 0) {
      // No folder selected → list vpaths so user sees "Music, 12-inches, Disco…"
      req.subsonicVpaths.forEach((vp, i) => {
        const letter = vp.charAt(0).toUpperCase();
        const key = /[A-Z]/.test(letter) ? letter : '#';
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push({ id: String(i + 1), name: vp });
      });
    } else {
      // Folder selected → return first-level FS dirs of that vpath
      const folderId = Number.parseInt(rawFolderId, 10);
      if (!Number.isNaN(folderId) && folderId >= 1 && folderId <= req.subsonicVpaths.length) {
        const selectedVpath = req.subsonicVpaths[folderId - 1];
        const vpMeta = req.subsonicVpathMeta?.[selectedVpath] ?? {};
        const dbVpath = vpMeta.parentVpath || selectedVpath;
        const dirRelPath = (vpMeta.filepathPrefix || '').replace(/\/$/, '');

        const { dirs } = db.getDirectoryContents(dbVpath, dirRelPath, req.subsonicUser);
        for (const d of dirs) {
          const letter = d.name.charAt(0).toUpperCase();
          const key = /[A-Z]/.test(letter) ? letter : '#';
          if (!buckets[key]) buckets[key] = [];
          buckets[key].push({
            id: makeDirId(dbVpath, dirRelPath ? dirRelPath + '/' + d.name : d.name),
            name: d.name,
            ...(d.aaFile ? { coverArt: d.aaFile } : {}),
          });
        }
      }
    }

    const index = Object.keys(buckets).sort((a, b) => a.localeCompare(b)).map(k => ({
      name: k,
      artist: buckets[k]
    }));
    const lastModifiedMs = db.getLastScannedMs() || Date.now();
    const ifModifiedSince = Number.parseInt(req.query.ifModifiedSince ?? req.body?.ifModifiedSince ?? '0', 10);
    if (ifModifiedSince > 0 && lastModifiedMs <= ifModifiedSince) {
      return sendResponse(req, res, makeResponse('ok', {
        indexes: { index: [], lastModified: lastModifiedMs, ignoredArticles: 'The El La Los Las Le Les' }
      }));
    }
    sendResponse(req, res, makeResponse('ok', {
      indexes: { index, lastModified: lastModifiedMs, ignoredArticles: 'The El La Los Las Le Les' }
    }));
  });

  // ── getArtists ──────────────────────────────────────────────────────────────
  router('getArtists', (req, res) => {
    const artists = db.getAllArtistIds(resolveVpaths(req), { filepathPrefix: resolvePrefix(req) });
    const buckets = {};
    for (const a of artists) {
      const letter = (a.artist || '#').charAt(0).toUpperCase();
      const key = /[A-Z]/.test(letter) ? letter : '#';
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push({
        id: a.artist_id, name: a.artist, albumCount: a.albumCount,
        ...(a.artist_id ? { coverArt: 'ar-' + a.artist_id } : {}),
      });
    }
    const index = Object.keys(buckets).sort((a, b) => a.localeCompare(b)).map(k => ({
      name: k,
      artist: buckets[k]
    }));
    sendResponse(req, res, makeResponse('ok', {
      artists: { index, ignoredArticles: 'The El La Los Las Le Les' }
    }));
  });

  // ── getArtist ───────────────────────────────────────────────────────────────
  router('getArtist', (req, res) => {
    const id = req.query.id || req.body?.id;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));

    const albums = db.getAlbumsByArtistId(id, req.subsonicVpaths);
    if (!albums || albums.length === 0) {
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }
    const artistRow = {
      artist_id: id,
      artist: albums[0].artist,
      aaFile: albums[0].aaFile,
      albumCount: albums.length
    };
    const artistObj = buildArtist(artistRow, albums);
    sendResponse(req, res, makeResponse('ok', { artist: artistObj }));
  });

  // ── getAlbum ────────────────────────────────────────────────────────────────
  router('getAlbum', (req, res) => {
    const id = req.query.id || req.body?.id;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));

    const songs = db.getFilesByAlbumId(id, req.subsonicVpaths, req.subsonicUser);
    if (!songs || songs.length === 0) {
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }
    const first = songs[0];
    const albumRow = {
      album_id:     id,
      album:        first.album,
      artist:       first.artist,
      album_artist: first.album_artist,
      artist_id:    first.artist_id,
      aaFile:       first.aaFile,
      year:         first.year,
      songCount:    songs.length
    };

    // CUE-sheet expansion: each physical file with ≥2 cuepoints becomes virtual tracks.
    // Works for single-disc (1 FLAC + CUE) and multi-disc flat-folder albums
    // (2+ FLACs each with their own CUE) alike.
    const expandedSongs = [];
    let hasCue = false;
    for (const song of songs) {
      const cps = _parseCuepoints(song);
      if (cps.length >= 2) {
        hasCue = true;
        for (let i = 0; i < cps.length; i++) {
          expandedSongs.push(buildCueSong(cps[i], cps[i + 1] ?? null, song, i));
        }
      } else {
        expandedSongs.push(buildSong(song));
      }
    }
    if (hasCue) {
      albumRow.songCount    = expandedSongs.length;
      albumRow.totalDuration = Math.round(songs.reduce((s, r) => s + (r.duration || 0), 0));
      const albumObj = buildAlbum(albumRow, null);
      albumObj.song      = expandedSongs;
      albumObj.songCount = expandedSongs.length;
      return sendResponse(req, res, makeResponse('ok', { album: albumObj }));
    }

    const albumObj = buildAlbum(albumRow, songs);
    sendResponse(req, res, makeResponse('ok', { album: albumObj }));
  });

  // ── getSong ─────────────────────────────────────────────────────────────────
  router('getSong', (req, res) => {
    const id = req.query.id || req.body?.id;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));

    // CUE virtual track: "cue:<hash>[@<rowid>]:<index>"
    if (String(id).startsWith('cue:')) {
      const idx      = decodeSongId(id).cueIdx;
      const baseRow  = resolveSongRow(id, req.subsonicUser);
      if (!baseRow || !req.subsonicVpaths.includes(baseRow.vpath)) {
        return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
      }
      const cps = _parseCuepoints(baseRow);
      if (!Number.isNaN(idx) && idx >= 0 && idx < cps.length) {
        return sendResponse(req, res, makeResponse('ok', {
          song: buildCueSong(cps[idx], cps[idx + 1] ?? null, baseRow, idx)
        }));
      }
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }

    const row = resolveSongRow(id, req.subsonicUser);
    if (!row || !req.subsonicVpaths.includes(row.vpath)) {
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }
    sendResponse(req, res, makeResponse('ok', { song: buildSong(row) }));
  });

  // ── getMusicDirectory ─────────────────────────────────────────────────────────
  // Browses the actual folder hierarchy stored in the DB.
  // IDs:
  //   Integer 1..N  → root of vpath N (from getMusicFolders)
  //   "d:..."       → encoded sub-directory (makeDirId)
  //   other string  → treated as album_id for backward-compat with some clients
  router('getMusicDirectory', (req, res) => {
    const id = req.query.id || req.body?.id;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));

    const vpathIndex = Number.parseInt(id, 10);

    // ── case 1: vpath root ────────────────────────────────────────────────────
    if (!Number.isNaN(vpathIndex) && vpathIndex >= 1 && vpathIndex <= req.subsonicVpaths.length) {
      const selectedVpath = req.subsonicVpaths[vpathIndex - 1];
      const vpMeta = req.subsonicVpathMeta?.[selectedVpath] ?? {};
      const dbVpath = vpMeta.parentVpath || selectedVpath;
      // dirRelPath for this vpath root: strip trailing slash from filepathPrefix
      const dirRelPath = vpMeta.filepathPrefix ? vpMeta.filepathPrefix.replace(/\/$/, '') : '';

      const { dirs, files } = db.getDirectoryContents(dbVpath, dirRelPath, req.subsonicUser);
      const children = [
        ...dirs.map(d => ({
          id: makeDirId(dbVpath, dirRelPath ? dirRelPath + '/' + d.name : d.name),
          parent: id, isDir: true, title: d.name,
          ...(d.aaFile ? { coverArt: d.aaFile } : {}),
        })),
        ..._expandDirFiles(files, id),
      ];
      return sendResponse(req, res, makeResponse('ok', {
        directory: { id, name: selectedVpath, child: children }
      }));
    }

    // ── case 2: encoded sub-directory ─────────────────────────────────────────
    const parsed = parseDirId(id);
    if (parsed) {
      const { v: dbVpath, p: dirRelPath } = parsed;
      // Security: verify the user has access to this dbVpath
      const hasAccess = req.subsonicVpaths.some(vp => {
        const m = req.subsonicVpathMeta?.[vp] ?? {};
        return (m.parentVpath || vp) === dbVpath;
      });
      if (!hasAccess) {
        return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
      }

      const { dirs, files } = db.getDirectoryContents(dbVpath, dirRelPath, req.subsonicUser);
      const displayName = dirRelPath.includes('/') ? dirRelPath.slice(dirRelPath.lastIndexOf('/') + 1) : dirRelPath;

      // Compute parent ID
      let parentId;
      if (dirRelPath.includes('/')) {
        parentId = makeDirId(dbVpath, dirRelPath.slice(0, dirRelPath.lastIndexOf('/')));
      } else {
        // Parent is the vpath root — find its index
        const vpIdx = req.subsonicVpaths.findIndex(vp => {
          const m = req.subsonicVpathMeta?.[vp] ?? {};
          const vpRoot = (m.filepathPrefix || '').replace(/\/$/, '');
          return (m.parentVpath || vp) === dbVpath && (vpRoot === dirRelPath || (!vpRoot && !dirRelPath));
        });
        parentId = vpIdx >= 0 ? String(vpIdx + 1) : null;
      }

      const children = [
        ...dirs.map(d => ({
          id: makeDirId(dbVpath, dirRelPath + '/' + d.name),
          parent: id, isDir: true, title: d.name,
          ...(d.aaFile ? { coverArt: d.aaFile } : {}),
        })),
        ..._expandDirFiles(files, id),
      ];
      return sendResponse(req, res, makeResponse('ok', {
        directory: { id, parent: parentId, name: displayName, child: children }
      }));
    }

    // ── case 3: album_id (legacy / other clients) ─────────────────────────────
    const songs = db.getFilesByAlbumId(id, req.subsonicVpaths, req.subsonicUser);
    if (!songs || songs.length === 0) {
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }
    const children = _expandDirFiles(songs, id);
    const first = songs[0];
    sendResponse(req, res, makeResponse('ok', {
      directory: { id, parent: first.artist_id, name: first.album, child: children }
    }));
  });

  // ── search2 / search3 ────────────────────────────────────────────────────────
  const handleSearch = (req, res) => {
    const rawQuery = req.query.query ?? req.body?.query ?? '';
    const query = rawQuery.replaceAll(/^["']+|["']+$/g, '');
    const artistCount  = Number.parseInt(req.query.artistCount  ?? req.body?.artistCount  ?? '20', 10);
    const albumCount   = Number.parseInt(req.query.albumCount   ?? req.body?.albumCount   ?? '20', 10);
    const songCount    = Number.parseInt(req.query.songCount    ?? req.body?.songCount    ?? '20', 10);
    const artistOffset = Number.parseInt(req.query.artistOffset ?? req.body?.artistOffset ?? '0',  10);
    const albumOffset  = Number.parseInt(req.query.albumOffset  ?? req.body?.albumOffset  ?? '0',  10);
    const songOffset   = Number.parseInt(req.query.songOffset   ?? req.body?.songOffset   ?? '0',  10);

    const vp  = resolveVpaths(req);
    const pfx = resolvePrefix(req);

    let artists, albums, songs;
    if (query.trim()) {
      ({ artists, albums, songs } = _searchQuery(db, vp, query, artistCount, albumCount, songCount));
    } else {
      const excl = resolveExcludePrefixes(req);
      ({ artists, albums, songs } = _searchEmpty(db, vp, pfx, excl, { artistCount, albumCount, songCount, artistOffset, albumOffset, songOffset }));
    }

    const resultKey = req.path.includes('search2') ? 'searchResult2' : 'searchResult3';
    sendResponse(req, res, makeResponse('ok', { [resultKey]: { artist: artists, album: albums, song: songs } }));
  };

  router('search2', handleSearch);
  router('search3', handleSearch);

  // ── getAlbumList / getAlbumList2 ─────────────────────────────────────────────
  /**
   * Resolve effective vpaths + filepathPrefix for album-list queries.
   * (Implementation moved to module scope — see resolveAlbumListScope above.)
   */

  const handleAlbumList = (req, res) => {
    const type   = req.query.type   || req.body?.type   || 'newest';
    const size   = Math.min(Number.parseInt(req.query.size   || req.body?.size   || '10', 10), 500);
    const offset = Number.parseInt(req.query.offset || req.body?.offset || '0', 10);
    const user   = req.subsonicUser;
    const { vp, pfxValue, includeFilepathPrefixes = [] } = resolveAlbumListScope(req);
    const pfx    = { filepathPrefix: pfxValue, includeFilepathPrefixes };
    const limit  = size + offset;

    // Alphabetical types skip dedup and return directly
    if (type === 'alphabeticalByName' || type === 'alphabeticalByArtist') {
      const orderBy = type === 'alphabeticalByArtist' ? 'artist' : 'album';
      const albumObjs = db.getAllAlbumIds(vp, { ...pfx, orderBy, limit: size, offset }).map(a => buildAlbum(a, null));
      const key = req.path.includes('2') ? 'albumList2' : 'albumList';
      return sendResponse(req, res, makeResponse('ok', { [key]: { album: albumObjs } }));
    }

    const rows = _fetchAlbumListRows(db, vp, user, type, limit, pfx, req);

    const seen = {}, albumRows = [];
    for (const r of rows) {
      if (!r.album_id || seen[r.album_id]) continue;
      seen[r.album_id] = true;
      albumRows.push(r);
      if (albumRows.length >= size) break;
    }

    const statsMap  = db.getAlbumStatsByIds(albumRows.map(r => r.album_id));
    const albumObjs = albumRows.map(r => {
      const stats = statsMap[r.album_id] || {};
      return buildAlbum({
        album_id: r.album_id, album: r.album, artist: r.artist,
        album_artist: r.album_artist,
        artist_id: r.artist_id, aaFile: r.aaFile, year: r.year,
        songCount: stats.songCount || 0, totalDuration: stats.totalDuration || 0
      }, null);
    });

    const key = req.path.includes('2') ? 'albumList2' : 'albumList';
    sendResponse(req, res, makeResponse('ok', { [key]: { album: albumObjs.slice(offset) } }));
  };

  router('getAlbumList',  handleAlbumList);
  router('getAlbumList2', handleAlbumList);

  // ── getRandomSongs ───────────────────────────────────────────────────────────
  router('getRandomSongs', (req, res) => {
    const opts = {
      size:     req.query.size     || req.body?.size     || 10,
      genre:    req.query.genre    || req.body?.genre    || null,
      fromYear: req.query.fromYear || req.body?.fromYear || null,
      toYear:   req.query.toYear   || req.body?.toYear   || null,
      filepathPrefix: resolvePrefix(req),
    };
    const rows = db.getRandomSongs(resolveVpaths(req), req.subsonicUser, opts);
    sendResponse(req, res, makeResponse('ok', {
      randomSongs: { song: rows.map(r => buildSong(r)) }
    }));
  });

  // ── getSongsByGenre ──────────────────────────────────────────────────────────
  router('getSongsByGenre', (req, res) => {
    const genre  = req.query.genre  || req.body?.genre  || '';
    const count  = Math.min(Number.parseInt(req.query.count  || req.body?.count  || '10', 10), 500);
    const offset = Number.parseInt(req.query.offset || req.body?.offset || '0', 10);

    const rows = db.getSongsByGenre(genre, resolveVpaths(req), req.subsonicUser, null, { filepathPrefix: resolvePrefix(req) });
    const slice = rows.slice(offset, offset + count);
    sendResponse(req, res, makeResponse('ok', {
      songsByGenre: { song: slice.map(r => buildSong(r)) }
    }));
  });

  // ── getGenres ────────────────────────────────────────────────────────────────
  router('getGenres', (req, res) => {
    const genres = db.getGenres(resolveVpaths(req), null, { filepathPrefix: resolvePrefix(req) });
    const genreList = genres.map(g => ({
      value: g.genre, songCount: g.cnt, albumCount: 0
    }));
    sendResponse(req, res, makeResponse('ok', {
      genres: { genre: genreList }
    }));
  });

  // ── getNowPlaying ────────────────────────────────────────────────────────────
  router('getNowPlaying', (req, res) => {
    const cutoff = Date.now() - 30 * 60 * 1000; // 30 minutes
    const entries = [];

    const activeByUser = new Map();
    for (const [username, np] of nowPlayingStore) {
      if (np.startedAt < cutoff) { nowPlayingStore.delete(username); continue; }
      if (!activeByUser.has(username)) activeByUser.set(username, []);
      activeByUser.get(username).push(np);
    }

    for (const [username, playing] of activeByUser) {
      const songMap = resolveSongRows(playing.map(np => np.id), username);
      for (const np of playing) {
        // Resolve CUE virtual ids to the base file + per-track metadata so
        // getNowPlaying returns a usable entry instead of nothing. Ids may carry
        // an "@<rowid>" disambiguator (resolveSongRows keys by the raw id).
        let song = null;
        const baseRow = songMap.get(np.id);
        const dec     = decodeSongId(np.id);
        if (dec.cue) {
          if (baseRow) {
            const idx = dec.cueIdx;
            const cps = _parseCuepoints(baseRow);
            if (!Number.isNaN(idx) && idx >= 0 && idx < cps.length) {
              song = buildCueSong(cps[idx], cps[idx + 1] ?? null, baseRow, idx);
            }
          }
        } else if (baseRow) {
          song = buildSong(baseRow, req.subsonicVpaths);
        }
        if (!song) continue;
        entries.push({
          ...song,
          username,
          minutesAgo: Math.floor((Date.now() - np.startedAt) / 60000),
          playerId:   np.playerId,
          playerName: np.playerName,
        });
      }
    }

    sendResponse(req, res, makeResponse('ok', { nowPlaying: { entry: entries } }));
  });

  // ── getStarred / getStarred2 ──────────────────────────────────────────────
  const handleGetStarred = (req, res) => {
    const vp     = resolveVpaths(req);
    const pfx    = { filepathPrefix: resolvePrefix(req) };
    const songs  = db.getStarredSongs(vp, req.subsonicUser, pfx);
    const albums = db.getStarredAlbums(vp, req.subsonicUser, pfx);
    const key = req.path.includes('2') ? 'starred2' : 'starred';
    sendResponse(req, res, makeResponse('ok', {
      [key]: {
        song:   songs.map(r => buildSong(r)),
        album:  albums.map(r => buildAlbum(r, null)),
        artist: []
      }
    }));
  };
  router('getStarred',  handleGetStarred);
  router('getStarred2', handleGetStarred);

  // ── star / unstar ────────────────────────────────────────────────────────────
  const handleStar = (req, res, starValue) => {
    const ids = [
      req.query.id   || req.body?.id   || [],
      req.query.albumId  || req.body?.albumId  || [],
      req.query.artistId || req.body?.artistId || []
    ].flat().filter(Boolean);

    for (const id of ids) {
      // id can be a song id ("<hash>" or "<hash>@<rowid>") or an album_id/artist_id
      // (16 hex chars). Stars are keyed by the content hash, so decode first.
      const { hash } = decodeSongId(id);
      if (hash.length === 32) {
        // song hash
        db.setStarred(hash, req.subsonicUser, starValue);
      } else {
        // album or artist — star all songs in it
        const songs = db.getFilesByAlbumId(id, req.subsonicVpaths, req.subsonicUser);
        for (const s of songs) {
          if (s.hash) db.setStarred(s.hash, req.subsonicUser, starValue);
        }
      }
    }
    sendResponse(req, res, makeResponse());
  };
  router('star',   (req, res) => handleStar(req, res, true));
  router('unstar', (req, res) => handleStar(req, res, false));

  // ── setRating ────────────────────────────────────────────────────────────────
  router('setRating', (req, res) => {
    const id     = req.query.id     || req.body?.id;
    const rating = Number.parseInt(req.query.rating || req.body?.rating || '0', 10); // 1-5 stars or 0=remove

    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));
    if (rating < 0 || rating > 5) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'rating must be 0-5'));

    // Convert Subsonic 1-5 to Velvet 1-10
    const velvetRating = rating > 0 ? rating * 2 : null;

    // Ratings are keyed by content hash — strip any "@<rowid>" disambiguator.
    const hash = decodeSongId(id).hash;
    const existing = db.findUserMetadata(hash, req.subsonicUser);
    if (existing) {
      db.updateUserMetadata({ ...existing, rating: velvetRating });
    } else {
      db.insertUserMetadata({ hash, user: req.subsonicUser, rating: velvetRating, pc: 0, lp: null });
    }
    db.saveUserDB();
    sendResponse(req, res, makeResponse());
  });

  // ── scrobble ─────────────────────────────────────────────────────────────────
  router('scrobble', (req, res) => {
    const ids = [req.query.id || req.body?.id || []].flat().filter(Boolean);
    const submission = String(req.query.submission || req.body?.submission || 'true') !== 'false';

    if (!ids.length) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));

    if (!submission) {
      const id = ids.at(-1);
      const playerName = req.query.c || req.body?.c || 'Unknown';
      const playerId   = req.query.c || req.body?.c || 'Unknown';
      nowPlayingStore.set(req.subsonicUser, { id, playerName, playerId, startedAt: Date.now() });
    }

    if (submission) {
      _processScrobble(db, ids, req.subsonicUser, nowPlayingStore);
    }
    sendResponse(req, res, makeResponse());
  });

  // ── stream / download ────────────────────────────────────────────────────────
  // Serve the audio file directly — do NOT redirect to /media/ because that
  // route is behind JWT auth and Subsonic clients don't carry a JWT token.
  // Dedup concurrent thumbnail generation: shared between handleStream (pre-warm) and
  // getCoverArt (on-demand). If two requests arrive for the same thumb before it exists,
  // the second waits for the first's promise rather than spawning a parallel sharp instance.
  const thumbInProgress = new Map();

  const handleStream = async (req, res) => {
    let id = req.query.id || req.body?.id;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));
    // Strip Sonora/OpenSubsonic preview suffix (e.g. "<hash>-preview-0")
    id = String(id).replace(/-preview-\d+$/, '');

    // ── CUE virtual track: "cue:<hash>[@<rowid>]:<index>" ────────────────────
    if (id.startsWith('cue:')) {
      const idx       = decodeSongId(id).cueIdx;
      const baseRow   = resolveSongRow(id, req.subsonicUser);
      if (!baseRow || !req.subsonicVpaths.includes(baseRow.vpath)) {
        return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
      }
      const cps = _parseCuepoints(baseRow);
      if (Number.isNaN(idx) || idx < 0 || idx >= cps.length) {
        return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
      }
      const folder = config.program.folders[baseRow.vpath];
      if (!folder) return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));

      let fullPath;
      try {
        fullPath = resolvePathWithinRoot(folder.root, baseRow.filepath);
      } catch {
        return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
      }
      const startSec  = cps[idx].t;
      const nextCp    = cps[idx + 1];
      const durSec    = nextCp == null ? null : Math.max(0, nextCp.t - startSec);

      // Ensure ffmpeg is downloaded and ready before spawning.
      // On a fresh Docker container the binary is absent until bootstrap finishes
      // (~1-5 min). Without this guard, spawn() throws ENOENT → silent 500.
      try { await ensureFfmpeg(); } catch (e) {
        winston.error('[velvet] CUE stream: ffmpeg not available', { stack: e });
        return sendResponse(req, res, makeError(ERRORS.GENERIC.code, 'ffmpeg not available'));
      }

      // Write to a temp file so ffmpeg can seek back and write the correct
      // STREAMINFO.total_samples after encoding. When piping to stdout, ffmpeg
      // cannot seek back → total_samples=0. Feishin reads this and treats the
      // track as 0ms, giving no playback. Symfonium falls back to the API's
      // JSON duration, so it played fine with pipe, but Feishin does not.
      // Writing to a file fixes both clients: STREAMINFO is correct, and
      // res.sendFile() provides Content-Length for range support.
      // -compression_level 0 encodes at ~350x realtime — negligible latency.
      const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-cue-'));
      const tmpFile = path.join(tmpDir, 'slice.flac');
      const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* no-op */ } };

      const ffArgs = ['-hide_banner', '-loglevel', 'error', '-ss', String(startSec)];
      if (durSec != null) ffArgs.push('-t', String(durSec));
      ffArgs.push(
        '-i', fullPath,
        '-map', '0:a',
        '-vn',
        '-c:a', 'flac',
        '-compression_level', '0',
        '-f', 'flac',
        tmpFile
      );

      const proc = spawn(ffmpegBin(), ffArgs, { stdio: ['ignore', 'ignore', 'ignore'] });
      let clientClosed = false;
      req.on('close', () => {
        clientClosed = true;
        try { proc.kill(); } catch { /* no-op */ }
        cleanup();
      });
      proc.on('error', () => {
        if (!clientClosed && !res.headersSent) res.status(500).end();
        cleanup();
      });
      proc.on('close', exitCode => {
        if (clientClosed) return;
        if (exitCode !== 0) {
          if (!res.headersSent) res.status(500).end();
          cleanup();
          return;
        }
        res.set('Content-Type', 'audio/flac');
        res.sendFile(tmpFile, err => {
          cleanup();
          if (err && !res.headersSent) res.status(500).end();
        });
      });
      return;
    }

    const row = resolveSongRow(id, req.subsonicUser);
    if (!row || !req.subsonicVpaths.includes(row.vpath)) {
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }

    const folder = config.program.folders[row.vpath];
    if (!folder) return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));

    let fullPath;
    try {
      fullPath = resolvePathWithinRoot(folder.root, row.filepath);
    } catch {
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }

    // Pre-warm thumbnail tiers before audio starts flowing.
    // iSub fires getCoverArt (size=160) and stream within ~5ms of each other.
    // Generating both tiers here ensures that by the time size=160 arrives,
    // the zs- thumbnail already exists on disk → getCoverArt responds in < 1 ms.
    // iOS AVFoundation needs > 100 ms of buffering before actual playback starts,
    // so even a 24 KB zs- file at LAN speeds arrives and renders well before audio.
    if (row.aaFile) {
      const artDir = config.program.storage.albumArtDirectory;
      let fullArtPath;
      try {
        fullArtPath = resolveChildPath(artDir, row.aaFile);
      } catch {
        fullArtPath = null;
      }
      if (fullArtPath && fs.existsSync(fullArtPath)) {
        for (const [prefix, px] of [['zs-', 92], ['zl-', 256]]) {
          let thumbPath;
          try {
            thumbPath = resolveChildPath(artDir, prefix + row.aaFile);
          } catch {
            continue;
          }
          if (!fs.existsSync(thumbPath) && !thumbInProgress.has(thumbPath)) {
            const gen = sharp(fullArtPath)
              .resize(px, px, { fit: 'inside', withoutEnlargement: true })
              .toFile(thumbPath)
              .catch(() => {})
              .finally(() => thumbInProgress.delete(thumbPath));
            thumbInProgress.set(thumbPath, gen);
          }
        }
        // Await zs- only if it is currently being generated (first-ever play).
        // For cached thumbnails this returns instantly. No artificial extra delay —
        // at LAN speeds a 2–24 KB zs- file transfers in < 1 ms; iOS AVFoundation
        // needs > 100 ms of audio buffering before playback starts, so art always
        // arrives first even without extra padding.
        let zsPath;
        try {
          zsPath = resolveChildPath(artDir, 'zs-' + row.aaFile);
          await thumbInProgress.get(zsPath);
        } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      }
    }

    // Set explicit Content-Type using the DB format field so iOS AVFoundation gets
    // the correct IANA MIME type. Express's mime module maps .flac → audio/x-flac
    // and .wav → audio/x-wav, both of which iOS rejects. We need audio/flac + audio/wav.
    const streamMimeMap = {
      mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
      opus: 'audio/opus', aac: 'audio/aac', m4a: 'audio/mp4',
      wav: 'audio/wav', wma: 'audio/x-ms-wma', aiff: 'audio/aiff',
      aif: 'audio/aiff', ape: 'audio/ape', wv: 'audio/x-wavpack',
      mpc: 'audio/musepack'
    };
    const fmt = (row.format || path.extname(fullPath).slice(1)).toLowerCase();
    const mime = streamMimeMap[fmt];
    if (mime) res.set('Content-Type', mime);

    res.sendFile(fullPath, err => {
      if (err && !res.headersSent) {
        sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, 'File not found on disk'));
      }
    });
  };
  router('stream',   handleStream);
  router('download', handleStream);

  // ── getCoverArt ──────────────────────────────────────────────────────────────
  // Serve directly — do NOT redirect to /album-art/ (JWT-protected route).
  router('getCoverArt', async (req, res) => {
    const id = req.query.id || req.body?.id;
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Cross-Origin-Opener-Policy', 'unsafe-none');
    res.set('Cross-Origin-Embedder-Policy', 'unsafe-none');
    if (!id) return res.status(404).end();

    let filename = String(id);
    if (filename === 'null') return res.status(404).end();

    const parsedInt   = /^\d+$/.test(filename) ? Number.parseInt(filename, 10) : Number.NaN;
    const isFolderInt = !Number.isNaN(parsedInt) && parsedInt >= 1 && parsedInt <= (req.subsonicVpaths?.length || 0);
    const isDirId     = filename.startsWith('d:');

    if (isFolderInt || isDirId) {
      const artFile = _resolveFolderArt(db, req, filename, parsedInt, isDirId);
      if (artFile) {
        let artPath;
        try {
          artPath = resolveChildPath(config.program.storage.albumArtDirectory, path.basename(artFile));
        } catch {
          artPath = null;
        }
        if (artPath && fs.existsSync(artPath)) {
          res.set('Cache-Control', 'public, max-age=86400');
          return res.sendFile(artPath, err => { if (err && !res.headersSent) res.status(500).end(); });
        }
      }
      return serveFolderIcon(res);
    }

    // ── Artist image: ar-<artist_id> ──────────────────────────────────────────
    if (filename.startsWith('ar-')) {
      const artistId  = filename.slice(3);
      let imageFile = _cacheGet(_artistImageCache, artistId);
      if (imageFile === undefined) {
        imageFile = db.getArtistImageByArtistId(artistId) || null;
        _cacheSet(_artistImageCache, artistId, imageFile);
      }
      if (imageFile) {
        let artistsDir;
        let artPath;
        try {
          artistsDir = resolvePathWithinRoot(config.program.storage.albumArtDirectory, 'artists');
          artPath = resolveChildPath(artistsDir, path.basename(imageFile));
        } catch {
          artPath = null;
        }
        if (artPath && fs.existsSync(artPath)) {
          res.set('Cache-Control', 'public, max-age=86400');
          return res.sendFile(artPath, err => { if (err && !res.headersSent) res.status(500).end(); });
        }
      }
      return serveFolderIcon(res);
    }

    if (!path.extname(filename)) {
      let resolved = _cacheGet(_aaFileByIdCache, filename);
      if (resolved === undefined) {
        // Cover art is shared by files with the same content hash, so resolve by
        // the bare hash — strip any "@<rowid>" disambiguator / CUE wrapper first.
        resolved = db.getAaFileById(decodeSongId(filename).hash) || null;
        _cacheSet(_aaFileByIdCache, filename, resolved);
      }
      if (!resolved) return serveFolderIcon(res);
      filename = resolved;
    }
    filename = path.basename(filename);
    const artDir  = config.program.storage.albumArtDirectory;
    let fullPath;
    try {
      fullPath = resolveChildPath(artDir, filename);
    } catch {
      return res.status(404).end();
    }
    if (!fs.existsSync(fullPath)) return res.status(404).end();

    const reqSize  = Number.parseInt(req.query.size || req.body?.size || '0', 10);
    const servePath = await _resolveThumb(artDir, filename, fullPath, reqSize, thumbInProgress);

    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(servePath, err => { if (err && !res.headersSent) res.status(500).end(); });
  });

  // ── getLyrics / getLyricsBySongId ────────────────────────────────────────────
  router('getLyrics', (req, res) => {
    sendResponse(req, res, makeResponse('ok', { lyrics: {} }));
  });
  router('getLyricsBySongId', (req, res) => {
    sendResponse(req, res, makeResponse('ok', { lyricsList: { structuredLyrics: [] } }));
  });

  // ── getUser ───────────────────────────────────────────────────────────────────
  router('getUser', (req, res) => {
    const username = req.query.username || req.body?.username || req.subsonicUser;
    const userObj  = config.program.users[username];
    if (!userObj && Object.keys(config.program.users).length > 0) {
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }
    const isAdmin = userObj?.admin === true || Object.keys(config.program.users).length === 0;
    const user = {
      username,
      email: '',
      scrobblingEnabled: false,
      adminRole: isAdmin,
      settingsRole: true,
      downloadRole: true,
      uploadRole: false,
      playlistRole: true,
      coverArtRole: false,
      commentRole: false,
      podcastRole: false,
      streamRole: true,
      jukeboxRole: false,
      shareRole: false,
      videoConversionRole: false,
      folder: (userObj?.vpaths ?? Object.keys(config.program.folders)).map((vp, i) => i + 1)
    };
    sendResponse(req, res, makeResponse('ok', { user }));
  });

  // ── getUsers ──────────────────────────────────────────────────────────────────
  router('getUsers', (req, res) => {
    const userIsAdmin = config.program.users[req.subsonicUser]?.admin === true
      || Object.keys(config.program.users).length === 0;
    if (!userIsAdmin) {
      return sendResponse(req, res, makeError(ERRORS.UNAUTH.code, ERRORS.UNAUTH.message));
    }
    const users = Object.keys(config.program.users).map(u => {
      const obj = config.program.users[u];
      return {
        username: u, email: '', scrobblingEnabled: false,
        adminRole: obj.admin === true, settingsRole: true, downloadRole: true,
        uploadRole: false, playlistRole: true, coverArtRole: false,
        commentRole: false, podcastRole: false, streamRole: true,
        jukeboxRole: false, shareRole: false, videoConversionRole: false,
        folder: (obj.vpaths || []).map((vp, i) => i + 1)
      };
    });
    sendResponse(req, res, makeResponse('ok', { users: { user: users } }));
  });

  // ── getPlaylists ──────────────────────────────────────────────────────────────
  router('getPlaylists', (req, res) => {
    const lists = db.getUserPlaylists(req.subsonicUser);
    const playlists = lists.map(pl => ({
      id: pl.name,
      name: pl.name,
      owner: req.subsonicUser,
      public: false,
      songCount: pl.songCount || 0,
      duration: pl.totalDuration || 0
    }));
    sendResponse(req, res, makeResponse('ok', { playlists: { playlist: playlists } }));
  });

  // ── getPlaylist ───────────────────────────────────────────────────────────────
  router('getPlaylist', (req, res) => {
    const id = req.query.id || req.body?.id;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));

    const entries = db.loadPlaylistEntries(req.subsonicUser, id);
    const vpaths  = req.subsonicVpaths;
    const songs   = [];

    for (const entry of entries) {
      if (!entry.filepath) continue;
      // Entries are stored as "vpath/relative/path" — find the matching vpath
      // by trying each allowed vpath as a prefix (handles spaces in vpath names)
      let matchVpath = null, matchFp = null;
      for (const vp of vpaths) {
        const prefix = vp + '/';
        if (entry.filepath.startsWith(prefix)) {
          matchVpath = vp;
          matchFp    = entry.filepath.slice(prefix.length);
          break;
        }
      }
      if (!matchVpath) continue;
      const row = db.getFileWithMetadata(matchFp, matchVpath, req.subsonicUser);
      if (row) songs.push(buildSong(row));
    }

    const duration = songs.reduce((s, r) => s + (r.duration || 0), 0);
    sendResponse(req, res, makeResponse('ok', {
      playlist: {
        id, name: id, owner: req.subsonicUser, public: false,
        songCount: songs.length, duration: Math.round(duration),
        entry: songs
      }
    }));
  });

  // Sanitise AI-generated playlist names:
  //   "Path: Eine Kleine Disco Band - (Love In) A Turkish Bath to Relaxed_instant"
  //   → "Eine Kleine Disco Band - (Love In) A Turkish Bath to Relaxed"
  // Rules (applied in order):
  //   1. Strip leading "Path: " (case-insensitive) — AudioMuse-AI prefix
  //   2. Strip trailing underscore AI suffixes: _instant / _queue / _session
  //   3. Collapse multiple spaces, trim
  //   4. Truncate to 120 chars
  // (sanitizePlaylistName moved to module scope)

  // ── createPlaylist ────────────────────────────────────────────────────────────
  router('createPlaylist', (req, res) => {
    const rawName = req.query.name || req.body?.name;
    if (!rawName) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'name required'));
    // Sanitise AI-generated names: strip common prefixes/suffixes that tools like
    // AudioMuse-AI append (e.g. "Path: Foo Bar_instant" → "Foo Bar").
    const name = sanitizePlaylistName(rawName);

    const songIds = [req.query.songId || req.body?.songId || []].flat().filter(Boolean);
    const songMap = resolveSongRows(songIds, req.subsonicUser);

    // Delete existing then recreate atomically.
    db.beginTransactionStrict();
    try {
      db.deletePlaylist(req.subsonicUser, name);
      for (const sid of songIds) {
        const row = songMap.get(sid);
        if (!row || !req.subsonicVpaths.includes(row.vpath)) continue;
        const fp = path.join(row.vpath, row.filepath).replaceAll('\\', '/');
        db.createPlaylistEntry({ name, filepath: fp, user: req.subsonicUser });
      }
      // Insert null sentinel entry
      db.createPlaylistEntry({ name, filepath: null, user: req.subsonicUser, live: false });
      db.commitTransactionStrict();
    } catch (err) {
      db.rollbackTransactionStrict();
      throw err;
    }
    db.saveUserDB();

    sendResponse(req, res, makeResponse('ok', {
      playlist: { id: name, name, owner: req.subsonicUser, public: false,
        songCount: songIds.length, duration: 0 }
    }));
  });

  // ── updatePlaylist ────────────────────────────────────────────────────────────
  router('updatePlaylist', (req, res) => {
    const rawPlaylistId = req.query.playlistId || req.body?.playlistId;
    if (!rawPlaylistId) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'playlistId required'));
    const playlistId = sanitizePlaylistName(rawPlaylistId);

    // Optional rename/comment — newName is used if provided
    const rawNewName = req.query.name || req.body?.name;
    const newName = rawNewName ? sanitizePlaylistName(rawNewName) : null;

    const toAdd    = [req.query.songIdToAdd    || req.body?.songIdToAdd    || []].flat().filter(Boolean);
    const songMap = resolveSongRows(toAdd, req.subsonicUser);
    const toRemove = [req.query.songIndexToRemove || req.body?.songIndexToRemove || []].flat().map(Number).filter(n => !Number.isNaN(n));

    // Load existing
    const entries = db.loadPlaylistEntries(req.subsonicUser, playlistId);
    const filepaths  = entries.filter(e => e.filepath).map(e => e.filepath);

    // Remove by index (descending to preserve indices)
    toRemove.toSorted((a, b) => b - a).forEach(i => { if (i >= 0 && i < filepaths.length) filepaths.splice(i, 1); });

    // Append new songs
    for (const sid of toAdd) {
      const row = songMap.get(sid);
      if (!row || !req.subsonicVpaths.includes(row.vpath)) continue;
      filepaths.push(path.join(row.vpath, row.filepath).replaceAll('\\', '/'));
    }

    // Rewrite under new name (or same name if not renaming) atomically.
    const targetName = newName ?? playlistId;
    db.beginTransactionStrict();
    try {
      db.deletePlaylist(req.subsonicUser, playlistId);
      // If renaming, ensure old name is gone (already deleted above)
      for (const fp of filepaths) {
        db.createPlaylistEntry({ name: targetName, filepath: fp, user: req.subsonicUser });
      }
      db.createPlaylistEntry({ name: targetName, filepath: null, user: req.subsonicUser, live: false });
      db.commitTransactionStrict();
    } catch (err) {
      db.rollbackTransactionStrict();
      throw err;
    }
    db.saveUserDB();

    sendResponse(req, res, makeResponse());
  });

  // ── deletePlaylist ────────────────────────────────────────────────────────────
  router('deletePlaylist', (req, res) => {
    const id = req.query.id || req.body?.id;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));

    db.deletePlaylist(req.subsonicUser, id);
    db.saveUserDB();
    sendResponse(req, res, makeResponse());
  });

  // ── getArtistInfo / getAlbumInfo ─────────────────────────────────────────────
  // biography (ArtistInfo) and notes (AlbumInfo) must always be present —
  // Substreamer, DSub, and similar clients crash their markdown renderer when
  // the key is absent. artistInfo2/albumInfo2 use their own wrapper names.
  // Artist image URLs point back to getCoverArt?id=ar-<artist_id>; clients
  // are expected to append their own auth params before fetching.
  // (_buildArtistInfoImageUrl moved to module scope)

  router('getArtistInfo', (req, res) => {
    const artistId  = req.query.id || req.body?.id || '';
    const imageUrl  = _buildArtistInfoImageUrl(req, artistId);
    const info = {
      biography: '',
      ...(imageUrl ? { smallImageUrl: imageUrl, mediumImageUrl: imageUrl, largeImageUrl: imageUrl } : {}),
    };
    sendResponse(req, res, makeResponse('ok', { artistInfo: info }));
  });

  router('getArtistInfo2', (req, res) => {
    const artistId  = req.query.id || req.body?.id || '';
    const imageUrl  = _buildArtistInfoImageUrl(req, artistId);
    const info = {
      biography: '',
      ...(imageUrl ? { smallImageUrl: imageUrl, mediumImageUrl: imageUrl, largeImageUrl: imageUrl } : {}),
    };
    sendResponse(req, res, makeResponse('ok', { artistInfo2: info }));
  });

  router('getAlbumInfo',   (req, res) => sendResponse(req, res, makeResponse('ok', { albumInfo:   { notes: '' } })));
  router('getAlbumInfo2',  (req, res) => sendResponse(req, res, makeResponse('ok', { albumInfo2:  { notes: '' } })));

  // ── getSimilarSongs / getTopSongs ─────────────────────────────────────────────
  // Stubs — no audio-analysis/MusicBrainz lookup yet; return empty song lists
  router('getSimilarSongs',  (req, res) => sendResponse(req, res, makeResponse('ok', { similarSongs:  { song: [] } })));
  router('getSimilarSongs2', (req, res) => sendResponse(req, res, makeResponse('ok', { similarSongs2: { song: [] } })));
  router('getTopSongs',      (req, res) => sendResponse(req, res, makeResponse('ok', { topSongs:      { song: [] } })));

  // ── getBookmarks / saveBookmark / deleteBookmark ─────────────────────────────
  router('getBookmarks', (req, res) => {
    const rows = db.getBookmarks(req.subsonicUser);
    const songMap = resolveSongRows(rows.map(bm => bm.song_id), req.subsonicUser);
    const bookmarkList = rows.map(bm => {
      const songRow = songMap.get(bm.song_id);
      if (!songRow) return null;
      return {
        position: bm.position,
        username: req.subsonicUser,
        comment:  bm.comment ?? '',
        created:  new Date(bm.created).toISOString(),
        changed:  new Date(bm.changed).toISOString(),
        entry:    buildSong(songRow),
      };
    }).filter(Boolean);
    sendResponse(req, res, makeResponse('ok', { bookmarks: { bookmark: bookmarkList } }));
  });

  router('saveBookmark', (req, res) => {
    const id       = req.query.id       || req.body?.id;
    const position = Number(req.query.position ?? req.body?.position ?? 0);
    const comment  = req.query.comment  || req.body?.comment || null;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));
    db.saveBookmark(req.subsonicUser, id, position, comment);
    sendResponse(req, res, makeResponse());
  });

  router('deleteBookmark', (req, res) => {
    const id = req.query.id || req.body?.id;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));
    db.deleteBookmark(req.subsonicUser, id);
    sendResponse(req, res, makeResponse());
  });

  // ── savePlayQueue / getPlayQueue ─────────────────────────────────────────────
  // Server-side play queue persistence: lets Feishin (and other Subsonic clients)
  // save the full queue + current position to the server so it survives client
  // restarts reliably — more durable than client-side local storage.
  router('savePlayQueue', (req, res) => {
    const rawIds = [req.query.id || req.body?.id || []].flat().filter(Boolean);
    const current   = req.query.current   || req.body?.current   || rawIds[0] || null;
    const position  = Number(req.query.position  ?? req.body?.position  ?? 0);
    const changedBy = req.query.c || req.body?.c || null;
    db.savePlayQueue(req.subsonicUser, current, position, changedBy, JSON.stringify(rawIds));
    sendResponse(req, res, makeResponse());
  });

  router('getPlayQueue', (req, res) => {
    const row = db.getPlayQueue(req.subsonicUser);
    if (!row) {
      // No saved queue — return an empty playQueue element
      return sendResponse(req, res, makeResponse('ok', {
        playQueue: { username: req.subsonicUser, current: '', position: 0 }
      }));
    }
    let ids = [];
    try { ids = JSON.parse(row.song_ids); } catch { /* malformed — treat as empty */ }
    if (!Array.isArray(ids)) ids = [];

    // Resolve each saved id to its exact file (handles "<hash>@<rowid>" and CUE ids,
    // plus legacy bare-hash ids saved by older clients). Keyed by the raw id.
    const songMap = resolveSongRows(ids, req.subsonicUser);

    const entries = [];
    for (const id of ids) {
      const songRow = songMap.get(id);
      if (!songRow || !req.subsonicVpaths.includes(songRow.vpath)) continue;
      const dec = decodeSongId(id);
      if (dec.cue) {
        const idx = dec.cueIdx;
        const cps = _parseCuepoints(songRow);
        if (!Number.isNaN(idx) && idx >= 0 && idx < cps.length) {
          entries.push(buildCueSong(cps[idx], cps[idx + 1] ?? null, songRow, idx));
        }
      } else {
        entries.push(buildSong(songRow));
      }
    }

    sendResponse(req, res, makeResponse('ok', {
      playQueue: {
        current:   row.current_id ?? '',
        position:  row.position_ms ?? 0,
        username:  req.subsonicUser,
        changed:   new Date(row.changed).toISOString(),
        changedBy: row.changed_by ?? '',
        entry:     entries,
      }
    }));
  });

  // ── getPodcasts / getNewestPodcasts ──────────────────────────────────────────
  router('getPodcasts',       (req, res) => sendResponse(req, res, makeResponse('ok', { podcasts: {} })));
  router('getNewestPodcasts', (req, res) => sendResponse(req, res, makeResponse('ok', { newestPodcasts: {} })));

  // ── getInternetRadioStations / createInternetRadioStation / update / delete ──
  // Maps Velvet radio stations (radio_stations table) to the Subsonic
  // internetRadioStation element. link_a is the primary stream URL.
  // Station art (img field) is served by getCoverArt using the same albumArtDir.
  // (Implementation moved to module scope — see _buildRadioStation above.)

  router('getInternetRadioStations', (req, res) => {
    const stations = db.getRadioStations(req.subsonicUser);
    const list = stations.filter(s => s.link_a).map(_buildRadioStation);
    sendResponse(req, res, makeResponse('ok', {
      internetRadioStations: list.length ? { internetRadioStation: list } : {}
    }));
  });

  router('createInternetRadioStation', (req, res) => {
    const streamUrl = req.query.streamUrl || req.body?.streamUrl;
    const name      = req.query.name      || req.body?.name;
    if (!streamUrl || !name) {
      return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'streamUrl and name required'));
    }
    db.createRadioStation(req.subsonicUser, { name, link_a: streamUrl });
    sendResponse(req, res, makeResponse());
  });

  router('updateInternetRadioStation', (req, res) => {
    const id        = req.query.id        || req.body?.id;
    const streamUrl = req.query.streamUrl || req.body?.streamUrl;
    const name      = req.query.name      || req.body?.name;
    if (!id || !streamUrl || !name) {
      return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id, streamUrl and name required'));
    }
    const existing = db.getRadioStations(req.subsonicUser).find(s => String(s.id) === String(id));
    if (!existing) {
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }
    db.updateRadioStation(Number(id), req.subsonicUser, {
      name,
      link_a: streamUrl,
      link_b: existing.link_b,
      link_c: existing.link_c,
      genre:  existing.genre,
      country: existing.country,
      img:    existing.img,
    });
    sendResponse(req, res, makeResponse());
  });

  router('deleteInternetRadioStation', (req, res) => {
    const id = req.query.id || req.body?.id;
    if (!id) return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'id required'));
    const deleted = db.deleteRadioStation(Number(id), req.subsonicUser);
    if (!deleted) return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    sendResponse(req, res, makeResponse());
  });

  // ── getScanStatus ─────────────────────────────────────────────────────────────
  router('getScanStatus', (req, res) => {
    sendResponse(req, res, makeResponse('ok', { scanStatus: { scanning: false, count: 0 } }));
  });

  // ── getOpenSubsonicExtensions ─────────────────────────────────────────────────
  router('getOpenSubsonicExtensions', (req, res) => {
    sendResponse(req, res, makeResponse('ok', {
      openSubsonicExtensions: [
        { name: 'formPost',    versions: [1] },
        { name: 'noAuth',      versions: [1] },
        { name: 'albumArtist', versions: [1] },
      ]
    }));
  });

  // ── createUser / updateUser / deleteUser ──────────────────────────────────────
  // User management is handled via the Velvet admin panel, not via
  // the Subsonic API. Return error 50 so clients don't silently think the
  // operation succeeded when it did not.
  const adminOnly = (req, res) => {
    sendResponse(req, res, makeError(ERRORS.UNAUTH.code, 'User management is not supported via the Subsonic API — use the Velvet admin panel.'));
  };
  router('createUser', adminOnly);
  router('updateUser', adminOnly);
  router('deleteUser', adminOnly);

  // ── changePassword ────────────────────────────────────────────────────────────
  router('changePassword', (req, res) => {
    // Only allow users to change their own subsonic password
    const username = req.query.username || req.body?.username;
    const password = req.query.password || req.body?.password;
    if (!username || !password) {
      return sendResponse(req, res, makeError(ERRORS.MISSING_PARAM.code, 'username and password required'));
    }
    if (username !== req.subsonicUser && config.program.users[req.subsonicUser]?.admin !== true) {
      return sendResponse(req, res, makeError(ERRORS.UNAUTH.code, ERRORS.UNAUTH.message));
    }
    const userObj = config.program.users[username];
    if (!userObj && Object.keys(config.program.users).length > 0) {
      return sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, ERRORS.NOT_FOUND.message));
    }
    if (userObj) {
      let plain = password;
      if (plain.startsWith('enc:')) plain = Buffer.from(plain.slice(4), 'hex').toString('utf8');
      userObj['subsonic-password'] = plain;
      // persist async — don't wait
      import('../util/admin.js').then(a => a.editSubsonicPassword(username, plain)).catch(() => {});
    }
    sendResponse(req, res, makeResponse());
  });

  // ── Catch-all for unsupported endpoints ──────────────────────────────────────
  // Unknown Subsonic method — return error 70 (not found) so clients can
  // distinguish a typo'd method from a generic backend failure (code 0).
  // Matches Navidrome / Gonic behaviour.
  velvet.all('/rest/:action', subsonicAuth, (req, res) => {
    const raw = String(req.params.action || '').replace(/\.view$/i, '');
    sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, `Subsonic method "${raw}" not found`));
  });
  velvet.all('/rest/:action.view', subsonicAuth, (req, res) => {
    const raw = String(req.params.action || '').replace(/\.view$/i, '');
    sendResponse(req, res, makeError(ERRORS.NOT_FOUND.code, `Subsonic method "${raw}" not found`));
  });
}

// ── subsonic helpers ───────────────────────────────────────────────────────────

function _searchEmpty(db, vp, pfx, excl, counts) {
  const { artistCount, albumCount, songCount, artistOffset, albumOffset, songOffset } = counts;
  let artists = [], albums = [], songs = [];
  if (songCount > 0) {
    const rows = db.listAllSongs(vp, null, excl, pfx, songOffset, songCount);
    for (const r of rows) {
      const cps = _parseCuepoints(r);
      if (cps.length >= 2) {
        for (let i = 0; i < cps.length; i++) {
          songs.push(buildCueSong(cps[i], cps[i + 1] ?? null, r, i));
        }
      } else {
        songs.push(buildSong(r));
      }
    }
  }
  if (albumCount > 0) {
    const _t0 = Date.now();
    const page = db.getAllAlbumIds(vp, { filepathPrefix: pfx, excludeFilepathPrefixes: excl, limit: albumCount, offset: albumOffset });
    const _t1 = Date.now();
    albums = page.map(a => buildAlbum(a, null));
    const _t2 = Date.now();
    winston.info(`[SUBSONIC-TIMING] album query=${_t1-_t0}ms build=${_t2-_t1}ms rows=${page.length} offset=${albumOffset}`);
  }
  if (artistCount > 0) {
    const page = db.getAllArtistIds(vp, { filepathPrefix: pfx, excludeFilepathPrefixes: excl, limit: artistCount, offset: artistOffset });
    artists = page.map(a => ({ id: a.artist_id, name: a.artist?.trim() || '(Unknown)', albumCount: a.albumCount || 0, ...(a.artist_id ? { coverArt: 'ar-' + a.artist_id } : {}) }));
  }
  return { artists, albums, songs };
}

function _searchQuery(db, vp, query, artistCount, albumCount, songCount) {
  const rawArtists = db.searchFiles('artist', query, vp, null);
  const rawAlbums  = db.searchFiles('album',  query, vp, null);
  // Songs: title OR artist OR album (Navidrome / single-box Subsonic clients expect this).
  const rawSongs   = db.searchFiles(['title', 'artist', 'album'], query, vp, null);

  const artists = [], artistSeen = {};
  for (const r of rawArtists) {
    if (!r.artist_id || artistSeen[r.artist_id]) continue;
    artistSeen[r.artist_id] = true;
    artists.push({ id: r.artist_id, name: r.artist || '', ...(r.artist_id ? { coverArt: 'ar-' + r.artist_id } : {}) });
    if (artists.length >= artistCount) break;
  }
  const albums = [], albumSeen = {};
  for (const r of rawAlbums) {
    if (!r.album_id || albumSeen[r.album_id]) continue;
    albumSeen[r.album_id] = true;
    albums.push(buildAlbum({ album_id: r.album_id, album: r.album, artist: r.artist, artist_id: r.artist_id, aaFile: r.aaFile, year: r.year }, null));
    if (albums.length >= albumCount) break;
  }
  const songs = [];
  for (const r of rawSongs.slice(0, songCount)) {
    const cps = _parseCuepoints(r);
    if (cps.length >= 2) {
      for (let i = 0; i < cps.length; i++) {
        songs.push(buildCueSong(cps[i], cps[i + 1] ?? null, r, i));
      }
    } else {
      songs.push(buildSong(r));
    }
  }
  return { artists, albums, songs };
}

function _fetchAlbumListRows(db, vp, user, type, limit, pfx, req) {
  if (type === 'newest')              return db.getRecentlyAdded(vp, user, limit, null, pfx);
  if (type === 'recent')              return db.getRecentlyPlayed(vp, user, limit, null, pfx);
  if (type === 'frequent' || type === 'highest') return db.getMostPlayed(vp, user, limit, null, pfx);
  if (type === 'starred')             return db.getStarredSongs(vp, user, pfx).slice(0, limit);
  if (type === 'random')              return db.getRandomSongs(vp, user, { size: limit, ...pfx });
  if (type === 'byYear') {
    const fromYear = Number.parseInt(req.query.fromYear || req.body?.fromYear || '0', 10);
    const toYear   = Number.parseInt(req.query.toYear   || req.body?.toYear   || '9999', 10);
    return db.getRandomSongs(vp, user, { size: limit, fromYear, toYear, ...pfx });
  }
  if (type === 'byGenre') {
    const genre = req.query.genre || req.body?.genre || '';
    return db.getRandomSongs(vp, user, { size: limit, genre, ...pfx });
  }
  return [];
}

function _dispatchScrobble(doLastfm, doLb, userObj, username, row) {
  if (!row || (!doLastfm && !doLb)) return;
  const meta = { artist: row.artist, album: row.album, track: row.title };
  if (doLastfm) scrobblerApi.scrobbleLastfmForUser(userObj, meta);
  if (doLb)     scrobblerApi.scrobbleLbForUser(username, meta);
}

function _processScrobble(db, ids, username, nowPlayingStore) {
  nowPlayingStore.delete(username);
  const userObj  = config.program.users[username];
  const doLastfm = userObj?.['subsonic-scrobble-lastfm'] === true;
  const doLb     = userObj?.['subsonic-scrobble-lb']     === true;

  // Pre-resolve all content hashes to avoid per-item DB lookups in hot scrobble
  // paths. decodeSongId strips any "@<rowid>" disambiguator and CUE wrapper so the
  // map is keyed by the bare content hash that user-metadata/play-events use.
  const storageHashes = ids.map(id => decodeSongId(id).hash).filter(Boolean);
  const songMap = db.getSongsByHashes(storageHashes, username);

  db.savepoint('scrobble_sp');
  try {
    for (const id of ids) {
      const now = Math.floor(Date.now() / 1000);

    // CUE virtual track id ("cue:<baseHash>[@<rowid>]:<index>"): resolve to the
    // underlying base file row and use its hash for play-count / play-event
    // storage, but use the per-track CUE title (and base artist/album) for the
    // external scrobble payload sent to Last.fm / ListenBrainz.
    const dec = decodeSongId(id);
    let storageHash = dec.hash;
    let scrobbleMeta = null;
    if (dec.cue) {
      const idx      = dec.cueIdx;
      const baseRow  = songMap.get(dec.hash);
      if (baseRow) {
        storageHash = dec.hash;
        const cps = _parseCuepoints(baseRow);
        if (!Number.isNaN(idx) && idx >= 0 && idx < cps.length) {
          scrobbleMeta = { artist: baseRow.artist, album: baseRow.album, track: cps[idx].title || baseRow.title };
        }
      } else {
        // Base file no longer exists — skip silently to avoid polluting the DB.
        continue;
      }
    }

      const existing = db.findUserMetadata(storageHash, username);
      if (existing) {
        db.updateUserMetadata({ ...existing, pc: (existing.pc || 0) + 1, lp: now });
      } else {
        db.insertUserMetadata({ hash: storageHash, user: username, rating: null, pc: 1, lp: now });
      }
      try {
        db.insertPlayEvent({ user_id: username, file_hash: storageHash, started_at: Date.now(), duration_ms: null, source: 'subsonic', session_id: null });
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      if (doLastfm || doLb) {
        if (scrobbleMeta) {
          if (doLastfm) scrobblerApi.scrobbleLastfmForUser(userObj, scrobbleMeta);
          if (doLb)     scrobblerApi.scrobbleLbForUser(username, scrobbleMeta);
        } else {
          _dispatchScrobble(doLastfm, doLb, userObj, username, songMap.get(storageHash));
        }
      }
    }
    db.releasePoint('scrobble_sp');
  } catch (err) {
    db.rollbackToPoint('scrobble_sp');
    throw err;
  }
  db.saveUserDB();
}

function _resolveFolderArt(db, req, filename, parsedInt, isDirId) {
  const cacheKey = req.subsonicUser + '\x00' + filename;
  const cached = _cacheGet(_folderArtCache, cacheKey);
  if (cached !== undefined) return cached;

  let result;
  if (isDirId) {
    const parsed = parseDirId(filename);
    result = parsed ? db.getAaFileForDir(parsed.v, parsed.p) : null;
    _cacheSet(_folderArtCache, cacheKey, result || null);
    return result;
  }
  const vp     = req.subsonicVpaths[parsedInt - 1];
  const vpMeta = req.subsonicVpathMeta?.[vp] ?? {};
  const dbVp   = vpMeta.parentVpath || vp;
  const prefix = (vpMeta.filepathPrefix || '').replace(/\/$/, '');
  result = db.getAaFileForDir(dbVp, prefix);
  _cacheSet(_folderArtCache, cacheKey, result || null);
  return result;
}

function _cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.ts > COVER_ID_CACHE_TTL_MS) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

function _cacheSet(map, key, value) {
  if (map.size >= COVER_ID_CACHE_MAX) map.clear();
  map.set(key, { ts: Date.now(), value });
}

async function _resolveThumb(artDir, filename, fullPath, reqSize, thumbInProgress) {
  if (reqSize <= 0) return fullPath;
  const useZs     = reqSize <= 160;
  const prefix    = useZs ? 'zs-' : 'zl-';
  const px        = useZs ? 92 : 256;
  let thumbPath;
  try {
    thumbPath = resolveChildPath(artDir, prefix + filename);
  } catch {
    return fullPath;
  }
  if (fs.existsSync(thumbPath)) return thumbPath;

  if (!thumbInProgress.has(thumbPath)) {
    const gen = sharp(fullPath)
      .resize(px, px, { fit: 'inside', withoutEnlargement: true })
      .toFile(thumbPath)
      .catch(() => {})
      .finally(() => thumbInProgress.delete(thumbPath));
    thumbInProgress.set(thumbPath, gen);
  }
  let otherPath;
  try {
    otherPath = resolveChildPath(artDir, (useZs ? 'zl-' : 'zs-') + filename);
  } catch {
    otherPath = null;
  }
  if (otherPath && !fs.existsSync(otherPath) && !thumbInProgress.has(otherPath)) {
    const gen = sharp(fullPath)
      .resize(useZs ? 256 : 92, useZs ? 256 : 92, { fit: 'inside', withoutEnlargement: true })
      .toFile(otherPath)
      .catch(() => {})
      .finally(() => thumbInProgress.delete(otherPath));
    thumbInProgress.set(otherPath, gen);
  }
  try {
    await thumbInProgress.get(thumbPath);
    if (fs.existsSync(thumbPath)) return thumbPath;
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  return fullPath;
}
