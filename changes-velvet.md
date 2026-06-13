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
