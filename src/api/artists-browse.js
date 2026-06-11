/**
 * artists-browse.js — Artist Library
 *
 * Home-style landing page + letter browse + search + per-artist profile.
 * All artist counts are precomputed in artists_normalized.song_count during
 * rebuildArtistIndex() — no expensive runtime joins with the files table.
 *
 * Endpoints:
 *   GET  /api/v1/artists/home            → { totalCount, topArtists[], recentArtists[] }
 *   GET  /api/v1/artists/letter?l=A      → { artists[] }  (0 = all digits)
 *   GET  /api/v1/artists/search?q=       → { artists[] }
 *   GET  /api/v1/artists/profile?key=    → { canonicalName, bio, imageFile, releaseCategories[] }
 *   POST /api/v1/artists/fetch-info      → trigger Last.fm/MusicBrainz fetch (admin)
 *   POST /api/v1/artists/set-image       → set custom artist image (admin)
 *   POST /api/v1/artists/set-name        → override canonical name (admin)
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import sharp from 'sharp';
import busboy from 'busboy';
import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { getDirname } from '../util/esm-helpers.js';

const __dirname = getDirname(import.meta.url);

// ── Constants ─────────────────────────────────────────────────────────────────

const CACHE_TTL              = 5 * 60 * 1000; // 5 minutes
const ARTIST_IMG_DIR         = path.join(__dirname, '../../image-cache', 'artists');
const ARTIST_PLACEHOLDER_FILE = path.join(__dirname, '../../image-cache', 'artist-placeholder.jpg');
const ARTIST_IMG_SIZE        = 400; // square JPEG size for stored artist images
const HYDRATE_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours
const HYDRATE_QUEUE_LIMIT = 50000;
const HYDRATE_DELAY_OK_MS = 1400;
const HYDRATE_DELAY_IDLE_MS = 2200;
const HYDRATE_DELAY_ERR_MS = 4000;

// ── Cache ─────────────────────────────────────────────────────────────────────
// Cache only the home stats (cheap to hold; letter/search queries are fast too)

let _homeCache   = null;
let _homeCacheTs = 0;

// Background queue: prioritize home-shelf artists for image hydration.
const _imgHydrateQueue = [];
let _imgHydrateRunning = false;
const _imgHydrateQueued = new Set();
const _imgHydrateLastTry = new Map(); // artistKey -> timestamp
const _imgHydrateStats = {
  startedAt: Date.now(),
  enqueued: 0,
  dropped: 0,
  processed: 0,
  succeeded: 0,
  noImage: 0,
  failed: 0,
  lastRunAt: 0,
  lastSuccessAt: 0,
  lastErrorAt: 0,
  lastError: null,
  lastArtist: null,   // name of artist currently being processed
  recentLog: [],      // rolling last-20 [{name, result, ts}]
};

export function invalidateArtistCache() {
  _homeCache   = null;
  _homeCacheTs = 0;
}

// ── Image directory ───────────────────────────────────────────────────────────

try { fs.mkdirSync(ARTIST_IMG_DIR, { recursive: true }); } catch (e) { console.debug('[velvet]', e?.message ?? e); }

// ── Boot migration: move images from legacy cwd-based path ───────────────────
// Older versions resolved ARTIST_IMG_DIR using process.cwd() instead of
// __dirname. When run via systemd without WorkingDirectory, cwd = '/' and images
// ended up at /image-cache/artists/ instead of /home/Velvet/image-cache/artists/.
// On first boot after the fix, we detect and migrate those files automatically.
await (async () => {
  const legacyDir         = path.join(process.cwd(), 'image-cache', 'artists');
  const legacyPlaceholder = path.join(process.cwd(), 'image-cache', 'artist-placeholder.jpg');
  if (legacyDir === ARTIST_IMG_DIR) return; // paths identical — nothing to do

  let files;
  try { files = await fsp.readdir(legacyDir); } catch { return; } // legacy dir doesn't exist
  if (!files.length) return;

  console.log(`[artists-browse] Migrating ${files.length} artist image(s) from ${legacyDir} → ${ARTIST_IMG_DIR}`);
  let moved = 0, skipped = 0;
  for (const f of files) {
    const src = path.join(legacyDir, f);
    const dst = path.join(ARTIST_IMG_DIR, f);
    try {
      // Skip if destination already exists (don't overwrite newer files)
      await fsp.access(dst);
      skipped++;
    } catch {
      try { await fsp.rename(src, dst); moved++; } catch { /* cross-device: try copy+delete */
        try {
          await fsp.copyFile(src, dst);
          await fsp.unlink(src);
          moved++;
        } catch { console.warn(`[artists-browse] Could not migrate ${f}:`, _e3.message); }
      }
    }
  }
  // Migrate placeholder too
  try {
    await fsp.access(ARTIST_PLACEHOLDER_FILE);
  } catch {
    try { await fsp.rename(legacyPlaceholder, ARTIST_PLACEHOLDER_FILE); } catch {
      try { await fsp.copyFile(legacyPlaceholder, ARTIST_PLACEHOLDER_FILE); await fsp.unlink(legacyPlaceholder); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }
  }
  console.log(`[artists-browse] Migration done: ${moved} moved, ${skipped} already present`);
})();

// ── Profile builder ───────────────────────────────────────────────────────────
// Builds the artist profile (release categories) from raw file rows.
// Release categories are keyed by L1 folder name — fully generic.

function buildProfile(fileRows, canonicalName) {
  // Group by L1 folder → release folder (L2 path segment)
  // fileRows each have: filepath, vpath, title, artist, album, track, disk,
  //   year, duration, aaFile, cover_file

  const categories = new Map(); // l1 → Map<releaseFolder, { artFile, aaFile, tracks[] }>

  for (const row of fileRows) {
    const parts = row.filepath.split('/');
    if (parts.length < 2) continue; // bare file at vpath root — skip

    const l1 = parts[0];
    const releaseFolder = parts.length >= 3 ? parts[1] : null; // L2 segment
    if (!releaseFolder) continue; // just l1/filename — skip

    if (!categories.has(l1)) categories.set(l1, new Map());
    const relMap = categories.get(l1);

    if (!relMap.has(releaseFolder)) {
      relMap.set(releaseFolder, {
        folder: releaseFolder,
        artFile: null,
        aaFile: null,
        year: null,
        tracks: [],
      });
    }

    const rel = relMap.get(releaseFolder);
    if (!rel.artFile && row.cover_file) {
      // Build artFile path relative to vpath root for the images API
      rel.artFile = row.vpath + '/' + l1 + '/' + releaseFolder + '/' + row.cover_file;
    }
    if (!rel.aaFile && row.aaFile) rel.aaFile = row.aaFile;
    if (!rel.year && row.year) rel.year = row.year;

    rel.tracks.push({
      filepath : row.vpath + '/' + row.filepath,
      title    : row.title || null,
      artist   : row.artist || canonicalName,
      track    : row.track  || null,
      disk     : row.disk   || null,
      duration : row.duration || null,
      aaFile   : row.aaFile || null,
      cuepoints: row.cuepoints ? (() => { try { return JSON.parse(row.cuepoints); } catch { return []; } })() : [],
    });
  }

  // Sort tracks within each release by disk → track → filepath
  const result = [];
  for (const [l1, relMap] of categories) {
    const releases = [];
    for (const [, rel] of relMap) {
      rel.tracks.sort((a, b) => {
        if ((a.disk || 0) !== (b.disk || 0)) return (a.disk || 0) - (b.disk || 0);
        if ((a.track || 0) !== (b.track || 0)) return (a.track || 0) - (b.track || 0);
        return (a.filepath || '').localeCompare(b.filepath || '');
      });
      releases.push(rel);
    }
    // Sort releases within category by year (asc), then folder name
    releases.sort((a, b) => {
      if (a.year && b.year && a.year !== b.year) return a.year - b.year;
      return a.folder.localeCompare(b.folder);
    });
    result.push({ category: l1, releases });
  }

  // Sort categories by total track count descending (most content first)
  result.sort((a, b) => {
    const ca = a.releases.reduce((s, r) => s + r.tracks.length, 0);
    const cb = b.releases.reduce((s, r) => s + r.tracks.length, 0);
    return cb - ca;
  });

  return result;
}

// ── Fetch bio + image from Last.fm / MusicBrainz ──────────────────────────────

function stripHtml(str) {
  return (str || '').replaceAll(/<[^>]+>/g, '').replaceAll(/\s+/g, ' ').trim();
}

function downloadBuffer(url, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 5) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, res => {
      // Follow 301/302/307/308 redirects
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        const location = res.headers.location;
        res.resume();
        if (!location) return reject(new Error(`Redirect with no Location from ${url}`));
        const next = location.startsWith('http') ? location : new URL(location, url).href;
        return resolve(downloadBuffer(next, _redirects + 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function downloadJson(url, headers = null, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const opts = { headers: { connection: 'close', ...headers } };
    const req = mod.get(url, opts, res => {
      if (res.statusCode !== 200) {
        res.resume(); // drain to free socket
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms: ${url}`));
    });
    req.on('error', reject);
  });
}

function isLastfmPlaceholder(url) {
  if (!url) return true;
  const u = String(url).toLowerCase();
  return (
    u.includes('/2a96cbd8b46e442fc41c2b86b821562f') ||
    u.includes('lastfm.freetls.fastly.net/i/u/avatar170s') ||
    u.includes('noimage') ||
    u.endsWith('/0.png')
  );
}

function discogsHeaders() {
  const d = config.program?.discogs || {};
  if (!d.enabled || !d.apiKey || !d.apiSecret) return null;
  const ua = d.userAgentTag
    ? `Velvet/dev/${d.userAgentTag} +https://github.com/aroundmyroom/Velvet`
    : 'Velvet/dev +https://github.com/aroundmyroom/Velvet';
  return {
    'User-Agent': ua,
    'Authorization': `Discogs key=${d.apiKey}, secret=${d.apiSecret}`,
  };
}

function discogsStatus() {
  const d = config.program?.discogs || {};
  return {
    enabled: !!d.enabled,
    hasApiCredentials: !!(d.apiKey && d.apiSecret),
  };
}

async function fetchArtistImageFromDiscogs(artistName) {
  const headers = discogsHeaders();
  if (!headers || !artistName) return null;

  try {
    const q = encodeURIComponent(artistName);
    const search = await downloadJson(`https://api.discogs.com/database/search?type=artist&per_page=5&q=${q}`, headers);
    const results = Array.isArray(search?.results) ? search.results : [];
    if (!results.length) return null;

    const norm = s => String(s || '').toLowerCase().replaceAll(/\(\d+\)/g, '').replaceAll(/[^a-z0-9 ]/g, ' ').replaceAll(/\s+/g, ' ').trim();
    const target = norm(artistName);
    let best = results[0];
    let bestScore = -1;
    for (const r of results) {
      const t = norm(r?.title);
      let score = 0;
      if (t === target) score = 100;
      else if (t.includes(target) || target.includes(t)) score = 80;
      else if (target && t && (target.split(' ').some(w => w.length > 2 && t.includes(w)))) score = 60;
      if (score > bestScore) { best = r; bestScore = score; }
    }

    // First choice: resource images[] (usually best quality)
    if (best?.resource_url) {
      try {
        const detail = await downloadJson(best.resource_url, headers);
        const imgs = Array.isArray(detail?.images) ? detail.images : [];
        const primary = imgs.find(i => i?.uri) || imgs[0];
        if (primary?.uri) return primary.uri;
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }

    // Fallback: search result image fields
    if (best?.cover_image) return best.cover_image;
    if (best?.thumb) return best.thumb;
    return null;
  } catch {
    return null;
  }
}

async function searchDiscogsArtistCandidates(artistName, max = 8) {
  const headers = discogsHeaders();
  if (!headers || !artistName) return [];

  try {
    const q = encodeURIComponent(artistName);
    const search = await downloadJson(`https://api.discogs.com/database/search?type=artist&per_page=${Math.max(1, Math.min(20, max))}&q=${q}`, headers);
    const results = Array.isArray(search?.results) ? search.results : [];
    const out = [];
    for (const r of results) {
      let imageUrl = r?.cover_image || r?.thumb || null;
      if (r?.resource_url) {
        try {
          const detail = await downloadJson(r.resource_url, headers);
          const imgs = Array.isArray(detail?.images) ? detail.images : [];
          const primary = imgs.find(i => i?.uri) || imgs[0];
          if (primary?.uri) imageUrl = primary.uri;
        } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      }
      if (!imageUrl) continue;
      out.push({
        id: r?.id || null,
        title: r?.title || artistName,
        imageUrl,
        thumbUrl: r?.thumb || imageUrl,
        sourceUrl: r?.uri ? `https://www.discogs.com${r.uri}` : null,
      });
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchFromLastfm(artistName) {
  const lfm = config.program?.lastFM;
  if (!lfm?.apiKey) return null;

  const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getInfo&artist=${encodeURIComponent(artistName)}&api_key=${lfm.apiKey}&format=json`;
  try {
    const buf = await downloadBuffer(url);
    const data = JSON.parse(buf.toString());
    if (!data.artist) return null;

    const bio = stripHtml(data.artist?.bio?.summary || '').replace(/\s*Read more on Last\.fm\s*/i, '').trim() || null;

    // Find largest image (Last.fm returns array ordered small→large)
    const images = data.artist?.image || [];
    const imgUrl = [...images]
      .reverse()
      .map(img => img?.['#text'])
      .find(u => u && !isLastfmPlaceholder(u)) || null;

    return { bio, imageUrl: imgUrl };
  } catch {
    return null;
  }
}

// Parse a TADB artist object into our enrichment shape
function _parseTadbArtist(a) {
  if (!a) return null;
  let bio = null;
  if (a.strBiographyEN) {
    bio = a.strBiographyEN
      .replace(/\s*See also:.*$/is, '')
      .replace(/\s*Read more at Last\.fm.*$/is, '')
      .trim() || null;
  }
  return {
    imageUrl:   a.strArtistThumb   || null,
    fanartUrl:  a.strArtistFanart  || a.strArtistFanart2 || a.strArtistFanart3 || null,
    bio,
    genre:      a.strGenre         || null,
    country:    a.strCountry       || null,
    formedYear: a.intFormedYear    ? Number.parseInt(a.intFormedYear, 10) || null : null,
    mbid:       a.strMusicBrainzID || null,
  };
}

// Fetch artist data from TheAudioDB.
// Strategy: if mbid is provided, try the precise MBID endpoint first
// (artist-mb.php?i=<mbid>) — no name ambiguity. Fall back to name search.
async function fetchFromTheAudioDB(artistName, mbid = null) {
  try {
    // 1. MBID-first: precise lookup
    if (mbid) {
      const url = `https://www.theaudiodb.com/api/v1/json/2/artist-mb.php?i=${encodeURIComponent(mbid)}`;
      const data = await downloadJson(url);
      const a = data?.artists?.[0];
      if (a) return _parseTadbArtist(a);
      // MBID not found in TADB — fall through to name search
    }
    // 2. Name-based fallback
    const url = `https://www.theaudiodb.com/api/v1/json/2/search.php?s=${encodeURIComponent(artistName)}`;
    const data = await downloadJson(url);
    return _parseTadbArtist(data?.artists?.[0]);
  } catch {
    return null;
  }
}

async function saveFanartImage(artistKey, fanartUrl) {
  try {
    const buf     = await downloadBuffer(fanartUrl);
    const outName = artistKey.replaceAll(/[^a-z0-9_-]/g, '_') + '_fanart.jpg';
    const outPath = path.join(ARTIST_IMG_DIR, outName);
    // Preserve wide aspect ratio — resize to 1280 wide, crop height to 480 (16:5)
    // Use 'top' so heads/faces at the top of the image are not cropped out
    await sharp(buf)
      .resize(1280, 480, { fit: 'cover', position: 'top' })
      .jpeg({ quality: 88 })
      .toFile(outPath);
    return outName;
  } catch {
    return null;
  }
}

async function fetchFromMusicBrainz(artistName) {
  const url = `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent(artistName)}&fmt=json&limit=1`;
  try {
    // MusicBrainz requires a User-Agent but node's https does fine for one-offs
    const buf = await downloadBuffer(url);
    const data = JSON.parse(buf.toString());
    const artist = data.artists?.[0];
    if (!artist) return null;

    const lifeSpanEnd = artist['life-span']?.end ? ` to ${artist['life-span'].end}` : '';
    const parts = [
      artist.disambiguation ? `Also known as: ${artist.disambiguation}.` : null,
      artist['life-span']?.begin ? `Active from ${artist['life-span'].begin}${lifeSpanEnd}.` : null,
      artist.area?.name ? `From ${artist.area.name}.` : null,
    ].filter(Boolean);

    return { bio: parts.join(' ') || null, imageUrl: null };
  } catch {
    return null;
  }
}

// Discogs returns a 1203-byte black 400×400 JPEG as a placeholder when an artist
// has no real image. Reject any download below this threshold.
const MIN_ARTIST_IMG_BYTES = 5000;

async function saveArtistImage(artistKey, imageUrl) {
  try {
    const buf     = await downloadBuffer(imageUrl);
    if (buf.length < MIN_ARTIST_IMG_BYTES) return null;
    const outName = artistKey.replaceAll(/[^a-z0-9_-]/g, '_') + '.jpg';
    const outPath = path.join(ARTIST_IMG_DIR, outName);
    await sharp(buf).resize(ARTIST_IMG_SIZE, ARTIST_IMG_SIZE, { fit: 'cover', position: 'top' }).jpeg({ quality: 85 }).toFile(outPath);
    return outName;
  } catch {
    _imgHydrateStats.lastError = `saveArtistImage(${artistKey}): ${_e.message}`;
    _imgHydrateStats.lastErrorAt = Date.now();
    return null;
  }
}

async function _hydrateArtistImage(artistKey, canonicalName) {
  const key = String(artistKey || '').toLowerCase().trim();
  if (!key) return 'skip';

  const now = Date.now();
  const lastTry = _imgHydrateLastTry.get(key) || 0;
  if (now - lastTry < HYDRATE_COOLDOWN_MS) return 'skip';
  _imgHydrateLastTry.set(key, now);

  const row = db.getArtistRow(canonicalName || artistKey);
  if (!row || row.imageFile) return 'skip';
  if (row.lastFetched) return 'skip';

  // Derive MBID on-demand if not yet stored (uses per-song AcoustID data)
  const mbid = row.mbid || db.deriveArtistMbidFromFiles(row.canonicalName);
  if (mbid && !row.mbid) db.saveArtistInfo(row.canonicalName, { mbid });

  // Fetch from all sources in parallel; TADB uses MBID-first lookup when available
  const [discogsUrl, tadb, lfm] = await Promise.all([
    fetchArtistImageFromDiscogs(row.canonicalName),
    fetchFromTheAudioDB(row.canonicalName, mbid),
    fetchFromLastfm(row.canonicalName),
  ]);

  // Bio priority: Last.fm > TheAudioDB (Last.fm bio is crowdsourced; TADB from Wikipedia)
  const bio = lfm?.bio || tadb?.bio || null;

  // Fanart: only from TADB
  let fanartFile = null;
  if (tadb?.fanartUrl) {
    fanartFile = await saveFanartImage(row.artistKey, tadb.fanartUrl);
  }

  if (!discogsUrl && !tadb?.imageUrl && !lfm?.imageUrl && !bio && !fanartFile && !tadb?.genre) {
    db.markArtistFetchAttempt(row.canonicalName);
    return 'no-image';
  }

  // Image priority: Discogs > TADB > Last.fm — try each in order until one saves successfully.
  // If a source returns a URL but the download is rejected (e.g. Discogs black placeholder),
  // fall through to the next source rather than giving up.
  let imageFile = null;
  let source    = null;
  const imageCandidates = [
    tadb?.imageUrl ? { url: tadb.imageUrl,   src: 'theaudiodb'  } : null,
    discogsUrl    ? { url: discogsUrl,       src: 'discogs'     } : null,
    lfm?.imageUrl  ? { url: lfm.imageUrl,    src: 'lastfm'      } : null,
  ].filter(Boolean);
  for (const candidate of imageCandidates) {
    imageFile = await saveArtistImage(row.artistKey, candidate.url);
    if (imageFile) { source = candidate.src; break; }
  }

  db.saveArtistInfo(row.canonicalName, {
    bio:        bio || row.bio || null,
    imageFile:  imageFile || null,
    imageSource: source || null,
    fanartFile,
    mbid:       tadb?.mbid || null,
    genre:      tadb?.genre || null,
    country:    tadb?.country || null,
    formedYear: tadb?.formedYear || null,
  });
  invalidateArtistCache();
  return imageFile ? 'success' : 'no-image';
}

function _enqueueHydration(artistKey, canonicalName) {
  const key = String(artistKey || '').toLowerCase().trim();
  if (!key || _imgHydrateQueued.has(key)) return;
  const row = db.getArtistRow(canonicalName || artistKey);
  if (!row || row.imageFile || row.lastFetched) return;
  if (_imgHydrateQueue.length >= HYDRATE_QUEUE_LIMIT) {
    _imgHydrateStats.dropped += 1;
    return;
  }
  _imgHydrateQueued.add(key);
  _imgHydrateQueue.push({ artistKey: key, canonicalName });
  _imgHydrateStats.enqueued += 1;
}

// Enqueue a no-image artist for a TheAudioDB-only retry pass.
function _enqueueHydrationTadb(artistKey, canonicalName, force = false) {
  const key = String(artistKey || '').toLowerCase().trim();
  // Use a tadb-namespaced key so it doesn't collide with normal queue entries
  const qKey = 'tadb:' + key;
  if (!key) return;
  // When force=true (user-initiated retry): remove from the in-memory queued set
  // so the artist can be re-added even if it was already processed this session.
  // Also clear the per-session cooldown entry so _hydrateArtistImageTadb won't skip it.
  if (force) {
    _imgHydrateQueued.delete(qKey);
    _imgHydrateLastTry.delete('tadb:' + key);
  }
  if (_imgHydrateQueued.has(qKey)) return;
  if (_imgHydrateQueue.length >= HYDRATE_QUEUE_LIMIT) {
    _imgHydrateStats.dropped += 1;
    return;
  }
  _imgHydrateQueued.add(qKey);
  _imgHydrateQueue.push({ artistKey: key, canonicalName, tadbOnly: true, force });
  _imgHydrateStats.enqueued += 1;
}

// Retry artists that previously got no-image, using TheAudioDB only.
// Retry / enrichment pass: TheAudioDB only.
// Used for artists that previously had no image, or that need the new enrichment
// fields (bio, fanart, genre, country, formedYear, mbid) added retroactively.
async function _hydrateArtistImageTadb(artistKey, canonicalName, force = false) {
  const key = String(artistKey || '').toLowerCase().trim();
  if (!key) return 'skip';

  const now = Date.now();
  const lastTry = _imgHydrateLastTry.get('tadb:' + key) || 0;
  // force=true (user-initiated): bypass the 12-hour in-memory session cooldown
  if (!force && now - lastTry < HYDRATE_COOLDOWN_MS) return 'skip';
  _imgHydrateLastTry.set('tadb:' + key, now);

  const row = db.getArtistRow(canonicalName || artistKey);
  if (!row) return 'skip';

  // Use MBID for precise TADB lookup when available
  const mbid = row.mbid || db.deriveArtistMbidFromFiles(row.canonicalName);
  if (mbid && !row.mbid) db.saveArtistInfo(row.canonicalName, { mbid });

  const tadb = await fetchFromTheAudioDB(row.canonicalName, mbid);
  if (!tadb || (!tadb.imageUrl && !tadb.bio && !tadb.fanartUrl && !tadb.genre)) {
    db.markArtistFetchAttempt(row.canonicalName);
    return 'no-image';
  }

  // Only download a new thumb if the artist doesn't already have an image
  let imageFile = row.imageFile || null;
  let source    = row.imageSource || null;
  if (!imageFile && tadb.imageUrl) {
    imageFile = await saveArtistImage(row.artistKey, tadb.imageUrl);
    if (imageFile) source = 'theaudiodb';
  }

  // Always download fanart if not yet cached
  let fanartFile = row.fanartFile || null;
  if (!fanartFile && tadb.fanartUrl) {
    fanartFile = await saveFanartImage(row.artistKey, tadb.fanartUrl);
  }

  db.saveArtistInfo(row.canonicalName, {
    bio:        tadb.bio || row.bio || null,
    imageFile:  imageFile || null,
    imageSource: source || null,
    fanartFile,
    mbid:       tadb.mbid   || null,
    genre:      tadb.genre  || null,
    country:    tadb.country || null,
    formedYear: tadb.formedYear || null,
  });
  invalidateArtistCache();
  return imageFile ? 'success' : 'no-image';
}

function _queueHomeImageHydration(stats) {
  const top = (stats.topArtists || []).slice(0, 50);
  const recent = (stats.recentArtists || []).slice(0, 50);
  const mostPlayed = (stats.mostPlayedArtists || []).slice(0, 50);
  for (const a of top) {
    if (!a || a.imageFile) continue;
    _enqueueHydration(a.artistKey, a.canonicalName);
  }
  for (const a of recent) {
    if (!a || a.imageFile) continue;
    _enqueueHydration(a.artistKey, a.canonicalName);
  }
  for (const a of mostPlayed) {
    if (!a || a.imageFile) continue;
    _enqueueHydration(a.artistKey, a.canonicalName);
  }
  _drainHydrationQueue().catch(() => {});
}

function _queueListImageHydration(artists, limit = 120) {
  const rows = Array.isArray(artists) ? artists.slice(0, limit) : [];
  for (const a of rows) {
    if (!a || a.imageFile) continue;
    _enqueueHydration(a.artistKey, a.canonicalName);
  }
  _drainHydrationQueue().catch(() => {});
}

async function _drainHydrationQueue() {
  if (_imgHydrateRunning) return;
  _imgHydrateRunning = true;
  try {
    while (_imgHydrateQueue.length > 0) {
      _imgHydrateStats.lastRunAt = Date.now();
      const item = _imgHydrateQueue.shift();
      if (!item) continue;
      _imgHydrateQueued.delete(item.artistKey);
      const displayName = item.canonicalName || item.artistKey;
      _imgHydrateStats.lastArtist = displayName;
      try {
        const result = item.tadbOnly
          ? await _hydrateArtistImageTadb(item.artistKey, item.canonicalName, item.force)
          : await _hydrateArtistImage(item.artistKey, item.canonicalName);
        _imgHydrateStats.processed += 1;
        if (result === 'success') {
          _imgHydrateStats.succeeded += 1;
          _imgHydrateStats.lastSuccessAt = Date.now();
        } else if (result === 'no-image') {
          _imgHydrateStats.noImage += 1;
        } else if (result === 'failed') {
          _imgHydrateStats.failed += 1;
          _imgHydrateStats.lastErrorAt = Date.now();
          _imgHydrateStats.lastError = 'image processing failed';
        }
        // Rolling log — keep last 20 entries
        _imgHydrateStats.recentLog.push({ name: displayName, result: result || 'skip', ts: Date.now() });
        if (_imgHydrateStats.recentLog.length > 20) _imgHydrateStats.recentLog.shift();
        let waitMs;
        if (result === 'success') waitMs = HYDRATE_DELAY_OK_MS;
        else if (result === 'no-image' || result === 'skip') waitMs = HYDRATE_DELAY_IDLE_MS;
        else waitMs = HYDRATE_DELAY_ERR_MS;
        await new Promise(r => setTimeout(r, waitMs));
      } catch {
        // non-fatal; continue queue
        _imgHydrateStats.processed += 1;
        _imgHydrateStats.failed += 1;
        _imgHydrateStats.lastErrorAt = Date.now();
        _imgHydrateStats.lastError = String(_e?.message || _e || 'hydrate error');
        await new Promise(r => setTimeout(r, HYDRATE_DELAY_ERR_MS));
      }
    }
  } finally {
    _imgHydrateRunning = false;
  }
}

function hydrationStatusSnapshot() {
  const discogs = discogsStatus();
  const elapsedMin = (_imgHydrateStats.startedAt > 0)
    ? Math.max(1, (Date.now() - _imgHydrateStats.startedAt) / 60000)
    : null;
  const throughput = elapsedMin && _imgHydrateStats.processed > 0
    ? Math.round(_imgHydrateStats.processed / elapsedMin * 10) / 10
    : null;
  return {
    running: _imgHydrateRunning,
    queueLength: _imgHydrateQueue.length,
    queueLimit: HYDRATE_QUEUE_LIMIT,
    throughputPerMin: throughput,
    delayMs: {
      ok: HYDRATE_DELAY_OK_MS,
      noImage: HYDRATE_DELAY_IDLE_MS,
      error: HYDRATE_DELAY_ERR_MS,
    },
    discogs,
    stats: {
      ..._imgHydrateStats,
      recentLog: [..._imgHydrateStats.recentLog],
    },
  };
}

function seedHydrationFromMissing(limit = 500) {
  const cap = Math.max(1, Math.min(100000, Number(limit) || 500));
  const rows = db.getArtistsNeedingFetch(cap);
  let enqueued = 0;
  for (const a of rows) {
    const before = _imgHydrateQueue.length;
    _enqueueHydration(a, a);
    if (_imgHydrateQueue.length > before) enqueued += 1;
  }
  _drainHydrationQueue().catch(() => {});
  return enqueued;
}

function seedHydrationFromNoImage(limit = 500, force = false) {
  const rows = db.getArtistsForTadbRetry(Math.max(1, Math.min(2000, Number(limit) || 500)), force);
  let enqueued = 0;
  for (const a of rows) {
    const before = _imgHydrateQueue.length;
    _enqueueHydrationTadb(a, a, force);
    if (_imgHydrateQueue.length > before) enqueued += 1;
  }
  _drainHydrationQueue().catch(() => {});
  return enqueued;
}

// ── Allowed vpaths helper (reuse pattern from rest of API) ────────────────────

function getAllowedVpaths(req) {
  const folders = config.program?.folders || {};
  const all = Object.keys(folders);
  if (req.user.admin) return all;
  const allowed = req.user.vpaths || [];
  return all.filter(v => allowed.includes(v));
}

// ── Route setup ───────────────────────────────────────────────────────────────

export function setup(velvet) {

  // Serve artist images from image-cache/artists/
  velvet.get('/api/v1/artists/images/:filename', (req, res) => {
    const name = req.params.filename;
    // Security: only allow simple filenames with no path traversal
    if (!name || !/^[a-z0-9_.-]+\.(jpg|jpeg|png|webp)$/i.test(name)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(ARTIST_IMG_DIR, name);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(ARTIST_IMG_DIR) + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    res.sendFile(resolved);
  });

  // ── POST /api/v1/admin/artists/placeholder ────────────────────────────────
  // Admin only. Accept a multipart image upload, resize to 400×400 JPEG, save
  // as the custom placeholder shown for artists without a photo.
  velvet.post('/api/v1/admin/artists/placeholder', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    let settled = false;
    const bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: 10 * 1024 * 1024 } });
    bb.on('file', (_field, fileStream, info) => {
      const mime = (info.mimeType || '').toLowerCase();
      if (!mime.startsWith('image/')) {
        fileStream.resume();
        if (!settled) { settled = true; res.status(400).json({ error: 'Only image files are allowed' }); }
        return;
      }
      settled = true; // claim the response slot before any async work
      const chunks = [];
      fileStream.on('data', d => chunks.push(d));
      fileStream.on('end', async () => {
        try {
          const buf = Buffer.concat(chunks);
          const processed = await sharp(buf)
            .resize(ARTIST_IMG_SIZE, ARTIST_IMG_SIZE, { fit: 'cover', position: 'top' })
            .jpeg({ quality: 85 })
            .toBuffer();
          await fsp.mkdir(path.dirname(ARTIST_PLACEHOLDER_FILE), { recursive: true });
          await fsp.writeFile(ARTIST_PLACEHOLDER_FILE, processed);
          res.json({ ok: true });
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      });
      fileStream.on('error', err => {
        res.status(500).json({ error: err.message });
      });
    });
    bb.on('error', err => {
      if (!settled) { settled = true; res.status(500).json({ error: err.message }); }
    });
    bb.on('close', () => {
      if (!settled) { settled = true; res.status(400).json({ error: 'No image file received' }); }
    });
    req.pipe(bb);
  });

  // ── DELETE /api/v1/admin/artists/placeholder ──────────────────────────────
  // Admin only. Remove the custom placeholder — reverts to the built-in default.
  velvet.delete('/api/v1/admin/artists/placeholder', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    try {
      if (fs.existsSync(ARTIST_PLACEHOLDER_FILE)) {
        await fsp.unlink(ARTIST_PLACEHOLDER_FILE);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/v1/admin/artists/placeholder-info ───────────────────────────
  // Admin only. Returns whether a custom placeholder is active.
  velvet.get('/api/v1/admin/artists/placeholder-info', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    res.json({ hasCustom: fs.existsSync(ARTIST_PLACEHOLDER_FILE) });
  });

  // ── GET /api/v1/artists/home ──────────────────────────────────────────────
  // Returns: totalCount, topArtists (top 20 by song count), recentArtists (last 10 played).
  // Fully precomputed — no file table join.
  velvet.get('/api/v1/artists/home', (req, res) => {
    try {
      const now = Date.now();
      if (_homeCache && now - _homeCacheTs < CACHE_TTL) {
        _queueHomeImageHydration(_homeCache);
        return res.json(_homeCache);
      }
      const stats = db.getArtistHomeStats();
      _homeCache   = stats;
      _homeCacheTs = now;
      _queueHomeImageHydration(stats);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/v1/artists/letter?l=A ────────────────────────────────────────
  // l = single letter A-Z or '0' for all digit-starting names.
  velvet.get('/api/v1/artists/letter', (req, res) => {
    try {
      const l = req.query.l;
      if (!l || typeof l !== 'string' || !/^[0-9A-Za-z]$/.test(l)) {
        return res.status(400).json({ error: 'Invalid letter. Use A-Z or 0 for digits.' });
      }
      const artists = db.getArtistsByLetter(l);
      _queueListImageHydration(artists, 200);
      res.json({ artists });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/v1/artists/search?q= ─────────────────────────────────────────
  // FTS5 trigram search against artist names.
  velvet.get('/api/v1/artists/search', (req, res) => {
    try {
      const q = req.query.q;
      if (!q || typeof q !== 'string' || q.trim().length < 2) {
        return res.status(400).json({ error: 'Query must be at least 2 characters' });
      }
      // searchArtistsNormalized returns { name, variants[] } objects
      const rawResults = db.searchArtistsNormalized(q.trim(), null, null);
      const artists = rawResults.map(r => {
        // Fetch full row so we have imageFile, songCount etc.
        const row = db.getArtistRow(r.name);
        if (!row) return null;
        return {
          artistKey:    row.artistKey,
          canonicalName: row.canonicalName,
          imageFile:    row.imageFile,
          hasBio:       !!row.bio,
          songCount:    row.songCount || 0,
          rawVariants:  row.rawVariants || [row.canonicalName],
        };
      }).filter(Boolean);
      _queueListImageHydration(artists, 150);
      res.json({ artists });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/v1/artists/image?artist= ────────────────────────────────────
  // Lightweight endpoint used by Playing Now to get the cached local image
  // for a given artist name (raw tag value). Returns { imageFile } if we have
  // one cached, or {} if not (and enqueues hydration so next call may have it).
  velvet.get('/api/v1/artists/image', (req, res) => {
    const name = req.query.artist;
    if (!name || typeof name !== 'string') return res.json({});
    try {
      const row = db.getArtistRowByName(String(name).trim());
      if (row?.imageFile) return res.json({ imageFile: row.imageFile });
      // No image yet — enqueue hydration and return empty so client shows nothing
      if (row) _enqueueHydration(row.artistKey, row.canonicalName);
      res.json({});
    } catch {
      res.json({});
    }
  });

  // ── GET /api/v1/artists/profile?key= ──────────────────────────────────────
  velvet.get('/api/v1/artists/profile', async (req, res) => {
    try {
      const key = req.query.key;
      if (!key || typeof key !== 'string') {
        return res.status(400).json({ error: 'Missing key' });
      }

      let artistRow = db.getArtistRow(key);
      if (!artistRow) return res.status(404).json({ error: 'Artist not found' });

      // On-demand MBID derivation: if not stored yet, derive from per-song data
      let mbid = artistRow.mbid || null;
      if (!mbid) {
        mbid = db.deriveArtistMbidFromFiles(artistRow.canonicalName);
        if (mbid) db.saveArtistInfo(artistRow.canonicalName, { mbid });
      }

      // On-demand TADB enrichment: fetch if fanart is missing OR all enrichment fields are missing.
      // Using OR ensures a missing fanartFile is re-fetched even when genre/country are already stored.
      const needsEnrich = !artistRow.fanartFile || (!artistRow.genre && !artistRow.bio && !artistRow.country);
      if (needsEnrich) {
        try {
          await _hydrateArtistImageTadb(artistRow.artistKey, artistRow.canonicalName);
          // Re-read the row so we return freshly saved enrichment data
          artistRow = db.getArtistRow(key) || artistRow;
          mbid = mbid || artistRow.mbid || null;
        } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      }

      const vpaths   = getAllowedVpaths(req);
      const fileRows = db.getArtistFiles(artistRow.rawVariants, vpaths, null);
      const releaseCategories = buildProfile(fileRows, artistRow.canonicalName);

      res.json({
        artistKey     : artistRow.artistKey,
        canonicalName : artistRow.canonicalName,
        bio           : artistRow.bio || null,
        imageFile     : artistRow.imageFile || null,
        imageSource   : artistRow.imageSource || null,
        fanartFile    : artistRow.fanartFile || null,
        mbid,
        genre         : artistRow.genre || null,
        country       : artistRow.country || null,
        formedYear    : artistRow.formedYear || null,
        lastFetched   : artistRow.lastFetched || null,
        releaseCategories,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/v1/artists/fetch-info ─────────────────────────────────────────
  // Admin only. Fetches bio + image from Last.fm, TheAudioDB, and MusicBrainz.
  velvet.post('/api/v1/artists/fetch-info', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    const schema = Joi.object({ artistKey: Joi.string().required() });
    try { joiValidate(schema, req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

    const { artistKey } = req.body;
    const artistRow = db.getArtistRow(artistKey);
    if (!artistRow) return res.status(404).json({ error: 'Artist not found' });

    try {
      // Fetch all sources in parallel; TADB uses MBID-first when available
      const fetchMbid = artistRow.mbid || db.deriveArtistMbidFromFiles(artistRow.canonicalName);
      if (fetchMbid && !artistRow.mbid) db.saveArtistInfo(artistRow.canonicalName, { mbid: fetchMbid });
      const [lfm, tadb, discogsUrl] = await Promise.all([
        fetchFromLastfm(artistRow.canonicalName),
        fetchFromTheAudioDB(artistRow.canonicalName, fetchMbid),
        fetchArtistImageFromDiscogs(artistRow.canonicalName),
      ]);
      const mb = (!lfm?.bio && !tadb?.bio)
        ? await fetchFromMusicBrainz(artistRow.canonicalName)
        : null;

      // Bio: Last.fm > TheAudioDB > MusicBrainz minimal
      const bio = lfm?.bio || tadb?.bio || mb?.bio || null;

      // Image: Discogs > TADB > Last.fm
      const imageUrl = discogsUrl || tadb?.imageUrl || lfm?.imageUrl || null;
      let source;
      if (discogsUrl) source = 'discogs';
      else if (tadb?.imageUrl) source = 'theaudiodb';
      else if (lfm?.imageUrl) source = 'lastfm';
      else source = null;

      if (!bio && !imageUrl && !tadb?.fanartUrl && !tadb?.genre) {
        return res.status(502).json({ error: 'No data from Discogs, Last.fm, TheAudioDB, or MusicBrainz' });
      }

      let imageFile = null;
      if (imageUrl) {
        imageFile = await saveArtistImage(artistRow.artistKey, imageUrl);
        if (!imageFile) source = null;
      }

      // Fanart from TADB
      let fanartFile = artistRow.fanartFile || null;
      if (!fanartFile && tadb?.fanartUrl) {
        fanartFile = await saveFanartImage(artistRow.artistKey, tadb.fanartUrl);
      }

      db.saveArtistInfo(artistRow.canonicalName, {
        bio,
        imageFile   : imageFile || null,
        imageSource : source || (mb ? 'musicbrainz' : null),
        fanartFile,
        mbid:         tadb?.mbid    || null,
        genre:        tadb?.genre   || null,
        country:      tadb?.country || null,
        formedYear:   tadb?.formedYear || null,
      });

      invalidateArtistCache();
      res.json({ ok: true, bio, imageFile, imageSource: source, fanartFile, genre: tadb?.genre || null, country: tadb?.country || null, formedYear: tadb?.formedYear || null, mbid: tadb?.mbid || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/v1/artists/set-image ──────────────────────────────────────────
  // Admin only. Downloads a custom image URL, resizes, stores.
  velvet.post('/api/v1/artists/set-image', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    const schema = Joi.object({
      artistKey : Joi.string().required(),
      imageUrl  : Joi.string().uri({ scheme: ['http', 'https'] }).required(),
    });
    try { joiValidate(schema, req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

    const { artistKey, imageUrl } = req.body;
    const artistRow = db.getArtistRow(artistKey);
    if (!artistRow) return res.status(404).json({ error: 'Artist not found' });

    try {
      const imageFile = await saveArtistImage(artistRow.artistKey, imageUrl);
      if (!imageFile) return res.status(422).json({ error: 'Could not download or process image' });

      db.setArtistImage(artistRow.canonicalName, imageFile, 'custom');
      invalidateArtistCache();
      res.json({ ok: true, imageFile });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/v1/artists/set-name ───────────────────────────────────────────
  // Admin only. Override the canonical display name.
  velvet.post('/api/v1/artists/set-name', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    const schema = Joi.object({
      artistKey     : Joi.string().required(),
      canonicalName : Joi.string().min(1).max(200).required(),
    });
    try { joiValidate(schema, req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

    const { artistKey, canonicalName } = req.body;
    const artistRow = db.getArtistRow(artistKey);
    if (!artistRow) return res.status(404).json({ error: 'Artist not found' });

    try {
      db.setArtistNameOverride(artistRow.canonicalName, canonicalName);
      invalidateArtistCache();
      res.json({ ok: true, canonicalName });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/v1/artists/mark-image-wrong ──────────────────────────────────
  // Admin-only action available from main player artist views.
  velvet.post('/api/v1/artists/mark-image-wrong', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });

    const schema = Joi.object({
      artistKey : Joi.string().required(),
      wrong     : Joi.boolean().default(true),
    });
    try { joiValidate(schema, req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

    const { artistKey, wrong } = req.body;
    const artistRow = db.getArtistRow(artistKey);
    if (!artistRow) return res.status(404).json({ error: 'Artist not found' });

    db.setArtistImageWrongFlag(artistRow.canonicalName, !!wrong);
    invalidateArtistCache();
    res.json({ ok: true, artistKey: artistRow.artistKey, wrong: !!wrong });
  });

  // ── GET /api/v1/admin/artists/image-audit?kind=missing|no-image|wrong|with-image&limit=200 ───
  velvet.get('/api/v1/admin/artists/image-audit', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const kind = String(req.query.kind || 'missing').toLowerCase();
    const limit = Number(req.query.limit || 200);
    if (kind !== 'missing' && kind !== 'no-image' && kind !== 'wrong' && kind !== 'with-image') {
      return res.status(400).json({ error: 'Invalid kind' });
    }
    try {
      const artists = db.getArtistImageAudit(kind, limit);
      const counts = db.getArtistImageAuditCounts();
      res.json({ kind, counts, artists });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/v1/admin/artists/hydration-status ────────────────────────────
  velvet.get('/api/v1/admin/artists/hydration-status', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    try {
      const counts = db.getArtistImageAuditCounts();
      res.json({ ...hydrationStatusSnapshot(), counts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/v1/admin/artists/hydration-seed ─────────────────────────────
  velvet.post('/api/v1/admin/artists/hydration-seed', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({ limit: Joi.number().integer().min(1).max(100000).default(500) });
    try { joiValidate(schema, req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }

    try {
      const enqueued = seedHydrationFromMissing(req.body?.limit || 500);
      const counts = db.getArtistImageAuditCounts();
      res.json({ ok: true, enqueued, ...hydrationStatusSnapshot(), counts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  velvet.post('/api/v1/admin/artists/hydrate-tadb-noimage', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({ limit: Joi.number().integer().min(1).max(100000).default(500) });
    try { joiValidate(schema, req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }

    try {
      // force=true: user explicitly clicked the button — bypass both the 30-day DB
      // cooldown and the 12-hour in-memory session cooldown so all no-image artists
      // are immediately re-queued regardless of when they were last tried.
      const enqueued = seedHydrationFromNoImage(req.body?.limit || 500, true);
      const counts = db.getArtistImageAuditCounts();
      res.json({ ok: true, enqueued, ...hydrationStatusSnapshot(), counts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/v1/admin/artists/discogs-candidates?artistKey= ───────────────
  velvet.get('/api/v1/admin/artists/discogs-candidates', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const artistKey = String(req.query.artistKey || '');
    if (!artistKey) return res.status(400).json({ error: 'Missing artistKey' });

    const artistRow = db.getArtistRow(artistKey);
    if (!artistRow) return res.status(404).json({ error: 'Artist not found' });

    try {
      const candidates = await searchDiscogsArtistCandidates(artistRow.canonicalName, 10);
      res.json({ artistKey: artistRow.artistKey, canonicalName: artistRow.canonicalName, candidates });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/v1/admin/artists/tadb-candidates?artistKey= ─────────────────
  velvet.get('/api/v1/admin/artists/tadb-candidates', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const artistKey = String(req.query.artistKey || '');
    if (!artistKey) return res.status(400).json({ error: 'Missing artistKey' });

    const artistRow = db.getArtistRow(artistKey);
    if (!artistRow) return res.status(404).json({ error: 'Artist not found' });

    try {
      const url = `https://www.theaudiodb.com/api/v1/json/2/search.php?s=${encodeURIComponent(artistRow.canonicalName)}`;
      const data = await downloadJson(url);
      const artists = Array.isArray(data?.artists) ? data.artists : [];
      const candidates = artists.slice(0, 6).map(a => ({
        id:        a.idArtist || null,
        title:     a.strArtist || artistRow.canonicalName,
        imageUrl:  a.strArtistThumb || null,
        thumbUrl:  a.strArtistThumb || null,
        genre:     a.strGenre || null,
        country:   a.strCountry || null,
        sourceUrl: a.strArtistThumb ? `https://www.theaudiodb.com/artist/${a.idArtist}` : null,
      })).filter(c => c.imageUrl);
      res.json({ artistKey: artistRow.artistKey, canonicalName: artistRow.canonicalName, candidates });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/v1/admin/artists/apply-image ─────────────────────────────────
  // Admin sets image from Discogs candidate or custom URL link.
  velvet.post('/api/v1/admin/artists/apply-image', async (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    const schema = Joi.object({
      artistKey : Joi.string().required(),
      imageUrl  : Joi.string().uri({ scheme: ['http', 'https'] }).required(),
      source    : Joi.string().allow('', null).optional(),
    });
    try { joiValidate(schema, req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

    const { artistKey, imageUrl, source } = req.body;
    const artistRow = db.getArtistRow(artistKey);
    if (!artistRow) return res.status(404).json({ error: 'Artist not found' });

    try {
      const imageFile = await saveArtistImage(artistRow.artistKey, imageUrl);
      if (!imageFile) return res.status(422).json({ error: 'Could not download or process image' });

      db.setArtistImage(artistRow.canonicalName, imageFile, source || 'custom');
      db.setArtistImageWrongFlag(artistRow.canonicalName, false);
      invalidateArtistCache();
      res.json({ ok: true, imageFile, imageSource: source || 'custom' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/v1/admin/artists/enrich-tadb ────────────────────────────────
  // Admin: re-enrich artists that are missing TADB fields (bio, fanart, genre, etc.)
  // — resets last_fetched for artists without any enrichment so they re-enter the
  // normal hydration queue, and seeds the tadb-only queue for artists that
  // already have an image but are missing the enrichment fields.
  velvet.post('/api/v1/admin/artists/enrich-tadb', (req, res) => {
    if (req.user.admin !== true) return res.status(403).json({ error: 'Admin only' });
    try {
      // 1. Reset fetch flag for artists with no image and no enrichment
      const reset = db.resetUnenrichedArtistFetch();

      // 2. Seed tadb-only queue for artists WITH images but no enrichment data
      const toEnrich = db.getArtistsForTadbEnrichment(2000);
      let enqueued = 0;
      for (const name of toEnrich) {
        const before = _imgHydrateQueue.length;
        _enqueueHydrationTadb(name, name);
        if (_imgHydrateQueue.length > before) enqueued++;
      }
      _drainHydrationQueue().catch(() => {});

      res.json({ ok: true, reset, enqueued, message: `${reset} artist(s) queued for normal re-fetch; ${enqueued} artist(s) queued for TADB enrichment` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
