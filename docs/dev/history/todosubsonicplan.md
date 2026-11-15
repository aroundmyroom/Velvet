# Subsonic / OpenSubsonic Compliance Plan — `subsonic-extend` branch

> **Status: done.** Every item in Tiers 1–4 below is now in `src/api/subsonic.js`
> (2,799 lines today). Each item has a **Built:** line that says how it was done, since
> several differ from the plan. The branch / version notes at the end are history.
> The user-facing compliance list is [`docs/subsonic.md`](../../subsonic.md).

---

## Current state summary (at planning time)

All 1543 lines of `src/api/subsonic.js` were audited against the full OpenSubsonic endpoint list.

| Status | Count |
|---|---|
| Fully implemented | ~25 endpoints |
| Stub (returns empty/ok, but REAL data available) | 9 areas |
| Completely missing (no route) | 6 routes |
| Intentionally skipped (out of scope) | ~10 endpoints |

Routes are registered with `router(action, handler)`, which adds `velvet.all('/rest/<action>')`
and `/rest/<action>.view` behind `subsonicAuth`.

---

## Tier 1 — Easy wins: stubs that have real data (all in `subsonic.js`)

---

### 1. `getInternetRadioStations` — real radio station list

**Plan:** call `db.getRadioStations(req.subsonicUser)` and map `link_a` → `streamUrl`,
`link_b` → `homePageUrl`.

**Built:** `_buildRadioStation()` does this; stations without `link_a` are left out;
`coverArt` is set from `img` when it is a local file. Also built:
`createInternetRadioStation`, `updateInternetRadioStation`, `deleteInternetRadioStation`.

---

### 2. `getScanStatus` — real scanning state

**Plan:** `dbQueue.isScanning()` plus a file count.

**Built:** `scanning = dbQueue.isScanning()`; `count` = sum of `scanned` over
`scanProgress.getAll()`.

---

### 3. `startScan` — trigger rescan

**Built** as planned: admin-only (or no users configured), calls `dbQueue.scanAll()`,
replies `scanStatus: { scanning: true, count: 0 }`. Non-admins get error 50.

---

### 4. `getTopSongs` — real most-played songs for an artist

**Plan:** new helper `getTopSongsByArtist()` ordered by `user_metadata.pc`.

**Built differently:** `db.getArtistSongsWithPlays(artist, vpaths, user)` gives the
user's play counts, blended with Last.fm top tracks (`scrobblerApi.artistTopTracks()`,
when an API key is set) by `rankTopSongs()` in `src/util/top-songs.js`. Param `artist`
is required; `count` default 50, max 200.

---

### 5. `getArtistInfo` / `getArtistInfo2` — artist image and bio

**Plan:** image URL under `/image-cache/artists/`, empty biography.

**Built differently:** `_artistInfo()` returns the stored biography (`profile.bio`,
from Last.fm / TheAudioDB enrichment), the MusicBrainz id, and image URLs that point to
`/rest/getCoverArt?id=ar-<artist_id>` (`_buildArtistInfoImageUrl()`), not to a static
image-cache path. `getAlbumInfo` / `getAlbumInfo2` still return empty `notes`.

---

### 6. `getSimilarSongs` / `getSimilarSongs2` — real similar songs

**Plan:** Last.fm `artist.getSimilar`, then songs by those artists.

**Built differently:** a radio chain from Velvet's Auto-DJ (`radioForUser()` in
`src/autodj/`), seeded by the song, or the first song of the album or artist that `id`
names. If the chain finds nothing, it falls back to Last.fm `track.getSimilar`
(`Scrobbler.GetSimilarSongs`), matched to the library. No API key → empty list, no error.
`count` default 50, max 100.

---

### 7. `buildSong` — expose bitDepth, samplingRate, channelCount

**Built:** `samplingRate`, `bitDepth`, `channelCount` are added when the DB has a
positive value. `bitRate` is the scanned value (the scanner stores kbps:
`Math.round(fmt.bitrate / 1000)`), or a per-format estimate when unknown.

---

## Tier 2 — New DB tables needed (moderate work)

### 8. Bookmarks — real bookmark persistence

**Plan:** table `subsonic_bookmarks`; routes `createBookmark` / `getBookmarks` / `deleteBookmark`.

**Built differently:**
- Table is `bookmarks (username, song_id, position, comment, created, changed)`,
  primary key `(username, song_id)`.
- Routes: `getBookmarks`, **`saveBookmark`**, `deleteBookmark`. The standard Subsonic
  name `createBookmark` is **not registered**, so clients that call `createBookmark`
  get the catch-all reply (error 70, "Subsonic method not found").
- `getBookmarks` returns the shape below, with `created` / `changed` as ISO strings.

```json
{
  "bookmarks": {
    "bookmark": [
      { "position": 12000, "username": "user", "comment": "...", "created": "...", "changed": "...", "entry": { ...song... } }
    ]
  }
}
```

---

### 9. `savePlayQueue` / `getPlayQueue` — cross-device play queue sync

**Plan:** table `subsonic_play_queue`.

**Built differently:** table is
`play_queues (username PK, current_id, position_ms, changed, changed_by, song_ids)`.
`savePlayQueue` reads `id`, `current`, `position`, `c` with `arrayParam()` / `qparam()`
so queues over 1,000 tracks work, and stores ids in the current `<hash>@<rowid>` form.
`getPlayQueue` with no saved queue returns
`playQueue: { username, current: '', position: 0 }`.

---

## Tier 3 — Missing routes

### 10. `search` (original Subsonic v1.9)

**Built:** `search` reads `any`, `count` (default 20, max 500), `offset`, and uses the
same search helpers as `search2`; artist and album counts are fixed at 20. Reply key is
`searchResult`.

---

### 11. `reportPlayback` (OpenSubsonic extension)

**Plan:** params `id`, `time`, `submission`.

**Built differently:** params `mediaId` (or `id`), `positionMs`, `state`,
`ignoreScrobble`, `c`. States `starting` / `started` / `playing` / `paused` update now
playing. `stopped` scrobbles when at least half the track (max 4 min) was heard;
`completed` always scrobbles. The `playbackReport` extension is **not advertised** in
`getOpenSubsonicExtensions` (on purpose: some clients then send `ignoreScrobble=true`).

---

### 12. `getAvatar`

**Plan:** generated SVG initials.

**Built differently:** the route exists but always returns HTTP 404 (no avatars).

---

## Tier 4 — Improvements to existing partial implementations

### 13. `scrobble` — also update play count in our DB

**Built:** `_processScrobble()` adds 1 to `user_metadata.pc`, sets `lp`, and inserts a
`play_events` row with `source: 'subsonic'`, then forwards to Last.fm / ListenBrainz
when the user has `subsonic-scrobble-lastfm` / `subsonic-scrobble-lb` set.
`submission=false` only updates now playing.

---

### 14. `getAlbumList` / `getAlbumList2` — `alphabeticalByArtist`, `alphabeticalByName`

**Built:** handled in `handleAlbumList` with `db.getAllAlbumIds(vp, { orderBy: 'artist' | 'album', limit, offset })`.

---

### 15. `getLyricsBySongId` — real lyrics

**Plan:** on-demand `music-metadata` read, 60 s memory cache.

**Built differently:** `_rowLyrics()` tries a sidecar `.lrc` file, then lyrics in the
file's tags, then Velvet's lrclib cache, synced lyrics first. `getLyrics` (artist +
title) uses the same helper. The `songLyrics` extension is advertised.

---

## What we intentionally skip

| Endpoint | Status today |
|---|---|
| `getChatMessages` / `addChatMessage` | Not registered (out of scope) |
| `getShares` / `createShare` / `updateShare` / `deleteShare` | Not registered (out of scope) |
| `getTranscodeDecision` / `getTranscodeStream` | **Built** after all; the `transcoding` extension is not advertised |
| `hls` | Not registered |
| `jukeboxControl` | Not registered |
| `tokenInfo` | **Built**: returns `{ username, authMethod }`; `apiKeyAuth` is advertised |
| `createUser` / `updateUser` / `deleteUser` | Registered, always return error 50 ("use the Velvet admin panel") |
| `getVideoInfo` / `getVideos` | Not registered |
| CUE virtual tracks in Subsonic | **Built** — `getAlbum` expands single-FLAC CUE albums into virtual tracks (`cue:<hash>[@<rowid>]:<index>`); `stream` slices audio with ffmpeg `-ss`/`-t` |

Also built and not in this plan: `getPodcasts` / `getNewestPodcasts` (always empty),
`changePassword` (own password, or any if admin).

---

## Implementation order (as planned — all done)

```
Phase 1 (quick wins, all in subsonic.js):
  1. buildSong: add bitDepth, samplingRate, channelCount          [done]
  2. getInternetRadioStations: real station list                  [done]
  3. startScan: new route, call dbQueue.scanAll()                 [done]
  4. getScanStatus: wire dbQueue.isScanning()                     [done]
  5. getAlbumList: fix alphabeticalByName, alphabeticalByArtist   [done]
  6. scrobble: also increment DB play count                       [done]
  7. reportPlayback: new route, reuse scrobble logic              [done]
  8. getAvatar: SVG initials response                             [route exists, returns 404]
  9. search (v1.9): alias to search2 handler                      [done]
  10. getArtistInfo/2: return cached artist image                  [done, + bio]
  11. getTopSongs: most-played songs per artist                    [done, + Last.fm blend]
  12. getSimilarSongs/2: via Last.fm similar-artists               [done, Auto-DJ radio first]

Phase 2 (new DB tables):
  13. saveBookmark / getBookmarks / deleteBookmark                 [done; createBookmark missing]
  14. savePlayQueue / getPlayQueue                                  [done]

Phase 3 (optional):
  15. getLyricsBySongId                                            [done]
```

---

## Branch name

`subsonic-extend` — off `master` at v7.2.0-velvet (history: the repo was later
re-initialised at v0.0.1 and uses plain `X.Y.Z` versions on `main`).

---

## Files touched

- `src/api/subsonic.js` — all route changes
- `src/db/sqlite-backend.js` — `bookmarks` and `play_queues` tables + queries, `getArtistSongsWithPlays()`
- `src/util/top-songs.js` — `rankTopSongs()`
- `docs/subsonic.md` — compliance table

---

## Notes / risks

1. **`getInternetRadioStations`** is user-scoped in our DB (per-user station list). Subsonic assumes a global station list. We expose the requesting user's stations.

2. **`startScan`** is admin-only (or open when no users are configured).

3. **Song ids** — clients get `<hash>@<rowid>` ids (or `cue:…` for CUE tracks). `decodeSongId()` strips the `@<rowid>` part, so bare hashes still work.

4. **`getSimilarSongs`** — without a Last.fm API key the fallback returns an empty list with no error.

5. **`buildSong` bitrate** — the scanner stores kbps, so `bitRate` needs no conversion.
