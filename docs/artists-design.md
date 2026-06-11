# Artist Library — Design & Implementation Plan

## Overview

Build a full Artist Library feature for Velvet:
- Smart artist-name normalization system (multi-signal: ID3 tags + folder structure + frequency voting)
- Artist grid (image, name, album count) — similar layout to Albums Library
- Artist detail page: biography, artist image, album grid (clickable, same as Albums Library), singles/12-inches section
- Admin: fetch bio + image from Last.fm (with MusicBrainz fallback), override name and image

---

## Background — Why Normalization Is Hard

138K songs in the DB. Artist names come from ID3 tags written at different times by different tools. Known problems observed in the UI:
- `"1 Ben Liebrand"` and `"Ben Liebrand"` appear as separate artists
- `"2 Supertramp"` vs `"Supertramp"`
- `"38 Pink"` vs `"Pink"`
- Possibly folder-name-derived prefixes (e.g. folders sorted numerically by record label or release year)

Root cause is unknown until DB audit (Phase 0) runs. Could be:
1. ID3 tags were written with numeric sort prefixes by a tagger
2. Folder names like `"38 Pink/"` were parsed as artist names during scan
3. Both

**Phase 0 scripts must run and be analyzed before any normalization code is written.**

---

## Phase 0 — DB Audit (5 scripts, run one at a time)

All scripts: create as `/home/Velvet/audit-artistN.cjs`, run with `node /home/Velvet/audit-artistN.cjs`, delete after output captured.

### Script 1 — Schema + counts
- `PRAGMA table_info(files)` — confirm all columns
- `COUNT(*)`, `COUNT(DISTINCT artist)`, `COUNT(DISTINCT album)`
- Count songs with/without `artist` tag

### Script 2 — Numeric-prefix artists
- `SELECT artist, COUNT(*) FROM files WHERE artist GLOB '[0-9]*' GROUP BY artist ORDER BY CAST(artist AS INTEGER)`
- Shows every artist tag that starts with a digit, with song count

### Script 3 — L1 folder anatomy
- `SELECT SUBSTR(filepath,1,INSTR(filepath,'/')-1) AS l1, COUNT(*) FROM files GROUP BY l1 ORDER BY l1 LIMIT 100`
- Shows first-level folder segments — do any start with digits?

### Script 4 — Folder vs tag mismatch
- For files where L1 folder contains ` - ` (i.e. `"Artist - Album"` format), extract folder-artist and compare to `artist` tag
- Surfaces where they differ — confirms whether tags or folder parsing is the problem

### Script 5 — L2 subfolder survey per artist
- For a sample of top artists, list distinct L2 folder names
- Reveals: do they have `Albums/`, `12 inches/`, `Singles/`, `Maxi/`, etc.?
- This determines how we detect albums vs singles in Phase 3

---

## Architecture Overview

```
files table (existing)          artists table (new)
artist: "01 DJ Deep"      →    artist_key: "dj deep"
artist: "02 DJ Deep"      →    canonical_name: "DJ Deep"   (picked by frequency)
artist: "DJ Deep"         →    bio: "..."
                               image_file: "dj-deep.jpg"
```

The `artists` table is a **derived summary** — rebuilt from `files` after every scan. Admin overrides (`name_override=1`) are never overwritten by rebuild.

---

## Phase 0 Audit — Key Findings

These findings came from running the audit scripts against the live DB (134K songs, 25K distinct artist values):

### The digit-prefix problem is a TAG CORRUPTION issue, not folder parsing

- **2,205** artist tags start with digit+space (e.g. `"01 DJ Deep"`, `"02 Kim Wilde"`)
- **1,546** of those have a corresponding clean version also in the DB (e.g. `"DJ Deep"` exists alongside `"01 DJ Deep"` and `"02 DJ Deep"`) → **safe to merge**
- **659** have no clean version → they may be real artist names OR isolated corrupt tags

### Critical distinction — three categories of digit-prefix artists

| Pattern | Example | Real artist? | Action |
|---------|---------|-------------|--------|
| `NN ArtistName` where clean version EXISTS and has ≥ equal song count | `"01 DJ Deep"` (19) + `"DJ Deep"` (29) | No — tag corruption | Merge under `"DJ Deep"` |
| `NN ArtistName` where clean version EXISTS but has far fewer songs | `"2 Unlimited"` (235) + `"Unlimited"` (2) | YES — `"2 Unlimited"` is the real name | Keep `"2 Unlimited"` as canonical |
| `NN ArtistName` — no clean version exists | `"808 State"`, `"50 Cent"`, `"4 Non Blondes"` | YES — real names | Keep as-is, no stripping |

### Merge safety rule (the "ratio test")
Strip the prefix and merge ONLY when:
- A clean (no-prefix) version of the stripped name exists in the DB **AND**
- The clean version has **≥ 50%** as many songs as the prefixed version
  - → `"01 DJ Deep"` (19) vs `"DJ Deep"` (29): 29/19 = 153% → MERGE ✓
  - → `"2 Unlimited"` (235) vs `"Unlimited"` (2): 2/235 = 0.8% → KEEP original ✗

This ratio test is a **display-only grouping decision** — it never touches the `files` table artist tags. The raw tags are preserved. The `artists` table simply controls which canonical name is shown and which raw variants are grouped together.

---

## Phase 1 — Normalization Engine

**New file:** `src/util/artist-normalize.js`

### `normalizeKey(rawArtist)`
Returns a stable lowercase key used for grouping. This is ONLY used when a clean variant exists AND passes the ratio test:
1. Trim whitespace
2. If the stripped version (removing `^\d+\s+`) matches an existing artist AND passes ratio test → return stripped+lowercased key
3. Otherwise → return `rawArtist.toLowerCase().trim()` unchanged

### `buildArtistGroups(allArtistRows)`
Takes the full `[{ artist, count }]` array from DB and returns a Map of `artistKey → { canonicalName, rawVariants[] }`:

```
Algorithm:
1. For each artist row: check if it matches /^\d+\s+(.+)/
2. If yes: compute stripped = match[1].trim()
   - Look up stripped in artistMap
   - If stripped exists AND strippedCount >= prefixedCount * 0.5 → group them: key = stripped.toLowerCase()
   - Else: treat prefixed name as its own group (real artist name)
3. If no digit prefix: its own group, key = artist.toLowerCase()
4. pickCanonicalName(group.rawVariants):
   - Filter out variants matching /^\d+\s+/ (the "01 X" style)
   - From remaining: pick highest-count variant (preserving original casing)
   - If all variants have digit prefix (shouldn't happen after step 2): strip prefix from highest-count
```

### Edge cases preserved correctly
- `"2Pac"` → key `"2pac"` (digit but no space → no stripping)
- `"50 Cent"` (no clean `"Cent"` in DB) → key `"50 cent"`, canonical `"50 Cent"`
- `"808 State"` (no clean `"State"` in DB) → key `"808 state"`, canonical `"808 State"`
- `"10cc"` → key `"10cc"` (digit+letter, not digit+space)
- `"The 1975"` → key `"the 1975"` (digit not at start)
- `"2 Unlimited"` (235) vs `"Unlimited"` (2): ratio 0.8% < 50% → key `"2 unlimited"`, canonical `"2 Unlimited"` ✓
- `"01 DJ Deep"` (19) + `"DJ Deep"` (29): ratio 153% > 50% → key `"dj deep"`, canonical `"DJ Deep"` ✓

---

## Phase 2 — DB Layer

**Modify:** `src/db/sqlite-backend.js`

### New migration (appended to existing migration chain)

```sql
CREATE TABLE IF NOT EXISTS artists (
  artist_key     TEXT PRIMARY KEY,   -- normalized key (lowercase, no digit prefix)
  canonical_name TEXT NOT NULL,      -- display name
  name_override  INTEGER DEFAULT 0,  -- 1 = admin manually set, never auto-overwritten
  bio            TEXT,               -- plain text summary from Last.fm or MusicBrainz
  image_file     TEXT,               -- filename under image-cache/artists/
  image_source   TEXT,               -- 'lastfm' | 'musicbrainz' | 'custom'
  last_fetched   INTEGER             -- unix timestamp of last bio/image fetch
)
```

### New function: `rebuildArtistsTable()`
Called after every scan completion:
1. `SELECT artist, COUNT(*) AS c FROM files WHERE artist NOT NULL AND artist != '' GROUP BY artist`
2. Group rows by `normalizeKey(artist)` → collect all raw variants + total counts
3. For each group: `INSERT OR IGNORE` new artist; if not `name_override`: update `canonical_name` via `pickCanonicalName(variants)`
4. Remove orphan rows: `DELETE FROM artists WHERE artist_key NOT IN (...current keys...)`

### New function: `getArtistsForBrowse()`
Returns all artists with counts for the grid:
```sql
SELECT a.artist_key, a.canonical_name, a.image_file,
       COUNT(DISTINCT f.album) AS album_count,
       COUNT(*) AS song_count
FROM artists a
JOIN files f ON lower(trim(f.artist)) LIKE ...  -- via artist_key matching
GROUP BY a.artist_key
ORDER BY a.canonical_name COLLATE NOCASE
```
(Exact join strategy TBD after Phase 0 — may use a `file_artist_key` computed column or a separate lookup.)

### New function: `getArtistRawNames(artistKey)`
Returns all raw `artist` values that normalize to this key.

### New function: `getArtistFilepaths(artistKey)`
Returns all `filepath, vpath, album, title, track, disk, year, aaFile, cover_file` rows for all raw names of this artist.

---

## Phase 3 — API Module

**New file:** `src/api/artists-browse.js`

Registered in server startup alongside `albums-browse.js`. Uses 5-minute in-memory cache.

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/artists/browse` | user | Grid data: `{ artists[] }` — canonical\_name, image\_file, album\_count, song\_count |
| `GET` | `/api/v1/artists/profile?key=` | user | Detail: `{ artist, bio, imageFile, albums[], singles[] }` |
| `POST` | `/api/v1/artists/fetch-info` | admin | Body `{ artistKey }` — fetch Last.fm bio + image (MusicBrainz fallback) |
| `POST` | `/api/v1/artists/set-image` | admin | Body `{ artistKey, imageUrl }` — download + store custom image |
| `POST` | `/api/v1/artists/set-name` | admin | Body `{ artistKey, canonicalName }` — sets `name_override=1` |

### Image serving
Artist images stored in `image-cache/artists/`. Served via:
```js
app.use('/api/v1/artists/images/', authMiddleware, express.static(path.join(__dirname, '../image-cache/artists')));
```

### `/api/v1/artists/profile` logic — GENERIC (no hardcoded folder names)

The artist profile must work regardless of how a user organises their music library. No folder names like "Albums/", "12 inches/", "Singles/" are ever hardcoded. Instead:

1. Look up `artist_key` in `artists` table → get `canonical_name`, `bio`, `image_file`
2. Get all raw name variants via `getArtistRawNames(key)`
3. Query `files` WHERE `artist IN (variants)` — returns ALL songs for this artist across all vpaths and all folders
4. **Group by L1 folder** (first path segment of `filepath`):
   - For each song: `l1 = filepath.split('/')[0]`
   - Each distinct `l1` becomes a **release category** (e.g. a user's `"12 inches A-Z"`, `"Albums"`, `"Disco"`, `"TOP40"` etc. — whatever exists in their library)
   - Within each `l1`, group by the **release folder** (the L2 or deeper segment that forms a "release": `Album Title`, `Artist - Single Title`, etc.) using the same `buildAlbumFromEntries` logic already in `albums-browse.js`
5. Each release group becomes a `release` object: `{ title, artFile, tracks[], category (= l1 folder name) }`
6. Return `{ canonicalName, bio, imageFile, releaseCategories: [{ name, releases[] }] }`

**Why this is correct:**
- Every user's L1 folders are THEIR natural categorisation: "Albums", "12 inches", "Vinyl Rips", "Bootlegs", "Compilations" — whatever they chose
- The frontend can label each section with the L1 folder name exactly
- No configuration required — the structure emerges from the data
- If a user has no "Albums" folder at all, this still works fine

### `fetch-info` logic — Last.fm primary, MusicBrainz fallback
```
1. If lastfm.apiKey configured:
   a. Call Scribble.GetArtistInfo(canonicalName)
   b. Extract bio summary (artist.bio.summary, strip HTML)
   c. If image: download largest, run through sharp 400×400, save to image-cache/artists/{key}.jpg
   d. Update artists table: bio, image_file='...', image_source='lastfm', last_fetched=now
2. Else (no API key):
   a. Call MusicBrainz: GET https://musicbrainz.org/ws/2/artist?query={name}&fmt=json
   b. Take first result, extract disambiguation + area as minimal bio
   c. No image available via MusicBrainz directly
   d. Update artists table: bio, image_source='musicbrainz', last_fetched=now
```

---

## Phase 4 — Frontend (`webapp/app.js`)

All edits targeted — never rewrite whole sections. Edit in small hunks.

### New data store
```js
let _artLib = null;  // { artists: [], byKey: Map }
```

### New functions (added in sequence after existing artist functions)

#### `_loadArtLib()`
```js
async function _loadArtLib() {
  if (_artLib) return _artLib;
  const data = await api('GET', 'api/v1/artists/browse');
  _artLib = { artists: data.artists, byKey: new Map(data.artists.map(a => [a.artist_key, a])) };
  return _artLib;
}
```

#### `_artImgUrl(imageFile)`
Returns URL for artist image or a placeholder SVG data URI.
- If `imageFile`: `/api/v1/artists/images/${imageFile}`
- Else: inline SVG placeholder (silhouette / music note icon)

#### `viewArtistLibrary()`
Replaces `viewArtists()` as the sidenav Artists destination.
- Load `_artLib`
- Render card grid (same CSS class structure as Album Library cards)
- Each card: artist image, name, `N albums` subtitle
- Live search input (filters in-memory)
- A-Z strip (same pattern as Album Library)
- Source vpath filter pills (optional — if artists span multiple vpaths)
- Click card → `viewArtistDetail(artistKey)`

#### `viewArtistDetail(artistKey)`
- `GET /api/v1/artists/profile?key={artistKey}`
- **Header**: artist image (left), canonical name + bio summary (right), "Read more" toggle for full bio
- **Admin controls** (if `S.isAdmin`): "Fetch Info" button (calls `fetch-info`), "Set Image" button (URL input or file picker)
- **Release sections — GENERIC**: The API returns `releaseCategories` — one per distinct L1 folder the artist has songs in. Each section is rendered as a collapsible accordion with the L1 folder name as its heading:
  - e.g. user A sees: **"Albums"**, **"12 inches A-Z"**, **"Disco"**
  - user B sees: **"Vinyl Rips"**, **"CD Collection"**, **"Bootlegs"**
  - user C sees: **"Music"** (one flat library)
  - The code renders whatever categories exist — zero hardcoded folder name checks
- Within each section: release cards (art + title + track count). Click release → track list (add to queue or play). If the release matches an existing Albums Library album, clicking opens `viewAlbumDetail()` (matched by folder path).

### Navigation change
- Sidenav "Artists" link: change `onclick` from `viewArtists()` to `viewArtistLibrary()`
- Old `viewArtists()` kept in place for now (Subsonic doesn't touch it, and the tag-based browse endpoints `/api/v1/db/artists` remain)

---

## Phase 5 — Auto-fetch on scan completion

**Modify:** `src/api/scan.js` (or wherever scan completion is signalled)

After scan finishes:
1. `db.rebuildArtistsTable()` — synchronous, fast (pure DB operation)
2. If `lastfm.apiKey` configured: get list of `artist_key` WHERE `last_fetched IS NULL`
3. Process queue: one artist per second (via recursive `setTimeout`), call internal `fetch-info` logic
4. Log progress to console, do not surface to user (background task)

---

## Files Changed

| File | Action | What |
|------|--------|------|
| `src/util/artist-normalize.js` | **CREATE** | `normalizeKey()`, `pickCanonicalName()` |
| `src/api/artists-browse.js` | **CREATE** | All artist API endpoints + profile builder |
| `src/db/sqlite-backend.js` | **MODIFY** | `artists` table migration + 4 new functions |
| `webapp/app.js` | **MODIFY** | 4 new functions + sidenav wire |
| `app.js` (server root) | **MODIFY** | Register `artists-browse` module |
| `docs/-artists-design.md` | **CREATE** | This file — plan + design |
| `docs/API/artists.md` | **CREATE** | API endpoint reference |
| `docs/API.md` | **MODIFY** | Add artists section to index |

---

## Verification Checklist

1. **Phase 0**: Run 5 audit scripts — confirm numeric prefix pattern type and singles folder names
2. **Phase 1**: Unit-check: `normalizeKey("38 Pink") === "pink"`, `normalizeKey("2Pac") === "2pac"`, `normalizeKey("10cc") === "10cc"`
3. **Phase 2**: After rebuild: `SELECT * FROM artists LIMIT 20` — no numbered canonical names
4. **Phase 3**: `curl` `/api/v1/artists/browse` with JWT — valid JSON, all canonical names clean
5. **Phase 3**: `curl` `/api/v1/artists/profile?key=pink` — returns albums + singles
6. **Phase 4**: Artist Library grid renders, no numbered names visible
7. **Phase 4**: Click artist with Last.fm presence → bio + image shown
8. **Phase 4**: Click album card → `viewAlbumDetail` opens
9. **Admin**: "Fetch Info" saves bio + image, persists on page reload
10. **Admin**: "Set Name" override → never overwritten by next scan

---

## Design Decisions

- **No `albumartist` column** in DB — scanner already writes albumartist tag to `artist` column. Normalization only targets `artist`.
- **`artist_id` column** (Subsonic MD5 ID): untouched — Subsonic still uses it.
- **Old `viewArtists()` and `/api/v1/db/artists`**: kept for backward compatibility. UI replaced by new Library.
- **MusicBrainz images**: not available via their public API without fanart.tv key. Bio text only from MusicBrainz.
- **Sharp for images**: already a dependency (used in albums art set). Resize to 400×400 JPEG for consistency.
- **Cache invalidation**: in-memory artist browse cache cleared on `rebuildArtistsTable()` call.
- **`name_override`**: once an admin sets a canonical name manually, automatic scans never touch it again.

---

## Open Items

- [x] Numeric prefix regex confirmed: `^\d+\s+` captures all corrupt cases. Digit+letter (no space) like `"2Pac"`, `"10cc"` correctly excluded.
- [x] Singles folder naming: **generic — no hardcoded folder names**. All L1 folder names are user-defined. Profile API returns `releaseCategories` keyed by L1 folder name.
- [x] Source of numbered prefixes: **ID3 tag corruption** — the `artist` tag contains `"01 DJ Deep"` etc. Folder names are not the cause.
- [ ] Decide if a `file_artist_key` computed column is needed in `files` for efficient joins, or if a JOIN on normalised key logic is fast enough. With 134K rows an in-memory grouping at rebuild time is fine; at query time a full-scan with `artist IN (variants)` on an indexed column is acceptable.
