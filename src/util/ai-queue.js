// AI DJ: a listener describes a set, Claude turns that into a brief in library
// terms, and this module picks and orders the songs. The planner is
// deterministic and never sees the model: a queue only ever holds songs the
// library has, stays under the cap, and comes out the same for the same brief.
import Joi from 'joi';
import { FAMILIES, familyCompat } from './genre-family.js';

export const ENERGY = ['steady', 'build', 'peak', 'wave', 'cooldown'];
export const RELEASES = ['any', 'album', 'single', '12inch', 'extended', 'instrumental', 'remix', 'live', 'original'];
export const PREFERS = ['none', 'longest', 'shortest', 'newest', 'oldest'];
export const RANKINGS = ['none', 'mostPlayed', 'leastPlayed', 'topRated', 'recentlyAdded', 'recentlyPlayed'];
export const ORDERS = ['dj', 'chronological', 'newestFirst', 'alphabetical', 'random', 'countdown'];
export const PLAYED = ['any', 'never', 'played'];
export const RATED = ['any', 'rated', 'unrated'];
// What each release wish looks for in titles and file names.
export const RELEASE_PATTERNS = {
  '12inch': ['12"', '12 inch', '12-inch', '12inch', 'extended', 'maxi', 'club mix', 'club version', 'long version', 'dub'],
  extended: ['extended', 'long version', '12"', '12 inch', '12-inch'],
  single: ['single', '7"', '7 inch', 'radio edit', 'radio version', 'single version', 'edit'],
  instrumental: ['instrumental', 'karaoke', 'dub'],
  remix: ['remix', 'mix)', 'rework', 'edit)', 'bootleg', 'version)'],
  live: ['live', 'in concert', 'unplugged', 'acoustic'],
  original: ['original', 'album version', 'lp version'],
};
export const DEFAULT_SONGS = 25;
export const MAX_MINUTES = 24 * 60;
export const MAX_SONGS = 9999;
export const MAX_LIST = 25;
export const MAX_SEGMENTS = 12;
const FALLBACK_DURATION = 240;
const CHAIN_LIMIT = 1500;

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
export function toCamelot(key) { return key ? CAMELOT[key] ?? null : null; }

const KEY_ALIASES = { 'a#': 'Bb', 'c#': 'Db', 'd#': 'Eb', 'f#': 'Gb', 'g#': 'Ab' };
export function keyToCamelot(text) {
  const t = String(text || '').trim();
  if (/^\d{1,2}[ab]$/i.test(t)) { const n = Number.parseInt(t, 10); return n >= 1 && n <= 12 ? `${n}${t.slice(-1).toUpperCase()}` : null; }
  const m = t.match(/^([a-g])\s*([#b♭♯])?\s*(minor|major|min|maj|m|dur|moll)?$/i);
  if (!m) return null;
  let note = m[1].toUpperCase() + (m[2] ? (m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2]) : '');
  const mode = /^(minor|min|m|moll)$/i.test(m[3] || '') ? 'minor' : 'major';
  if (mode === 'major' && KEY_ALIASES[note.toLowerCase()]) note = KEY_ALIASES[note.toLowerCase()];
  return CAMELOT[`${note} ${mode}`] ?? CAMELOT[`${note.replace('b', '#')} ${mode}`] ?? null;
}

function camelotScore(a, b) {
  if (!a || !b) return 0.6;
  if (a === b) return 1;
  const na = Number.parseInt(a, 10), nb = Number.parseInt(b, 10);
  const sameLetter = a.slice(-1) === b.slice(-1);
  if (na === nb) return 0.9;
  const step = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
  if (step === 1) return sameLetter ? 0.8 : 0.5;
  return 0.25;
}

// What Claude answers with. Every field is optional for the model but present
// in the JSON (json_schema output needs the full list), nulls meaning "not asked".
const nullableInt = { type: ['integer', 'null'] };
const strList = { type: 'array', items: { type: 'string' } };
export const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    songs: nullableInt,
    minutes: nullableInt,
    genres: strList,
    excludeGenres: strList,
    families: { type: 'array', items: { type: 'string', enum: FAMILIES } },
    yearFrom: nullableInt,
    yearTo: nullableInt,
    bpmFrom: nullableInt,
    bpmTo: nullableInt,
    energy: { type: 'string', enum: ENERGY },
    artists: strList,
    artistMode: { type: 'string', enum: ['feature', 'only'] },
    excludeArtists: strList,
    folders: strList,
    keywords: strList,
    albums: strList,
    excludeAlbums: strList,
    albumMode: { type: 'string', enum: ['songs', 'oneAlbum', 'wholeAlbums'] },
    titles: strList,
    minSeconds: nullableInt,
    maxSeconds: nullableInt,
    keys: strList,
    release: { type: 'string', enum: RELEASES },
    prefer: { type: 'string', enum: PREFERS },
    ranking: { type: 'string', enum: RANKINGS },
    order: { type: 'string', enum: ORDERS },
    starred: { type: 'boolean' },
    played: { type: 'string', enum: PLAYED },
    rated: { type: 'string', enum: RATED },
    minPlays: nullableInt,
    maxPlays: nullableInt,
    addedWithinDays: nullableInt,
    playedWithinDays: nullableInt,
    notPlayedWithinDays: nullableInt,
    lossless: { type: ['boolean', 'null'] },
    hiRes: { type: 'boolean' },
    playlists: strList,
    collections: strList,
    excludeKeywords: strList,
    allVersions: { type: 'boolean' },
    favourites: { type: 'boolean' },
    discovery: { type: 'boolean' },
    minRating: nullableInt,
    chart: { type: ['string', 'null'] },
    chartFrom: nullableInt,
    chartTo: nullableInt,
    cohesive: { type: 'boolean' },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          minutes: nullableInt,
          songs: nullableInt,
          genres: strList,
          families: { type: 'array', items: { type: 'string', enum: FAMILIES } },
          bpmFrom: nullableInt,
          bpmTo: nullableInt,
          energy: { type: 'string', enum: ENERGY },
        },
        required: ['name', 'minutes', 'songs', 'genres', 'families', 'bpmFrom', 'bpmTo', 'energy'],
        additionalProperties: false,
      },
    },
    clarification: { type: ['string', 'null'] },
  },
  required: ['title', 'summary', 'songs', 'minutes', 'genres', 'excludeGenres', 'families', 'yearFrom', 'yearTo', 'bpmFrom', 'bpmTo',
    'energy', 'artists', 'artistMode', 'excludeArtists', 'folders', 'keywords', 'albums', 'excludeAlbums', 'albumMode', 'titles', 'minSeconds', 'maxSeconds', 'keys', 'release', 'prefer', 'ranking', 'order', 'starred', 'played', 'rated', 'minPlays', 'maxPlays', 'addedWithinDays', 'playedWithinDays', 'notPlayedWithinDays', 'lossless', 'hiRes', 'playlists', 'collections', 'excludeKeywords', 'allVersions', 'favourites', 'discovery', 'minRating', 'chart', 'chartFrom', 'chartTo', 'cohesive', 'segments', 'clarification'],
  additionalProperties: false,
};

// The same brief, checked before Velvet acts on it — whether it came from the
// model or from the player (the listener may edit and rebuild).
const str = Joi.string().trim().max(120).allow('');
const strs = Joi.array().items(str).max(MAX_LIST).default([]);
const year = Joi.number().integer().min(1900).max(2100).allow(null).default(null);
const bpm = Joi.number().integer().min(40).max(300).allow(null).default(null);
const count = Joi.number().integer().min(1).allow(null).default(null);
const families = Joi.array().items(Joi.string().valid(...FAMILIES)).max(FAMILIES.length).default([]);
const energy = Joi.string().valid(...ENERGY).default('steady');
// One phase of a set in phases: "15 minutes calm around 100 BPM, then disco
// up to 120, then half an hour of club house, then trance".
const segmentJoi = Joi.object({
  name: Joi.string().trim().max(80).allow('').default(''),
  minutes: count, songs: count,
  genres: strs, families,
  bpmFrom: bpm, bpmTo: bpm,
  energy,
}).options({ stripUnknown: true });
const briefJoi = Joi.object({
  title: Joi.string().trim().max(120).allow('').default(''),
  summary: Joi.string().trim().max(400).allow('').default(''),
  songs: count,
  minutes: count,
  genres: strs, excludeGenres: strs,
  families,
  yearFrom: year, yearTo: year, bpmFrom: bpm, bpmTo: bpm,
  energy,
  artists: strs,
  artistMode: Joi.string().valid('feature', 'only').default('feature'),
  excludeArtists: strs,
  folders: strs, keywords: strs,
  albums: strs, excludeAlbums: strs,
  albumMode: Joi.string().valid('songs', 'oneAlbum', 'wholeAlbums').default('songs'),
  titles: strs,
  minSeconds: Joi.number().integer().min(1).max(36000).allow(null).default(null),
  maxSeconds: Joi.number().integer().min(1).max(36000).allow(null).default(null),
  keys: strs,
  release: Joi.string().valid(...RELEASES).default('any'),
  prefer: Joi.string().valid(...PREFERS).default('none'),
  ranking: Joi.string().valid(...RANKINGS).default('none'),
  order: Joi.string().valid(...ORDERS).default('dj'),
  starred: Joi.boolean().default(false),
  played: Joi.string().valid(...PLAYED).default('any'),
  rated: Joi.string().valid(...RATED).default('any'),
  minPlays: Joi.number().integer().min(0).allow(null).default(null),
  maxPlays: Joi.number().integer().min(0).allow(null).default(null),
  addedWithinDays: Joi.number().integer().min(1).max(36500).allow(null).default(null),
  playedWithinDays: Joi.number().integer().min(1).max(36500).allow(null).default(null),
  notPlayedWithinDays: Joi.number().integer().min(1).max(36500).allow(null).default(null),
  lossless: Joi.boolean().allow(null).default(null),
  hiRes: Joi.boolean().default(false),
  playlists: strs, collections: strs, excludeKeywords: strs,
  allVersions: Joi.boolean().default(false),
  favourites: Joi.boolean().default(false),
  discovery: Joi.boolean().default(false),
  minRating: Joi.number().integer().min(0).max(10).allow(null).default(null),
  chart: Joi.string().trim().max(200).allow('', null).default(null),
  chartFrom: Joi.number().integer().min(1).max(MAX_SONGS).allow(null).default(null),
  chartTo: Joi.number().integer().min(1).max(MAX_SONGS).allow(null).default(null),
  cohesive: Joi.boolean().default(false),
  segments: Joi.array().items(segmentJoi).max(MAX_SEGMENTS).default([]),
  clarification: Joi.string().trim().max(300).allow('', null).default(null),
}).options({ stripUnknown: true });

// A phase with no length gets the typical length of the phases that have
// one, else its share of the set's length; a set in phases is a mixed set
// (no chart, ranking, album or seed-song shape), one phase is no set in phases.
function validateSegments(value) {
  if (value.segments.length < 2) { value.segments = []; return; }
  const med = l => median(l) ?? null;
  const minutes = med(value.segments.map(s => s.minutes));
  const songs = med(value.segments.map(s => s.songs));
  for (const s of value.segments) {
    if (s.bpmFrom != null && s.bpmTo != null && s.bpmFrom > s.bpmTo) [s.bpmFrom, s.bpmTo] = [s.bpmTo, s.bpmFrom];
    s.genres = [...new Set(s.genres.map(g => g.trim()).filter(Boolean))];
    if (s.minutes != null) s.minutes = Math.min(s.minutes, MAX_MINUTES);
    if (s.songs != null) s.songs = Math.min(s.songs, MAX_SONGS);
    if (s.minutes != null || s.songs != null) continue;
    if (minutes != null) s.minutes = minutes;
    else if (songs != null) s.songs = songs;
    else if (value.minutes != null) s.minutes = Math.max(5, Math.round(value.minutes / value.segments.length));
    else s.songs = Math.max(3, Math.round((value.songs ?? DEFAULT_SONGS) / value.segments.length));
  }
  Object.assign(value, { chart: null, chartFrom: null, chartTo: null, ranking: 'none', albumMode: 'songs', cohesive: false, titles: [], allVersions: false, prefer: 'none' });
  if (value.order === 'countdown') value.order = 'dj';
}

export function validateBrief(raw) {
  const { error, value } = briefJoi.validate(raw ?? {});
  if (error) throw error;
  if (value.songs != null) value.songs = Math.min(value.songs, MAX_SONGS);
  if (value.minutes != null) value.minutes = Math.min(value.minutes, MAX_MINUTES);
  validateSegments(value);
  if (value.yearFrom != null && value.yearTo != null && value.yearFrom > value.yearTo) [value.yearFrom, value.yearTo] = [value.yearTo, value.yearFrom];
  if (value.bpmFrom != null && value.bpmTo != null && value.bpmFrom > value.bpmTo) [value.bpmFrom, value.bpmTo] = [value.bpmTo, value.bpmFrom];
  const dedupe = l => [...new Set(l.map(s => s.trim()).filter(Boolean))];
  for (const k of ['genres', 'excludeGenres', 'artists', 'excludeArtists', 'folders', 'keywords', 'albums', 'excludeAlbums', 'titles', 'playlists', 'collections', 'excludeKeywords']) value[k] = dedupe(value[k]);
  value.excludeKeywords = value.excludeKeywords.map(k => k.toLowerCase()).filter(k => k.length >= 2);
  if (value.played === 'never') value.discovery = false;
  if (value.minSeconds != null && value.maxSeconds != null && value.minSeconds > value.maxSeconds) [value.minSeconds, value.maxSeconds] = [value.maxSeconds, value.minSeconds];
  // keys: "A minor" or "8A" → Camelot codes; anything else is dropped
  value.keys = [...new Set(value.keys.map(keyToCamelot).filter(Boolean))];
  // "album" is a request shape, not a word to look for in titles
  value.keywords = value.keywords.filter(k => !/^(album|albums|record|lp|plaat)$/.test(k.toLowerCase()));
  // "Grandmix 1983": the year in a named title is the title's, not an era
  const titleYears = new Set(value.titles.flatMap(t => t.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number));
  if (titleYears.size && (titleYears.has(value.yearFrom) || titleYears.has(value.yearTo))) { value.yearFrom = null; value.yearTo = null; }
  if (value.albums.length && value.albumMode === 'songs') value.albumMode = 'wholeAlbums';
  // "no Modern Talking" sometimes lands in both lists; the exclusion wins.
  const lower = l => new Set(l.map(x => x.toLowerCase()));
  const exA = lower(value.excludeArtists), exG = lower(value.excludeGenres);
  value.artists = value.artists.filter(a => !exA.has(a.toLowerCase()));
  value.genres = value.genres.filter(g => !exG.has(g.toLowerCase()));
  value.keywords = value.keywords.map(k => k.toLowerCase()).filter(k => k.length >= 2);
  if (!value.clarification) value.clarification = null;
  // a chart is answered from its positions; a ranking of the listener's own statistics is another question
  if (!value.chart) { value.chart = null; value.chartFrom = null; value.chartTo = null; }
  else {
    value.ranking = 'none';
    value.albumMode = 'songs';
    if (value.chartFrom != null && value.chartTo != null && value.chartFrom > value.chartTo) [value.chartFrom, value.chartTo] = [value.chartTo, value.chartFrom];
  }
  return value;
}

export function artistKey(name) {
  return String(name || '').toLowerCase().replaceAll('.', '').replaceAll(/\s+/g, ' ').trim();
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function median(values) {
  const v = values.filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
}

export function targetCount(brief, { avgDuration, maxSongs, poolSize }) {
  const notes = [];
  let n = brief.songs;
  if (n == null && brief.minutes) n = Math.round(brief.minutes * 60 / (avgDuration || FALLBACK_DURATION));
  // named songs with no count: one each
  if (n == null && brief.titles?.length) n = brief.titles.length;
  if (n == null) n = DEFAULT_SONGS;
  n = Math.max(1, n);
  if (n > maxSongs) { notes.push({ code: 'cappedByAdmin', max: maxSongs }); n = maxSongs; }
  if (n > poolSize) { notes.push({ code: 'cappedByLibrary', found: poolSize }); n = poolSize; }
  return { n, notes };
}

function outside(v, lo, hi) {
  if (lo != null && v < lo) return lo - v;
  if (hi != null && v > hi) return v - hi;
  return 0;
}

function creditParts(artist) {
  return String(artist || '').toLowerCase().split(/[;,]|\s(?:&|and|feat\.?|ft\.?|featuring|vs\.?|pres\.?|presents?|x)\s/).map(p => artistKey(p)).filter(Boolean);
}

function scoreRow(row, brief, ctx) {
  const wantsGenre = ctx.genreRaw.size > 0 || brief.families.length > 0;
  let g = 0.5;
  if (wantsGenre) {
    const fam = ctx.familyOf(row);
    if (row.genre && ctx.genreRaw.has(row.genre)) g = 1;
    else if (fam && brief.families.includes(fam)) g = 0.85;
    else if (fam) g = 0.6 * Math.max(...(brief.families.length ? brief.families : [...ctx.genreFamilies]).map(f => familyCompat(f, fam)), 0);
    else g = 0.4;
  }

  let a = 0.5;
  if (ctx.seedArtists.size || ctx.similarRank.size) {
    const parts = creditParts(row.artist);
    const full = artistKey(row.artist);
    // the artist themselves before "X vs Y" mash-ups and featured credits
    if (ctx.seedArtists.has(full)) a = 1;
    else if (parts.some(p => ctx.seedArtists.has(p))) a = 0.85;
    else {
      const rank = ctx.similarRank.get(full) ?? Math.min(...parts.map(p => ctx.similarRank.get(p) ?? Infinity));
      a = Number.isFinite(rank) ? Math.max(0.35, 1 - rank / 60) : 0.25;
    }
  }

  let y = 0.5;
  if (brief.yearFrom != null || brief.yearTo != null) {
    if (!row.year) y = 0.35;
    else { const d = outside(row.year, brief.yearFrom, brief.yearTo); y = d === 0 ? 1 : Math.max(0, 1 - d / 8); }
  }

  let b = 0.5;
  if (brief.bpmFrom != null || brief.bpmTo != null) {
    if (!row.bpm) b = 0.4;
    else { const d = outside(row.bpm, brief.bpmFrom, brief.bpmTo); b = d === 0 ? 1 : Math.max(0, 1 - d / 25); }
  }

  const rating = row.rating || 0, pc = row.pc || 0;
  let f;
  if (brief.discovery) f = pc === 0 ? 1 : Math.max(0.1, 1 - pc / 5);
  else if (brief.favourites) f = 0.55 * rating / 10 + 0.45 * Math.min(pc, 20) / 20;
  else f = 0.5 + 0.3 * rating / 10 + 0.2 * Math.min(pc, 10) / 10;

  let k = 0.5;
  if (ctx.titles?.length) {
    // the song itself first ("Relax"), then versions of it ("Relax (Sex Mix)"),
    // then songs that merely contain the word ("Relax Vs I Feel Love")
    const title = String(row.title || '').toLowerCase();
    const base = baseTitle(row.title);
    if (ctx.titles.some(w => base === baseTitle(w))) k = brief.release === 'any' && /[([]/.test(title) ? 0.8 : 1;
    else if (!ctx.titles.some(w => title.includes(w))) k = 0.2;
  } else if (ctx.keywords.length) {
    const hay = `${row.title || ''} ${row.album || ''} ${row.genre || ''} ${row.filepath || ''}`.toLowerCase();
    k = ctx.keywords.some(w => hay.includes(w)) ? 1 : 0.3;
  }

  // "the longest version", "the newest": a strong, explicit wish
  let p = 0;
  if (brief.prefer !== 'none' && ctx.range) {
    const v = brief.prefer === 'longest' || brief.prefer === 'shortest' ? Number(row.duration) : Number(row.year);
    const { lo, hi } = brief.prefer === 'longest' || brief.prefer === 'shortest' ? ctx.range.duration : ctx.range.year;
    const norm = v > 0 && hi > lo ? (v - lo) / (hi - lo) : 0.5;
    p = (brief.prefer === 'longest' || brief.prefer === 'newest' ? norm : 1 - norm) * 0.5;
  }

  // The jitter breaks ties between equally good songs so two builds of the
  // same brief do not come out identical to the song.
  // eslint-disable-next-line sonarjs/pseudo-random
  const jitter = (Math.random() - 0.5) * 0.01;
  return 0.25 * g + 0.22 * a + 0.13 * y + 0.1 * b + 0.18 * f + 0.12 * k + p + jitter;
}

function seenCount(sorted, songKey) { return new Set(sorted.map(c => songKey(c.row))).size; }

// "Two Tribes (Keep The Peace Mix)", "Two Tribes - Radio Edit", "Two Tribes [12"]"
// → "two tribes"; "Cerrone feat. X — Supernature" and "Cerrone — Supernature" → the same.
const VERSION_WORDS = /\b(mix|remix|remixed|edit|version|versie|dub|instrumental|extended|radio|single|album|live|acoustic|unplugged|remaster(?:ed)?|mono|stereo|demo|rework|bootleg|12["”]?|7["”]?|inch|maxi|club|original|vocal|long|short|full|re-?edit)\b/g;
export function baseTitle(title) {
  let t = String(title || '').toLowerCase();
  t = t.replaceAll(/\s*[([{][^)\]}]*[)\]}]/g, ' ');
  const dash = t.split(/\s+[-–—:]\s+/);
  if (dash.length > 1 && VERSION_WORDS.test(dash.slice(1).join(' '))) t = dash[0];
  VERSION_WORDS.lastIndex = 0;
  return t.replaceAll(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
export function versionKey(row) {
  const primary = creditParts(row.artist)[0] || artistKey(row.artist);
  return `${primary}|${baseTitle(row.title)}`;
}

function albumKey(row) {
  return row.album ? `${artistKey(row.album_artist || row.artist)}|${row.album.toLowerCase()}` : null;
}

function selectSongs(scored, n, brief, ctx) {
  const sorted = [...scored].sort((x, y) => y.score - x.score);
  let perArtist = clamp(Math.ceil(n / 12), 1, 8);
  let perAlbum = clamp(Math.ceil(n / 30), 1, 4);
  // the listener named the artist(s) or the songs: the spread caps are not what they want
  if (brief.artistMode === 'only' && ctx.seedArtists.size) { perArtist = Math.max(perArtist, Math.ceil(n / ctx.seedArtists.size) + 1); perAlbum = n; }
  if (brief.titles?.length || brief.allVersions) { perArtist = n; perAlbum = n; }
  // the same song is one song: not twice from two compilations, and not as
  // the 7-inch, the 12-inch and the remix — unless every version was asked for
  // "all versions": every distinct version once — the Sex Mix from five
  // compilations is still one Sex Mix
  const songKey = brief.allVersions ? (r => `${artistKey(r.artist)}|${String(r.title || '').toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, ' ').trim()}`) : versionKey;
  for (;;) {
    const picked = [];
    const byArtist = new Map(), byAlbum = new Map(), seen = new Set();
    for (const c of sorted) {
      if (picked.length >= n) break;
      const ak = artistKey(c.row.artist), al = albumKey(c.row), sk = songKey(c.row);
      if (seen.has(sk)) continue;
      if ((byArtist.get(ak) || 0) >= perArtist) continue;
      if (al && (byAlbum.get(al) || 0) >= perAlbum) continue;
      seen.add(sk);
      byArtist.set(ak, (byArtist.get(ak) || 0) + 1);
      if (al) byAlbum.set(al, (byAlbum.get(al) || 0) + 1);
      picked.push(c);
    }
    if (picked.length >= n || perArtist >= n || picked.length >= seenCount(sorted, songKey)) return picked;
    perArtist *= 2; perAlbum *= 2;
  }
}

// "The Grandmix 1983 and 1986": every named title gets its best match, so two
// versions of the first cannot crowd out the second.
function ensureTitles(picked, scored, ctx) {
  const titles = ctx.titles || [];
  if (titles.length < 2) return picked;
  const matches = (c, t) => String(c.row.title || '').toLowerCase().includes(t) || baseTitle(c.row.title) === baseTitle(t);
  const chosen = new Set(picked);
  for (const t of titles) {
    if (picked.some(c => matches(c, t))) continue;
    const best = scored.filter(c => !chosen.has(c) && matches(c, t)).sort((x, y) => y.score - x.score)[0];
    if (!best) continue;
    // the weakest pick whose title another pick already covers, else the weakest of all
    const covered = new Map();
    for (const c of picked) for (const u of titles) if (matches(c, u)) covered.set(u, (covered.get(u) || 0) + 1);
    let victim = -1;
    for (let i = picked.length - 1; i >= 0; i--) {
      const spare = titles.some(u => matches(picked[i], u) && covered.get(u) > 1) || !titles.some(u => matches(picked[i], u));
      if (spare && (victim < 0 || picked[i].score < picked[victim].score)) victim = i;
    }
    if (victim < 0) break;
    chosen.delete(picked[victim]); chosen.add(best);
    picked[victim] = best;
  }
  return picked;
}

// A listener who names an artist expects to hear that artist: every seed with
// songs in the pool gets at least one slot, replacing the weakest other pick.
function ensureSeeds(picked, scored, ctx) {
  if (!ctx.seedArtists.size) return picked;
  const has = new Set(picked.flatMap(c => creditParts(c.row.artist).concat(artistKey(c.row.artist))));
  const chosen = new Set(picked);
  for (const seed of ctx.seedArtists) {
    if (has.has(seed)) continue;
    const best = scored.filter(c => !chosen.has(c) && (artistKey(c.row.artist) === seed || creditParts(c.row.artist).includes(seed))).sort((x, y) => y.score - x.score)[0];
    if (!best) continue;
    let victim = -1;
    for (let i = picked.length - 1; i >= 0; i--) {
      const parts = creditParts(picked[i].row.artist).concat(artistKey(picked[i].row.artist));
      if (!parts.some(p => ctx.seedArtists.has(p)) && (victim < 0 || picked[i].score < picked[victim].score)) victim = i;
    }
    if (victim < 0) break;
    chosen.delete(picked[victim]); chosen.add(best);
    picked[victim] = best;
    has.add(seed);
  }
  return picked;
}

function hill(asc, peakAt = 0.5) {
  const left = [], right = [];
  const leftShare = clamp(peakAt, 0.2, 0.8);
  let acc = 0;
  for (const s of asc) {
    acc += leftShare;
    if (acc >= 1) { acc -= 1; left.push(s); } else right.unshift(s);
  }
  return [...left, ...right];
}

function chain(items) {
  if (items.length <= 2) return items;
  const rest = new Set(items);
  let cur = items[Math.floor(items.length / 2)];
  const out = [cur];
  rest.delete(cur);
  while (rest.size) {
    let best = null, bestCost = Infinity;
    for (const c of rest) {
      const cost = Math.abs(c.row.bpm - cur.row.bpm) + (1 - camelotScore(cur.key, c.key)) * 8;
      if (cost < bestCost) { best = c; bestCost = cost; }
    }
    out.push(best); rest.delete(best); cur = best;
  }
  return out;
}

// A mix moves in small steps: the next song sits within about 2.5% of the
// tempo of the one before it (3 BPM at 125), never 6 or 7.
const maxStep = bpm => Math.max(2, (bpm || 125) * 0.025);

// A hill or a wave walks the ladder two rungs at a time; when the picks are
// too few for that to stay within a step, a plain climb it is — the arc is a
// wish, the small steps are the craft.
function gentle(shaped, asc) {
  const jumpy = shaped.some((c, i) => i > 0 && Math.abs(c.row.bpm - shaped[i - 1].row.bpm) > maxStep(Math.min(c.row.bpm, shaped[i - 1].row.bpm)));
  return jumpy ? asc : shaped;
}

function shape(withBpm, energy) {
  const asc = [...withBpm].sort((x, y) => x.row.bpm - y.row.bpm);
  switch (energy) {
    case 'build': return asc;
    case 'cooldown': return asc.reverse();
    case 'peak': return gentle(hill(asc, 0.65), asc);
    case 'wave': {
      const a = asc.filter((_, i) => i % 2 === 0), b = asc.filter((_, i) => i % 2 === 1);
      return gentle([...hill(a, 0.5), ...hill(b, 0.5)], asc);
    }
    default:
      // steady: a gentle rise and fall through the corridor — a nearest-neighbour
      // chain would leave the far ends for last and jump to them
      if (asc.length > CHAIN_LIMIT) return asc.flatMap((_, i) => i % 200 === 0 ? hill(asc.slice(i, i + 200), 0.5) : []);
      return gentle(hill(asc, 0.5), asc);
  }
}

// After the picks: the widest tempo gap on the ladder is filled from the
// corridor, a song from the densest stretch giving up its slot — never a named
// artist or title, never the ends that anchor the arc.
// `tight` halves the allowed rung for shapes that walk the ladder two rungs at
// a time (a hill: up one side, down the other).
function smoothTempo(picked, candidates, ctx, tight = 1) {
  const keep = c => ctx.seedArtists.has(artistKey(c.row.artist)) || (ctx.titles || []).some(t => String(c.row.title || '').toLowerCase().includes(t));
  const chosen = new Set(picked);
  for (let iter = 0; iter < picked.length * 2; iter++) {
    const ladder = picked.filter(c => c.row.bpm > 0).sort((a, b) => a.row.bpm - b.row.bpm);
    if (ladder.length < 3) return picked;
    let gi = -1, gap = 0;
    for (let i = 1; i < ladder.length; i++) {
      const d = ladder[i].row.bpm - ladder[i - 1].row.bpm;
      if (d > gap) { gap = d; gi = i; }
    }
    if (gi < 0) return picked;
    const lo = ladder[gi - 1].row.bpm, hi = ladder[gi].row.bpm;
    if (gap <= maxStep(lo) * tight) return picked;
    const seen = new Set(picked.map(c => versionKey(c.row)));
    // the songs that sit in the gap — never a markedly weaker one than the
    // song it replaces, so the asked era, the favourites, the similar artists
    // are not traded for a rung; among the nearly-best, the one nearest the middle
    const inGap = candidates
      .filter(c => !chosen.has(c) && c.row.bpm > lo && c.row.bpm < hi && !seen.has(versionKey(c.row)))
      .sort((a, b) => b.score - a.score);
    if (!inGap.length) return picked;
    const mid = (lo + hi) / 2;
    const filler = inGap.filter(c => c.score >= inGap[0].score - 0.03).sort((a, b) => Math.abs(a.row.bpm - mid) - Math.abs(b.row.bpm - mid))[0];
    // the victim: the song whose removal, with the filler in place, leaves
    // the ladder with the smallest worst gap — its slot must still mix, or
    // the worst gap must shrink. Never an end, never an end of the gap itself.
    const d = ladder.map((c, i) => (i ? c.row.bpm - ladder[i - 1].row.bpm : 0));
    d[gi] = 0;
    const pre = [], suf = [];
    for (let i = 0; i < d.length; i++) pre[i] = Math.max(d[i], pre[i - 1] ?? 0);
    for (let i = d.length - 1; i >= 0; i--) suf[i] = Math.max(d[i], suf[i + 1] ?? 0);
    const split = Math.max(filler.row.bpm - lo, hi - filler.row.bpm);
    let victim = null, after = Infinity, opens = Infinity;
    for (let i = 1; i + 1 < ladder.length; i++) {
      const c = ladder[i];
      if (keep(c) || i === gi - 1 || i === gi || filler.score < c.score - 0.03) continue;
      const o = ladder[i + 1].row.bpm - ladder[i - 1].row.bpm;
      const a = Math.max(pre[i - 1], suf[i + 2] ?? 0, o, split);
      if (a < after || (a === after && c.score < victim.score)) { after = a; victim = c; opens = o; }
    }
    if (!victim || after > gap || (after === gap && opens > maxStep(lo))) return picked;
    picked[picked.indexOf(victim)] = filler;
    chosen.delete(victim);
    chosen.add(filler);
  }
  return picked;
}

// "From 100 to 120 BPM": a build or cooldown between two named tempos is a
// journey that must arrive. The ladder is laid out on evenly spaced rungs
// from the one tempo to the other, each rung taking the best song within
// half a rung of it (never twice the same artist back to back, one artist
// never dominating); named artists and titles keep their slots, and a rung
// nobody fits stays with the original pick.
function journeyLadder(picked, candidates, ctx, lo, hi) {
  const n = picked.length;
  if (n < 2) return picked;
  const keep = c => ctx.seedArtists.has(artistKey(c.row.artist)) || (ctx.titles || []).some(t => String(c.row.title || '').toLowerCase().includes(t));
  const out = picked.filter(keep);
  const chosen = new Set(out);
  const seen = new Set(out.map(c => versionKey(c.row)));
  const perArtist = clamp(Math.ceil(n / 12), 1, 8);
  const byArtist = new Map();
  for (const c of out) byArtist.set(artistKey(c.row.artist), (byArtist.get(artistKey(c.row.artist)) || 0) + 1);
  const rung = (hi - lo) / (n - 1);
  const fits = x => !chosen.has(x) && x.row.bpm > 0 && !seen.has(versionKey(x.row)) && (byArtist.get(artistKey(x.row.artist)) || 0) < perArtist;
  for (let k = 0; k < n && out.length < n; k++) {
    const target = lo + rung * k;
    const reach = Math.max(rung / 2, maxStep(target) / 2);
    // a rung nobody sits on exactly takes the nearest song, up to a step and a half away
    let c = null;
    for (const widen of [1, 2, 3]) {
      c = candidates
        .filter(x => fits(x) && Math.abs(x.row.bpm - target) <= reach * widen)
        .sort((a, b) => b.score - a.score || Math.abs(a.row.bpm - target) - Math.abs(b.row.bpm - target))[0];
      if (c) break;
    }
    if (!c) continue;
    out.push(c);
    chosen.add(c);
    seen.add(versionKey(c.row));
    byArtist.set(artistKey(c.row.artist), (byArtist.get(artistKey(c.row.artist)) || 0) + 1);
  }
  for (const c of picked) if (out.length < n && !chosen.has(c) && !seen.has(versionKey(c.row))) { out.push(c); chosen.add(c); seen.add(versionKey(c.row)); }
  return out;
}

function orderBy(picked, order) {
  const list = [...picked];
  const year = c => Number(c.row.year) || 0;
  const name = c => `${c.row.artist || ''} ${c.row.title || ''}`.toLowerCase();
  if (order === 'chronological') return list.sort((a, b) => year(a) - year(b) || name(a).localeCompare(name(b)));
  if (order === 'newestFirst') return list.sort((a, b) => year(b) - year(a) || name(a).localeCompare(name(b)));
  if (order === 'alphabetical') return list.sort((a, b) => name(a).localeCompare(name(b)));
  // random: the jittered score order already shuffles equals; a real shuffle here
  for (let i = list.length - 1; i > 0; i--) {
    // eslint-disable-next-line sonarjs/pseudo-random
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function sprinkle(seq, extras) {
  if (!extras.length) return seq;
  const out = [...seq];
  const step = (seq.length + 1) / (extras.length + 1);
  extras.forEach((e, i) => out.splice(Math.min(out.length, Math.round(step * (i + 1)) + i), 0, e));
  return out;
}

// Harmonic mixing on the Camelot wheel: a transition is harmonic when the next
// song is in the same key, one step round the wheel (8A → 7A / 9A) or the
// relative major/minor (8A ↔ 8B). Walking the tempo ladder, the next song is
// the one the current key mixes into — as long as the tempo step stays small
// and no artist ends up next to itself.
export const HARMONIC = 0.8;
export function harmonic(a, b) { return !!a && !!b && camelotScore(a, b) >= HARMONIC; }

// Reordering can only do so much when the picks' keys do not chain. Walking
// the finished ladder, a transition that is not harmonic is repaired from the
// corridor: a song at the same tempo whose key the previous one mixes into,
// scoring as well, by another artist — never a named artist or title.
function harmonicChain(seq, candidates, ctx) {
  if (seq.length < 3) return seq;
  const n = seq.length;
  const perArtist = clamp(Math.ceil(n / 12), 1, 8);
  const spacing = clamp(Math.floor(n / 8), 1, 10);
  const keep = c => ctx.seedArtists.has(artistKey(c.row.artist)) || (ctx.titles || []).some(t => String(c.row.title || '').toLowerCase().includes(t));
  const out = [seq[0]];
  // replacements come from outside the set: a song that sits later on the
  // ladder is not pulled forward, or it would play twice
  const chosen = new Set(seq);
  const seen = new Set(seq.map(c => versionKey(c.row)));
  const byArtist = new Map([[artistKey(seq[0].row.artist), 1]]);
  for (let i = 1; i < n; i++) {
    const slot = seq[i], prev = out.at(-1);
    let pick = slot;
    if (slot.row.bpm > 0 && prev.key && !harmonic(prev.key, slot.key) && !keep(slot)) {
      const recent = new Set(out.slice(-spacing).map(c => artistKey(c.row.artist)));
      const next = seq[i + 1];
      // the replacement sits where the slot sat: within a step of the song
      // before and the song after, by an artist heard neither just before nor just after
      const prevBpm = prev.row.bpm > 0 ? prev.row.bpm : null, nextBpm = next?.row.bpm > 0 ? next.row.bpm : null;
      const fits = c => Math.abs(c.row.bpm - slot.row.bpm) <= maxStep(slot.row.bpm) / 2
        && (prevBpm == null || Math.abs(c.row.bpm - prevBpm) <= maxStep(prevBpm))
        && (nextBpm == null || Math.abs(c.row.bpm - nextBpm) <= maxStep(nextBpm))
        && (!next || artistKey(next.row.artist) !== artistKey(c.row.artist));
      const alt = candidates
        .filter(c => !chosen.has(c) && c.row.bpm > 0 && !seen.has(versionKey(c.row)) && harmonic(prev.key, c.key) && fits(c)
          && !recent.has(artistKey(c.row.artist)) && (byArtist.get(artistKey(c.row.artist)) || 0) < perArtist
          && c.score >= slot.score - 0.05)
        .sort((a, b) => b.score - a.score || Math.abs(a.row.bpm - slot.row.bpm) - Math.abs(b.row.bpm - slot.row.bpm))[0];
      if (alt) pick = alt;
    }
    out.push(pick);
    chosen.add(pick);
    seen.add(versionKey(pick.row));
    byArtist.set(artistKey(pick.row.artist), (byArtist.get(artistKey(pick.row.artist)) || 0) + 1);
  }
  return out;
}

// A build climbs and a cooldown falls: a swap for a key or an artist may not
// turn the arc back on itself (a wobble of half a step is nothing).
function arcKeeper(seq, energy) {
  const dir = { build: 1, cooldown: -1 }[energy] || 0;
  if (!dir) return () => true;
  const known = c => c.row.bpm > 0;
  const ok = (a, b) => !known(a) || !known(b) || (b.row.bpm - a.row.bpm) * dir >= -maxStep(Math.min(a.row.bpm, b.row.bpm)) / 2;
  return pos => (pos === 0 || ok(seq[pos - 1], seq[pos])) && (pos + 1 >= seq.length || ok(seq[pos], seq[pos + 1]));
}

function harmonize(seq, energy = 'steady') {
  const gap = (a, b) => (a.row.bpm > 0 && b.row.bpm > 0 ? Math.abs(a.row.bpm - b.row.bpm) : 0);
  const arc = arcKeeper(seq, energy);
  const smoothAt = pos => arc(pos) && (pos === 0 || gap(seq[pos - 1], seq[pos]) <= maxStep(seq[pos].row.bpm)) && (pos + 1 >= seq.length || gap(seq[pos], seq[pos + 1]) <= maxStep(seq[pos].row.bpm));
  const sameArtist = (a, b) => a && b && artistKey(a.row.artist) === artistKey(b.row.artist);
  const clashAt = pos => sameArtist(seq[pos], seq[pos - 1]) || sameArtist(seq[pos], seq[pos + 1]);
  for (let i = 0; i + 1 < seq.length; i++) {
    const cur = seq[i];
    const known = c => c.row.bpm > 0;
    if (!cur.key || !known(seq[i + 1])) continue;
    let bestJ = i + 1, best = camelotScore(cur.key, seq[i + 1].key);
    if (best >= HARMONIC) continue;
    for (let j = i + 2; j <= Math.min(i + 8, seq.length - 1); j++) {
      const s = camelotScore(cur.key, seq[j].key);
      if (s <= best || s < HARMONIC || !known(seq[j])) continue;
      [seq[i + 1], seq[j]] = [seq[j], seq[i + 1]];
      const fits = smoothAt(i + 1) && smoothAt(j) && !clashAt(i + 1) && !clashAt(j);
      [seq[i + 1], seq[j]] = [seq[j], seq[i + 1]];
      if (fits) { best = s; bestJ = j; }
    }
    if (bestJ !== i + 1) [seq[i + 1], seq[bestJ]] = [seq[bestJ], seq[i + 1]];
  }
  return seq;
}

function spaceArtists(seq) {
  const gap = clamp(Math.floor(seq.length / 8), 1, 10);
  const clash = (i, pos, within = gap) => {
    const k = artistKey(seq[i].row.artist);
    for (let d = 1; d <= within; d++) {
      if (pos - d >= 0 && pos - d !== i && artistKey(seq[pos - d].row.artist) === k) return true;
      if (pos + d < seq.length && pos + d !== i && artistKey(seq[pos + d].row.artist) === k) return true;
    }
    return false;
  };
  // A swap prefers a spot with about the same tempo, so the energy arc
  // survives; only the same artist twice in a row is bad enough to accept a
  // tempo jump for.
  const tempoGap = (a, b) => (a.row.bpm > 0 && b.row.bpm > 0) ? Math.abs(a.row.bpm - b.row.bpm) : 0;
  const adjacent = i => i > 0 && artistKey(seq[i].row.artist) === artistKey(seq[i - 1].row.artist);
  // after a swap the song must still sit next to tempos within the step: the
  // ladder 118-120-122 never becomes 118-122-120
  const smoothAt = (pos, maxGap) => (pos === 0 || tempoGap(seq[pos - 1], seq[pos]) <= maxGap) && (pos + 1 >= seq.length || tempoGap(seq[pos], seq[pos + 1]) <= maxGap);
  const trySwap = (i, maxGap, within = gap) => {
    // Nearest positions first, so a song never travels far along the arc.
    const candidates = [];
    for (let d = 1; d <= 40; d++) {
      if (i + d < seq.length) candidates.push(i + d);
      if (d >= 2 && i - d >= 0) candidates.push(i - d);
    }
    const known = c => c.row.bpm > 0;
    for (const j of candidates) {
      // a song without a tempo only trades places with another such song: it
      // was sprinkled through the set on purpose and must not drift to the end
      if (known(seq[i]) !== known(seq[j]) && maxGap !== Infinity) continue;
      if (tempoGap(seq[i], seq[j]) > maxGap) continue;
      [seq[i], seq[j]] = [seq[j], seq[i]];
      if (!clash(i, i, within) && !clash(j, j, within) && smoothAt(i, maxGap) && smoothAt(j, maxGap)) return true;
      [seq[i], seq[j]] = [seq[j], seq[i]];
    }
    return false;
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < seq.length; i++) {
      if (!clash(i, i)) continue;
      const step = maxStep(seq[i].row.bpm);
      // the smallest move first, so the arc barely notices
      if (trySwap(i, step / 2) || trySwap(i, step)) continue;
      // the same artist twice in a row is the one thing worth more: then it is
      // enough that they are no longer neighbours, still in small steps
      if (adjacent(i)) trySwap(i, step / 2, 1) || trySwap(i, step, 1) || trySwap(i, step * 2, 1) || trySwap(i, Infinity, 1);
    }
  }
  return seq;
}

// pool: candidate rows (artist, album, title, year, genre, bpm, musical_key,
// duration, rating, pc, filepath). ctx: seedArtists (Set of artistKey),
// similarRank (Map artistKey → 1-based rank), genreRaw (Set of raw tags that
// match the asked genres), genreFamilies (families of those tags), familyOf(row),
// keywords (lowercase). Returns the ordered rows plus what was decided.
function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    // eslint-disable-next-line sonarjs/pseudo-random
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// A mix DJ's set is picked from one corridor: a seed song, and around it only
// songs a DJ could mix into each other — within a few BPM (the corridor
// follows the energy arc: a build climbs, a steady set stays), in a
// compatible key, of the same genre. "Songs that match each other"
// (cohesive) is the strict version: the same genre tag, near-identical tempo,
// no song without a key. When the pool is too small the rules widen one step
// at a time, and every step taken is reported.
const STRICT_STEPS = [
  { lo: 0.03, hi: 0.03, key: 0.8, genre: 'tag' },
  { lo: 0.06, hi: 0.06, key: 0.8, genre: 'tag' },
  { lo: 0.06, hi: 0.06, key: 0.8, genre: 'family' },
  { lo: 0.06, hi: 0.06, key: 0.5, genre: 'family' },
  { lo: 0.08, hi: 0.08, key: 0, genre: 'family' },
];
const FLOW_SPAN = { steady: [0.06, 0.06], build: [0.02, 0.14], cooldown: [0.02, 0.14], peak: [0.02, 0.12], wave: [0.02, 0.12] };
// a phase that follows another drifts up from where that one ended rather
// than opening below it
const FOLLOW_SPAN = [0.02, 0.1];
// A journey between two named tempos spans too many rungs to keep every song
// in a key compatible with one seed: there the keys are matched transition
// by transition, later, and the corridor is only the genre family.
function flowSteps(energy, follows = false, keyed = true) {
  const [lo, hi] = follows && energy === 'steady' ? FOLLOW_SPAN : FLOW_SPAN[energy] || FLOW_SPAN.steady;
  return [
    { lo, hi, key: keyed ? 0.5 : 0, genre: 'family' },
    { lo, hi, key: 0, genre: 'family' },
    { lo: lo * 1.5, hi: hi * 1.5, key: 0, genre: 'family' },
    { lo: lo * 1.5, hi: hi * 1.5, key: 0, genre: 'any' },
  ];
}
function mixableSubset(scored, n, brief, ctx, notes) {
  const strict = brief.cohesive;
  const withBpm = scored.filter(c => c.row.bpm > 0);
  const hasBpm = new Set(withBpm);
  const without = strict ? [] : scored.filter(c => !hasBpm.has(c));
  if (withBpm.length < (strict ? Math.min(n, 2) : Math.max(n * 1.5, 8))) {
    if (strict) notes.push({ code: 'cohesionDropped' });
    return scored;
  }
  const genreOf = r => String(r.genre || '').toLowerCase().trim();
  const arc = brief.energy;
  const candidates = (brief.order === 'random' ? shuffle(withBpm) : [...withBpm].sort((x, y) => y.score - x.score)).slice(0, strict ? 16 : 48);
  // a seed with a key and a genre can be matched on all three; for an arc the
  // seed is where the arc starts — a build climbs from a slow song, a cooldown
  // falls from a fast one — so the corridor can hold the whole climb
  const complete = c => (c.key ? 1 : 0) + (genreOf(c.row) ? 1 : 0);
  // a phase that follows another starts where that one ended: the seed is
  // the song nearest that tempo, whatever the arc does from there
  const start = !strict && ctx.startBpm > 0 ? ctx.startBpm : null;
  let seeds;
  if (start) seeds = [...candidates].sort((a, b) => Math.abs(a.row.bpm - start) - Math.abs(b.row.bpm - start) || complete(b) - complete(a));
  else if (!strict && arc !== 'steady') seeds = [...candidates].sort((a, b) => (arc === 'cooldown' ? b.row.bpm - a.row.bpm : a.row.bpm - b.row.bpm) || complete(b) - complete(a));
  else seeds = [...candidates].sort((a, b) => complete(b) - complete(a));
  seeds = seeds.slice(0, 16);
  // "from 100 to 120": a journey between two named tempos is the corridor at
  // least; a steady set "around 100" keeps its tight corridor inside the range
  const asked = !strict && (arc === 'build' || arc === 'cooldown') && brief.bpmFrom != null && brief.bpmTo != null;
  const steps = strict ? STRICT_STEPS : flowSteps(arc, !!start, !asked).map(s => (arc === 'cooldown' ? { ...s, lo: s.hi, hi: s.lo } : s));
  // a corridor is only worth it when it costs no quality: it must hold enough
  // distinct songs, enough room under the per-artist cap, and its best picks
  // must score as the best picks of the whole pool do (the asked era, the
  // favourites, the similar artists …)
  const perArtist = clamp(Math.ceil(n / 12), 1, 8);
  // the best n the selection could take from a list, under the per-artist cap
  const cappedTop = list => {
    const by = new Map();
    let sum = 0, taken = 0;
    for (const c of [...list].sort((x, y) => y.score - x.score)) {
      const a = artistKey(c.row.artist);
      if ((by.get(a) || 0) >= perArtist) continue;
      by.set(a, (by.get(a) || 0) + 1);
      sum += c.score;
      if (++taken >= n) break;
    }
    return { sum, taken };
  };
  const bar = strict ? 0 : 0.97 * cappedTop(scored).sum;
  // and its tempo ladder must have no rung missing: a corridor whose songs
  // sit 4 BPM apart cannot be mixed in small steps, whatever else it holds
  const smoothLadder = subset => {
    const vals = [...new Set(subset.map(c => Math.round(c.row.bpm)))].sort((a, b) => a - b);
    const core = vals.slice(Math.floor(vals.length * 0.05), Math.ceil(vals.length * 0.95));
    return core.every((v, i) => i === 0 || v - core[i - 1] <= maxStep(core[i - 1]));
  };
  const good = subset => {
    if (seenCount(subset, versionKey) < n) return false;
    // three songs that match each other are three artists, not one remix album
    if (strict) return cappedTop(subset).taken >= n;
    const top = cappedTop([...subset, ...without]);
    return top.taken >= n && top.sum >= bar && smoothLadder(subset);
  };
  let best = { subset: [], seed: null, step: null };
  for (const step of steps) {
    for (const seed of seeds) {
      const g = genreOf(seed.row), f = ctx.familyOf(seed.row);
      const lo = asked ? Math.max(step.lo, (seed.row.bpm - brief.bpmFrom) / seed.row.bpm) : step.lo;
      const hi = asked ? Math.max(step.hi, (brief.bpmTo - seed.row.bpm) / seed.row.bpm) : step.hi;
      const subset = withBpm.filter(c => {
        const d = c.row.bpm - seed.row.bpm;
        if (d < -seed.row.bpm * lo || d > seed.row.bpm * hi) return false;
        if (step.key > 0 && seed.key && (!c.key || camelotScore(seed.key, c.key) < step.key)) return false;
        if (step.genre === 'tag' && g) return genreOf(c.row) === g;
        if (step.genre !== 'any' && f) return ctx.familyOf(c.row) === f;
        return true;
      });
      if (subset.length > best.subset.length) best = { subset, seed, step };
      if (good(subset)) {
        if (!strict) {
          notes.push({ code: 'flowCorridor', from: Math.round(seed.row.bpm * (1 - lo)), to: Math.round(seed.row.bpm * (1 + hi)), genre: f || '' });
          return [...subset, ...without];
        }
        report(seed, step, subset.length);
        // songs that must match each other: the closer to the seed's tempo, the better
        const span = Math.max(1, seed.row.bpm * step.hi);
        return subset.map(c => ({ ...c, score: c.score + 0.3 * (1 - Math.abs(c.row.bpm - seed.row.bpm) / span) }));
      }
    }
  }
  if (!strict) return scored;
  if (best.seed) report(best.seed, best.step, best.subset.length);
  notes.push({ code: 'cohesionPartial', found: best.subset.length });
  return best.subset.length ? best.subset : scored;

  function report(seed, step, found) {
    const r = seed.row;
    notes.push({ code: 'cohesionSeed', artist: r.artist || '', title: r.title || '', bpm: Math.round(r.bpm), key: seed.key || '—', genre: r.genre || '—', pct: Math.round(step.hi * 100), found });
    if (step.genre === 'family' && genreOf(r)) notes.push({ code: 'cohesionFamily' });
    if (step.key === 0 && seed.key) notes.push({ code: 'cohesionKeyDropped' });
    else if (step.key < 0.8 && seed.key) notes.push({ code: 'cohesionKeyLoose' });
  }
}

// A steady phase between other phases starts near the tempo the phase before
// ended on and ends near the one the next phase opens with. A hill's two ends
// are the two slowest songs, one rung apart, so the hill can be turned to
// start anywhere and every step stays small; a plain ramp (the hill's
// fallback) can only be turned round.
function fromStart(shaped, energy, startBpm, endBpm) {
  const start = startBpm > 0 ? startBpm : null, end = endBpm > 0 ? endBpm : null;
  if (energy !== 'steady' || (!start && !end) || shaped.length < 4 || shaped.length > CHAIN_LIMIT) return shaped;
  const cost = seq => (start ? Math.abs(seq[0].row.bpm - start) : 0) + (end ? Math.abs(seq.at(-1).row.bpm - end) : 0);
  // a hill always ends next to where it starts; between a slower and a faster
  // phase the plain climb (or descent) through the corridor is the better bridge
  const asc = [...shaped].sort((a, b) => a.row.bpm - b.row.bpm);
  const options = [shaped, asc, [...asc].reverse()];
  const first = shaped[0].row.bpm, last = shaped.at(-1).row.bpm;
  if (Math.abs(last - first) <= maxStep(Math.min(first, last))) {
    for (let at = 1; at < shaped.length; at++) options.push([...shaped.slice(at), ...shaped.slice(0, at)]);
  }
  let best = shaped, bestCost = cost(shaped);
  for (const seq of options) {
    const c = cost(seq);
    if (c < bestCost) { best = seq; bestCost = c; }
  }
  return best;
}

function arrange(picked, energy, startBpm = null, endBpm = null) {
  const withBpm = picked.filter(c => c.row.bpm > 0);
  const hasBpm = new Set(withBpm);
  const without = picked.filter(c => !hasBpm.has(c));
  // keys are harmonised again after the artist spacing, which may have moved a song
  return harmonize(spaceArtists(harmonize(sprinkle(fromStart(shape(withBpm, energy), energy, startBpm, endBpm), without), energy)), energy);
}

const dur = (row, fallback) => (Number(row.duration) > 0 ? Number(row.duration) : fallback);

// What the player shows about a set: how it moves in tempo and in key.
export function queueStats(songs, { pool = 0, avgDuration = FALLBACK_DURATION } = {}) {
  const bpms = songs.map(s => s.bpm).filter(b => b > 0);
  let maxStepTaken = null;
  let harmonicOk = 0, harmonicTotal = 0;
  for (let i = 1; i < songs.length; i++) {
    if (songs[i].bpm > 0 && songs[i - 1].bpm > 0) maxStepTaken = Math.max(maxStepTaken ?? 0, Math.abs(songs[i].bpm - songs[i - 1].bpm));
    const a = toCamelot(songs[i - 1].musical_key), b = toCamelot(songs[i].musical_key);
    if (a && b) { harmonicTotal++; if (harmonic(a, b)) harmonicOk++; }
  }
  const minutes = Math.round(songs.reduce((s, r) => s + dur(r, avgDuration), 0) / 60);
  return {
    pool, picked: songs.length, minutes,
    artists: new Set(songs.map(s => artistKey(s.artist))).size,
    bpmFrom: bpms.length ? Math.min(...bpms) : null, bpmTo: bpms.length ? Math.max(...bpms) : null,
    withBpm: bpms.length, maxStep: maxStepTaken == null ? null : Math.round(maxStepTaken * 10) / 10,
    harmonic: harmonicOk, transitions: harmonicTotal, withKey: songs.filter(s => toCamelot(s.musical_key)).length,
  };
}

export function planQueue({ brief, pool, maxSongs, ctx }) {
  const notes = [];
  if (!pool.length) return { songs: [], notes: [{ code: 'empty' }], stats: { pool: 0, picked: 0, minutes: 0 } };
  const typical = median(pool.map(r => Number(r.duration))) || FALLBACK_DURATION;
  const byTime = brief.minutes != null && brief.songs == null;
  // A two-hour set is not the place for a 60-minute megamix: with a time
  // target, songs far longer than the typical one stay out of the pool.
  const usable = byTime ? pool.filter(r => dur(r, typical) <= typical * 4) : pool;
  const wantAll = brief.allVersions && brief.titles.length > 0 && brief.songs == null && brief.minutes == null;
  const { n, notes: countNotes } = wantAll
    ? { n: Math.min(maxSongs, usable.length), notes: usable.length > maxSongs ? [{ code: 'cappedByAdmin', max: maxSongs }] : [] }
    : targetCount(brief, { avgDuration: typical, maxSongs, poolSize: usable.length });
  notes.push(...countNotes);

  if (brief.prefer !== 'none') {
    const ds = usable.map(r => Number(r.duration)).filter(v => v > 0), ys = usable.map(r => Number(r.year)).filter(v => v > 0);
    ctx = { ...ctx, range: { duration: { lo: Math.min(...ds, Infinity), hi: Math.max(...ds, -Infinity) }, year: { lo: Math.min(...ys, Infinity), hi: Math.max(...ys, -Infinity) } } };
  }
  const all = usable.map(row => ({ row, key: toCamelot(row.musical_key), score: scoreRow(row, brief, ctx) }));
  // a mixable corridor for a DJ-ordered set; named artists and titles may still come from anywhere
  // "the longest version", a named song, every version: searches, not mixes
  const flow = brief.cohesive || (brief.order === 'dj' && !brief.titles.length && !brief.allVersions && brief.prefer === 'none');
  const scored = flow ? mixableSubset(all, n, brief, ctx, notes) : all;
  let picked = ensureTitles(ensureSeeds(selectSongs(scored, n, brief, ctx), all, ctx), all, ctx);
  if (byTime) {
    // The median guessed the count; the real durations of the picks decide.
    const target = brief.minutes * 60;
    const total = picked.reduce((s, c) => s + dur(c.row, typical), 0);
    if (total > target * 1.15 || (total < target * 0.85 && picked.length < usable.length)) {
      const n2 = Math.max(1, Math.min(maxSongs, usable.length, Math.round(picked.length * target / total)));
      if (n2 !== picked.length) picked = ensureSeeds(selectSongs(scored, n2, brief, ctx), scored, ctx);
    }
  }
  const journey = flow && (brief.energy === 'build' || brief.energy === 'cooldown') && brief.bpmFrom != null && brief.bpmTo != null;
  if (journey) picked = journeyLadder(picked, scored, ctx, brief.bpmFrom, brief.bpmTo);
  if (flow) picked = smoothTempo(picked, scored, ctx, ['steady', 'peak', 'wave'].includes(brief.energy) ? 0.5 : 1);
  // countdown only means something for a chart; a mixed set keeps its flow, and
  // "random" songs that must match each other are still laid out as a mix
  let seq = brief.order === 'dj' || brief.order === 'countdown' || brief.cohesive ? arrange(picked, brief.energy, ctx.startBpm, ctx.endBpm) : orderBy(picked, brief.order);
  // then the keys: a transition that does not mix is repaired from the corridor
  if (flow) seq = harmonicChain(seq, scored, ctx);

  const songs = seq.map(c => c.row);
  return { songs, notes, stats: queueStats(songs, { pool: pool.length, avgDuration: typical }) };
}
