/**
 * ai-queue.js — AI DJ for listeners. Hidden until aiAssist.enabled AND
 * aiAssist.queueBuilder are set; every endpoint answers 404 before that.
 *
 * The listener describes a set in their own words. Claude turns the text into
 * a brief in library terms (genres, artists, years, tempo, flow); Velvet then
 * picks and orders the songs itself (util/ai-queue.js). The model never sees
 * file names, users or play history, and never chooses a song.
 *
 *   GET  /api/v1/ai/status             { enabled, maxSongs }
 *   POST /api/v1/ai/queue/brief        body: { text, ignoreVPaths?, filepathPrefix?, excludeFilepathPrefixes? }
 *   POST /api/v1/ai/queue/build        body: { brief, ignoreVPaths?, filepathPrefix?, excludeFilepathPrefixes? }
 */
import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import Scribble from '../state/lastfm.js';
import { joiValidate } from '../util/validation.js';
import { mergeGenreRows, toKey } from '../util/genre-merge.js';
import { FAMILIES, keywordFamily } from '../util/genre-family.js';
import { genreFamilyResolver } from '../util/genre-family-cache.js';
import * as ai from '../util/ai-assist.js';
import { BRIEF_SCHEMA, DEFAULT_SONGS, MAX_LIST, RELEASE_PATTERNS, artistKey, planQueue, queueStats, validateBrief, versionKey } from '../util/ai-queue.js';
import { computeChildInclusions, renderMetadataObj, userDbVpaths } from './db.js';
import { parseBriefLocally } from '../util/ai-brief-parser.js';
import { chartPosition, detectCharts, findChart } from '../util/ai-charts.js';
import { noteAliases, noteLine, notesText } from '../util/ai-library-notes.js';

// The library notes as the DJ reads them, refreshed when the admin or the
// analysis changes them.
let _notes = null;
function libraryNotes() {
  if (!_notes) {
    const all = db.getLibraryNotes();
    const byKey = new Map(all.map(x => [x.key, x]));
    _notes = { all, byKey, ...notesText(all), aliases: noteAliases(all) };
  }
  return _notes;
}
export function invalidateLibraryNotes() { _notes = null; }

const PROFILE_TTL_MS = 10 * 60 * 1000;
const BRIEF_TTL_MS = 15 * 60 * 1000;
const BRIEF_MIN_GAP_MS = 3000;
const BRIEF_PER_DAY = 200;
const BUILD_MIN_GAP_MS = 1000;
const SIMILAR_TIMEOUT_MS = 6000;
const MAX_SEEDS = 5;
const UNTAGGED_POOL = 3000;

const scopeJoi = {
  ignoreVPaths: Joi.array().items(Joi.string().max(200)).max(100).optional(),
  filepathPrefix: Joi.string().max(500).optional(),
  excludeFilepathPrefixes: Joi.array().items(Joi.object({ vpath: Joi.string().max(200).required(), prefix: Joi.string().max(500).required() })).max(100).optional(),
};

const SYSTEM = `You are the resident DJ of one personal music library. The listener tells you what they want to hear; you answer with a brief that the music server turns into a queue. You never pick songs yourself.
Rules:
- genres: only names from the genre list below, spelled exactly as listed. Leave empty when the request is not about a genre.
- families: a broad style when the request does not map to listed genres: electronic (house, techno, trance, dance), disco (disco, funk, soul, boogie, italo), soft (pop, rock, R&B, hip-hop, jazz, blues, folk), ambient (chill-out, downtempo, lounge), hard (hardcore, hardstyle), other.
- folders: only names from the folder or sub-folder lists, spelled exactly as listed (sub-folders as "Folder/Sub"), and only when the listener clearly means that collection, series or label.
- artists: the artists the listener asks for, spelled as in the artist list when they appear there, otherwise as the listener wrote them. An artist is a name — never a year, a number or a word of the request that merely happens to be tagged as an artist somewhere. artistMode "only" when the listener wants nothing but those artists, "feature" when they should be featured among similar music.
- excludeGenres / excludeArtists: what the listener does not want. Never list the same name under artists or genres as well.
- yearFrom / yearTo: eras as years (80s = 1980–1989, "late 90s" = 1996–1999, "classics" = up to 1995). Null when no era is meant.
- bpmFrom / bpmTo: tempo words as BPM (chill 80–110, groove 110–122, club 122–130, peak-time 128–140, hard 150+). Null when tempo is not meant.
- energy: steady (no arc), build (warm-up rising to a peak), peak (rise, then come down), wave (two rises), cooldown (slowly down).
- albumMode: "oneAlbum" when the listener wants one album / a record / an LP of someone (then the artist goes in artists and the era in yearFrom/yearTo; Velvet picks the album and plays only its tracks, in order). "wholeAlbums" when they name albums or want complete albums in track order. "songs" otherwise — a mixed set.
- albums: album titles the listener names, as written, and the album's artist in artists. When the library hits show no such album, give the title the library would use: the other name an album is known by ("Cerrone 9" is "Cerrone IX – Your Love Survived", "the White Album" is "The Beatles", "Thriller" stays) — and if nothing of it is in the hits, say so in clarification rather than naming a different album. excludeAlbums: albums they do not want.
- songs / minutes: only what the listener asked for ("2 hours" → minutes 120, "50 songs" → songs 50); both null otherwise.
- favourites: the listener wants songs they love or play a lot. discovery: songs they rarely or never played.
- keywords: lowercase words looked for in song titles, file names and folder names: a theme (love, summer, christmas, night) or a kind of version (extended, 12 inch, remix, instrumental, live, acoustic, dub). Not genres, not artists.
- The genre list shows the average BPM of each genre where known: use it to turn a tempo wish into genres and a BPM range that this library can actually fill.
- minRating: 0–10 only when the listener asks for rated songs (4 stars = 8).
- title: a short name for the set. summary: one sentence saying what you will play. Both in the listener's own language.
- titles: song titles the listener names ("play Relax", "the one called Two Tribes", "X by Y" → title X, artist Y), as written, without the artist. A title is a title even when it is also an ordinary word (Relax, Freedom, Jump, Fame): "play Relax by FGTH" is the song Relax, not a mood. A named song with no count means songs 1; several named songs mean one each (songs = their number); with allVersions it means every version of it. A kind of version or a service name is never a title: "a DMC remix of Level 42" is artists ["Level 42"], keywords ["dmc"], release "remix"; "a Disconet version of Donna Summer" is keywords ["disconet"] with the artist.
- Names with a number are titles, not eras or counts: a yearly mix or edition ("Grandmix 1983", "Jaarmix 1991", the Series list below), an album ("Cerrone 9"), a numbered volume. "The Grandmix 1983 and 1986" → titles ["Grandmix 1983", "Grandmix 1986"], songs 2, yearFrom/yearTo null, no folder.
- The request comes with "What the library holds for the words of this request": what each phrase of the request actually is in this library. Trust it over your own guess: a phrase found in titles is a titles entry; one found as an artist goes in artists; one found only as a folder in folders. Spell the entry as the library spells it.
- minSeconds / maxSeconds: wishes about a song's length ("+10 minutes", "longer than ten minutes" → minSeconds 600; "short songs" → maxSeconds 240). Not the length of the whole set.
- keys: musical keys the listener asks for ("in A minor", "8A"), as written. Null otherwise.
- release: what kind of version — "12inch" (12-inch, maxi, extended, club versions), "extended", "single" (7-inch, radio edits), "instrumental", "remix", "live", "original" (album versions) — or "any".
- "a song", "one song", "a track", "a 12-inch", "a remix", "the version of …" all mean songs 1; "a few", "a couple", "some", "een paar", "enkele" mean 5.
- prefer: "longest" / "shortest" (the longest version you have), "newest" / "oldest" — else "none".
- starred: only songs the listener starred. played: "never" (never played) / "played" (played before) / "any". rated: "rated" / "unrated" / "any". minPlays / maxPlays: play-count bounds ("played more than 5 times" → minPlays 6).
- addedWithinDays / playedWithinDays / notPlayedWithinDays: "added this month" → addedWithinDays 30; "played last week" → playedWithinDays 7; "not played in a year" → notPlayedWithinDays 365.
- lossless: true for "lossless / flac / wav only", false for "mp3 only", null otherwise. hiRes: true for "hi-res / 24-bit".
- playlists: names of the listener's own playlists from the playlist list below, when they ask to play from one ("my playlist Sunday", "the Best Remixes list"). collections: names from the collection list when they restrict to one ("only from the 12 inches").
- excludeKeywords: words that must not appear in a title or file name ("no remixes" → ["remix"]; "no live versions" → ["live"]).
- allVersions: true only when the listener wants every version of a song ("all versions of Relax", "every mix of Two Tribes"); otherwise one version per song is played.
- cohesive: true when the songs must match each other — "songs that match in tempo, key and genre", "a harmonic mix", "tracks that mix together", "nummers die bij elkaar passen", "same key and tempo". Velvet then picks one song as the seed and keeps the others within a few BPM of it, in a compatible key and of the same genre. Such a request never becomes bpmFrom/bpmTo or keys; those are only for a tempo or key the listener names.
- order: how the set is laid out — "dj" (tempo flow, the default), "chronological" (oldest first), "newestFirst", "alphabetical", "random" (plain shuffle).
- ranking: a request about the listener's own statistics, answered from them exactly: "the most played song(s)" → mostPlayed; "least played" → leastPlayed; "highest rated" / "my 5-star songs" → topRated; "recently added" / "newest additions" → recentlyAdded; "what I played last" / "recently played" → recentlyPlayed. Else "none". "The most played song" means ranking mostPlayed and songs 1; "my top 20 disco" means mostPlayed, songs 20, genres Disco. Use favourites only for a taste ("songs I love"), ranking for a list.
- chart: the library holds numbered charts — the chart list below: folders whose file names start with the position. "The top 10 of the House Top 1000", "number 1 of 1983", "positions 50 to 60 of the Disco Top 700", "the Top 40 of 1988" → chart = that chart's name exactly as listed, chartFrom / chartTo = the positions asked (top 10 → 1 and 10; number 1 → 1 and 1; the whole chart → both null), songs null, genres and years empty (the chart is the content), ranking "none". Velvet plays those positions in chart order, number 1 first; order "countdown" only when the listener literally asks for a countdown (from the last position down to number 1). Only a chart from the list is a chart: "my top 10" or "the 10 most played" is a ranking of the listener's own statistics, and "10 songs from the House Top 1000" is folders with songs 10, not a chart.
You know music history. Use it: expand abbreviations and nicknames to the full artist name as it appears in the artist list, or as commonly written (FGTH → Frankie Goes To Hollywood, MJ → Michael Jackson, GNR → Guns N' Roses, RHCP → Red Hot Chili Peppers, NKOTB → New Kids on the Block, SAW → Stock Aitken Waterman; but OMD, ABBA, ELO are names). Turn scenes, labels and producers into what this library has: "Chicago house" → genre House plus years 1985–1992; "the SAW years" → 1986–1990; "Motown" → the Motown folder or genre when listed, else families disco/soft with years 1960–1975; "Ben Liebrand remixes" → keywords ["liebrand"]; "Italo" → Italo-Disco when listed. A producer or remixer named ("the Liebrand mixes", "Bob Sinclar's Cerrone", "Frankie Knuckles remixes") becomes keywords with that surname plus release "remix". A single year ("from 1984") is yearFrom and yearTo 1984; "around 1985" is 1984–1986; "classics" is up to 1995; "oldies" before 1975; "new" or "recent" the last two years; "the 12-inch years" 1982–1991. Tempo knowledge when no genre is named: italo 110–128, hi-NRG 125–140, disco 100–130, house 118–130, trance 130–145. Spell every genre, folder and artist exactly as the library lists them.
- segments: a set in phases, when the listener describes a sequence — "start calm around 100 BPM for 15 minutes, then dance and disco from 100 to 120, then 30 minutes of club house with a higher BPM, then 30 minutes of dance, then trance". One entry per phase, in the listener's order, two phases at least: name (a few words in the listener's language), minutes or songs when they say how long the phase lasts (both null otherwise), genres from the genre list and/or families for that phase only, bpmFrom / bpmTo for that phase (from the words, or from the genre's average BPM in the genre list: "with a higher BPM" means above the phase before, trance sits around 135–140), energy: build when the phase rises ("from 100 to 120"), steady when it stays, cooldown when it falls. Every phase is picked from this library on its own and mixed into the next, so each phase must name what to play — a phase without genres, families or tempo is the whole library. The top-level genres, families, bpmFrom / bpmTo, energy, songs and minutes then stay empty: the phases decide; era, artists, exclusions and the listener's marks still apply to every phase. One mood, one tempo, one genre is never a set in phases — then segments is empty.
- clarification: only when the request is not about music, or cannot be met from this library at all; then explain in the listener's language and leave the rest empty. Otherwise null.`;

let _lastfm = null;
function lastfm() {
  const key = config.program.lastFM?.apiKey;
  if (!key) return null;
  if (!_lastfm || _lastfm._key !== key) {
    _lastfm = new Scribble();
    _lastfm.setKeys(key, config.program.lastFM?.apiSecret || '');
    _lastfm._key = key;
  }
  return _lastfm;
}

function similarArtists(name) {
  const client = lastfm();
  if (!client) return Promise.resolve([]);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve([]), SIMILAR_TIMEOUT_MS);
    client.GetSimilarArtists(name, data => {
      clearTimeout(timer);
      resolve((data?.similarartists?.artist || []).map(a => a.name).filter(Boolean).slice(0, 50));
    }, 50);
  });
}

function scopeOf(user, body) {
  const inclusions = computeChildInclusions(user);
  return {
    user: user.username,
    collections: user.vpaths || [],
    vpaths: userDbVpaths(user),
    opts: {
      ignoreVPaths: body.ignoreVPaths,
      filepathPrefix: body.filepathPrefix || null,
      excludeFilepathPrefixes: body.excludeFilepathPrefixes,
      includeFilepathPrefixes: inclusions.length ? inclusions : undefined,
    },
    // the listener narrowed the selection (collections off, a folder chosen):
    // what they may hear at all, to explain a miss honestly
    narrowed: !!(body.ignoreVPaths?.length || body.filepathPrefix || body.excludeFilepathPrefixes?.length),
    fullOpts: { includeFilepathPrefixes: inclusions.length ? inclusions : undefined },
  };
}

function scopeKey(scope) {
  return JSON.stringify([scope.vpaths, scope.opts.ignoreVPaths || [], scope.opts.filepathPrefix, scope.opts.excludeFilepathPrefixes || [], scope.opts.includeFilepathPrefixes || []]);
}

const _profiles = new Map();
function libraryProfile(scope) {
  const key = `${scope.user || ''}|${scopeKey(scope)}`;
  const hit = _profiles.get(key);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profile;
  const raw = db.getLibraryProfile(scope.vpaths, scope.opts);
  const merged = mergeGenreRows(db.getGenres(scope.vpaths, scope.opts.ignoreVPaths, { filepathPrefix: scope.opts.filepathPrefix, includeFilepathPrefixes: scope.opts.includeFilepathPrefixes }));
  // average tempo per merged genre name, weighted over the raw tags folded into it
  const tempo = new Map();
  if (raw) {
    const byRaw = new Map(raw.genreBpm.map(r => [r.genre, r]));
    for (const [display, raws] of merged.rawMap) {
      let sum = 0, cnt = 0;
      for (const r of raws) { const b = byRaw.get(r); if (b) { sum += b.bpmAvg * b.bpmN; cnt += b.bpmN; } }
      if (cnt >= 5) tempo.set(display, Math.round(sum / cnt));
    }
  }
  const playlists = scope.user ? [
    ...db.getUserPlaylists(scope.user).map(pl => ({ name: pl.name, n: pl.songCount ?? 0, kind: 'playlist' })),
    ...db.getSmartPlaylists(scope.user).map(sp => ({ name: sp.name, n: sp.limit_n, kind: 'smart' })),
  ] : [];
  const charts = raw ? detectCharts(db.getFilePaths(scope.vpaths, scope.opts)) : [];
  const series = raw ? titleSeries(db.getTitleYears(scope.vpaths, scope.opts)) : [];
  const profile = raw ? { ...raw, genres: merged.genres, rawMap: merged.rawMap, tempo, collections: scope.collections || [], playlists, charts, series } : null;
  _profiles.set(key, { profile, at: Date.now() });
  if (_profiles.size > 50) _profiles.delete(_profiles.keys().next().value);
  return profile;
}
export function invalidateLibraryProfiles() { _profiles.clear(); }

// "Grandmix 1983", "Grandmix 1984", … : a name that recurs with different
// years is a series of editions, and "name + year" is a title — not an era.
function titleSeries(rows, { minYears = 3, minFiles = 5, max = 40 } = {}) {
  const groups = new Map();
  for (const r of rows) {
    const m = String(r.title || '').match(/^(.{2,40}?)[\s:-]*((?:19|20)\d{2})(?!\d)/);
    if (!m) continue;
    const name = m[1].replace(/^(?:ben liebrand|dj [\w.]+)\s*-\s*/i, '').trim();
    if (name.length < 3 || /\d{4}/.test(name)) continue;
    const key = name.toLowerCase();
    let g = groups.get(key);
    if (!g) { g = { names: new Map(), years: new Set(), n: 0 }; groups.set(key, g); }
    g.names.set(name, (g.names.get(name) || 0) + r.cnt);
    g.years.add(Number(m[2]));
    g.n += r.cnt;
  }
  return [...groups.values()]
    .filter(g => g.years.size >= minYears && g.n >= minFiles)
    .map(g => ({ name: [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0], from: Math.min(...g.years), to: Math.max(...g.years), editions: g.years.size, n: g.n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, max);
}

const REQUEST_STOP = new Set(['give', 'me', 'the', 'a', 'an', 'play', 'some', 'and', 'or', 'of', 'from', 'with', 'for', 'to', 'in', 'on', 'at', 'by', 'my', 'all', 'only', 'please', 'songs', 'song', 'tracks', 'track', 'set', 'hours', 'hour', 'minutes', 'that', 'this', 'then', 'into', 'about',
  'geef', 'speel', 'draai', 'de', 'het', 'een', 'en', 'of', 'van', 'met', 'voor', 'uit', 'op', 'in', 'mijn', 'alle', 'alleen', 'nummers', 'nummer', 'liedjes', 'uur', 'minuten', 'wat', 'iets', 'graag', 'nu', 'dan', 'die', 'dat', 'deze', 'zonder', 'geen', 'niet', 'no', 'not', 'without']);

// What the library holds for the words of the request, looked up before the
// model writes: "grandmix 1983" is a title here, "cerrone" an artist, "disconet"
// a folder. The model then names what exists instead of guessing a meaning.
function requestHits(text, scope) {
  const words = String(text).toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  const phrases = [];
  const add = p => { if (p && !phrases.includes(p)) phrases.push(p); };
  for (let i = 0; i < words.length; i++) {
    if (i + 2 < words.length && !REQUEST_STOP.has(words[i]) && !REQUEST_STOP.has(words[i + 2])) add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    if (i + 1 < words.length && !REQUEST_STOP.has(words[i]) && !REQUEST_STOP.has(words[i + 1])) add(`${words[i]} ${words[i + 1]}`);
    // "grandmix 1983 and 1986", "de jaarmix van 1991": the name with every year that follows it
    if (!REQUEST_STOP.has(words[i]) && !/^\d+$/.test(words[i])) {
      for (let j = i + 1; j < words.length && j < i + 8; j++) {
        if (/^(?:19|20)\d{2}$/.test(words[j])) add(`${words[i]} ${words[j]}`);
      }
    }
  }
  for (const w of words) {
    if (w.length >= 4 && !REQUEST_STOP.has(w) && !/^\d+$/.test(w)) add(w);
  }
  const lines = [];
  const notes = libraryNotes();
  const extra = new Map();
  let queries = 0;
  for (const p of phrases) {
    if (queries >= 12) break;
    queries++;
    const { total, rows } = db.getPhraseHits(scope.vpaths, scope.opts, p, 200);
    if (!total) continue;
    const count = (f, n) => {
      const m = new Map();
      for (const r of rows) {
        const v = f(r);
        if (v) m.set(v, (m.get(v) || 0) + 1);
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([v]) => v);
    };
    const inTitle = rows.filter(r => String(r.title || '').toLowerCase().includes(p)).length;
    // a bare year as an artist tag is a tagging accident, not an artist
    const artistOf = r => (/^\d+$/.test(String(r.artist || '').trim()) ? '' : String(r.artist || '').toLowerCase());
    const asArtist = rows.filter(r => artistOf(r).includes(p)).length;
    const parts = [];
    if (inTitle) parts.push(`in ${inTitle} titles: ${count(r => String(r.title || '').toLowerCase().includes(p) ? r.title : null, 3).join(' · ')}`);
    if (asArtist) parts.push(`artist: ${count(r => artistOf(r).includes(p) ? r.artist : null, 2).join(' · ')}`);
    const folders = count(r => { const seg = r.filepath.split('/'); return seg.length > 1 ? `${r.vpath}/${seg[0]}` : null; }, 2);
    if (folders.length) parts.push(`folders: ${folders.join(' · ')}`);
    lines.push(`"${p}": ${total.toLocaleString('en-US')} songs — ${parts.join('; ')}`);
    // the notes of the folders these songs sit in, when the system text had no room for them
    for (const k of count(r => { const seg = r.filepath.split('/'); return seg.length > 2 ? `${r.vpath}/${seg.slice(0, Math.min(3, seg.length - 1)).join('/')}` : null; }, 3)) {
      const x = notes.byKey.get(k) || notes.byKey.get(k.split('/').slice(0, 3).join('/'));
      if (x && !notes.included.has(x.key) && !extra.has(x.key)) extra.set(x.key, noteLine(x));
    }
  }
  if (extra.size) lines.push(`Notes on the folders found:\n${[...extra.values()].join('\n')}`);
  return lines.length ? `\n\nWhat the library holds for the words of this request (looked up for you):\n${lines.join('\n')}` : '';
}

function profileText(p) {
  const n = v => Number(v || 0).toLocaleString('en-US');
  const lines = [
    `Library: ${n(p.total)} songs. ${n(p.withGenre)} have a genre tag, ${n(p.withYear)} a year, ${n(p.withBpm)} a BPM, ${n(p.withKey)} a musical key. Average song ${p.avgDuration ? Math.round(p.avgDuration / 60) : 4} min.`,
    `Decades (songs): ${p.decades.map(d => `${d.decade}s ${n(d.cnt)}`).join(', ') || 'unknown'}`,
    `BPM (songs): ${p.bpmBuckets.map(b => `${b.bucket}-${b.bucket + 9} ${n(b.cnt)}`).join(', ') || 'none analysed'}`,
    `Genres (songs, average BPM when analysed): ${[...p.genres].sort((a, b) => b.cnt - a.cnt).slice(0, 100).map(g => { const t = p.tempo.get(g.genre); return `${g.genre} ${n(g.cnt)}${t ? ` ~${t}bpm` : ''}`; }).join('; ')}`,
    `Artists (songs): ${p.artists.slice(0, 250).map(a => `${a.artist} ${a.cnt}`).join('; ')}`,
    `Folders (songs): ${p.folders.slice(0, 50).map(f => `${f.vpath}/${f.folder} ${n(f.cnt)}`).join('; ')}`,
    `Sub-folders (songs): ${p.folders2.slice(0, 100).map(f => `${f.vpath}/${f.folder} ${n(f.cnt)}`).join('; ')}`,
    `Charts — numbered lists, the position is in the file name (positions, songs): ${(p.charts || []).map(c => `${c.label} ${c.from}–${c.to} (${n(c.n)})`).join('; ') || 'none'}`,
    `Series — editions by year, "name year" is a song title here, never an era (years, editions, songs): ${(p.series || []).map(s => `${s.name} ${s.from}–${s.to} (${s.editions} editions, ${n(s.n)})`).join('; ') || 'none'}`,
    `Collections the listener can choose: ${(p.collections || []).join('; ') || '—'}`,
    `The listener's playlists (songs): ${(p.playlists || []).map(x => `${x.name} ${x.n}`).join('; ') || 'none'}`,
  ];
  return lines.join('\n');
}

function houseNotes() {
  const { text } = ai.parseDjNotes(ai.settings().djNotes);
  return text ? `\n\nHouse notes from the library owner — follow them, they know this collection:\n${text}` : '';
}
function systemPrompt(profile) {
  const notes = libraryNotes().text;
  return `${SYSTEM}${houseNotes()}\n\nThe library:\n${profileText(profile)}${notes ? `\n\n${notes}` : ''}`;
}

// For the admin page: the system prompt and the library text as the model reads them.
export function aiDjContext(user) {
  const scope = scopeOf(user, {});
  const profile = libraryProfile(scope);
  const library = profile ? profileText(profile) : '';
  const notes = libraryNotes();
  return { system: `${SYSTEM}${houseNotes()}`, library, notes: notes.text, notesIncluded: notes.included.size, notesTotal: notes.all.length, chars: SYSTEM.length + houseNotes().length + library.length + notes.text.length };
}

const _briefs = new Map();
const _lastCall = new Map();
const _dayCount = new Map();

function throttle(user, kind, gapMs) {
  const k = `${kind}:${user}`;
  const now = Date.now();
  if (now - (_lastCall.get(k) || 0) < gapMs) return false;
  _lastCall.set(k, now);
  return true;
}

function underDailyCap(user) {
  const k = `${user}:${new Date().toISOString().slice(0, 10)}`;
  const n = (_dayCount.get(k) || 0) + 1;
  if (n > BRIEF_PER_DAY) return false;
  _dayCount.set(k, n);
  if (_dayCount.size > 1000) _dayCount.delete(_dayCount.keys().next().value);
  return true;
}

// "play <title> by <artist>" is unambiguous enough to be enforced whatever the
// model made of it: a title that is also a word (Relax, Jump) must stay a title.
function enforceTitleByArtist(text, brief, scope) {
  const m = String(text).match(/\b(?:play|speel|draai)\s+(?:all (?:the )?versions of\s+|every (?:version|mix) of\s+|alle versies van\s+|me\s+)?["“]?([^"”,]{1,60}?)["”]?\s+(?:by|van|from|of)\s+([^,.;]{2,60}?)(?:\s*[,.;]|\s+(?:the longest|the newest|the oldest|longest|please|in|from|with)\b|$)/i);
  if (!m) return brief;
  const title = m[1].trim().replace(/^(a|an|the|een|het|de)\s+/i, '');
  const who = m[2].trim();
  if (!title || /^(song|track|album|number|nummer|something|anything|some|12-inch|12 inch|remix|version)s?$/i.test(title)) return brief;
  // "de jaarmix van 1991": a year is not an artist; "een DMC remix van Level 42": a kind of version is not a title
  if (/^\d{2,4}$/.test(who) || /^(?:19|20)\d{2}\b/.test(who)) return brief;
  if (/\b(remix|remixes|mix|mixes|version|versie|edit|edits|medley|megamix|instrumental|12-inch|12 inch|maxi|single|dub|rework|bootleg)$/i.test(title)) return brief;
  const variants = resolveArtist(who, scope.vpaths);
  if (!variants.length) return brief;
  const out = { ...brief };
  if (!out.artists.length) { out.artists = [who]; out.artistMode = 'only'; }
  if (!out.titles.length && !out.albums.length && out.albumMode === 'songs') out.titles = [title];
  if (out.titles.length && out.songs == null && out.minutes == null && !out.allVersions) out.songs = 1;
  return out;
}

// Claude writes the brief; when it cannot (no key, budget spent, network,
// refusal, unusable answer) the rule-based reader takes over, so a listener
// always gets a set. The source is reported so the player can say so.
async function writeBrief(user, text, scope) {
  const cacheKey = `${user}|${scopeKey(scope)}|${text.toLowerCase().replaceAll(/\s+/g, ' ')}`;
  const hit = _briefs.get(cacheKey);
  if (hit && Date.now() - hit.at < BRIEF_TTL_MS) return { ...hit, cached: true };
  const profile = libraryProfile(scope);
  if (!profile || !profile.total) throw new ai.AiAssistError('No songs in scope', 'empty');
  let brief, source = ai.providerLabel();
  try {
    const raw = await ai.askJson({
      task: 'queue-brief',
      // The library summary is the bulk of the prompt and identical for every
      // listener for ten minutes; cached, repeat reads cost a tenth.
      system: [{ type: 'text', text: systemPrompt(profile), cache_control: { type: 'ephemeral' } }],
      prompt: text + requestHits(text, scope),
      schema: BRIEF_SCHEMA,
      maxTokens: 2000,
      timeoutMs: 45_000,
      maxRetries: 1,
      strict: false,
    });
    brief = validateBrief(raw);
  } catch (e) {
    console.warn(`[aidj] Claude unavailable (${e.code || e.name || 'error'}: ${String(e.message).slice(0, 160)}) — reading the request with rules`);
    // the notes' aliases first, the owner's house notes on top
    brief = validateBrief(parseBriefLocally(text, profile, { aliases: new Map([...libraryNotes().aliases, ...ai.parseDjNotes(ai.settings().djNotes).aliases]) }));
    source = 'rules';
  }
  brief = enforceTitleByArtist(text, brief, scope);
  const entry = { brief, source, at: Date.now() };
  if (source === 'claude') {
    _briefs.set(cacheKey, entry);
    if (_briefs.size > 500) _briefs.delete(_briefs.keys().next().value);
  }
  return { ...entry, cached: false };
}

function matchGenres(names, profile, notes, code) {
  const byKey = new Map(profile.genres.map(g => [toKey(g.genre), g.genre]));
  const raws = new Set();
  const matched = [];
  for (const name of names) {
    const k = toKey(name);
    let hits = byKey.has(k) ? [byKey.get(k)] : [...byKey.entries()].filter(([gk]) => gk.includes(k) || k.includes(gk)).map(([, g]) => g).slice(0, 10);
    if (!hits.length) { notes.push({ code, name }); continue; }
    for (const display of hits) {
      matched.push(display);
      for (const raw of profile.rawMap.get(display) || []) raws.add(raw);
    }
  }
  return { raws, matched: [...new Set(matched)] };
}

function familyRaws(families, profile, resolver) {
  const raws = new Set();
  if (!families.length) return raws;
  for (const g of profile.genres) {
    for (const raw of profile.rawMap.get(g.genre) || []) {
      const fam = resolver?.fromTag(raw) || keywordFamily(raw);
      if (fam && fam !== 'ignore' && families.includes(fam)) raws.add(raw);
    }
  }
  return raws;
}

// FGTH, "frankie goes 2 hollywood", "Frankie Goes To Hollywood" all mean one
// row of the artist index: exact, then search, then initials.
const ACRONYM_TTL_MS = 10 * 60 * 1000;
let _acronyms = null, _acronymsAt = 0;
function acronymIndex() {
  if (_acronyms && Date.now() - _acronymsAt < ACRONYM_TTL_MS) return _acronyms;
  const idx = new Map();
  for (const a of db.getArtistNames()) {
    const words = artistKey(a.name).replaceAll(/[^\p{L}\p{N} ]+/gu, '').split(' ').filter(w => w && !['the', 'and', 'of', 'de', 'die'].includes(w));
    if (words.length < 2) continue;
    const acro = words.map(w => w[0]).join('');
    if (!idx.has(acro)) idx.set(acro, a);
  }
  _acronyms = idx; _acronymsAt = Date.now();
  return idx;
}

function resolveArtist(name, vpaths) {
  let variants = db.resolveArtistNamesForDJ([name]);
  if (!variants.length) {
    const k = artistKey(name);
    const found = db.searchArtistsNormalized(name, vpaths).find(a => artistKey(a.name).includes(k) || k.includes(artistKey(a.name)));
    if (found) variants = found.variants;
  }
  if (!variants.length) {
    const acro = artistKey(name).replaceAll(/[^\p{L}\p{N}]+/gu, '');
    const hit = acro.length >= 2 && acro.length <= 6 ? acronymIndex().get(acro) : null;
    if (hit) variants = hit.variants.length ? hit.variants : [hit.name];
  }
  return variants;
}

async function resolveArtists(brief, scope, notes) {
  const seedArtists = new Set();
  const seedVariants = [];
  const seedNames = [];
  for (const name of brief.artists.slice(0, MAX_LIST)) {
    const variants = resolveArtist(name, scope.vpaths);
    if (!variants.length) { notes.push({ code: 'artistUnknown', name }); continue; }
    seedNames.push(name);
    seedArtists.add(artistKey(name));
    for (const v of variants) { seedArtists.add(artistKey(v)); seedVariants.push(v); }
  }
  const similarRank = new Map();
  let similarFound = 0;
  if (brief.artistMode === 'feature' && seedNames.length && lastfm()) {
    const lists = await Promise.all(seedNames.slice(0, MAX_SEEDS).map(similarArtists));
    for (const names of lists) {
      for (const [i, n] of names.entries()) {
        const variants = db.resolveArtistNamesForDJ([n]);
        if (!variants.length) continue;
        similarFound++;
        for (const v of variants) {
          const k = artistKey(v);
          if (!seedArtists.has(k)) similarRank.set(k, Math.min(similarRank.get(k) ?? Infinity, i + 1));
        }
      }
    }
  }
  const ignoreArtists = [];
  for (const name of brief.excludeArtists) {
    ignoreArtists.push(name, ...resolveArtist(name, scope.vpaths));
  }
  return { seedArtists, seedVariants, seedNames, similarRank, similarFound, ignoreArtists };
}

// "my playlist Sunday" → the full paths of its songs (a smart playlist is run first).
function resolvePlaylists(brief, scope, notes) {
  if (!brief.playlists.length || !scope.user) return [];
  const own = db.getUserPlaylists(scope.user).map(pl => ({ name: pl.name, kind: 'playlist' }));
  const smart = db.getSmartPlaylists(scope.user).map(sp => ({ ...sp, kind: 'smart' }));
  const all = [...own, ...smart];
  const paths = new Set();
  for (const wanted of brief.playlists) {
    const w = wanted.toLowerCase();
    const hit = all.find(p => p.name.toLowerCase() === w) || all.find(p => p.name.toLowerCase().includes(w) || w.includes(p.name.toLowerCase()));
    if (!hit) { notes.push({ code: 'playlistUnknown', name: wanted }); continue; }
    if (hit.kind === 'playlist') {
      for (const e of db.loadPlaylistEntries(scope.user, hit.name)) paths.add(e.filepath);
    } else {
      for (const row of db.runSmartPlaylist(hit.filters, hit.sort, hit.limit_n, scope.vpaths, scope.user, scope.opts.ignoreVPaths, scope.opts.filepathPrefix)) paths.add(`${row.vpath}/${row.filepath}`);
    }
    notes.push({ code: 'playlistUsed', name: hit.name, songs: paths.size });
  }
  if (brief.playlists.length && !paths.size) notes.push({ code: 'playlistEmpty' });
  return [...paths];
}

// "only from the 12 inches": the named collections become the scope.
function resolveCollections(brief, scope, notes) {
  if (!brief.collections.length) return {};
  const names = scope.collections || [];
  const chosen = [];
  for (const wanted of brief.collections) {
    const w = wanted.toLowerCase();
    const hit = names.find(nm => nm.toLowerCase() === w) || names.find(nm => nm.toLowerCase().includes(w) || w.includes(nm.toLowerCase()));
    if (hit) chosen.push(hit); else notes.push({ code: 'collectionUnknown', name: wanted });
  }
  if (!chosen.length) return {};
  const folders = config.program.folders || {};
  const rootOf = nm => (folders[nm]?.root || '').replace(/\/?$/, '/');
  const ignore = new Set(scope.opts.ignoreVPaths || []);
  const include = [];
  for (const nm of names) {
    if (chosen.includes(nm)) continue;
    // a parent stays when one of its children is chosen; the child becomes a prefix inside it
    const childChosen = chosen.find(c => rootOf(c).startsWith(rootOf(nm)) && rootOf(c) !== rootOf(nm));
    if (childChosen) include.push({ vpath: nm, prefix: rootOf(childChosen).slice(rootOf(nm).length) });
    else ignore.add(nm);
  }
  return { ignoreVPaths: [...ignore], includeFilepathPrefixes: include.length ? include : scope.opts.includeFilepathPrefixes };
}

function matchFolders(names, profile, notes) {
  const out = [];
  const all = [...profile.folders, ...(profile.folders2 || [])];
  for (const name of names) {
    const k = name.toLowerCase().replace(/\/+$/, '');
    const exact = all.filter(f => `${f.vpath}/${f.folder}`.toLowerCase() === k || f.folder.toLowerCase() === k);
    const hits = (exact.length ? exact : all.filter(f => `${f.vpath}/${f.folder}`.toLowerCase().includes(k))).slice(0, 10);
    if (!hits.length) { notes.push({ code: 'folderUnknown', name }); continue; }
    for (const f of hits) out.push({ vpath: f.vpath, prefix: `${f.folder}/`, label: `${f.vpath}/${f.folder}` });
  }
  return out;
}

// How far a too-small pool may be widened. Soft wishes (an era, a tempo) give
// way while the pool is merely small; explicit wishes (a key, a folder, a
// version, a genre) only when nothing at all matched — and "only these
// artists" never: fewer songs is the honest answer, other artists is not.
const TIERS = [
  {},
  { allowUnknownYear: true },
  { allowUnknownYear: true, dropBpm: true },
  { allowUnknownYear: true, dropBpm: true, widenYears: 5 },
  { allowUnknownYear: true, dropBpm: true, widenYears: 10 },
  { allowUnknownYear: true, dropBpm: true, widenYears: 10, dropKeys: true, explicit: true },
  { allowUnknownYear: true, dropBpm: true, widenYears: 10, dropKeys: true, dropFolders: true, explicit: true },
  { allowUnknownYear: true, dropBpm: true, widenYears: 10, dropKeys: true, dropFolders: true, dropRelease: true, explicit: true },
  { allowUnknownYear: true, dropBpm: true, widenYears: 10, dropKeys: true, dropFolders: true, dropRelease: true, dropGenres: true, explicit: true },
];

function poolOpts(brief, scope, r, tier, limit) {
  const hasYears = brief.yearFrom != null || brief.yearTo != null;
  const widen = hasYears ? (tier.widenYears || 0) : 0;
  return {
    ...scope.opts,
    minRating: brief.minRating || undefined,
    yearFrom: brief.yearFrom == null ? null : brief.yearFrom - widen,
    yearTo: brief.yearTo == null ? null : brief.yearTo + widen,
    allowUnknownYear: !!tier.allowUnknownYear,
    bpmFrom: tier.dropBpm ? null : brief.bpmFrom,
    bpmTo: tier.dropBpm ? null : brief.bpmTo,
    genreRawStrings: tier.dropGenres ? [] : r.whitelist,
    excludeGenreRawStrings: r.blacklist,
    artists: brief.artistMode === 'only' ? r.seedVariants : [],
    ignoreArtists: r.ignoreArtists,
    folderPrefixes: tier.dropFolders ? [] : r.folders.map(f => ({ vpath: f.vpath, prefix: f.prefix })),
    titles: brief.titles,
    patterns: tier.dropRelease ? [] : (RELEASE_PATTERNS[brief.release] || []),
    excludePatterns: brief.excludeKeywords,
    starred: brief.starred, played: brief.played, rated: brief.rated,
    minPlays: brief.minPlays, maxPlays: brief.maxPlays,
    addedWithinDays: brief.addedWithinDays, playedWithinDays: brief.playedWithinDays, notPlayedWithinDays: brief.notPlayedWithinDays,
    lossless: brief.lossless, hiRes: brief.hiRes,
    filepaths: r.filepaths,
    musicalKeys: tier.dropKeys ? [] : brief.keys,
    // a wish about a song's length is never relaxed: it is the whole point of such a request
    minSeconds: brief.minSeconds, maxSeconds: brief.maxSeconds,
    limit,
  };
}

function tierNotes(tier, brief, r) {
  const notes = [];
  if (tier.widenYears && (brief.yearFrom != null || brief.yearTo != null)) notes.push({ code: 'yearsWidened', from: brief.yearFrom == null ? null : brief.yearFrom - tier.widenYears, to: brief.yearTo == null ? null : brief.yearTo + tier.widenYears });
  else if (tier.allowUnknownYear && (brief.yearFrom != null || brief.yearTo != null)) notes.push({ code: 'unknownYearIncluded' });
  if (tier.dropBpm && (brief.bpmFrom != null || brief.bpmTo != null)) notes.push({ code: 'bpmDropped' });
  if (tier.dropFolders && r.folders.length) notes.push({ code: 'foldersDropped' });
  if (tier.dropKeys && brief.keys.length) notes.push({ code: 'keysDropped' });
  if (tier.dropRelease && brief.release !== 'any') notes.push({ code: 'releaseDropped' });
  if (tier.dropGenres && r.whitelist.length) notes.push({ code: 'genresDropped' });
  return notes;
}

function familyPool(brief, scope, r, resolver, limit) {
  if (!brief.families.length || !resolver) return [];
  const opts = { ...scope.opts, untaggedOnly: true, excludeGenreRawStrings: r.blacklist, ignoreArtists: r.ignoreArtists, limit, minRating: brief.minRating || undefined };
  return db.getQueueCandidates(scope.vpaths, scope.user, opts).filter(row => {
    const f = resolver.resolve(row);
    return f && brief.families.includes(f.family);
  });
}

const COMPILATION = /remix|best of|\bbest\b|greatest|collection|collector|classics|anthology|in concert|\blive\b|megamix|sampler|discoset|\bhits\b|disc \d|cd ?\d/i;

function albumTitleKey(t) { return String(t || '').toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

// The year an album is "from": the folder name when the collector wrote one
// ("1995 - Dream", "Red Lips (2016)") — that is curation, more reliable than
// tags on re-released tracks — else the median of the track years. A wide
// spread of tag years without a folder year smells like a compilation.
function albumYear(a) {
  const leaf = String(a.dir || '').replace(/\/+$/, '').split('/').pop() || '';
  const fromFolder = leaf.match(/(?:^|[^\d])((?:19|20)\d{2})(?!\d)/);
  const years = String(a.years || '').split(',').map(Number).filter(y => y >= 1900 && y <= 2100).sort((x, y) => x - y);
  const median = years.length ? years[Math.floor(years.length / 2)] : null;
  const spread = years.length ? years.at(-1) - years[0] : 0;
  return { year: fromFolder ? Number(fromFolder[1]) : median, fromFolder: !!fromFolder, spread };
}

// "One album of Cerrone from around 1985": resolve the albums the request can
// mean, rank them, and play the chosen one(s) track by track — no scoring, no
// arc, no artist spacing; an album is played as the album.
async function buildAlbumQueue(brief, scope, notes, profile) {
  const genres = matchGenres(brief.genres, profile, notes, 'genreUnknown');
  const artists = await resolveArtists({ ...brief, artistMode: 'only' }, scope, notes);
  const wantsCompilation = brief.keywords.some(k => COMPILATION.test(k)) || brief.albums.some(a => COMPILATION.test(a));
  const named = brief.albums.map(albumTitleKey);
  const excluded = new Set(brief.excludeAlbums.map(albumTitleKey));
  const hasYears = brief.yearFrom != null || brief.yearTo != null;
  const mid = hasYears ? ((brief.yearFrom ?? brief.yearTo) + (brief.yearTo ?? brief.yearFrom)) / 2 : null;

  let candidates = db.getAlbumCandidates(scope.vpaths, scope.user, {
    ...scope.opts, artists: artists.seedVariants, genreRawStrings: genres.raws, requireGenre: !artists.seedVariants.length && genres.raws.length > 0,
  }).filter(a => albumTitleKey(a.album) && !excluded.has(albumTitleKey(a.album)) && a.n >= 2);
  if (!candidates.length) return null;

  // whole words only: the album "VI" is not inside "Your Love Survived", and
  // the folder name ("1982 - Cerrone IX") counts as much as the tag
  const asWords = s => ` ${s} `;
  const within = (short, long) => short.length >= 2 && asWords(long).includes(asWords(short));
  const ranked = candidates.map(a => {
    const t = albumTitleKey(a.album);
    const dir = albumTitleKey(String(a.dir || '').split('/').pop() || '');
    const { year, fromFolder, spread } = albumYear(a);
    let score = 0;
    if (named.length) {
      const exact = named.some(n => t === n || dir === n);
      const partial = named.some(n => within(n, t) || within(t, n) || within(n, dir) || within(dir, n));
      score += exact ? 100 : (partial ? 60 : 0);
    }
    if (hasYears && year == null) {
      score -= 15;
    } else if (hasYears) {
      const d = Math.max(0, (brief.yearFrom ?? -Infinity) - year, year - (brief.yearTo ?? Infinity));
      score += d === 0 ? 30 : Math.max(0, 30 - d * 6);
      score -= Math.abs(year - mid) * 0.5;
    }
    if (!fromFolder && spread > 3) score -= 20;
    if (!wantsCompilation && COMPILATION.test(a.album)) score -= 25;
    if (!wantsCompilation && COMPILATION.test(String(a.dir || '').split('/').pop() || '')) score -= 10;
    if (a.artistCount > 3) score -= 20;
    if (a.n < 4) score -= 20; else if (a.n < 6) score -= 8; else if (a.n > 40) score -= 10;
    if (a.withTrack === a.n) score += 5;
    if (genres.raws.length) score += Math.min(20, 20 * a.genreHits / a.n);
    if (artists.seedVariants.length && artists.seedArtists.has(artistKey(a.albumArtist))) score += 10;
    return { ...a, year, score };
  }).sort((x, y) => y.score - x.score || y.n - x.n);

  for (const title of brief.albums) {
    const n = albumTitleKey(title);
    const known = ranked.some(a => {
      const t = albumTitleKey(a.album), dir = albumTitleKey(String(a.dir || '').split('/').pop() || '');
      return t === n || dir === n || within(n, t) || within(t, n) || within(n, dir) || within(dir, n);
    });
    if (!known) notes.push({ code: 'albumUnknown', name: title });
  }
  // a named album the library does not hold is answered honestly: nothing,
  // not whichever album ranks first among all the rest
  const chosen = named.length ? ranked.filter(a => a.score >= 60) : [ranked[0]];
  if (!chosen.length) return { songs: [], picked: [], stats: { pool: ranked.length, picked: 0, minutes: 0, artists: 0, albums: 0 }, resolved: { genres: genres.matched, excludeGenres: [], families: [], artists: artists.seedNames, similar: 0, folders: [], albums: [] } };

  const maxSongs = ai.settings().maxQueueSongs;
  const songs = [];
  const picked = [];
  for (const a of chosen) {
    const tracks = db.getAlbumTracks(scope.vpaths, scope.user, a.key, scope.opts);
    if (!tracks.length) continue;
    picked.push({ artist: a.albumArtist, album: a.album, year: a.year ?? null, tracks: tracks.length, candidates: ranked.length });
    for (const t of tracks) {
      if (songs.length >= maxSongs) break;
      songs.push(t);
    }
  }
  for (const p of picked) notes.push({ code: 'albumPicked', ...p });
  if (songs.length >= maxSongs) notes.push({ code: 'cappedByAdmin', max: maxSongs });
  const minutes = Math.round(songs.reduce((s, r) => s + (Number(r.duration) > 0 ? Number(r.duration) : 240), 0) / 60);
  const bpms = songs.map(s => s.bpm).filter(b => b > 0);
  return {
    songs, picked,
    stats: { pool: ranked.length, picked: songs.length, minutes, artists: new Set(songs.map(s => artistKey(s.artist))).size, bpmFrom: bpms.length ? Math.min(...bpms) : null, bpmTo: bpms.length ? Math.max(...bpms) : null, withBpm: bpms.length, albums: picked.length },
    resolved: { genres: genres.matched, excludeGenres: [], families: [], artists: artists.seedNames, similar: 0, folders: [], albums: picked.map(p => `${p.artist} — ${p.album}${p.year ? ` (${p.year})` : ''}`) },
  };
}

// When a position is held twice (a "new entries" folder re-using the number),
// the file in the chart's own numbered range wins.
function positionFit(row, pos) {
  const parts = row.filepath.split('/');
  const parent = parts.length > 1 ? parts.at(-2) : '';
  const range = parent.match(/^(\d{1,4})\s*-\s*(\d{1,4})$/);
  if (range) return Number(range[1]) <= pos && pos <= Number(range[2]) ? 2 : 0;
  return /\d/.test(parent) ? 0 : 1;
}

// "The top 10 of the House Top 1000": those positions, in chart order, read
// from the file names. The listener's own marks still filter; era, genre and
// tempo wishes do not — the chart is the content.
function buildChartQueue(brief, scope, notes, r, profile) {
  const chart = findChart(brief.chart, profile.charts || []);
  if (!chart) { notes.push({ code: 'chartUnknown', name: brief.chart }); return null; }
  const maxSongs = ai.settings().maxQueueSongs;
  const from = brief.chartFrom ?? 1;
  const to = Math.max(from, brief.chartTo ?? (brief.chartFrom == null && brief.songs != null ? brief.songs : chart.to));
  const rows = db.getQueueCandidates(scope.vpaths, scope.user, {
    ...scope.opts,
    folderPrefixes: [{ vpath: chart.vpath, prefix: `${chart.folder}/` }],
    artists: brief.artistMode === 'only' ? r.seedVariants : [],
    ignoreArtists: r.ignoreArtists,
    excludePatterns: brief.excludeKeywords,
    starred: brief.starred, played: brief.played, rated: brief.rated,
    minPlays: brief.minPlays, maxPlays: brief.maxPlays,
    addedWithinDays: brief.addedWithinDays, playedWithinDays: brief.playedWithinDays, notPlayedWithinDays: brief.notPlayedWithinDays,
    lossless: brief.lossless, hiRes: brief.hiRes,
    minRating: brief.minRating || undefined,
    limit: 20000,
  });
  const byPos = new Map();
  for (const row of rows) {
    const pos = chartPosition(row.filepath);
    if (pos == null || pos < from || pos > to) continue;
    const cur = byPos.get(pos);
    if (!cur || positionFit(row, pos) > positionFit(cur, pos)) byPos.set(pos, row);
  }
  let songs = [...byPos.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
  const found = songs.length;
  if (brief.order === 'countdown') songs.reverse();
  if (brief.order === 'random') {
    for (let i = songs.length - 1; i > 0; i--) {
      // eslint-disable-next-line sonarjs/pseudo-random
      const j = Math.floor(Math.random() * (i + 1));
      [songs[i], songs[j]] = [songs[j], songs[i]];
    }
  }
  if (songs.length > maxSongs) {
    notes.push({ code: 'cappedByAdmin', max: maxSongs });
    songs = brief.order === 'countdown' ? songs.slice(-maxSongs) : songs.slice(0, maxSongs);
  }
  if (!found) notes.push({ code: 'chartEmpty', name: chart.name, from, to });
  else notes.push({ code: 'chartPicked', name: chart.name, chart: chart.label, from, to, found, asked: to - from + 1 });
  const minutes = Math.round(songs.reduce((s, x) => s + (Number(x.duration) > 0 ? Number(x.duration) : 240), 0) / 60);
  return {
    songs,
    stats: { pool: rows.length, picked: songs.length, minutes, artists: new Set(songs.map(x => artistKey(x.artist))).size, chart: chart.label },
    resolved: { chart: chart.label, chartFrom: from, chartTo: to, artists: r.seedNames, excludeArtists: brief.excludeArtists },
  };
}

// "The most played disco song": the ranking decides, in its own order — no
// scoring, no sampling, no spacing. Identical recordings count once.
function buildRankedQueue(brief, scope, notes, r, ctx) {
  const maxSongs = ai.settings().maxQueueSongs;
  const want = Math.min(maxSongs, brief.songs ?? (brief.minutes ? Math.round(brief.minutes * 60 / 240) : DEFAULT_SONGS));
  let rows = [];
  let applied = TIERS[0];
  let lastOpts = null;
  // A ranking answers the question as asked: songs without a year may join,
  // but genres, artists, versions and keys are never dropped to fill the list.
  for (const tier of TIERS.slice(0, 2)) {
    const opts = { ...poolOpts(brief, scope, r, tier, Math.min(20000, want * 4 + 20)), orderBy: brief.ranking };
    const key = JSON.stringify(opts);
    if (key === lastOpts) continue;
    lastOpts = key;
    applied = tier;
    rows = db.getQueueCandidates(scope.vpaths, scope.user, opts);
    if (rows.length >= want) break;
  }
  notes.push(...tierNotes(applied, brief, r));
  const seen = new Set();
  const songs = [];
  for (const row of rows) {
    const k = brief.allVersions ? `${artistKey(row.artist)}|${String(row.title || '').toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, ' ').trim()}` : versionKey(row);
    if (seen.has(k)) continue;
    seen.add(k);
    songs.push(row);
    if (songs.length >= want) break;
  }
  if (!songs.length) notes.push({ code: 'rankingEmpty', ranking: brief.ranking });
  else if (songs.length < (brief.songs ?? want)) notes.push({ code: 'cappedByLibrary', found: songs.length });
  const minutes = Math.round(songs.reduce((s, x) => s + (Number(x.duration) > 0 ? Number(x.duration) : 240), 0) / 60);
  return { songs, stats: { pool: rows.length, picked: songs.length, minutes, artists: new Set(songs.map(x => artistKey(x.artist))).size, ranking: brief.ranking } };
}

// A name that matched nothing: is it in the library at all, just outside the
// listener's current selection? Then say so, with where it is — the listener
// switched that collection off, the DJ did not fail.
const OUTSIDE = { titleUnknown: 'titleOutsideScope', artistUnknown: 'artistOutsideScope', albumUnknown: 'albumOutsideScope', folderUnknown: 'folderOutsideScope', chartUnknown: 'chartOutsideScope' };
function explainOutsideScope(notes, scope) {
  if (!scope.narrowed) return notes;
  return notes.map(n => {
    if (!OUTSIDE[n.code] || !n.name) return n;
    const { total, rows } = db.getPhraseHits(scope.vpaths, scope.fullOpts, n.name, 100);
    if (!total) return n;
    const folders = new Map();
    for (const r of rows) {
      const seg = r.filepath.split('/');
      const k = seg.length > 1 ? `${r.vpath}/${seg[0]}` : r.vpath;
      folders.set(k, (folders.get(k) || 0) + 1);
    }
    const where = [...folders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k).join(', ');
    return { code: OUTSIDE[n.code], name: n.name, count: total, where };
  });
}

export async function buildQueue(brief, scope) {
  const result = await buildQueueInScope(brief, scope);
  result.notes = explainOutsideScope(result.notes, scope);
  if (!result.songs.length && !result.notes.some(n => n.code === 'empty')) result.notes.push({ code: scope.narrowed ? 'emptyInSelection' : 'empty' });
  else if (!result.songs.length && scope.narrowed) result.notes = result.notes.map(n => (n.code === 'empty' ? { code: 'emptyInSelection' } : n));
  return result;
}

async function buildQueueInScope(brief, scope) {
  const notes = [];
  if (brief.albumMode !== 'songs') {
    const profileForAlbums = libraryProfile(scope);
    const album = profileForAlbums?.total ? await buildAlbumQueue(brief, scope, notes, profileForAlbums) : null;
    if (album) {
      const fams = genreFamilyResolver();
      return {
        songs: album.songs.map(row => {
          const o = renderMetadataObj(row);
          const f = fams?.resolve(row);
          if (f) o.metadata['genre-family'] = f.family;
          return o;
        }),
        notes, stats: album.stats, resolved: album.resolved,
      };
    }
    notes.push({ code: 'albumNone' });
  }
  const profile = libraryProfile(scope);
  if (!profile || !profile.total) return { songs: [], notes: [{ code: 'empty' }], stats: { pool: 0, picked: 0, minutes: 0 }, resolved: {} };
  const resolver = genreFamilyResolver();
  const maxSongs = ai.settings().maxQueueSongs;

  const genres = matchGenres(brief.genres, profile, notes, 'genreUnknown');
  const excluded = matchGenres(brief.excludeGenres, profile, notes, 'genreUnknown');
  const fams = familyRaws(brief.families, profile, resolver);
  const artists = await resolveArtists(brief, scope, notes);
  const folders = matchFolders(brief.folders, profile, notes);
  const filepaths = resolvePlaylists(brief, scope, notes);
  const collectionScope = resolveCollections(brief, scope, notes);
  const r = {
    whitelist: [...new Set([...genres.raws, ...fams])],
    blacklist: [...excluded.raws],
    seedVariants: artists.seedVariants,
    seedNames: artists.seedNames,
    ignoreArtists: artists.ignoreArtists,
    folders, filepaths,
  };
  scope = { ...scope, opts: { ...scope.opts, ...collectionScope } };
  const render = rows => rows.map(row => {
    const o = renderMetadataObj(row);
    const f = resolver?.resolve(row);
    if (f) o.metadata['genre-family'] = f.family;
    return o;
  });
  if (brief.chart) {
    const chart = buildChartQueue(brief, scope, notes, r, profile);
    if (chart) return { songs: render(chart.songs), notes, stats: chart.stats, resolved: chart.resolved };
  }
  const ctx = {
    seedArtists: artists.seedArtists,
    similarRank: artists.similarRank,
    genreRaw: genres.raws,
    genreFamilies: new Set([...genres.raws].map(raw => resolver?.fromTag(raw) || keywordFamily(raw)).filter(f => f && f !== 'ignore')),
    familyOf: row => resolver ? (resolver.resolve(row)?.family ?? null) : keywordFamily(row.genre),
    keywords: brief.keywords,
    titles: brief.titles.map(t => t.toLowerCase()),
  };

  if (brief.ranking !== 'none') {
    const ranked = buildRankedQueue(brief, scope, notes, r, ctx);
    return {
      songs: render(ranked.songs),
      notes, stats: ranked.stats,
      resolved: { genres: genres.matched, excludeGenres: excluded.matched, families: brief.families, artists: artists.seedNames, similar: 0, folders: [...new Set(folders.map(f => f.label))], titles: brief.titles, keys: brief.keys, release: brief.release, ranking: brief.ranking },
    };
  }

  const resolved = {
    genres: genres.matched, excludeGenres: excluded.matched, families: brief.families,
    artists: artists.seedNames, similar: artists.similarFound,
    folders: [...new Set(folders.map(f => f.label))],
    titles: brief.titles, keys: brief.keys, release: brief.release,
    playlists: notes.filter(x => x.code === 'playlistUsed').map(x => x.name), collections: brief.collections,
  };
  const set = { scope, profile, resolver, maxSongs };
  if (brief.segments.length) {
    const phased = buildPhasedQueue(brief, set, notes, r, ctx);
    return { songs: render(phased.songs), notes, stats: phased.stats, resolved: { ...resolved, genres: phased.genres, families: phased.families, segments: phased.segments } };
  }
  const plan = pickSet(brief, set, notes, r, ctx);
  return { songs: render(plan.songs), notes: [...notes, ...plan.notes], stats: plan.stats, resolved };
}

// The pool for one brief, relaxed tier by tier until it is big enough, and
// the planned set from it. `exclude`: ids already playing in an earlier phase.
function pickSet(brief, { scope, profile, resolver, maxSongs }, notes, r, ctx, exclude = null) {
  const want = Math.min(maxSongs, brief.songs ?? (brief.minutes ? Math.round(brief.minutes * 60 / (profile.avgDuration || 240)) : DEFAULT_SONGS));
  // a request for one song with one exact match is answered, not relaxed
  const enough = want <= 5 ? want : Math.max(Math.ceil(want * 1.25), want + 5);
  const limit = Math.max(2000, Math.min(20000, want * 10));
  let pool = [];
  let applied = TIERS[0];
  let lastOpts = null;
  for (const tier of TIERS) {
    const opts = poolOpts(brief, scope, r, tier, limit);
    const key = JSON.stringify(opts);
    if (key === lastOpts) continue;
    if (tier.explicit && pool.length > 0) break;
    lastOpts = key;
    applied = tier;
    pool = db.getQueueCandidates(scope.vpaths, scope.user, opts);
    if (!tier.dropGenres) {
      const seen = new Set(pool.map(p => p.id));
      for (const row of familyPool(brief, scope, r, resolver, UNTAGGED_POOL)) if (!seen.has(row.id)) pool.push(row);
    }
    if (exclude?.size) pool = pool.filter(row => !exclude.has(row.id));
    if (pool.length >= enough) break;
  }
  notes.push(...tierNotes(applied, brief, r));
  for (const title of brief.titles) {
    const t = title.toLowerCase();
    if (!pool.some(row => String(row.title || '').toLowerCase().includes(t))) notes.push({ code: 'titleUnknown', name: title });
  }
  return planQueue({ brief, pool, maxSongs, ctx });
}

// A set in phases: each phase is its own brief for genre, tempo, arc and
// length, inheriting everything else (era, artists, marks, exclusions), built
// as its own mixable set that starts where the phase before it ended. A song
// plays in one phase only; the cap counts the whole set.
function buildPhasedQueue(brief, set, notes, r, ctx) {
  const { profile, resolver, maxSongs } = set;
  const songs = [], segments = [], genresUsed = new Set(), familiesUsed = new Set();
  const playing = new Set();
  let startBpm = null, left = maxSongs, pool = 0;
  for (const [i, seg] of brief.segments.entries()) {
    if (left <= 0) { notes.push({ code: 'cappedByAdmin', max: maxSongs }); break; }
    const sub = { ...brief, segments: [], genres: seg.genres, families: seg.families, bpmFrom: seg.bpmFrom, bpmTo: seg.bpmTo, energy: seg.energy, minutes: seg.minutes, songs: seg.songs };
    const own = [];
    const genres = matchGenres(seg.genres, profile, own, 'genreUnknown');
    const fams = familyRaws(seg.families, profile, resolver);
    const r2 = { ...r, whitelist: [...new Set([...genres.raws, ...fams])] };
    // where the next phase opens, so this one can end near it
    const next = brief.segments[i + 1];
    const endBpm = next ? next.bpmFrom ?? next.bpmTo ?? null : null;
    const ctx2 = { ...ctx, genreRaw: genres.raws, genreFamilies: new Set([...genres.raws].map(raw => resolver?.fromTag(raw) || keywordFamily(raw)).filter(f => f && f !== 'ignore')), startBpm, endBpm };
    const plan = pickSet(sub, { ...set, maxSongs: left }, own, r2, ctx2, playing);
    const corridor = plan.notes.find(n => n.code === 'flowCorridor');
    segments.push({
      index: i + 1, name: seg.name, genres: genres.matched, families: seg.families, energy: seg.energy,
      songs: plan.songs.length, minutes: plan.stats.minutes, bpmFrom: plan.stats.bpmFrom, bpmTo: plan.stats.bpmTo,
      corridor: corridor ? { from: corridor.from, to: corridor.to } : null,
    });
    for (const n of [...own, ...plan.notes]) {
      if (n.code === 'flowCorridor') continue;
      const note = n.code === 'cappedByAdmin' ? { ...n, max: maxSongs } : { ...n, phase: i + 1 };
      if (!notes.some(x => JSON.stringify(x) === JSON.stringify(note))) notes.push(note);
    }
    for (const row of plan.songs) { playing.add(row.id); songs.push(row); }
    for (const g of genres.matched) genresUsed.add(g);
    for (const f of seg.families) familiesUsed.add(f);
    const last = plan.songs.findLast(row => row.bpm > 0);
    if (last) startBpm = last.bpm;
    left -= plan.songs.length;
    pool += plan.stats.pool;
  }
  return { songs, segments, genres: [...genresUsed], families: [...familiesUsed], stats: queueStats(songs, { pool, avgDuration: profile.avgDuration || 240 }) };
}

// On for every listener once the admin switches it on; off per user with allow-ai-dj: false.
function allowedFor(user) {
  return ai.queueBuilderEnabled() && user?.['allow-ai-dj'] !== false;
}

function gate(req, res) {
  if (!allowedFor(req.user)) { res.status(404).json({ error: 'Not found' }); return false; }
  return true;
}

export function setup(velvet) {
  velvet.get('/api/v1/ai/status', (req, res) => {
    res.json({ enabled: allowedFor(req.user), maxSongs: ai.settings().maxQueueSongs, families: FAMILIES });
  });

  velvet.post('/api/v1/ai/queue/brief', async (req, res) => {
    if (!gate(req, res)) return;
    joiValidate(Joi.object({ text: Joi.string().trim().min(2).max(600).required(), ...scopeJoi }), req.body);
    const user = req.user.username;
    if (!throttle(user, 'brief', BRIEF_MIN_GAP_MS)) return res.status(429).json({ error: 'Too many requests', code: 'throttled' });
    if (!underDailyCap(user)) return res.status(429).json({ error: 'Daily limit reached', code: 'daily' });
    const scope = scopeOf(req.user, req.body);
    try {
      const { brief, cached, source } = await writeBrief(user, req.body.text.trim(), scope);
      console.log(`[aidj] brief user=${user} "${req.body.text.trim().slice(0, 120)}" → "${brief.title}" via ${source}${cached ? ' (cached)' : ''}${brief.clarification ? ' needs clarification' : ''}`);
      res.json({ brief, cached, source, usage: ai.usage() });
    } catch (e) {
      if (e instanceof ai.AiAssistError) return res.status(409).json({ error: e.message, code: e.code });
      if (e.isJoi) return res.status(409).json({ error: 'The answer could not be used', code: 'invalid' });
      throw e;
    }
  });

  velvet.post('/api/v1/ai/queue/build', async (req, res) => {
    if (!gate(req, res)) return;
    joiValidate(Joi.object({ brief: Joi.object().required(), ...scopeJoi }), req.body);
    const user = req.user.username;
    if (!throttle(user, 'build', BUILD_MIN_GAP_MS)) return res.status(429).json({ error: 'Too many requests', code: 'throttled' });
    let brief;
    try { brief = validateBrief(req.body.brief); } catch (e) { return res.status(400).json({ error: e.message }); }
    const scope = { ...scopeOf(req.user, req.body), user };
    const out = await buildQueue(brief, scope);
    console.log(`[aidj] build user=${user} "${brief.title}" → ${out.songs.length} songs, ${out.stats.minutes} min (pool ${out.stats.pool}${out.notes.length ? `; ${out.notes.map(n => n.code).join(', ')}` : ''})`);
    res.json(out);
  });
}
