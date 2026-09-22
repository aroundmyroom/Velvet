# Velvet TODO

---

## NOW — In Progress / Remaining

### Artist and Album Identity Improvements

- [x] Fold diacritics in the existing artist grouping key so accented and
  unaccented tags share one identity while display names and raw variants stay
  unchanged.
- [x] Make canonical artist display-name selection deterministic and
  non-mutating; preserve admin overrides.
- [x] Add a separate artist sort-name field/election for navigation without
  changing the displayed canonical name.

### Scheduled Backup — Velvet Data (Admin → Directories)

Automated daily backup of all Velvet cache and data to a user-chosen folder (NAS, external drive, etc.), with independently-extractable zip snapshots and configurable retention.

#### What is backed up

| Source | Location | Approx. size | Notes |
|---|---|---|---|
| Album art cache | `image-cache/` (flat, ~109K files) | ~15 GB | MD5-named JPEGs |
| Artist images | `image-cache/artists/` | ~820 MB | subfolder of above |
| Database | `save/db/velvet.sqlite` | ~713 MB | SQLite `VACUUM INTO` hot-copy first |
| Waveform cache | `waveform-cache/` | ~10 MB | SVG files |
| Config | `save/conf/default.json` | ~36 KB | passwords are hashed — safe to back up |

#### Destination structure

```
<backup-folder>/
  live/                        ← rolling mirror, always current
    image-cache/
    artists/
    db/
      velvet-YYYY-MM-DD.sqlite   ← today's VACUUM INTO hot-copy
    waveform-cache/
    config/
      default-YYYY-MM-DD.json
  zip/
    2026-05-14/                ← one folder per day, kept for <retention> days
      image-cache-001.zip      ← ≤ 1024 MB, independently extractable
      image-cache-002.zip
      ...
      artists-001.zip
      db-001.zip               ← VACUUM copy, single zip (fits in ≤ 1 GB)
      waveform-001.zip
      config-001.zip
      manifest.json            ← date, source versions, part counts per category
```

#### Key design rules

- **ZIP split strategy**: each ZIP file ≤ 1024 MB and independently extractable. Unlike RAR `.r01/.r02` chains, every `.zip` part can be extracted in isolation — the file set is partitioned across independent archives, never a single file split across parts.  
  Strategy: sort files by size descending, fill current ZIP until adding the next file would exceed 1024 MB, then start a new ZIP. Any single file larger than 1024 MB (unlikely here) gets its own zip.
- **Live sync**: `rsync --checksum --delete` semantics — adds new files, updates changed files, removes deleted files. Runs as the live mirror refresh.
- **Daily snapshot**: after live sync completes, walk `live/` and re-zip into today's date folder. Existing today-folder is overwritten (only one zip set per day).
- **DB hot-copy**: always use SQLite `VACUUM INTO '/tmp/velvet-backup-YYYYMMDD.sqlite'` before zipping to get a clean consistent snapshot with no WAL journal.
- **Retention**: delete date folders older than N days (default 7, user range 1–21). Enforced after each daily run.
- **One job at a time**: share the existing `task-queue` mutex — no concurrent scan + backup.

#### Storage estimates

| Retention | Est. storage |
|---|---|
| 3 days (min) | ~50 GB |
| 7 days (default) | ~120 GB |
| 21 days (max) | ~360 GB |

All on the user's chosen drive — not on the 47 GB system disk.

#### Admin UI — Directories view additions

- **Backup folder** text input + browse button (writes to config). Greyed-out if blank. Shows a `(writable ✓ / ✗)` live check result.
- **Retention** numeric spinner: 1–21 days (default 7).
- **Run now** button → triggers the backup job immediately (shows live progress in the same style as scan progress).
- **Schedule** selector: Daily at a fixed hour (default 03:00), or Manual only.
- **Status card**: last run date/time, result (OK / error), total zip folder size, next scheduled run.

#### REST endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/admin/backup/run` | Trigger immediate backup job |
| `POST` | `/api/v1/admin/backup/stop` | Cancel in-progress backup |
| `GET` | `/api/v1/admin/backup/status` | Job status + last run info + disk usage |
| `GET` | `/api/v1/admin/backup/validate-path` | Test that a path is writable |

#### Config additions (`default.json`)

```json
"backup": {
  "destination": "",
  "retentionDays": 7,
  "scheduledHour": 3,
  "enabled": false
}
```

#### Work breakdown

> **Warning:** `src/api/backup.js` already exists as an unrelated legacy feature (weekly zip of DB+config into `save/backups/`, keeps 4 — `:143`, `:152`, `:161`, scheduler `:134`). This work must EXTEND it and keep those routes, not replace the module.

- [ ] **Config schema**: add `backup` block to the `src/state/config.js` validator; expose via `GET /api/v1/admin/config`
- [ ] **`src/api/backup.js`**: new module — 4 endpoints above + scheduled job bootstrap
- [ ] **`src/util/backup-worker.mjs`** (or inline): live-sync logic (walk + compare mtime/size), zip-partition logic (sort by size, fill to 1024 MB, use `archiver`), DB VACUUM INTO, retention cleanup
- [ ] **Register** in `server.js`
- [ ] **Admin UI** (`webapp/admin/index.js`): backup settings card in Directories view — folder input with writable check, retention spinner, schedule picker, run/stop buttons, status card
- [ ] **i18n**: add keys to all 12 `webapp/locales/*.json` — `admin.backup.*`
- [ ] **`docs/backup.md`**: update (file exists at `docs/backup.md`) with full feature spec
- [ ] **`docs/API.md`**: add Backup section to the admin table

#### Notes

- `archiver` npm package is already in `package.json` — no new dependency needed.
- The `image-cache/` flat root has ~109K files at ~15 GB total. At 1024 MB per zip that's ~15 independent zip files per daily snapshot. Each is fully usable standalone.
- Waveform cache and config are tiny — each gets a single zip per day.
- The `image-cache/artists/` subfolder is physically inside `image-cache/` — back it up as part of the image-cache run (the walker sees it naturally).
- Writer thread must NOT back up the `zip/` subfolder into itself when walking `live/`.
- On Docker installs the backup destination must be a mounted volume — document this in `docs/backup.md` and `docs/docker.md`.

---

### Migration — Export & Import (Admin → Database menu) — MOSTLY BUILT

> **Status:** export is fully working; the import backend is written but the **UI is
> deliberately disabled** and **vpath remapping is still a stub**. Only those two
> things remain. Do not rebuild the module.
>
> Shipped: `src/api/migrate.js` (7 endpoints: export/start `:287`, export/status `:317`,
> export/download `:333`, upload `:348`, apply `:364`, status `:386`, cleanup `:404`),
> registered at `src/server.js:42`, `:333`. Admin UI `migrate-view` at
> `webapp/admin/index.js:3821`, nav at `webapp/admin/index.html:207`. 42 `admin.migrate.*`
> i18n keys already exist in all 12 locales. All 7 endpoints documented at `docs/API.md:912-918`.
>
> Remaining work:
> - [ ] **vpath remapping** — `src/api/migrate.js:211-213` is a stub: *"this would need UI interaction / For now, just restore config as-is"*
> - [ ] **Re-enable the import UI** — `webapp/admin/index.js:3907-3915` wraps the section in `opacity:.4;pointer-events:none` with the button `disabled`
> - [ ] **"Keep this system's user accounts" checkbox** — the `keepUsers` param exists in the API (`docs/API.md:916`) but has no UI control
>
> Note the spec below describes a one-shot `GET /migrate/export`; the built reality is a
> 3-call async start/status/download flow.

Export the full Velvet state as a ZIP and import it on a new instance (Docker, VM, different IP/hostname) in two steps with vpath remapping.

**Export** (`GET /api/v1/admin/migrate/export`)
- Always includes: `velvet.sqlite` (VACUUM INTO hot-copy), `default.json`, `manifest.json` (version, timestamp, vpath roots)
- Optional checkbox: *Include waveforms* (default on, ~5 MB)
- Optional checkbox: *Include artist images* (default off — 15 GB warning shown)
- Streams the ZIP directly to the browser

**Import — Step 1: Upload** (`POST /api/v1/admin/migrate/upload`)
- Upload ZIP → extract to `/tmp/velvet-migrate-<id>/`, read manifest
- Return: export date, source version, list of old vpath roots

**Import — Step 2: Remap & Apply** (`POST /api/v1/admin/migrate/apply`)
- UI shows each old vpath root with a text input for the new path
- Checkbox: *Keep this system's user accounts* (default ✅) — if unchecked, imports users + JWT secret from ZIP (full clone)
- On Apply: write DB, rewrite config with remapped paths, copy caches, restart server
- Security warning shown: *"This archive contains credentials — keep it secure."*

**Files to create/modify:**
- `src/api/migrate.js` — new module
- Register in `server.js`
- `webapp/admin/index.js` — `migrate-view` component
- `webapp/admin/index.html` — nav item (under Database section) + view
- All 12 `webapp/locales/*.json` — i18n keys

### Artist Image Moderation — Follow-ups

- [ ] Admin Artists: add bulk actions (apply first Discogs candidate to selected rows)
- [ ] Admin Artists: add pagination/filter by minimum song count for very large libraries
- [x] Admin Artists: image dimensions in the manual URL preview — DONE (`webapp/admin/index.js` `onCustomPreviewLoad`, key `admin.artists.previewDims`)
- [ ] Admin Artists: add bulk Yes/No validation actions in the With image review list
- [ ] Admin Directories: add bulk Artists On/Off actions by folder type (music/audio-books/recordings)
- [ ] Admin Directories: parent/child inheritance badges for Albums Only and Artists On/Off — PARTIAL: the folder tree already computes parent/child (`webapp/admin/index.js:1897-1934`); only the badge render is missing (toggles at `:1765`, `:1777`)
- [ ] Player Artist Library: optional badge for already-flagged wrong artists (admin-only)
- [ ] Add global media-enrichment budget (shared limiter between artist-image hydration and album-art background tasks)


### Subsonic / OpenSubsonic API — compliance audit & further testing

- [x] **`getMusicDirectory`**: DSub + Ultrasonic confirmed working (`docs/subsonic.md:13`, `:15`, `:163`)
- [ ] **`getMusicDirectory`**: still untested with Jamstash
- [x] **`search2` / `search3`**: empty-query pagination verified against py-opensonic; per-category FTS5 column semantics documented (`docs/subsonic.md:42`, `:180`)
- [ ] Run through the full [OpenSubsonic conformance checklist](https://opensubsonic.netlify.app/)

---

### 📱 Mobile / PWA — DONE, shipped as a dedicated PWA

The 2026-03-26 audit proposed **Option A — a separate `mobile.css`** overlay. That
strategy was abandoned. Phones now get a **dedicated PWA at `/mobile/`** with
server-side UA routing, so `webapp/mobile.css` does not exist and must not be created.

Shipped: `webapp/mobile/` — `index.html`, `app.js` (2001 lines), `app.css` (528 lines),
`sw.js`, `manifest.json`, `icons/`. Routing in `src/server.js:157` with a `?ui=desktop|mobile`
override and a sticky `ms2_ui` cookie (`:179-186`).

- [x] Phone/tablet layout — `webapp/mobile/app.css` (replaces the `mobile.css` overlay idea)
- [x] UA routing instead of a media-query stylesheet — `src/server.js:157`, `:179-186`
- [x] iOS PWA meta tags — `webapp/mobile/index.html:6-10`
- [x] `-webkit-tap-highlight-color: transparent` — `webapp/mobile/app.css:46`
- [x] Manifest `orientation` / `scope` / `id` — `webapp/mobile/manifest.json` (a static file now, not an inline Blob)
- [x] Service worker for offline caching — `webapp/mobile/sw.js` (album-art cache-first, 500-entry cap), registered at `webapp/mobile/app.js:13-16`
- [ ] Library sync manifest — `POST /api/v1/sync/manifest`: server returns a library manifest (hashes, paths, mtimes) so a client can diff and sync offline content. **The only genuinely open item here.** Idea from upstream mStream branch `claude/sync-manifest` (Sep 2026); pairs with the service worker above (see `docs/mobile-app-plan.md`).

### Sonos — reliable seeking into unbuffered audio — PLANNED (approved, not started)

Seeking into a part of a track Sonos hasn't buffered yet stalls the speaker for a long time and sometimes restarts the song from 0. Root cause: Velvet sends `Seek REL_TIME` and relies on Sonos to seek the live HTTP `/media` stream itself (the AVTransport API confirms `REL_TIME` is the only in-track seek unit; Seek returns `701` when the content "does not support seek"). The fix is to stop asking Sonos to seek a live stream and instead **re-cast a fresh stream that begins at the seek point** — the same pattern already used for transcoded streams (`?start=N`), generalised to native FLAC/MP3/WAV via a cheap ffmpeg **remux** (`-ss N -c copy`, no re-encode). Builds on v0.2.6's lead-in (the re-cast re-arms it, so the UI locks to the new position). Full design: `/root/.claude/plans/analyze-my-existing-project-cosmic-map.md`.

- [ ] New `GET /api/v1/sonos/stream-at?fp=&token=&start=N` — `ffmpeg -ss N -i <file> -vn -c:a copy -f <container> -`, modelled on `transcode-stream` (`src/api/sonos.js`)
- [ ] `_resolveStreamUrl`: native + `seekTo>0.5` → `stream-at`; `seekTo==0` → `/media` (unchanged); transcode path unchanged
- [ ] Treat the offset stream like the transcoded live-pipe: `soapSeekTo=0`, `streamStartOffset=N`, DIDL `res@duration` = remaining (`duration−N`)
- [x] Cheap wins — DONE: `_sonosBuildWindow` (and the top-up + activate paths) now send `duration`, and `buildDidl` takes a real per-format `protocolInfo` via `mimeForPath()` (`src/api/sonos.js`)
- [ ] Client `_onAudioSeeked` Sonos branch → debounced `_sonosPushWindow(newPos)` instead of `POST /api/v1/sonos/seek`
- [ ] Verify on real Sonos: FLAC mid-file remux plays; WAV piping (else fall back to lossless `-c:a flac`); seek into unbuffered region never restarts from 0; FLAC/MP3/WAV all OK
- [ ] Separate PR off `main`, hardware-verified before merge (no stacked PRs)

## FUTURE — image-cache 2-level hash subdirectory layout *(low priority)*

Currently `image-cache/` holds ~109K MD5-named JPEG files in a single flat directory (~15 GB). ext4 htree keeps direct lookups fast, but directory walks (rsync, backup zip creation, `find`) slow down linearly with file count. At ~300K+ files even htree lookups start degrading.

**Fix:** migrate to a 2-level Git-objects-style layout using the first 2 hex chars of the MD5 as a subdirectory:

```
before:  image-cache/2780b157fbe88da69809f187f9cae009.jpg
after:   image-cache/27/2780b157fbe88da69809f187f9cae009.jpg
```

256 buckets → ~430 files/dir at current scale.

**Work:**
- [ ] **There is no path helper today — it has to be created first.** `src/api/files.js` does not exist; art paths are built ad hoc from `config.program.storage.albumArtDirectory` at 15+ call sites (`radio-recorder.js:121`, `discogs.js:409,440`, `podcasts.js:28,104`, `server.js:388`, `scanner.js:466`, `db/task-queue.js:291,356`, `download.js:159`, `dlna.js:1170`, `migrate.js:79,249`, `album-art-workshop.js:428`, `subsonic.js:1473,1581,1605,1630`, `radio.js:26`). Create `src/util/art-path.js`, retrofit every site, then add the 2-char prefix. `dlna.js:1170` also mounts `/album-art` as flat static and needs a rewrite middleware. Re-scoped: **LARGE**, not a one-liner. Precedent for the back-compat shim: artist images already use a subfolder with a legacy fallback (`artists-browse.js:36`, `:87-88`)
- [ ] One-time migration script: `find image-cache -maxdepth 1 -type f | for each file → mkdir -p image-cache/${md5:0:2}/ && mv`
- [ ] Update the backup worker (when built) to walk the new structure
- [ ] Verify album-art serving, on-demand art endpoint, and artist-image serving all use the helper (not hardcoded paths)

**Do before:** implementing the daily backup feature (smaller dirs = faster rsync stat pass and zip walk).  
**Blocks nothing** in the current release.

---

## FUTURE — Music Library Backup (file mirror)

Port the upstream music-file mirroring system from Velvet
**This is separate from our existing DB+config ZIP backup** — it mirrors the actual music files to a local destination (rsync-style), protecting against drive failure or accidental deletes.

Key upstream design (worth keeping):
- Per-library N destinations, each with: trigger type (after-scan / daily / manual), retention days (soft-delete trash), per-file throttle, exclude globs (`Thumbs.db`, `.DS_Store`, `._*`, `desktop.ini`)
- Worker: sorted merge-walk (O(max files in one dir) memory), atomic copies via tmp→rename, resume for files ≥ 16 MB, empty-source guard (refuses to run when library appears unmounted), NFC normalisation for HFS+ NFD-on-disk, 2 s mtime tolerance for FAT/HFS+ rounding
- Admin UI: destinations table with inline edit, add form with live path validation, exclude-globs modal, per-destination history panel, live progress card
- DB schema: `backup_destinations` + `backup_history` tables; task-queue mutex so scan and backup never run concurrently

**Integration notes before porting:**
- Their `task-queue.js` was heavily refactored — needs careful merging with our version
- Their DB schema uses V28–V30 — must renumber to not conflict with our current schema version
- Their `admin/index.js` delta is ~730 lines — review against our existing admin UI before merging

---

## FUTURE — Library Management

### Tag Workshop — Tag Display Mode (Admin → Tags)

Add a server-wide setting in the admin that controls which set of tags the player/UI uses for **all** display (Now Playing bar, queue, search results, album browser, artist browser, file browser).

**4 modes:**

| # | Mode key | Behaviour |
|---|---|---|
| 1 | `file` (default) | Always use live file tags — `title`, `artist`, `album`, `year`, `track` as scanned from disk |
| 2 | `mb` | Use MB/AcoustID staged tags where available, fall back to file tags — `COALESCE(mb_title, title)` etc. Includes pending, ready, applied and skipped rows |
| 3 | `mb_confirmed` | Same as mode 2, but **skip shelved rows** (`tag_status = 'skipped'`) — those fall back to file tags |
| 4 | `mb_applied` | Only use MB tags that were **explicitly accepted** by the admin (`tag_status = 'applied'`); everything else uses file tags. Safest production option |

**Architecture — how it works:**

`renderMetadataObj()` in `src/api/db.js` is the **single bottleneck** — every track metadata object sent to the player goes through it. The mode COALESCE logic goes there. No client changes needed.

The tag mode is **server-wide** (not per-user), stored in a new `server_settings` DB singleton table (id=1).

**Work breakdown:**

- [ ] **DB: `server_settings` singleton table** — `CREATE TABLE IF NOT EXISTS server_settings (id INTEGER PRIMARY KEY DEFAULT 1, tag_mode TEXT NOT NULL DEFAULT 'file')`. Add `getTagMode()` / `setTagMode(mode)` to `src/db/sqlite-backend.js`. Cache in memory on load; invalidate on admin POST.

- [ ] **DB query audit** — `renderMetadataObj()` needs `mb_title`, `mb_artist`, `mb_album`, `mb_year`, `mb_track`, `tag_status` in the row. Audit every function that feeds it:
  - `getAllFilesWithMetadata` — uses `SELECT f.*` → already includes `mb_*` ✓
  - `getFileWithMetadata` → uses `_s.getFileWithMeta` prepared statement — check if explicit column list, add `mb_*` if needed
  - `searchFiles`, `searchFilesAllWords`, `searchAlbumsByArtist` — likely explicit column lists, need `mb_*` added
  - `getSongsByGenre`, `getSongsByDecade`, `getSongByHash` — check explicit column lists
  - `albums-browse.js` album track queries — check
  - `smart-playlists.js` queries — check
  - **Rule:** wherever the SELECT is `f.*` it's fine; wherever it's an explicit list, add `, f.mb_title, f.mb_artist, f.mb_album, f.mb_year, f.mb_track, f.tag_status`

- [ ] **`renderMetadataObj()` changes** — read current `getTagMode()` (cached, cheap), then:
  ```js
  function _applyTagMode(row) {
    const mode = getTagMode(); // cached in-process
    if (mode === 'file') return row;
    const eligible = mode === 'mb' ||
      (mode === 'mb_confirmed' && row.tag_status !== 'skipped') ||
      (mode === 'mb_applied'   && row.tag_status === 'applied');
    if (!eligible) return row;
    return {
      ...row,
      title:  row.mb_title  ?? row.title,
      artist: row.mb_artist ?? row.artist,
      album:  row.mb_album  ?? row.album,
      year:   row.mb_year   ?? row.year,
      track:  row.mb_track  ?? row.track,
    };
  }
  ```

- [ ] **Admin API** — add to `src/api/tagworkshop.js` (or a new `src/api/server-settings.js`):
  - `GET /api/v1/admin/tag-mode` → `{ mode, stats: { total, mb_ready, mb_applied, mb_skipped } }`
  - `POST /api/v1/admin/tag-mode` → `{ mode }` → validate, save, invalidate cache

- [ ] **Admin UI** — new "Tags" section in Tag Workshop view (or a separate Admin → Tags page):
  - 4 radio buttons with clear descriptions for each mode
  - Stats row: "X files have MB tags — Y applied, Z pending, W shelved"
  - Save button; success toast
  - Warning banner when mode is `mb` or `mb_confirmed`: "Staged tags have not all been reviewed"

- [ ] **i18n keys** — add `admin.tagMode.*` keys to all 12 locale files

- [ ] **Docs** — update `docs/API.md` with new endpoint; note in `docs/tageditor.md` or new `docs/tag-display-mode.md`

**Risk / complexity note:** The DB query audit (step 2) is the bulk of the work — ~10 functions to check. Many already use `f.*` so the actual add is small. The `renderMetadataObj` change is a single function. Admin UI and API are straightforward.

### Tag Workshop — Enhancements
- [ ] "Apply to similar filenames" — propagate artist/album guess to other files in same folder

### Gapless — scan-time silence trimming *(optional)*
- [ ] Server: detect `silence_end_ms` / `silence_start_ms` via `ffmpeg silencedetect` at scan time; store in DB
- [ ] Client: use DB offsets instead of fixed 80 ms window when available

---

## FUTURE — Accessibility & Appearance

### Customizable Themes

#### Track A — External / File-based Themes
- [ ] `themes/` dir + static route + `GET /api/v1/themes` listing `.css` files
- [ ] Appearance settings: built-in swatches + discovered file-based themes

#### Track B — In-UI Color Customizer
- [ ] `viewThemeEditor()` panel: hue wheel for `--primary`, lightness sliders, contrast-ratio display
- [ ] 4–5 colorblind-safe presets (deuteranopia, protanopia, tritanopia, high-contrast dark/light)
- [ ] Persist custom variable blob to `localStorage`; apply before first paint

#### Theme Persistence
- [ ] `GET /api/v1/themes`, `POST /api/v1/themes` (admin), `DELETE /api/v1/themes/:name` (admin)
- [ ] On theme change → write `localStorage` immediately + debounce PUT to `user_settings`
- [ ] Audit `_updateBadgeFg` and `_applyAlbumArtTheme` — add `lockAccent` flag guard

---

## FUTURE — Home, Analytics & Discovery

### Album-Art Workshop — follow-ups
- [x] Add MusicBrainz / Cover Art Archive as additional cover suggestion sources — DONE, and CAA is the first-priority source (`src/api/album-art-workshop.js:16`, `:287`; `coverArtArchive` toggle at `:32`)
- [ ] Optional multi-art gallery model (multiple covers per album, user picks the default) — larger schema change
- [ ] Wire the album-art suggestion pass into the shared media-enrichment budget limiter (see Performance section)

### Smart Auto-DJ — Personal Weights
- [ ] Re-rank candidates by `completion_rate × recency_decay`
- [ ] Penalise songs skipped >2× in the last 30 days

### 🎵 Acoustic Similarity & Audio Analysis — Phase 1 DONE

> Full design document: [`docs/audio-analysis.md`](docs/audio-analysis.md)

Phase 1 complete (v6.14.17): `audio_features` table, `essentia-bpm-worker.mjs`, `getSimilarSongs()`, `GET /api/v1/db/similar`, `GET /api/v1/db/audio-features/:hash`, Essentia start/stop endpoints.

**AudioMuse-AI sidecar — investigate before building native analysis:**
- [x] **Subsonic compatibility test** — DONE; the bridge works and Velvet carries AudioMuse-AI-specific fixes (playlist-name sanitising for the `Path: ` prefix and `_instant` suffix at `src/api/subsonic.js:679`, `:1794`, `:1805`). The two follow-ups below are still open.
- [ ] **If Subsonic bridge works**: use AudioMuse-AI as the sonic intelligence engine (clustering, text search, song paths, similar-song playlists) without building any native analysis — Velvet just becomes the player + library, AudioMuse-AI adds AI on top.
- [ ] **Phase 2 option (deeper integration)**: add an Velvet admin toggle for an AudioMuse-AI REST URL; Auto-DJ calls AudioMuse-AI's similarity API for the next track in "Acoustic" mode instead of Last.fm. Real-time sonic similarity rather than batch playlist generation.

**Phase 2 — Admin UI:**
- [x] "Audio Analysis" card — DONE, lives inside BPM Workshop (`webapp/admin/index.js:7384`; start/stop/reset at `:7485`-`:7515`; per-source coverage at `:7621`; backend `src/api/bpm-analysis.js:12-14`)
  - [ ] Throttle setting — the one remaining gap; delays are hardcoded (`src/api/bpm-analysis.js:199,225,228`)

**Phase 3 — Player UI:**
- [ ] "≈ Build Similar Playlist" button in Now Playing modal
  - [ ] BPM / key in Now Playing modal when features exist
- [ ] Auto-DJ: "Acoustic" mode

### Your Stats enhancements
- [x] Extend stats history beyond the 60-period limit — DONE, limit is 260 both ends (`src/api/wrapped.js:205`, `webapp/app.js:15735`)

---

## FUTURE — Social / Multi-user

### Collaborative Queue (Jukebox)
- [ ] Extend Jukebox WS protocol to accept `queue-append` messages from any connected session
- [ ] Broadcast queue state changes to all connected clients in same session
- [ ] Show connected-user avatars/initials in Jukebox view
- [ ] Per-track "added by" attribution in queue panel

### Multi-room / Snapcast / Chromecast

**Snapcast sidecar:**
- [ ] Run snapcast as a sidecar; Velvet writes PCM to snapfifo while playing
- [ ] Control via snapcast JSON-RPC API over TCP
- [ ] Admin UI: "Multi-room" panel; player UI: room selector

**Chromecast:**
- [ ] Cast Web SDK + Cast button in Now Playing bar
- [ ] Cast receiver app URL that proxies the `/api/v1/music/` stream endpoint
- [ ] Sync play/pause/seek between Cast session and local player
