// Wires the radio chain (./radio.js) to the library: DB pools, Last.fm similar
// artists, admin-approved genre families and the user's synced Auto-DJ prefs.

import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { similarArtistsFor } from '../api/scrobbler.js';
import { genreFamilyResolver } from '../util/genre-family-cache.js';
import { buildRadio, songFromRow } from './radio.js';

// The library-wide pool (no similar-artist list) is drawn from one random
// sample per request instead of loading the whole library for every pick.
const SCOPE_SAMPLE = 4000;
const SEED_LOOKUP_MS = 3000;
// Last.fm time allowed for the rest of the chain. Cached lookups are instant;
// once spent, an uncached artist counts as a miss and the chain keeps the last
// similar-artist list, exactly like the browser after a failed lookup.
const CHAIN_LOOKUP_BUDGET_MS = 600;

function ignoreKey(a) {
  return String(a || '').toLowerCase().replaceAll('.', '');
}

function userPrefs(username) {
  try { return db.getUserSettings(username).prefs || {}; } catch { return {}; }
}

function filterWords(prefs) {
  if (prefs.dj_filter_on !== '1') return [];
  try {
    const w = JSON.parse(prefs.dj_filter_words || '[]');
    return Array.isArray(w) ? w.filter(x => typeof x === 'string' && x) : [];
  } catch { return []; }
}

// Audiobook folders never feed Auto-DJ (same as the browser's _audioBookExclusions);
// the radio also leaves out recordings (whole radio shows).
const NOT_RADIO = new Set(['audio-books', 'recordings']);
function nonMusicScope(vpaths) {
  const folders = config.program.folders || {};
  const ignoreVPaths = [];
  const excludeFilepathPrefixes = [];
  for (const [name, f] of Object.entries(folders)) {
    if (!NOT_RADIO.has(f.type || 'music') || !f.root) continue;
    const root = f.root.replace(/\/?$/, '/');
    const parent = Object.entries(folders).find(([other, o]) =>
      other !== name && o.root && root.startsWith(o.root.replace(/\/?$/, '/')) && root !== o.root.replace(/\/?$/, '/'));
    if (parent) {
      if (vpaths.includes(parent[0])) excludeFilepathPrefixes.push({ vpath: parent[0], prefix: root.slice(parent[1].root.replace(/\/?$/, '/').length) });
    } else {
      ignoreVPaths.push(name);
    }
  }
  return { ignoreVPaths, excludeFilepathPrefixes };
}

// Pool rows are shared between requests for a few minutes: Music Assistant
// asks for one radio batch after another, mostly around the same artists.
const ROW_CACHE_TTL_MS = 10 * 60 * 1000;
const ROW_CACHE_MAX_ARTISTS = 5000;
const _rowCaches = new Map();

function rowCacheFor(key) {
  let c = _rowCaches.get(key);
  if (!c || Date.now() - c.at > ROW_CACHE_TTL_MS) {
    c = { at: Date.now(), byArtist: new Map(), sample: null };
    _rowCaches.set(key, c);
    for (const [k, v] of _rowCaches) if (Date.now() - v.at > ROW_CACHE_TTL_MS) _rowCaches.delete(k);
  }
  if (c.byArtist.size > ROW_CACHE_MAX_ARTISTS) c.byArtist.clear();
  return c;
}

function createRowSource(vpaths, username, scope) {
  const cache = rowCacheFor(JSON.stringify([vpaths, username, scope]));
  const base = { ...scope, columns: 'autodj' };
  const withoutIgnored = (rows, ignoreArtists) => {
    if (!ignoreArtists?.length) return rows;
    const ignore = new Set(ignoreArtists.map(ignoreKey));
    return rows.filter(r => !ignore.has(ignoreKey(r.artist)));
  };
  return opts => {
    if (opts.artists?.length) {
      const missing = opts.artists.filter(a => !cache.byArtist.has(a));
      if (missing.length) {
        for (const a of missing) cache.byArtist.set(a, []);
        for (const row of db.getAllFilesWithMetadata(vpaths, username, { ...base, artists: missing })) {
          cache.byArtist.get(row.artist)?.push(row);
        }
      }
      return withoutIgnored(opts.artists.flatMap(a => cache.byArtist.get(a) || []), opts.ignoreArtists);
    }
    cache.sample ??= db.getAllFilesWithMetadata(vpaths, username, { ...base, sample: SCOPE_SAMPLE });
    return withoutIgnored(cache.sample, opts.ignoreArtists);
  };
}

// The best-ranked similar artists are the likely next picks: look them up in
// parallel while the chain is being built so their lists are ready in time.
const PREFETCH_ARTISTS = 8;
const PREFETCH_PARALLEL = 4;
function prefetchSimilar(r, vpaths) {
  const ranked = Object.entries(r.variantRankMap || {}).sort((a, b) => a[1] - b[1]).map(([a]) => a);
  const queue = [...new Set(ranked)].slice(0, PREFETCH_ARTISTS);
  const worker = async () => {
    while (queue.length) {
      try { await similarArtistsFor(queue.shift(), vpaths); } catch { /* best effort */ }
    }
  };
  for (let i = 0; i < PREFETCH_PARALLEL; i++) worker();
}

function createSimilarSource(vpaths) {
  let spent = 0;
  let first = true;
  return async artist => {
    const isSeed = first;
    const limit = first ? SEED_LOOKUP_MS : Math.max(0, CHAIN_LOOKUP_BUDGET_MS - spent);
    first = false;
    const t0 = Date.now();
    let timer;
    try {
      const r = await Promise.race([
        similarArtistsFor(artist, vpaths),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), limit); }),
      ]);
      if (isSeed && r?.artists?.length) prefetchSimilar(r, vpaths);
      return r;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      if (!isSeed) spent += Date.now() - t0;
    }
  };
}

// Music Assistant asks for the next radio batch seeded from a track near the
// end of the previous one. Looking those artists up in the background now
// makes that next request answer from cache.
const WARM_ARTISTS = 12;
function warmSimilar(songs, vpaths) {
  const artists = [...new Set(songs.map(s => s.artist).filter(Boolean))].slice(-WARM_ARTISTS);
  (async () => {
    for (const a of artists) {
      try { await similarArtistsFor(a, vpaths); } catch { /* best effort */ }
    }
  })();
}

/**
 * Radio chain for a Subsonic user. seedRow: a full files row; vpaths: the
 * root (DB) vpaths the user may read. Returns full file rows in play order.
 */
export async function radioForUser({ seedRow, count, username, vpaths }) {
  const t0 = Date.now();
  const families = genreFamilyResolver();
  const prefs = userPrefs(username);
  const minRating = Number.parseInt(prefs.dj_min_rating || '0', 10) || undefined;
  const scope = { ...nonMusicScope(vpaths), minRating };
  const toSong = row => songFromRow(row, families);
  const seed = toSong(seedRow);
  const { songs, trace } = await buildRadio({
    seed,
    count,
    fetchRows: createRowSource(vpaths, username, scope),
    similarFor: createSimilarSource(vpaths),
    scope,
    settings: { filterWords: filterWords(prefs) },
    toSong,
  });
  warmSimilar(songs, vpaths);
  const full = db.getSongsByRowids(songs.map(s => s.id), username);
  const rows = songs.map(s => full.get(s.id)).filter(Boolean);
  const sources = [...new Set(trace.map(t => t.similarSource).filter(Boolean))];
  console.log(`[autodj] radio user=${username} seed="${seed.artist || '?'} — ${seed.title || '?'}" → ${rows.length}/${count} tracks in ${Date.now() - t0}ms${sources.length ? ` (similar to ${sources.slice(0, 4).map(s => `"${s}"`).join(', ')})` : ' (no similar artists)'}`);
  return { rows, songs, trace };
}
