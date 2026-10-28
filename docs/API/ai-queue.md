# AI DJ — building a set from a sentence (`/api/v1/ai/queue/*`)

The AI DJ turns a listener's description into a queue. Two calls: the first
asks Claude to read the sentence into a **brief**, the second builds the set
from that brief without any model call. You can skip the first call and send a
brief of your own, edit the brief Claude wrote before building, or rebuild the
same brief for another take.

All calls need a user token (`x-access-token`). Everything answers `404`
until an admin has set `aiAssist.enabled` and `aiAssist.queueBuilder`, and for
a user whose admin switched AI DJ off (`allow-ai-dj: false`).

## 1. Is it on?

```http
GET /api/v1/ai/status
```

```json
{ "enabled": true, "maxSongs": 500, "families": ["electronic", "disco", "soft", "ambient", "hard", "other"] }
```

`maxSongs` is the admin's cap for one set.

## 2. Write the brief

```http
POST /api/v1/ai/queue/brief
Content-Type: application/json

{ "text": "twee uur italo en hi-nrg uit de jaren 80 dat langzaam opbouwt, geen Modern Talking" }
```

Optional scope fields, the same as `POST /api/v1/db/random-songs`:
`ignoreVPaths`, `filepathPrefix`, `excludeFilepathPrefixes`. Without them the
whole library the user may see is in scope.

```json
{
  "brief": {
    "title": "Italo en Hi-NRG uit de jaren 80",
    "summary": "Twee uur Italo-Disco en Hi-NRG uit de jaren 80, die langzaam opbouwt; zonder Modern Talking.",
    "songs": null, "minutes": 120,
    "genres": ["Italo-Disco", "Hi-Nrg"], "excludeGenres": [], "families": [],
    "yearFrom": 1980, "yearTo": 1989, "bpmFrom": null, "bpmTo": null,
    "energy": "build",
    "artists": [], "artistMode": "feature", "excludeArtists": ["Modern Talking"],
    "folders": [], "keywords": [],
    "favourites": false, "discovery": false, "minRating": null,
    "clarification": null
  },
  "cached": false,
  "source": "claude",
  "usage": { "month": "2026-10", "calls": 4, "usd": 0.0046 }
}
```

- `source` is `claude`, `local` (a self-hosted model configured under
  *Advanced*), or `rules` when the model could not be asked (no key, budget
  spent, network, refusal, unusable answer) and the built-in reader wrote the
  brief from the text instead.
- `cached: true` means the same text was asked within 15 minutes; no model
  call was made.
- `clarification` is set — and the rest empty — when the request is not
  about music or cannot be met from the library; show it instead of building.
- The model is briefed as a DJ who knows music history: it expands shorthand
  (FGTH → Frankie Goes To Hollywood, GNR, RHCP, SAW) to the name the library
  uses, turns scenes and eras into genres and years ("Chicago house",
  "the SAW years"), labels and producers into folders or keywords, and
  formats into `release`. The server still resolves artists itself: exact
  name, then search, then initials (an acronym that matches one artist's
  initials is accepted).
- **The request is grounded before the model writes.** Every phrase of the
  request (pairs and triples of its words, single words, and "name + year"
  pairs such as "grandmix 1986" from "grandmix 1983 and 1986") is looked up
  in the library's search index, and the model is told what each one *is*
  there: `"grandmix 1983": 9 songs — in 9 titles: Grandmix 1983 · Grandmix
  1983 (Mastertape) · …; artist: Ben Liebrand; folders: Music/Grandmix`. A
  phrase that exists as a title becomes a `titles` entry, one as an artist an
  `artists` entry, one only as a folder a `folders` entry — instead of a
  guessed era, genre or mood. At most 12 lookups per request.
- The system prompt carries the **library notes** the admin page holds
  (what each folder is, written once by the model after reading the
  collection, editable under *What the AI knows about your library*): the
  broad folders always, deeper ones when a request's phrases land in them.
- The library summary also lists **series**: names that recur with
  different years in titles ("Grandmix 1982–2016, 30 editions"), so "name +
  year" is read as a title, never as an era. A brief whose year range merely
  repeats a year from one of its titles has that range dropped.
- Limits: 2–600 characters; one brief per user every 3 seconds (`429
  throttled`), 200 per user per day (`429 daily`).

### The brief, field by field

| Field | Meaning |
|---|---|
| `songs` / `minutes` | What was asked for; both `null` → 25 songs. Minutes are converted with the median song length and trimmed by the real durations. |
| `genres` / `excludeGenres` | Library genre names (as the Genres view shows them). Unknown names are ignored and reported in `notes`. |
| `families` | Broad styles when no genre name fits: `electronic`, `disco`, `soft`, `ambient`, `hard`, `other`. |
| `yearFrom` / `yearTo` | Era. Songs without a year are only used when the pool would otherwise be too small. |
| `bpmFrom` / `bpmTo` | Tempo window; songs without a BPM score neutral. |
| `energy` | `steady` (nearest-tempo chain), `build`, `peak` (rise, then down), `wave` (two rises), `cooldown`. |
| `artists` / `artistMode` | Artists to hear; `feature` adds their Last.fm similar artists, `only` restricts the set to them. Every named artist in the library gets at least one slot. |
| `excludeArtists` | Never these. |
| `folders` | Top-level folders (`vpath/folder`) to stay inside. |
| `keywords` | Lowercase words looked for in titles, file and folder names (`love`, `summer`, `extended`, `12 inch`). |
| `albumMode` | `songs` (a mixed set, default), `oneAlbum` ("one album of Cerrone from around 1985": Velvet ranks that artist's albums by era, title and shape — compilations, remix albums and multi-artist folders rank low unless asked — and plays the best one **in track order**), `wholeAlbums` (the named `albums` complete, in order). |
| `albums` / `excludeAlbums` | Album titles named by the listener; titles to skip ("Another take" on an album request adds the one just played). |
| `titles` | Song titles named ("play Relax"); matched inside library titles. Named songs with no count mean one song each, and every named title is guaranteed its best match (two versions of "Grandmix 1983" cannot crowd out "Grandmix 1986"). |
| `minSeconds` / `maxSeconds` | A wish about a song's length ("+10 minutes" → `minSeconds: 600`). Never relaxed. |
| `keys` | Musical keys as Camelot codes (`8A`); key names ("A minor", "F# major") are converted. Relaxed first when the pool is too small. |
| `ranking` | `none`, `mostPlayed`, `leastPlayed`, `topRated`, `recentlyAdded`, `recentlyPlayed` — answered from the listener's own statistics (the same play counts, ratings and timestamps the Most Played / Recently Added views use) in exact order, within the other filters; no sampling, no scoring. "The most played song" → `mostPlayed`, `songs: 1`. |
| `starred`, `played` (`any`/`never`/`played`), `rated` (`any`/`rated`/`unrated`), `minPlays`/`maxPlays` | The listener's own marks and counts — the same columns the Starred, Unplayed Gems and smart-playlist views use. |
| `addedWithinDays`, `playedWithinDays`, `notPlayedWithinDays` | Date windows: "added this month", "played last week", "not played in a year". |
| `lossless` (`true`/`false`/`null`), `hiRes` | File format wishes: flac/wav/aiff/alac only, mp3 only, 24-bit or > 48 kHz. |
| `playlists` | The listener's own playlists or smart playlists by name; the set is built from their songs (smart playlists are run first). |
| `collections` | Restrict to named collections (vpaths), as the scope pills do. |
| `excludeKeywords` | Words that must not appear in a title or file name ("no remixes"). |
| `allVersions` | By default one version of a song is played — not the 7-inch, the 12-inch and the remix. `true` plays every version ("all versions of Relax"). |
| `chart`, `chartFrom`, `chartTo` | A **chart in the library**: a folder whose file names start with the position (`001 - Jaydee - Plastic Dreams.flac`, `12. The O'Jays - I Love Music.wav`). Velvet detects these folders itself (nearly every file numbered, dense positions starting at 1, the folder named like a list) and shows them to the model as *Charts*. "The top 10 of the House Top 1000" → `chart: "Music/Housetop1000", chartFrom: 1, chartTo: 10`; "number 1 of 1983" → the 1983 chart, 1–1; both `null` → the whole chart. The positions are played **in chart order, number 1 first** (or `order: "countdown"` to count down to number 1), read from the file names — no scoring, no sampling. Era, genre and tempo wishes are ignored for a chart (the chart is the content); the listener's own marks (starred, never played, …), excluded artists and words still filter. A position held twice (a "new entries" folder re-using the number) is played once, from the chart's own numbered range. `chart` wins over `ranking`. |
| *(every DJ-ordered set)* | The DJ mixes like a mix DJ: a set in `dj` order is picked from one **mixable corridor** — a seed song and, around it, only songs within a few BPM (the corridor follows the arc: a build climbs up to +14%, a steady set stays within ±6%), in a compatible key and the same genre family — provided that costs no quality (the corridor must hold enough distinct songs and artists and its best picks must score as the whole pool's best do; otherwise the corridor is dropped). The ladder is then smoothed: the widest tempo gap is filled from the corridor, and artist and key spacing may only move a song within that step. **No neighbour is more than about 2.5% (3 BPM at 125) apart**; `stats.maxStep` reports the largest step taken. The note `flowCorridor { from, to, genre }` says which corridor was used. **Keys are mixed harmonically on the Camelot wheel**: walking the ladder, the next song is one the current key mixes into — the same key, one step round the wheel (8A → 7A or 9A) or the relative major/minor (8A ↔ 8B) — chosen among the next eight songs whenever the tempo step allows and no artist lands next to itself; the pass runs before and after artist spacing. `stats.harmonic` / `stats.transitions` count the harmonic transitions among those where both keys are known, `stats.withKey` the songs with a key. Songs without an analysed key cannot be judged; the player says how many there are. |
| `cohesive` | `true` when the songs must match **each other** ("3 songs that match in tempo, key and genre", "a harmonic mix"). One song becomes the seed; the others must sit within ±3% of its BPM, in the same or a neighbouring Camelot key, with the same genre tag. When too few qualify the rules widen one step at a time (±6% BPM, same genre family, relative keys, then no key rule, ±8%), and every step taken is reported. Not the same as `bpmFrom`/`bpmTo` or `keys`, which are for a tempo or key the listener names. |
| `order` | `dj` (tempo flow, default), `chronological`, `newestFirst`, `alphabetical`, `random`, `countdown` (charts only: highest position first, ending at number 1). |
| `prefer` | `none`, `longest`, `shortest`, `newest`, `oldest` — "the longest version you have". |
| `release` | `any`, `album`, `single` (7-inch, radio edits), `12inch` (12-inch, maxi, extended, club), `extended`, `instrumental`, `remix`, `live`, `original` — matched against titles and file names. |
| `favourites` / `discovery` | Lean on rating and play count — or on the never-played. |
| `minRating` | 0–10 (4 stars = 8). |

## 3. Build the set

```http
POST /api/v1/ai/queue/build
Content-Type: application/json

{ "brief": { ...the brief, edited or not... } }
```

Same optional scope fields as above. One build per user per second.

```json
{
  "songs": [
    { "filepath": "Music/Italo/Gazebo - I Like Chopin.flac",
      "metadata": { "artist": "Gazebo", "title": "I Like Chopin", "year": 1983, "genre": "italo-disco", "bpm": 108, "musical-key": "D minor", "duration": 372, "genre-family": "disco", "...": "…" } }
  ],
  "notes": [ { "code": "cappedByAdmin", "max": 500 } ],
  "stats": { "pool": 744, "picked": 20, "minutes": 126, "artists": 12, "bpmFrom": 107.5, "bpmTo": 136.5, "withBpm": 18 },
  "resolved": { "genres": ["Italo-Disco", "Hi-Nrg"], "excludeGenres": [], "families": [], "artists": [], "similar": 46, "folders": [] }
}
```

`songs` are in play order and have the same `{ filepath, metadata }` shape as
every other song endpoint, so they go straight into the queue or
`POST /api/v1/playlist/save`.

`notes` tell the listener what happened:

| `code` | Meaning |
|---|---|
| `cappedByAdmin` `{ max }` | More was asked than the admin allows. |
| `cappedByLibrary` `{ found }` | Fewer matching songs than asked. |
| `genreUnknown` / `artistUnknown` / `folderUnknown` `{ name }` | Not in the library; ignored. |
| `unknownYearIncluded`, `yearsWidened` `{ from, to }`, `bpmDropped` | A soft wish (era, tempo) gave way because the pool was too small for the set. |
| `keysDropped`, `foldersDropped`, `releaseDropped`, `genresDropped` | An explicit wish was dropped because **nothing at all** matched it. "Only these artists" is never dropped: a shorter set is returned instead. |
| `albumPicked` `{ artist, album, year, tracks, candidates }` | The album that was played whole, and how many albums were considered. |
| `albumUnknown` `{ name }` | A named album is not in the library. |
| `albumNone` | An album was asked for but none matched; a mixed set was built instead. |
| `titleUnknown` `{ name }` | A named song is not in the library. |
| `titleOutsideScope`, `artistOutsideScope`, `albumOutsideScope`, `folderOutsideScope`, `chartOutsideScope` `{ name, count, where }` | The name exists in the library the listener may access, but outside the current selection (a collection switched off, a folder chosen). `where` lists the top-level folders that hold it. The DJ never plays outside the selection; it says where the music is instead. |
| `emptyInSelection` | Nothing matched within a narrowed selection (as opposed to `empty`: nothing in the whole library). |
| `cohesionSeed` `{ artist, title, bpm, key, genre, pct, found }` | The song the cohesive set was built around and the tempo tolerance used. |
| `cohesionFamily`, `cohesionKeyLoose`, `cohesionKeyDropped`, `cohesionPartial` `{ found }`, `cohesionDropped` | Which cohesion rule had to give way: genre family instead of tag, looser or no key rule, fewer songs than asked, or no BPM data at all. |
| `playlistUsed` `{ name, songs }`, `playlistUnknown` `{ name }`, `playlistEmpty`, `collectionUnknown` `{ name }` | Playlist and collection resolution. |
| `rankingEmpty` `{ ranking }` | Nothing has the asked statistic yet (nothing played or rated that matches). |
| `chartPicked` `{ name, chart, from, to, found, asked }` | The chart and positions played, and how many of those positions exist in the library. |
| `chartUnknown` `{ name }` | No chart folder matches that name; the brief was built as a normal set instead. |
| `chartEmpty` `{ name, from, to }` | The chart exists but no song in those positions passed the other filters. |
| `keysDropped`, `releaseDropped` | The key or version filter was relaxed because the pool was too small. |
| `empty` | Nothing in scope. |

`400` for a brief that does not validate (unknown `energy`, more than 25
names in a list, …).

## Examples

A set from your own brief, no model call at all:

```bash
curl -sk -H "x-access-token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"brief":{"songs":30,"genres":["House"],"bpmFrom":122,"bpmTo":128,"energy":"peak","favourites":true}}' \
  https://music.example:3000/api/v1/ai/queue/build | jq '.stats, [.songs[].metadata | "\(.bpm) \(.artist) — \(.title)"]'
```

Ask, edit, build:

```js
const brief = (await post('/api/v1/ai/queue/brief', { text: 'late 70s disco for a dinner, two hours' })).brief;
brief.minutes = 90;                       // the listener changed their mind
const set = await post('/api/v1/ai/queue/build', { brief });
await post('/api/v1/playlist/save', { title: brief.title, songs: set.songs.map(s => s.filepath) });
```

## What is sent where

Only the listener's text and a summary of the library (genre names, biggest
artists, top-level folder names, decade and tempo counts) go to Anthropic;
the summary is cached for ten minutes. The chosen songs, user names and play
history never leave the server. Each brief costs about $0.002 on Haiku 5.5
(about $0.0003 once the summary is cached) and counts against the monthly
budget set by the admin.
