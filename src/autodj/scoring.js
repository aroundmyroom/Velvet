// Server-side copy of the browser Auto-DJ scoring (webapp/app.js: toCamelot,
// camelotNeighbours, _djGenre*, _djScoreSong, _djArtistKey(s)). The browser
// keeps its own copy; test/autodj-parity.test.mjs runs both on the same
// fixtures so a change on one side without the other fails the suite.
// The scoring is documented in docs/autodj-scoring.md.

const CAMELOT = {
  'Ab minor': '1A', 'G# minor': '1A', 'B major': '1B',
  'Eb minor': '2A', 'D# minor': '2A', 'F# major': '2B', 'Gb major': '2B',
  'Bb minor': '3A', 'A# minor': '3A', 'Db major': '3B', 'C# major': '3B',
  'F minor': '4A', 'Ab major': '4B', 'G# major': '4B',
  'C minor': '5A', 'Eb major': '5B', 'D# major': '5B',
  'G minor': '6A', 'Bb major': '6B', 'A# major': '6B',
  'D minor': '7A', 'F major': '7B',
  'A minor': '8A', 'C major': '8B',
  'E minor': '9A', 'G major': '9B',
  'B minor': '10A', 'D major': '10B',
  'F# minor': '11A', 'A major': '11B',
  'C# minor': '12A', 'E major': '12B',
};

export function toCamelot(musicalKey) {
  if (!musicalKey) return null;
  return CAMELOT[musicalKey] ?? null;
}

export function camelotNeighbours(code) {
  if (!code) return null;
  const num = Number.parseInt(code, 10);
  const letter = code.slice(-1);
  const other = letter === 'A' ? 'B' : 'A';
  const prev = ((num - 2 + 12) % 12) + 1;
  const next = (num % 12) + 1;
  return new Set([
    `${num}${letter}`, `${num}${other}`,
    `${prev}${letter}`, `${prev}${other}`,
    `${next}${letter}`, `${next}${other}`,
  ]);
}

export function genreCat(genre) {
  const g = String(genre || '').toLowerCase();
  if (g.includes('ambient') || g.includes('chillout') || g.includes('downtempo') || g.includes('new age')) return 'ambient';
  if (g.includes('disco') || g.includes('funk') || g.includes('soul') || g.includes('motown')) return 'disco';
  if (g.includes('electronic') || g.includes('techno') || g.includes('house') ||
      g.includes('trance') || g.includes('dance') || g.includes('edm') ||
      g.includes('synth') || g.includes('electro')) return 'electronic';
  if (g.includes('hardcore') || g.includes('hardstyle') || g.includes('gabber')) return 'hard';
  if (g.includes('pop') || g.includes('rock') || g.includes('indie') ||
      g.includes('alternative') || g.includes('country') || g.includes('folk') ||
      g.includes('r&b') || g.includes('rnb') || g.includes('jazz')) return 'soft';
  return 'other';
}

const GENRE_CAT_COMPAT = {
  'electronic→disco': 0.7,  'disco→electronic': 0.7,
  'electronic→ambient': 0.35, 'ambient→electronic': 0.35,
  'disco→ambient': 0.15,    'ambient→disco': 0.15,
  'electronic→soft': 0.25,  'soft→electronic': 0.25,
  'disco→soft': 0.45,       'soft→disco': 0.45,
  'ambient→soft': 0.25,     'soft→ambient': 0.25,
  'electronic→hard': 0.05,  'hard→electronic': 0.05,
  'disco→hard': 0.05,       'hard→disco': 0.05,
  'ambient→hard': 0.0,      'hard→ambient': 0.0,
  'soft→hard': 0.15,        'hard→soft': 0.15,
};

export function genreCatCompat(c1, c2) {
  if (c1 === c2) return 0.9;
  return GENRE_CAT_COMPAT[`${c1}→${c2}`] ?? 0.5;
}

export function genreFamilyOf(song) {
  if (!song) return null;
  if (song.genreFamily) return song.genreFamily;
  return song.genre ? genreCat(song.genre) : null;
}

export function genreCompatScore(cur, cand) {
  const cf = genreFamilyOf(cur), kf = genreFamilyOf(cand);
  if (!cf || !kf) return 0.6;
  if (cur.genre && cand.genre && cur.genre.toLowerCase() === cand.genre.toLowerCase()) return 1.0;
  return genreCatCompat(cf, kf);
}

export function genreAnchor(seedFamily, familyHistory) {
  const recent = [seedFamily, seedFamily, ...familyHistory.slice(-8)].filter(Boolean);
  if (!recent.length) return null;
  const freq = {};
  for (const f of recent) freq[f] = (freq[f] || 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
}

export function genreContinuityScore(cur, cand, anchor) {
  const curScore = genreCompatScore(cur, cand);
  const kf = genreFamilyOf(cand);
  if (!anchor || !kf) return curScore;
  const anchored = genreCatCompat(anchor, kf);
  return genreFamilyOf(cur) ? 0.6 * curScore + 0.4 * anchored : anchored;
}

// filter: null, or { mode: 'whitelist'|'blacklist', genres: [expanded names] }
export function genreFilterScore(song, filter) {
  if (!filter?.genres?.length) return null;
  const raw = (song.genre || '').toLowerCase();
  const inList = filter.genres.some(g => {
    const lc = g.toLowerCase();
    return raw === lc || raw.startsWith(lc + ',') || raw.endsWith(', ' + lc) || raw.includes(', ' + lc + ',');
  });
  if (filter.mode === 'whitelist') return raw ? (inList ? 1.0 : 0.0) : 0.5;
  return raw ? (inList ? 0.0 : 1.0) : 1.0;
}

export const ARTIST_HARD_FLOOR = 3;
export const ARTIST_COOLDOWN = 15;
const ARTIST_PART_MIN = 3;
const ARTIST_PART_STOP = new Set(['the', 'and', 'of', 'de', 'la', 'le', 'les', 'los', 'las', 'van', 'von', 'fire', 'wind', 'earth']);

export function artistKey(s) {
  return (s || '').toLowerCase()
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll('.', '')
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Pure and called for every candidate × every recent artist — memoised.
// Callers must not mutate the returned Set.
const _artistKeysMemo = new Map();
const ARTIST_KEYS_MEMO_MAX = 20000;

export function artistKeys(name) {
  const memoKey = String(name ?? '');
  const hit = _artistKeysMemo.get(memoKey);
  if (hit) return hit;
  const out = computeArtistKeys(name);
  if (_artistKeysMemo.size >= ARTIST_KEYS_MEMO_MAX) _artistKeysMemo.clear();
  _artistKeysMemo.set(memoKey, out);
  return out;
}

function computeArtistKeys(name) {
  const out = new Set();
  const add = v => {
    const key = artistKey(v);
    if (!key || key.length < ARTIST_PART_MIN || ARTIST_PART_STOP.has(key)) return;
    out.add(key);
  };
  add(name);
  // "04. Clean Bandit Fe. Mabel", "A1. Donna Summer", "02.Donna Summer": a leaked
  // track / vinyl-side number and the "Fe." shorthand (see src/util/artist-credit.js)
  // must not hide the main artist.
  const credit = String(name || '').replace(/^[A-Z]?\d{1,3}\.\s*/, '');
  add(credit);
  const chunks = credit.split(/\s+(?:feat\.?|ft\.?|fe\.|featuring|vs\.?|pres\.?|presents?\b|\bx\b)\s+/i);
  for (const chunk of chunks) {
    add(chunk);
    for (const part of chunk.split(/\s+(?:&|and)\s+/i)) add(part);
  }
  return out;
}

export function artistsOverlap(a, b) {
  if (!a?.size || !b?.size) return false;
  for (const key of a) if (b.has(key)) return true;
  return false;
}

function rangeScore(diff, tol) {
  if (diff <= tol) return 1.0 - (diff / tol) * 0.3;
  if (diff <= tol * 2) return 0.3 - ((diff - tol) / tol) * 0.3;
  return 0;
}

// ctx mirrors the browser globals _djScoreSong reads:
//   similarActive  S.djSimilar && _djSimilarArtists.length > 0
//   rankMap        _djVariantRankMap
//   current        S.queue[S.idx]
//   currentBpm, currentCamelot, currentNeighbours, bpmAnchor, yearAnchor, lastPickFree
//   bpmBase        S.djBpmBase       bpmTolerance  S.djBpmTolerance
//   genreAnchor    _djGenreAnchor()  genreFilter   see genreFilterScore
//   artistHistory  S.djArtistHistory
export function scoreSong(song, ctx) {
  let wArtist = 0.35, wBpm = 0.25, wGenre = 0.13, wHarmonic = 0.07;
  if (!ctx.similarActive) {
    const otherTotal = wBpm + wGenre + wHarmonic;
    wBpm      += wArtist * (wBpm / otherTotal);
    wGenre    += wArtist * (wGenre / otherTotal);
    wHarmonic += wArtist * (wHarmonic / otherTotal);
    wArtist = 0;
  }

  let score = 0;

  if (song.musical_key) {
    const cand = toCamelot(song.musical_key);
    if (!cand) {
      score += wHarmonic * 0.4;
    } else if (cand === ctx.currentCamelot) {
      score += wHarmonic * 1.0;
    } else if (ctx.currentNeighbours?.has(cand)) {
      score += wHarmonic * 0.7;
    } else {
      score += wHarmonic * (camelotNeighbours(cand).has(ctx.currentCamelot) ? 0.3 : 0.0);
    }
  } else {
    score += wHarmonic * 0.4;
  }

  const filterScore = genreFilterScore(song, ctx.genreFilter);
  const contScore = genreContinuityScore(ctx.current, song, ctx.genreAnchor);
  score += wGenre * (filterScore == null ? contScore : 0.6 * filterScore + 0.4 * contScore);

  if (wArtist > 0) {
    const rankMap = ctx.rankMap || {};
    if (song.artist && Object.keys(rankMap).length > 0) {
      const rank = rankMap[song.artist];
      score += wArtist * (rank == null ? 0 : Math.max(0.18, 1.0 - (rank - 1) / 60));
    } else {
      score += wArtist * 0.3;
    }
  }

  const baseRef = ctx.bpmBase ?? ctx.bpmAnchor;
  const blendRef = (ctx.currentBpm != null && baseRef != null && !ctx.lastPickFree)
    ? Math.round(0.6 * ctx.currentBpm + 0.4 * baseRef)
    : (ctx.currentBpm ?? baseRef);
  if (song.bpm && blendRef != null) {
    score += wBpm * rangeScore(Math.abs(song.bpm - blendRef), ctx.bpmTolerance ?? 8);
  } else {
    score += wBpm * 0.5;
  }

  const curYear = ctx.current?.year ?? null;
  const yearBlend = (curYear != null && ctx.yearAnchor != null)
    ? Math.round(0.6 * curYear + 0.4 * ctx.yearAnchor)
    : (curYear ?? ctx.yearAnchor);
  if (song.year && yearBlend != null) {
    score += 0.10 * rangeScore(Math.abs(song.year - yearBlend), 12);
  } else {
    score += 0.10 * 0.5;
  }

  const recent = (ctx.artistHistory || []).slice(-ARTIST_COOLDOWN);
  const songArtistKeys = artistKeys(song.artist);
  const aidx = recent.findIndex(a => artistsOverlap(songArtistKeys, artistKeys(a)));
  let diversity = 0.7;
  if (aidx === -1) diversity = 1.0;
  else if (aidx >= recent.length - 5) diversity = 0.0;
  else if (aidx >= recent.length - 10) diversity = 0.4;
  score += 0.10 * diversity;

  return score;
}
