## v0.4.6 (2026-08-20)

Transcoding diagnostic logging and bitrate display fix for Subsonic clients.

### Fixed: `bitRate` in song metadata shows source bitrate instead of transcoded bitrate
- When transcoding is enabled, `Child` objects (used by `getSong`, `getAlbum`, `search3`, etc.) now report `bitRate` as the configured transcoded target bitrate (e.g. 192) instead of the source file's bitrate (e.g. 800 for FLAC). This fixes clients such as Tempus that correctly detected the `transcodedSuffix` but displayed the wrong bitrate.

### Added: stream transcoding decision logged for Docker diagnostics
- Every `/rest/stream` call that triggers a transcode now logs: `[SUBSONIC] stream TRANSCODE flac→opus@192k src="Artist - Title" client=Symfonium`. Calls that pass through (transcoding disabled, `format=raw`, or no transcode params sent) log the reason when the client did send `format`/`maxBitRate` params. This makes it straightforward to confirm in `docker logs` whether a client's transcoding configuration is actually reaching Velvet and whether the transcode path is being taken.
- `getTranscodeStream` also logs the codec, bitrate, and offset for each transcoded stream it serves.

## v0.4.5 (2026-08-20)

Full OpenSubsonic transcoding compliance. The `stream` endpoint now honours `maxBitRate` and `format` parameters; song metadata includes `transcodedSuffix`/`transcodedContentType`; and the `getTranscodeDecision` + `getTranscodeStream` extension endpoints are implemented.

### Subsonic: honour `maxBitRate` and `format` in stream
- `GET /rest/stream` and `/rest/download` previously ignored the `maxBitRate` (kbps cap) and `format` (target codec) parameters — files were always served as-is. Clients such as Symfonium that configured transcoding received the original FLAC even though they requested, say, 320 kbps MP3. These params are now fully honoured when transcoding is enabled in Velvet's config.
- Supported target codecs: `mp3`, `opus`, `aac`. `format=raw` forces passthrough regardless of the bitrate cap.
- `maxBitRate` maps to the nearest supported bitrate (64/96/128/192 kbps) without exceeding the cap.

### Subsonic: `transcodedSuffix` / `transcodedContentType` in song metadata
- When transcoding is enabled, `Child` (song) objects in `getSong`, `getAlbum`, `search3`, etc. now include `transcodedSuffix` and `transcodedContentType` fields, matching the OpenSubsonic spec. Clients can use these to show the actual format that will be streamed (e.g., "OPUS" for a FLAC source) rather than the source file extension.

### Subsonic: `getTranscodeDecision` extension endpoint (POST)
- New OpenSubsonic extension endpoint. Accepts a `ClientInfo` JSON body with `directPlayProfiles`, `transcodingProfiles`, and bitrate limits. Returns a `transcodeDecision` with `canDirectPlay`, `canTranscode`, `sourceStream` details, `transcodeStream` details, and an opaque `transcodeParams` token.

### Subsonic: `getTranscodeStream` extension endpoint
- Companion to `getTranscodeDecision`. Accepts the opaque `transcodeParams` token and pipes the audio through Velvet's transcode engine at the negotiated codec and bitrate. Supports an `offset` parameter for mid-track start.

### Subsonic: `transcoding` listed in `getOpenSubsonicExtensions`
- The `transcoding` extension (`versions: [1]`) is now advertised. Clients that support the Dec-2025 OpenSubsonic transcoding extension spec will detect it and use `getTranscodeDecision` + `getTranscodeStream` instead of the legacy `maxBitRate`/`format` params.

## v0.4.4 (2026-08-19)

Two fixes: Essentia BPM/key analysis now auto-starts after scan (was never triggered), and the Transcoding admin panel now shows readable status instead of raw true/false.

### Fixed: Essentia BPM/key auto-start missing from post-scan pipeline
- After a library scan finished, AcoustID fingerprinting, ReplayGain, and AcousticBrainz lookups were all queued automatically — but Essentia (local BPM + musical key analysis) was never started. It could only be launched manually from the Admin UI. The missing `_tryEssentiaAutoStart` hook is now registered with `onEveryScanEnd`, using the same pattern as the other workers: 90 s boot delay (to let AcoustID and RG settle first), deferred start if a scan is still in progress, and a < 500 file threshold to avoid auto-starting on very large libraries where an admin decision is more appropriate.

### Fixed: Transcoding admin panel showed raw `true`/`false` for FFmpeg status
- The "FFmpeg Downloaded" row displayed the raw boolean value from the server, which users interpreted as a config flag they needed to manually set. It now shows **Ready** / **Not ready** (NL: Gereed / Niet gereed). The "Download" button is also relabelled to "Verify / Download" to clarify that in Docker the binary is pre-installed and the action simply verifies it rather than fetching it from the internet.

## v0.4.3 (2026-08-17)

Bugfix: multi-word search queries (e.g. an artist name plus part of the title) still queued songs without a duration, even after the v0.4.1 fix.

### Fixed: cross-field search results still missing duration
- The v0.4.1 fix patched the single-column search helper (`searchByX()`), but multi-word queries — where the title and artist words match in different database columns, e.g. searching "Rock the Box Sylvester" — go through a separate cross-field search path (`_crossFieldSearch()`) that builds its own result objects independently. That path still didn't include `duration`, so a very common real-world "artist + title" search still queued songs without a playtime shown. `duration` is now included there too.

## v0.4.2 (2026-08-17)

Velvet TV (Tizen): File Explorer and an on-screen app version so you can confirm a side-loaded update actually installed.

### New: File Explorer on Velvet TV
- Added a **Files** tab (side menu + Home tile) that browses the library's raw folder structure via the same `POST /api/v1/file-explorer` endpoint the web player uses. Drilling into a folder shows sub-folders and playable tracks together; the breadcrumb trail is focusable so you can jump back to any parent folder directly instead of pressing Back repeatedly. Selecting a track queues every playable file in that folder and starts playback from the one picked.

### New: app version shown on the Velvet TV sign-in screen
- The sign-in screen now shows the installed app version (e.g. `v0.4.2`), stamped from `package.json` at build time in both `index.html` and `config.xml`. Since Tizen widgets are side-loaded rather than auto-updated through a store, this makes it easy to confirm a freshly side-loaded `.wgt` actually replaced the previous install.

## v0.4.1 (2026-08-16)

Bugfix: songs added to the queue from search results now show their playtime like everywhere else.

### Fixed: search results missing duration in the queue
- Adding a song to the queue from the search view showed no playtime next to it, while every other queue entry (albums, artists, playlists) displayed its duration normally. `searchByX()` (backing `POST /api/v1/db/search` title/files categories) only returned `{name, filepath, album_art_file}` per row, dropping `duration` even though the underlying DB row has it. Search results now carry `duration` through the API response and into the queued song objects.

## v0.4.0 (2026-08-14)

Auto-DJ redesign: hard-filter fallback chain replaced with soft/weighted batch scoring, plus a hard artist-repeat floor and a playback-stall fix that could silently halt Auto-DJ mid-session.

### Auto-DJ — soft-scoring architecture (replaces the tiered hard-filter fallback chain)
- **Complete redesign of how the next Auto-DJ song is chosen.** The old model applied hard filters (BPM window, harmonic/key match, genre group, similar-artist list) and escalated through an ever-growing chain of fallback tiers whenever a combination proved too restrictive for a real library. It's replaced with a single soft-scoring model: fetch a broad batch of candidates (`POST /api/v1/db/random-songs` with `returnAll: true`), score every one on similar-artist rank, BPM continuity, genre compatibility, harmonic (Camelot) mixing, year/era continuity and artist diversity, and always queue the single highest-scoring song. Nothing except collection/path scope, minimum rating, and the keyword filter can exclude a candidate outright anymore — every other signal only nudges the score up or down. See `docs/autodj-scoring.md` for the full design.
- **Fixed: a well-tagged song from a thinly-represented similar artist could statistically never reach the scoring stage.** When a similar-artist list is active, artists with a large catalogue in the library crowded out the rest once the combined candidate pool was randomly cut down to size. The batch is now sampled per-artist first (up to 10 songs per similar artist) before the overall cap, so every similar artist gets a fair shot at being scored.
- **Fixed: the same artist could repeat within just a few songs.** The server's cooldown fallback can legitimately drop the artist-cooldown constraint entirely when the similar-artist pool is too narrow to satisfy both filters at once. Auto-DJ now also enforces a hard client-side floor — the last 3 played artists are never eligible for the next pick, regardless of what the server returns — on top of the existing 15-song soft diversity window.
- **Fixed: Auto-DJ could silently stop advancing mid-session while the current song kept playing to completion on Sonos.** The browser's local (muted) audio element drives both the waveform and the "song ended → next song" trigger, but only recovered from network stalls on the `stalled` event. A slow buffer underrun — the far more common real-world case — fires `waiting` instead, which had no recovery handler at all, so the element could hang indefinitely with no next song ever queued. `waiting` now triggers the same stall-recovery path as `stalled`.

## v0.3.22 (2026-08-11)

Auto-DJ scoring engine + Samsung TV parity: weighted candidate scoring, year/era continuity, smarter fallback chain, and the Tizen app now runs the same engine.

### Auto-DJ — weighted scoring engine, year/era continuity, smarter fallback
- **New scoring engine.** Instead of accepting the first candidate the server returns, Auto-DJ now requests up to 5 candidates and scores each one — harmonic (Camelot) fit 25%, genre compatibility 15%, Last.fm similarity rank 20%, BPM proximity 20%, year/era proximity 10%, artist diversity 10% — and queues the best-scoring unblocked song. A genre compatibility matrix (e.g. electronic↔disco 0.7, electronic↔hard 0.05) replaces the old binary same/different genre check.
- **New: year/era continuity.** A rolling average of the last 8 DJ-picked years (like the existing BPM anchor) now nudges each pick toward a coherent era, preventing the similar-artist "random walk" from drifting from 2005 to 2023 over a dozen songs with nothing to notice or correct it.
- **Fixed: BPM/harmonic anchors could be seeded from a manually-played song.** If you were listening to a slow ballad and switched on Auto-DJ, the first DJ pick used to lock the whole session's BPM window to that song's tempo, often exhausting the similar-artist pool immediately. The rolling anchor now only ever updates from actual DJ-picked songs — the first pick after enabling Auto-DJ is unconstrained and lets the artist/genre/harmonic signals guide it instead.
- **Fixed: tier-3 "free pick" fallback could still violate the artist keyword filter or jump hard↔soft genre groups.** It now retries up to 3 times and validates each candidate against those two guards before accepting it.
- **Fixed: the genre-escape fallback (used when a genre run gets stuck) could return a candidate that was itself blocked.** It's now validated the same way as every other candidate; if blocked, the original pick is kept instead.
- **Fixed: the artist-cooldown list sent to the server could grow up to 500 entries.** On smaller libraries this caused the server to exhaust the entire catalog and silently drop the cooldown constraint. Only the most recent 15 artists (the actual cooldown window) are sent now.
- **Improved Last.fm similar-artist matching** for compound artist names (`"A & B"`, `"A vs. B"`, `"A pres. B"`, `"A x B"`) — each part is tried individually until one returns results, and each result now carries its Last.fm rank (used by the new scoring engine) instead of an unordered list.

### Velvet TV — Samsung Tizen app: Auto-DJ parity
- **The TV app's Auto-DJ now uses the same scoring/continuity engine as the web player** — similar-artist matching, BPM continuity, harmonic (Camelot) mixing, year/era continuity, artist diversity, and the same 3-tier fallback chain (similar+BPM+key → library-wide BPM+key → free pick). Since the TV has no settings screen, these all run with fixed sensible defaults rather than user-configurable options — there was previously no way to expose them there. The keyword and genre whitelist/blacklist filters remain web/desktop-only, since those inherently need a list-editing UI the remote doesn't have.

## v0.3.21 (2026-08-10)

Maintenance release: waveform cache refresh, visualizer graceful fallback, Subsonic large-queue position fix, deterministic album sort order.

## v0.3.20 (2026-08-09)

### Velvet TV — Samsung Tizen app: album feature parity + shareable build
- **Albums on the TV now match the web UI.** CUE-sheet albums (single-file FLAC+CUE) are split into their individual tracks — selecting a track seeks to its start and stops cleanly at the track boundary, auto-advancing to the next. Multi-disc sets are grouped under disc headers ("CD 1", "Disc 2", …), each album shows year • track count • total duration, and the currently playing track is highlighted.
- **A–Z quick-jump strip** added to the Albums view: press Right from the grid, pick a letter with Up/Down, press OK to jump straight to the first album for that letter. Only letters that have albums are shown (digits/symbols group under `#`). Fixed the D-pad visibility check so `position: fixed` controls are reachable by the remote.
- **New public, credential-free widget build** — `npm run build:tizen:dist` produces `dist/velvet-tv-<version>.wgt` with no server URL or login baked in, safe to attach to a GitHub release. `npm run release` now builds and uploads this clean widget automatically, with a safety net that aborts if the package ever appears to contain credentials.
- **Docs:** added `docs/tizen-tv.md` (install via Apps2Samsung, remote/media-key reference, album features, build modes, troubleshooting) and a dedicated TV-app release note.

## v0.3.19 (2026-08-05)

- Improved Auto-DJ: fixed a case where the DJ could get stuck repeating untagged tracks when the artist cooldown covered all artists in the active library.
- Fixed: admin API returned the wrong HTTP status code when a non-admin user accessed admin routes.
- Fixed: admin panel loaders no longer hang on a permanent spinner when a network request fails.

## v0.3.18 (2026-08-01)

- Added performance improvements.

## v0.3.17 (2026-08-01)

- Added optimalisations.

## v0.3.16 (2026-08-01)

### OpenSubsonic `reportPlayback` scrobble fix
- **Fixed: scrobbles from OpenSubsonic clients (e.g. Naviamp) were silently discarded.** The `reportPlayback` extension (OpenSubsonic v1, finalised March 2026) uses `state=stopped` as the terminal playback event that servers should use to trigger a scrobble. Our implementation only fired on `state=completed`, a value that does not exist in the spec — so every track played via a compliant client was counted as not-scrobbled.
- **Fix:** the handler now correctly treats `stopped` as the scrobble trigger. Before scrobbling, a listen-threshold check is applied: the user must have listened to at least 50% of the track **or** 4 minutes, whichever is shorter (matching the Last.fm / ListenBrainz minimum). Position is taken from the `positionMs` parameter; if zero, elapsed time is estimated from the internal now-playing store.
- The `starting` state (spec-correct name) is now also accepted alongside the old `started` alias for now-playing tracking.
- Clients that still send `state=completed` (older behaviour) continue to work unchanged — scrobble fires unconditionally as before.
- `ignoreScrobble=true` is honoured on `stopped` just as it was on `completed`.
- Tracks skipped in under 30 seconds are never scrobbled regardless of position.

## v0.3.15 (2026-08-01)

### Playlist drag-to-reorder
- **New:** songs in a saved playlist can now be dragged to a new position. Hover over a song to reveal the grip handle (⠿) on the right side — drag it up or down to reorder. The new order is saved to the server immediately.
- A `sort_order` column is added to the playlist database table on first start (silent migration, no data loss). Existing playlists keep their current insertion order until a reorder is performed.
- New API endpoint: `POST /api/v1/playlist/reorder` — accepts `{ playlistname, ids[] }`.

### Scrolling song title fix
- **Fixed:** long song titles that use the marquee animation were showing a truncated version (ending in "…") while scrolling, because the title container had `overflow: hidden; text-overflow: ellipsis` applied before the scroll happened. The full title now scrolls correctly.

### Dependencies
- Bumped all 12 pending Dependabot PRs: helmet 8.3.0, nanoid 6.0.0, ws 8.21.1, eslint-plugin-sonarjs 4.2.0, brace-expansion 5.0.7→5.0.9, fast-xml-parser 5.10.1, axios 1.19.0, music-metadata 11.14.0, eslint 10.8.0, globals 17.8.0, actions/setup-node v7, trivy-action (latest).
- **Security:** `npm audit fix` resolved a high-severity brace-expansion DoS (unbounded expansion → OOM) and a low-severity body-parser DoS (invalid limit silently disabling size enforcement). Zero vulnerabilities.

## v0.3.14 (2026-07-10)

### Cross-device queue sync — always-visible tab fix
- **Fixed: returning to a paused device after playing on another machine kept the stale queue** instead of pulling the updated one from the server. The queue sync relied entirely on the `visibilitychange` event (tab hidden → visible), but if the Velvet tab was always visible (desktop that was never minimised or locked), that event never fired — leaving the old queue in place indefinitely.
- **Fix:** added a 2-minute background interval that runs only while audio is paused. It fetches the server settings, applies the same cross-device browser-identity check (`browserId`) as the existing `visibilitychange` handler, and calls `restoreQueue` if the DB queue was saved by a different device and differs from localStorage. The interval shares the `_lastVisRefresh` throttle so the two code paths never double-sync.

## v0.3.13 (2026-07-10)

### Admin panel — non-admin users blocked from HTML page
- **Fixed: any authenticated user could load the admin panel HTML page** (`/admin`, `/admin/index.html`) even without `admin: true` in their config. The route guard in `server.js` only verified the JWT was valid (user logged in) but never checked the admin flag. Non-admin users are now redirected to `/` immediately — they never see the admin UI.
- Admin API endpoints already required `admin: true` and were unaffected; this closes the HTML-access gap.

### Child-only vpath access fix
- **Fixed: users restricted to a child vpath (e.g. "12-inches") can now browse and play music.** Previously, any user whose `vpaths` list contained only child vpaths — sub-folders of a root vpath — received empty results everywhere and could not play files at all.
- **Root cause:** files are indexed in the database under the ROOT vpath (e.g. `Music`). All DB queries, media access checks, and metadata lookups used the user's strict vpath list, so queries for `WHERE vpath IN ('12-inches')` returned zero rows.
- **Auth layer:** middleware now computes `req.user.dbVpaths` — the user's strict list expanded with any parent root vpaths needed for DB queries. The original `req.user.vpaths` is unchanged and still used for all access-control checks.
- **playlist/getall (`/api/v1/ping`):** `vpathMetaData` now correctly reports `parentVpath` and `filepathPrefix` for child-only users, so the client knows to query the parent root.
- **Media access:** child-only users can stream files via the parent root's Express static mount, but only within their allowed filesystem prefix.
- **vpath.js:** `getVPathInfo` now permits access to parent-root filepaths that fall within a user's child vpath prefix, instead of always throwing.
- **DB queries (`db.js`):** all ~25 query endpoints (artists, albums, songs, search, random, home, rated, recently played, etc.) use `userDbVpaths(req.user)` which returns `dbVpaths` when present.
- **Artists menu:** `getArtists`, `getArtistHomeStats`, `getArtistsByLetter` accept `includeFilepathPrefixes` and filter to only artists with files in the user's allowed sub-folder prefix.
- **Albums menu:** `/api/v1/albums/browse` filters its shared cache per-user so child-only users with no `albumsOnly` vpath see zero albums (correct — they have no albums folder configured).
- **Genres and Decades menus:** `getGenres`, `getDecades`, `getSongsByDecade`, `getAlbumsByDecade`, `getSongsByGenreRaw`, `getAlbumsByGenre` all accept `includeFilepathPrefixes`; every endpoint in db.js passes `computeChildInclusions(req.user)`.

## v0.3.12 (2026-07-08)

### Search — artist tracks shortcut
- **New: tracks icon on artist search results** — each artist row in the Search view shows a hover-reveal list icon on the right. Clicking it opens a flat track list (all songs by that artist, matched by metadata tags) with Play All and Append All. Back returns to search.
- Clicking the artist name itself still opens the full artist profile (albums, bio) — no existing behaviour changed.
- Track list uses `POST /api/v1/db/artist-folder-songs` with all artist name variants from the search response, respecting audiobook and albums-only vpath filters.

## v0.3.11 (2026-07-08)

### Starred — smart queue append
- **New: "Append songs" bar in the Starred view** — a compact row of star-threshold buttons (★ through ★★★★★) sits above the song list. Click any button to append all songs matching the selected rating filter to the queue instantly.
- **Hidden operator toggle**: the operator symbol (≥ by default) is clickable and cycles through three modes — **≥** (at or above), **=** (exactly), **≤** (at or below). The symbol highlights in the accent colour when a non-default mode is active.
- Fully localised across all 12 languages.

## v0.3.10 (2026-07-07)

### OpenSubsonic API — Full Compliance
- **API Key authentication** (`apiKeyAuth` extension): generate per-user API keys in Admin → Users → Password modal. Keys authenticate via `?apiKey=<key>` — no username or password needed. Keys do not expire; admins can list and revoke them individually. New DB table `subsonic_api_keys`.
- **`tokenInfo` endpoint**: returns `{ username, authMethod }` for the current session.
- **`startScan` / `getScanStatus`**: admin-only rescan trigger; `getScanStatus` now returns live data — real `scanning` boolean and total files scanned.
- **`reportPlayback`** (`playbackReport` extension): accepts `state: started/playing/paused/completed` + `positionMs`. Triggers scrobble on `completed`.
- **`getLyricsBySongId`** (`songLyrics` extension): reads embedded lyrics on demand — USLT, Vorbis `LYRICS`, synced SYLT. Results cached per content hash.
- **`getSimilarSongs` / `getSimilarSongs2` / `getTopSongs`**: wired to Last.fm, matched against local library.
- **`search` v1**: legacy endpoint now registered (delegates to search2).
- **`getCoverArt ?size=`**: now scales to any requested size (92 / 256 / custom tiers).
- **Auth error codes 41/42/43**: conflicting/unsupported auth combinations return proper OpenSubsonic codes.
- **`getOpenSubsonicExtensions`**: now advertises `apiKeyAuth`, `songLyrics`, `playbackReport`.

### Dependencies
- Bumped `nanoid` 5.1.11 → 5.1.16 (random pool corruption fix, forever-loop fix).

## v0.3.9 (2026-07-07)

### Navigation
- **Fixed: "Your Stats" missing from the sidebar** — the listening-habits view (top artists, total play time, fun facts, unplayed gems) was fully implemented but had no nav button. It now appears under **History & Stats** in the left sidebar.

## v0.3.8 (2026-07-07)

### AcoustID — diagnostics & error handling
- **Fixed: invalid API key now aborts the worker immediately** with a clear log message instead of silently marking every file as `error` (previously caused 138k error rows for users with a wrong key).
- **Improved logging**: per-file outcomes (found/not_found/API errors/fpcalc failures) are now written to the server log, making it possible to diagnose connectivity and key issues from `docker logs`.
- **API link added to Admin UI**: the "register a free key" hint in the AcoustID settings panel is now a clickable link to `acoustid.org/new-application`.

### Player — Now Playing modal
- **New: technical metadata line** above the star rating — shows format, bitrate, sample rate, and channel count (e.g. `FLAC · 1 411 kbps · 44.1 kHz · Stereo`).

### UI
- Removed "AI slop" wording from the login page tagline across all 12 locale files.

## v0.3.7 (2026-07-06)

### AcoustID & Normalisation — Worker lifecycle fix
- **Fixed: AcoustID and ReplayGain workers now stop automatically** when all files have been processed. Previously both workers would idle indefinitely in a 60-second poll loop even after completing their queue, causing them to appear perpetually "running" in the Admin panel.
- **Fixed: stuck-at-99% progress** — AcoustID rows left as `pending` by a previous server crash were never cleared for users who did not manually restart the worker. The DB startup migration now resets these on every server start, unlocking the remaining percentage.

### UI
- Removed "AI slop" wording from the login page tagline across all 12 locale files.

## v0.3.6 (2026-07-04)

### Player — Lyrics Button
- **New: Lyrics button in the player control bar** — a dedicated lyrics icon sits between the visualizer (eye) and queue buttons. Clicking it opens the lyrics view directly, without having to go through the Now Playing modal first.

## v0.3.5 (2026-06-28)

### Album Art — Scanner
- **Fixed: `front.jpg` and `folder.jpg` now correctly used as album art** when embedded audio tags contain only artist-type pictures (artist photo, band logo, etc.). Previously the scanner would pick the first embedded picture regardless of type, so a track with an artist photo in its tags would be stored with that as its `aaFile` — and `front.jpg` / `folder.jpg` in the same folder was silently ignored. The new `chooseEmbeddedAlbumArt()` helper filters out artist-typed pictures and prefers the Front Cover type; if only artist photos are embedded (or none at all), it falls through to folder art (`front.jpg`, `folder.jpg`, `cover.jpg`, etc.).

### BPM / Key Analysis
- **Fixed: Wasm memory leak in Essentia BPM/key worker** — `RhythmExtractor2013` and `KeyExtractor` vectors are now freed in `finally` blocks after each analysis, preventing steady memory growth during large library scans.

## v0.3.4 (2026-06-24)

### Album Art
- **Save as folder cover**: after embedding art from Discogs, Deezer, iTunes, or a URL in the Now Playing modal, the art image shows a 📁 badge. Clicking it prompts "Save as cover.jpg in the album folder?" — writing a properly sized JPEG and updating the folder-cover DB record for all tracks in that album.

### Performance & Storage
- **DB-first queue**: localStorage queue window reduced from 600 songs to 25 songs (current ±12). The full queue (up to 5 000 songs, up from 2 000) lives in the database and is lazy-loaded into memory 3 seconds after boot — the player is immediately usable while the rest expands silently.
- **New `GET /api/v1/queue` endpoint**: dedicated lightweight fetch for the full saved queue. The client calls this for the lazy-load expansion and cross-browser restore (Subsonic play-queue API is unchanged).
- **Cross-browser queue continuity**: when opening Velvet in a new browser with no localStorage, the full queue is fetched from the DB on first load instead of starting empty.
- **Audiobook resume positions synced to DB**: `_saveBookPosition` now pushes positions to `user_settings.prefs` so resume positions survive across devices and browsers.

---

## v0.3.3 (2026-06-23)

Genre Enricher fixes, Playing Now performance, per-disc cover art, and BM25 search.

### Genre Enricher
- **Apply Consensus and Apply Majority now report distinct artists updated** instead of the raw row count, giving a more meaningful number in the confirmation toast.
- **Majority apply now handles all three two-source combinations** (Last.fm + MB, Last.fm + Discogs, MB + Discogs) correctly — previously only fully-enriched rows were candidates.
- **Removed the consistency reset pass** that was resetting partially-enriched artists on every run and forcing unnecessary re-fetches from Last.fm, MusicBrainz, and Discogs.

### Playing Now
- **Artist songs now appear immediately** on the Playing Now page; the album library panel fills in progressively while songs are already visible.
- **Album library pre-fetched at boot** (4-second delay) so repeat visits to Playing Now are instant — no waiting for the 500 KB library download.

### Enhancements
- **Per-disc cover art**: Multi-disc albums (CD1/CD2/etc.) now carry per-disc `aaFile` in the album detail response. In the album detail view, switching disc tabs updates the main cover image to that disc's art (when it differs from the album cover), and each disc tab button shows a small thumbnail of its own cover when available.
- **BM25 column weighting for search**: FTS5 search now boosts title matches (weight 10) over artist/album_artist (5), album (3), album_version (2), and filepath (1). Searching "bohemian" will now rank a song literally titled "Bohemian Rhapsody" above results that only match the word in a folder path.

### Discogs
- **Fixed: "cannot commit — no transaction is active"** error logged during Discogs/Deezer art updates — a spurious `commitTransaction()` call was removed from `_updateArtRecord`.

## v0.3.2 (2026-06-22)

Small bugfixes.

- Fix download route error propagation (async/await)
- Improve error responses with proper HTTP status codes
- Minor internal cleanup

## v0.3.1 (2026-06-21)

Fix purge-orphaned-vpaths 500, WAV cover art folder write, and dependency bumps.

### Fix
- **Fixed: `POST /api/v1/admin/db/purge-orphaned-vpaths` returned 500** because `manager.js` (the manual re-export proxy for `sqlite-backend.js`) was missing the two new functions `getOrphanedVpaths` and `deleteOrphanedVpathRows` introduced in v0.3.0.

### Album art — WAV / AIFF files
- **Fixed: setting cover art for WAV (and AIFF/W64) files now writes `cover.jpg` to the track's folder** when no folder image is present. WAV containers cannot carry embedded art, so previously the image was downloaded and cached in the database but never made visible on disk. The folder image is now written at 1200 × 1200 px (matching the Album-Art Workshop quality), and the `cover_file` database column is updated accordingly — so the art appears immediately in the file browser, album library, and player without a rescan.

### Dependencies
- `axios` 1.17.0 → 1.18.0
- `fast-xml-parser` 5.8.0 → 5.9.3
- `joi` 18.2.1 → 18.2.3
- `undici` (transitive, group bump)
- CI: `actions/setup-node` 4 → 6, `aquasecurity/trivy-action` pinned to latest digest

## v0.3.0 (2026-06-20)

### Library — Orphaned vpath detection and cleanup
- **Fixed: "vpath X is not a root folder" error in the Album-Art Workshop** when library rows from a renamed or removed folder still exist in the database. The Workshop now skips any row whose vpath is not a current root folder in config, preventing stale entries from ever entering the workshop table.
- **Post-scan warning in the log** when orphaned vpath rows are detected in the `files` table after a rescan — points the admin to the new cleanup tool.
- **New admin action: Purge orphaned vpaths** (Admin → Library). A dry-run step reports the affected vpaths and row count before any deletion. Removes rows from both `files` and `album_art_workshop` for vpaths that no longer exist in config — recovers from folder renames without manual SQL.
- New endpoint: `POST /api/v1/admin/db/purge-orphaned-vpaths` — body `{ dryRun }`, returns `{ orphaned, deleted }`.

## v0.2.8 (2026-06-18)

Docker: PUID/PGID support and album-art permission safeguard.

### Docker — PUID/PGID support
- **The container now accepts `PUID` and `PGID` environment variables** (LinuxServer.io convention). When started as root the entrypoint reassigns the internal `node` user to those ids before dropping privileges, so the process uid/gid matches the host filesystem owner without needing a `user:` override in Compose.
- **Fixed: `user:` override in Compose no longer exits 70 spuriously.** The writable-dir check incorrectly included `/app/bin` — an internal container path that is never bind-mounted and therefore never writable by an arbitrary host uid. It has been removed from the check.
- **Album-Art Workshop: applying a cover now reports a clear error if the album folder is not writable** instead of crashing with an opaque `EACCES` HTTP 500. The message names the folder, the uid, and the fix to apply.

## v0.2.7 (2026-06-18)

Performance, Auto-DJ intelligence, and admin directory health checking.

### Database
- **5 new composite indexes** on `files` and `play_events` for faster Recently Added, decade browse, smart playlist year filters, artist home stats, and per-play lookups. The redundant 2-column `idx_pe_user_hash` index was replaced by a covering 3-column variant.

### Auto-DJ — genre drift prevention
- **Auto-DJ no longer locks into a single genre cluster.** A rolling 25-track genre history detects when a genre becomes over-represented (3 consecutive tracks, or ≥ 40 % of the last 25). When triggered, a single escape pick is requested with that genre blacklisted, breaking out of Trance / Hardstyle / Italo loops while still allowing natural exploration. Hard escape (5+ consecutive) also drops the similar-artist filter entirely to guarantee a way out. History persists across page refreshes and clears on queue/session reset.

### Admin — Directory Health Check
- **New "Scan" button under Admin → Directories.** Checks read and write access for every configured vpath root **and** all its first-level subdirectories. Results are shown inline with expandable per-vpath rows — only problematic subdirectories are listed, hidden dirs are skipped, and the scan is capped at 300 entries per path. Vpaths with issues auto-expand.

### Dependencies
- Removed `undici` from `package.json` — it was never imported; the only consumer was `@distube/ytdl-core` which manages its own version internally.
- Updated `axios` → 1.18.0, `eslint` → 10.5.0, `fast-xml-parser` → 5.9.2, `joi` → 18.2.3, `sharp` → 0.35.1.

## v0.2.6 (2026-06-17)

Sonos casting: the player UI now stays locked to the speaker, and seeking lands cleanly.

### Player — Sonos casting
- **The progress bar/waveform no longer runs ahead of the Sonos speaker.** A proper lead-in now pins the (muted) UI clock to the device's real position until Sonos actually starts streaming, then runs in lockstep — so there's no permanent head-offset and no backward jump when audio begins. The poll briefly speeds up (1 s) during this lead-in only; it stays at 3 s the rest of the track (and never speeds up near a track's end). The natural track-to-next transition, external-control cede, and stopped-stream self-heal are unchanged.
- **Seeking / fast-forwarding now lands cleanly instead of jumping back.** When you scrubbed, a position poll landing mid-seek could read the device's old position and snap the UI back to where you started. The poll now holds off its drift correction for a few seconds after a local seek, so the UI stays at the new position while the speaker catches up.

## v0.2.5 (2026-06-17)

Auto-DJ now survives a page refresh; reverted the Sonos casting-sync change (#32) that regressed real-world playback.

### Player — Auto-DJ
- **Auto-DJ now stays on across a page refresh.** The on/off flag was already saved but never restored on boot, so a refresh silently turned Auto-DJ off. It's now reapplied after the queue is restored (without force-starting playback — it takes over at the end of the current track as usual).
- **The Auto-DJ badge in the queue now survives a refresh.** The per-song `_dj` marker was dropped by the queue-compaction whitelist that keeps localStorage small, so the badge vanished on reload. `_dj` is now persisted with the queue.

### Deploys / cache-busting
- **Fixed: content-hash cache-busters never reached the main player.** The `/` route rewrote `index.html`'s `app.js?v=…` to the plain package version (`app.js?v=0.2.4`), pinning the URL across content changes, so a client-only deploy was invisible until a version bump or restart. It now serves the on-disk content-hash buster (stamped by `sync-webapp-version` on boot), so a changed asset gets a fresh URL and busts the browser cache without a version bump.

### Player — Sonos casting
- **Reverted #32.** The lead-in/anchor/device-end rework misunderstood how Sonos casting works: Velvet pushes a multi-track *window* and the device auto-advances through it itself. Disabling the local re-push plus the faster near-end polling made the "external control" cede fire on a normal track change — the web player paused, stopped syncing, and the UI froze on the finished song while Sonos played on. Restored the previous known-good behaviour. The original polish issue (UI clock slightly ahead of the speaker) will be re-addressed with a window-following approach, verified on real hardware before merge.

## v0.2.4 (2026-06-17)

i18n & British English polish — theme switcher fully translated, British spellings, Dutch admin theme labels.

### Player
- **Fixed: theme switcher buttons Velvet / Dark / Light had no i18n key.** All five theme buttons now use `data-i18n` spans. Dutch users see Donker / Licht / Hoog contrast / Kleurenblind. The High-contrast fallback text was also wrong ("Contrast" → "High contrast").

### Localisation — English
- **British English corrections in en.json.** Fixed: `behavior` → `behaviour`, `favorites` → `favourites` (Sonos Radio), `Customize` → `Customise` (Home/Shortcuts shelf buttons), `Colorblind` → `Colourblind`.

### Localisation — Dutch
- **Fixed: admin default-theme dropdown showed "Velvet Dark" / "Velvet Light" in Dutch.** Now correctly "Velvet Donker" / "Velvet Licht", matching the player theme switcher.

## v0.2.3 (2026-06-17)

Recently-added calendar-day view, scan-errors i18n fix, Auto-DJ similar-artists loop fix.

### Server
- **Fixed: Recently Added groups by calendar day, not by track count.** A bulk import of 500 albums in one session would fill the entire Recently Added view with just that session's tracks. The endpoint now uses a CTE to find the N most recent distinct calendar days on which tracks were added, then returns all tracks from those days — so a bulk import counts as one day and older additions remain visible.

### Admin
- **Fixed: scan-errors table footer showed wrong plural form.** The i18n translation call was missing the `count` parameter, causing several locales to display the singular form or a raw key regardless of how many errors were listed.

### Auto-DJ
- **Fixed: similar-artists mode looped over the same 2–3 songs when the library has few matching tracks.** The server-side ignore list is capped at 50% of the candidate pool; with a 3-track similar-artists pool only 1 song could be cooled at a time, so the other 2 cycled indefinitely. A `MIN_SIMILAR_POOL = 10` threshold now detects tiny pools after the similar-artist steps and forces the fallback chain to widen to the full library. A catch-all handles the no-BPM/no-key case where the existing BPM-gated fallback steps would not fire.

## v0.2.2 (2026-06-16)

Player experience — accessibility, design system, queue multi-select, and stability fixes.

### Server
- **Fixed: browser-cached `index.html` caused stale UI after deploys.** The HTML entry point was served without a `Cache-Control` header, so browsers applied heuristic caching and could hold on to old HTML for hours or days. New JS and CSS would load (they have content-hash cache-busters) but new DOM elements added to the HTML — like the queue selection bar — would be missing, silently breaking features. Now served with `Cache-Control: no-cache` so the browser always revalidates on the next navigation.

### Auto-DJ — fix localStorage quota crash
- **Fixed: Auto-DJ repeatedly threw `QuotaExceededError` and stopped picking next songs.** Two sources of localStorage bloat filled the 5 MB quota: (1) waveform cache keys (`wf:…`, ~2 KB each) accumulated forever — unnecessary because the server already persists generated waveforms to disk and returns them instantly on subsequent requests; (2) older Auto-DJ builds stored full file-path strings instead of bare artist names in the history key. Fix: the `wf:` localStorage layer is removed entirely and replaced with a session-only `Map` (used for crossfade look-ahead and fast track-switching within the same page load). The artist-history write now uses `slice(-500)` and a self-healing catch block. A one-time startup migration (`ms2_ls_clean_v1`) clears all existing `wf:` keys and the artist-history key for every user on first load.

### Player — accessibility
- **Track changes are announced to screen readers.** A polite ARIA live region now reads out *"Now playing: &lt;title&gt; — &lt;artist&gt;"* whenever the current track changes, so screen-reader users hear what started without hunting for the now-playing bar.
- **Text now meets WCAG AA contrast.** Secondary and tertiary text colours (`--t2`/`--t3`) were nudged lighter — keeping the same hue — so every normal-text pair clears the 4.5:1 AA threshold across the Velvet, Dark and Light themes (several previously sat at ~3.0–4.3:1, e.g. tertiary text on cards).
- **Two new accessible themes.** A **High-contrast** theme (pure black/white, AAA-level contrast, a bright focus ring) and a **Colorblind-safe** theme (a blue/orange palette that never relies on red↔green distinctions) join the theme switcher, which now wraps to fit the five options. Both persist like the other themes.
- **Fixed: the theme switcher was unreadable in High-contrast.** The segmented theme pill used the theme `--border` colour as its track fill, but High-contrast sets `--border` to pure white — so the pill turned white and the inactive labels (Velvet/Dark/Light/Colorblind) disappeared. The High-contrast pill now uses a dark track with a white outline, white labels, and a white-on-black active button.
- **Fixed: High-contrast and Colorblind themes resized the layout.** The responsive breakpoints that scale the queue-panel and sidebar widths (`--qp-width`/`--sidebar`) listed only the Velvet/Dark/Light themes, so the High-contrast and Colorblind themes — which redeclare those widths at higher specificity — ignored the breakpoints and locked to the full desktop width, making the panels jump when switching themes. All five themes now share the same responsive widths at every screen size.

### Player — design system (foundation)
- **Spacing and type-scale tokens.** CSS custom properties `--sp-1` through `--sp-8` (4 px → 64 px) and `--type-xs` through `--type-2xl` (11 px → 28 px) are now available in `style.css`. A representative adoption pass applies them to the nav sidebar, player bar text, queue panel sizing, and queue list text — the same values, now driven by a single definition.
- **Button class system.** A canonical `.btn` base class (reset, cursor, transition, font inheritance), `:focus-visible` ring, and `disabled` / `[disabled]` states are now applied consistently to `.btn-primary`, `.btn-ghost`, and `.btn-danger`. A new `.btn-icon` variant mirrors `.icon-btn` for icon-sized square controls.
- **SVG icon helper.** A small `icon(name, {w, h})` function returns named SVG strings for the six most-repeated shapes (`play`, `plus`, `more`, `search`, `music`, `check`). Row action buttons in the four song-row renderers (`renderSongRows`, `renderSongRowsWithPath`, `renderSearchRows`, `renderMostPlayedRows`) now call `icon('plus')` and `icon('more')` instead of repeating inline SVG literals.

### Player — queue multi-select
- **Click the position number to select; click the row to play.** The left-side number cell is now a dedicated select zone — clicking it toggles the checkmark without triggering playback. A plain click anywhere else on the row still plays the track. Ctrl/Cmd+click and Shift+click on any part of the row continue to work for power users. This resolves the UX clash where first-selecting an item also played it.
- **Ctrl/Cmd+click to select queue items, Shift+click to range-select.** Selected items show a checkmark in the position cell and a subtle `--active` background tint; selection state lives only in a JS Set, so it survives virtual-scroll row recycling correctly.
- **Selection bar with bulk actions.** When one or more items are selected, a compact bar appears above the queue list showing the count, a **Remove** button (deletes all selected tracks from the queue in one step, adjusting the current-song pointer cleanly), and an **Add to playlist** button (opens the existing playlist picker and bulk-adds all selected songs). The bar disappears when the selection is cleared.
- **Escape clears the selection.** The global Escape handler now also clears the queue multi-select and re-renders the queue when a selection is active.
- **Fixed: selection stopped working after logout → login.** `_initQueueListeners()` registered a second click handler on `#queue-list` on every login (logout does not reload the page). Each `.q-num` click fired twice — adding then immediately removing the item from the selection Set — so the bar never appeared. A one-per-page-load guard prevents re-registration.

## v0.2.1 (2026-06-16)

Makes Subsonic server-side play-queue persistence self-consistent across upgrades and rescans.

### Subsonic — fixes
- **Server-side play-queue restore is now self-consistent.** For clients that persist their queue on the server via `savePlayQueue`/`getPlayQueue` (e.g. DSub, play:Sub), the saved `current` track id is now re-encoded through the same resolver as the queue entries, so it always matches one of the returned entry ids — even after a Velvet upgrade (older queues stored bare-hash ids) or a library rescan (which reassigns the rowid embedded in each id). Previously `getPlayQueue` echoed `current` verbatim while rebuilding the entries in the canonical `<hash>@<rowid>` form, so the two could diverge and a client could lose its resume point. `getPlayQueue` now falls back to the head of the queue if the current track is gone, and `savePlayQueue` canonicalises ids before storing.
  - *Scope note:* this does **not** affect clients that keep their queue entirely client-side (e.g. Feishin, which never calls these endpoints). A separately reported Feishin symptom — a restored or replaced queue playing the previous queue's next track — was traced to Feishin's own gapless prefetch and is not addressed by this change. See `docs/dev/feishin-gapless-findings.md`.

## v0.2.0 (2026-06-16)

Player experience overhaul + queue-reliability fixes.

### Player — perceived performance & feedback
- **Skeleton loaders.** Slow views now show shimmer placeholders shaped like their result instead of a blank pane or a bare spinner — the Artists gallery, Album Library, search results, and the Home shelves (each shelf fills in as its data arrives).
- **Reduced-motion support.** Velvet now honours the OS *"reduce motion"* setting: a single global rule neutralises every CSS animation/transition, and the auto-triggered JS animations (the Auto-DJ dice throw and the scrolling-title marquee) are skipped via a `_reducedMotion()` guard.
- **Keyboard focus ring.** A consistent `:focus-visible` outline (a new per-theme `--focus` token) now appears on nav buttons, icon buttons, song/queue rows, cards and sliders when navigating by keyboard — and never on mouse/touch.
- **Stacking toasts.** Toasts now stack instead of overwriting one another, announce to screen readers (`role="status"`, errors `role="alert"`), and can carry an action button.
- **Add-to-playlist is instant.** Adding a song to a playlist confirms immediately and reconciles in the background; if the request fails, the error toast offers a **Retry** instead of a dead end.

### Player — empty states & onboarding
- **Clearer empty states.** A consistent illustrated placeholder (icon + title + message + a one-tap action) now replaces bare one-liners for an empty queue, an empty playlist, no starred songs, and zero search results — each offering a relevant next step (browse music, browse by artist).
- **First-run tip.** A quiet, dismissible strip on Home points newcomers at the `?` keyboard-shortcut overlay and Auto-DJ. It appears once and never again after it's dismissed.

### Player — command palette
- **`Ctrl`/`Cmd` + `K` command palette.** A fast fuzzy launcher: type to filter, arrow-keys to move, Enter to run, Esc to close. Jump to any sidebar view or run a transport action (play/pause, next, previous, shuffle, repeat, open equalizer, keyboard-shortcuts help) without reaching for the mouse. It reuses the existing controls' handlers, announces as a dialog with a listbox, and skips its entrance animation under *reduce motion*.

### Player — queue quality-of-life
- **Jump to now playing.** A new button in the queue header re-centres the list on the currently-playing track — handy after scrolling through a long queue.
- **Drag drop-indicator.** Dragging a queue item now shows a precise insertion line at the exact spot it will land (top or bottom of the hovered row, matching the drag direction), instead of just highlighting the row.

### Player — visual delight
- **Buffered-range indicator.** The progress bars (player bar and the Now-Playing view) now show a faint bar that fills ahead of the playhead as audio buffers, so you can see how much is loaded. It stays hidden for live radio streams.
- **Soft view cross-fade.** Switching views now gives the content a brief, subtle fade-in instead of an instant swap. (Implemented as a synchronous CSS animation rather than the View Transitions API, which would have broken views that read the DOM immediately after rendering; it is automatically disabled under *reduce motion*.)
- **Waveform stays on-brand.** The seek-bar waveform's unplayed bars now use a low-alpha tint of the brand gradient instead of a flat neutral grey, so a freshly-loaded track reads as on-brand rather than dead. Played/unplayed contrast now comes from opacity rather than a grey-vs-colour split.

### Tooling
- **Content-hash cache-busters.** Webapp asset URLs are now stamped `…?v=<version>-<hash>`, where the hash is derived from each file's content (`scripts/sync-webapp-version.cjs`). The URL therefore changes whenever a file's content changes — so a merged webapp change reaches browsers on the next deploy without waiting for a version bump, closing a gap where testers kept loading a stale cached `app.js` after a deploy. The hash is deterministic, so the `version-sync` CI gate still passes.

### Player — fixes
- **Queue now survives a refresh even when localStorage is full.** A stale, pre-cap value (an old multi-MB Auto-DJ ignore list, e.g. orphaned under a differently-cased username that the per-user heal path missed) could fill the browser's ~5 MB storage quota, after which the queue write silently failed and the queue was lost on every reload. Three changes fix and harden this: (1) a boot-time sanitizer drops **any** Velvet localStorage value over 512 KB (no legitimate key is remotely that large — the windowed queue tops ~240 KB and the server reseeds prefs and the queue); (2) `persistQueue` reclaims that space and retries the write before falling back to a smaller window; (3) starting fresh playback now actually clears the persisted Auto-DJ ignore list (it previously reset only the in-memory copy, leaving a stale value in localStorage that `_syncPrefs` would push straight back).
- **Auto-DJ no longer floods the console with `QuotaExceededError`.** The Auto-DJ recently-played memory (`ms2_dj_ignore_*` in localStorage) grew without bound — on a large library the server-returned ignore list is tens of thousands of entries, and the whole array was re-serialised on every pick. It eventually exceeded the browser storage quota and every prefetch/fetch threw repeatedly. The list is now capped to a rolling 2 000-entry window and every write is fail-safe, so a full store can never break playback or spam the console. Oversized entries left over from earlier sessions are trimmed automatically on next load and on prefs sync.

## v0.1.7 (2026-06-14)

Album-Art Workshop — MusicBrainz covers, a proper review journey, and full undo.

### Album-Art Workshop
- **MusicBrainz / Cover Art Archive is the first art source.** For albums whose tracks carry a MusicBrainz release id (from Tag Workshop enrichment), the workshop fetches the official front cover from the [Cover Art Archive](https://musicbrainz.org/doc/Cover_Art_Archive/API) first; only when CAA has nothing does it fall back to Discogs → Deezer → iTunes. Releases with no CAA art are never shown — they fall through. ~70% of enriched art-less albums get an official cover this way.
- **Preview before apply — no more wrong covers stored.** Clicking any cover (the big one or a small alternate) now opens a **large preview** with **Apply this cover** / **Back**. Alternates are bigger, and nothing is written until you confirm.
- **Full undo (Restore).** Every apply snapshots the album's previous art; the **Applied** view shows the stored cover with a **Restore** button that reverts exactly (folder `cover.jpg` + DB pointers, or removes it if the album had none).
- **Fix a cover (any album).** A new **Fix a cover** mode searches *any* album — including ones that already have a wrong cover (which never appear under “missing”) — shows the current art, and lets you replace it from **all sources** or a manual URL. New `GET /api/v1/admin/art/find` + `POST /api/v1/admin/art/fix-suggest`.
- **Source filter + MusicBrainz view.** A source chip row (All · ♪ MusicBrainz · Discogs · Deezer · iTunes, with counts) next to the status chips lets you check suggestions by provider.
- **Find missing covers (MusicBrainz).** A dedicated button in the MusicBrainz box runs a Cover-Art-Archive-only pass (`POST /api/v1/admin/art/scan { source:'musicbrainz' }`). Per-album, a **Find cover** button searches a single folder on demand.
- **Batch apply.** **Apply best cover to selected** + `POST /api/v1/admin/art/apply-batch` apply the preferred cover to many albums at once.
- **Seek alternatives for MusicBrainz-only covers.** When an album's only suggestion is the official Cover Art Archive cover, a **Seek alternative covers** button now queries Discogs, Deezer and iTunes on demand (`POST /api/v1/admin/art/suggest { allSources:true }`), shows a spinner while searching, then lists the alternatives like any other source so you can compare and pick.
- **Bigger, clearer previews in Fix a cover.** Suggestions render as larger tiles (with a source badge and a hover *Preview* hint), the album's **current cover is itself clickable** to open a full-size view, and the search-result thumbnails are enlarged — so you can actually see what you're choosing.
- **Detect automatically, apply only on a human decision.** The workshop is deliberately proposal-only: because the library is mostly singles, 12-inches and loose songs (where art searches throw many false positives), nothing is ever written to disk until the admin confirms the cover. See the **Philosophy** section in [docs/album-art-workshop.md](docs/album-art-workshop.md).
- **Cover-forward UI** with source badges (Cover Art Archive covers get a blue **♪ MUSICBRAINZ** badge) and a visible **Prefer official Cover Art Archive covers** toggle (on by default). See [docs/album-art-workshop.md](docs/album-art-workshop.md).

## v0.1.6 (2026-06-13)

Release tooling hardening.

### Maintenance
- **`npm run release` now rebases before pushing.** The first run of the new release script failed when `main` had advanced (Dependabot merges) since the local commit. The Push step now runs `git pull --rebase origin main` before `git push`, so concurrent commits on `main` are integrated automatically instead of the push being rejected.

## v0.1.5 (2026-06-13)

Sonos casting fixes.

### Sonos
- **Fixed: hi-res FLAC silent on Sonos when queued via a child vpath.** `/cast-queue` looked up the track's `sample_rate` with an exact `(vpath, filepath)` match, which misses for child vpaths (e.g. `12-inches`) — their files are indexed under the parent ROOT (`Music`). With `sample_rate` unknown, hi-res (>48 kHz) detection failed and the file streamed **directly** instead of being transcoded, so Sonos (which can't decode 192 kHz) played silence. `/cast-queue` now uses the same child-vpath fallback as `/cast`, so hi-res files are correctly transcoded to 48 kHz MP3 and play.
- **Cast log now names the song.** The `cast-queue` log line shows the now-playing track and how it's routed, e.g. `cast-queue ▶ Alphaville - Sounds Like A Melody [12-inches/A/…flac] (transcoded 192000Hz) → 10.1.1.210`. A direct hi-res stream is flagged `(DIRECT … — Sonos may not decode)`. Upcoming queued tracks are logged separately.

### Maintenance
- **One-command releases.** `npm run release` (or the `/release` command) runs the whole release sequence — bump `package.json`, `sync-version`, release-note retention, `docs/docker.md` pin, tests, commit, push, tag, GitHub release — with safety guards (must be on `main`, Mon–Fri 09:00–17:00 CET blackout check, tag must be free, changelog entry + `releases/vX.Y.Z.md` required). Version and title are read from the top changelog entry. Flags: `--dry-run`, `--no-push`, `--force`, `--skip-tests`, `--title`. See `docs/dev/release.md`.

## v0.1.4 (2026-06-13)

Sonos Favourites — every service, hide controls, live now-playing.

### Sonos
- **All favourites, not just radio.** New `GET /api/v1/sonos/favorites` returns every "My Favorites" entry (FV:2) — Sonos Radio, Spotify, Apple Music, TuneIn, etc. — each tagged with its `service`. Previously only Sonos Radio stations were surfaced, so a Spotify favourite like "New Music Friday NL" was filtered out of the radio list; it now appears. `radio-favorites` still returns the radio-only subset.
- **Play any favourite, any service.** New `POST /api/v1/sonos/play-favorite` plays a favourite by its FV:2 id by replaying the favourite's own stored `res`/`resMD` (which carries the device's service auth token), so Spotify/Apple Music playlists work — not just `x-sonosapi-radio:` stations. Container favourites (playlists) are enqueued; single streams are set directly on the transport.
- **Favourite playback now behaves like a real output.** Starting a favourite (e.g. a Spotify playlist) puts the web player into a dedicated Sonos-Favourite mode: the browser is paused + muted, the player bar shows the device's **live now-playing** (track title/artist/cover + progress, polled every 3 s) and the output button shows the room. Pressing **Play** — or picking any local track — takes control back to the browser and stops the favourite. `GET /api/v1/sonos/transport-status` now also returns `trackTitle`/`trackArtist`/`trackAlbum`/`trackArt`/`trackUri`. *(The full-screen "Playing Now" view still reflects the library queue, not external favourites; the player bar is the live indicator.)*
- **"Sonos Radio" view renamed to "Sonos Favourites".** It now lists every favourite (all services), so the radio-only name no longer fit.
- **Non-playable shortcuts hidden by default.** Favourites with no playable resource (the art-less Sonos shortcut folders like "Nu trendy", "Sonos presenteert", "Sonos Radio ontdekken" that can't be started via the local API) are concealed by default instead of cluttering the list. They — and any admin-hidden favourites — are recalled via **Show hidden (N)**.
- **Hide favourites you don't want.** Each favourite row has an admin **Hide**/**Show** toggle; hidden ones drop out of the list. Stored in config (`sonos.hiddenFavorites`, all users) keyed by a stable content id via the new `POST /api/v1/sonos/favorite-visibility`.
- **Self-healing default-room IP (persisted).** When a cast redirects after DHCP moves the speaker, the rediscovered IP is now written back to the saved `defaultRoom` in config (matched by UUID), so favourites/cast calls stop pointing at the dead address. Complements the in-memory `_sonosTargetIp()` resolution from v0.1.2.

## v0.1.3 (2026-06-13)

Sonos queue mirroring.

### Sonos
- **The Sonos app now shows the queue.** While casting, Velvet mirrors a window of the player queue (current + up to ~30 upcoming) onto the Sonos queue via the new `POST /api/v1/sonos/cast-queue` (plays the current track immediately, appends the rest in the background). The web player stays the source of truth.
- **Per-row album art in CLIC.** Queue-row art is served through the speaker's `/getaa` proxy (extracts the embedded cover from the stream); transcoded streams fall back to the cached `/album-art/` URL. CLIC shows title + duration + per-row art. (The official Sonos S2 app resolves queue-row metadata by source, so its list rows stay blank for HTTP-streamed content — a structural S2 limitation; now-playing renders fully everywhere.)
- **Bidirectional pause + cede control.** Pause/resume from the Sonos app or CLIC is now reflected back in the web player (the sleep LED follows). Navigating on the Sonos app (next / previous / shuffle) makes the web player cede control — it pauses and stops syncing until you press Play in the web again.
- **Never deletes a foreign queue.** `POST /api/v1/sonos/queue/clear` (used on output-switch / tab-close) wipes the Sonos queue only if every track is Velvet's; a user-built queue (e.g. Spotify) is left untouched.
- `GET /api/v1/sonos/transport-status` now also returns the current `track` number.

## v0.1.2 (2026-06-13)

Sonos fix.

### Sonos
- **Fixed: "Sonos Radio" nav hidden after the speaker's IP changed.** The Radio-nav reachability check (and the favourites/browse loaders) used the stored default-room IP, which goes stale when the speaker's DHCP address changes — probing the dead address hid the menu even while casting worked. `_sonosTargetIp()` now resolves the default room to its live discovered IP by UUID, self-healing DHCP drift.

## v0.1.1 (2026-06-13)

Sonos sleep mode.

### Sonos
- **Sleep mode (opt-in, per admin).** Enable under **Admin → Sonos**. When on and casting to a Sonos device, **pause turns the speaker's status LED off** (direct sleep — a paused/zero-volume state; the device stays reachable) and **play turns it back on**. Selecting or re-selecting a device aligns the LED with playback (paused keeps it asleep, playing wakes it), and closing the tab drops the LED.
- **New endpoints.** `GET`/`POST /api/v1/sonos/led` read/set the status LED (`GetLEDState`/`SetLEDState`); `GET`/`POST /api/v1/sonos/sleep` read/set the native sleep timer (`ConfigureSleepTimer`). `POST /api/v1/admin/sonos` now accepts `sleepEnabled`.
- **Admin test panel.** With sleep mode enabled, a test panel exposes **Sleep now** / **Wake** with a live countdown plus transport + LED readout to verify the device responds. Hidden when sleep mode is disabled.
- **Admin notes.** Clarified that sleep mode is a reachable paused/zero-volume state, not a power-off, and that the device's **Battery Saver** (a Sonos cloud/app setting, not on the local API) powers the speaker off after ~30 min idle — disable it in the Sonos app for a reachable low-power sleep.

## v0.1.0 (2026-06-12)

Accessibility milestone.

### Accessibility
- **Keyboard & screen-reader support across the player.** The seek/progress bars are now real ARIA sliders (`role="slider"`, keyboard-focusable, live position announced as "1:23 / 4:05"). Icon-only buttons get an `aria-label` automatically (mirrored from their translated tooltip). Every dialog now announces itself (`role="dialog"`/`aria-modal`), traps focus while open, closes on `Esc`, and restores focus to the control that opened it.
- **Expanded, discoverable keyboard shortcuts.** Added `/` (jump to search), `R` (cycle repeat) and `?` (open an in-app keyboard-shortcuts cheat-sheet), alongside the existing `Space`, `←/→`, `Shift+←/→`, `↑/↓`, `M`, `S`. New `docs/accessibility.md` documents the full set.

### Admin
- **"Backup" is now "Backup & Logs".** The log download and the "write logs to disk" toggle moved into this page; the separate Logs page was removed. The log download is now a clean bundle of only `*.log` files from the **last 7 days** — no rotate-audit `.json`, no stray sub-folders.

### Sonos
- **Unreachable devices are clearly marked and can't be mis-selected.** In the output picker a device shows yellow (checking) → green (ready) → **red (offline, not selectable)**; you can no longer pick a dead device and trigger a cast error.
- **Quieter logs.** Sonos discovery now logs only on state change instead of repeating "device unreachable" every few minutes.

### UI
- Minor login-screen wording tweak.

## v0.0.9 (2026-06-12)

### Build & maintenance
- **Version sync now covers every webapp cache-buster.** `scripts/sync-webapp-version.cjs` now stamps any `.js`/`.css` `?v=` cache-buster from `package.json` in every webapp entry document. The mobile stylesheet cache-buster (`mobile/app.css?v=`) was previously not bumped on release, so mobile users could keep loading a stale cached stylesheet after an upgrade. All cache-busters are again single-sourced from `package.json`.

## v0.0.8 (2026-06-12)

### Fixes
- **Sonos — auto-resume when the stream drops.** If a Sonos device goes silent mid-track while it should be playing (the HTTP stream dropped or the device idled), the player now detects the stopped device and re-casts the current track at the current position automatically — no more switching output Web↔Sonos to get sound back. Guarded so it won't loop or interrupt the natural end-of-track hand-off to the next song.
- **Shared playlist pages play again.** The public share page (`/shared/...`) failed to load its player under the strict Content-Security-Policy because its logic ran as an inline script. The player code is now an external script and the playlist data is passed as a non-executable JSON block, so the page works without weakening CSP.

## v0.0.7 (2026-06-12)

### Fixes
- **Server speaker (MPV cast) — resilient resume.** Playback now recovers on its own after a backend restart, even while the browser tab is in the background. The cast heartbeat moved into a Web Worker (which browsers do not throttle when a tab is hidden), MPV auto-starts on the first cast request after a restart, and an active stream is no longer stopped by the idle watchdog while it is genuinely playing. A hidden tab no longer pauses the server speaker by mistake.
- **Cross-device queue resume.** Reloading the player on a second device/browser now restores the song that was actually playing or paused — not the first track in the queue. Boot-time restore no longer overwrites the server-side queue before it has been read, and the current track is matched by file path so the right row is selected and scrolled into view.
- **Subsonic — duplicate content hashes.** Song IDs are now always disambiguated per file, so Subsonic clients no longer confuse two different files that happen to share a content hash; hash lookups return a stable row.

### Internal
- Content-Security-Policy now sets an explicit `worker-src 'self' blob:` so the cast heartbeat Worker loads correctly.

## v0.0.6 (2026-06-12)

### Features
- **Album-Art Workshop** (admin): finds albums that have no cover art, fetches cover suggestions from Discogs, Deezer and iTunes, and lets you approve a thumbnail to write `cover.jpg` into the album folder (plus cached + thumbnailed art for instant display). A review-first design — nothing is written without approval, unless **Auto-approve the best match** is enabled. The suggestion pass runs through the background broker, so it is serialised and never competes with a library scan; with **Auto-suggest for newly added folders** enabled it re-runs automatically after each scan to cover new, art-less folders. Endpoints under `/api/v1/admin/art/*`.

### Fixes
- Docker migration: first boot now correctly renames the legacy database file to `velvet.sqlite` when the new database file is absent, so existing user metadata such as starred titles survives a redeploy.
- Admin backup/import: legacy backup archives that still contain the old database file are now accepted during restore.

### Docs
- Install and backup docs now explain the SQLite migration and legacy restore compatibility.

## v0.0.5 (2026-06-11)

### Fixes
- Scanner: Docker/library scans no longer hang forever on a single malformed file during targeted metadata backfill. All scanner re-parse phases now run under the same 30 s timeout guard as full parses, and timeout logs now include the exact phase + file path so stuck files can be identified from logs.

### UI
- Player branding: enlarged the sidebar Velvet logo and the centre VU logo so the branding reads more clearly during playback.

### Docs
- Docker: clarified that `ghcr.io/aroundmyroom/velvet:latest` can be used directly in addition to version-pinned tags.

### Cleanup
- Removed the unused legacy `webapp/alpha` frontend files so the repo no longer carries an unmaintained alternate client surface.

## v0.0.4 (2026-06-11)

### Fixes
- Anonymous telemetry ping now targets the stable custom domain `velvet.aroundmyroom.com` instead of the old `velvet-velvet.aroundmyroom.workers.dev` subdomain, which had been renamed and was returning 404 — instance pings work again.

### Docs
- Added a one-time "Switching from the previous upstream repo" guide to `docs/install.md` for bare-metal/Node users moving an existing clone to the new `Velvet` git repo (the fresh history makes a plain `git pull` fail). Covers the in-place remote switch and a fresh-clone alternative; config/data is preserved automatically since it lives in gitignored folders.

## v0.0.3 (2026-06-11)

### Build & maintenance
- Version is now single-sourced from `package.json`. A new `scripts/sync-webapp-version.cjs` stamps the version into every webapp cache-buster and version string (`index.html`, `app.js` `VELVET_VERSION`, the login version tag, `admin/index.html`, `shared/index.html`, `mobile/index.html`, `webapp/package.json`). It runs automatically on server boot and via `npm run sync-version`, so a release only edits `package.json` instead of 8–10 files.

## v0.0.2 (2026-06-11)

### Player & visualizer
- Milkdrop "Velvet" preset now features the Velvet logo as a sound-reactive centrepiece: hue-cycling halo and logo glow that pulse on bass, rotating aura rays that react to treble, and beat-rings that emanate from the logo
- Sidebar: removed the duplicate plain "Velvet" label; the styled logotype now aligns to the logo height

### Fixes
- Auth: stop repeated `401` failures on background polls. `api()` now clears an expired/invalid token centrally so guarded pollers stop retrying a dead token; pre-login poll guards corrected (`/sonos/devices`, `/radio/schedules/active`, scan status)
- Sonos: selecting Sonos no longer leaves the browser audible while keeping the VU meters and spectrum alive — browser output is silenced via the cast-mute gain node without starving the analyser feed
- Queue: localStorage quota overflow no longer spams the log or hammers the DB sync every cycle — it now retries a smaller window first and throttles the DB fallback
- Scanner: multi-disc albums can use a parent-folder cover (`../Folder.jpg`) without tripping the "path outside allowed root" guard
- Recently Added: ordering now uses the time the scanner first discovered a file, not the file's modification date, so freshly scanned files sort correctly

### Docs & maintenance
- Docker: added a migration guide for users moving from the previous Docker image
- Removed unused GitHub Actions workflows (Build Webapp, build-electron, Deploy Demo Site, Update Website)

## v0.0.1 (2026-06-11)

- Initial public release of Velvet
- Established repository, CI/CD pipeline, and Docker image publishing
- Multi-arch Docker image (`linux/amd64` + `linux/arm64`) via `ghcr.io/aroundmyroom/velvet`
- GitHub Actions: docker-publish, build, test-ffmpeg-bootstrap
- CLAUDE.md and project guidelines added
