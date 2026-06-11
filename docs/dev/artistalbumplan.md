# Artist vs Album Artist — Analysis & Implementation Plan (v2)

> Refined: player queue clarified · scope locked to albumsOnly=true · MusicBrainz API confirmed · Subsonic extension mapped.  
> Rescan is acceptable and included where it adds value.

---

## 1. The rule — one sentence

`ARTIST` (TPE1) = who performs **this track** · `ALBUMARTIST` (TPE2) = who owns **this album**

Use `ARTIST` where track-level identity matters (queue, song rows, per-track credits).  
Use `ALBUMARTIST` as **fallback** when `ARTIST` is blank, and as the **attribution label** on album cards.  
Enhanced attribution is only meaningful in the **albumsOnly = true** context. Recordings and YouTube vpaths don't need this.

---

## 2. Current state — what is fine, what is broken

### Already correct (do not change)

| Where | Behaviour |
|-------|-----------|
| Artists browse / artist profiles | Uses `COALESCE(album_artist, artist)` throughout |
| Artist rebuild worker | Groups by `COALESCE(album_artist, artist)` |
| ReplayGain album grouping | Uses `album_artist OR artist` for album batching |
| Album song queries | Uses `COALESCE(album_artist, artist)` for lookup |
| Scanner reads ALBUMARTIST tag | `music-metadata` exposes `common.albumartist`; scanner stores it in `files.album_artist` |
| DB column exists | `files.album_artist` added via migration — present on all live instances |

### Gaps to fix

| # | Where | Problem |
|---|-------|---------|
| A | `renderMetadataObj` (db.js) | Returns `row.artist` only. CUE-ripped track with `artist=NULL, album_artist="Donna Summer"` → queue/player bar shows **blank artist**. That is the confusion. |
| B | `albums-browse.js` per-track artist | Returns `e.row.artist || null` — same blank-artist problem for CUE albums. |
| C | Tag Workshop / MusicBrainz | `_buildFinalTags()` does not include `album_artist`. After tagging, the ALBUMARTIST tag is **never written** to the file. The MB worker fetches recording-level artist but NOT the release-level artist. |
| D | Subsonic API (`buildSong`, `buildAlbum`) | `albumArtist` field absent from responses. Subsonic clients (DSub, Symfonium, Sonixd, Feishin) use `albumArtist` for album grouping and display. |
| E | FTS search | `fts_files` indexes only `artist`, not `album_artist`. Tracks with `artist=NULL` are invisible to search. |

---

## 3. Player queue — the right answer

Your challenge to my first draft ("why not in player queue?") is correct.

The answer is **fallback, not override**:

```
display_artist = COALESCE(artist, album_artist)   ← track artist first; album artist only when track artist is blank
```

Examples:
- `artist="Donna Summer feat. Brooklyn Dreams"` → queue shows **"Donna Summer feat. Brooklyn Dreams"** ✓
- CUE track: `artist=NULL, album_artist="Donna Summer"` → queue shows **"Donna Summer"** ✓ (currently blank — this is the bug)
- VA compilation: `artist="Wham!", album_artist="Various Artists"` → queue shows **"Wham!"** ✓

**album_artist is the safety net, not the primary field.**

Fix — one line in `renderMetadataObj()` in `src/api/db.js`:
```js
// Before:
"artist": row.artist ? row.artist : null,
// After:
"artist": row.artist || row.album_artist || null,
```

No albumsOnly gate needed for the fallback itself. A blank artist in the queue is wrong in any context.

Also expose the raw field for card-level use:
```js
"album-artist": row.album_artist || null,
```

---

## 4. albumsOnly scope — what it means in practice

The **enhanced display** (album card attribution, Subsonic `albumArtist`, explicit `album-artist` field) only makes sense where `albumsOnly: true`. Why:

- `albumsOnly` vpaths = curated album collection → ALBUMARTIST is meaningful and present in tags
- `recordings` vpath = mic recordings → no ALBUMARTIST tag, irrelevant
- `youtube` vpath = downloaded tracks → no ALBUMARTIST tag, irrelevant

In practice **albums-browse.js is inherently albumsOnly-only** — so all display code in that file is automatically scoped correctly.

For Subsonic: gate `albumArtist` on whether the song's vpath is albumsOnly (§7 below).  
For `renderMetadataObj`: the fallback fires universally but is harmless — it only triggers when `artist` is NULL, which in a Recordings/YouTube vpath would simply stay NULL anyway.

---

## 5. MusicBrainz — what the API provides and how to use it

### Two levels of artist-credit in the MB response

When the enrichment worker looks up a recording with `inc=releases+artist-credits`, the response contains **two separate** artist-credit arrays:

```
apiData['artist-credit']          ← RECORDING artist (track artist)   e.g. "Donna Summer"
best['artist-credit']             ← RELEASE artist (album artist)      e.g. "Donna Summer" or "Various Artists"
```

(`best` = the selected Release object from `apiData.releases`, already computed in the worker.)

For joint-credit releases:
```json
"artist-credit": [
  { "artist": { "name": "Giorgio Moroder" }, "joinphrase": " & " },
  { "artist": { "name": "Donna Summer" } }
]
```
→ build string: `credits.map(c => (c.name || c.artist?.name || '') + (c.joinphrase || '')).join('')`
→ result: `"Giorgio Moroder & Donna Summer"`

### Current code (`src/util/mb-enrich-worker.mjs` line 208)

```js
const mbArtist = apiData['artist-credit']?.[0]?.artist?.name ?? null;   // recording artist — already used
// best['artist-credit'] is NEVER read — this is the gap
```

### Fix — extract release artist

Add after line 208:
```js
const mbAlbumArtist = best['artist-credit']
  ?.map(c => (c.name || c.artist?.name || '') + (c.joinphrase || ''))
  .join('').trim() || null;
```

Add to `mbData` object:
```js
mb_album_artist: mbAlbumArtist,
```

**No new API call needed.** The release `artist-credit` is already in the payload the worker fetches.

### DB migration needed

```js
// sqlite-backend.js migrations block:
try { db.exec('ALTER TABLE files ADD COLUMN mb_album_artist TEXT'); } catch { /* noop */ }
```

### Tag Workshop: write ALBUMARTIST to file

`_buildFinalTags()` in `src/api/tagworkshop.js`:
```js
return {
  title:        t.mb_title        ?? t.title,
  artist:       t.mb_artist       ?? t.artist,
  album_artist: t.mb_album_artist ?? t.album_artist ?? null,   // ← new
  album:        t.mb_album        ?? t.album,
  year:         t.mb_year         ?? t.year,
  track:        t.mb_track        ?? t.track,
};
```

`writeTagsToFile()` in `src/api/tagworkshop.js`:
```js
if (tags.album_artist != null) args.push('-metadata', `album_artist=${tags.album_artist}`);
```
(ffmpeg uses the key `album_artist` for ALBUMARTIST/TPE2 across all formats — MP3, FLAC, OGG, M4A.)

`db.updateFileTags()` in `src/db/sqlite-backend.js`:
Add `album_artist` to the UPDATE SET list and bind parameter.

**Effect:** After Tag Workshop accepts an album, ALBUMARTIST is written to every file in the release. The `album_artist` column in the DB is updated immediately — no rescan needed for those files.

---

## 6. Rescan — when it helps

| Scenario | Action |
|----------|--------|
| Files already have ALBUMARTIST tags but were scanned before the migration ran | Full rescan — scanner will populate `album_artist` from existing file tags |
| Files Tag Workshop accepted before this feature exists | Re-accept them (or "batch tag all") after the fix; `updateFileTags` updates DB directly |
| Files scanned after the migration existed | Nothing to do — column already populated |

**Practical approach:** after deploying the fixes, run a targeted re-scan limited to files where `album_artist IS NULL` and the file actually has an ALBUMARTIST tag on disk. This is less work than a full rescan. Alternatively: just let the Tag Workshop handle it — the next time an album is processed, the correct `mb_album_artist` is written.

---

## 7. Subsonic API — what to add

### `albumArtist` on Song element (Subsonic 1.16.1 / OpenSubsonic)

The Subsonic spec defines `albumArtist` as an optional attribute on `Child`. Clients like DSub, Symfonium, Sonixd, and Feishin use it for album grouping, "Albums by this artist" lookups, and display.

In `buildSong()` (`src/api/subsonic.js`), add:
```js
const albumArtist = row.album_artist?.trim() || null;
// Only include when set AND different from track artist (avoids sending redundant data)
...(albumArtist && albumArtist !== artist ? { albumArtist } : {}),
```

### Album `artist` field should be the album artist

In `buildAlbum()`, the `artist` field is the **album-level** attribution. Currently it uses `albumRow.artist` (track artist from first track). Fix:
```js
const artist = (albumRow.album_artist || albumRow.artist)?.trim() || null;
```

In the `getAlbum` handler, populate `album_artist` in the `albumRow` object:
```js
const albumRow = {
  album_id:     id,
  album:        first.album,
  artist:       first.artist,
  album_artist: first.album_artist,   // ← new: pass through so buildAlbum can use it
  artist_id:    first.artist_id,
  aaFile:       first.aaFile,
  year:         first.year,
  songCount:    songs.length
};
```

Verify that `db.getFilesByAlbumId()` SELECTs `album_artist` — add it to the query if not already present.

### Declare OpenSubsonic extension

Add to `getOpenSubsonicExtensions`:
```js
{ name: 'albumArtist', versions: [1] }
```

This signals to OpenSubsonic-aware clients that `albumArtist` and (optionally) `albumArtistId` are present.

---

## 8. albums-browse.js — per-track artist fallback

In `src/api/albums-browse.js` line 269:
```js
// Before:
artist: e.row.artist || null,
// After:
artist: e.row.artist || e.row.album_artist || null,
```

Also verify that `getFilesForAlbumsBrowse()` in `src/db/sqlite-backend.js` includes `f.album_artist` in the SELECT — add it if not already present.

---

## 9. FTS search — album_artist indexing

The `fts_files` virtual table currently indexes: `title, artist, album, album_version, filepath`.

**Option A — add `album_artist` to fts_files:**
External-content FTS tables cannot be ALTER'd — it requires drop+recreate+rebuild. The rebuild is automatic (one-time cost on first startup after the change). The downside: a search for "Various Artists" would match every track in every compilation. Mitigate by ensuring search results de-duplicate at album level (already partially done).

**Option B — separate fallback query:**
When the main FTS search returns no artist matches, run a secondary `LIKE` query on `album_artist`. More surgical, no FTS rebuild needed.

**Recommendation:** Option A — add `album_artist` to fts_files. The "Various Artists" noise is manageable because search UI de-duplicates results. The real benefit is that tracks with `artist=NULL` (CUE albums, some classical) become searchable by their album artist name.

---

## 10. Full implementation map — ordered by priority

| # | File(s) | Change | Impact | Effort |
|---|---------|--------|--------|--------|
| 1 | `src/api/db.js` | `renderMetadataObj`: `artist = row.artist \|\| row.album_artist \|\| null` + add `"album-artist": row.album_artist \|\| null` | Queue no longer shows blank for CUE albums; client gets explicit album-artist field | 2 lines |
| 2 | `src/api/albums-browse.js` + `src/db/sqlite-backend.js` | Per-track artist fallback; add `album_artist` to SELECT in `getFilesForAlbumsBrowse` | Album page never shows blank artist for CUE tracks | 3 lines |
| 3 | `src/db/sqlite-backend.js` | Migration: `mb_album_artist TEXT` column | Stores MB release artist | 1 line |
| 4 | `src/util/mb-enrich-worker.mjs` | Extract `best['artist-credit']` as `mbAlbumArtist`, store in DB | MB enrichment captures album-level artist | ~5 lines |
| 5 | `src/api/tagworkshop.js` | `_buildFinalTags` adds `album_artist`; `writeTagsToFile` writes `-metadata album_artist=` | Tag Workshop writes ALBUMARTIST to files | ~5 lines |
| 6 | `src/db/sqlite-backend.js` `updateFileTags()` | Include `album_artist` in UPDATE | DB stays in sync after tag writes | ~3 lines |
| 7 | `src/api/subsonic.js` | `buildSong` adds `albumArtist`; `buildAlbum`/`getAlbum` uses effective artist; declare extension | Subsonic clients show correct album artist | ~15 lines |
| 8 | `src/db/sqlite-backend.js` FTS | Add `album_artist` to `fts_files`; trigger rebuild | Tracks with `artist=NULL` become searchable | Medium — drop+recreate FTS table |

---

## 11. What does NOT need changing

- **Artists browse**: already correct with `COALESCE(album_artist, artist)` throughout
- **Artist rebuild worker**: correct
- **ReplayGain grouping**: correct
- **Album grid card artist label in albums-browse**: comes from **folder path structure** for albumsOnly content, not from tags — intentional and correct
- **Tag display in recently-added view**: the `album-artist` field added to `renderMetadataObj` (item 1 above) is available; the client can decide when to show it on album cards in that view
