# Subsonic / OpenSubsonic Compliance Plan — `subsonic-extend` branch

> **Review this before any code is written.**
> After approval, create branch `subsonic-extend` off master and implement in the order below.

---

## Current state summary

All 1543 lines of `src/api/subsonic.js` were audited against the full OpenSubsonic endpoint list.

| Status | Count |
|---|---|
| Fully implemented | ~25 endpoints |
| Stub (returns empty/ok, but REAL data available) | 9 areas |
| Completely missing (no route) | 6 routes |
| Intentionally skipped (out of scope) | ~10 endpoints |

---

## Tier 1 — Easy wins: stubs that have real data (all in `subsonic.js`)

These are already registered and returning empty/stub responses. Wiring real data is 10–30 min each.

---

### 1. `getInternetRadioStations` — real radio station list

**Current:** returns `{ internetRadioStations: {} }` always.

**Fix:** call `db.getRadioStations(req.subsonicUser)` and map each row to the Subsonic `InternetRadioStation` shape:

```js
{
  id:          String(station.id),
  name:        station.name,
  streamUrl:   station.link_a,           // primary stream URL
  homePageUrl: station.link_b || ''      // secondary as "home page"
}
```

Multiple links (`link_b`, `link_c`) have no Subsonic equivalent — expose `link_a` only as `streamUrl`.

**Effort:** ~15 min.

---

### 2. `getScanStatus` — real scanning state

**Current:** always returns `{ scanning: false, count: 0 }`.

**Fix:** import `dbQueue` and expose real state:

```js
import * as dbQueue from '../db/task-queue.js';
// ...
const scanning = dbQueue.isScanning();
const count    = scanning ? (dbQueue.getAdminStats()?.filesScanned || 0) : 0;
```

**Effort:** ~15 min.

---

### 3. `startScan` — trigger rescan (currently MISSING route)

**Current:** falls through to the catch-all 404 handler.

**Fix:** register the route (admin-only) and call `dbQueue.scanAll()`:

```js
router('startScan', (req, res) => {
  const isAdmin = config.program.users[req.subsonicUser]?.admin === true
    || Object.keys(config.program.users).length === 0;
  if (!isAdmin) return sendResponse(req, res, makeError(ERRORS.UNAUTH.code, ERRORS.UNAUTH.message));
  dbQueue.scanAll();
  sendResponse(req, res, makeResponse('ok', { scanStatus: { scanning: true, count: 0 } }));
});
```

**Effort:** ~10 min.

---

### 4. `getTopSongs` — real most-played songs for an artist

**Current:** returns `{ topSongs: { song: [] } }` always.

**Fix:** we have `user_metadata.pc` (play count). Add a DB helper `getTopSongsByArtist(artistName, vpaths, user, limit)` that joins `files` + `user_metadata` ordered by `pc DESC`.

```sql
SELECT f.*, um.pc AS playCount
FROM files f
LEFT JOIN user_metadata um ON um.hash = f.hash AND um.user = ?
WHERE f.artist_id = ?
  AND f.vpath IN (...)
ORDER BY COALESCE(um.pc, 0) DESC
LIMIT ?
```

Return mapped as `buildSong()` array.

**Effort:** ~45 min (new DB helper + route update).

---

### 5. `getArtistInfo` / `getArtistInfo2` — return cached artist images

**Current:** returns `{ artistInfo: { biography: '' } }`.

**Fix:** we have `artists_normalized.image_file` (populated by the Artist Workshop). Look up the artist by ID, build a cover-art URL for the image. Biography remains empty (no Last.fm call — too slow/complex for now).

```js
const row = db.getArtistById(id);  // need this helper or query
const imageUrl = row?.image_file
  ? `${req.protocol}://${req.hostname}:${port}/image-cache/artists/${row.image_file}`
  : undefined;
return { artistInfo: { biography: '', ...(imageUrl ? { largeImageUrl: imageUrl, mediumImageUrl: imageUrl, smallImageUrl: imageUrl } : {}) } };
```

**Note:** the Subsonic protocol expects `largeImageUrl` as a URL string, not a song ID. Clients like Symfonium will download it directly. We need to make sure `image-cache/artists/` is statically served.

**Effort:** ~30 min.

---

### 6. `getSimilarSongs` / `getSimilarSongs2` — real similar songs via Last.fm

**Current:** returns empty `{ similarSongs: { song: [] } }`.

**Fix:** we already use Last.fm similar-artists in Auto-DJ (`src/api/lastfm.js` or similar). Reuse that path:

1. Look up the song/artist by the provided `id`
2. Call Last.fm `artist.getSimilar` (same API we use in Auto-DJ)
3. For each similar artist returned, query the DB for songs by that artist
4. Return up to `count` (default 50) songs as `buildSong()` array

**Caveat:** requires Last.fm API key configured. If not configured, gracefully fall back to empty list.

**Effort:** ~1 hour.

---

### 7. `buildSong` — expose bitDepth, samplingRate, channelCount

**Current:** `buildSong()` does not include audio technical fields.

**Fix:** we store `bitrate`, `bit_depth`, `sample_rate`, `channels` in the `files` table. Add to `buildSong()`:

```js
...(row.sample_rate ? { samplingRate: row.sample_rate } : {}),
...(row.channels    ? { channelCount: row.channels }    : {}),
...(row.bit_depth   ? { bitDepth: row.bit_depth }       : {}),
```

These are standard OpenSubsonic fields. Clients (Symfonium, Feishin) display them in track details.

**Effort:** ~10 min.

---

## Tier 2 — New DB tables needed (moderate work)

### 8. `createBookmark` / `getBookmarks` / `deleteBookmark` — real bookmark persistence

**Current:** all three return `ok` immediately with no persistence.

**Data model:** new table `subsonic_bookmarks`:

```sql
CREATE TABLE IF NOT EXISTS subsonic_bookmarks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user       TEXT NOT NULL,
  hash       TEXT NOT NULL,          -- song ID (matches files.hash)
  position   INTEGER NOT NULL,       -- ms
  comment    TEXT DEFAULT '',
  created_ts INTEGER NOT NULL,       -- epoch seconds
  changed_ts INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sb_user_hash ON subsonic_bookmarks(user, hash);
```

`createBookmark`: upsert by `(user, hash)` — update `position`, `comment`, `changed_ts`.
`getBookmarks`: SELECT all for user, join to `files` to build full `entry` song objects.
`deleteBookmark`: DELETE by `(user, hash)`.

**Spec note:** `getBookmarks` response shape:
```json
{
  "bookmarks": {
    "bookmark": [
      { "position": 12000, "username": "user", "comment": "...", "created": "...", "changed": "...", "entry": { ...song... } }
    ]
  }
}
```

**Effort:** ~1.5 hours.

---

### 9. `savePlayQueue` / `getPlayQueue` — cross-device play queue sync

**Current:** not registered — falls through to 404.

**Data model:** new table `subsonic_play_queue`:

```sql
CREATE TABLE IF NOT EXISTS subsonic_play_queue (
  user        TEXT PRIMARY KEY,
  entry_ids   TEXT NOT NULL DEFAULT '[]',  -- JSON array of hashes
  current_id  TEXT,                         -- hash of current song
  position_ms INTEGER DEFAULT 0,
  changed_ts  INTEGER NOT NULL,
  changed_by  TEXT NOT NULL DEFAULT ''
);
```

`savePlayQueue`: upsert (one row per user). `id` params = array of song hashes (Subsonic IDs = our hashes).
`getPlayQueue`: SELECT row, expand `entry_ids` by joining each hash against `files` to build full `entry` song objects.

**Spec note (OpenSubsonic errata):** send without `id` params to clear the queue. `current` is optional if no IDs given.

**Effort:** ~2 hours.

---

## Tier 3 — Missing routes (trivial to add)

### 10. `search` (original Subsonic v1.9)

**Current:** not registered.

**Fix:** register `search` as an alias for the same handler as `search2`/`search3` — or just wire it to the same `handleSearch` function. The original `search` endpoint uses `any`, `count`, `offset` params (single search query across all types). Very few clients still use it.

**Effort:** ~20 min.

---

### 11. `reportPlayback` (OpenSubsonic extension)

**Current:** not registered.

**Spec:** `POST /rest/reportPlayback` — replaces `scrobble` for OpenSubsonic clients. Parameters: `id`, `time` (position ms), `submission` (bool — true=scrobble, false=now-playing).

**Fix:** wire to our existing `_processScrobble` / `_submitNowPlaying` logic already in `scrobble`. When `submission=true`, scrobble. When `submission=false`, update `nowPlayingStore`. Add `reportPlayback` to `getOpenSubsonicExtensions`.

**Effort:** ~30 min.

---

### 12. `getAvatar`

**Current:** returns 404 error via catch-all.

**Fix:** return a simple generated SVG avatar (initials from username, coloured circle). No user-uploaded avatar storage needed.

**Effort:** ~15 min.

---

## Tier 4 — Improvements to existing partial implementations

### 13. `scrobble` — also update play count in our DB

**Current:** routes to Last.fm / ListenBrainz scrobblers, but does NOT increment `user_metadata.pc` (play count) in our own DB.

**Fix:** after dispatching to Last.fm/LB, also call the existing play-count-increment helper (same one the native player uses).

**Effort:** ~15 min.

---

### 14. `getAlbumList` / `getAlbumList2` — fix `alphabeticalByArtist`, `alphabeticalByName`

**Current:** these two types fall through to `_fetchAlbumListRows` which returns `[]` for unknown types.

**Fix:** add cases in `_fetchAlbumListRows`:
- `alphabeticalByName`: `db.getAllAlbumIds(..., { sortBy: 'album' })`
- `alphabeticalByArtist`: `db.getAllAlbumIds(..., { sortBy: 'artist' })`

We already support sorting in `getAllAlbumIds` — just need to pass it through.

**Effort:** ~20 min.

---

### 15. `getLyricsBySongId` — return real embedded lyrics if available

**Current:** always returns `{ lyricsList: { structuredLyrics: [] } }`.

**Note:** the `files` table has NO `lyrics` column currently. Embedded lyrics would need to be extracted on demand from the audio file using `music-metadata` (`common.lyrics[]`). This is a read operation — no DB write needed — but adds per-request I/O.

**Decision:** implement as an on-demand read (cache in memory for 60s keyed by hash). Return unsynced lyrics if found.

**Effort:** ~45 min. **Mark as optional for v1 — skip if not worth the I/O.**

---

## What we intentionally skip

| Endpoint | Reason |
|---|---|
| `getChatMessages` / `addChatMessage` | Chat system not in scope |
| `getShares` / `createShare` / `updateShare` / `deleteShare` | Public sharing not in scope |
| `getTranscodeDecision` / `getTranscodeStream` | Complex transcode decision matrix; not needed |
| `hls` | HLS streaming not implemented |
| `jukeboxControl` | Server-side audio playback not in scope |
| `tokenInfo` | API key management, out of scope |
| `createUser` / `updateUser` / `deleteUser` | Admin-only actions already stub-accepted; full implementation requires Velvet admin config rewrite |
| `getVideoInfo` / `getVideos` | No video support |
| CUE virtual tracks in Subsonic | ✅ **Implemented** — `getAlbum` expands single-FLAC CUE albums into virtual tracks (`cue:<hash>:<index>`); `stream` slices audio with ffmpeg `-ss`/`-t` |

---

## Implementation order

```
Phase 1 (quick wins, all in subsonic.js):
  1. buildSong: add bitDepth, samplingRate, channelCount          [10 min]
  2. getInternetRadioStations: real station list                  [15 min]
  3. startScan: new route, call dbQueue.scanAll()                 [10 min]
  4. getScanStatus: wire dbQueue.isScanning()                     [15 min]
  5. getAlbumList: fix alphabeticalByName, alphabeticalByArtist   [20 min]
  6. scrobble: also increment DB play count                       [15 min]
  7. reportPlayback: new route, reuse scrobble logic              [30 min]
  8. getAvatar: SVG initials response                             [15 min]
  9. search (v1.9): alias to search2 handler                      [20 min]
  10. getArtistInfo/2: return cached artist image                  [30 min]
  11. getTopSongs: most-played songs per artist                    [45 min]
  12. getSimilarSongs/2: via Last.fm similar-artists               [60 min]

Phase 2 (new DB tables):
  13. createBookmark / getBookmarks / deleteBookmark               [90 min]
  14. savePlayQueue / getPlayQueue                                  [2 hours]

Phase 3 (optional):
  15. getLyricsBySongId: on-demand music-metadata read             [45 min]
```

**Total estimate:** Phase 1 ≈ 4 hours · Phase 2 ≈ 3.5 hours · Phase 3 ≈ 45 min.

---

## Branch name

`subsonic-extend` — off `master` at v7.2.0-velvet.

---

## Files to modify

- `src/api/subsonic.js` — all route changes (Phases 1, 2, 3)
- `src/db/sqlite-backend.js` — new DB helpers for `getTopSongsByArtist`, bookmarks, play queue tables + queries
- `docs/subsonic.md` — update compliance table after implementation
- `changes-fork-velvet.md` — add v7.3.0 entry

---

## Notes / risks

1. **`getInternetRadioStations`** is user-scoped in our DB (per-user station list). Subsonic assumes a global station list. We expose the requesting user's stations — this is fine for single-user setups and reasonable for multi-user.

2. **`startScan`** should be admin-only. Our check matches the existing `createUser`/`updateUser` gate pattern.

3. **`savePlayQueue`** — the IDs we use are MD5 hashes (32 hex chars). Subsonic clients send them back in `id` params — we must accept them as-is. This is already how `stream`, `star`, `setRating` etc. work, so no change needed.

4. **`getSimilarSongs`** — if Last.fm API key is not configured, return empty list with no error. Do not return error code 0.

5. **`buildSong` technical fields** — `bitrate` in our DB is stored as the raw value from `music-metadata` (bits/s or kbps depending on source). Verify the unit and normalise to kbps before adding to response.
