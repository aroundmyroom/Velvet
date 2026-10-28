// Fallback for the AI DJ when Claude cannot be asked (no key, budget spent,
// network down): reads the listener's text with plain rules against the
// library's own genre, artist and folder names. Covers "two hours of 80s
// italo, no Modern Talking"; the model remains the upgrade for the fuzzy rest.
import { toKey } from './genre-merge.js';
import { matchChart, parseChartRange, stripChartWords } from './ai-charts.js';

const DECADE_WORDS = {
  fifties: 1950, sixties: 1960, seventies: 1970, eighties: 1980, nineties: 1990, noughties: 2000,
  jaren50: 1950, jaren60: 1960, jaren70: 1970, jaren80: 1980, jaren90: 1990,
};
const TEMPO_WORDS = [
  [/\b(chill|chilled|relaxed|relaxing|slow|downtempo|rustig|langzaam)\b/, 80, 110],
  [/\b(groove|groovy|mid-?tempo|midtempo)\b/, 110, 122],
  [/\b(peak[- ]?time|peak time|piek|banging|driving)\b/, 128, 140],
  [/\b(hard|harder|hardcore|hardstyle|gabber)\b/, 150, 200],
];
const ENERGY_WORDS = [
  [/\b(build|building|builds|warm[- ]?up|opbouw|opbouwen|opbouwend|rising)\b/, 'build'],
  [/\b(wind down|winding down|cool[- ]?down|afbouw|afbouwen|afbouwend|end calm|calm end|rustig eindigen)\b/, 'cooldown'],
  [/\b(two peaks|twee pieken|waves?)\b/, 'wave'],
  [/\b(rise and fall|up and down|rise then|peak then|piek en dan)\b/, 'peak'],
];
const FAMILY_WORDS = {
  electronic: ['electronic', 'electro', 'dance', 'edm', 'elektronisch'],
  disco: ['disco', 'funk', 'soul', 'boogie'],
  soft: ['pop', 'rock', 'urban', 'r&b', 'hip hop', 'hip-hop', 'hiphop'],
  ambient: ['chill', 'chillout', 'chill-out', 'ambient', 'lounge', 'downtempo'],
  hard: ['hardcore', 'hardstyle', 'gabber'],
};
const ALIASES = {
  fgth: 'Frankie Goes To Hollywood', mj: 'Michael Jackson', gnr: "Guns N' Roses", rhcp: 'Red Hot Chili Peppers', nkotb: 'New Kids on the Block',
  saw: 'Stock Aitken Waterman', 'acdc': 'AC/DC', 'ac/dc': 'AC/DC', ds: 'Dire Straits', pf: 'Pink Floyd', dm: 'Depeche Mode', sfx: 'Sophie Ellis-Bextor',
};
const RELEASE_WORDS = [
  [/\b(12["”]|12 ?inch|12-inch|twaalf inch|maxi|maxis|maxi-?single|extended|club mix|long version)\b/, '12inch'],
  [/\b(instrumental|instrumentals|instrumentaal|karaoke)\b/, 'instrumental'],
  [/\b(remix|remixes|remixed|rework)\b/, 'remix'],
  [/\b(live|in concert|unplugged|acoustic|akoestisch)\b/, 'live'],
  [/\b(single|singles|7["”]|7 ?inch|radio edit|radio edits)\b/, 'single'],
  [/\b(original|originals|album version|album versions|originele?)\b/, 'original'],
];
const EXCLUDE_WORDS = { remixes: 'remix', remix: 'remix', 'live versions': 'live', live: 'live', instrumentals: 'instrumental', instrumental: 'instrumental', edits: 'edit', 'radio edits': 'radio edit', covers: 'cover', karaoke: 'karaoke', dubs: 'dub', mixes: 'mix' };
const THEME_WORDS = ['love', 'liefde', 'summer', 'zomer', 'christmas', 'kerst', 'night', 'nacht', 'rain', 'regen', 'sun', 'zon', 'party', 'feest', 'dance', 'dansen', 'girl', 'boy', 'heart', 'moon', 'fire', 'water'];

function hasWord(text, word) {
  const w = word.toLowerCase();
  let from = 0;
  for (;;) {
    const i = text.indexOf(w, from);
    if (i < 0) return false;
    const before = i === 0 ? ' ' : text[i - 1];
    const after = i + w.length >= text.length ? ' ' : text[i + w.length];
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    from = i + 1;
  }
}

const SMALL_NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, een: 1, één: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6 };

function parseLength(text, b) {
  let m = text.match(/(\d+(?:[.,]\d+)?)\s*(?:hours?|hrs?|h|uur|u)\b/);
  const words = text.match(/\b(a|an|one|two|three|four|five|six|een|één|twee|drie|vier|vijf|zes)\s+(?:hours?|uur)\b/);
  if (m) b.minutes = Math.round(Number(m[1].replace(',', '.')) * 60);
  else if (words) b.minutes = SMALL_NUMBERS[words[1]] * 60;
  else if (/\b(half an hour|half uur|halfuur)\b/.test(text)) b.minutes = 30;
  m = text.match(/(\d+)\s*(?:min|mins|minutes|minuten)\b/);
  if (m) b.minutes = Number(m[1]);
  m = text.match(/(\d+)\s*(?:songs?|tracks?|nummers|liedjes|platen)\b/);
  if (m) { b.songs = Number(m[1]); b.minutes = null; }
}

function parseYears(text, b) {
  const years = [...text.matchAll(/\b((?:19|20)\d{2})\b/g)].map(m => Number(m[1]));
  if (years.length >= 2) { b.yearFrom = Math.min(...years); b.yearTo = Math.max(...years); return; }
  if (years.length === 1) { b.yearFrom = years[0]; b.yearTo = years[0]; return; }
  const dec = text.match(/\b(?:19|20)?(\d0)(?:'?s|s|er|ies)\b|\bjaren\s*'?(\d0)\b/);
  let start = null;
  if (dec) { const d = Number(dec[1] ?? dec[2]); start = d >= 30 ? 1900 + d : 2000 + d; }
  else for (const [w, y] of Object.entries(DECADE_WORDS)) if (text.replaceAll(/\s+/g, '').includes(w)) start = y;
  if (start == null) return;
  const early = /\b(early|vroege|begin)\b/.test(text), late = /\b(late|eind|einde)\b/.test(text);
  b.yearFrom = late ? start + 6 : start;
  b.yearTo = early ? start + 3 : start + 9;
}

function parseTempo(text, b) {
  let m = text.match(/(\d{2,3})\s*(?:-|–|to|tot)\s*(\d{2,3})\s*bpm/);
  if (m) { b.bpmFrom = Number(m[1]); b.bpmTo = Number(m[2]); return; }
  m = text.match(/(\d{2,3})\s*bpm/);
  if (m) { b.bpmFrom = Number(m[1]) - 4; b.bpmTo = Number(m[1]) + 4; return; }
  for (const [re, lo, hi] of TEMPO_WORDS) if (re.test(text)) { b.bpmFrom = lo; b.bpmTo = hi; return; }
}

// Longest names first, and a match is consumed, so "italo-disco" is not also
// "disco" and "Donna Summer" is not also "Summer".
function matchNames(text, names, max) {
  const out = [];
  let rest = text;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (name.length < 3 || out.length >= max) continue;
    if (!hasWord(rest, name)) continue;
    out.push(name);
    rest = rest.split(name.toLowerCase()).join(' ');
  }
  return out;
}

export function parseBriefLocally(text, profile, { aliases } = {}) {
  const original = String(text || '').trim();
  const b = {
    title: original.slice(0, 80), summary: '', songs: null, minutes: null, genres: [], excludeGenres: [], families: [],
    yearFrom: null, yearTo: null, bpmFrom: null, bpmTo: null, energy: 'steady', artists: [], artistMode: 'feature',
    excludeArtists: [], folders: [], keywords: [], albums: [], excludeAlbums: [], albumMode: 'songs',
    titles: [], minSeconds: null, maxSeconds: null, keys: [], release: 'any', prefer: 'none', ranking: 'none',
    order: 'dj', starred: false, played: 'any', rated: 'any', minPlays: null, maxPlays: null, addedWithinDays: null, playedWithinDays: null, notPlayedWithinDays: null,
    lossless: null, hiRes: false, playlists: [], collections: [], excludeKeywords: [], allVersions: false,
    favourites: false, discovery: false, minRating: null, chart: null, chartFrom: null, chartTo: null, cohesive: false, segments: [], clarification: null,
  };
  let lower = original.toLowerCase();
  const genreNames = (profile?.genres || []).map(g => g.genre);
  const artistNames = (profile?.artists || []).map(a => a.artist);
  const folderNames = (profile?.folders || []).map(f => f.folder);

  // "not played in the last year" is a history window, read before the "no …"
  // pass below takes the phrase away
  const playedWin = (() => {
    const m = lower.match(/\b(?:played|gedraaid|gespeeld)\b[^.]*?(?:in the last|within the last|this|the last|last|afgelopen|deze|laatste)\s*(\d+)?\s*(day|days|dag|dagen|week|weeks|weken|month|months|maand|maanden|year|years|jaar)\b/);
    if (!m) return null;
    const unit = { day: 1, days: 1, dag: 1, dagen: 1, week: 7, weeks: 7, weken: 7, month: 30, months: 30, maand: 30, maanden: 30, year: 365, years: 365, jaar: 365 };
    return (m[1] && /\d/.test(m[1]) ? Number(m[1]) : 1) * (unit[m[2]] || 1);
  })();
  const notPlayed = /\b(not played|haven'?t played|niet gedraaid|niet gespeeld|lang niet)\b/.test(lower);
  if (notPlayed) lower = lower.replace(/\b(not played|haven'?t played|niet gedraaid|niet gespeeld)\b/, 'unplayed-window');

  // "no Modern Talking", "zonder disco" — taken out before the positive matches
  for (const m of lower.matchAll(/\b(?:no|not|without|geen|zonder|except|behalve)\s+([^,.;]+)/g)) {
    const phrase = m[1];
    b.excludeGenres.push(...matchNames(phrase, genreNames, 5));
    b.excludeArtists.push(...matchNames(phrase, artistNames, 5));
    const version = phrase.trim().match(/^(remixes|remix|live versions|live|instrumentals|instrumental|edits|radio edits|covers|karaoke|dubs|mixes)\b/);
    if (version) b.excludeKeywords.push(EXCLUDE_WORDS[version[1]]);
    lower = lower.replace(m[0], ' ');
  }

  // "FGTH" → the full name, so the library lookup and the artist match both work
  // the owner's house notes win over the built-in shorthand
  const aliasList = [...(aliases ? [...aliases.entries()] : []), ...Object.entries(ALIASES)];
  for (const [alias, full] of aliasList) if (hasWord(lower, alias.toLowerCase())) lower = lower.split(alias.toLowerCase()).join(full.toLowerCase());

  // "+10 minutes", "longer than ten minutes", "korter dan 4 minuten": the length of a
  // song — read and removed first, so it is not taken for the length of the set
  let d = lower.match(/(?:\+|\bover\b|\bmore than\b|\blonger than\b|\bat least\b|\bminstens\b|\blanger dan\b|\bmeer dan\b)\s*(\d+)\s*(?:min|mins|minutes|minuten)\b/);
  if (d) { b.minSeconds = Number(d[1]) * 60; lower = lower.replace(d[0], ' '); }
  d = lower.match(/(?:\bunder\b|\bshorter than\b|\bless than\b|\bat most\b|\bkorter dan\b|\bhooguit\b|\bmax(?:imaal)?\b)\s*(\d+)\s*(?:min|mins|minutes|minuten)\b/);
  if (d) { b.maxSeconds = Number(d[1]) * 60; lower = lower.replace(d[0], ' '); }
  // "the top 10 of the House Top 1000": a chart in the library, by position —
  // its words are taken out so "house" and "1000" are not a genre or a count
  const chart = matchChart(lower, profile?.charts || []);
  if (chart) {
    const { from, to } = parseChartRange(lower);
    b.chart = chart.label; b.chartFrom = from; b.chartTo = to;
    lower = stripChartWords(lower, chart)
      .replaceAll(/\btop\s*\d{1,4}\b/g, ' ')
      .replaceAll(/(?:\b(?:number|nummer|no\.?|nr\.?|plaats|plek|positie|position|place)|#)\s*\d{1,4}\b/g, ' ')
      .replaceAll(/\b(?:positions?|posities?|plaatsen|plekken|nummers|numbers|places)\s*\d{1,4}\s*(?:-|–|to|tot|t\/m|through|until)\s*\d{1,4}\b/g, ' ');
    if (/\b(countdown|count down|aftellen|aftellend|van hoog naar laag|aflopend)\b/.test(lower)) b.order = 'countdown';
  }
  // "the grandmix 1983 and 1986": a series name followed by years is one title
  // per year, not an era — when the library holds titles of that name
  const seriesNames = new Set((profile?.series || []).map(s => s.name.toLowerCase()));
  for (const m of [...lower.matchAll(/\b(\p{L}[\p{L}\p{N}-]{2,})\s+((?:19|20)\d{2})((?:\s*(?:,|and|en|&|\+|\/)\s*(?:19|20)\d{2})*)\b/gu)]) {
    if (!seriesNames.has(m[1])) continue;
    const years = [m[2], ...(m[3].match(/(?:19|20)\d{2}/g) || [])];
    for (const y of years) b.titles.push(`${m[1]} ${y}`);
    lower = lower.replace(m[0], ' ');
  }
  if (/\b(most played|most-played|meest gedraaid|meest gespeeld|vaakst gedraaid|vaakst gespeeld|top \d+)\b/.test(lower)) b.ranking = 'mostPlayed';
  else if (/\b(least played|minst gedraaid|minst gespeeld)\b/.test(lower)) b.ranking = 'leastPlayed';
  else if (/\b(highest rated|best rated|top rated|hoogst gewaardeerd|best beoordeeld|5 stars|five stars|vijf sterren)\b/.test(lower)) b.ranking = 'topRated';
  else if (/\b(recently added|newest additions|latest additions|just added|last added|nieuw toegevoegde?|laatst toegevoegde?|recent toegevoegde?|nieuwste toevoegingen)\b/.test(lower)) b.ranking = 'recentlyAdded';
  else if (/\b(recently played|last played|played last|laatst gespeeld|laatst gedraaid|recent gespeeld)\b/.test(lower)) b.ranking = 'recentlyPlayed';
  const top = lower.match(/\btop\s*(\d+)\b/);
  if (top) b.songs = Number(top[1]);
  if (/\b(starred|with a star|met een ster|met ster|favorited)\b/.test(lower)) b.starred = true;
  if (/\b(never played|unplayed|nooit gedraaid|nooit gespeeld|never heard)\b/.test(lower)) b.played = 'never';
  else if (/\b(played before|already played|al gedraaid|al gespeeld|eerder gespeeld)\b/.test(lower)) b.played = 'played';
  if (/\b(unrated|not rated|zonder beoordeling|niet beoordeeld|zonder sterren)\b/.test(lower)) b.rated = 'unrated';
  else if (/\b(rated|beoordeeld|met sterren)\b/.test(lower)) b.rated = 'rated';
  // "played more than 5 times" and the Dutch order "meer dan 5 keer gedraaid"
  let pm = lower.match(/\b(?:played|gedraaid|gespeeld)\s+(?:more than|over|at least|vaker dan|meer dan|minstens)\s+(\d+)\s*(?:times|x|keer)/)
    || lower.match(/\b(?:more than|over|at least|vaker dan|meer dan|minstens)\s+(\d+)\s*(?:times|x|keer)\s+(?:played|gedraaid|gespeeld)/);
  if (pm) b.minPlays = Number(pm[1]) + (/more than|over|vaker dan|meer dan/.test(pm[0]) ? 1 : 0);
  pm = lower.match(/\b(?:played|gedraaid|gespeeld)\s+(?:less than|fewer than|at most|under|minder dan|hooguit)\s+(\d+)\s*(?:times|x|keer)/)
    || lower.match(/\b(?:less than|fewer than|at most|under|minder dan|hooguit)\s+(\d+)\s*(?:times|x|keer)\s+(?:played|gedraaid|gespeeld)/);
  if (pm) b.maxPlays = Math.max(0, Number(pm[1]) - (/less than|fewer than|under|minder dan/.test(pm[0]) ? 1 : 0));
  const days = { day: 1, days: 1, dag: 1, dagen: 1, week: 7, weeks: 7, weken: 7, month: 30, months: 30, maand: 30, maanden: 30, year: 365, years: 365, jaar: 365 };
  const win = (re) => {
    const m = lower.match(re);
    if (!m) return null;
    const n = m[1] && /\d/.test(m[1]) ? Number(m[1]) : 1;
    return n * (days[m[2]] || 1);
  };
  const added = win(/\b(?:added|toegevoegd)\b[^.]*?(?:in the last|within the last|this|the last|last|afgelopen|deze|laatste)\s*(\d+)?\s*(day|days|dag|dagen|week|weeks|weken|month|months|maand|maanden|year|years|jaar)\b/);
  if (added) b.addedWithinDays = added;
  if (playedWin && notPlayed) b.notPlayedWithinDays = playedWin;
  else if (playedWin) b.playedWithinDays = playedWin;
  if (/\b(lossless|flac|wav|hi-?fi only)\b/.test(lower)) b.lossless = true;
  else if (/\b(mp3 only|lossy)\b/.test(lower)) b.lossless = false;
  if (/\b(hi-?res|high-?res|24 ?bit|24-bit)\b/.test(lower)) b.hiRes = true;
  if (/\b(all versions|every version|all mixes|every mix|all the versions|alle versies|elke versie|alle mixen)\b/.test(lower)) b.allVersions = true;
  // "songs which match tempo, key, genre": the songs must match each other
  if (/\b(match(?:es|ing)?|harmonic|mixable|mix together|blend|in key|same key|same tempo|zelfde tempo|zelfde toonsoort|bij elkaar passen|op elkaar aansluiten|aansluitend)\b/.test(lower)) b.cohesive = true;
  if (/\b(chronological|chronologisch|oldest first|oudste eerst|by year|op jaar)\b/.test(lower)) b.order = 'chronological';
  else if (/\b(newest first|nieuwste eerst)\b/.test(lower)) b.order = 'newestFirst';
  else if (/\b(alphabetical|alfabetisch|a to z|a-z)\b/.test(lower)) b.order = 'alphabetical';
  else if (/\b(shuffled?|random|husselen|willekeurig)\b/.test(lower)) b.order = 'random';
  for (const m of lower.matchAll(/\b(?:playlist|list|lijst|afspeellijst)\s+["“']?([^"”',.;]{2,60})/g)) b.playlists.push(m[1].trim());
  if (/\b(longest|the longest|langste)\b/.test(lower)) b.prefer = 'longest';
  else if (/\b(shortest|kortste)\b/.test(lower)) b.prefer = 'shortest';
  else if (/\b(newest|latest|nieuwste|laatste)\b/.test(lower)) b.prefer = 'newest';
  else if (/\b(oldest|earliest|oudste|eerste)\b/.test(lower)) b.prefer = 'oldest';

  parseLength(lower, b);
  if (b.songs == null && b.minutes == null && /\b(a|an|one|een|één|1)\s+(song|track|number|nummer|liedje|plaatje|12["”]|12 ?inch|12-inch|maxi|single|remix|version|versie|instrumental)\b/.test(lower)) b.songs = 1;
  if (b.songs == null && b.minutes == null && b.ranking !== 'none' && /\b(the|het|de)\s+(most|least|highest|best|top|meest|minst|hoogst|best)\b[^,]*\b(song|track|number|nummer|liedje|plaatje)\b/.test(lower)) b.songs = 1;
  if (b.songs == null && b.minutes == null && /\b(a few|some|een paar|enkele)\s+(songs|tracks|nummers|liedjes)\b/.test(lower)) b.songs = 5;
  if (b.songs == null && b.minutes == null && b.titles.length === 0 && /\bplay\s+[^,]{2,60}\bby\b/.test(lower) && b.prefer !== 'none') b.songs = 1;
  parseYears(lower, b);
  parseTempo(lower, b);
  const key = lower.match(/\bin\s+([a-g][#b]?)\s*(minor|major|min|maj|mineur|majeur|klein|groot)\b/) || lower.match(/\b(\d{1,2}[ab])\b(?=.*\b(?:key|camelot|toonsoort)\b)/);
  if (key) b.keys = [key[2] ? `${key[1].toUpperCase()} ${/^(minor|min|mineur|klein)$/.test(key[2]) ? 'minor' : 'major'}` : key[1].toUpperCase()];
  for (const [re, rel] of RELEASE_WORDS) if (re.test(lower)) { b.release = rel; break; }
  for (const q of lower.matchAll(/["“”']([^"“”']{2,80})["“”']/g)) b.titles.push(q[1].trim());
  for (const [re, e] of ENERGY_WORDS) if (re.test(lower)) { b.energy = e; break; }
  if (/\b(favou?rites?|favorieten?|songs i love|love most|most played|meest gedraaid|best rated|hoogst gewaardeerd)\b/.test(lower)) b.favourites = true;
  if (/\b(never played|unplayed|nooit gedraaid|nooit gespeeld|discover|ontdek|new to me|rarely played|zelden)\b/.test(lower)) b.discovery = true;
  const stars = lower.match(/(\d)\s*(?:stars?|sterren)\b/);
  if (stars) b.minRating = Math.min(10, Number(stars[1]) * 2);

  b.genres = matchNames(lower, genreNames, 10);
  const genreKeys = new Set(b.genres.map(toKey));
  for (const [fam, words] of Object.entries(FAMILY_WORDS)) {
    if (words.some(w => hasWord(lower, w) && !genreKeys.has(toKey(w)))) b.families.push(fam);
  }
  if (/\b(an?|one|een|één|1)\s+(album|record|lp|plaat)\b/.test(lower) || /\b(whole|complete|entire|hele|volledige?)\s+(album|record|lp|plaat)\b/.test(lower)) b.albumMode = 'oneAlbum';
  else if (/\b(albums|records|lps|platen)\b/.test(lower) && /\b(whole|complete|entire|full|in order|hele|volledige|compleet)\b/.test(lower)) b.albumMode = 'wholeAlbums';
  b.artists = matchNames(lower, artistNames, 10);
  if (b.artists.length && /\b(only|alleen|just|uitsluitend)\b/.test(lower)) b.artistMode = 'only';
  b.folders = matchNames(lower, folderNames, 5);
  b.collections = matchNames(lower, (profile?.collections || []).filter(c => !b.folders.includes(c)), 5);
  b.keywords = THEME_WORDS.filter(w => hasWord(lower, w) && !genreKeys.has(toKey(w)) && !b.families.some(f => FAMILY_WORDS[f].includes(w)));
  return b;
}
