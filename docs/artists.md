# Artist Library

The Artist Library is a dedicated view for browsing your music collection by artist. It combines a smart normalisation layer (which collapses tag variants into a single canonical name), a precomputed index in the database, and a rich client-side UI.

---

## Feature overview

| Feature | Status |
|---------|--------|
| Artist home page — "Most Songs in Library" shelf | ✅ |
| Artist home page — "Most Played Artists" shelf | ✅ |
| Artist home page — "Recently Listened" shelf | ✅ |
| Shelf drag-to-reorder (persisted per user) | ✅ |
| A–Z letter browse | ✅ |
| Artist name search | ✅ |
| Artist profile — Songs and Albums tabs, category pills | ✅ |
| Artist biography (Last.fm, else TheAudioDB), genre / country / formed-year chips and fanart hero (TheAudioDB) | ✅ |
| Similar artists on the profile (from the [similar-artists source](similar-artists.md): ListenBrainz, TIDAL or Last.fm; only artists with albums in the library) | ✅ |
| Admin artist image repair (missing/wrong queues + Discogs/TheAudioDB picker) | ✅ |
| Custom artist image URL apply (admin) | ✅ |
| Background image hydration | ✅ |
| Per-artist discography stats | 🔜 planned |

---

## How the artist index works

### The `artists_normalized` table

All artist intelligence is stored in one table (created in `src/db/sqlite-backend.js`, extra columns added by migrations):

| Column | Meaning |
|---|---|
| `id` | Row id (also the rowid of the `fts_artists` trigram search table) |
| `artist_clean` | Canonical display name (unique) |
| `artist_raw_variants` | JSON array of all raw tags that map here |
| `vpaths_json` | JSON array of vpaths the artist has files in |
| `song_count` | Number of songs |
| `sort_name` | Sort key |
| `bio`, `genre`, `country`, `formed_year`, `mbid` | Profile data (TheAudioDB / MusicBrainz) |
| `image_file`, `image_source`, `fanart_file` | Files in `image-cache/artists/` |
| `last_fetched`, `image_flag_wrong`, `name_override` | Hydration and admin state |

`artist_clean` is the single name shown in the UI. `artist_raw_variants` is a JSON array like `["Madonna","03_Madonna","madonna "]` — every distinct value of `COALESCE(album_artist, artist)` in the `files` table that was judged to be the same person.

### Normalisation algorithm (`src/util/artist-normalize.js`)

`buildArtistGroups(rows)` is called with every distinct `{ artist, count }` row and returns the groups of `canonicalName → raw variants`. It runs a series of passes in order:

**Pass 1 — exclusion of junk tags**
- `PURE_DIGITS_RX` — tags that are just digits (`"01"`, `"42"`) are excluded entirely. These are ripped track numbers that ended up in the artist field; they cannot be attributed to a real artist.

**Pass 2 — normalisation to a clean key**
Each raw tag is run through these transforms (first match wins):

1. `PAREN_ONLY_RX` — entire field is a remix credit: `" (Nalin & Kane Remix)"` → artist = `"Nalin & Kane"`.
2. `PAREN_SUFFIX_RX` — remix suffix on a main artist: `"EWF (Phats & Small Remix)"` → artist = `"EWF"`.
3. `UNDERSCORE_PREFIX_RX` — filesystem-numbered tag: `"01_Communards"` → `"Communards"` (underscores replaced with spaces).
4. Track-number prefixes — zero-padded (`"01 Madonna"`), dotted (`"3. Madonna"`), side (`"1a) Madonna"`) and vinyl side (`"A1 Madonna"`) prefixes are stripped. A prefix that leaves only a year is dropped.
5. `UNPADDED_PREFIX_RX` (safe) — only applied when a clean variant already has many more songs; prevents `"2 Unlimited"` from collapsing into `"Unlimited"`.

**Pass 2b — explicit featuring credits**
A group whose name is `<lead> feat. <guest>` (also `ft.` and `featuring`) is merged into the `<lead>` group whenever that group exists, regardless of song counts: `"Afrojack feat. Eva Simons"` counts as an Afrojack song. `vs`, `&` and `x` credits are collaborations without a clear lead and are left alone.

**Pass 3 — similarity/containment merge**
After the explicit passes, any *small* group (≤ 5 songs, `SIM_MAX_CANDIDATE`) whose key, at a word boundary, is **contained within** a *large* group's key (≥ 10 songs, `SIM_MIN_TARGET`, ≥ 5× more songs, key ≥ 5 chars) is merged into the larger group. This catches residual malformed tags like `"Nalin & Kane Remix)"` (missing opening paren) that survive the earlier passes.

### When is the index rebuilt?

`rebuildArtistIndex()` runs:

- at the end of every file scan (`POST /api/v1/scanner/finish-scan` in `src/api/scanner.js`);
- when an admin clicks **Rebuild Artist Index** in **Admin → Database** (`POST /api/v1/admin/artists/rebuild-index`);
- when a folder's **Artists: On/Off** flag changes;
- after the Wrapped folder-metadata backfill.

The rebuild runs in a `worker_thread` (`src/util/artist-rebuild-worker.mjs`) and goes through the background task broker, so heavy normalisation does not block the main server event loop.

The rebuild:
1. Queries all distinct `(COALESCE(album_artist, artist), vpath, COUNT(*))` rows from `files`, limited to folders with Artists on.
2. Passes them through `buildArtistGroups()`.
3. DELETEs the `artists_normalized` table and re-inserts in one transaction, keeping each artist's bio, images, flags, name override and other profile data.
4. When started from admin, calls `invalidateArtistCache()` when done so the home-page cache is refreshed. Otherwise the 5-minute home cache expires on its own.

### Folder-level artist inclusion (`artistsOn`)

Each configured folder has an Artist Library include flag:

- `artistsOn: true` (default) — folder contributes to artist index + artist features.
- `artistsOn: false` — folder is excluded from artist index rebuilds.

This setting is controlled in **Admin → Directories** via **Artists: On/Off** and applies to:

- Artist Home shelves (Most Songs, Recently Listened, Most Played)
- A-Z letter browse + artist search
- artist image hydration and missing/wrong audit queues

The Admin UI also shows an inline hint beside each folder path:

- root folders affect the whole artist subtree by default
- child folders act as scoped overrides for only their own subfolder prefix inside the parent root

When changed, the server starts a background rebuild of `artists_normalized`, so the toggle response is immediate while updated results appear as soon as rebuild completes.

### Why a precomputed table?

A naive approach would JOIN `files` with a normalisation function on every request. On a large library that join takes seconds on every page load. The precomputed table makes artist lookups and listings simple single-table queries.

---

## API endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/v1/artists/home` | user | Home stats: `totalCount`, `topArtists` (top 20 by song count), `mostPlayedArtists` (top 20 by plays), `recentArtists` (last 10 played) |
| GET | `/api/v1/artists/letter?l=A` | user | All artists starting with that letter; `l=0` returns all digit-starting names |
| GET | `/api/v1/artists/search?q=…` | user | Trigram search on canonical artist names (min 2 chars), limited to artists in the caller's own folders |
| GET | `/api/v1/artists/profile?key=…` | user | Profile: bio, image, fanart, MBID, genre, country, formed year, release categories. Fetches missing TheAudioDB data on demand |
| GET | `/api/v1/artists/image?artist=…` | user | Cached image file for a raw artist name, or `{}` (and queues hydration) |
| GET | `/api/v1/artists/images/:filename` | user | Serve a stored artist image from `image-cache/artists/` |
| GET | `/api/v1/artists/placeholder` | public | The artist placeholder image: the custom one if set, else the built-in default (`webapp/assets/img/unknownartist.webp`). The custom image is stored as `artist-placeholder.jpg` in the config folder (`save/conf/`, next to `default.json`) |
| POST | `/api/v1/artists/set-image` | admin | Download an image URL, resize, store as the artist image |
| POST | `/api/v1/artists/set-name` | admin | Override the display name of an artist |
| POST | `/api/v1/artists/mark-image-wrong` | admin | Flag/unflag an artist image as wrong from the player view |
| POST | `/api/v1/db/artists-albums-multi` | user | Albums for one artist (accepts an array of variant names to handle all tag forms) |
| POST | `/api/v1/admin/artists/rebuild-index` | admin | Trigger an immediate index rebuild without a full scan |
| GET | `/api/v1/admin/artists/image-audit?kind=missing\|no-image\|wrong\|with-image` | admin | List pending missing artists, already-tried no-image artists, wrong-image review, and with-image validation |
| GET | `/api/v1/admin/artists/hydration-status` | admin | Live hydration queue status, counters, delay profile, and Discogs readiness |
| POST | `/api/v1/admin/artists/hydration-seed` | admin | Enqueue missing artists on demand (`limit`, default 500; used by **Queue next 500**) |
| POST | `/api/v1/admin/artists/hydrate-tadb-noimage` | admin | Re-queue no-image artists for TheAudioDB, ignoring cooldowns (**Retry next 500 (TheAudioDB)**) |
| POST | `/api/v1/admin/artists/enrich-tadb` | admin | Reset the fetch flag of artists with no image and no profile data, and queue artists that have an image but no fanart/genre for TheAudioDB enrichment |
| GET | `/api/v1/admin/artists/discogs-candidates?artistKey=...` | admin | Fetch Discogs artist image candidates |
| GET | `/api/v1/admin/artists/tadb-candidates?artistKey=...` | admin | Fetch TheAudioDB artist image candidates |
| POST | `/api/v1/admin/artists/apply-image` | admin | Apply selected Discogs/TheAudioDB/custom image URL to artist (`artistKey`, `imageUrl`, optional `source`) |
| POST / DELETE | `/api/v1/admin/artists/placeholder` | admin | Upload (one image, max 10 MB, saved as a square JPEG to `save/conf/artist-placeholder.jpg`) or remove the custom artist placeholder image |
| GET | `/api/v1/admin/artists/placeholder-info` | admin | Whether a custom placeholder is set |

TheAudioDB lookups (`tadb-candidates` and the background bio/image hydration pipeline) use TheAudioDB's shared public test key, `TADB_API_KEY` in `src/api/artists-browse.js` (defaults to `123`; TheAudioDB has silently killed a shared test key before — their other documented one, `2`, now 404s every query). Override with the `TADB_API_KEY` env var if `123` ever meets the same fate.

### Artist object shape (home, letter and search lists)

```json
{
  "artistKey":     "madonna",
  "canonicalName": "Madonna",
  "imageFile":     null,
  "hasBio":        false,
  "songCount":     847,
  "rawVariants":   ["Madonna", "03_Madonna"]
}
```

Entries in `mostPlayedArtists` also carry `playCount`.

`artistKey` is the lowercase version of `canonicalName` — use it as a stable identifier for navigation state.

### `POST /api/v1/db/artists-albums-multi`

Request body:
```json
{
  "artists": ["Madonna", "03_Madonna", "madonna "],
  "ignoreVPaths": [],
  "excludeFilepathPrefixes": [],
  "includeFilepathPrefixes": []
}
```

Response — `albums` array (each album object):
```json
{
  "name":           "Like a Prayer",
  "album_art_file": "3f2a….jpg",
  "year":           1989,
  "dir":            "Albums/Like a Prayer (1989)/",
  "normDir":        "Albums/Like a Prayer (1989)"
}
```

`album_art_file` is an image-cache filename (`aaFile`). `normDir` can be used as the `albumDir` filter when fetching album songs (`POST /api/v1/db/album-songs`) — it scopes the query to exactly that physical folder so albums that share a tag name (e.g. all discs tagged `"Catalogue"`) each return only their own tracks.

The web player's artist profile does not use this endpoint; its Albums tab is built from the Album Library data (see below).

---

## Client-side UI (`webapp/app.js`)

### Artist home (`viewArtists`)

Loads `GET /api/v1/artists/home`. Three draggable shelves (home-shelf style), up to 8 artists each:
- **Most Songs in Library** — top artists ranked by song count
- **Most Played Artists** — top artists ranked by play-event history
- **Recently Listened** — last artists played

Shelf order is persisted to `localStorage` under `ms2_art2_order_{username}`.

Below the shelves: A–Z pill strip and a search bar. Clicking a letter loads `GET /api/v1/artists/letter?l=…`; the search box queries `GET /api/v1/artists/search?q=…` with 250 ms debounce.

The density controls (**List / Comfortable / Compact**) apply to the result grid. Preference is persisted per user in localStorage (`ms2_art2_density_{username}`, default list).

For admin users, artist cards/rows include a flag action to mark an artist image as wrong. This feeds the Admin image-repair queue.

### Background image hydration behavior

- Home shelves enqueue hydration for missing artist images.
- Letter browse (`0-9`, `A-Z`) and search results also enqueue hydration for artists in the shown result set.
- Each hydration asks Discogs, TheAudioDB and Last.fm in parallel. The image is taken from TheAudioDB, else Discogs, else Last.fm; the bio from Last.fm, else TheAudioDB; fanart, genre, country and formed year from TheAudioDB.
- Hydration runs as a throttled background queue with adaptive delays (1.4 s after success, 2.2 s after no-image/skip, 4 s after errors) and a queue cap of 50,000 entries.
- An artist is not retried within 12 hours in the same server session. When an upstream lookup yields no usable image, the fetch attempt is recorded (`last_fetched`) so missing artists are not repeatedly retried.
- Admin can monitor live queue/rate/error counters via `GET /api/v1/admin/artists/hydration-status` (used by the Admin → Artists status panel).
- Admin can force-start hydration with `POST /api/v1/admin/artists/hydration-seed` (**Queue next 500** in Admin → Artists).
- Admin counts separate **pending missing** artists (never tried yet) from **no image found** artists that were already checked upstream and returned nothing.

### Admin image repair workflow

`Admin → Artists` provides:

- **Missing** queue: artists with no stored image.
- **No image found** queue: artists already checked upstream with no usable result; shown separately so the pending queue stays actionable.
- **With image** queue: artists that already have an image, for manual quality review.
- **Wrong** queue: artists flagged from the player as incorrect image.
- Discogs and TheAudioDB candidate grids with direct apply.
- Direct image URL apply for manual fixes, with a live preview before applying.
- Admin route CSP explicitly allows external HTTPS image sources and `blob:` previews so Discogs/manual URL previews render correctly in the image repair workflow.
- In **With image**, admins can quickly validate each portrait with **Yes: image is OK** or **No: mark wrong**.
- Live telemetry panel showing whether background hydration is running, queue depth, dropped items (queue cap), and session progress.
- Clear Discogs readiness state (enabled + API credentials) so users understand when Discogs suggestions are unavailable.

When an image is applied, the wrong flag is cleared automatically.

### Artist profile (`viewArtistProfile2`)

Loads `GET /api/v1/artists/profile`, `POST /api/v1/db/artist-folder-songs` and the Album Library (`GET /api/v1/albums/browse`) in parallel. The page shows the artist image (or a fanart hero), bio, genre/country/formed-year chips, similar artists, and two tabs:

**Albums tab.** The albums come from the Album Library (see [albums.md](albums.md)). An album appears on an artist's page when:
- it belongs to a series whose name contains the artist **as a whole word** (`_nameContainsArtist`) — whole-word matters: "Black Sabbath" contains the letters "abba", and a plain substring check put Black Sabbath's albums on ABBA's page;
- its majority `album_artist`/`artist` tag (`rawArtistTags`) matches one of the artist's variants; or
- its top-level folder is the artist's name (`Artist`, `Artist - …`, `Artist (…`, `Artist-…`).

Albums are sorted by year. When albums carry a category label, **category pills** appear above the grid (**Albums** = albums without a category, plus one pill per category). When you open an album and press back, the Albums tab and category are restored.

**Songs tab.** Lists the artist's songs *outside* Albums-Only folders. If the whole library is Albums-Only, everything is reached through the Albums tab and the Songs tab is empty by design. Clicking a song adds it to the queue.

**Profile data (`GET /api/v1/artists/profile`).** Releases are grouped as `Category/Release/…`. Songs directly inside an artist folder (`Artist/song.mp3`) form a release of their own, and loose files at the library root are grouped by album tag.

---

## Future work

- **Discography stats** — total songs, total albums, year range, top genres.
