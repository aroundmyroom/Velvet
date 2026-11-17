# Velvet — API Reference

Velvet uses a REST API. All `POST` requests must set `Content-Type: application/json` unless otherwise noted. All responses are JSON.

---

## Authentication

Most endpoints require a JWT bearer token. Tokens are issued by `POST /api/v1/auth/login`.

The token can be supplied in any of these ways (checked in order):

1. Request body field: `{ "token": "…" }`
2. Query parameter: `?token=…`
3. HTTP header: `x-access-token: …`
4. HTTP header: `Authorization: Bearer …`
5. Cookie: `x-access-token=…`

### Public mode
If no users are configured on the server, all requests are treated as authenticated as a public user with full library access — no token required (default for fresh installs).

### Special tokens
| Token type | How obtained | Restrictions |
|---|---|---|
| **Admin** (`admin: true`) | Login with admin account | Required for all `/api/v1/admin/*` endpoints |
| **Jukebox** (`scope: 'jukebox'`, `code`) | Created with a remote-control session (valid 12 h) | Only `POST /api/v1/jukebox/push-to-client` for its own session code, and `POST /api/v1/file-explorer` |
| **Sonos stream** (`scope: 'stream'`, `fp`) | Minted per track when casting to Sonos (valid 8 h) | Only `/media/<fp>` and `/api/v1/sonos/transcode-stream?fp=<fp>` for that one file |
| **Shared playlist** (`shareToken: true`) | `GET /api/v1/shared/{id}` | Can only stream tracks in that specific playlist |

### Token revocation
Every user has a `tokenVersion` (0 when absent). User tokens carry it as the `tv` claim, and a token whose `tv` does not match the user's current version is refused with `401`. A password change (self or by an admin) and `POST /api/v1/admin/users/revoke-tokens` raise the version, which logs the user out on every device; jukebox and Sonos stream tokens are revoked the same way. Shared-playlist tokens are not affected.

---

## Errors

All errors return `{ "error": "<message>" }`.

| Status | Meaning |
|---|---|
| 400 | Bad request (invalid input, including Joi validation errors) |
| 401 | Unauthenticated or invalid token |
| 403 | Forbidden (insufficient permission) |
| 404 | Resource not found |
| 405 | Admin API locked |
| 500 | Server error |
| 503 | External dependency unavailable (ffmpeg, mpv) |

---

## Virtual Paths (vpaths)

Libraries are mounted under named vpaths (e.g. `Music`, `AudioBooks`). Filepaths in all request/response bodies use the format `<vpath>/<relative/path>`. The server maps these to absolute disk paths and enforces per-user access on every request. The list of vpaths a user can access is returned by `/api/v1/ping` and `/api/v1/db/status`.

A user who has only a child vpath (a sub-folder of a root vpath) is limited to that folder on the server: every library list (search, artists, albums, genres, recent, rated, most played, random songs, similar, Auto-DJ, and so on) is narrowed to the child's folder whatever the client sends, and a path with `..` cannot leave it.

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
| `GET` | `/admin` | Serves the admin panel HTML (also `/admin/index.html`). Non-admins are sent to `/`; a locked admin API shows "Admin Page Disabled". |
| `GET` | `/login` | Redirects (301) to `/` (also `/login/index.html`). |
| `GET` | `/classic` | `410` — the classic UI was removed. |
| `GET` | `/manifest.json` | Root-scoped PWA manifest, phones only (others fall through to 404). |
| `GET` | `/sw.js` | Root-scoped service worker, phones only. |
| `GET` | `/favicon.ico` | Redirects to `/assets/fav/favicon.ico`. |
| `GET` | `/assets/fav/site.webmanifest` | Web app manifest for desktop browsers. |
| `GET` | `/robots.txt` | `Disallow: /` for all crawlers. |
| `GET` | `/api` | API version discovery — returns `{ server, apiVersions }` |
| `GET` | `/api/v1/ping` | Bootstrap payload: `{ vpaths, noUpload, supportedAudioFiles, transcode, vpathMetaData, allowRadioRecording, allowYoutubeDownload, allowUpload, allowServerRemote, allowMpvCast, version, defaultTheme, skins, defaultSkin }`. `skins` is `[{ id, v }]` (folder name and a cache-buster from the file time), `defaultSkin` the admin's default (`""` for none). `transcode` is `{ defaultCodec, defaultBitrate, defaultAlgorithm }` when transcoding is enabled and ffmpeg is ready, else `false`. `vpathMetaData[vpath]` is `{ type, parentVpath, filepathPrefix, allowRecordDelete, albumsOnly }`. `allowMpvCast` is true when Server Audio is on and the user is an admin or has `allow-mpv-cast`. For admin users also includes `vpathWriteAccess: { [vpathName]: bool }` (filesystem write-access check). Auth required. |
| `GET` | `/api/v1/ping/public` | Unauthenticated. Returns `{ status: 'ok', instanceId, hasUsers }` — used by the client to detect cross-instance localStorage contamination, and to decide whether to probe `/db/status` for no-auth-server detection without producing a spurious 401. *(Velvet)* |

---

## Auth

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/auth/login` | `{ username, password }` | Authenticates. Returns `{ token, vpaths }` and sets an `x-access-token` cookie (30-day max-age). Brute-force protected (800ms delay on failure). |
| `GET` | `/api/v1/auth/refresh` | — | Issues a freshly-signed JWT from the current valid session; refreshes the `x-access-token` cookie. Returns `{ token }` or `{ token: null }` on no-auth servers. *(Velvet)* |
| `POST` | `/api/v1/auth/change-password` | `{ currentPassword, newPassword }` | Self-service password change for the logged-in user. Verifies the current password first (800ms delay on failure). The change revokes every older token of the user (this session's too), so it returns `{ token }`, a fresh token that is also set as cookie. *(Velvet)* |

### Passkey (WebAuthn) — public endpoints (no token required)

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/auth/passkey/auth/options` | `{ username? }` | Generate a WebAuthn authentication challenge. Optional `username` restricts to that user's credentials; omit for discoverable-credential (resident key) flow. Returns `PublicKeyCredentialRequestOptionsJSON`. *(Velvet)* |
| `POST` | `/api/v1/auth/passkey/auth/verify` | `{ credential, challenge }` | Verify a WebAuthn assertion. Returns `{ token, vpaths, username }` and sets `x-access-token` cookie — same response as `/auth/login`. *(Velvet)* |

### Passkey (WebAuthn) — authenticated endpoints (token required)

| Method | Endpoint | Body / Params | Description |
|---|---|---|---|
| `POST` | `/api/v1/auth/passkey/register/options` | — | Generate a WebAuthn registration challenge for the current user. Returns `PublicKeyCredentialCreationOptionsJSON`. *(Velvet)* |
| `POST` | `/api/v1/auth/passkey/register/verify` | `{ credential, friendlyName? }` | Verify a registration response and store the new passkey credential. Returns `{ verified: true }`. *(Velvet)* |
| `GET` | `/api/v1/auth/passkey/credentials` | `?username=x` (admin) | List passkeys for the current user (or `username` if admin). Returns `{ credentials: [{ id, friendlyName, deviceType, backedUp, createdAt, lastUsedAt }] }`. *(Velvet)* |
| `DELETE` | `/api/v1/auth/passkey/credentials/:id` | `?username=x` (admin) | Remove a specific passkey by id. *(Velvet)* |

### Reverse-proxy trusted-header auth (ExtAuth)

Not a REST endpoint — a fallback inside the main auth middleware. When no `x-access-token`/bearer/query token is present on a request, and `extAuth.enabled` is on, Velvet checks whether the request's TCP socket peer is in `extAuth.trustedProxies` (IPv4 CIDR or exact IP) and, if a shared-secret header is configured, that it matches. If both pass, the configured header (`extAuth.headerName`, default `Remote-User`) is read as a username; a matching Velvet user gets a normal session (same JWT cookie `/auth/login` sets). See `docs/auth-reverse-proxy.md` for reverse-proxy examples (Nginx Proxy Manager, Traefik, Caddy). Config and admin endpoints: see **Reverse-Proxy Auth — Admin Config** below. *(Velvet)*

### Cross-device login pairing

A device with an awkward keyboard (Samsung TV remote, kiosk) shows a short code; an already-logged-in device approves it. Complements passkeys, which need a platform authenticator or WebAuthn hybrid transport the requesting device may not have. Codes are 6 characters (unambiguous alphabet, no `0/O/1/I`), single-use, and expire after 5 minutes. *(Velvet)*

| Method | Endpoint | Auth | Body / Params | Description |
|---|---|---|---|---|
| `POST` | `/api/v1/auth/pair/start` | none | — | Starts a pairing session. Returns `{ pairId, code, expiresInSec }`. Limited to 10 starts per minute per IP and 1000 pending pairings in total; over either limit it answers `429`. |
| `GET` | `/api/v1/auth/pair/status` | none | `?pairId=` | Poll for approval. Returns `{ status: 'pending' \| 'expired' }`, or once approved (once only — the pairing is consumed on this response) `{ status: 'approved', token, vpaths, username }` — same session shape as `/auth/login`. |
| `POST` | `/api/v1/auth/pair/approve` | user | `{ code }` | Approves a pairing code as the calling (already-authenticated) user. Spaces are ignored and the code is not case-sensitive. 800ms delay on an invalid/expired/already-used code, same brute-force mitigation as `/auth/login`. |

---

## Library

| Method | Endpoint | Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/v1/db/status` | — | `{ totalFileCount, locked, vpaths, scanningVpaths }`. `totalFileCount` counts only the tracks the caller can reach (a user with only a child folder gets the count of that folder). |
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
| `GET` | `/api/v1/db/genres` | — | All genres. (integration API, no web UI caller) |
| `POST` | `/api/v1/db/genres` | `{ ignoreVPaths? }` | Genres with optional vpath filter. (integration API, no web UI caller) |
| `GET` | `/api/v1/db/genre-groups` | — | Genres with counts, grouped by the admin's display groups; while no groups are saved, the groups are made automatically. Genres in no group land in `Other`. Returns `{ groups: [{ name, genres: [{ genre, cnt }] }], genres }`. *(Velvet)* |
| `POST` | `/api/v1/db/genre/albums` | `{ genre }` | Albums in a genre. *(Velvet)* |
| `POST` | `/api/v1/db/genre/songs` | `{ genre }` | Tracks in a genre. *(Velvet)* |
| `GET` | `/api/v1/db/decades` | — | Decades with track counts. Returns `{ decades }`. *(Velvet)* |
| `POST` | `/api/v1/db/decades` | `{ ignoreVPaths? }` | Same, with optional vpath filter. *(Velvet)* |
| `POST` | `/api/v1/db/decade/albums` | `{ decade }` | Albums released in a decade. *(Velvet)* |
| `POST` | `/api/v1/db/decade/songs` | `{ decade }` | Tracks from a decade. *(Velvet)* |
| `POST` | `/api/v1/db/songs-by-artists` | `{ artists[], limit? }` | Random tracks by the given artists. *(Velvet)* |
| `GET` | `/api/v1/db/similar` | `?hash=&limit=` | Similar songs scored by BPM proximity + Camelot wheel key compatibility. (integration API, no web UI caller) *(Velvet)* |
| `POST` | `/api/v1/db/scan-errors/report-playback` | `{ filepath, errorMsg? }` | Report a file the browser could not decode (DEMUXER_ERROR / PTS undefined) to the Scan Error Workshop so an admin can remux it with ffmpeg. `filepath` includes the vpath prefix. *(Velvet)* |
| `POST` | `/api/v1/db/random-songs` | `{ minRating?, ignoreList?, ignorePercentage?, ignoreVPaths?, filepathPrefix?, includeFilepathPrefixes?, genres?, genreMode?, minDuration?, maxDuration?, allowUnknownDuration?, returnAll? }` | One random track. `includeFilepathPrefixes: [{ vpath, prefix }]` whitelists folders inside a root vpath (used for several child vpaths at once); a root not named in the list is not narrowed. `ignoreList` lets callers avoid repeats across calls. `genres` is an array of display genre names (from `/api/v1/db/genres`); `genreMode` is `"whitelist"` (default) or `"blacklist"`. `minDuration`/`maxDuration` (SECONDS) are an optional track-length window — a hard scope filter like `minRating`, never relaxed, for the single pick and for `returnAll` alike (`400` when `minDuration > maxDuration`); `allowUnknownDuration` (default `false`) controls whether tracks with no scanned duration are included. `returnAll: true` switches to Auto-DJ batch mode: returns a broad candidate pool (scoped to collections/rating/artists/cooldown/duration only, no BPM/key/genre filtering) for client-side soft scoring instead of one server-picked track — see `docs/autodj-scoring.md`. |
| `POST` | `/api/v1/autodj/next` | `{ seedFilepath?, recent?: string[] (≤200, oldest first), scope?: { ignoreVPaths?, filepathPrefix?, includeFilepathPrefixes?, excludeFilepathPrefixes?, minRating?, minDuration?, maxDuration?, allowUnknownDuration? } }` | The server's Auto-DJ picks the next song — the same picker a room's Auto-DJ uses, with the caller's saved Auto-DJ settings (minimum rating, similar artists, filter words). `seedFilepath` is the song playing now (without one it is a plain random pick); `recent` are the songs played before it, used for repeat and artist cooldown. Paths the caller cannot read are skipped, and a user limited to sub-folders stays inside them whatever `scope` says. Returns `{ song }` (same `{ filepath, metadata }` shape as one `random-songs` entry) or `{ song: null }`. Any logged-in user; used by the Samsung TV app and Server Remote. *(Velvet)* |
| `POST` | `/api/v1/db/unplayed-gems` | `{ limit?, ignoreVPaths? }` | Songs with zero play count (limit 1–500, default 100) plus `count` of total unplayed songs in library. *(Velvet)* |
| `GET` | `/api/v1/files/art` | `?fp=<vpath/file>` | Extract and cache embedded album art for a track. Returns `{ aaFile }`. |
| `GET` | `/album-art/{file}` | `?compress=zl\|zs` | Serve a cached album-art file. `zl` = large thumbnail, `zs` = small. |

---

## Album Library *(Velvet)*

> Full DB-driven album tree with series, discs, tracks, and cover art. See [docs/albums.md](albums.md) for design details.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/albums/browse` | All albums grouped into albums + series. Returns `{ albums[], series[] }`. Each album object includes `album_version` (edition string) and `bit_depth`. |
| `GET` | `/api/v1/albums/art-file` | Serve an on-disk cover image by relative path. Params: `?p=<path>` (must end in `.jpg`/`.jpeg`/`.png`/`.webp`/`.gif`). |
| `GET` | `/api/v1/albums/detail` | Album detail: discs, tracks + metadata for one album. Params: `?id=<albumId>` (the `id` from `/albums/browse`). `404` for an unknown id. |
| `POST` | `/api/v1/albums/set-art` | Download a cover and write it as `cover.jpg` in the album folder. Body: `{ albumPath, releaseId? \| coverUrl? }` (one of the two; `albumPath` is the album's `path` from `/albums/browse`, `releaseId` a Discogs release). Returns `{ artFile }`. Admin only. |

---

## Artist Library *(Velvet)*

> Artist index with bio images auto-fetched from Discogs/Wikipedia. See [docs/artists.md](artists.md).

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/artists/home` | All artists with counts and thumbnail image URLs. |
| `GET` | `/api/v1/artists/letter` | Artists starting with a letter. Params: `?l=`. Returns `{ artists }`. |
| `GET` | `/api/v1/artists/search` | Search artist names in the caller's own folders. Params: `?q=` (at least 2 characters, else `400`). Returns `{ artists }`. |
| `GET` | `/api/v1/artists/profile` | Full profile: albums, tracks, bio image. Params: `?key=<artistKey>`. |
| `GET` | `/api/v1/artists/image` | Look up an artist's image. Params: `?artist=`. Returns `{ imageFile }` or `{}`. |
| `GET` | `/api/v1/artists/images/:filename` | Serve a cached artist image file directly. |
| `GET` | `/api/v1/artists/placeholder` | The artist placeholder image: the custom one (`artist-placeholder.jpg` in the config folder, next to `default.json`) if set, else the built-in default. Public — no auth. |
| `POST` | `/api/v1/artists/set-image` | Set artist image from a URL. Body: `{ artistKey, imageUrl }`. Returns `{ ok, imageFile }`. Admin only. |
| `POST` | `/api/v1/artists/set-name` | Set the display name of an artist. Body: `{ artistKey, canonicalName }`. Returns `{ ok, canonicalName }`. Admin only. |
| `POST` | `/api/v1/artists/mark-image-wrong` | Flag (or unflag) the current image as wrong. Body: `{ artistKey, wrong? }` (default `true`). Admin only. |

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
| `POST` | `/api/v1/wrapped/play-start` | `{ filePath, sessionId?, source?, dj? }` | Log start of a play. Returns `{ ok, eventId }`. If the same song has an unfinished play from the last 10 minutes (a page reload), that event is reused and the answer also has `resumed: true`. `dj` (only with `source: 'autodj'`) is the Auto-DJ decision trace `{ cands, score, similar, escape?, dropArtist?, curBpm?, curKey?, curYear?, curGenre? }` — written to the server log as one bounded `[autodj] ▶` line, never stored. *(Velvet)* |
| `POST` | `/api/v1/wrapped/play-end` | `{ eventId, playedMs }` | Log natural track completion. |
| `POST` | `/api/v1/wrapped/play-stop` | `{ eventId, playedMs }` | Log a manual stop. |
| `POST` | `/api/v1/wrapped/play-skip` | `{ eventId, playedMs }` | Log an explicit skip. |
| `POST` | `/api/v1/wrapped/pause` | `{ eventId }` | Increment pause count. |
| `POST` | `/api/v1/wrapped/session-end` | `{ sessionId }` | Close a listening session (called on page unload). |
| `POST` | `/api/v1/wrapped/radio-start` | `{ stationName, stationId?, sessionId }` | Log radio listen start. Returns `{ ok, eventId }`. |
| `POST` | `/api/v1/wrapped/radio-stop` | `{ eventId, listenedMs? }` | Log radio listen stop. |
| `POST` | `/api/v1/wrapped/podcast-start` | `{ episodeId, feedId, sessionId }` | Log podcast episode start. Returns `{ ok, eventId }`. |
| `POST` | `/api/v1/wrapped/podcast-end` | `{ eventId, playedMs?, completed? }` | Log podcast episode end. |

**Stats queries**:

| Method | Endpoint | Params | Description |
|---|---|---|---|
| `GET` | `/api/v1/user/wrapped` | `?period=monthly&offset=0` | Aggregated stats for a period. Periods: `weekly`, `monthly`, `quarterly`, `half-yearly`, `yearly`. `offset=0` = current, `-1` = previous, down to `-260`. |
| `GET` | `/api/v1/user/wrapped/periods` | — | List of available period labels. |
| `GET` | `/api/v1/history` | `?fromMs=<unix-ms>&toMs=<unix-ms>` (optional) | Play events for the current user with title, artist, album, aaFile, filepath, started_at, played_ms. Without params: last 7 days. With both params: bounded range `started_at >= fromMs AND started_at < toMs`. Returns `{ events[] }` ordered newest first. |

**Admin**:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/admin/wrapped/stats` | Server-wide listening statistics across all users. |
| `POST` | `/api/v1/admin/wrapped/purge` | Delete one user's listening events in a time range. Body: `{ userId, fromMs, toMs }` (`toMs >= fromMs`). Returns `{ ok, deleted }`. |
| `POST` | `/api/v1/admin/wrapped/backfill-folder-metadata` | Backfill vpath/folder metadata for historical events. |
| `GET` | `/api/v1/admin/wrapped/backfill-folder-metadata/preview` | Preview which events would be updated by the backfill (dry run). |

---

## Playlists

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/playlist/getall` | — | The user's playlists: `[{ name, created, songCount, totalDuration }]` (`totalDuration` in seconds). |
| `POST` | `/api/v1/playlist/load` | `{ playlistname }` | Load tracks with full metadata. Each entry includes a stable row `id` for removal. |
| `POST` | `/api/v1/playlist/new` | `{ title }` | Create an empty playlist. 400 if name already exists. |
| `POST` | `/api/v1/playlist/save` | `{ title, songs[], live? }` | Create or overwrite a playlist. `songs` (file paths) is required (`400` without it). `live: true` marks it as a live-synced queue. |
| `POST` | `/api/v1/playlist/add-song` | `{ song, playlist }` | Add a track to a playlist (creates it if missing). |
| `POST` | `/api/v1/playlist/remove-song` | `{ id }` | Remove a track by its row `id` (from `/playlist/load`). |
| `POST` | `/api/v1/playlist/delete` | `{ playlistname }` | Delete a playlist. |
| `POST` | `/api/v1/playlist/rename` | `{ oldName, newName }` | Rename a playlist. 400 if new name already exists. |
| `POST` | `/api/v1/playlist/reorder` | `{ playlistname, ids: number[] }` | Persist a new song order. `ids` is the full list of row IDs (from `/playlist/load`) in the desired sequence. |

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
| `GET` | `/api/v1/shared/:playlistId` | — | Fetch playlist contents + a restricted token for playback. (Public — no auth required.) `410` when the link has expired, `404` when it is unknown. |
| `GET` | `/shared/:playlistId` | — | Public HTML viewer page for a shared playlist. An expired link answers `410` and an unknown one `404`, each with a short HTML error page. |
| `GET` | `/api/v1/download/shared` | — | Download all files in a shared playlist as ZIP. Requires shared-playlist token. |

---

## File Explorer

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/file-explorer` | `{ directory, sort?, pullMetadata? }` | Browse a directory. Pass `""` or `~` to list vpaths. Returns `{ path, directories[], files[] }`. |
| `POST` | `/api/v1/file-explorer/recursive` | `{ directory }` | Recursively list all audio files. Returns array of virtual paths. (integration API, no web UI caller) |
| `POST` | `/api/v1/file-explorer/upload` | Multipart form | Upload a file. Target dir in `data-location` header. Requires `allowUpload`. Filenames sanitized. |
| `POST` | `/api/v1/file-explorer/m3u` | `{ path }` | Parse an M3U playlist file. Returns resolved entries. (integration API, no web UI caller) |

---

## Download

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/download/m3u` | `{ path }` | Download an M3U playlist + all its tracks as a ZIP. |
| `POST` | `/api/v1/download/directory` | `{ directory }` | Download the requested directory (only that folder) as a ZIP. Returns 413 `{ error, maxMb, sizeMb }` above `scanOptions.maxZipMb`. |
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
| `GET` | `/api/v1/db/waveform` | `?filepath=<vpath/file>` | `{ waveform }`: a 600-point amplitude array (0–255) for the progress scrubber. Generated on demand, cached. |

---

## Cue Points *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/db/cuepoints` | `?fp=<vpath/file>` | Track markers from the file's cue sheet (embedded tag or sidecar `.cue`) or M4B chapters. Returns `{ cuepoints: [{ no, title, t }] }` (`[]` when there are none). When the track was never checked, the markers are read from the file on this request and stored in the database (a `[]` result is stored too, so the file is not parsed again; a sidecar `.cue` is still re-checked on every call). Markers always come from the file; the API cannot set them. See [docs/API/db_cuepoints.md](API/db_cuepoints.md). |

---

## Album Art

Cached art is served by `GET /album-art/{file}` and extracted on demand by `GET /api/v1/files/art` (both in **Library** above). Searching and setting covers goes through **Discogs / iTunes** and the **Album-Art Workshop** below.

---

## Discogs / iTunes *(Velvet)*

| Method | Endpoint | Params / Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/discogs/coverart` | `?artist=&title=&album=&year=` | Search Discogs for cover art options. Returns `{ choices[] }`. |
| `POST` | `/api/v1/discogs/embed` | `{ filepath, releaseId?, coverUrl? }` | Embed art from Discogs or a direct URL. Returns `{ ok, aaFile, cacheOnly }`; on rewrite paths, file mtime is synced in DB to avoid stale scan flags. |
| `POST` | `/api/v1/discogs/save-folder-cover` | `{ filepath }` | Admin only. Writes the song's already-cached art as `cover.jpg` in its album folder (no re-download). Updates `cover_file` for all tracks in the album. Returns `{ ok, alreadyExists? }`. |
| `GET` | `/api/v1/discogs/release-images` | `?id=&type=release\|master` | Admin only. Fetch thumbnail choices for a specific Discogs release/master ID. Returns `{ choices[] }`. *(Velvet)* |
| `GET` | `/api/v1/deezer/search` | `?q=` or `?artist=&album=` | Admin only. Search Deezer (part of the Discogs art-lookup flow). |
| `GET` | `/api/v1/itunes/search` | `?artist=&album=` | Admin only. Server-side proxy for the iTunes Search API. Returns structured results. *(Velvet)* |

---

## Album-Art Workshop *(Velvet)*

Admin only. Finds albums (folders) with no cover art, fetches suggestions, and writes `cover.jpg` on approval. The suggestion pass runs through the background broker (serialised, scan-aware). **Source priority: MusicBrainz / Cover Art Archive first** — when an album's tracks carry a MusicBrainz release id (resolved by Tag Workshop enrichment) and the Cover Art Archive holds a front cover, that official cover is the sole suggestion; otherwise it falls back to Discogs → Deezer → iTunes.

| Method | Endpoint | Params / Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/art/status` | — | Worker state, per-status `counts`, per-source `sourceCounts` (for the source chips), current album, and the `autoApprove` / `autoSuggestNewContent` / `coverArtArchive` config. |
| `GET` | `/api/v1/admin/art/candidates` | `?offset=&limit=&status=&source=&q=` | Paginated albums with their cached suggestions. `status` filters by `pending\|suggested\|notfound\|applied\|skipped\|error`; `source` filters by primary suggestion source (`musicbrainz\|discogs\|deezer\|itunes`); `q` matches folder/album/artist. Applied rows include `appliedAaFile` (live cover) + `canRestore`. Returns `{ total, candidates[] }`. |
| `POST` | `/api/v1/admin/art/scan` | `{ source? }` | Reconcile candidates and start a suggestion pass. `source:'musicbrainz'` runs a Cover-Art-Archive-only pass over albums that have a release id. Returns `{ status }`. |
| `POST` | `/api/v1/admin/art/stop` | — | Request the running suggestion pass to stop after the current album. |
| `POST` | `/api/v1/admin/art/suggest` | `{ albumKey, allSources? }` | Re-fetch suggestions for one album now. With `allSources:true`, also queries Discogs/Deezer/iTunes even when a Cover Art Archive cover exists (used by **Seek alternative covers**). Returns `{ status, suggestions }`. |
| `POST` | `/api/v1/admin/art/apply` | `{ albumKey, releaseId? \| coverUrl?, source? }` | Download the chosen cover, write `cover.jpg`, cache + thumbnail it, and point every track at it. **Snapshots the album's prior art first** so it can be restored. Returns `{ ok, aaFile, cover }`. |
| `POST` | `/api/v1/admin/art/apply-batch` | `{ albumKeys: [] }` | Apply the top (preferred) cached suggestion for each selected album in one call. Returns `{ ok, applied[], failed[], appliedCount, failedCount }`. |
| `POST` | `/api/v1/admin/art/restore` | `{ albumKey }` | Undo an applied cover — restore the album's previous art exactly (DB pointers + folder `cover.jpg` from backup, or remove it if the album had none). Returns `{ ok, status, restoredAaFile }`. |
| `GET` | `/api/v1/admin/art/find` | `?q=` | Search **any** album by artist/album (incl. ones that already have art) so a wrong cover can be fixed. Returns `{ albums:[{ albumKey, vpath, dir, album, artist, aaFile, hasArt }] }`. |
| `POST` | `/api/v1/admin/art/fix-suggest` | `{ albumKey }` | Fetch **all-source** suggestions (MusicBrainz + Discogs + Deezer + iTunes) for one album and upsert its workshop row. Returns `{ status, suggestions, current:{ aaFile, hasArt } }`. |
| `POST` | `/api/v1/admin/art/skip` | `{ albumKey }` | Mark an album skipped so it stops resurfacing (kept as a cooldown record). |
| `POST` | `/api/v1/admin/art/config` | `{ autoApprove?, autoSuggestNewContent?, coverArtArchive? }` | Persist workshop settings to config. Returns `{ ok, config }`. |
| `GET` | `/api/v1/admin/art/shelves` | — | List shelved folder prefixes, each with the count of art-less albums it currently suppresses. Returns `{ shelves[] }`. |
| `POST` | `/api/v1/admin/art/shelve` | `{ vpath, prefix }` or `{ folders: [{ vpath, prefix }] }` | Hide one or more folders (and everything under them) from the workshop. Removes matching non-applied candidates immediately. Returns `{ ok, removed, count }`. |
| `POST` | `/api/v1/admin/art/unshelve` | `{ vpath, prefix }` or `{ folders: [{ vpath, prefix }] }` | Un-hide one or more shelved folders; their art-less albums reappear on reconcile. Returns `{ ok, count }`. |

---

## User Settings *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/user/settings` | — | Get the user's saved UI preferences and optional queue. Returns `{ prefs, queue? }`. |
| `POST` | `/api/v1/user/settings` | `{ prefs?, queue? }` | Save UI preferences and/or queue state. |
| `POST` | `/api/v1/user/subsonic-password` | `{ password }` | Set the caller's own Subsonic password. Returns `{}`. |
| `POST` | `/api/v1/user/subsonic-scrobble` | `{ scrobbleLastfm?, scrobbleLb? }` | Turn the caller's own Subsonic scrobble forwarding on or off. Returns `{}`. |

---

## Queue *(Velvet)*

Dedicated queue persistence endpoints — separate from the Subsonic play-queue API.
The full queue (up to 5 000 songs) is stored server-side; the browser caches a
small local window for instant boot, then lazy-loads the rest from here.

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/queue` | — | Return the full saved queue for the authenticated user. Returns the queue object `{ queue[], idx, currentFilepath, time, playing, savedAt, browserId }` or `null`. |
| `POST` | `/api/v1/queue` | queue object | Overwrite the saved queue. Body is the same shape as the GET response. |
| `POST` | `/api/v1/queue/flow` | `{ songs: string[] (2–1000 file paths), pinFirst?: true, energy?: "steady" }` | **Flow the queue**: the given songs back in an order where each flows into the next — the Auto-DJ / AI DJ ordering (tempo ladder in steps of about 2.5%, Camelot key pass, artist spacing, songs without a tempo spread through the list) applied to the listener's own picks. With `pinFirst` the first song stays first (the one playing) and the rest take off from its tempo. `energy` shapes the arc (`steady`, `build`, `peak`, `wave`, `cooldown`). Returns `{ order: number[], unplaced: number[], stats }`: `order` is a permutation of the **input indices** (duplicates keep their identity), songs the caller cannot resolve (missing, outside their libraries) come last in their own order and are listed in `unplaced`; `stats` has `maxStep`, `harmonic`/`transitions`, `withKey`, `withBpm`, `bpmFrom`/`bpmTo`. No model call, works without AI-assist. `400` on an invalid body. |

---

## Scrobbling — Last.fm

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/lastfm/status` | — | Returns `{ serverEnabled, hasApiKey, linkedUser }`. |
| `POST` | `/api/v1/lastfm/connect` | `{ lastfmUser, lastfmPassword }` | Link the current user's Last.fm account. |
| `POST` | `/api/v1/lastfm/disconnect` | — | Unlink Last.fm. |
| `GET` | `/api/v1/lastfm/similar-artists` | `?artist=` | Last.fm similar artists (top 50), resolved to artist names in the library. Returns `{ artists[], displayArtists[], displayVariantMap, variantRankMap }`: `artists` = every matching library artist variant; `displayArtists` = Last.fm names that have albums in the caller's folders; `displayVariantMap` = Last.fm name → library variants; `variantRankMap` = variant → Last.fm rank (1 = most similar). Empty lists without an API key. |
| `GET` | `/api/v1/lastfm/artist-info` | `?artist=` | Artist bio summary (HTML stripped), up to 5 tags and Last.fm counts. Returns `{ bio, tags[], listeners, plays }`, or `{}` without an API key or when Last.fm has no data. |
| `POST` | `/api/v1/lastfm/scrobble-by-filepath` | `{ filePath }` | Scrobble a completed track. Returns `{ scrobbled: true }` when Last.fm accepted it, `false` when the file is unknown to the caller or Last.fm refused it, and `null` when Last.fm is off, has no API key or the user is not linked. |
| `POST` | `/api/v1/lastfm/scrobble-by-metadata` | `{ track, artist?, album? }` | Scrobble by metadata. (integration API, no web UI caller) |

---

## Scrobbling — ListenBrainz *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/listenbrainz/status` | — | Returns `{ serverEnabled, linked }`. |
| `POST` | `/api/v1/listenbrainz/connect` | `{ lbToken }` | Link a ListenBrainz account. |
| `POST` | `/api/v1/listenbrainz/disconnect` | — | Unlink ListenBrainz. |
| `POST` | `/api/v1/listenbrainz/playing-now` | `{ filePath }` | Send a now-playing notification. |
| `POST` | `/api/v1/listenbrainz/scrobble-by-filepath` | `{ filePath }` | Scrobble a completed track. Returns `{ scrobbled: true }` when ListenBrainz accepted it, `false` when the file is unknown to the caller or ListenBrainz refused it, and `null` when ListenBrainz is off or the user is not linked. |

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

> The admin sets up to two webhook slots (name + URL); each user opts in per slot in the Connectors sidebar. On a play Velvet POSTs a JSON payload (`artist`, `album`, `track`, `username`, `timestamp`) to the slot URL. Each POST has a 10 s timeout. LAN targets (private IPs) are allowed on purpose, so a webhook can reach a home-automation box.

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/custom-webhooks/status` | — | Per-slot status for the current user: `{ webhooks: [{ name, serverEnabled, userEnabled, nick }] }`. |
| `POST` | `/api/v1/custom-webhooks/save` | `{ slot, enabled, nick? }` | Save the user's opt-in (and display nick) for one slot. |
| `POST` | `/api/v1/custom-webhooks/scrobble-by-filepath` | `{ filePath, slot }` | Fire one slot's webhook for a track (used by the player). Returns `{ sent }`. |

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
| `PUT` | `/api/v1/radio/stations/reorder` | `{ ids[] }` | Reorder stations. |
| `GET` | `/api/v1/radio/stream` | `?id=` | Proxy the ICY stream for a station. |
| `GET` | `/api/v1/radio/art` | `?id=` | Serve station logo image. |
| `GET` | `/api/v1/radio/nowplaying` | `?id=` | Get ICY now-playing metadata for a station. Returns `{ title, artist, song }`. |
| `GET` | `/api/v1/radio/schedules` | — | List recording schedules. |
| `POST` | `/api/v1/radio/schedules` | `{ stationId, startTime, duration, … }` | Create a recording schedule. |
| `DELETE` | `/api/v1/radio/schedules/:id` | — | Delete a schedule. |
| `PATCH` | `/api/v1/radio/schedules/:id/enable` | `{ enabled: bool }` | Enable or disable a schedule. |
| `GET` | `/api/v1/radio/schedules/active` | — | Get the currently active schedule (if any). |
| `GET` | `/api/v1/radio/record/active` | — | Array of running recordings: `[{ id, stationName, filePath, vpath, filepath, startedAt, bytesWritten }]` (`[]` when idle). `filepath` is the DB path to play from. Needs `allow-radio-recording`. |
| `POST` | `/api/v1/radio/record/start` | `{ stationId }` | Start a live recording. |
| `POST` | `/api/v1/radio/record/stop` | — | Stop the recording. Returns `{ filePath, relPath, bytesWritten, durationMs, vpath, stationName, artFile }`. |

---

## Podcasts *(Velvet)*

> RSS podcast subscriptions with per-episode playback progress. See [docs/API/podcasts.md](API/podcasts.md).

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/podcast/preview` | `?url=` | Preview a feed URL before subscribing: returns title, description, episode count. |
| `GET` | `/api/v1/podcast/feeds` | — | List subscribed feeds. |
| `POST` | `/api/v1/podcast/feeds` | `{ url, name? }` | Subscribe to a feed. `name` overrides the feed's own title. Returns the new feed. |
| `DELETE` | `/api/v1/podcast/feeds/:id` | — | Unsubscribe. |
| `PATCH` | `/api/v1/podcast/feeds/:id` | `{ title?, url? }` (at least one) | Rename a feed or change its URL. Returns the updated feed. |
| `PUT` | `/api/v1/podcast/feeds/reorder` | `{ ids[] }` | Reorder feeds. |
| `POST` | `/api/v1/podcast/feeds/:id/refresh` | — | Force-refresh a feed's episodes. |
| `GET` | `/api/v1/podcast/episodes/:feedId` | — | List episodes for a feed by feed ID. Each row carries `play_position` (seconds) and `played`. |
| `POST` | `/api/v1/podcast/episode/progress` | `{ episodeId, feedId, position, played? }` | Save playback position (seconds) for an episode. Leaving out `played` keeps the stored flag. |
| `GET` | `/api/v1/podcast/episode/:id/progress` | — | `{ episodeId, feedId, play_position, played, duration_secs }` for one of the caller's episodes; `404` otherwise. Read-only status route for outside clients (Home Assistant, mobile); the web player does not call it. |
| `POST` | `/api/v1/podcast/episode/save` | `{ feedId, episodeId }` | Download the episode audio into the caller's first audio-books folder (`<feed title>/<date> <episode title>.<ext>`). Returns `{ savedTo }` (vpath-relative path); `400` when the caller has no audio-books folder. |

---

## YouTube Download *(Velvet)*

> Downloads YouTube audio into the library. See [docs/API/ytdl.md](API/ytdl.md). `metadata` and the download start refuse URLs that are not http(s) or whose host resolves to a private or loopback address (`400`, "That URL is not allowed").

| Method | Endpoint | Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/v1/ytdl/metadata` | `?url=` | Fetch video metadata — returns `{ title, artist, album, year, thumbnail }`. |
| `POST` | `/api/v1/ytdl/` | `{ url, outputCodec?, metadata? }` | Start async download. Returns `{ jobId, message }` immediately. |
| `GET` | `/api/v1/ytdl/downloads` | — | Poll job status. Returns the caller's own jobs (admins: every user's) keyed by `jobId` → `{ status, url, title, started, user, finished?, filePath?, vpath?, filepath?, error? }` (`filepath` = DB path to play from). |

---

## Server Playback (Cast to Server Speaker) *(Velvet)*

> Controls the mpv-based server-side audio player. See [docs/server-audio.md](server-audio.md).
>
> **Access:** `available` is open to any logged-in user. `detect`, `audio-health`, `audio-health/fix` and `test-tone` are admin-only. Every other route needs admin, the `allow-mpv-cast` permission, or server-remote access; otherwise 403. Paths are resolved against the user's own folders; a bad, unreadable or forbidden path answers 404 `{ error: 'File not available' }`.

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/server-playback/available` | — | Whether the player may offer the Server Speaker output. Returns `{ enabled, running, allowed }`; `allowed` is true for admins and users with `allow-mpv-cast`. Never 403. |
| `GET` | `/api/v1/server-playback/status` | — | `{ running, playing, currentTime, duration, currentIndex, queueLength, volume, loopMode, shuffle, queue, currentGainDb }` (`currentGainDb` only while mpv is running). |
| `POST` | `/api/v1/server-playback/set-pause` | `{ paused: bool }` | Start or pause playback. |
| `POST` | `/api/v1/server-playback/pause` | — | Toggle pause (legacy). |
| `POST` | `/api/v1/server-playback/seek` | `{ position }` | Seek to seconds. |
| `POST` | `/api/v1/server-playback/volume` | `{ volume }` (0–130) | Set volume. `400` when `volume` is not a number; other values are clamped to 0–130. |
| `POST` | `/api/v1/server-playback/next` | — | Next track. |
| `POST` | `/api/v1/server-playback/previous` | — | Previous track. |
| `POST` | `/api/v1/server-playback/loop` | — | Cycle loop mode `none` → `one` → `all`. Returns `{ loop_mode }`. |
| `POST` | `/api/v1/server-playback/play` | `{ file: { filepath, title?, artist?, album?, albumArt?, seekTo?, rgEnabled?, rgMode?, rgPreamp?, rgClip? } }` | Clear queue, add one file, start playback. (integration API, no web UI caller) |
| `POST` | `/api/v1/server-playback/queue/add` | `{ filepath, title?, artist?, album?, albumArt?, seekTo?, rgEnabled?, rgMode?, rgPreamp?, rgClip? }` | Append a file to the queue. Returns `{ index }`. |
| `POST` | `/api/v1/server-playback/queue/add-many` | `{ files: [{ filepath, title?, artist?, album?, albumArt?, seekTo?, rgEnabled?, rgMode?, rgPreamp?, rgClip? }] }` | Append multiple files, all or nothing: every file is located and mpv is started before the first one is queued, so a bad path leaves the queue unchanged. Returns `{ indices[] }`. (integration API, no web UI caller) |
| `POST` | `/api/v1/server-playback/queue/play-index` | `{ index }` | Jump to queue index. |
| `POST` | `/api/v1/server-playback/queue/remove` | `{ index }` | Remove track at index. |
| `POST` | `/api/v1/server-playback/queue/clear` | — | Clear the queue. |
| `GET` | `/api/v1/server-playback/detect` | — | Detect mpv binary. Returns `{ found, version, path }`. |
| `GET` | `/api/v1/server-playback/audio-health` | — | ALSA/audio health check. Returns `{ platform, mpv: { found, path, version, error }, alsa: { amixerFound, aplayFound, controls, inspected, mutedControls, cards }, healthy, issues[] }`. |
| `POST` | `/api/v1/server-playback/audio-health/fix` | — | Attempt auto-fix (unmute ALSA master). |
| `POST` | `/api/v1/server-playback/test-tone` | — | Play a 3 s stereo test tone (440 Hz left, 880 Hz right). `409` when mpv is not running. |
| `POST` | `/api/v1/server-playback/heartbeat` | — | Keep-alive from the remote UI. Resets idle timeout. |
| `POST` | `/api/v1/server-playback/reapply-gain` | `{ gainDb?, volumePct?, balance? }` | Re-apply gain, volume and balance to the loaded track (after a settings change). `400` when a value is not a finite number; `gainDb` is clamped to −30…+20 dB (the same clamp applies to ReplayGain/preamp gain when a track is added). |
| `GET` | `/server-remote` | — | Static HTML for the server-audio player UI (also `/server-remote/` and `/server-remote/index.html`). While Server Audio is off it shows a short "not enabled" page with a link to the admin panel. |

---

## Jukebox (Remote Control)

> Remote-control mode: a separate device controls the player via a one-time code. A session starts when the player opens a WebSocket to the server (`?token=<jwt>`); the server replies with `{ code, token }` and the session ends when the socket closes. See [docs/API/jukebox_sessions.md](API/jukebox_sessions.md).

**Authenticated endpoints**:

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/jukebox/sessions` | — | Admin only. List all active jukebox sessions. Returns `{ sessions: [{ code, token, startTime, url }] }`. (integration API, no web UI caller) |
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
| `POST` | `/api/v1/acoustid/start` | — | Start fingerprinting all unfingerprinted tracks. `400` while AcoustID is off or has no API key; answers `pending: true` while a file scan runs (the job starts after it). |
| `POST` | `/api/v1/acoustid/stop` | — | Stop the running job. |
| `POST` | `/api/v1/acoustid/scan-files` | `{ files: [{ filepath, vpath }] }` (first 500 used) | Queue specific files for fingerprinting (resets their status) and start the worker. Returns `{ ok, queued, workerStarted }`. *(Velvet)* |
| `POST` | `/api/v1/acoustid/reset-errors` | — | Re-queue all errored files for fingerprinting. *(Velvet)* |
| `POST` | `/api/v1/acoustid/reset-not-found` | — | Re-queue all `not_found` files for fingerprinting. Returns `{ reset, workerStarted }`. *(Velvet)* |

---

## Tag Workshop *(Velvet)*

> Batch metadata enrichment via AcoustID/MusicBrainz fingerprint lookup. See [docs/tag-workshop.md](tag-workshop.md). All endpoints are admin only.

| Method | Endpoint | Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/v1/tagworkshop/status` | — | Combined status, including `enrich: { running, stopping }` and `textSearch: { queued, found, not_found, skipped, errors, running, stopping }`. |
| `GET` | `/api/v1/tagworkshop/folder` | `?path=<vpath/folder>` | Audio files directly in one folder, with their DB tags and any MusicBrainz data. Child vpaths are resolved to their parent. Returns `{ files }`. |
| `POST` | `/api/v1/tagworkshop/enrich/start` | `{ vpaths? }` | Start the enrichment job. |
| `POST` | `/api/v1/tagworkshop/enrich/stop` | — | Stop the running job. |
| `POST` | `/api/v1/tagworkshop/enrich/files` | `{ files: [{ filepath, vpath }] }` (max 500) | Queue specific files for enrichment and start the worker. Returns `{ ok, queued, workerStarted }`. |
| `GET` | `/api/v1/tagworkshop/enrich/errors` | — | List tracks where enrichment failed. |
| `POST` | `/api/v1/tagworkshop/enrich/retry-errors` | — | Retry failed tracks. |
| `GET` | `/api/v1/tagworkshop/albums` | — | Albums with pending tag suggestions. |
| `GET` | `/api/v1/tagworkshop/album/:mb_release_id` | — | Full suggestion for one MusicBrainz release. |
| `POST` | `/api/v1/tagworkshop/accept-track` | `{ filepath, … }` | Accept tags for a single track. |
| `POST` | `/api/v1/tagworkshop/skip` | `{ mb_release_id }` | Shelve a release (skip for now). |
| `POST` | `/api/v1/tagworkshop/unshelve` | `{ mb_release_id }` | Restore a shelved release. |
| `GET` | `/api/v1/tagworkshop/shelved` | — | List shelved releases. |
| `POST` | `/api/v1/tagworkshop/bulk-accept-casing` | `{ mb_release_id }` | Accept only casing/punctuation normalisation for a release. |
| `POST` | `/api/v1/tagworkshop/text-search/start` | — | Start the MusicBrainz text-search fallback job (for `acoustid_status='not_found'` files). |
| `POST` | `/api/v1/tagworkshop/text-search/stop` | — | Stop the running text-search job. |
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

## Admin — Configuration

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/config` | — | Full server configuration. |
| `POST` | `/api/v1/admin/lock-api` | `{ lock: bool }` | Lock or unlock the admin API. |
| `POST` | `/api/v1/admin/config/port` | `{ port }` | Change port (triggers restart). |
| `POST` | `/api/v1/admin/config/address` | `{ address }` | Change listen address. |
| `POST` | `/api/v1/admin/config/secret` | `{ strength }` | Regenerate JWT secret (invalidates all tokens). |
| `POST` | `/api/v1/admin/config/noupload` | `{ noUpload: bool }` | Toggle uploads server-wide. |
| `POST` | `/api/v1/admin/config/write-logs` | `{ writeLogs: bool }` | Toggle writing logs to disk. |
| `POST` | `/api/v1/admin/config/log-retention` | `{ logRetention: "1d"\|"3d"\|"7d"\|"14d"\|"30d" }` | How long log files are kept. |
| `POST` | `/api/v1/admin/config/max-request-size` | `{ maxRequestSize: "50MB" }` | Set max request body size. |
| `POST` | `/api/v1/admin/config/theme` | `{ ui: "velvet"\|"velvet-dark"\|"velvet-light" }` | Set the default theme. |
| `POST` | `/api/v1/admin/config/skin` | `{ skin: "goud"\|"" }` | Set the default skin (`""` = none). The skin must exist; see [skins.md](skins.md). 400 for an unknown skin. |

---

## Admin — Libraries (vpaths)

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/directories` | — | List all libraries. |
| `PUT` | `/api/v1/admin/directory` | `{ directory, vpath, autoAccess?, isAudioBooks?, isRecording?, isYoutube?, allowRecordDelete?, isExcluded?, artistsOn?, … }` | Add a library. |
| `DELETE` | `/api/v1/admin/directory` | `{ vpath }` | Remove a library. |
| `PATCH` | `/api/v1/admin/directory/flags` | `{ vpath, albumsOnly?, allowRecordDelete?, dlnaEnabled?, artistsOn? }` (at least one) | Update per-folder flags. `allowRecordDelete` is for recordings/YouTube folders, `albumsOnly`/`dlnaEnabled` for music/audio-book folders, `artistsOn` for any non-excluded folder (changing it rebuilds the artist index). Returns `{}`. *(Velvet)* |
| `PATCH` | `/api/v1/admin/directory/type` | `{ vpath, type: "music"\|"audio-books"\|"recordings"\|"youtube"\|"excluded" }` | Change a folder's type. Setting `excluded` starts a scan of the parent so its rows are purged. *(Velvet)* |
| `PATCH` | `/api/v1/admin/directory/root` | `{ vpath, root }` | Change a folder's disk path. Returns `{ restartRequired: true }`. *(Velvet)* |
| `PATCH` | `/api/v1/admin/directory/users` | `{ vpath, users[] }` | Set which users can see a folder. *(Velvet)* |

---

## Admin — Users

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/users` | — | List all users with their permissions. |
| `PUT` | `/api/v1/admin/users` | `{ username, password, vpaths[], admin? }` | Create a user. |
| `DELETE` | `/api/v1/admin/users` | `{ username }` | Delete a user. |
| `POST` | `/api/v1/admin/users/password` | `{ username, password }` | Change a user's password. This logs that user out everywhere (their older tokens stop working). When the admin changes their own password the answer is `{ token }` (a fresh token, also set as cookie), otherwise `{}`. |
| `POST` | `/api/v1/admin/users/revoke-tokens` | `{ username }` | "Log out everywhere" (Admin → Users → Password button → Sessions): every token issued to that user before now stops working. Same answer as the password route (`{ token }` when it is the admin's own account, else `{}`). *(Velvet)* |
| `POST` | `/api/v1/admin/users/subsonic-password` | `{ username, password }` | Set a user's Subsonic password. *(Velvet)* |
| `POST` | `/api/v1/admin/users/vpaths` | `{ username, vpaths[] }` | Update library access. |
| `POST` | `/api/v1/admin/users/access` | `{ username, admin }` | Set or clear the admin role. |
| `POST` | `/api/v1/admin/users/allow-mpv-cast` | `{ username, allow: bool }` | Toggle server-playback (mpv cast) permission. *(Velvet)* |
| `POST` | `/api/v1/admin/users/allow-server-remote` | `{ username, allow: bool }` | Toggle access to the `/server-remote` page. *(Velvet)* |
| `POST` | `/api/v1/admin/users/allow-radio-recording` | `{ username, allow: bool }` | Toggle radio recording permission. *(Velvet)* |
| `POST` | `/api/v1/admin/users/allow-youtube-download` | `{ username, allow: bool }` | Toggle YouTube download permission. *(Velvet)* |
| `POST` | `/api/v1/admin/users/allow-upload` | `{ username, allow: bool }` | Toggle upload permission. *(Velvet)* |

---

## Admin — Scanner

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/db/params` | — | Get all scanner settings. |
| `POST` | `/api/v1/admin/db/scan/all` | — | Scan all libraries. |
| `POST` | `/api/v1/admin/db/scan/stop` | — | Stop the running scan. *(Velvet)* |
| `GET` | `/api/v1/admin/db/scan/resume-state` | — | Libraries whose last scan can be resumed. Returns `{ resumable }`. *(Velvet)* |
| `POST` | `/api/v1/admin/db/scan/clear-state` | — | Forget all saved scan-resume state. *(Velvet)* |
| `GET` | `/api/v1/admin/db/scan/stats` | — | Library totals (tracks, albums, waveform count, …). |
| `GET` | `/api/v1/admin/db/scan/progress` | — | Per-library scan progress. Returns `[{ vpath, pct, scanned, expected, currentFile }]`. *(Velvet)* |
| `GET` | `/api/v1/admin/db/scan-errors` | — | List scan errors (files the scanner could not process). |
| `DELETE` | `/api/v1/admin/db/scan-errors` | — | Clear all scan errors. |
| `GET` | `/api/v1/admin/db/scan-errors/count` | — | Returns `{ count }` of current scan errors. |
| `POST` | `/api/v1/admin/db/scan-errors/fix` | — | Attempt to re-process all scan-errored files. |
| `POST` | `/api/v1/admin/db/params/scan-interval` | `{ scanInterval }` | Scheduled rescan interval in hours (0 = disabled). Returns `{ nextScanAt }`. |
| `POST` | `/api/v1/admin/db/params/scan-start-time` | `{ scanStartTime: "HH:MM" \| null }` | Time of day the scheduled scan starts. Returns `{ nextScanAt }`. *(Velvet)* |
| `POST` | `/api/v1/admin/db/params/skip-img` | `{ skipImg: bool }` | Skip album art extraction during scan. |
| `POST` | `/api/v1/admin/db/params/boot-scan-delay` | `{ bootScanDelay }` | Seconds to wait before scanning on boot. |
| `POST` | `/api/v1/admin/db/params/boot-scan-enabled` | `{ bootScanEnabled: bool }` | Scan on boot or not. *(Velvet)* |
| `POST` | `/api/v1/admin/db/params/max-concurrent-scans` | `{ maxConcurrentTasks }` | Max parallel scan workers. |
| `POST` | `/api/v1/admin/db/params/compress-image` | `{ compressImage: bool }` | Generate album art thumbnails. |
| `POST` | `/api/v1/admin/db/params/allow-id3edit` | `{ allowId3Edit: bool }` | Allow tag editing from the player. *(Velvet)* |
| `POST` | `/api/v1/admin/db/params/max-recording-minutes` | `{ maxRecordingMinutes }` | Longest allowed radio recording. *(Velvet)* |
| `POST` | `/api/v1/admin/db/params/max-zip-mb` | `{ maxZipMb }` | Size cap for ZIP downloads. *(Velvet)* |
| `POST` | `/api/v1/admin/db/params/album-category-folders` | `{ folders: string[] }` (max 50) | Folder names the Album Library treats as categories, not albums. *(Velvet)* |
| `POST` | `/api/v1/admin/db/force-compress-images` | — | Re-run thumbnail compressor over the whole library. Returns `{ started }`. |
| `GET` | `/api/v1/admin/db/album-version-inventory` | — | Count of files grouped by `album_version_source` (which tag or method produced the version value). Returns `[{ source, count }]`. *(Velvet)* |
| `POST` | `/api/v1/admin/db/params/album-version-tags` | `{ tags: ["TIT3", "TXXX:EDITION", …] }` | Update the ordered list of tag fields the scanner uses to detect album version/edition. Max 20 entries. *(Velvet)* |
| `POST` | `/api/v1/admin/db/purge-orphaned-vpaths` | `{ dryRun?: bool }` | Detect (and optionally delete) rows in the `files` table whose vpath no longer exists in config — left behind after a folder rename or removal. `dryRun: true` returns `{ orphaned, deleted: 0 }` without modifying the DB. Admin only; answers 405 while the admin API is locked. *(Velvet)* |
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
| `POST` | `/api/v1/admin/transcode/enable` | `{ enable: bool }` | Turn transcoding on or off. |
| `POST` | `/api/v1/admin/transcode/default-codec` | `{ defaultCodec: "mp3"\|"opus"\|"aac" }` | Set default codec. |
| `POST` | `/api/v1/admin/transcode/default-bitrate` | `{ defaultBitrate: "64k"\|"96k"\|"128k"\|"192k" }` | Set default bitrate. |
| `POST` | `/api/v1/admin/transcode/default-algorithm` | `{ algorithm: "stream"\|"buffer" }` | Set default transcode method. |
| `POST` | `/api/v1/admin/transcode/download` | — | Download the bundled ffmpeg binary. |

---

## Admin — DLNA

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/dlna/config` | — | DLNA config: `{ enabled, port, name, running }`. |
| `POST` | `/api/v1/admin/dlna/config` | `{ enabled?, port? (1024–65535), name? }` | Update DLNA config (at least one field; any other field, such as the old `browse`, answers `400`). Starts/stops the DLNA server live. Returns `{ running }`. |

The DLNA server itself runs on its own port (default 10293) and answers UPnP requests, not JSON:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/dlna/description.xml` | UPnP device description. |
| `GET` | `/dlna/scpd/content-directory.xml` | ContentDirectory service description. |
| `GET` | `/dlna/scpd/connection-manager.xml` | ConnectionManager service description. |
| `POST` | `/dlna/control/content-directory` | ContentDirectory SOAP control (Browse, Search, …). |
| `POST` | `/dlna/control/connection-manager` | ConnectionManager SOAP control. |

The DLNA port also serves the audio itself under `/media/<vpath>/<path>` and cached covers under `/album-art/`, without authentication (LAN only). Browse, BrowseMetadata, Search and `/media` only reach files inside folders with `dlnaEnabled` on. See [docs/dlna.md](dlna.md).

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
| `POST` | `/api/v1/admin/discord-webhook/config` | `{ enabled, url }` | Update config. URL must be a `discord.com` or `discordapp.com` webhook URL. |

---

## Admin — Custom Webhooks Config *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/custom-webhooks/config` | — | The two webhook slots: `{ webhooks: [{ name, url, enabled }] }`. |
| `POST` | `/api/v1/admin/custom-webhooks/config` | `{ webhooks: [{ name, url, enabled }] }` (max 2) | Save the slots. `url` must be `http` or `https`. |

---

## Admin — Genre Groups *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/genre-groups` | — | Genre display groupings: `{ groups: [{ name, genres[] }], allGenres[], isDefault }`. `isDefault` is true while no groups are saved (the groups are then made automatically). |
| `POST` | `/api/v1/admin/genre-groups` | `[{ name, genres[] }]` (a bare array) | Replace the groupings. Returns `{ ok }`. |

---

## Admin — Server Playback *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/server-audio` | — | Get Server Audio config: `{ enabled, mpvBin, autoUnmute, running }`. |
| `POST` | `/api/v1/admin/server-audio` | `{ enabled?, mpvBin?, autoUnmute? }` (at least one) | Save config; `enabled: true` starts mpv, `false` stops it. |
| `POST` | `/api/v1/admin/server-audio/start` | — | Start the mpv process. |
| `POST` | `/api/v1/admin/server-audio/stop` | — | Stop the mpv process. |

---

## Sonos *(Velvet)*

> Active cast to Sonos devices via UPnP/SOAP. See [docs/sonos.md](sonos.md).
>
> **Access:** every `/api/v1/sonos/*` route except the device callback `/event` needs an admin or a user with the `allow-mpv-cast` permission; anyone else gets `403 { error: 'Not allowed' }`. Routes marked **Admin** need an admin. Where a route takes `ip`, it falls back to the saved default room when left out.

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/sonos/devices` | — | `{ rooms, lastScan, cached, defaultRoom, enabled, transcodeOpus, sleepEnabled }`. Re-discovers when the cached list is older than 5 minutes. |
| `POST` | `/api/v1/sonos/scan` | `{ seedIp? }` | Force re-discovery (optionally starting from one speaker IP). |
| `GET` | `/api/v1/sonos/probe?ip=` | — | Probe a single IP — returns room name, UUID, reachability. |
| `POST` | `/api/v1/sonos/save-default` | `{ ip, name, uuid? }` | **Admin.** Save a room as the default cast target. |
| `POST` | `/api/v1/sonos/cast` | `{ ip?, filepath, title?, artist?, album?, aaFile?, seekTo?, paused? }` | Cast one track (`filepath` with vpath prefix). Returns `{ ok, ip, actualIp, title, artist, streamUrl, streamStartOffset, isTranscodeStream }`. |
| `POST` | `/api/v1/sonos/set-pause` | `{ ip?, paused }` | Pause or resume. |
| `POST` | `/api/v1/sonos/seek` | `{ ip?, position }` | Seek to `position` seconds. |
| `POST` | `/api/v1/sonos/set-volume` | `{ ip?, volume, muted? }` | Set volume (0–100); `muted: true` sets 0. |
| `GET` | `/api/v1/sonos/battery?ip=` | — | Battery status for portable devices (Roam, Roam 2, Move, Move 2). Returns `{ supported, level, powerSource, health, temperature }`. Mains-powered devices return `{ supported: false }`. |
| `GET` | `/api/v1/sonos/device-info?ip=` | — | Device info from `/status/zp` + `/status/wireless`. Returns `{ zoneName, model, firmware, firmwareDate, ipAddress, macAddress, seriesId, wifi, wifiMode, sonosNetPeers }`. |
| `GET` | `/api/v1/sonos/transport-status?ip=` | — | Poll playback state: `{ playing, paused, stopped, state, position, duration, track, nrTracks, trackUri, trackFp, trackTitle, trackArtist, trackAlbum, trackArt, serverAdvanced }`. `serverAdvanced` is `null`, or `{ fp, position }` when the server auto-advanced the speaker to the caller's next queued track while their player was asleep and that player has not caught up yet (see `docs/sonos.md`). The player's own background poll only reads `stopped`/`unreachable` from this (reachability + stopped-while-should-be-playing self-heal — see `docs/sonos.md`); it does not use `track`/`nrTracks`/`trackFp` to decide what should be playing. The `track*` metadata fields still drive now-playing display for external Sonos-Favourite content (Spotify, radio, etc. played from the Sonos app), which is a separate feature from queue casting. |
| `POST` | `/api/v1/sonos/cast-queue` | `{ ip, tracks[], index, seekTo?, paused?, reason? }` | Cast track(s) to the Sonos queue, replacing its current contents. `reason` (≤160 chars, log only) is the client's note on why this cast happened — e.g. the speaker finished the previous track while the web player's clock was behind — and is appended to the `cast-queue ▶` server log line. Response `{ ok, actualIp, count, index, streamStartOffset, isTranscodeStream }` — or `{ ok, alreadyPlaying: true, position, actualIp }` when the server itself already started this exact track via auto-advance while the player was asleep (see `docs/sonos.md`): the player positions its mirror at `position` instead of restarting the speaker. One-shot. The player calls this with a single track: the web UI's queue is the source of truth for what plays, so every track change re-casts rather than relying on the device to advance through a pre-loaded window — see `docs/sonos.md`. Still accepts multiple tracks for other callers. |
| `POST` | `/api/v1/sonos/queue/append` | `{ ip, tracks[] }` | Append tracks to the end of the Sonos queue **without wiping it**. (integration API, no web UI caller) |
| `POST` | `/api/v1/sonos/queue/trim` | `{ ip, currentTrack, keep? }` | Remove already-played tracks from the front of the device's queue (`RemoveTrackRangeFromQueue`), keeping `keep` (default 2) for history. Playback is undisturbed. (integration API, no web UI caller) |
| `GET` | `/api/v1/sonos/events/stream` | — | Server-sent events: transport changes the speaker pushes to Velvet (UPnP GENA) forwarded as `data:` frames. (integration API, no web UI caller) |
| `NOTIFY` | `/api/v1/sonos/event` | UPnP `LastChange` XML | **Device callback — not for clients.** Registered before auth because the speaker cannot present a token; accepts only private-LAN peers presenting a subscription ID Velvet issued (`403` / `412` otherwise), with a 256 KB body cap. |
| `POST` | `/api/v1/sonos/queue/jump` | `{ ip, track }` | Jump to a track already in the Sonos queue by 1-based position (`Seek TRACK_NR`). (integration API, no web UI caller) `409` if `track` is beyond the queue length. |
| `POST` | `/api/v1/sonos/queue/clear` | `{ ip }` | Wipe the Sonos queue **only if every track is Velvet's** (a user-built/foreign queue is left untouched). Called when casting stops. |
| `GET` | `/api/v1/sonos/favorites?ip=` | — | Return **all** "My Favorites" (FV:2) — Sonos Radio, Spotify, Apple Music, TuneIn, etc. Each entry is tagged with `service`/`serviceKey` and carries the playable `res`/`resMD` plus `isContainer`. |
| `GET` | `/api/v1/sonos/radio-favorites?ip=` | — | The Sonos Radio subset of favourites (directly playable from the local Sonos MusicServices bridge). (integration API, no web UI caller) |
| `POST` | `/api/v1/sonos/play-favorite` | `{ ip, favoriteId }` | Play any favourite by its FV:2 id, regardless of service. Replays the favourite's own stored `res`/`resMD` (which carries the device's service auth), so Spotify/Apple Music playlists work. Containers are enqueued; single streams set directly on the transport. |
| `POST` | `/api/v1/sonos/favorite-visibility` | `{ key, hidden }` | **Admin.** Hide or show a favourite in Velvet's Sonos view. `key` is the favourite's stable content key (from `/favorites`). Persisted in config as `sonos.hiddenFavorites` (applies to all users). |
| `GET` | `/api/v1/sonos/browse-content?ip=&objectId=` | — | Browse a Sonos ContentDirectory object (also `browseFlag=BrowseMetadata`, `startingIndex`, `requestedCount`, default 100). Returns `{ ok, objectId, items, totalMatches }`. |
| `POST` | `/api/v1/sonos/play-cloud-object` | `{ ip?, cloudObjectId, title?, authToken? }` | Start a Sonos cloud object (for example a Sonos Radio station) on the speaker: tries a direct radio URI first, then SMAPI resolution, then a DIDL reference. Returns `{ ok, playing, via }` on the first two paths. |
| `GET` | `/api/v1/sonos/transcode-stream?fp=&token=` | — | Stream a Sonos-incompatible file as MP3 (192 k @ 48 kHz) via ffmpeg. Used automatically when Auto-transcode is enabled and the file is Opus or hi-res (>48 kHz). |
| `POST` | `/api/v1/sonos/test-play` | `{ ip }` | **Admin only.** Play a random MP3 from the library on the given speaker (test). |
| `GET` | `/api/v1/sonos/sleep?ip=` | — | Read the speaker's native sleep timer. Returns `{ ok, active, remaining, generation, raw }` (`remaining` in seconds). |
| `POST` | `/api/v1/sonos/sleep` | `{ ip, seconds?, minutes?, play? }` | Set or clear the native Sonos sleep timer (`ConfigureSleepTimer`). `seconds`/`minutes` ≤ 0 clears it; `play: true` also resumes playback on wake. Returns `{ ok, active, remaining, requested }`. |
| `GET` | `/api/v1/sonos/led?ip=` | — | Read the status-LED state (`GetLEDState`). Returns `{ ok, state }` (`On`/`Off`). |
| `POST` | `/api/v1/sonos/led` | `{ ip, state }` | Set the status-LED state (`SetLEDState`, `On`/`Off`). Used as the sleep-mode visual cue. Returns `{ ok, state }`. |
| `POST` | `/api/v1/admin/sonos` | `{ enabled?, transcodeOpus?, sleepEnabled? }` (at least one, booleans) | Save Sonos config (admin only). Returns `{ ok, enabled, transcodeOpus, sleepEnabled }`. `transcodeOpus: true` enables auto-transcode for Opus and hi-res files. `sleepEnabled: true` turns on sleep mode — when casting, pausing drops the speaker's status LED (direct sleep) and resuming turns it back on. |

---

## Velvet Rooms *(Velvet)*

> Server-side queue played on speakers that implement the Sendspin protocol (works with Sendspin speakers). Full contract — object shapes, limits, error codes, polling — in [API/rooms.md](API/rooms.md). Player routes need `allow-mpv-cast` (or admin) and return `409 { code: "rooms_disabled" }` while the feature is off; the room list itself answers `200` with `enabled: false`.

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/sendspin/status` | — | **Admin.** `{ enabled, running, name, port, serverId, serverIdShort, error, devices[], rooms[] }`. |
| `POST` | `/api/v1/admin/sendspin/settings` | `{ enabled?, name?, port? }` | **Admin.** Save settings; returns the status. |
| `POST` | `/api/v1/admin/sendspin/devices/approve` | `{ clientId }` | **Admin.** Allow a device unpaired access. |
| `POST` | `/api/v1/admin/sendspin/devices/revoke` | `{ clientId }` | **Admin.** Revoke unpaired access. |
| `POST` | `/api/v1/admin/sendspin/devices/rename` | `{ clientId, name }` | **Admin.** Rename a device (playback continues). |
| `POST` | `/api/v1/admin/sendspin/devices/forget` | `{ clientId }` | **Admin.** Unpair, revoke and remove a device. |
| `POST` | `/api/v1/admin/sendspin/devices/connect` | `{ clientId }` | **Admin.** Connect now (also takes a device back from another server). |
| `POST` | `/api/v1/admin/sendspin/devices/add` | `{ address }` | **Admin.** Dial a speaker by LAN IP address (`ip`, `ip:port`, `[v6]:port` or `ws://ip:port/path`), for speakers mDNS does not find. Remembered across restarts until forgotten. |
| `POST` | `/api/v1/admin/sendspin/devices/unpair` | `{ clientId }` | **Admin.** `server/unpair` + delete the pairing record. |
| `POST` | `/api/v1/admin/sendspin/devices/pair-token` | `{ pairingToken, clientId? }` | **Admin.** Pair with a pairing token (lenient decoding); `result: 'pairing' \| 'staged'`. |
| `POST` | `/api/v1/admin/sendspin/devices/pair-code/start` | `{ clientId }` | **Admin.** Start code pairing; returns `PairStatus`. |
| `GET` | `/api/v1/admin/sendspin/devices/pair-code/status?clientId=` | — | **Admin.** `PairStatus`: `waiting` / `pending {message}` / `need_code` / `wrong_code` / `paired` / `aborted {reason}`. |
| `POST` | `/api/v1/admin/sendspin/devices/pair-code/submit` | `{ clientId, code }` | **Admin.** Submit the 6- or 8-digit code. |
| `POST` | `/api/v1/admin/sendspin/devices/pair-code/cancel` | `{ clientId }` | **Admin.** Cancel (`pair/abort user_cancelled`). |
| `POST` | `/api/v1/admin/sendspin/devices/source` | `{ clientId, allowed }` | **Admin.** Allow / disallow a paired or approved device as a line-in source (explicit, separate from playback approval). |
| `POST` | `/api/v1/admin/sendspin/devices/source-auto` | `{ clientId, autoSwitch, roomId? }` | **Admin.** Auto-switch: start the line-in when the device reports signal, stop when it goes. |
| `GET` | `/api/v1/rooms` | — | Rooms with members and live state, plus the line-in `sources` a room can play. Also the player's capability check. |
| `POST` | `/api/v1/rooms` | `{ name, members[] }` | Create a room from speakers (they leave their old rooms). |
| `PATCH` | `/api/v1/rooms/:id` | `{ name?, members? }` | Rename / set members (moves speakers). |
| `DELETE` | `/api/v1/rooms/:id` | — | Dissolve a room; members return to solo rooms. |
| `GET` | `/api/v1/rooms/:id/state` | — | Room state; polled ~1 s by the remote UI. Includes `scrobble: { lastfm, listenbrainz } \| null`, the current song's scrobble state (rooms scrobble, count plays and record Wrapped statistics on the server for the user who last controlled them — see [API/rooms.md](API/rooms.md#listening-scrobbles-play-counts-statistics)). |
| `GET` | `/api/v1/rooms/:id/queue` | — | `{ queueVersion, index, songs[] }`. |
| `POST` | `/api/v1/rooms/:id/play` | `{ songs[], index?, positionMs?, paused?, rgEnabled?, rgMode?, rgPreamp?, rgClip? }` | Hand a queue to the room (replaces its queue); `skipped` counts unresolvable songs. |
| `POST` | `/api/v1/rooms/:id/add` | `{ songs[], next?, queueVersion?, rgEnabled?, rgMode?, rgPreamp?, rgClip? }` | Append (or insert after current with `next`). `queueVersion` → `409 queue_changed` if the queue changed meanwhile. |
| `POST` | `/api/v1/rooms/:id/jump` | `{ index }` | Play the queue entry at `index`. |
| `POST` | `/api/v1/rooms/:id/remove` | `{ indexes[], queueVersion? }` | Remove queue entries; removing the current one plays the next. The current track is never interrupted otherwise. |
| `POST` | `/api/v1/rooms/:id/move` | `{ from, to, queueVersion? }` | Move one queue entry (`to` = its final index). |
| `POST` | `/api/v1/rooms/:id/reorder` | `{ order[], queueVersion? }` | New queue order as a permutation of the current indexes. |
| `POST` | `/api/v1/rooms/:id/pause` | — | Pause. |
| `POST` | `/api/v1/rooms/:id/resume` | — | Resume (an idle room resumes what it last played). |
| `POST` | `/api/v1/rooms/:id/next` | — | Next track. |
| `POST` | `/api/v1/rooms/:id/previous` | — | Previous track (restart when > 3 s in). |
| `POST` | `/api/v1/rooms/:id/seek` | `{ positionMs }` | Seek in the current track. |
| `POST` | `/api/v1/rooms/:id/volume` | `{ volume, clientId? }` | Group volume, or one speaker with `clientId`. |
| `POST` | `/api/v1/rooms/:id/mute` | `{ muted, clientId? }` | Group mute, or one speaker. |
| `POST` | `/api/v1/rooms/:id/stop` | — | Stop; response carries `stoppedAt: { index, positionMs }`. |
| `POST` | `/api/v1/rooms/:id/repeat` | `{ repeat }` | `'off' \| 'all' \| 'one'`. |
| `POST` | `/api/v1/rooms/:id/shuffle` | `{ shuffle }` | Shuffle on/off. |
| `GET` | `/api/v1/rooms/:id/eq` | — | The room's 8-band EQ `{ enabled, gains[8], preset }` (also in the room state as `eq`). |
| `PUT` | `/api/v1/rooms/:id/eq` | `{ enabled, gains[8], preset? }` | Set the room EQ (gains −12…12 dB, same bands as the web player). Takes effect within about a second while playing, without stopping the song. |
| `GET` | `/api/v1/rooms/:id/autodj` | — | `{ on, state }`: the room's Auto-DJ and its DJ state (artist cooldown, BPM/year/genre history). |
| `PUT` | `/api/v1/rooms/:id/autodj` | `{ on, settings?, state?, rg…? }` | Switch the room's server-side Auto-DJ, with the web player's Auto-DJ settings and DJ state so it picks exactly the same way; also in the room state as `autoDj`. |
| `POST` | `/api/v1/rooms/:id/line-in` | `{ clientId }` | Play a source device's input (line-in) in the room; the queue pauses underneath. |
| `POST` | `/api/v1/rooms/:id/line-in/stop` | — | Stop the line-in; the room returns to its paused queue. |
| `GET` | `/api/v1/rooms/sonos` | — | Sonos speakers that can follow a room: `{ enabled, maxTrimMs, devices[] }`. |
| `POST` | `/api/v1/rooms/:id/sonos` | `{ uuid, trimMs? }` | A Sonos follows the room (live stream; Velvet measures and corrects its lead). |
| `PATCH` | `/api/v1/rooms/:id/sonos/:uuid` | `{ trimMs }` | Change its fine-tune (−1000 to 1000 ms). |
| `DELETE` | `/api/v1/rooms/:id/sonos/:uuid` | — | It stops following (and is stopped if it still plays the room). |
| `GET` | `/api/v1/rooms/sonos-stream/:token.mp3` | — | **No auth** — the live stream a following Sonos pulls; per-session token, LAN peers only. The same path with `.jpg` gives the cover of the song the room plays now. |

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
| `GET` | `/api/v1/admin/artists/image-audit` | `?kind=missing\|no-image\|wrong\|with-image&limit=200` | Artists by image state. Returns `{ kind, counts, artists }`. |
| `GET` | `/api/v1/admin/artists/discogs-candidates` | `?artistKey=` | Search Discogs for artist image candidates. |
| `GET` | `/api/v1/admin/artists/tadb-candidates` | `?artistKey=` | Search TheAudioDB for artist image candidates. |
| `POST` | `/api/v1/admin/artists/apply-image` | `{ artistKey, imageUrl, source? }` | Download and apply an artist image from a URL. Returns `{ ok, imageFile, imageSource }`. |
| `POST` | `/api/v1/admin/artists/enrich-tadb` | — | Queue TheAudioDB enrichment (bio, fanart, genre) for all artists that lack it, and re-queue artists with no image and no data. Returns `{ ok, reset, enqueued, message }`. |
| `GET` | `/api/v1/admin/artists/hydration-status` | — | Status of the background artist-image hydration job. |
| `POST` | `/api/v1/admin/artists/hydration-seed` | `{ limit? }` (default 500) | Queue image fetches for artists without one. |
| `POST` | `/api/v1/admin/artists/hydrate-tadb-noimage` | `{ limit? }` (default 500) | Run TheAudioDB hydration for artists still missing an image. |
| `POST` | `/api/v1/admin/artists/placeholder` | Multipart form, one image file (max 10 MB) | Upload a custom placeholder image for artists with no image. Resized to a square JPEG. Returns `{ ok: true }`. |
| `DELETE` | `/api/v1/admin/artists/placeholder` | — | Remove the custom placeholder image (reverts to default). |
| `GET` | `/api/v1/admin/artists/placeholder-info` | — | Returns `{ hasCustom }`. |

---

## Admin — Backup *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/v1/admin/backup` | — | Create a server backup ZIP (database + config). Takes no body; the contents are fixed. |
| `GET` | `/api/v1/admin/backups` | — | List available backup files. |
| `GET` | `/api/v1/admin/backup/download/:filename` | — | Download a backup file. |

---

## Updates — Admin *(Velvet)*

In-app updater (Admin → Updates). See `docs/updates.md`. All admin-only.

| Method | Endpoint | Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/update/check` | `?force=1` | Installed version, latest GitHub release (`{ version, tag, name, publishedAt, htmlUrl, body, assets }` — drafts/pre-releases ignored; cached 30 min unless `force=1`), `isNewer`, `checkError`, the environment checklist (`runtime`, `supervisor`, git state, process user, write access, `npmPath`, `blockers[]`, `canSelfUpdate`), `docker` pull hints when inside a container, and the current `job`. Never changes anything. |
| `POST` | `/api/v1/admin/update/start` | `{ version }` | Starts the update job. `version` must equal the latest release the check returned (the notes the admin read are the notes for this version). 400 when blocked or already on it, 409 when a job is running. Runs through the background-task broker (never overlaps a scan): git fetch, fast-forward to the tag, `npm install --omit=dev` if the lockfile changed, verify, then exit for the supervisor to restart (or re-exec without one). Rolls back to the previous commit on failure. |
| `GET` | `/api/v1/admin/update/status` | — | `{ currentVersion, job: { state: idle\|running\|restarting\|failed\|done, target, phase, percent, log[], startedAt, finishedAt, error, startedBy } }` — the page polls this every second while a job runs. |

---

## Network shares — Admin *(Velvet)*

Mount an NFS/SMB share directly from inside Velvet (Admin → Network
Shares). See `docs/network-shares.md`. All admin-only. Needs Velvet's own
process to be running as root — fails with a specific `not-root` error
otherwise; also always fails with a specific `not-permitted` error on an
unprivileged LXC/Incus container, a confirmed kernel limitation.

| Method | Endpoint | Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/network-mount` | — | Lists configured network mounts: `{ [name]: { type, server, mountPoint, options, hasCredentials } }`. |
| `POST` | `/api/v1/admin/network-mount` | `{ name, type: 'nfs'\|'cifs', server, username?, password?, domain?, options? }` | Installs the client package if needed, mounts the share, and adds a tagged `/etc/fstab` entry so it survives a reboot. Rolls the `/etc/fstab` entry back automatically if the mount itself fails. 409 with `error: 'not-root'` or `error: 'not-permitted'` for the two specific, expected failure modes above; 500 with a classified message (`unreachable`/`auth`/generic) otherwise. |
| `DELETE` | `/api/v1/admin/network-mount/:name` | — | Unmounts, removes the `/etc/fstab` entry, and deletes the credentials file if one was written. |

---

## Admin — Import / Export *(Velvet)*

Export is built in the background; poll for status before downloading.

| Method | Endpoint | Body / Params | Description |
|---|---|---|---|
| `POST` | `/api/v1/admin/migrate/export/start` | `{ includeWaveforms?, includeArtistImages? }` | Start background ZIP build. Returns `{ id }`. The ZIP holds the config (secret, password hashes, API keys), so it is built in an owner-only folder next to the database (`<dbDirectory>/../migrate`, mode `0700`, ZIP `0600`), never in the system temp folder. An export not downloaded within 1 hour is deleted; leftovers from an earlier run are removed at boot. |
| `GET` | `/api/v1/admin/migrate/export/status/:id` | — | Poll build status. Returns `{ status: 'building'\|'ready'\|'error', filename?, sizeBytes?, error? }`. |
| `GET` | `/api/v1/admin/migrate/export/download/:id` | — | Stream the finished ZIP (authenticated). Deletes file after download. |
| `POST` | `/api/v1/admin/migrate/upload` | multipart `file` | Upload import ZIP. **Not available yet**: ZIP extraction is unimplemented, so this answers `501 { error: 'Import is not available yet' }` without reading the body, and stores nothing. |
| `POST` | `/api/v1/admin/migrate/apply` | `{ id, keepUsers = true }` | Apply an extracted import: replaces the config (keeping the current `users` unless `keepUsers: false`), copies in the database and re-opens it (the server keeps working), then restores waveforms and artist images when present. Returns `{ success, message, manifest }`. Since `upload` stores nothing yet, there is no import to apply today. |
| `GET` | `/api/v1/admin/migrate/status/:id` | — | Read manifest of an uploaded import. `id` must look like `velvet-import-<digits>`, else `400`. |
| `POST` | `/api/v1/admin/migrate/cleanup/:id` | — | Delete temp files for an import job. `id` must look like `velvet-import-<digits>`, else `400`. |

---

## Admin — Logs

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/admin/logs/download` | Download all server logs as a ZIP. |
| `POST` | `/api/v1/admin/logs/prune` | Delete log files older than the configured retention period. |

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
| `GET` | `/api/v1/admin/directories/health` | Scan each vpath root and its immediate subdirectories for read/write permission issues. Returns `{ results: [{ vpath, root, readable, writable, error?, subdirs: [{ name, readable, writable }] }] }`. Only problematic subdirs are included; hidden dirs are skipped; capped at 300 subdirs per vpath. |

---

## Internal Scanner Endpoints

> Used only by the scanner child process, which signs its requests with a scan token. Any other caller gets `403`. **Not intended for external use.**

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/scanner/set-expected` | Set the expected file count of a scan (`{ scanId, expected }`) for the progress bar. |
| `POST` | `/api/v1/scanner/get-files-batch` | Look up a batch of files (`{ items, vpath, scanId }`) so the scanner can skip unchanged ones. |
| `POST` | `/api/v1/scanner/add-files` | Insert or replace a batch of scanned rows (`{ files: [...] }`). The batch is written in one short transaction inside the request (a failing row is skipped, the rest still commit), so no transaction stays open between requests. Returns `{ failed: [{ filepath, error }] }`. |
| `POST` | `/api/v1/scanner/update-art` | Write album art cache reference for a file. |
| `POST` | `/api/v1/scanner/update-cue` | Write cue point data for a file. |
| `POST` | `/api/v1/scanner/update-tech-meta` | Write `bitrate`, `sample_rate`, `channels`, `bit_depth` for a file. |
| `POST` | `/api/v1/scanner/update-duration` | Write `duration` for a file. |
| `POST` | `/api/v1/scanner/update-album-version` | Write `album_version` and its source for a file. |
| `POST` | `/api/v1/scanner/report-error` | Record a scan error for a file (Scan Error Workshop). |
| `POST` | `/api/v1/scanner/confirm-ok` | Clear the scan error of a file that now scans fine. |
| `POST` | `/api/v1/scanner/prune-errors` | Drop scan errors older than the retention setting. |
| `POST` | `/api/v1/scanner/abort-scan` | Stop a scan early, e.g. on a likely mount failure (`{ scanId, vpath, reason }`). No rows are removed (batches already written by `add-files` stay), and the resume checkpoint is deleted, so the next scan of that vpath starts from the beginning. |
| `POST` | `/api/v1/scanner/finish-scan` | Close a scan: remove stale rows (with a safety guard), clear resolved errors, record the scan. |

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
| `GET` | `/api/v1/admin/acoustid/config` | — | `{ enabled, apiKey, hasKey }`; `apiKey` is masked (first 6 characters + asterisks). |
| `POST` | `/api/v1/admin/acoustid/config` | `{ enabled, apiKey }` | Save the config. Sending back the masked key keeps the stored one; `""` clears it. |

---

## Reverse-Proxy Auth — Admin Config *(Velvet)*

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/ext-auth` | — | Get reverse-proxy trusted-header auth config. `secretValue` is masked (first 4 chars + asterisks); `hasSecret` reports whether one is set. `listenAddress` is included so the UI can warn when the server also listens on a non-loopback interface with no trusted proxies configured. |
| `POST` | `/api/v1/admin/ext-auth` | `{ enabled, headerName, trustedProxies[], secretHeaderName, secretValue, autoCreateUsers }` | Save reverse-proxy trusted-header auth config. Sending back the masked `secretValue` from `GET` preserves the existing secret; any other value replaces it. |

---

## Normalisation Workshop — Admin *(Velvet)*

> See [docs/replaygain-info.md](replaygain-info.md).

All endpoints require admin token.

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/rg/status` | — | Worker status + library stats + undo info. Returns `{ running, stopping, startedAt, currentFile, processedCount, stats, tool, undo }`. |
| `GET` | `/api/v1/admin/rg/failed` | — | List all failed files: `{ files: [{ id, filepath, vpath, reason, error, duration, bitrate }] }`. |
| `POST` | `/api/v1/admin/rg/start` | — | Start measurement worker. |
| `POST` | `/api/v1/admin/rg/stop` | — | Stop worker gracefully after current file. |
| `POST` | `/api/v1/admin/rg/reset-failed` | — | Re-queue every failed row for another try. Library rows are never deleted here (a file that looks missing may be on an offline mount; only the scanner removes gone files). Returns `{ reset }`. |
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
| `POST` | `/api/v1/admin/bpm/genre-correct` | `?dryRun=true` | Genre-matrix octave correction on Essentia rows. `dryRun=true` returns preview stats + full `corrections[]` list without writing. Returns `{dryRun, changed, skipped, noGenre, noFamily, alreadyOk, byFamily, corrections}`. Returns 409 while the Essentia worker runs. *(Velvet)* |
| `POST` | `/api/v1/admin/bpm/genre-correct-undo` | — | Restore `bpm_raw` → `bpm` for all `bpm_status='genre-corrected'` rows. Returns `{ok, restored}`; 409 while the Essentia worker runs. *(Velvet)* |
| `POST` | `/api/v1/admin/bpm/genre-correct-selected` | — | Apply a user-selected subset of dry-run corrections. Body: `{corrections: [{filepath, vpath, bpm, corrected}]}`. Returns `{ok, applied}`. Returns 409 while the Essentia worker runs. *(Velvet)* |

---

## Genre Enricher — Admin *(Velvet)*

> See [docs/genre-enricher.md](genre-enricher.md).

All endpoints require admin token. The Genre Enricher worker queries Last.fm, MusicBrainz and Discogs in parallel and stores suggestions per source. The admin compare table lets the user pick which suggestion to apply per artist.

| Method | Endpoint | Body / Query | Description |
|---|---|---|---|
| `GET`  | `/api/v1/admin/genre-enricher/status` | — | Live worker status + stats (`enriched`, `applied`, per-source `ok`/`nf`/`error`/`queued`, current artist, current phase). |
| `POST` | `/api/v1/admin/genre-enricher/start` | — | Start the background worker. |
| `POST` | `/api/v1/admin/genre-enricher/stop` | — | Stop the worker after the current artist. |
| `POST` | `/api/v1/admin/genre-enricher/reset-errors` | `{ source? }` | Reset rows with `genre_enrich_* = 'error'` to NULL for retry (one source, or all). A `source` other than `lastfm`/`mb`/`discogs` → `400`. |
| `POST` | `/api/v1/admin/genre-enricher/reset-not-found` | `{ source? }` | Reset rows with `genre_enrich_* = 'nf'` to NULL (one source, or all). A bad `source` → `400`. |
| `POST` | `/api/v1/admin/genre-enricher/reset-source` | `{ source: 'lastfm'\|'mb'\|'discogs' }` | Reset one source's enrichment status + value to NULL. |
| `POST` | `/api/v1/admin/genre-enricher/reset-all` | — | Wipe all enrichment data (per-source status + suggestions). `genre_user_reviewed` and the current genre are kept. `400` while the worker runs. |
| `GET`  | `/api/v1/admin/genre-enricher/compare` | `?filter=enriched\|empty\|applied&search=<text>&limit&offset` | Paginated comparison rows. `enriched` = all 3 sources processed, not yet reviewed. `empty` = same as `enriched` but only artists with no current genre tag. `applied` = user has acted. `search` does a case-insensitive `%text%` LIKE match on artist over the ENTIRE result set. |
| `POST` | `/api/v1/admin/genre-enricher/apply` | `{ items: [{ artist, source: 'lastfm'\|'mb'\|'discogs'\|'keep' }] }` | Apply user decisions in bulk. `keep` marks the artist as reviewed without changing the genre; items with another `source` are ignored (`400` when none is left). To write an own genre use `set-genre`. Returns `{ ok, updated }`. |
| `POST` | `/api/v1/admin/genre-enricher/apply-all-empty` | `{ source: 'preferred'\|'mb'\|'discogs'\|'lastfm' }` | Bulk-apply suggestions to every artist that currently has no genre. |
| `POST` | `/api/v1/admin/genre-enricher/apply-all-consensus` | — | Apply the agreed genre for every unreviewed artist where all 3 sources returned the same non-empty value. Returns `{ updated }`. |
| `POST` | `/api/v1/admin/genre-enricher/apply-all-majority` | — | Apply the majority genre for every unreviewed artist where exactly 2 of 3 sources agree and the third has no data yet. Returns `{ updated }`. |
| `POST` | `/api/v1/admin/genre-enricher/set-genre` | `{ artist, genre }` | Manually set the current genre for one artist (lowercase, stored on `files.genre`). |

---

## AI-assist — Admin *(Velvet)*

> See [docs/ai-assist.md](ai-assist.md) (admin) and [docs/ai-dj.md](ai-dj.md) (listeners).

Admin token required. Everything except the config endpoints answers `404` until `aiAssist.enabled` is set in the config file. Claude proposes a genre family per tag and per library folder; only approved rules reach Auto-DJ (`genre-family` on `random-songs` candidates).

| Method | Endpoint | Body / Query | Description |
|---|---|---|---|
| `GET`  | `/api/v1/admin/ai/config` | — | `{ enabled, apiKey, model, monthlyBudgetUsd, queueBuilder, maxQueueSongs, provider, localBaseUrl, localModel, localApiKey, djNotes, usage: { month, calls, usd }, families, estimate }`. `estimate` is what one full pass over the library would cost before anything is sent: `{ songs, items: { genres, folders, notes, notesAll }, model, provider, usd: { genres, folders, notes, total, brief }, perThousandSongs, models: { <model>: total } }` — `brief` is the cost of one AI DJ request. Token counts per item were measured on a 141,000-song library (4 cents for 523 rules, 9 cents for 662 folder notes on Haiku). |
| `POST` | `/api/v1/admin/ai/config` | `{ enabled, apiKey, model, monthlyBudgetUsd, queueBuilder?, maxQueueSongs?, provider?, localBaseUrl?, localModel?, localApiKey?, djNotes?, analyse? }` | Save settings (config file + live). `queueBuilder` shows the AI DJ page to listeners; `maxQueueSongs` (1–9999, default 500) caps one AI-built set. `provider` is `anthropic` (default) or `openai` for a self-hosted server with an OpenAI-compatible API at `localBaseUrl` (…`/v1`) serving `localModel`. Nothing is sent to the model on save unless `analyse: true`, which starts the full pass (genre and folder proposals, then the folder notes) in the background; the answer says `{ analysing, estimate }`. |
| `POST` | `/api/v1/admin/ai/test` | — | One tiny structured request to the configured provider. `{ ok, model, ms, provider }`, or `409 { ok: false, error, code }` (`nokey`, `local`, `budget`, `disabled`). |
| `GET`  | `/api/v1/admin/ai/genre-families` | `?profile=` (default: active) | Merged genres and library folders (two levels deep) with file counts, tag statistics, and the rule per row (`status`: `none`/`proposed`/`approved`, `family`, `proposed`, `confidence`, `note`), plus `profile`, `profiles` and the `analysis` state. |
| `GET`  | `/api/v1/admin/ai/activity` | — | `{ endpoint: { provider, model, endpoint, auth, billing }, usage, calls: [{ ts, task, provider, model, systemChars, promptChars, preview, ms, ok, inputTokens, outputTokens, cacheRead, usd, error? }], analysis }` — the last 60 calls since start. |
| `GET`  | `/api/v1/admin/ai/context` | `?profile=` | The exact texts each task sends: `{ genres: { system, sample, lines, batch }, folders: { system, sample, lines, fromStats }, aidj: { system, library, notes, notesIncluded, notesTotal, chars }, notes: { system, sample, lines } }`. |
| `GET`  | `/api/v1/admin/ai/overview` | `?profile=` | The library as that profile's rules see it: `{ library: { songs, withGenre, withoutGenre, genres, withBpm, withKey, folders, subfolders }, rules: { tag, folder }, families: { <family|unknown>: { songs, viaTag, viaFolder, viaKeyword, genres: [{ genre, cnt }] } } }`. |
| `GET`  | `/api/v1/admin/ai/analysis` | — | `{ running, profile, startedAt, finishedAt, error, genres, folders, notes: { running, startedAt, finishedAt, error, folders, todo, done, usd } }` — the background pass started by a saved key or `…/analyse`; the library notes follow the genre pass. |
| `GET`  | `/api/v1/admin/ai/library-notes` | — | What the model wrote about each folder after reading the library: `{ notes: [{ key, vpath, folder, name, depth, kind, note, aliases, ask, n, source: 'ai'\|'edited', ts }], kinds, analysis, plan: { folders, todo, noted, estimateUsd, batches } }`. `plan.todo` counts folders without a note or whose size changed by a fifth; `estimateUsd` is the cost at the configured model. |
| `POST` | `/api/v1/admin/ai/library-notes/analyse` | `{ force? }` | Describe the `todo` folders in the background (`force` describes every folder again; edited notes are kept). `{ started, analysis }`; `409 nokey` without a key. |
| `POST` | `/api/v1/admin/ai/library-notes/edit` | `{ key, kind, note, aliases, ask }` | The admin's own text for a folder; marked `edited`, never overwritten by a later pass. |
| `POST` | `/api/v1/admin/ai/library-notes/delete` | `{ key }` | Remove one note (a later pass writes it again). |
| `POST` | `/api/v1/admin/ai/library-notes/reset` | `{ keepEdited? }` | Remove the model's notes (default keeps edited ones). `{ removed }`. |
| `GET`  | `/api/v1/admin/ai/version-words` | — | The version-word families the AI DJ uses for "no …" and "only …" wishes: `{ families: [{ name, says[], match[] }], custom, defaults }`. `custom` is `false` while the built-in list applies; `defaults` is always the built-in list. |
| `POST` | `/api/v1/admin/ai/version-words` | `{ families: [{ name, says?, match }] }` | Save an own list (1–40 families, unique names, words lower-cased and trimmed, at least two characters). Stored as `aiAssist.versionWords` and kept through updates and through saves of the other AI settings. `400` on an invalid list. |
| `POST` | `/api/v1/admin/ai/version-words/reset` | — | Remove the own list; the built-in families apply again. |
| `POST` | `/api/v1/admin/ai/genre-families/analyse` | `{ profile? }` | Propose genres and folders in one background pass. `{ started, analysis }`; `started: false` while one is running; `409 nokey` without a key. |
| `POST` | `/api/v1/admin/ai/genre-families/propose` | `{ kind: 'genre'\|'folder', profile? }` | Ask Claude for proposals (folders whose tags already agree are proposed from statistics). `409` with `code: 'budget'\|'nokey'\|'disabled'` when it cannot ask. Returns `{ proposed, usage }`. |
| `POST` | `/api/v1/admin/ai/genre-families/apply` | `{ items: [{ kind, key, family, label? }], profile? }` | Save rules. `family` ∈ `electronic\|disco\|soft\|ambient\|hard\|other\|ignore` approves (a modified choice too), `undo` puts an approved rule back to its proposal, `none` removes the rule. |
| `POST` | `/api/v1/admin/ai/genre-families/reset` | `{ kind?, status?, profile? }` | Delete rules; default deletes proposals only. Returns `{ removed }`. |
| `GET`  | `/api/v1/admin/ai/profiles` | — | `{ profiles: [{ id, name, active, approved, proposed }], active }`. Rules live per profile; Auto-DJ uses the active one. |
| `POST` | `/api/v1/admin/ai/profiles` | `{ name, copyFrom? }` | Create a profile, optionally copying another profile's rules. `{ id, profiles }`. |
| `POST` | `/api/v1/admin/ai/profiles/activate` | `{ id }` | Make this profile the one Auto-DJ uses. |
| `POST` | `/api/v1/admin/ai/profiles/rename` | `{ id, name }` | Rename. |
| `POST` | `/api/v1/admin/ai/profiles/delete` | `{ id }` | Delete a profile and its rules; `409 active` for the active profile. |
| `POST` | `/api/v1/admin/users/allow-ai-dj` | `{ username, allow }` | Per-user switch for the AI DJ page (default on once the admin enables the queue builder). |

### AI DJ — listeners *(Velvet)*

User token. `/queue/*` answers `404` until both `aiAssist.enabled` and `aiAssist.queueBuilder` are set. The listener's text becomes a **brief** (genres, era, tempo, flow, artists, length — see `BRIEF_SCHEMA` in `src/util/ai-queue.js`); Velvet picks and orders the songs itself, so a set only ever holds songs from the library and never exceeds the cap. Scope fields (`ignoreVPaths`, `filepathPrefix`, `excludeFilepathPrefixes`) work as for `random-songs`.

| Method | Endpoint | Body / Query | Description |
|---|---|---|---|
| `GET`  | `/api/v1/ai/status` | — | `{ enabled, maxSongs, families }` — always `200`; `enabled` is false until the admin switches the queue builder on, and for a user with `allow-ai-dj: false`. Usage guide: [docs/API/ai-queue.md](API/ai-queue.md). |
| `POST` | `/api/v1/ai/queue/brief` | `{ text (2–600 chars), ignoreVPaths?, filepathPrefix?, excludeFilepathPrefixes? }` | Asks Claude for a brief. Returns `{ brief, cached, source: 'claude'\|'local'\|'rules', usage }`; `local` is a self-hosted model; `source: 'rules'` means the model could not be reached (no key, budget, network, unusable answer) and a rule-based reader wrote the brief instead. Identical requests are served from a 15-minute cache. `429` with `code: 'throttled'` (3 s between calls) or `'daily'` (200 per user per day). |
| `POST` | `/api/v1/ai/queue/build` | `{ brief, ignoreVPaths?, filepathPrefix?, excludeFilepathPrefixes? }` | Builds the set from a (possibly edited) brief, no model call. Returns `{ songs: [{ filepath, metadata }], notes: [{ code, … }], stats: { pool, picked, minutes, artists, bpmFrom, bpmTo, withBpm, maxStep, harmonic, transitions, withKey }, resolved: { genres, excludeGenres, families, artists, similar, folders, titles, keys, release, playlists, collections, chart?, albums?, segments? } }`. A brief with `segments` (a set in phases) is built phase by phase and `resolved.segments` lists what each phase got. Notes say what was capped, not found, outside the listener's selection (`titleOutsideScope` …), relaxed to fill the set, which album, chart, corridor or seed was used, and which cohesion rule gave way — the full list is in [docs/API/ai-queue.md](API/ai-queue.md). `400` on an invalid brief, `429` when called more than once a second. |

---

## Duplicate Workshop — Admin *(Velvet)*

Find and remove duplicate songs and album folders in the library. Three detection tiers: exact file hash, matching audio hash (same content, different tags/container), and similar (same normalised artist+title with close duration).

All endpoints require admin token.

| Method | Endpoint | Body / Query | Description |
|---|---|---|---|
| `GET`  | `/api/v1/admin/dup-workshop/status` | — | Current state (`idle`\|`scanning`\|`done`), summary (`groups`, `files`), `lastScan` timestamp, active `threshold`. |
| `POST` | `/api/v1/admin/dup-workshop/scan` | `{ threshold?: 50–100 }` (default 90) | Start a scan in the background (run in small chunks by the background-task broker). Returns `202 { started: true }` at once, `409` when a scan is already running. Poll `/status` until `state=done`. |
| `POST` | `/api/v1/admin/dup-workshop/cancel` | — | Stop the running scan before its next chunk; the results of the previous finished scan stay. `400` when no scan is running. Returns `{ cancelling: true }`. |
| `GET`  | `/api/v1/admin/dup-workshop/songs` | `?match=exact\|audio\|similar&limit&offset` | Paginated song duplicate groups. Each group has `paths[]`, `formats[]`, `similarity`, `artist`, `title`, `album`, `duration`. |
| `GET`  | `/api/v1/admin/dup-workshop/folders` | `?limit&offset` | Paginated folder-duplicate groups: folders whose tracks have exactly the same set of content hashes (audio hash, else file hash), whatever their names or tags. |
| `POST` | `/api/v1/admin/dup-workshop/delete` | `{ filepaths: ['vpath/rel/path', …] }` | Permanently delete files from disk and remove DB rows. Returns `{ deleted, failed }`. |

---

## Subsonic Compatibility

Velvet implements a subset of the Subsonic API for third-party client compatibility. See [docs/subsonic.md](subsonic.md) for supported methods.

Base URL: `/rest/`

**Per-user Subsonic scrobble toggle**:

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/api/v1/subsonic/scrobble-settings` | — | Get the user's Subsonic scrobble settings. |
| `GET` | `/api/v1/admin/users/subsonic-apikeys` | `?username=` | **Admin.** List the API keys of a user (default: the admin's own). |
| `POST` | `/api/v1/admin/users/subsonic-apikeys` | `{ username?, label? }` | **Admin.** Generate a new Subsonic API key for a user. Returns `{ apiKey, label, created }`. |
| `DELETE` | `/api/v1/admin/users/subsonic-apikeys/:id` | `?username=` | **Admin.** Revoke an API key by ID. |

**Subsonic server-side play queue persistence**:

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET/POST` | `/rest/getPlayQueue(.view)` | Subsonic auth params | Returns the authenticated user's saved queue, current track ID, and position (ms). |
| `GET/POST` | `/rest/savePlayQueue(.view)` | Subsonic auth params + `id[]`, `current`, `position` | Saves/upserts the authenticated user's queue server-side so clients can restore queue state across restarts. |

**OpenSubsonic transcoding extension (v1)**:

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET/POST` | `/rest/stream(.view)` | `maxBitRate` (kbps), `format` (`mp3`/`opus`/`aac`/`raw`) | Streams a song; transcodes when `maxBitRate` or `format` is provided and transcoding is enabled. `format=raw` forces passthrough. |
| `POST` | `/rest/getTranscodeDecision(.view)` | Subsonic auth + `mediaId`, `mediaType`, `ClientInfo` JSON | Returns `transcodeDecision` with `canDirectPlay`, `canTranscode`, `transcodeParams` token, `sourceStream`, and `transcodeStream` details. |
| `GET/POST` | `/rest/getTranscodeStream(.view)` | Subsonic auth + `mediaId`, `transcodeParams`, `offset` | Streams the song transcoded using the settings encoded in the opaque `transcodeParams` token from `getTranscodeDecision`. |
