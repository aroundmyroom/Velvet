// Server-side Auto-DJ: builds a radio chain from a seed song the way the
// browser Auto-DJ would play it — every next track is chosen against the one
// before it (similar artists of the current artist, BPM corridor, Camelot key,
// genre family, era, artist cooldown), not all against the seed. Used by the
// Subsonic getSimilarSongs/getSimilarSongs2 endpoints (Music Assistant radio).
// Scoring: ./scoring.js. Candidate pool: ./pool.js. Both shared with the browser.

import {
  toCamelot, camelotNeighbours, genreFamilyOf, genreAnchor, scoreSong,
  artistKeys, artistsOverlap, ARTIST_HARD_FLOOR, ARTIST_COOLDOWN,
} from './scoring.js';
import { batchCandidatePool } from './pool.js';
import { titleKey } from '../util/title-key.js';

const GENRE_WINDOW = 25;
const GENRE_CONSEC_SOFT = 3;
const GENRE_CONSEC_HARD = 5;
const GENRE_FREQ_THRESH = 0.40;
const RECENT_PATHS = 30;

function avg(arr) {
  if (!arr.length) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

// One entry per song, whatever the version or credit: "The Reynolds Girls —
// I'd Rather Jack [Instrumental]" and "Reynolds Girls — I'd Rather Jack" are
// the same song for a radio.
function dedupeArtistKeys(artist) {
  return new Set([...artistKeys(artist)].map(k => k.replace(/^the /, '')));
}

function createSongIndex() {
  const byTitle = new Map();
  return {
    add(song) {
      const t = titleKey(song.title);
      if (!t) return;
      if (!byTitle.has(t)) byTitle.set(t, []);
      byTitle.get(t).push(dedupeArtistKeys(song.artist));
    },
    has(song) {
      const t = titleKey(song.title);
      const seen = t && byTitle.get(t);
      if (!seen) return false;
      const keys = dedupeArtistKeys(song.artist);
      return seen.some(k => (k.size === 0 && keys.size === 0) || artistsOverlap(k, keys));
    },
  };
}

// Same field mapping as the browser's renderMetadataObj → norm() path.
export function songFromRow(row, familyResolver) {
  return {
    id: row.id,
    hash: row.hash || null,
    filepath: `${row.vpath}/${row.filepath}`,
    title: row.title || null,
    artist: row.artist || row.album_artist || null,
    album: row.album || null,
    genre: row.genre || null,
    genreFamily: familyResolver?.resolve(row)?.family || null,
    year: row.year || null,
    bpm: row.bpm == null ? null : Math.round(row.bpm),
    musical_key: row.musical_key || null,
  };
}

function keywordBlocked(song, words) {
  if (!words?.length) return false;
  const norm = s => s.toLowerCase().replaceAll(/(.)\1+/g, '$1');
  const haystack = norm([song.title || '', song.artist || '', song.album || '', song.filepath || ''].join(' '));
  return words.some(w => w && haystack.includes(norm(w)));
}

/**
 * seed:        song object (songFromRow)
 * count:       chain length
 * fetchRows:   pool row source, see pool.js batchCandidatePool
 * similarFor:  async artist → { artists, variantRankMap } | null (null = lookup failed)
 * scope:       hard pool scope (ignoreVPaths, minRating, excludeFilepathPrefixes, …)
 * settings:    { similar, bpmContinuity, bpmBase, bpmTolerance, genreFilter, filterWords }
 * Returns { songs, trace } — songs in play order, seed excluded.
 */
// state: the browser's Auto-DJ state to continue from (a Velvet Room carries it on from the web player and from
// pick to pick): artistHistory, bpmHistory, yearHistory, genreHistory, familyHistory, seedFamily, lastPickFree,
// similarFor/similarArtists/rankMap/similarSource. seedIsDj: the seed itself was an Auto-DJ pick, so its start counts
// like the browser's Player.playAt for a DJ track. history: songs played before the seed (no repeats of those).
// The returned state is where the chain left off.
export async function buildRadio({
  seed, count, fetchRows, similarFor, scope = {}, settings = {}, toSong = r => r, rng = Math.random,
  state = null, seedIsDj = false, history = [],
}) {
  const cfg = { similar: true, bpmContinuity: true, bpmBase: null, bpmTolerance: 8, genreFilter: null, filterWords: [], ...settings };
  const st = {
    similarFor: '', similarArtists: [], rankMap: {}, similarSource: '',
    bpmHistory: [], yearHistory: [], lastPickFree: false,
    seedFamily: genreFamilyOf(seed), familyHistory: [], genreHistory: [],
    artistHistory: seed.artist ? [seed.artist.trim()] : [],
  };
  if (state) {
    for (const k of ['artistHistory', 'bpmHistory', 'yearHistory', 'genreHistory', 'familyHistory', 'similarArtists']) {
      if (Array.isArray(state[k])) st[k] = state[k].slice();
    }
    if (state.rankMap && typeof state.rankMap === 'object') st.rankMap = { ...state.rankMap };
    for (const k of ['similarFor', 'similarSource']) if (typeof state[k] === 'string') st[k] = state[k];
    st.lastPickFree = state.lastPickFree === true;
    // A manually started song re-seeds the genre anchor; a DJ pick keeps the session's.
    st.seedFamily = seedIsDj && state.seedFamily !== undefined ? state.seedFamily : genreFamilyOf(seed);
  }
  const played = [...history, seed];
  const usedIds = new Set(played.map(s => s.id).filter(id => id != null));
  const usedHashes = new Set(played.map(s => s.hash).filter(Boolean));
  const usedTitles = createSongIndex();
  for (const s of played) usedTitles.add(s);
  const trace = [];

  const pushArtist = artist => {
    if (!artist) return;
    const keys = artistKeys(artist);
    st.artistHistory = st.artistHistory.filter(a => !artistsOverlap(artistKeys(a), keys));
    st.artistHistory.push(artist.trim());
  };
  const pushGenre = song => {
    const fam = genreFamilyOf(song);
    if (fam) {
      st.familyHistory.push(fam);
      if (st.familyHistory.length > 8) st.familyHistory.shift();
    }
    if (!song.genre) return;
    st.genreHistory.push(song.genre.trim().toLowerCase());
    if (st.genreHistory.length > GENRE_WINDOW) st.genreHistory.shift();
  };
  const genreConsecutive = () => {
    const h = st.genreHistory;
    if (!h.length) return { genre: null, count: 0 };
    const last = h.at(-1);
    let n = 0;
    for (let i = h.length - 1; i >= 0 && h[i] === last; i--) n++;
    return { genre: last, count: n };
  };
  const genreOverrepresented = () => {
    if (st.genreHistory.length < 10) return null;
    const freq = {};
    for (const g of st.genreHistory) freq[g] = (freq[g] || 0) + 1;
    for (const [g, n] of Object.entries(freq)) if (n / st.genreHistory.length >= GENRE_FREQ_THRESH) return g;
    return null;
  };

  const updateSimilar = async (cur, isDj) => {
    if (!cfg.similar || !cur.artist || st.similarFor === cur.artist) return;
    const r = await similarFor(cur.artist);
    st.similarFor = cur.artist;
    if (r?.artists?.length) {
      st.similarArtists = r.artists;
      st.rankMap = r.variantRankMap || {};
      st.similarSource = cur.artist;
      return;
    }
    // A miss mid-session keeps the last list that worked (docs/autodj-scoring.md).
    if (isDj && st.similarArtists.length > 0) return;
    st.similarArtists = [];
    st.rankMap = {};
    st.similarSource = '';
  };

  const pick = (cur, escape = {}) => {
    const artists = !escape.dropArtistFilter && cfg.similar && st.similarArtists.length ? st.similarArtists : undefined;
    const ignoreArtists = st.artistHistory.length ? st.artistHistory.slice(-ARTIST_COOLDOWN) : undefined;
    // A small library can have every artist in the cooldown list; the artist
    // floor and the diversity score still keep repeats apart.
    const pool = batchCandidatePool(fetchRows, { ...scope, artists, ignoreArtists }, rng) ??
      (ignoreArtists ? batchCandidatePool(fetchRows, { ...scope, artists }, rng) : null);
    if (!pool) return null;
    let cands = pool.songs.map(toSong).filter(c =>
      !keywordBlocked(c, cfg.filterWords) && !usedIds.has(c.id) &&
      !(c.hash && usedHashes.has(c.hash)) && !usedTitles.has(c));
    // Untagged files show up as "[unknown]" in Music Assistant and carry no
    // similar-artist signal; only fall back to them when nothing else is left.
    const tagged = cands.filter(c => c.artist && c.title);
    if (tagged.length) cands = tagged;
    const recentPaths = new Set(played.slice(-RECENT_PATHS).map(s => s.filepath));
    cands = cands.filter(c => !recentPaths.has(c.filepath));
    // Every song of the similar artists is already in the chain: widen to the
    // whole scope rather than end the radio early.
    if (!cands.length && artists) return pick(cur, { ...escape, dropArtistFilter: true });
    const floor = st.artistHistory.slice(-ARTIST_HARD_FLOOR).map(artistKeys);
    if (floor.some(k => k.size > 0)) {
      const beyond = cands.filter(c => !floor.some(k => artistsOverlap(artistKeys(c.artist), k)));
      if (beyond.length) cands = beyond;
    }
    if (escape.escapeGenre) {
      const other = cands.filter(c => (c.genre || '').trim().toLowerCase() !== escape.escapeGenre);
      if (other.length) cands = other;
    }
    if (!cands.length) return null;

    const currentCamelot = toCamelot(cur.musical_key);
    const ctx = {
      similarActive: cfg.similar && st.similarArtists.length > 0,
      rankMap: st.rankMap,
      current: cur,
      currentBpm: cur.bpm ?? null,
      currentCamelot,
      currentNeighbours: camelotNeighbours(currentCamelot),
      bpmBase: cfg.bpmBase,
      bpmAnchor: avg(st.bpmHistory),
      yearAnchor: avg(st.yearHistory),
      lastPickFree: st.lastPickFree,
      bpmTolerance: cfg.bpmTolerance,
      genreAnchor: genreAnchor(st.seedFamily, st.familyHistory),
      genreFilter: cfg.genreFilter,
      artistHistory: st.artistHistory,
    };
    let best = null, bestScore = -Infinity;
    for (const c of cands) {
      const sc = scoreSong(c, ctx);
      if (sc > bestScore || (sc === bestScore && rng() < 0.5)) { bestScore = sc; best = c; }
    }
    return { song: best, score: bestScore, cands: cands.length, note: pool.note };
  };

  for (let i = 0; i < count; i++) {
    const cur = played.at(-1);
    const isDj = i > 0 || seedIsDj;
    // What the browser does when a track starts playing (Player.playAt).
    if (isDj) {
      if (cfg.bpmContinuity && cfg.bpmBase == null && cur.bpm != null && !st.lastPickFree) {
        st.bpmHistory.push(cur.bpm);
        if (st.bpmHistory.length > 8) st.bpmHistory.shift();
      }
      if (cur.year != null && !st.lastPickFree) {
        st.yearHistory.push(cur.year);
        if (st.yearHistory.length > 8) st.yearHistory.shift();
      }
    }
    await updateSimilar(cur, isDj);

    let chosen = pick(cur);
    if (!chosen) break;
    let escaped = null;
    const whitelist = cfg.genreFilter?.mode === 'whitelist' && cfg.genreFilter.genres?.length;
    if (chosen.song.genre && !whitelist) {
      const { genre: consecGenre, count: consecCount } = genreConsecutive();
      const escapeGenre = consecCount >= GENRE_CONSEC_SOFT ? consecGenre : genreOverrepresented();
      if (escapeGenre && chosen.song.genre.trim().toLowerCase() === escapeGenre) {
        const esc = pick(cur, { escapeGenre, dropArtistFilter: consecCount >= GENRE_CONSEC_HARD });
        if (esc) { chosen = esc; escaped = escapeGenre; }
      }
    }

    const song = chosen.song;
    pushArtist(song.artist);
    pushGenre(song);
    st.lastPickFree = song.bpm == null;
    played.push(song);
    usedIds.add(song.id);
    if (song.hash) usedHashes.add(song.hash);
    usedTitles.add(song);
    trace.push({
      score: Number(chosen.score.toFixed(3)), cands: chosen.cands,
      similar: cfg.similar ? st.similarArtists.length : 0, similarSource: st.similarSource || null,
      escape: escaped, note: chosen.note,
    });
  }
  const out = {
    artistHistory: st.artistHistory.slice(-500), bpmHistory: st.bpmHistory, yearHistory: st.yearHistory,
    genreHistory: st.genreHistory, familyHistory: st.familyHistory, seedFamily: st.seedFamily, lastPickFree: st.lastPickFree,
    similarFor: st.similarFor, similarArtists: st.similarArtists, rankMap: st.rankMap, similarSource: st.similarSource,
  };
  return { songs: played.slice(history.length + 1), trace, state: out };
}
