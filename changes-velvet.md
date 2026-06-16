## v0.1.8 (2026-06-15)

Player UI polish — perceived performance, feedback, and clearer empty states.

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
