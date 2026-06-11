/**
 * genre-enricher-worker.mjs
 *
 * Long-running worker thread that fetches artist genres from THREE sources
 * INDEPENDENTLY so the user can compare results and choose which to apply:
 *
 *   Last.fm     (artist.getTopTags)        — ~250 ms/call
 *   MusicBrainz (artist tags via MBID)     — ~1100 ms/call
 *   Discogs     (release styles)           — ~600 ms/call
 *
 * Each source has its own state column. The worker processes all three for
 * every artist regardless of whether the others found anything. Writes go
 * to the DB only — audio files on disk are never touched. There is no
 * auto-apply: the user must explicitly choose a source via the UI.
 *
 * workerData:
 *   { dbPath, lastfmApiKey, discogs: { apiKey, apiSecret, userAgentTag } | null }
 *
 * Messages from main → { type: 'stop' }
 * Messages to main:
 *   { type: 'ready' }
 *   { type: 'progress', currentArtist, currentPhase, processedCount }
 *   { type: 'status', stats }
 *   { type: 'fileError', message }
 *   { type: 'error', message }
 *   { type: 'stopped' }
 */

import { workerData, parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import https from 'node:https';
import http from 'node:http';
import { stripDigitPrefix } from './artist-normalize.js';

const { dbPath, lastfmApiKey, discogs } = workerData;

// ── Non-genre filter ──────────────────────────────────────────────────────────
// Drop Last.fm "tags" that are NOT genres (decades, moods, vocal styles,
// language/region labels, user favourite lists, etc).
const _NON_GENRE = new Set([
  // Personal / collection
  'seen live', 'live', 'favourites', 'favourite', 'fav', 'my favourites',
  'my favorite', 'my favorites', 'love', 'loved', 'love at first listen',
  'amazing', 'awesome', 'great', 'beautiful', 'good', 'cool', 'best',
  'albums i own', 'check out', 'under 2000 listeners', 'overrated', 'underrated',
  'all', 'various', 'misc', 'other', 'unknown',
  // Platforms
  'spotify', 'youtube', 'soundcloud', 'bandcamp', 'lastfm', 'last.fm',
  // Generic vibe tags
  'chill', 'chillout', 'chill out', 'relax', 'relaxing', 'mellow',
  'sad', 'happy', 'angry', 'energetic', 'dreamy', 'mood', 'atmospheric',
  'melancholic', 'melancholy', 'dark', 'epic', 'feel good', 'feelgood',
  'party', 'summer', 'winter', 'driving', 'workout', 'sleep',
  // Vocal / instrument descriptors
  'female vocalist', 'female vocalists', 'male vocalist', 'male vocalists',
  'vocal', 'vocals', 'instrumental', 'instrumentals', 'acapella', 'a cappella',
  // Era descriptors (non-decade)
  'classic', 'classics', 'oldies', 'old', 'old school', 'old-school',
  'new', 'modern', 'contemporary', 'retro', 'vintage', 'nostalgic',
  'underground', 'mainstream', 'commercial',
  // Format
  'best of', 'compilation', 'compilations', 'mixtape', 'mix',
  'cover', 'covers', 'remix', 'remixes', 'mashup', 'mashups', 'edit', 'edits',
  // Languages
  'english', 'french', 'german', 'spanish', 'italian', 'dutch', 'japanese',
  'korean', 'chinese', 'russian', 'portuguese', 'swedish', 'norwegian',
  // Regions / nationality
  'usa', 'us', 'uk', 'american', 'british', 'european', 'australian',
  'canadian', 'irish', 'scottish', 'german music', 'french music',
]);
// Regex: decade tags like "80s", "1980s", "80'", "2010s", "the 80s"
const _DECADE_RE = /^(the\s+)?(19|20)?\d0(['’]?s)?$/i;
// Single-year tag like "1985"
const _YEAR_RE   = /^(19|20)\d{2}$/;

function isGenre(tag) {
  const norm = String(tag).trim().toLowerCase();
  if (!norm) return false;
  if (_NON_GENRE.has(norm)) return false;
  if (_DECADE_RE.test(norm)) return false;
  if (_YEAR_RE.test(norm))   return false;
  return true;
}

const _MB_UA = 'Velvet/dev (https://github.com/aroundmyroom/Velvet)';
const DELAY_LASTFM   = 250;
const DELAY_MB       = 1100;
const DELAY_DISCOGS  = 600;
const DELAY_SKIP     = 50;
const IDLE_SLEEP_MS  = 60_000;
const STATUS_EVERY   = 10;

let _stopRequested  = false;
let _processedCount = 0;

parentPort.on('message', msg => {
  if (msg?.type === 'stop') _stopRequested = true;
});

// ── SQLite (own connection) ───────────────────────────────────────────────────
const db = new DatabaseSync(dbPath, { timeout: 30_000 });
db.exec('PRAGMA busy_timeout = 30000');
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA cache_size = -4000');

// Prepared statements — queue lookups
// Per-source single-row lookups (used when a source still has work but the
// next artist may already be done for the other two sources).
const _findLfQueue = db.prepare(
  "SELECT artist, lower(trim(artist)) AS norm FROM files WHERE genre_enrich_lastfm IS NULL AND artist IS NOT NULL AND trim(artist) != '' LIMIT 1"
);
const _findMbQueue = db.prepare(
  "SELECT artist, lower(trim(artist)) AS norm FROM files WHERE genre_enrich_mb IS NULL AND artist IS NOT NULL AND trim(artist) != '' LIMIT 1"
);
const _findDgQueue = db.prepare(
  "SELECT artist, lower(trim(artist)) AS norm FROM files WHERE genre_enrich_discogs IS NULL AND artist IS NOT NULL AND trim(artist) != '' LIMIT 1"
);
// Find the next artist that needs ANY source enriched, plus per-source NULL
// flags. This drives the interleaved \"all 3 sources per artist\" loop so the
// UI sees Last.fm, MusicBrainz, and Discogs counters tick up together.
const _findAnyQueue = db.prepare(
  `SELECT artist, lower(trim(artist)) AS norm,
          MAX(CASE WHEN genre_enrich_lastfm  IS NULL THEN 1 ELSE 0 END) AS need_lf,
          MAX(CASE WHEN genre_enrich_mb      IS NULL THEN 1 ELSE 0 END) AS need_mb,
          MAX(CASE WHEN genre_enrich_discogs IS NULL THEN 1 ELSE 0 END) AS need_dg
   FROM files
   WHERE (genre_enrich_lastfm IS NULL OR genre_enrich_mb IS NULL OR genre_enrich_discogs IS NULL)
     AND artist IS NOT NULL AND trim(artist) != ''
   GROUP BY lower(trim(artist))
   LIMIT 1`
);

// MBID lookup
const _getMbidAN = db.prepare(
  'SELECT mbid FROM artists_normalized WHERE lower(trim(artist_clean)) = ? AND mbid IS NOT NULL LIMIT 1'
);
const _getMbidFiles = db.prepare(
  "SELECT mb_artist_id FROM files WHERE lower(trim(artist)) = ? AND mb_artist_id IS NOT NULL AND mb_artist_id != '' LIMIT 1"
);

// ── Raw → clean artist name map ──────────────────────────────────────────────
// Some raw `files.artist` values are filename-derived junk like "01.Abba",
// "01_Communards", "01. Lady Gaga". The artists_normalized table already
// resolves these to a clean canonical name (e.g. "Abba", "Communards").
// Use the clean name when querying Last.fm / MusicBrainz / Discogs so the
// lookups actually succeed — DB writes still go via the raw lower(trim(artist))
// key so every file row with that raw value receives the result.
let _rawToClean = new Map();
function _loadArtistCleanMap() {
  _rawToClean = new Map();
  try {
    const rows = db.prepare('SELECT artist_clean, artist_raw_variants FROM artists_normalized').all();
    for (const r of rows) {
      let variants = [];
      try { variants = JSON.parse(r.artist_raw_variants || '[]'); } catch { variants = []; }
      for (const v of variants) {
        if (typeof v !== 'string') continue;
        const k = v.trim().toLowerCase();
        if (k && !_rawToClean.has(k)) _rawToClean.set(k, r.artist_clean);
      }
    }
  } catch (e) {
    parentPort.postMessage({ type: 'fileError', message: 'artist clean-map load failed: ' + e.message });
  }
}
function cleanName(row) {
  const mapped = _rawToClean.get(row.norm);
  if (mapped) return mapped;
  // Fallback: strip leading track-number prefixes ("01.", "01_", "01 ", "A1 ", etc.)
  // so junk-prefixed artists that aren't yet in artists_normalized still query
  // Last.fm/Discogs with a sensible name.
  const stripped = stripDigitPrefix(row.artist || '');
  return stripped && stripped !== row.artist ? stripped : row.artist;
}

// Junk-artist: mark all 3 sources as nf in one shot (no API calls)
const _markJunk = db.prepare(
  "UPDATE files SET genre_enrich_lastfm = 'nf', genre_enrich_mb = 'nf', genre_enrich_discogs = 'nf' WHERE lower(trim(artist)) = ?"
);
// Returns true for values that are obviously not real artist names (pure digits:
// years like 1989 / 2021, track numbers, catalog numbers, etc.).
function _isJunkArtist(name) {
  return /^\d+$/.test(name.trim());
}

// Writes
const _setLf = db.prepare(
  "UPDATE files SET genre_lastfm = ?, genre_enrich_lastfm = ? WHERE lower(trim(artist)) = ?"
);
const _setMb = db.prepare(
  "UPDATE files SET genre_mb = ?, genre_enrich_mb = ? WHERE lower(trim(artist)) = ?"
);
const _setDg = db.prepare(
  "UPDATE files SET genre_discogs = ?, genre_enrich_discogs = ? WHERE lower(trim(artist)) = ?"
);

// Stats
function _count(sql) { return db.prepare(sql).get()?.c ?? 0; }
function getStats() {
  const total = _count("SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE artist IS NOT NULL AND trim(artist) != ''");
  const lf = {
    ok:     _count("SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE genre_enrich_lastfm = 'ok'"),
    nf:     _count("SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE genre_enrich_lastfm = 'nf'"),
    error:  _count("SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE genre_enrich_lastfm = 'error'"),
    queued: _count("SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE genre_enrich_lastfm IS NULL AND artist IS NOT NULL AND trim(artist) != ''"),
  };
  const mb = {
    ok:     _count("SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE genre_enrich_mb = 'ok'"),
    nf:     _count("SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE genre_enrich_mb = 'nf'"),
    error:  _count("SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE genre_enrich_mb = 'error'"),
    queued: _count("SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE genre_enrich_mb IS NULL AND artist IS NOT NULL AND trim(artist) != ''"),
  };
  const dg = {
    ok:     _count("SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE genre_enrich_discogs = 'ok'"),
    nf:     _count("SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE genre_enrich_discogs = 'nf'"),
    error:  _count("SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE genre_enrich_discogs = 'error'"),
    queued: _count("SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE genre_enrich_discogs IS NULL AND artist IS NOT NULL AND trim(artist) != ''"),
  };
  const anyFound = _count(
    "SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE genre_lastfm IS NOT NULL OR genre_mb IS NOT NULL OR genre_discogs IS NOT NULL"
  );
  const fillableEmpty = _count(
    "SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE (genre IS NULL OR trim(genre) = '') AND (genre_lastfm IS NOT NULL OR genre_mb IS NOT NULL OR genre_discogs IS NOT NULL)"
  );
  // Mismatch: current genre present AND differs from EVERY available source
  const mismatch = _count(`
    SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files
    WHERE genre IS NOT NULL AND trim(genre) != ''
      AND (genre_lastfm IS NOT NULL OR genre_mb IS NOT NULL OR genre_discogs IS NOT NULL)
      AND (genre_lastfm IS NULL OR lower(trim(genre)) != lower(trim(genre_lastfm)))
      AND (genre_mb     IS NULL OR lower(trim(genre)) != lower(trim(genre_mb)))
      AND (genre_discogs IS NULL OR lower(trim(genre)) != lower(trim(genre_discogs)))
  `);
  // Enriched: all 3 sources processed (not NULL) but user has NOT yet reviewed.
  const enriched = _count(`
    SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files
    WHERE genre_enrich_lastfm IS NOT NULL
      AND genre_enrich_mb     IS NOT NULL
      AND genre_enrich_discogs IS NOT NULL
      AND (genre_user_reviewed IS NULL OR genre_user_reviewed = 0)
  `);
  // Applied: user explicitly made a decision via the compare screen.
  const applied = _count("SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files WHERE genre_user_reviewed = 1");
  // Artists with at least one source still unprocessed (the real "work remaining" count).
  const artistsQueued = _count(
    "SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files " +
    "WHERE (genre_enrich_lastfm IS NULL OR genre_enrich_mb IS NULL OR genre_enrich_discogs IS NULL) " +
    "AND artist IS NOT NULL AND trim(artist) != ''"
  );
  // Artists where every attempted source returned 'nf' — truly unresolvable.
  const artistsNf = _count(
    "SELECT COUNT(DISTINCT lower(trim(artist))) c FROM files " +
    "WHERE genre_enrich_lastfm = 'nf' AND genre_enrich_mb = 'nf' AND genre_enrich_discogs = 'nf'"
  );

  return {
    total,
    byState: { lastfm: lf, mb, discogs: dg },
    anyFound,
    fillableEmpty,
    mismatch,
    enriched,
    applied,
    artistsQueued,
    artistsNf,
    // queued = sum of per-source queues (= artistsQueued × 3 when in sync); kept for compat
    queued:    lf.queued + mb.queued + dg.queued,
    lfQueue:   lf.queued,
    mbQueue:   mb.queued,
    dgQueue:   dg.queued,
    found:     anyFound,
    not_found: lf.nf + mb.nf + dg.nf,
    errors:    lf.error + mb.error + dg.error,
    done:      anyFound + lf.nf + mb.nf + dg.nf,
    bySource:  { lastfm: lf.ok, mb: mb.ok, discogs: dg.ok },
  };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function downloadJson(url, headers = null) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const opts = { headers: { connection: 'close', ...headers } };
    const req = mod.get(url, opts, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// ── Phase 1: Last.fm ──────────────────────────────────────────────────────────
async function fetchLastfm(artistName) {
  if (!lastfmApiKey) throw new Error('No Last.fm API key configured');
  const clean = artistName.replace(/\s+(feat\.|ft\.|featuring|vs\.?)\s+.*/i, '').trim();
  const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getTopTags&artist=${encodeURIComponent(clean)}&api_key=${lastfmApiKey}&format=json&autocorrect=1`;
  const data = await downloadJson(url);
  if (data.error) return null;
  const tags = Array.isArray(data?.toptags?.tag) ? data.toptags.tag : [];
  return tags
    .filter(t => Number(t.count) >= 10 && isGenre(t.name))
    .map(t => t.name)[0] ?? null;
}

// ── Phase 2: MusicBrainz ──────────────────────────────────────────────────────
function getMbid(normArtist) {
  const an = _getMbidAN.get(normArtist);
  if (an?.mbid) return an.mbid;
  const f = _getMbidFiles.get(normArtist);
  return f?.mb_artist_id ?? null;
}

async function fetchMusicBrainz(mbid) {
  const url = `https://musicbrainz.org/ws/2/artist/${mbid}?inc=tags&fmt=json`;
  const data = await downloadJson(url, { 'User-Agent': _MB_UA });
  const tags = Array.isArray(data?.tags) ? data.tags : [];
  return tags
    .filter(t => Number(t.count) > 0 && isGenre(t.name))
    .sort((a, b) => Number(b.count) - Number(a.count))
    .map(t => t.name)[0] ?? null;
}

// ── Phase 3: Discogs ──────────────────────────────────────────────────────────
async function fetchDiscogs(artistName) {
  if (!discogs?.apiKey) return null;
  const ua = discogs.userAgentTag
    ? `Velvet/dev/${discogs.userAgentTag} +https://github.com/aroundmyroom/Velvet`
    : 'Velvet/dev +https://github.com/aroundmyroom/Velvet';
  const headers = {
    'User-Agent': ua,
    'Authorization': `Discogs key=${discogs.apiKey}, secret=${discogs.apiSecret}`,
  };
  const clean = artistName.replace(/\s+(feat\.|ft\.|featuring|vs\.?)\s+.*/i, '').trim();
  const url = `https://api.discogs.com/database/search?artist=${encodeURIComponent(clean)}&type=release&per_page=10&sort=have&sort_order=desc`;
  const data = await downloadJson(url, headers);
  const results = Array.isArray(data?.results) ? data.results : [];
  if (!results.length) return null;
  const tally = new Map();
  for (const r of results) {
    const styleOrGenre = Array.isArray(r.genre) ? r.genre : [];
    const tags = Array.isArray(r.style) ? r.style : styleOrGenre;
    for (const tag of tags) {
      if (isGenre(tag)) tally.set(tag, (tally.get(tag) ?? 0) + 1);
    }
  }
  if (!tally.size) return null;
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ── DB write retry ───────────────────────────────────────────────────────────
// SQLite in WAL mode still serialises writers. When the main thread holds the
// write lock (scan, artist rebuild, Sonos metadata, etc.) a direct .run()
// throws "database is locked" even with busy_timeout set, because Node's
// synchronous sqlite binding doesn't honour the async busy_timeout contract.
// Retry for up to ~3 minutes (60 × 3 s) before giving up on a single write.
const DB_RETRY_ATTEMPTS = 60;
const DB_RETRY_DELAY_MS = 3_000;

async function dbWriteWithRetry(fn) {
  for (let i = 0; i < DB_RETRY_ATTEMPTS; i++) {
    try {
      return fn();
    } catch (err) {
      const locked = err && typeof err.message === 'string' &&
        (err.message.includes('database is locked') || err.message.includes('SQLITE_BUSY'));
      if (!locked || i === DB_RETRY_ATTEMPTS - 1) throw err;
      if (_stopRequested) throw err;
      console.warn(`[genre-enricher] DB locked, retry ${i + 1}/${DB_RETRY_ATTEMPTS}...`);
      await sleep(DB_RETRY_DELAY_MS);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function postProgress(artist, phase) {
  parentPort.postMessage({ type: 'progress', currentArtist: artist, currentPhase: phase, processedCount: _processedCount });
}
function postStats() {
  try { parentPort.postMessage({ type: 'status', stats: getStats() }); }
  catch (e) { parentPort.postMessage({ type: 'fileError', message: 'stats: ' + e.message }); }
}
function bump() {
  _processedCount++;
  if (_processedCount % STATUS_EVERY === 0) postStats();
}

// ── Per-source processing ─────────────────────────────────────────────────────
// All genre values are stored lowercased so comparison across sources (and
// the user's file-tag `genre` column) is meaningful regardless of source
// capitalisation ("Pop" vs "pop").
const _lc = v => (v == null ? null : String(v).trim().toLowerCase() || null);

async function runLastfm(row) {
  const name = cleanName(row);
  postProgress(name, 'lastfm');
  try {
    const genre = _lc(await fetchLastfm(name));
    await dbWriteWithRetry(() => _setLf.run(genre ?? null, genre ? 'ok' : 'nf', row.norm));
  } catch (e) {
    try { await dbWriteWithRetry(() => _setLf.run(null, 'error', row.norm)); } catch { /* ignore */ }
    parentPort.postMessage({ type: 'fileError', message: `Last.fm "${name}": ${e.message}` });
  }
  return DELAY_LASTFM;
}

async function runMb(row) {
  const name = cleanName(row);
  postProgress(name, 'musicbrainz');
  try {
    // MBID lookup: try clean name first, then raw norm
    const mbid = getMbid(name.trim().toLowerCase()) || getMbid(row.norm);
    if (!mbid) {
      await dbWriteWithRetry(() => _setMb.run(null, 'nf', row.norm));
      return DELAY_SKIP;
    }
    const genre = _lc(await fetchMusicBrainz(mbid));
    await dbWriteWithRetry(() => _setMb.run(genre ?? null, genre ? 'ok' : 'nf', row.norm));
    return DELAY_MB;
  } catch (e) {
    try { await dbWriteWithRetry(() => _setMb.run(null, 'error', row.norm)); } catch { /* ignore */ }
    parentPort.postMessage({ type: 'fileError', message: `MusicBrainz "${name}": ${e.message}` });
    return DELAY_MB;
  }
}

async function runDiscogs(row) {
  const name = cleanName(row);
  postProgress(name, 'discogs');
  if (!discogs?.apiKey) {
    await dbWriteWithRetry(() => _setDg.run(null, 'nf', row.norm));
    return DELAY_SKIP;
  }
  try {
    const genre = _lc(await fetchDiscogs(name));
    await dbWriteWithRetry(() => _setDg.run(genre ?? null, genre ? 'ok' : 'nf', row.norm));
    return DELAY_DISCOGS;
  } catch (e) {
    try { await dbWriteWithRetry(() => _setDg.run(null, 'error', row.norm)); } catch { /* ignore */ }
    parentPort.postMessage({ type: 'fileError', message: `Discogs "${name}": ${e.message}` });
    return DELAY_DISCOGS;
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function run() {
  if (!lastfmApiKey || lastfmApiKey.length < 4) {
    parentPort.postMessage({ type: 'error', message: 'No valid Last.fm API key configured' });
    return;
  }

  // Build the raw → clean artist lookup so junk tags like "01.Abba" query
  // Last.fm/MB/Discogs as the clean canonical name ("Abba") instead.
  _loadArtistCleanMap();

  // ── Consistency pass ───────────────────────────────────────────────────────
  // Every artist must have all three sources from the SAME enrichment run, so
  // the comparison table is meaningful. Any artist where one or two sources
  // are filled but the third is NULL gets reset entirely so the loop below
  // will re-fetch all three together. Fully-enriched artists (all 3 non-NULL)
  // and untouched artists (all 3 NULL) are left alone.
  try {
    const reset = db.prepare(`
      UPDATE files
         SET genre_lastfm = NULL, genre_enrich_lastfm = NULL,
             genre_mb = NULL,     genre_enrich_mb = NULL,
             genre_discogs = NULL, genre_enrich_discogs = NULL
       WHERE artist IS NOT NULL AND trim(artist) != ''
         AND (genre_enrich_lastfm IS NULL OR genre_enrich_mb IS NULL OR genre_enrich_discogs IS NULL)
         AND (genre_enrich_lastfm IS NOT NULL OR genre_enrich_mb IS NOT NULL OR genre_enrich_discogs IS NOT NULL)
    `).run();
    if (reset.changes > 0) {
      parentPort.postMessage({ type: 'fileError', message: `Consistency pass: reset ${reset.changes} partially-enriched rows so all 3 sources are re-fetched together.` });
    }
  } catch (e) {
    parentPort.postMessage({ type: 'fileError', message: 'Consistency pass failed: ' + e.message });
  }

  parentPort.postMessage({ type: 'ready' });
  postStats();

  while (!_stopRequested) {
    // Pick the next artist that still has any source NULL, then enrich ALL
    // missing sources for that artist in a single pass. This makes the three
    // counters (Last.fm / MB / Discogs) advance together and the compare table
    // populate with side-by-side data from the first artist onward — instead
    // of draining Last.fm completely before MB and Discogs ever start.
    const row = _findAnyQueue.get();
    if (row) {
      if (_isJunkArtist(row.artist)) {
        _markJunk.run(row.norm);
        bump();
        continue;
      }
      if (row.need_lf) { await sleep(await runLastfm(row)); if (_stopRequested) break; }
      if (row.need_mb) { await sleep(await runMb(row));     if (_stopRequested) break; }
      if (row.need_dg) { await sleep(await runDiscogs(row));if (_stopRequested) break; }
      bump();
      continue;
    }

    // Fallback: in case _findAnyQueue returned nothing but a per-source
    // single-row query still finds work (race against the migration or apply
    // endpoints), drain them individually before idling.
    let row2 = _findLfQueue.get();
    if (row2) { await sleep(await runLastfm(row2)); bump(); continue; }
    row2 = _findMbQueue.get();
    if (row2) { await sleep(await runMb(row2)); bump(); continue; }
    row2 = _findDgQueue.get();
    if (row2) { await sleep(await runDiscogs(row2)); bump(); continue; }

    // All queues drained — flush stats and idle
    postStats();
    for (let i = 0; i < IDLE_SLEEP_MS / 1000 && !_stopRequested; i++) await sleep(1000);
  }

  postStats();
  parentPort.postMessage({ type: 'stopped' });
}

try { await run(); } catch (err) { parentPort.postMessage({ type: 'error', message: err.message }); }
