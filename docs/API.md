# Velvet — API Reference

Velvet uses a REST API. All `POST` requests must set `Content-Type: application/json` unless otherwise noted. All responses are JSON.

Related: [Upstream OpenAPI comparison](API/upstream-openapi-comparison.md)

---

## Authentication

Most endpoints require a JWT bearer token. Tokens are issued by `POST /api/v1/auth/login`.

The token can be supplied in any of these ways (checked in order):

1. Request body field: `{ "token": "…" }`
2. Query parameter: `?token=…`
3. HTTP header: `x-access-token: …`
4. Cookie: `x-access-token=…`

### Public mode
If no users are configured on the server, all requests are treated as authenticated as a public user with full library access — no token required (default for fresh installs).

### Special tokens
| Token type | How obtained | Restrictions |
|---|---|---|
| **Admin** (`admin: true`) | Login with admin account | Required for all `/api/v1/admin/*` endpoints |
| **Jukebox** (`jukebox: true`) | Created during session | Bound to one active remote-control session |
| **Shared playlist** (`shareToken: true`) | `GET /api/v1/shared/{id}` | Can only stream tracks in that specific playlist |
| **Federation invite** (`invite: true`) | `POST /api/v1/federation/invite/generate` | Can only call `POST /api/v1/federation/invite/exchange` |

---

## Errors

All errors return `{ "error": "<message>" }`.

| Status | Meaning |
|---|---|
| 400 | Bad request (invalid input) |
| 401 | Unauthenticated or invalid token |
| 403 | Forbidden (Joi validation error, insufficient permission) |
| 404 | Resource not found |
| 405 | Admin API locked |
| 500 | Server error |
| 503 | External dependency unavailable (ffmpeg, mpv) |

---

## Virtual Paths (vpaths)

Libraries are mounted under named vpaths (e.g. `Music`, `AudioBooks`). Filepaths in all request/response bodies use the format `<vpath>/<relative/path>`. The server maps these to absolute disk paths and enforces per-user access on every request. The list of vpaths a user can access is returned by `/api/v1/ping` and `/api/v1/db/status`.

---

## Streaming Files

To stream a file directly:
```
GET /media/<vpath>/<path/to/song.mp3>?token=<jwt>
```

---

## System

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Serves the main player webapp HTML |
| `GET` | `/admin` | Serves the admin panel HTML |
| `GET` | `/api` | API version discovery — returns `{ server, apiVersions }` |
| `GET` | `/api/v1/ping` | Bootstrap payload — vpaths, playlists, transcode config, vpath metadata. For admin users also includes `vpathWriteAccess: { [vpathName]: bool }` (filesystem write-access check). Auth required. |
| `GET` | `/api/v1/ping/public` | Unauthenticated. Returns `{ status: 'ok', instanceId, hasUsers }` — used by the client to detect cross-instance localStorage contamination, and to decide whether to probe `/db/status` for no-auth-server detection without producing a spurious 401. *(Velvet)* |

---

## Auth

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/auth/login` | `{ username, password }` | Authenticates. Returns `{ token, vpaths }` and sets an `x-access-token` cookie (5-year max-age). Brute-force protected (800ms delay on failure). |
| `GET` | `/api/v1/auth/refresh` | — | Issues a freshly-signed JWT from the current valid session; refreshes the `x-access-token` cookie. Returns `{ token }` or `{ token: null }` on no-auth servers. *(Velvet)* |

---

## Library

| Method | Endpoint | Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/v1/db/status` | — | Total track count + scan lock state + vpaths. |
| `POST` | `/api/v1/db/metadata` | `{ filepath }` | Full metadata for one track. Response includes `album-version`, `bit-depth`, and `album-artist` (ID3 TPE2; `artist` falls back to `album-artist` when blank). *(Velvet)* |
| `POST` | `/api/v1/db/metadata/batch` | `["filepath1", …]` | Metadata for multiple tracks. Returns map of filepath → metadata. |
| `GET` | `/api/v1/db/artists` | — | All artist names, case-insensitive sort. |
| `POST` | `/api/v1/db/artists` | `{ ignoreVPaths? }` | Same, with optional vpath filter. |
| `POST` | `/api/v1/db/artists-albums` | `{ artist, ignoreVPaths? }` | All albums by one artist. |
| `POST` | `/api/v1/db/artists-albums-multi` | `{ artists[] }` | Albums across several artists. |
| `POST` | `/api/v1/db/artist-folder-songs` | `{ artists[], ignoreVPaths?, excludeFilepathPrefixes? }` | Raw song rows for an artist; used by Artists2 Songs section. |
| `GET` | `/api/v1/db/albums` | — | All albums. |
| `POST` | `/api/v1/db/albums` | `{ ignoreVPaths?, excludeFilepathPrefixes?, includeFilepathPrefixes? }` | Albums with optional vpath and path prefix filters. |
| `POST` | `/api/v1/db/album-songs` | `{ album, artist?, year?, ignoreVPaths? }` | Tracks in an album. |
| `GET` | `/api/v1/db/genres` | — | All genres. |
| `POST` | `/api/v1/db/genres` | `{ ignoreVPaths? }` | Genres with optional vpath filter. |
| `POST` | `/api/v1/db/genre-songs` | `{ genre, ignoreVPaths? }` | Tracks in a genre (legacy). |
| `GET` | `/api/v1/db/genre-groups` | — | Genres with counts, grouped by admin-configured display groups. *(Velvet)* |
| `POST` | `/api/v1/db/genre/albums` | `{ genre }` | Albums in a genre. *(Velvet)* |
| `POST` | `/api/v1/db/genre/songs` | `{ genre }` | Tracks in a genre. *(Velvet)* |
| `GET` | `/api/v1/db/decades` | — | Decades with track counts. *(Velvet)* |
| `POST` | `/api/v1/db/decade/albums` | `{ decade }` | Albums released in a decade. *(Velvet)* |
| `POST` | `/api/v1/db/decade/songs` | `{ decade }` | Tracks from a decade. *(Velvet)* |
| `POST` | `/api/v1/db/songs-by-artists` | `{ artists[], limit? }` | Random tracks by the given artists. *(Velvet)* |
| `GET` | `/api/v1/db/similar` | `?hash=&limit=` | Similar songs scored by BPM proximity + Camelot wheel key compatibility. *(Velvet)* |
| `GET` | `/api/v1/db/audio-features/:hash` | — | Essentia audio features (BPM, key, MFCC, HPCP) for a track hash. *(Velvet)* |
| `POST` | `/api/v1/db/scan-errors/report-playback` | `{ filepath, errorMsg? }` | Report a file the browser could not decode (DEMUXER_ERROR / PTS undefined) to the Scan Error Workshop so an admin can remux it with ffmpeg. `filepath` includes the vpath prefix. *(Velvet)* |
| `POST` | `/api/v1/db/random-songs` | `{ minRating?, ignoreList?, ignorePercentage?, ignoreVPaths?, genres?, genreMode? }` | One random track. `ignoreList` lets callers avoid repeats across calls. `genres` is an array of display genre names (from `/api/v1/db/genres`); `genreMode` is `"whitelist"` (default) or `"blacklist"`. |
| `POST` | `/api/v1/db/unplayed-gems` | `{ limit?, ignoreVPaths? }` | Songs with zero play count (limit 1–500, default 100) plus `count` of total unplayed songs in library. *(Velvet)* |
| `GET` | `/api/v1/files/art` | `?fp=<vpath/file>` | Extract and cache embedded album art for a track. Returns `{ aaFile }`. |
| `GET` | `/album-art/{file}` | `?compress=zl\|zs` | Serve a cached album-art file. `zl` = large thumbnail, `zs` = small. |

---

## Album Library *(Velvet)*

> Full DB-driven album tree with series, discs, tracks, and cover art. See [docs/albums.md](albums.md) for design details.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/albums/browse` | All albums grouped into albums + series. Returns `{ albums[], series[] }`. Each album object includes `album_version` (edition string) and `bit_depth`. |
| `GET` | `/api/v1/albums/art-file` | Serve an on-disk `cover.jpg` by relative path. |
| `GET` | `/api/v1/albums/detail` | Album detail: all tracks + metadata. Params: `?vpath=&album=&artist=`. |
| `POST` | `/api/v1/albums/set-art` | Set album art from a URL. Body: `{ vpath, album, artist, url }`. Admin only. |

---

## Artist Library *(Velvet)*

> Artist index with bio images auto-fetched from Discogs/Wikipedia. See [docs/artists.md](artists.md).

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/artists/home` | All artists with counts and thumbnail image URLs. |
| `POST` | `/api/v1/artists/letter` | Artists starting with a letter. Body: `{ letter }`. |
| `POST` | `/api/v1/artists/search` | Search artist names. Body: `{ query }`. |
| `POST` | `/api/v1/artists/profile` | Full profile: albums, tracks, bio image. Body: `{ artist }`. |
| `GET` | `/api/v1/artists/image` | Serve artist image. Params: `?artist=`. |
| `GET` | `/api/v1/artists/images/:filename` | Serve a cached artist image file directly. |
| `POST` | `/api/v1/artists/fetch-info` | Fetch bio / social links for an artist from external sources. Body: `{ artist }`. |
| `POST` | `/api/v1/artists/set-image` | Set artist image from a URL. Body: `{ artist, url }`. Admin only. |
| `POST` | `/api/v1/artists/set-name` | Rename / alias an artist. Body: `{ oldName, newName }`. Admin only. |
| `POST` | `/api/v1/artists/mark-image-wrong` | Flag current image as wrong (admin). Body: `{ artist }`. |

---

## Home Screen *(Velvet)*

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/db/home-summary` | Personalised shelves: `recentlyPlayed`, `onThisDay`, `mostPlayed`. Auth required. |

---

## Search

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/db/search` | `{ search, noArtists?, noAlbums?, noTitles?, noFiles?, ignoreVPaths? }` | Full-text search across artists, albums, titles, and filepaths. Returns up to 30 matches per category. |

---

## Play Stats

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/db/rated` | — | Tracks rated > 0, sorted highest first. |
| `POST` | `/api/v1/db/rated` | `{ ignoreVPaths? }` | Same, with vpath filter. |
| `POST` | `/api/v1/db/rate-song` | `{ filepath, rating }` | Rate a track 0–10 (or `null` to clear). |
| `POST` | `/api/v1/db/recent/added` | `{ limit, ignoreVPaths? }` | Recently added tracks. |
| `POST` | `/api/v1/db/recent/added/by-day` | `{ maxDays?, maxFolders?, ignoreVPaths? }` | Recently added folders grouped by calendar day (up to 7 days, 700 folders). |
| `POST` | `/api/v1/db/stats/recently-played` | `{ limit, ignoreVPaths? }` | Recently played tracks. |
| `POST` | `/api/v1/db/stats/most-played` | `{ limit, ignoreVPaths? }` | Most played tracks. |
| `POST` | `/api/v1/db/stats/log-play` | `{ filePath }` | Increment play-count and update last-played. |
| `POST` | `/api/v1/db/stats/reset-play-counts` | — | Reset play counts for all tracks. |
| `POST` | `/api/v1/db/stats/reset-recently-played` | — | Clear recently-played history. |

---

## Your Stats / Wrapped *(Velvet)*

> Spotify-style listening statistics. See [docs/your-stats.md](your-stats.md) for full field reference.

**Listening event hooks** (called by the player):

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/wrapped/play-start` | `{ filePath, sessionId?, source? }` | Log start of a play. Returns `{ eventId }`. |
| `POST` | `/api/v1/wrapped/play-end` | `{ eventId, playedMs }` | Log natural track completion. |
| `POST` | `/api/v1/wrapped/play-stop` | `{ eventId, playedMs }` | Log a manual stop. |
| `POST` | `/api/v1/wrapped/play-skip` | `{ eventId, playedMs }` | Log an explicit skip. |
| `POST` | `/api/v1/wrapped/pause` | `{ eventId }` | Increment pause count. |
| `POST` | `/api/v1/wrapped/session-end` | `{ sessionId }` | Close a listening session (called on page unload). |
| `POST` | `/api/v1/wrapped/radio-start` | `{ stationName }` | Log radio listen start. |
| `POST` | `/api/v1/wrapped/radio-stop` | `{ stationName, listenedMs }` | Log radio listen stop. |
| `POST` | `/api/v1/wrapped/podcast-start` | `{ feedUrl, episodeTitle }` | Log podcast episode start. |
| `POST` | `/api/v1/wrapped/podcast-end` | `{ feedUrl, episodeTitle, listenedMs }` | Log podcast episode end. |

**Stats queries**:

| Method | Endpoint | Params | Description |
|---|---|---|---|
| `GET` | `/api/v1/user/wrapped` | `?period=monthly&offset=0` | Aggregated stats for a period. Periods: `weekly`, `monthly`, `quarterly`, `half-yearly`, `yearly`. `offset=0` = current, `1` = previous, etc. |
| `GET` | `/api/v1/user/wrapped/periods` | — | List of available period labels. |
| `GET` | `/api/v1/history` | `?fromMs=<unix-ms>&toMs=<unix-ms>` (optional) | Play events for the current user with title, artist, album, aaFile, filepath, started_at, played_ms. Without params: last 7 days. With both params: bounded range `started_at >= fromMs AND started_at < toMs`. Returns `{ events[] }` ordered newest first. |

**Admin**:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/admin/wrapped/stats` | Server-wide listening statistics across all users. |
| `POST` | `/api/v1/admin/wrapped/purge` | Delete all listening event history. Body: `{ confirm: true }`. |
| `POST` | `/api/v1/admin/wrapped/backfill-folder-metadata` | Backfill vpath/folder metadata for historical events. |
| `GET` | `/api/v1/admin/wrapped/backfill-folder-metadata/preview` | Preview which events would be updated by the backfill (dry run). |

---

## Playlists

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/playlist/getall` | — | List the user's playlists (names). |
| `POST` | `/api/v1/playlist/load` | `{ playlistname }` | Load tracks with full metadata. Each entry includes a stable row `id` for removal. |
| `POST` | `/api/v1/playlist/new` | `{ title }` | Create an empty playlist. 400 if name already exists. |
| `POST` | `/api/v1/playlist/save` | `{ title, songs[], live? }` | Create or overwrite a playlist. `live: true` marks it as a live-synced queue. |
| `POST` | `/api/v1/playlist/add-song` | `{ song, playlist }` | Add a track to a playlist (creates it if missing). |
| `POST` | `/api/v1/playlist/remove-song` | `{ id }` | Remove a track by its row `id` (from `/playlist/load`). |
| `POST` | `/api/v1/playlist/delete` | `{ playlistname }` | Delete a playlist. |
| `POST` | `/api/v1/playlist/rename` | `{ oldName, newName }` | Rename a playlist. 400 if new name already exists. |

---

## Smart Playlists *(Velvet)*

> Rule-based dynamic playlists. See [docs/smart-playlists.md](smart-playlists.md) for the filter schema.

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/smart-playlists` | — | List all smart playlists. |
| `POST` | `/api/v1/smart-playlists` | `{ name, filters?, sort?, limit? }` | Create a smart playlist. Returns `{ id }`. |
| `PUT` | `/api/v1/smart-playlists/:id` | `{ name?, filters?, sort?, limit? }` | Update a smart playlist. |
| `DELETE` | `/api/v1/smart-playlists/:id` | — | Delete a smart playlist. |
| `POST` | `/api/v1/smart-playlists/run` | `{ filters, sort?, limit? }` | Execute a query without saving. Returns `{ songs[] }`. |
| `POST` | `/api/v1/smart-playlists/count` | `{ filters }` | Count matching tracks. Returns `{ count }`. |

---

## Smart Playlist ML *(Velvet beta)*

> ML-powered time-slot playlists. See [docs/smart-playlist-ml.md](smart-playlist-ml.md). User endpoints require `BETA_SMART_PLAYLIST = true` in `src/beta-flags.js`.

| Method | Endpoint | Body / Query | Description |
|---|---|---|---|
| `GET` | `/api/v1/smartplaylist/generated` | `?slot=morning\|afternoon\|evening\|night` | Get cached top-50 tracks for a time slot (default: current). |
| `POST` | `/api/v1/smartplaylist/save-as-playlist` | `{ name, slot? }` | Save generated slot playlist as a regular playlist. |
| `GET` | `/api/v1/admin/smartplaylist/status` | — | Admin: feature flag + per-user profile stats. |
| `POST` | `/api/v1/admin/smartplaylist/generate` | — | Admin: trigger generation immediately. |
| `POST` | `/api/v1/admin/smartplaylist/reset-profiles` | `{ userId? }` | Admin: clear EMA profiles for a user. |

---

## Shared Playlists

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/share` | `{ playlist[], time? }` | Create a shareable link. `time` = expiry in days; omit for eternal. Returns `{ playlistId, token, … }`. |
| `GET` | `/api/v1/share/list` | — | List the user's shared playlists. *(Velvet)* |
| `DELETE` | `/api/v1/share/:id` | — | Delete a shared playlist. *(Velvet)* |
| `GET` | `/api/v1/shared/:playlistId` | — | Fetch playlist contents + a restricted token for playback. (Public — no auth required.) |
| `GET` | `/shared/:playlistId` | — | Public HTML viewer page for a shared playlist. |
| `GET` | `/api/v1/download/shared` | — | Download all files in a shared playlist as ZIP. Requires shared-playlist token. |

---

## File Explorer

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/file-explorer` | `{ directory, sort?, pullMetadata? }` | Browse a directory. Pass `""` or `~` to list vpaths. Returns `{ path, directories[], files[] }`. |
| `POST` | `/api/v1/file-explorer/recursive` | `{ directory }` | Recursively list all audio files. Returns array of virtual paths. |
| `POST` | `/api/v1/file-explorer/mkdir` | `{ directory }` | Create a directory. Requires `allowMkdir` permission. |
| `POST` | `/api/v1/file-explorer/upload` | Multipart form | Upload a file. Target dir in `data-location` header. Requires `allowUpload`. Filenames sanitized. |
| `POST` | `/api/v1/file-explorer/m3u` | `{ path }` | Parse an M3U playlist file. Returns resolved entries. |

---

## Download

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/download/m3u` | `{ path }` | Download an M3U playlist + all its tracks as a ZIP. |
| `POST` | `/api/v1/download/directory` | `{ directory }` | Download a directory as a ZIP. |
| `POST` | `/api/v1/download/zip` | Form: `fileArray` (JSON-stringified array of paths) | Download an arbitrary list of files as a ZIP. |
| `DELETE` | `/api/v1/files/recording` | `{ filepath }` | Delete a recording file. Requires `allowRecordDelete` on the vpath. *(Velvet)* |

---

## Transcode

| Method | Endpoint | Params | Description |
|---|---|---|---|
| `GET` | `/transcode/:filepath` | `?codec=mp3\|opus\|aac&bitrate=64k\|96k\|128k\|192k&algo=stream\|buffer&offset=<seconds>` | Stream a transcoded audio file. Streaming starts before transcoding completes. `offset` seeks by starting ffmpeg at the requested time (used for transcoded-playback seeking); offset requests bypass cache while non-offset requests remain cached. |

---

## Waveform

| Method | Endpoint | Params | Description |
|---|---|---|---|
| `GET` | `/api/v1/db/waveform` | `?filepath=<vpath/file>` | 800-bar amplitude array (0–255) for the progress scrubber. Generated on demand, cached. |

---

## Cue Points *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/db/cuepoints` | `?fp=<vpath/file>` | List cue points for a track. |
| `POST` | `/api/v1/db/cuepoints` | `{ filepath, position, label?, color? }` | Create a cue point. `position` = seconds. Returns `{ id }`. |
| `PUT` | `/api/v1/db/cuepoints/:id` | `{ position?, label?, color? }` | Update a cue point. |
| `DELETE` | `/api/v1/db/cuepoints/:id` | — | Delete a cue point. |

---

## Album Art

| Method | Endpoint | Body / Params | Description |
|---|---|---|---|
| `POST` | `/api/v1/album-art/search` | `{ artist?, album? }` | Search MusicBrainz, iTunes, and Deezer for cover art. Returns `{ results[], ffmpegAvailable }`. |
| `POST` | `/api/v1/album-art/set-from-url` | `{ filepath, url, writeToFolder?, writeToFile? }` | Download art from a URL and apply it. `writeToFile` embeds into the ID3 tag (requires ffmpeg + write permission). |
| `POST` | `/api/v1/album-art/upload` | `{ filepath, image, writeToFolder?, writeToFile? }` | Upload cover art as base64. |
| `GET` | `/api/v1/album-art/ffmpeg-status` | — | Whether ffmpeg is available. Returns `{ available }`. |

---

## Discogs / iTunes *(Velvet)*

| Method | Endpoint | Params / Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/discogs/coverart` | `?artist=&title=&album=&year=` | Search Discogs for cover art options. Returns `{ choices[] }`. |
| `POST` | `/api/v1/discogs/embed` | `{ filepath, releaseId?, coverUrl? }` | Embed art from Discogs or a direct URL. Returns `{ ok, aaFile, cacheOnly }`; on rewrite paths, file mtime is synced in DB to avoid stale scan flags. |
| `GET` | `/api/v1/discogs/release-images` | `?id=&type=release\|master` | Admin only. Fetch thumbnail choices for a specific Discogs release/master ID. Returns `{ choices[] }`. *(Velvet)* |
| `GET` | `/api/v1/deezer/search` | `?q=` | Search Deezer (part of the Discogs art-lookup flow). |
| `GET` | `/api/v1/itunes/search` | `?artist=&album=` | Server-side proxy for the iTunes Search API. Returns structured results. *(Velvet)* |

---

## User Settings *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/user/settings` | — | Get the user's saved UI preferences and optional queue. Returns `{ prefs, queue? }`. |
| `POST` | `/api/v1/user/settings` | `{ prefs?, queue? }` | Save UI preferences and/or queue state. |

---

## Scrobbling — Last.fm

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/lastfm/status` | — | Returns `{ serverEnabled, hasApiKey, linkedUser }`. |
| `POST` | `/api/v1/lastfm/connect` | `{ lastfmUser, lastfmPassword }` | Link the current user's Last.fm account. |
| `POST` | `/api/v1/lastfm/disconnect` | — | Unlink Last.fm. |
| `POST` | `/api/v1/lastfm/test-login` | `{ username, password }` | Validate Last.fm credentials without saving. |
| `GET` | `/api/v1/lastfm/similar-artists` | `?artist=` | Get similar artists from Last.fm API. Returns `{ artists[] }`. |
| `GET` | `/api/v1/lastfm/artist-info` | `?artist=` | Get artist bio, tags, and image from Last.fm API. Returns `{ bio, tags[], image }`. |
| `POST` | `/api/v1/lastfm/scrobble-by-filepath` | `{ filePath }` | Scrobble a completed track. |
| `POST` | `/api/v1/lastfm/scrobble-by-metadata` | `{ track, artist?, album? }` | Scrobble by metadata. |

---

## Scrobbling — ListenBrainz *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/listenbrainz/status` | — | Returns `{ serverEnabled, linked }`. |
| `POST` | `/api/v1/listenbrainz/connect` | `{ lbToken }` | Link a ListenBrainz account. |
| `POST` | `/api/v1/listenbrainz/disconnect` | — | Unlink ListenBrainz. |
| `POST` | `/api/v1/listenbrainz/playing-now` | `{ filePath }` | Send a now-playing notification. |
| `POST` | `/api/v1/listenbrainz/scrobble-by-filepath` | `{ filePath }` | Scrobble a completed track. |

---

## Discord Webhook *(Velvet)*

> Notifies a Discord channel when a user plays a track. Users opt-in individually in the Connectors sidebar.

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/discord-webhook/status` | — | Returns `{ serverEnabled, webhookEnabled, nick }`. |
| `POST` | `/api/v1/discord-webhook/save` | `{ enabled, nick? }` | Save per-user opt-in and display nick. |
| `POST` | `/api/v1/discord-webhook/scrobble-by-filepath` | `{ filePath }` | Send a Discord scrobble for a track. |

---

## Custom Webhooks *(Velvet)*

> Per-user configurable webhook that POSTs a JSON payload to any URL on each track play. Users configure it in the Connectors sidebar.

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/custom-webhooks/status` | — | Returns `{ serverEnabled, webhookEnabled, url? }` for the current user. |
| `POST` | `/api/v1/custom-webhooks/save` | `{ enabled, url?, headers? }` | Save per-user webhook config. |
| `POST` | `/api/v1/custom-webhooks/scrobble-by-filepath` | `{ filePath }` | Manually fire the webhook for a track (used internally by the player). |

---

## Radio *(Velvet)*

> Full internet radio with ICY metadata, recording, and scheduling. See [docs/API/radio.md](API/radio.md).

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/radio/enabled` | — | Returns `{ enabled }`. |
| `GET` | `/api/v1/radio/stations` | — | List all radio stations. |
| `POST` | `/api/v1/radio/stations` | `{ name, url, logoUrl? }` | Add a station. |
| `PUT` | `/api/v1/radio/stations/:id` | `{ name?, url?, logoUrl? }` | Update a station. |
| `DELETE` | `/api/v1/radio/stations/:id` | — | Delete a station. |
| `POST` | `/api/v1/radio/stations/reorder` | `{ ids[] }` | Reorder stations. |
| `GET` | `/api/v1/radio/stream` | `?id=` | Proxy the ICY stream for a station. |
| `GET` | `/api/v1/radio/art` | `?id=` | Serve station logo image. |
| `GET` | `/api/v1/radio/nowplaying` | `?id=` | Get ICY now-playing metadata for a station. Returns `{ title, artist, song }`. |
| `GET` | `/api/v1/radio/schedules` | — | List recording schedules. |
| `POST` | `/api/v1/radio/schedules` | `{ stationId, startTime, duration, … }` | Create a recording schedule. |
| `PUT` | `/api/v1/radio/schedules/:id` | `{ stationId?, startTime?, duration?, enabled? }` | Update a schedule. |
| `DELETE` | `/api/v1/radio/schedules/:id` | — | Delete a schedule. |
| `POST` | `/api/v1/radio/schedules/:id/enable` | `{ enabled: bool }` | Enable or disable a schedule. |
| `GET` | `/api/v1/radio/schedules/active` | — | Get the currently active schedule (if any). |
| `GET` | `/api/v1/radio/record/active` | — | Returns `{ recording: bool, stationId? }` — whether a live recording is in progress. |
| `POST` | `/api/v1/radio/record/start` | `{ stationId }` | Start a live recording. |
| `POST` | `/api/v1/radio/record/stop` | — | Stop the recording. Returns `{ filePath, relPath, bytesWritten, durationMs, vpath, stationName, artFile }`. |

---

## Podcasts *(Velvet)*

> RSS podcast subscriptions with per-episode playback progress. See [docs/API/podcasts.md](API/podcasts.md).

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/podcast/preview` | `?url=` | Preview a feed URL before subscribing: returns title, description, episode count. |
| `GET` | `/api/v1/podcast/feeds` | — | List subscribed feeds. |
| `POST` | `/api/v1/podcast/feeds` | `{ url }` | Subscribe to a feed. |
| `DELETE` | `/api/v1/podcast/feeds/:id` | — | Unsubscribe. |
| `PUT` | `/api/v1/podcast/feeds/:id` | `{ title? }` | Rename a feed. |
| `POST` | `/api/v1/podcast/feeds/reorder` | `{ ids[] }` | Reorder feeds. |
| `POST` | `/api/v1/podcast/feeds/:id/refresh` | — | Force-refresh a feed's episodes. |
| `GET` | `/api/v1/podcast/episodes/:feedId` | — | List episodes for a feed by feed ID. |
| `POST` | `/api/v1/podcast/episode/progress` | `{ feedId, episodeGuid, positionMs }` | Save playback position for an episode. |
| `POST` | `/api/v1/podcast/episode/save` | `{ feedId, episodeGuid }` | Mark an episode as saved/downloaded. |

---

## YouTube Download *(Velvet)*

> Downloads YouTube audio into the library. See [docs/API/ytdl.md](API/ytdl.md).

| Method | Endpoint | Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/v1/ytdl/metadata` | `?url=` | Fetch video metadata — returns `{ title, artist, album, year, thumbnail }`. |
| `POST` | `/api/v1/ytdl/` | `{ url, outputCodec?, metadata? }` | Start async download. Returns `{ jobId, message }` immediately. |
| `GET` | `/api/v1/ytdl/downloads` | — | Poll job status. Returns object keyed by `jobId` → `{ status, title, filePath?, vpath?, error? }`. |

---

## Server Playback (Cast to Server Speaker) *(Velvet)*

> Controls the mpv-based server-side audio player. See [docs/server-audio.md](server-audio.md).

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/server-playback/status` | — | `{ playing, filepath, position, duration, volume, looping }` |
| `POST` | `/api/v1/server-playback/set-pause` | `{ pause: bool }` | Start or pause playback. |
| `POST` | `/api/v1/server-playback/pause` | — | Pause (legacy alias). |
| `POST` | `/api/v1/server-playback/resume` | — | Resume (legacy alias). |
| `POST` | `/api/v1/server-playback/stop` | — | Stop and clear queue. |
| `POST` | `/api/v1/server-playback/seek` | `{ position }` | Seek to seconds. |
| `POST` | `/api/v1/server-playback/volume` | `{ volume }` (0–130) | Set volume. |
| `POST` | `/api/v1/server-playback/next` | — | Next track. |
| `POST` | `/api/v1/server-playback/previous` | — | Previous track. |
| `POST` | `/api/v1/server-playback/loop` | — | Toggle loop mode. |
| `POST` | `/api/v1/server-playback/shuffle` | — | Shuffle the queue. |
| `GET` | `/api/v1/server-playback/queue` | — | Get current queue (virtual paths). |
| `POST` | `/api/v1/server-playback/play` | `{ file }` | Clear queue and play a file. |
| `POST` | `/api/v1/server-playback/queue/add` | `{ filepath }` | Append a file to the queue. |
| `POST` | `/api/v1/server-playback/queue/add-many` | `{ files[] }` | Append multiple files. |
| `POST` | `/api/v1/server-playback/queue/play-index` | `{ index }` | Jump to queue index. |
| `POST` | `/api/v1/server-playback/queue/remove` | `{ index }` | Remove track at index. |
| `POST` | `/api/v1/server-playback/queue/clear` | — | Clear the queue. |
| `GET` | `/api/v1/server-playback/detect` | — | Detect mpv binary. Returns `{ found, path }`. |
| `GET` | `/api/v1/server-playback/audio-health` | — | ALSA/audio health check. Returns `{ ok, details[] }`. |
| `POST` | `/api/v1/server-playback/audio-health/fix` | — | Attempt auto-fix (unmute ALSA master). |
| `POST` | `/api/v1/server-playback/test-tone` | — | Play a 1 kHz test tone for 2 s. |
| `POST` | `/api/v1/server-playback/heartbeat` | `{ sessionId }` | Keep-alive from the remote UI. Resets idle timeout. |
| `POST` | `/api/v1/server-playback/reapply-gain` | — | Re-apply ReplayGain to the currently loaded track (after settings change). |
| `GET` | `/server-remote` | — | Static HTML for the server-audio player UI. |

---

## Jukebox (Remote Control)

> Remote-control mode: a separate device controls the player via a one-time code. See [docs/API/jukebox_sessions.md](API/jukebox_sessions.md).

**Authenticated endpoints**:

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/jukebox/open-jukebox` | — | Start a jukebox session. Returns `{ code }`. |
| `POST` | `/api/v1/jukebox/close-jukebox` | — | Close the active session. |
| `GET` | `/api/v1/jukebox/sessions` | — | List all active jukebox sessions. Returns `[{ code, since }]`. |
| `POST` | `/api/v1/jukebox/push-to-client` | `{ code, command, file? }` | Send a command to the player. Commands: `addSong`, `playPause`, `next`, `previous`, `removeSong`, `goToSong`, `getPlaylist`, `getNowPlaying`. |
| `POST` | `/api/v1/jukebox/update-playlist` | `{ code, tracks[], idx }` | Player → server: write current queue to cache. |
| `POST` | `/api/v1/jukebox/update-now-playing` | `{ code, nowPlaying: { title, artist, album, albumArt, filepath, currentTime, duration, playing } }` | Player → server: write now-playing to cache. |

**Public endpoints (no auth — use code)**:

| Method | Endpoint | Params / Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/jukebox/does-code-exist` | `{ code }` | Check if a code is active. Returns `{ status: bool, token }`. |
| `GET` | `/api/v1/jukebox/get-playlist` | `?code=` | Read cached queue. |
| `GET` | `/api/v1/jukebox/get-now-playing` | `?code=` | Read cached now-playing state. |
| `GET` | `/remote/:remoteId` | — | Serve the remote-control webapp. |

---

## AcoustID / Audio Fingerprinting *(Velvet)*

> See [docs/acoustid.md](acoustid.md).

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/acoustid/status` | — | Returns fingerprinting job status and queue length. |
| `POST` | `/api/v1/acoustid/start` | `{ vpaths? }` | Start fingerprinting all unfingerprinted tracks. |
| `POST` | `/api/v1/acoustid/stop` | — | Stop the running job. |
| `POST` | `/api/v1/acoustid/scan-files` | `{ files: ["vpath/rel", …] }` | Queue specific files for fingerprinting. *(Velvet)* |
| `POST` | `/api/v1/acoustid/reset-errors` | — | Re-queue all errored files for fingerprinting. *(Velvet)* |
| `POST` | `/api/v1/acoustid/reset-not-found` | — | Re-queue all `not_found` files for fingerprinting. Returns `{ reset, workerStarted }`. *(Velvet)* |

---

## Tag Workshop *(Velvet)*

> Batch metadata enrichment via AcoustID/MusicBrainz fingerprint lookup. See [docs/tageditor.md](tageditor.md).

| Method | Endpoint | Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/v1/tagworkshop/status` | — | Returns combined status: `{ mb: {…}, textSearch: {…}, tags: {…}, enrich: { running, stopping }, textSearch: { running, stopping, … } }`. |}
| `POST` | `/api/v1/tagworkshop/enrich/start` | `{ vpaths? }` | Start the enrichment job. |
| `POST` | `/api/v1/tagworkshop/enrich/stop` | — | Stop the running job. |
| `GET` | `/api/v1/tagworkshop/enrich/errors` | — | List tracks where enrichment failed. |
| `POST` | `/api/v1/tagworkshop/enrich/retry-errors` | — | Retry failed tracks. |
| `GET` | `/api/v1/tagworkshop/albums` | — | Albums with pending tag suggestions. |
| `GET` | `/api/v1/tagworkshop/album/:mb_release_id` | — | Full suggestion for one MusicBrainz release. |
| `POST` | `/api/v1/tagworkshop/accept` | `{ mb_release_id }` | Accept all track tags for a release. |
| `POST` | `/api/v1/tagworkshop/accept-track` | `{ filepath, … }` | Accept tags for a single track. |
| `POST` | `/api/v1/tagworkshop/skip` | `{ mb_release_id }` | Shelve a release (skip for now). |
| `POST` | `/api/v1/tagworkshop/unshelve` | `{ mb_release_id }` | Restore a shelved release. |
| `GET` | `/api/v1/tagworkshop/shelved` | — | List shelved releases. |
| `POST` | `/api/v1/tagworkshop/bulk-accept-casing` | `{ mb_release_id }` | Accept only casing/punctuation normalisation for a release. |
| `POST` | `/api/v1/tagworkshop/text-search/start` | — | Start the MusicBrainz text-search fallback job (for `acoustid_status='not_found'` files). |
| `POST` | `/api/v1/tagworkshop/text-search/stop` | — | Stop the running text-search job. |
| `GET` | `/api/v1/tagworkshop/text-search/status` | — | Returns `{ queued, found, not_found, skipped, errors, running, stopping }`. |
| `POST` | `/api/v1/tagworkshop/text-search/retry-notfound` | — | Reset all `not_found` rows so they are retried on next run. |
| `GET` | `/api/v1/tagworkshop/text-search/errors` | — | Returns `{ errors: [{filepath, vpath, mb_text_search_ts, mb_text_search_error}], total }`. |
| `POST` | `/api/v1/tagworkshop/text-search/retry-errors` | — | Reset all `error` rows so they are retried on next run. Returns `{ ok, reset }`. |

---

## Languages *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/languages/enabled` | — | List languages enabled on this server. |
| `GET` | `/api/v1/admin/languages/config` | — | Get language config (admin). |
| `POST` | `/api/v1/admin/languages/config` | `{ enabled[] }` | Set which languages are available. |

---

## Federation (Syncthing Mesh Sync)

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/federation/stats` | — | Returns `{ deviceId, uiAddress }`. |
| `POST` | `/api/v1/federation/invite/generate` | `{ vpaths?, url? }` | Generate a federation invite token. |
| `POST` | `/api/v1/federation/invite/accept` | `{ url, vpaths, invite, accessAll }` | Accept a federation invite. |
| `*` | `/api/v1/syncthing-proxy/:path` | — | Proxy any request to the bundled Syncthing UI. All HTTP methods accepted. |

---

## Admin — Configuration

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/config` | — | Full server configuration. |
| `POST` | `/api/v1/admin/lock-api` | `{ lock: bool }` | Lock or unlock the admin API. |
| `POST` | `/api/v1/admin/config/port` | `{ port }` | Change port (triggers restart). |
| `POST` | `/api/v1/admin/config/address` | `{ address }` | Change listen address. |
| `POST` | `/api/v1/admin/config/secret` | `{ strength }` | Regenerate JWT secret (invalidates all tokens). |
| `POST` | `/api/v1/admin/config/noupload` | `{ noUpload: bool }` | Toggle uploads server-wide. |
| `POST` | `/api/v1/admin/config/nomkdir` | `{ noMkdir: bool }` | Toggle directory creation server-wide. |
| `POST` | `/api/v1/admin/config/nofilemodify` | `{ noFileModify: bool }` | Toggle file modification server-wide. |
| `POST` | `/api/v1/admin/config/write-logs` | `{ writeLogs: bool }` | Toggle writing logs to disk. |
| `POST` | `/api/v1/admin/config/max-request-size` | `{ maxRequestSize: "50MB" }` | Set max request body size. |
| `POST` | `/api/v1/admin/config/ui` | `{ ui: "default"\|"velvet" }` | Switch UI mode. |

---

## Admin — Libraries (vpaths)

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/directories` | — | List all libraries. |
| `PUT` | `/api/v1/admin/directory` | `{ directory, vpath, autoAccess?, isAudioBooks? }` | Add a library. |
| `DELETE` | `/api/v1/admin/directory` | `{ vpath }` | Remove a library. |
| `PATCH` | `/api/v1/admin/directory/flags` | `{ vpath, albumsOnly?, allowRecordDelete? }` | Update per-folder flags. *(Velvet)* |

---

## Admin — Users

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/users` | — | List all users with their permissions. |
| `PUT` | `/api/v1/admin/users` | `{ username, password, vpaths[], admin?, allowMkdir?, allowUpload? }` | Create a user. |
| `DELETE` | `/api/v1/admin/users` | `{ username }` | Delete a user. |
| `POST` | `/api/v1/admin/users/password` | `{ username, password }` | Change a user's password. |
| `POST` | `/api/v1/admin/users/vpaths` | `{ username, vpaths[] }` | Update library access. |
| `POST` | `/api/v1/admin/users/access` | `{ username, admin, allowMkdir, allowUpload, allowFileModify? }` | Update role and permissions. |
| `POST` | `/api/v1/admin/users/allow-mpv-cast` | `{ username, allow: bool }` | Toggle server-playback (mpv cast) permission. *(Velvet)* |
| `POST` | `/api/v1/admin/users/lastfm` | `{ username, lasftfmUser, lasftfmPassword }` | Set Last.fm credentials for a user (admin override). |

---

## Admin — Scanner

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/db/params` | — | Get all scanner settings. |
| `POST` | `/api/v1/admin/db/scan/all` | — | Scan all libraries. |
| `POST` | `/api/v1/admin/db/scan/force-rescan` | — | Rescan all libraries ignoring mtimes. |
| `GET` | `/api/v1/admin/db/scan/stats` | — | Total track count in DB. |
| `GET` | `/api/v1/admin/db/scan/progress` | — | Per-library scan progress. Returns `[{ vpath, pct, scanned, expected, currentFile }]`. *(Velvet)* |
| `GET` | `/api/v1/admin/db/scan-errors` | — | List scan errors (files the scanner could not process). |
| `DELETE` | `/api/v1/admin/db/scan-errors` | — | Clear all scan errors. |
| `GET` | `/api/v1/admin/db/scan-errors/count` | — | Returns `{ count }` of current scan errors. |
| `POST` | `/api/v1/admin/db/scan-errors/fix` | — | Attempt to re-process all scan-errored files. |
| `POST` | `/api/v1/admin/db/params/scan-interval` | `{ scanInterval }` | Scheduled rescan interval in hours (0 = disabled). |
| `POST` | `/api/v1/admin/db/params/skip-img` | `{ skipImg: bool }` | Skip album art extraction during scan. |
| `POST` | `/api/v1/admin/db/params/boot-scan-delay` | `{ bootScanDelay }` | Seconds to wait before scanning on boot. |
| `POST` | `/api/v1/admin/db/params/max-concurrent-scans` | `{ maxConcurrentTasks }` | Max parallel scan workers. |
| `POST` | `/api/v1/admin/db/params/compress-image` | `{ compressImage: bool }` | Generate album art thumbnails. |
| `POST` | `/api/v1/admin/db/params/scan-commit-interval` | `{ scanCommitInterval }` | Files between DB commits (lower = shorter write locks). |
| `POST` | `/api/v1/admin/db/params/auto-album-art` | `{ autoAlbumArt: bool }` | Auto-fetch art from external services during scan. |
| `POST` | `/api/v1/admin/db/params/album-art-write-to-folder` | `{ albumArtWriteToFolder: bool }` | Write fetched art as `cover.jpg` in album folder. |
| `POST` | `/api/v1/admin/db/params/album-art-write-to-file` | `{ albumArtWriteToFile: bool }` | Embed fetched art in audio file ID3 tags. |
| `POST` | `/api/v1/admin/db/params/album-art-services` | `{ albumArtServices: ["musicbrainz","itunes","deezer"] }` | Select which services to query for art. |
| `POST` | `/api/v1/admin/db/force-compress-images` | — | Re-run thumbnail compressor over the whole library. |
| `POST` | `/api/v1/admin/db/generate-waveforms` | — | Generate waveform data for every track. |
| `GET` | `/api/v1/admin/db/album-version-inventory` | — | Count of files grouped by `album_version_source` (which tag or method produced the version value). Returns `[{ source, count }]`. *(Velvet)* |
| `POST` | `/api/v1/admin/db/params/album-version-tags` | `{ tags: ["TIT3", "TXXX:EDITION", …] }` | Update the ordered list of tag fields the scanner uses to detect album version/edition. Max 20 entries. *(Velvet)* |
| `POST` | `/api/v1/admin/directory/reset-sentinel` | `{ vpath }` | Re-write the `.velvet.md` mount-guard sentinel file to the vpath root. Use when scanning is blocked after the sentinel was accidentally deleted. *(Velvet)* |
| `POST` | `/api/v1/admin/db/params/scan-error-retention` | `{ days }` | Set how many days to keep scan errors before automatic pruning. *(Velvet)* |

---

## Admin — ID3 Tag Editing *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/admin/tags/write` | `{ filepath, title?, artist?, album?, year?, genre?, track?, disk? }` | Write ID3 tags to an audio file. Requires `allowFileModify`. |

---

## Admin — Transcode

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/transcode` | — | Get transcode config + ffmpeg availability. |
| `POST` | `/api/v1/admin/transcode/default-codec` | `{ defaultCodec: "mp3"\|"opus"\|"aac" }` | Set default codec. |
| `POST` | `/api/v1/admin/transcode/default-bitrate` | `{ defaultBitrate: "64k"\|"96k"\|"128k"\|"192k" }` | Set default bitrate. |
| `POST` | `/api/v1/admin/transcode/download` | — | Download the bundled ffmpeg binary. |

---

## Admin — DLNA

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/dlna` | — | DLNA config: `{ mode, port, name, uuid, browse }`. |
| `GET` | `/api/v1/admin/dlna/config` | — | Same as above. *(Velvet alias)* |
| `POST` | `/api/v1/admin/dlna/config` | `{ enabled?, port?, name? }` | Update DLNA config. Starts/stops the server live. |
| `POST` | `/api/v1/admin/dlna/mode` | `{ mode: "disabled"\|"same-port"\|"separate-port", port? }` | Enable/disable DLNA. |
| `POST` | `/api/v1/admin/dlna/browse` | `{ browse: "flat"\|"dirs"\|"artist"\|"album"\|"genre" }` | Set DLNA browse structure. |

---

## Admin — SSL

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/admin/ssl` | `{ cert, key }` | Set SSL certificate and key. Paths must point to existing files in trusted certificate locations. |
| `DELETE` | `/api/v1/admin/ssl` | — | Remove SSL certificates. |

---

## Admin — Last.fm / ListenBrainz Config

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/lastfm/config` | — | Get Last.fm server API key config. |
| `POST` | `/api/v1/admin/lastfm/config` | `{ apiKey, apiSecret?, enabled? }` | Set Last.fm API key. |
| `GET` | `/api/v1/admin/listenbrainz/config` | — | Get ListenBrainz config: `{ enabled, userToken? }`. |
| `POST` | `/api/v1/admin/listenbrainz/config` | `{ enabled?, userToken? }` | Update ListenBrainz config. |

---

## Admin — Discord Webhook Config *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/discord-webhook/config` | — | Get webhook config: `{ enabled, url }`. |
| `POST` | `/api/v1/admin/discord-webhook/config` | `{ enabled?, url? }` | Update config. URL must be a `discord.com` or `discordapp.com` webhook URL. |

---

## Admin — Genre Groups *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/genre-groups` | — | Get genre display groupings. |
| `POST` | `/api/v1/admin/genre-groups` | `{ groups: { "Group Name": ["genre1","genre2"] } }` | Update groupings. |

---

## Admin — Server Playback *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/server-audio` | — | Get Server Audio config: `{ mpvPath, enabled }`. |
| `POST` | `/api/v1/admin/server-audio` | `{ mpvPath?, enabled? }` | Save config. |
| `POST` | `/api/v1/admin/server-audio/start` | — | Start the mpv process. |
| `POST` | `/api/v1/admin/server-audio/stop` | — | Stop the mpv process. |

---

## Sonos *(Velvet)*

> Active cast to Sonos devices via UPnP/SOAP. See [docs/sonos.md](sonos.md).

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/sonos/devices` | — | Cached room list + `enabled` flag; triggers discovery if empty. |
| `POST` | `/api/v1/sonos/scan` | — | Force re-discovery using the configured seed IP. |
| `GET` | `/api/v1/sonos/probe?ip=` | — | Probe a single IP — returns room name, UUID, reachability. |
| `POST` | `/api/v1/sonos/save-default` | `{ ip, name, uuid }` | Save a room as the default cast target. |
| `POST` | `/api/v1/sonos/cast` | `{ deviceIp, track, seekTo?, paused? }` | Cast a track to a Sonos device. Requires `allow-mpv-cast`. |
| `POST` | `/api/v1/sonos/set-pause` | `{ deviceIp, paused }` | Pause or resume. Requires `allow-mpv-cast`. |
| `POST` | `/api/v1/sonos/seek` | `{ deviceIp, seconds }` | Seek to position. Requires `allow-mpv-cast`. |
| `POST` | `/api/v1/sonos/set-volume` | `{ deviceIp, volume }` | Set volume (0–100). Requires `allow-mpv-cast`. |
| `GET` | `/api/v1/sonos/battery?ip=` | — | Battery status for portable devices (Roam, Roam 2, Move, Move 2). Returns `{ supported, level, powerSource, health, temperature }`. Mains-powered devices return `{ supported: false }`. |
| `GET` | `/api/v1/sonos/device-info?ip=` | — | Device info from `/status/zp` + `/status/wireless`. Returns `{ zoneName, model, firmware, firmwareDate, ipAddress, macAddress, seriesId, wifi, wifiMode, sonosNetPeers }`. |
| `GET` | `/api/v1/sonos/transport-status?ip=` | — | Poll playback state: `{ playing, paused, stopped, state, position, duration }`. |
| `GET` | `/api/v1/sonos/radio-favorites?ip=` | — | Return Sonos favourite channels that are directly playable from the local Sonos MusicServices bridge. |
| `GET` | `/api/v1/sonos/browse-content?ip=&id=` | — | Browse Sonos MusicServices content containers by object id. |
| `POST` | `/api/v1/sonos/play-cloud-object` | `{ deviceIp, id, title? }` | Start a Sonos cloud object (for example a radio favourite) on the target device with resilient fallback behavior. Requires `allow-mpv-cast`. |
| `GET` | `/api/v1/sonos/transcode-stream?fp=&token=` | — | Stream a Sonos-incompatible file as MP3 (192 k @ 48 kHz) via ffmpeg. Used automatically when Auto-transcode is enabled and the file is Opus or hi-res (>48 kHz). |
| `POST` | `/api/v1/sonos/test-play` | `{ deviceIp }` | Play a random song (admin test). |
| `POST` | `/api/v1/admin/sonos` | `{ enabled?, transcodeOpus? }` | Save Sonos config (admin only). `transcodeOpus: true` enables auto-transcode for Opus and hi-res files. |

---

## Admin — Discogs Config

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/discogs/config` | — | Get Discogs config + feature flags. Returns `{ enabled, allowArtUpdate, allowId3Edit, itunesEnabled, deezerEnabled, apiKey, apiSecret }`. |
| `POST` | `/api/v1/admin/discogs/config` | `{ enabled?, allowArtUpdate?, apiKey?, apiSecret? }` | Update config. |

---

## Admin — Shared Playlists

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/db/shared` | — | List all shared playlists on the server. |
| `DELETE` | `/api/v1/admin/db/shared` | `{ id }` | Delete a shared playlist by ID. |
| `DELETE` | `/api/v1/admin/db/shared/expired` | — | Delete all expired shared playlists. |
| `DELETE` | `/api/v1/admin/db/shared/eternal` | — | Delete all non-expiring shared playlists. |

---

## Admin — File Explorer

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/admin/file-explorer` | `{ directory, joinDirectory? }` | Browse any absolute path on the filesystem. `~` for home. |
| `GET` | `/api/v1/admin/file-explorer/win-drives` | — | List Windows drive letters (returns `[]` on non-Windows). |

---

## Admin — Artist Image Management *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/admin/artists/rebuild-index` | — | Rebuild the artist name index. |
| `GET` | `/api/v1/admin/artists/rebuild-status` | — | Progress of an in-progress index rebuild. |
| `GET` | `/api/v1/admin/artists/image-audit` | — | List artists missing images. |
| `GET` | `/api/v1/admin/artists/discogs-candidates` | `?artist=` | Search Discogs for artist image candidates. |
| `GET` | `/api/v1/admin/artists/tadb-candidates` | `?artist=` | Search TheAudioDB for artist image candidates. |
| `POST` | `/api/v1/admin/artists/apply-image` | `{ artist, url }` | Download and apply an artist image from a URL. |
| `POST` | `/api/v1/admin/artists/enrich-tadb` | `{ artist }` | Fetch and store artist bio/social data from TheAudioDB. |
| `GET` | `/api/v1/admin/artists/hydration-status` | — | Status of the background artist-image hydration job. |
| `POST` | `/api/v1/admin/artists/hydration-seed` | — | Seed artist images for all artists without one. |
| `POST` | `/api/v1/admin/artists/hydrate-tadb-noimage` | — | Run TheAudioDB hydration for artists still missing an image. |
| `POST` | `/api/v1/admin/artists/placeholder` | `{ url }` | Set a custom placeholder image for artists with no image. |
| `DELETE` | `/api/v1/admin/artists/placeholder` | — | Remove the custom placeholder image (reverts to default). |
| `GET` | `/api/v1/admin/artists/placeholder-info` | — | Returns `{ hasCustomPlaceholder, url? }`. |

---

## Admin — Backup *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/admin/backup` | `{ includeDb?, includeConfig?, includeAlbumArt? }` | Create a server backup ZIP. |
| `GET` | `/api/v1/admin/backups` | — | List available backup files. |
| `GET` | `/api/v1/admin/backup/download/:filename` | — | Download a backup file. |

---

## Admin — Import / Export *(Velvet)*

Export is built in the background; poll for status before downloading.

| Method | Endpoint | Body / Params | Description |
|---|---|---|---|
| `POST` | `/api/v1/admin/migrate/export/start` | `{ includeWaveforms?, includeArtistImages? }` | Start background ZIP build. Returns `{ id }`. |
| `GET` | `/api/v1/admin/migrate/export/status/:id` | — | Poll build status. Returns `{ status: 'building'\|'ready'\|'error', filename?, sizeBytes?, error? }`. |
| `GET` | `/api/v1/admin/migrate/export/download/:id` | — | Stream the finished ZIP (authenticated). Deletes file after download. |
| `POST` | `/api/v1/admin/migrate/upload` | multipart `file` | Upload import ZIP. Returns `{ id, manifest }`. |
| `POST` | `/api/v1/admin/migrate/apply` | `{ id, keepUsers? }` | Apply an uploaded import. |
| `GET` | `/api/v1/admin/migrate/status/:id` | — | Read manifest of an uploaded import. |
| `POST` | `/api/v1/admin/migrate/cleanup/:id` | — | Delete temp files for an import job. |

---

## Admin — Logs

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/admin/logs/download` | Download all server logs as a ZIP. |
| `POST` | `/api/v1/admin/logs/prune` | Delete log files older than the configured retention period. |

---

## Admin — Federation

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/admin/federation/enable` | `{ enable: bool }` | Enable/disable federation. Rebuilds Syncthing config (5s debounce). |

---

## Admin — Radio Config *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/radio/config` | — | Get radio config: `{ enabled, recordingsVpath, maxRecordingMinutes }`. |
| `POST` | `/api/v1/admin/radio/config` | `{ enabled?, recordingsVpath?, maxRecordingMinutes? }` | Update radio config. |

---

## Admin — Diagnostics *(Velvet)*

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/admin/diagnostics/artist-albums` | Returns artist–album relationships for DB consistency checks. |
| `GET` | `/api/v1/admin/directories/test` | Test whether all configured library directories are accessible. Returns `[{ vpath, root, accessible, error? }]`. |

---

## Internal Scanner Endpoints

> These endpoints are protected by scanner middleware and are **not intended for external use**.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/scanner/update-art` | Write album art cache reference for a file. |
| `POST` | `/api/v1/scanner/update-cue` | Write cue point data for a file. |
| `POST` | `/api/v1/scanner/update-tech-meta` | Write `bitrate`, `sample_rate`, `channels` for a file. |
| `POST` | `/api/v1/scanner/update-duration` | Write `duration` for a file. |

---

## Lyrics *(Velvet)*

| Method | Endpoint | Params | Description |
|---|---|---|---|
| `GET` | `/api/v1/lyrics` | `?artist=&title=&filepath=&duration=` | Fetch lyrics. Checks embedded tags first, then queries the configured provider. Returns `{ lyrics, source }`. |

**Admin**:

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/lyrics/config` | — | Get lyrics config: `{ enabled }`. |
| `POST` | `/api/v1/admin/lyrics/config` | `{ enabled: bool }` | Enable/disable lyrics lookups. |

---

## AcoustID — Admin Config *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/acoustid/config` | — | Get AcoustID API key config. |
| `POST` | `/api/v1/admin/acoustid/config` | `{ apiKey }` | Set AcoustID API key. |

---

## Normalisation Workshop — Admin *(Velvet)*

> See [docs/replaygain-info.md](replaygain-info.md).

All endpoints require admin token.

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/rg/status` | — | Worker status + library stats + undo info. Returns `{ running, stopping, startedAt, currentFile, processedCount, stats, tool, undo }`. |
| `GET` | `/api/v1/admin/rg/tool` | — | Active measurement tool: `{ tool: 'rsgain'|'ffmpeg', available: bool }`. |
| `GET` | `/api/v1/admin/rg/failed` | — | List all failed files: `{ files: [{ id, filepath, vpath, reason, error, duration, bitrate }] }`. |
| `POST` | `/api/v1/admin/rg/start` | — | Start measurement worker. |
| `POST` | `/api/v1/admin/rg/stop` | — | Stop worker gracefully after current file. |
| `POST` | `/api/v1/admin/rg/reset-failed` | — | Smart reset: checks each failed file on disk. Purges DB rows for missing files, re-queues rows where the file still exists. Returns `{ reset, purged }`. |
| `POST` | `/api/v1/admin/rg/shelve` | `{ ids: [rowid, …] }` | Permanently exclude files from RG analysis (`rg_measured_ts = -2`). Shelved files stay in the library but are never touched by the worker. Returns `{ shelved }`. |
| `POST` | `/api/v1/admin/rg/reset-all` | — | Clear all RG measurements and back up current data for potential undo. Returns 409 if worker is running. Returns `{ reset, backedUp }`. |
| `POST` | `/api/v1/admin/rg/undo-reset-all` | — | Restore the most recent Reset All backup. Returns 409 if worker is running. Returns `{ restored }`. |

**`/api/v1/admin/rg/status` response shape:**
```json
{
  "running": false,
  "stopping": false,
  "startedAt": null,
  "currentFile": null,
  "processedCount": 0,
  "tool": "rsgain",
  "stats": {
    "total": 134599, "measured": 134123, "queued": 0,
    "failed": 30, "shelved": 6,
    "byTool": { "rsgain": 133000, "ffmpeg": 1123 }
  },
  "undo": { "available": false, "count": 0, "resetAt": null }
}
```

**`/api/v1/admin/rg/failed` file object fields:**

| Field | Type | Description |
|---|---|---|
| `id` | integer | DB rowid — pass to `/shelve` |
| `filepath` | string | Relative path within vpath |
| `vpath` | string | Virtual path name |
| `reason` | string | `measure_failed` / `timed_out` / `file_not_found` / `missing_vpath` / `resource_fork` |
| `error` | string\|null | Actual error text from rsgain/ffmpeg stderr |
| `duration` | number\|null | Duration in seconds |
| `bitrate` | number\|null | Bitrate in kbps |

---

## BPM & Key Analysis — Admin *(Velvet)*

> See [docs/bpm-harmonic.md](bpm-harmonic.md).

All endpoints require admin token.

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/bpm/status` | — | Coverage stats + AcousticBrainz + Essentia worker status. |
| `POST` | `/api/v1/admin/bpm/ab/start` | — | Start AcousticBrainz worker. |
| `POST` | `/api/v1/admin/bpm/ab/stop` | — | Stop AcousticBrainz worker after current file. |
| `POST` | `/api/v1/admin/bpm/ab/reset-failed` | — | Reset `ab_status='error'` rows to NULL for retry. |
| `POST` | `/api/v1/admin/bpm/ab/reset-not-found` | — | Reset `ab_status='not_found'` rows to NULL for re-query. Returns 409 if worker running. *(Velvet)* |
| `POST` | `/api/v1/admin/bpm/essentia/start` | — | Start Essentia WASM worker (Tier 2 BPM/key analysis). |
| `POST` | `/api/v1/admin/bpm/essentia/stop` | — | Stop Essentia worker after current file. |
| `POST` | `/api/v1/admin/bpm/essentia/reset-failed` | — | Reset `bpm_status='error'` rows. |
| `POST` | `/api/v1/admin/bpm/reset-all` | — | Clear all BPM/key data. Returns 409 if workers running. |
| `POST` | `/api/v1/admin/bpm/genre-correct` | `?dryRun=true` | Genre-matrix octave correction on Essentia rows. `dryRun=true` returns preview stats + full `corrections[]` list without writing. Returns `{dryRun, changed, skipped, noGenre, noFamily, alreadyOk, byFamily, corrections}`. Returns 409 if workers running. *(Velvet)* |
| `POST` | `/api/v1/admin/bpm/genre-correct-undo` | — | Restore `bpm_raw` → `bpm` for all `bpm_status='genre-corrected'` rows. Returns `{ok, restored}`. *(Velvet)* |
| `POST` | `/api/v1/admin/bpm/genre-correct-selected` | — | Apply a user-selected subset of dry-run corrections. Body: `{corrections: [{filepath, vpath, bpm, corrected}]}`. Returns `{ok, applied}`. Returns 409 if workers running. *(Velvet)* |

---

## Genre Enricher — Admin *(Velvet)*

> See [docs/genre-enricher.md](genre-enricher.md).

All endpoints require admin token. The Genre Enricher worker queries Last.fm, MusicBrainz and Discogs in parallel and stores suggestions per source. The admin compare table lets the user pick which suggestion to apply per artist.

| Method | Endpoint | Body / Query | Description |
|---|---|---|---|
| `GET`  | `/api/v1/admin/genre-enricher/status` | — | Live worker status + stats (`enriched`, `applied`, per-source `ok`/`nf`/`error`/`queued`, current artist, current phase). |
| `POST` | `/api/v1/admin/genre-enricher/start` | — | Start the background worker. |
| `POST` | `/api/v1/admin/genre-enricher/stop` | — | Stop the worker after the current artist. |
| `POST` | `/api/v1/admin/genre-enricher/reset-errors` | — | Reset rows with `genre_enrich_* = 'error'` to NULL for retry. |
| `POST` | `/api/v1/admin/genre-enricher/reset-not-found` | — | Reset rows with `genre_enrich_* = 'nf'` to NULL. |
| `POST` | `/api/v1/admin/genre-enricher/reset-source` | `{ source: 'lastfm'\|'mb'\|'discogs' }` | Reset one source's enrichment status + value to NULL. |
| `POST` | `/api/v1/admin/genre-enricher/reset-all` | — | Wipe all enrichment data (status + suggestions + `genre_user_reviewed`). |
| `GET`  | `/api/v1/admin/genre-enricher/compare` | `?filter=enriched\|empty\|applied&search=<text>&limit&offset` | Paginated comparison rows. `enriched` = all 3 sources processed, not yet reviewed. `empty` = same as `enriched` but only artists with no current genre tag. `applied` = user has acted. `search` does a case-insensitive `%text%` LIKE match on artist over the ENTIRE result set. |
| `POST` | `/api/v1/admin/genre-enricher/apply` | `{ items: [{ artist, source: 'lastfm'\|'mb'\|'discogs'\|'keep'\|'custom', custom? }] }` | Apply user decisions in bulk. `keep` marks the artist as reviewed without changing the genre. `custom` writes an arbitrary lowercase string. Returns `{ updated }`. |
| `POST` | `/api/v1/admin/genre-enricher/apply-all-empty` | `{ source: 'preferred'\|'mb'\|'discogs'\|'lastfm' }` | Bulk-apply suggestions to every artist that currently has no genre. |
| `POST` | `/api/v1/admin/genre-enricher/apply-all-consensus` | — | Apply the agreed genre for every unreviewed artist where all 3 sources returned the same non-empty value. Returns `{ updated }`. |
| `POST` | `/api/v1/admin/genre-enricher/apply-all-majority` | — | Apply the majority genre for every unreviewed artist where exactly 2 of 3 sources agree and the third has no data yet. Returns `{ updated }`. |
| `POST` | `/api/v1/admin/genre-enricher/set-genre` | `{ artist, genre }` | Manually set the current genre for one artist (lowercase, stored on `files.genre`). |

---

## Duplicate Workshop — Admin *(Velvet)*

Find and remove duplicate songs and album folders in the library. Three detection tiers: exact file hash, matching audio hash (same content, different tags/container), and similar (same normalised artist+title with close duration).

All endpoints require admin token.

| Method | Endpoint | Body / Query | Description |
|---|---|---|---|
| `GET`  | `/api/v1/admin/dup-workshop/status` | — | Current state (`idle`\|`scanning`\|`done`), summary (`groups`, `files`), `lastScan` timestamp, active `threshold`. |
| `POST` | `/api/v1/admin/dup-workshop/scan` | `{ threshold?: 50–100 }` | Start an async scan. Returns 202 immediately. Poll `/status` until `state=done`. |
| `POST` | `/api/v1/admin/dup-workshop/cancel` | — | Abort an in-progress scan. |
| `GET`  | `/api/v1/admin/dup-workshop/songs` | `?match=exact\|audio\|similar&limit&offset` | Paginated song duplicate groups. Each group has `paths[]`, `formats[]`, `similarity`, `artist`, `title`, `album`, `duration`. |
| `GET`  | `/api/v1/admin/dup-workshop/folders` | `?limit&offset` | Paginated folder-duplicate groups (same artist+album under multiple directory paths). |
| `POST` | `/api/v1/admin/dup-workshop/delete` | `{ filepaths: ['vpath/rel/path', …] }` | Permanently delete files from disk and remove DB rows. Returns `{ deleted, failed }`. |

---

## Subsonic Compatibility

Velvet implements a subset of the Subsonic API for third-party client compatibility. See [docs/subsonic.md](subsonic.md) for supported methods.

Base URL: `/rest/`

**Per-user Subsonic scrobble toggle**:

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/subsonic/scrobble-settings` | — | Get the user's Subsonic scrobble settings. |
| `POST` | `/api/v1/admin/users/subsonic-scrobble` | `{ username, scrobbleLastfm?, scrobbleLb? }` | Enable/disable scrobble forwarding per-user for Subsonic clients. |

**Subsonic server-side play queue persistence**:

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET/POST` | `/rest/getPlayQueue(.view)` | Subsonic auth params | Returns the authenticated user's saved queue, current track ID, and position (ms). |
| `GET/POST` | `/rest/savePlayQueue(.view)` | Subsonic auth params + `id[]`, `current`, `position` | Saves/upserts the authenticated user's queue server-side so clients can restore queue state across restarts. |
