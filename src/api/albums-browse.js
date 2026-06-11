/**
 * albums-browse.js — Album Library browser (DB-driven, fast)
 *
 * Builds the album tree entirely from indexed DB data — no filesystem walking.
 * Supports MULTIPLE albumsOnly sources (root vpaths and child vpaths).
 * Art files (cover.jpg etc.) are discovered via parallel fs.access at the end.
 *
 * Endpoints:
 *   GET /api/v1/albums/browse         → { albums, series }
 *   GET /api/v1/albums/art-file?p=    → serves a filesystem image file
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import axios from 'axios';
import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { resolvePathWithinRoot } from '../util/path-security.js';
import { fetchPublicUrlBuffer } from '../util/ssrf-check.js';
import { getReleaseCoverBuf } from './discogs.js';

// ── Sidecar CUE check (used by /albums/detail for live re-reads) ───────────────
/** Locate the .cue sidecar for an audio file, or return null if none found */
function _findCuePath(dir, base, audioFilename) {
  for (const candidate of [base + '.cue', audioFilename + '.cue']) {
    try {
      const resolved = resolvePathWithinRoot(dir, candidate);
      if (fs.existsSync(resolved)) return resolved;
    } catch {
      continue;
    }
  }
  let cueFiles;
  try { cueFiles = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.cue')); }
  catch { return null; }
  if (cueFiles.length === 1) {
    try { return resolvePathWithinRoot(dir, cueFiles[0]); } catch { return null; }
  }
  // Multiple CUE files in the folder (e.g. two FLAC+CUE pairs in the same directory).
  // Read each CUE's FILE directive to find the one that references this audio file.
  const audio = audioFilename.toLowerCase();
  for (const cue of cueFiles) {
    try {
      const content = fs.readFileSync(resolvePathWithinRoot(dir, cue), 'utf8');
      const m = content.match(/^FILE\s+"([^"]+)"/im);
      if (m && path.basename(m[1]).toLowerCase() === audio) return resolvePathWithinRoot(dir, cue);
    } catch { /* unreadable CUE — skip */ }
  }
  return null;
}

/** Parse TRACK/TITLE/INDEX 01 entries from a CUE sheet string */
function _parseCueTracks(content) {
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
  return tracks;
}

// Checks whether a sidecar .cue file exists alongside `fullPath` and parses it.
// Returns { cuepoints: [{no, title, t}], hasCueFile: boolean }
// • hasCueFile: true  + cuepoints ≥ 2  → valid CUE album
// • hasCueFile: true  + cuepoints < 2  → file exists but is invalid / references wrong audio
// • hasCueFile: false                  → no .cue sidecar found
function _checkSidecarCue(fullPath) {
  const dir          = path.dirname(fullPath);
  const base         = path.basename(fullPath, path.extname(fullPath));
  const audioFilename = path.basename(fullPath);

  // 1. Exact-basename match: album.flac → album.cue
  // 2. Double-extension: album.flac → album.flac.cue
  // 3. Sole .cue file in the directory
  const cuePath = _findCuePath(dir, base, audioFilename);
  if (!cuePath) return { cuepoints: [], hasCueFile: false };

  // File exists — try to parse it
  try {
    const content = fs.readFileSync(cuePath, 'utf8');
    // Only handle single-FILE sheets whose FILE line references this audio file
    const fileLines = [...content.matchAll(/^FILE\s+"([^"]+)"/gim)];
    if (fileLines.length !== 1) return { cuepoints: [], hasCueFile: true };
    const cueRef = path.basename(fileLines[0][1]);
    if (cueRef.toLowerCase() !== audioFilename.toLowerCase()) return { cuepoints: [], hasCueFile: true };
    const tracks = _parseCueTracks(content);
    return { cuepoints: tracks.length > 1 ? tracks : [], hasCueFile: true };
  } catch {
    return { cuepoints: [], hasCueFile: true };
  }
}

// ── Constants ──────────────────────────────────────────────────────────────────

// Strict disc-folder patterns:
//   DISC_RE         — starts with keyword: "CD 1", "Disc 2", "CD-3"  ("Disconet" does NOT match)
//   DISC_SUFFIX_RE  — ends with keyword:   "Album Title CD - 1", "Foo Disc 2"
//                     The \b guard prevents "1CD" from matching; the $ anchor prevents
//                     "CD Edition 2" (non-numeric suffix) from matching.
//   NUMERIC_DISC_RE — bare number:         "1", "02"
const DISC_RE         = /^(cd|disc)\s*[-–]?\s*\d/i;
const DISC_SUFFIX_RE  = /\b(cd|disc)\s*[-–]?\s*\d+\s*$/i;
const NUMERIC_DISC_RE = /^\d{1,2}$/;

// Shared collators — created once, reused. Avoids per-call locale lookup which is 40-50× slower.
const _collBase    = new Intl.Collator(undefined, { sensitivity: 'base' });             // accent+case-insensitive
const _collNumeric = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }); // same + numeric order

const ART_NAMES = [
  'cover.jpg', 'Cover.jpg', 'cover.jpeg', 'Cover.jpeg',
  'front.jpg', 'Front.jpg', 'front.jpeg', 'Front.jpeg',
  'Folder.jpg', 'folder.jpg', 'Folder.jpeg', 'folder.jpeg',
  'cover.png', 'Cover.png', 'front.png', 'Front.png',
  'cover.webp', 'Cover.webp',
];
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Source resolution (all albumsOnly vpaths) ────────────────────────────────
// Returns an array of source descriptors for every vpath configured as albumsOnly.
// Each source:
//   vpathName   — the vpath name used as the player filepath prefix
//   vpathRoot   — absolute filesystem root of the vpath
//   dbVpath     — the vpath name as stored in the `files.vpath` column
//   prefix      — filepath prefix to filter by inside dbVpath (null = all files)
//   artRoot     — filesystem root to resolve artFile paths against
//
// Architecture rules:
//   • Only ROOT vpaths (no parentVpath) are indexed in the DB.
//     VCHILDs are shortcuts/filters — their files are stored under the parent.
//   • A ROOT vpath with albumsOnly:true → include ALL its files (prefix=null)
//   • A CHILD vpath with albumsOnly:true → files are under the PARENT root,
//     filtered by filepathPrefix (e.g. "Albums/")
//   • If NO vpath is marked albumsOnly, fall back to any vpath whose root
//     contains an Albums/ subdirectory.

let _sourcesCache = null;
let _dlnaSourcesCache = null;
let _cache        = null;   // slim browse response: { albums (no discs), series }
let _cacheFull    = null;   // Map<albumId, fullAlbum> — used by /api/v1/albums/detail
let _cacheTs      = 0;

export function invalidateCache() {
  _cache     = null;
  _cacheFull = null;
  _cacheTs   = 0;
  _sourcesCache = null;
  _dlnaSourcesCache = null;
}

/** Build a map of vpath → parent vpath name (or null if root) */
function _buildParentOfMap(folderEntries) {
  const parentOf = {};
  for (const [name, folder] of folderEntries) {
    const myRoot = folder.root.replace(/\/?$/, '/');
    const parent = folderEntries.find(([other, otherF]) =>
      other !== name &&
      myRoot.startsWith(otherF.root.replace(/\/?$/, '/')) &&
      otherF.root.replace(/\/?$/, '/') !== myRoot
    );
    parentOf[name] = parent ? parent[0] : null;
  }
  return parentOf;
}

/** Build a source entry for a single albumsOnly vpath */
function _makeSourceEntry(name, folder, parent, folders) {
  if (!parent) {
    return { vpathName: name, vpathRoot: folder.root, dbVpath: name, prefix: null, artRoot: folder.root };
  }
  const parentRoot = folders[parent].root.replace(/\/?$/, '/');
  const myRoot     = folder.root.replace(/\/?$/, '/');
  const prefix     = myRoot.slice(parentRoot.length);
  return { vpathName: name, vpathRoot: folder.root, dbVpath: parent, prefix, artRoot: folder.root };
}

/** Fallback: find the first root vpath with an Albums/ subdirectory on disk */
async function _findAlbumsFallback(folderEntries, parentOf, explicitRoots) {
  for (const [name, folder] of folderEntries) {
    if (parentOf[name]) continue;
    const candidate = path.join(folder.root, 'Albums');
    if (explicitRoots.has(candidate)) continue;
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isDirectory()) {
        return { vpathName: name, vpathRoot: folder.root, dbVpath: name, prefix: 'Albums/', artRoot: folder.root };
      }
    } catch { /* Albums/ subdirectory not found on disk — skip this vpath */ }
  }
  return null;
}

export async function resolveAlbumsSources() {
  if (_sourcesCache) return _sourcesCache;

  const folders = config.program?.folders || {};
  const folderEntries = Object.entries(folders);
  const parentOf = _buildParentOfMap(folderEntries);

  const albumsOnlyNames = folderEntries
    .filter(([, f]) => f.albumsOnly === true)
    .map(([name]) => name);

  const sources = albumsOnlyNames.map(name =>
    _makeSourceEntry(name, folders[name], parentOf[name], folders)
  );

  // Fallback: if nothing is marked albumsOnly, find any root with an Albums/ subdir.
  // Skip roots where the Albums/ subdirectory is already explicitly registered
  // as its own vpath (regardless of that vpath's albumsOnly setting).
  if (sources.length === 0) {
    const explicitRoots = new Set(folderEntries.map(([, f]) => f.root.replace(/\/?$/, '')));
    const fallback = await _findAlbumsFallback(folderEntries, parentOf, explicitRoots);
    if (fallback) sources.push(fallback);
  }

  _sourcesCache = sources;
  return sources;
}

// DLNA source selection is explicit per-vpath via dlnaEnabled.
// Backward compatibility: if no vpath has a dlnaEnabled key yet, reuse
// the legacy albumsOnly source selection so existing installs keep working.
export async function resolveDlnaSources() {
  if (_dlnaSourcesCache) return _dlnaSourcesCache;

  const folders = config.program?.folders || {};
  const folderEntries = Object.entries(folders);
  const parentOf = _buildParentOfMap(folderEntries);
  const hasExplicitDlnaFlag = folderEntries.some(([, f]) => f.dlnaEnabled !== undefined);

  const dlnaNames = hasExplicitDlnaFlag
    ? folderEntries
      .filter(([, f]) => f.dlnaEnabled === true && f.type !== 'recordings' && f.type !== 'youtube' && f.type !== 'excluded')
      .map(([name]) => name)
    : folderEntries
      .filter(([, f]) => f.albumsOnly === true)
      .map(([name]) => name);

  const sources = dlnaNames.map(name =>
    _makeSourceEntry(name, folders[name], parentOf[name], folders)
  );

  _dlnaSourcesCache = sources;
  return sources;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

function md5(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function extractYear(name) {
  const m = name.match(/\((\d{4})\)/) || name.match(/^(\d{4})\s*[-–]/);
  return m ? m[1] : null;
}

function extractArtist(name) {
  const i = name.indexOf(' - ');
  return i > 0 ? name.slice(0, i).trim() : null;
}

function extractTrackNumber(filename) {
  const base = path.basename(filename, path.extname(filename));
  const m = base.match(/^(\d+)/);
  return m ? Number.parseInt(m[1], 10) : null;
}

function cleanTrackName(filename) {
  return path.basename(filename, path.extname(filename))
    .replace(/^\d+\.?\s*[-–]?\s*/, '')
    .trim() || path.basename(filename, path.extname(filename));
}

function isDiscFolder(name) {
  return DISC_RE.test(name) || DISC_SUFFIX_RE.test(name) || NUMERIC_DISC_RE.test(name);
}

// ── DB-driven tree builder ─────────────────────────────────────────────────────
// No filesystem access for structure — entirely from DB filepath strings.
// Strategy: BOTTOM-UP — read backwards from the file to determine structure.
//   • Immediate parent = disc folder (CD1, Disc 2, …)?  → album = grandparent
//   • Otherwise                                          → album = immediate parent
//   • Artist = one folder above the album (any depth)
//   • Everything above artist (genre, era, …) is preserved in the path for
//     display/art but does NOT affect album grouping logic.

function buildTrackListFromEntries(entries, source) {
  return entries
    .sort((a, b) =>
      ((a.row.track || 999) - (b.row.track || 999)) ||
      _collNumeric.compare(a.parts.at(-1), b.parts.at(-1))
    )
    .map(e => {
      let cuepoints = [];
      try { if (e.row.cuepoints) cuepoints = JSON.parse(e.row.cuepoints); } catch { /* invalid JSON in cuepoints column — skip cue data */ }
      return {
        // Use dbVpath + original DB filepath so the URL always routes through the
        // parent/root vpath's static mount (avoids spaces-in-vpathName encoding issues).
        filepath  : source.dbVpath + '/' + e.row.filepath,
        title     : e.row.title   || cleanTrackName(e.parts.at(-1)),
        artist    : e.row.album_artist || e.row.artist || null,
        number    : e.row.track   || extractTrackNumber(e.parts.at(-1)),
        duration  : e.row.duration || null,
        aaFile    : e.row.aaFile  || null,
        cuepoints : cuepoints.length >= 2 ? cuepoints : [],
      };
    });
}

// Build a single album object from pre-grouped entry data.
// albumData = { albumPath, artistPath, directEntries[], discEntries: Map<label, entries[]> }
/** Pick aaFile, cover_file, and album_version from the first entries that have each */
function _pickArtFields(directEntries, discEntries) {
  const allEntries = [...directEntries, ...[...discEntries.values()].flat()];
  let aaFile = null, coverFile = null, albumVersion = null;
  for (const e of allEntries) {
    if (!aaFile && e.row.aaFile)              aaFile       = e.row.aaFile;
    if (!coverFile && e.row.cover_file)       coverFile    = e.row.cover_file;
    if (!albumVersion && e.row.album_version) albumVersion = e.row.album_version;
    if (aaFile && coverFile && albumVersion) break;
  }
  return { aaFile, coverFile, albumVersion };
}

/** Build the discs array (direct tracks + sorted disc sub-folders) */
function _buildDiscList(directEntries, discEntries, source) {
  const discs = [];
  if (directEntries.length > 0) {
    // If every direct entry carries its own CUE data (e.g. two FLAC+CUE pairs in the
    // same flat folder rather than in CD1/ CD2/ subfolders), treat each file as a
    // separate virtual disc so the client’s per-disc CUE expansion logic fires correctly.
    const allHaveCue = directEntries.length >= 2 && directEntries.every(e => {
      try { return e.row.cuepoints && JSON.parse(e.row.cuepoints).length >= 2; } catch { return false; }
    });
    if (allHaveCue) {
      // Sort by filename for consistent CD1-before-CD2 ordering
      const sorted = [...directEntries].sort((a, b) =>
        _collNumeric.compare(a.parts.at(-1), b.parts.at(-1))
      );
      for (const entry of sorted) {
        discs.push({ label: null, discIndex: discs.length + 1, tracks: buildTrackListFromEntries([entry], source) });
      }
    } else {
      discs.push({ label: null, discIndex: 1, tracks: buildTrackListFromEntries(directEntries, source) });
    }
  }
  if (discEntries.size > 0) {
    const sorted = [...discEntries.entries()].sort((a, b) => _collNumeric.compare(a[0], b[0]));
    let discIdx = discs.length + 1; // continues after any virtual CUE discs
    for (const [discLabel, entries] of sorted) {
      discs.push({ label: discLabel, discIndex: discIdx++, tracks: buildTrackListFromEntries(entries, source) });
    }
  }
  return discs;
}

function buildAlbumFromData(albumData, vpathName, seriesId, source) {
  const { albumPath, artistPath, categoryLabel, directEntries, discEntries } = albumData;
  const id          = md5(albumPath);
  const segs        = albumPath.split('/');
  const displayName = segs[segs.length - 1];
  const year        = extractYear(displayName) || null;

  // Artist: "Artist - Album" convention first, then the folder directly above the album.
  const artistDisplayName = artistPath ? artistPath.split('/').pop() : null;
  const artist = extractArtist(displayName) || artistDisplayName || null;

  const discs = _buildDiscList(directEntries, discEntries, source);
  const { aaFile, coverFile, albumVersion } = _pickArtFields(directEntries, discEntries);
  const artFile = coverFile ? albumPath + '/' + coverFile : null;

  // Collect COALESCE(album_artist, artist) DB tags with a majority-rule filter so the
  // client can match albums by actual artist tag even when the folder structure doesn't
  // reflect the artist name (e.g. "Cerrone 1980 -82" inside "Disco/Cerrone Discography/").
  // Only tags that appear on MORE THAN HALF the album's tracks are included — this prevents
  // a single guest-artist track on a Various Artists compilation from causing that album to
  // match the guest artist in profile album matching.
  const tagCounts = new Map();
  let tagTotalEntries = 0;
  for (const e of directEntries) {
    const tag = e.row.album_artist || e.row.artist;
    if (tag) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    tagTotalEntries++;
  }
  for (const [, entries] of discEntries) {
    for (const e of entries) {
      const tag = e.row.album_artist || e.row.artist;
      if (tag) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      tagTotalEntries++;
    }
  }
  const _majorityTags = tagTotalEntries > 0
    ? [...tagCounts.entries()].filter(([, c]) => c > tagTotalEntries / 2).map(([t]) => t)
    : [];
  const rawArtistTags = _majorityTags.length ? _majorityTags : null;

  return {
    id, path: albumPath, displayName, artist, year, artFile, aaFile,
    album_version : albumVersion || null,
    categoryLabel : categoryLabel || null,
    seriesId      : seriesId || null,
    discs,
    sourceVpath   : vpathName || null,
    rawArtistTags,
    _artRoot      : source?.artRoot || null,
    _artPrefix    : source?.prefix || null,
  };
}

// Bottom-up tree builder: works from the file backwards to determine structure.
//   • Immediate parent = disc folder?  → album = grandparent, disc = parent
//   • Otherwise                        → album = immediate parent, no disc split
//   • Artist = folder one level above the album (any depth from root)
//   • Category folders (configured in albumCategoryFolders) are "see-through" —
//     when one appears as a segment in the artist path (e.g. Artist/[Live]/Album)
//     it is stripped from the artist path so albums still group under the real
//     artist. The category name is stored on each album as categoryLabel.
//   • Everything above the artist (genre, era, …) is preserved in the path for
//     display/art resolution but does NOT affect album grouping logic.

/** Process one DB row into album path info. Returns null for bare root files. */
function _processRowIntoAlbum(row, prefixLen, prefixBase, categoryFolderSet) {
  const treePath = prefixLen > 0 ? row.filepath.slice(prefixLen) : row.filepath;
  const parts    = treePath.split('/');
  if (parts.length < 2) return null;

  const immediateParent = parts[parts.length - 2];
  let discLabel = null, albumDepth;
  if (parts.length >= 3 && isDiscFolder(immediateParent)) {
    discLabel  = immediateParent;
    albumDepth = parts.length - 3;
  } else {
    albumDepth = parts.length - 2;
  }

  // Pre-compute path prefix once (avoids a nested ternary for artistPath below)
  const pfx           = prefixBase ? prefixBase + '/' : '';
  const albumRelParts = parts.slice(0, albumDepth + 1);
  const albumPath     = pfx + albumRelParts.join('/');

  const artistRelParts = parts.slice(0, albumDepth);
  let categoryLabel = null;
  let effectiveArtistParts = artistRelParts;
  if (categoryFolderSet.size > 0 && artistRelParts.length > 0) {
    for (let ci = artistRelParts.length - 1; ci >= 0; ci--) {
      if (categoryFolderSet.has(artistRelParts[ci])) {
        categoryLabel        = artistRelParts[ci];
        effectiveArtistParts = artistRelParts.slice(0, ci);
        break;
      }
    }
  }
  const artistPath = effectiveArtistParts.length > 0
    ? pfx + effectiveArtistParts.join('/')
    : null;

  return { albumPath, artistPath, categoryLabel, discLabel, entry: { row, parts, originalFilepath: row.filepath } };
}

/** Build artistPath → albumPaths[] map from the byAlbum map. */
function _groupByArtist(byAlbum) {
  const byArtist = new Map();
  for (const albumPath of byAlbum.keys()) {
    const artistKey = byAlbum.get(albumPath).artistPath || '';
    if (!byArtist.has(artistKey)) byArtist.set(artistKey, []);
    byArtist.get(artistKey).push(albumPath);
  }
  return byArtist;
}

/** Build the final albums[] and series[] arrays from the grouped artist map. */
function _buildSeriesAndAlbums(byArtist, byAlbum, vpathName, source) {
  const albums = [], series = [];
  for (const [artistKey, albumPaths] of [...byArtist.entries()].sort((a, b) => _collBase.compare(a[0], b[0]))) {
    const sortedPaths = albumPaths.sort((a, b) => _collBase.compare(a, b));
    if (!artistKey || sortedPaths.length === 1) {
      for (const albumPath of sortedPaths) {
        albums.push(buildAlbumFromData(byAlbum.get(albumPath), vpathName, null, source));
      }
    } else {
      const seriesId       = md5(artistKey);
      const seriesAlbumIds = [];
      for (const albumPath of sortedPaths) {
        const album = buildAlbumFromData(byAlbum.get(albumPath), vpathName, seriesId, source);
        albums.push(album);
        seriesAlbumIds.push(album.id);
      }
      series.push({
        id          : seriesId,
        path        : artistKey,
        displayName : artistKey.split('/').pop(),
        artFile     : null,
        aaFile      : null,
        albumIds    : seriesAlbumIds,
        sourceVpath : vpathName,
      });
    }
  }
  return { albums, series };
}

function buildTreeFromDB(dbRows, source) {
  const prefixLen = source.prefix ? source.prefix.length : 0;
  const vpathName = source.vpathName;
  const prefixBase = source.prefix ? source.prefix.replace(/\/$/, '') : null; // e.g. "Albums"
  const categoryFolderSet = new Set(config.program?.albumCategoryFolders || []);

  // Map: albumPath → { albumPath, artistPath, directEntries[], discEntries: Map<label, entries[]> }
  const byAlbum = new Map();

  for (const row of dbRows) {
    const result = _processRowIntoAlbum(row, prefixLen, prefixBase, categoryFolderSet);
    if (!result) continue;
    const { albumPath, artistPath, categoryLabel, discLabel, entry } = result;
    if (!byAlbum.has(albumPath)) {
      byAlbum.set(albumPath, { albumPath, artistPath, categoryLabel, directEntries: [], discEntries: new Map() });
    }
    const albumEntry = byAlbum.get(albumPath);
    if (discLabel) {
      if (!albumEntry.discEntries.has(discLabel)) albumEntry.discEntries.set(discLabel, []);
      albumEntry.discEntries.get(discLabel).push(entry);
    } else {
      albumEntry.directEntries.push(entry);
    }
  }

  // Group albums by their artistPath to form series, then build the output arrays
  const byArtist = _groupByArtist(byAlbum);
  return _buildSeriesAndAlbums(byArtist, byAlbum, vpathName, source);
}

// ── Art resolution (parallel filesystem checks) ────────────────────────────────
// artRoot per album comes from source.artRoot stored in album._artRoot
async function resolveArt(albums, series) {
  // Build O(1) ID → album map
  const byId = new Map(albums.map(a => [a.id, a]));

  // ── Step 1: Propagate series art directly from member DB data (zero FS calls) ──
  // Series cards in the browser only need one image — take it from the first member
  // that already has aaFile or artFile in the DB, no filesystem probing required.
  for (const s of series) {
    const firstWithArt = s.albumIds.map(id => byId.get(id)).find(a => a?.aaFile || a?.artFile);
    s.aaFile  = firstWithArt?.aaFile  || null;
    s.artFile = firstWithArt?.artFile || null;
  }

  // ── Step 2: FS art checks — standalone albums only, and only if they have no DB art ──
  // Series members are excluded entirely: their individual art is irrelevant in the
  // browse view (only the series-level art shown above matters).

  await Promise.allSettled(
    albums
      .filter(a => !a.aaFile && !a.artFile && a._artRoot)
      .map(async album => {
        // Strip source prefix before joining with artRoot to avoid double-segment path.
        // e.g. artRoot=/media/music/Albums, album.path="Albums/Artist" → strip "Albums/" → "Artist"
        const relPath    = (album._artPrefix && album.path.startsWith(album._artPrefix))
          ? album.path.slice(album._artPrefix.length)
          : album.path;
        let folderPath;
        try {
          folderPath = resolvePathWithinRoot(album._artRoot, relPath);
        } catch {
          return;
        }
        for (const name of ART_NAMES) {
          try {
            await fsp.access(resolvePathWithinRoot(folderPath, name), fs.constants.R_OK);
            album.artFile = album.path + '/' + name;
            return;
          } catch { /* art filename not found — try next candidate */ }
        }
        // Try art inside first disc sub-folder (for multi-disc albums with no root art)
        const firstDisc = album.discs.find(d => d.label);
        if (firstDisc) {
          let discPath;
          try {
            discPath = resolvePathWithinRoot(folderPath, firstDisc.label);
          } catch {
            return;
          }
          for (const name of ART_NAMES) {
            try {
              await fsp.access(resolvePathWithinRoot(discPath, name), fs.constants.R_OK);
              album.artFile = album.path + '/' + firstDisc.label + '/' + name;
              return;
            } catch { /* art filename not found in disc folder — try next candidate */ }
          }
        }
      })
  );
}

// ── set-art helpers ────────────────────────────────────────────────────────────

async function _resolveAlbumDir(albumPath) {
  const sources = await resolveAlbumsSources();
  for (const source of sources) {
    const relPath   = (source.prefix && albumPath.startsWith(source.prefix))
      ? albumPath.slice(source.prefix.length)
      : albumPath;
    const candidate    = path.resolve(source.artRoot, relPath);
    const rootResolved = path.resolve(source.artRoot);
    if (candidate !== rootResolved && !candidate.startsWith(rootResolved + path.sep)) continue;
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch { /* directory not found — try next source */ }
  }
  return null;
}

async function _downloadCoverImage(body) {
  if (body.releaseId) return getReleaseCoverBuf(body.releaseId);
  return fetchPublicUrlBuffer(body.coverUrl, {
    headers: { 'User-Agent': 'Velvet/dev +https://github.com/aroundmyroom/Velvet' },
  });
}

async function _writeJpeg(imgBuf, coverPath) {
  const { default: sharp } = await import('sharp');
  await sharp(imgBuf)
    .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toFile(coverPath);
}

/** Populate `_cacheFull` (detail map) if it's not yet built. */
async function _rebuildFullCacheIfNeeded() {
  if (_cacheFull) return;
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL) return;
  const sources = await resolveAlbumsSources();
  if (!sources.length) return;
  const allAlbums = [], allSeries = [];
  for (const source of sources) {
    const rows = db.getFilesForAlbumsBrowse([{ vpath: source.dbVpath, prefix: source.prefix }]);
    const { albums, series } = buildTreeFromDB(rows, source);
    allAlbums.push(...albums);
    allSeries.push(...series);
  }
  await resolveArt(allAlbums, allSeries);
  const fullAlbums = allAlbums.map(({ _artRoot, _artPrefix, ...a }) => a);
  _cacheFull = new Map(fullAlbums.map(a => [a.id, a]));
  if (!_cache) {
    const albums = fullAlbums.map(({ discs, ...a }) => ({
      ...a, discCount: discs.length, totalTracks: discs.reduce((n, d) => n + d.tracks.length, 0)
    }));
    _cache = { albums, series: allSeries };
    _cacheTs = Date.now();
  }
}

/**
 * For single-track discs with no cuepoints, re-check the sidecar .cue file on
 * disk so the user sees the result immediately without a full rescan.
 * Mutates `album.discs[*].tracks[0]` in place.
 */
function _applyLiveCueFixes(album) {
  const folders = config.program.folders;
  for (const disc of album.discs || []) {
    if (disc.tracks.length !== 1) continue;
    const track = disc.tracks[0];
    if (track.cuepoints && track.cuepoints.length >= 2) continue;
    const fpParts   = track.filepath.split('/');
    const vpathName = fpParts[0];
    const relPath   = fpParts.slice(1).join('/');
    const vpathCfg  = folders[vpathName];
    if (!vpathCfg) continue;
    const fullPath = resolvePathWithinRoot(vpathCfg.root, relPath);
    const { cuepoints, hasCueFile } = _checkSidecarCue(fullPath);
    if (cuepoints.length >= 2) {
      track.cuepoints = cuepoints;
      try { db.updateFileCue(relPath, vpathName, JSON.stringify(cuepoints)); } catch { /* DB write failed — cue data will be re-read on next request */ }
    } else if (hasCueFile) {
      track.cueInvalid = true;
    }
  }
}

// ── Setup ──────────────────────────────────────────────────────────────────────

export function setup(velvet) {
  // ── GET /api/v1/albums/browse ──────────────────────────────────────────────
  // Returns slim album objects (no track lists) for fast initial load.
  // Track data is fetched on demand via /api/v1/albums/detail?id=<albumId>.
  velvet.get('/api/v1/albums/browse', async (req, res) => {
    try {
      const now = Date.now();
      if (_cache && now - _cacheTs < CACHE_TTL) {
        return res.json(_cache);
      }

      const sources = await resolveAlbumsSources();
      if (!sources.length) {
        return res.json({ albums: [], series: [], error: 'No albumsOnly vpath or Albums/ folder found' });
      }

      // For each source, query DB rows filtered to that source and build a partial tree
      const allAlbums = [];
      const allSeries = [];

      for (const source of sources) {
        const rows = db.getFilesForAlbumsBrowse([{ vpath: source.dbVpath, prefix: source.prefix }]);
        const { albums, series } = buildTreeFromDB(rows, source);
        allAlbums.push(...albums);
        allSeries.push(...series);
      }

      // Resolve art files in parallel across all albums
      await resolveArt(allAlbums, allSeries);

      // Build full detail cache (id → album) including disc/track data
      const fullAlbums = allAlbums.map(({ _artRoot, _artPrefix, ...a }) => a);
      _cacheFull = new Map(fullAlbums.map(a => [a.id, a]));

      // Slim browse response: strip discs array, keep discCount + totalTracks only
      const albums = fullAlbums.map(({ discs, ...a }) => ({
        ...a,
        discCount   : discs.length,
        totalTracks : discs.reduce((n, d) => n + d.tracks.length, 0),
      }));
      const series = allSeries;

      _cache   = { albums, series };
      _cacheTs = Date.now();

      res.json(_cache);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/v1/albums/detail ──────────────────────────────────────────────
  // Returns the full album object including disc/track lists for a single album.
  // Called client-side when the user opens an album detail view.
  velvet.get('/api/v1/albums/detail', async (req, res) => {
    try {
      const id = req.query.id;
      if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing id' });

      // Rebuild cache if needed (e.g. after restart before first browse call)
      await _rebuildFullCacheIfNeeded();

      if (!_cacheFull?.has(id)) {
        return res.status(404).json({ error: 'Album not found' });
      }

      // Deep-enough clone so we can patch cuepoints without mutating the cache
      const album = structuredClone(_cacheFull.get(id));

      // ── Live sidecar CUE check ─────────────────────────────────────────────
      // For any single-track disc that has no cuepoints yet, re-read the sidecar
      // .cue file from disk. This picks up CUE files the user fixed after the
      // last scan, without requiring a full rescan.
      _applyLiveCueFixes(album);

      res.json(album);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/v1/albums/art-file ────────────────────────────────────────────
  // Serves a filesystem image (cover.jpg etc.) identified by its relative path
  // as returned in the artFile field of the browse response.
  // The `p` query param is e.g. "Albums/Artist - Title/cover.jpg"
  // We try every known albumsOnly artRoot until one resolves.
  velvet.get('/api/v1/albums/art-file', async (req, res) => {
    try {
      const p = req.query.p;
      if (!p || typeof p !== 'string') {
        return res.status(400).json({ error: 'Missing p' });
      }
      if (!/\.(jpe?g|png|webp|gif)$/i.test(p)) {
        return res.status(400).json({ error: 'Not an image' });
      }

      const sources = await resolveAlbumsSources();

      for (const source of sources) {
        const artRoot  = source.artRoot;
        // Strip source prefix from p if present (same issue as set-art):
        // p is e.g. "Albums/Artist/cover.jpg" but artRoot already points inside Albums/
        const relP     = (source.prefix && p.startsWith(source.prefix))
          ? p.slice(source.prefix.length)
          : p;
        const resolved     = path.resolve(artRoot, relP);
        const rootResolved = path.resolve(artRoot);
        // Security: stay inside this artRoot
        if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
          continue;
        }
        try {
          await fsp.access(resolved, fs.constants.R_OK);
          return res.sendFile(resolved);
        } catch { /* art file not accessible — try next source */ }
      }

      res.status(404).json({ error: 'Not found' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/v1/albums/set-art ───────────────────────────────────────────
  // Admin only. Downloads a cover image and writes it as cover.jpg inside the
  // album folder on disk.  albumPath is the `album.path` value from the browse
  // response (relative to artRoot, e.g. "Albums/Artist - Title (1990)").
  // Supply either releaseId (Discogs) or coverUrl (Deezer, iTunes, URL paste).
  velvet.post('/api/v1/albums/set-art', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    const schema = Joi.object({
      albumPath : Joi.string().required(),
      releaseId : Joi.number().integer(),
      coverUrl  : Joi.string().uri({ scheme: ['http', 'https'] }),
    }).or('releaseId', 'coverUrl');
    try { joiValidate(schema, req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

    const albumPath = req.body.albumPath;

    // Resolve album folder (strips source prefix to avoid doubling it against artRoot)
    const albumDir = await _resolveAlbumDir(albumPath);
    if (!albumDir) return res.status(404).json({ error: 'Album folder not found' });

    // Download the image
    let imgBuf;
    try { imgBuf = await _downloadCoverImage(req.body); } catch (e) {
      return res.status(502).json({ error: 'Failed to download image: ' + e.message });
    }

    // Convert to JPEG and write as cover.jpg
    const coverPath = path.join(albumDir, 'cover.jpg');
    try { await _writeJpeg(imgBuf, coverPath); } catch (e) {
      return res.status(500).json({ error: 'Failed to save cover: ' + e.message });
    }

    // Invalidate browse cache so next request returns fresh artFile paths
    invalidateCache();
    res.json({ artFile: albumPath.replaceAll('\\', '/') + '/cover.jpg' });
  });
}
