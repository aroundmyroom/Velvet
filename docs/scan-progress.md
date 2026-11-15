# Live Scan Progress

## How Velvet scans your library

Understanding when Velvet reads, updates, or ignores a file helps explain what you see in the scan progress UI.

### What triggers a scan

A scan runs when:
- You click **Start A Scan** (or **Resume Scan**) in Admin → Database (manual trigger)
- The automatic schedule fires (`scanInterval` hours, or once a day at `scanStartTime`)
- The server starts and **Boot Scan Enabled** is on, or the last scan is older than one interval
- A folder is added in Admin → Directories, or a folder is marked as excluded (its parent root is rescanned)

See [scanning.md](scanning.md) for the trigger rules.

Each configured root vpath is scanned separately. Child vpaths (Albums Only, sub-folder shortcuts) are **not** scanned independently — they share the parent vpath's files.

---

### Per-file decision: what the scanner does with each file

For every audio file found on disk, the scanner checks the database and takes **one** of these paths:

| Situation | What happens |
|---|---|
| **File not in DB** | Fully parsed (tags + art + duration + bitrate), inserted as a new row. Appears in Recently Added. |
| **File in DB, date unchanged** | Tags are not re-read — the DB record is stamped with the new scan ID. Fast. Only missing pieces are filled in (art, cue points, duration, bitrate/sample rate, album version). |
| **File in DB, date changed** | File fully re-parsed; its new row replaces the old one in the same write. `ts` (first-added timestamp), ReplayGain measurements, BPM/key and user-picked art are carried over, so it does not re-appear in Recently Added. |
| **File in DB, hash is null** | Treated as stale (previous parse failed) — re-parsed and re-inserted. |
| **File added on demand** (played or opened before any scan found it; scan ID `on-demand`) | Treated as stale — fully parsed by the next scan, like a new file. |
| **File removed from disk** | After the scan completes, any DB row whose scan ID was not updated is deleted (pruned as stale). Pruning is skipped if fewer than 70% of the vpath's rows were confirmed. |

> **Key point:** the scanner uses each file's **"date/time modified"** as the change signal — not the file content or tags. This is the same date and time you see in Windows Explorer's detail column or in the output of `ls -l` on Linux. If you edit tags with an external tool, the file's "date/time modified" is updated and the file is re-parsed on the next scan. Some tools have an option to **preserve** the original date — if that option is on, Velvet will not notice the change and the scan will skip the file.

---

### Album art: when is it read?

| Source | When it is read |
|---|---|
| **Embedded art** (ID3 / Vorbis / MP4 cover tag) | On first insert or when the file is re-parsed ("date/time modified" changed). Cached to `albumArtDirectory`. |
| **Folder art** (`cover.jpg`, `folder.jpg`, etc.) | Read during parse when the file has no embedded art. On later scans the folder is re-checked if the stored cover file was replaced, changed, or (for tracks with no art yet) newly added. |
| **Art picked in Velvet** (Discogs / Deezer, cache-only for formats without embedded art) | Stored in the DB as the `aaFile` reference. Kept when the file is re-parsed and the file itself carries no embedded art. |
| **Cached art file deleted** | If the stored `aaFile` is missing from `albumArtDirectory`, art is re-extracted on the next scan. |
| **Art embedded inside Velvet** (Discogs / Deezer picker) | Written to the file on disk; the DB is updated immediately and its stored "date/time modified" is synced, so the next scan does not see it as changed. |
| **Art approved in the Album Art workshop** | Written as `cover.jpg` in the album folder; the DB rows of that album are updated immediately (`art_source = 'workshop'`). |

---

### Tags: when are they read or updated?

| Action | Effect on DB |
|---|---|
| **External tag editor** changes tags + updates "date/time modified" | Picked up on next scan (file treated as modified). |
| **External tag editor** changes tags but keeps original "date/time modified" | Not picked up — scanner sees no change. Run a manual scan after, or disable the "preserve timestamps" option in your tag editor. |
| **Velvet Tag Editor** changes tags | Written to file, DB updated immediately and its stored "date/time modified" synced (no rescan needed). |
| **Velvet Tag Workshop** (bulk fix) | Same — DB updated immediately and "date/time modified" synced to prevent a false "modified" signal on next scan. |
| **No changes** | Nothing is written. The scan only stamps a new scan ID on the existing row. |

---

### Artist index rebuild

At the end of every scan, Velvet rebuilds the **Artist Library index** (`artists_normalized` table) in a background worker thread. This:
- Groups artist name variants (e.g. `"DJ Deep"` / `" DJ Deep"` / `"01 DJ Deep"`) into a single canonical entry
- Preserves manually set data: name override, artist images, fanart, bios, genre, country, formed year, sort name, MBID

This runs automatically — you do not need to trigger it manually. Admin → Database also has a **Rebuild Artist Index** button.

---

Velvet shows real-time scan progress in two places while a scan is running:

1. **Admin Panel** — a detailed card in Admin → Database → Scan Queue & Stats
2. **Player header** — a compact single-row pill (admin users only)

Both update every 3 seconds and disappear automatically when the scan finishes. When no scan runs, the player checks `/api/v1/db/status` every 15 seconds to notice a scan that starts later.

---

## What is shown

| Field | Admin card | Player pill |
|---|---|---|
| Vpath being scanned | ✓ | ✓ |
| Progress bar | ✓ (animated, 6px) | ✓ (compact, 4px) |
| Percentage | ✓ badge | ✓ |
| Files scanned / expected | ✓ | ✓ |
| Estimated time remaining | ✓ | — (shown in admin) |
| Scan rate (files/sec) | ✓ | — |
| Files added to DB | ✓ (when > 0) | — |
| Current file path | ✓ (truncated, 60 chars) | tooltip on hover |
| First-scan shimmer | ✓ (no baseline exists) | ✓ |
| Elapsed time | ✓ | — |

---

## First scan vs. subsequent scans

- **Subsequent scans**: the vpath's current DB file count is used as a
  baseline (`expected`).  Progress is shown as a percentage fill, capped at
  99% until the scan finishes.
- **First scan** (vpath has no rows yet): `expected` is `null`.
  An indeterminate shimmer animation plays instead, and the badge says
  `first scan`.  The file counter still increments as files are processed.
  After the walk, the scanner sends the real total (`POST /api/v1/scanner/set-expected`).
- **Resumed scan**: the counter starts at the number of files already
  confirmed in the interrupted run.

---

## How it works — backend

### `src/state/scan-progress.js`
Pure in-memory module, no database.  Resets on server restart.

```
startScan(scanId, vpath, expected, resumeOffset)   called when a scan fork is created
tick(scanId, filepath)                             called per file in get-files-batch endpoint
tickInsert(scanId, count)                          called with the number of rows written by one add-files batch
setExpected(scanId, expected)                      called after a first scan's tree walk
finish(scanId)                                     called on scan completion/close/abort
getAll()                                           returns snapshot array for the API
```

Data stored per scan:
```json
{
  "scanId": "UyU04tkR",
  "vpath": "Music",
  "expected": 137412,
  "scanned": 51203,
  "added": 12,
  "currentFile": "Artist/Album/Track.flac",
  "startedAt": 1740912345000,
  "filesPerSec": 29.6
}
```

`currentFile` is the path relative to the vpath root.

### `src/db/task-queue.js`
- Before forking: `db.countFilesByVpath(vpath)` → `startScan(scanId, vpath, count or null, resumeOffset)`
- On child `close`: `finish(scanId)`

### `src/api/scanner.js`
- `POST /api/v1/scanner/get-files-batch`: `tick(scanId, filepath)` for each file in the batch
- `POST /api/v1/scanner/add-files`: `tickInsert(scanId, count)` after each batch is written
- `POST /api/v1/scanner/abort-scan`: `finish(scanId)` and deletes the resume checkpoint; no rows are removed, and batches already written stay. The next scan of that vpath starts from the beginning.
- `POST /api/v1/scanner/finish-scan`: `finish(scanId)` before pruning stale files

### `src/api/admin.js`
```
GET /api/v1/admin/db/scan/progress
```
Returns an array (one entry per active scan):
```json
[
  {
    "scanId": "UyU04tkR",
    "vpath": "Music",
    "scanned": 51203,
    "added": 12,
    "expected": 137412,
    "pct": 37,
    "currentFile": "Artist/Album/Track.flac",
    "elapsedSec": 1731,
    "filesPerSec": 29.6,
    "etaSec": 2918
  }
]
```
Returns `[]` when no scan is active.

### Rate calculation
`filesPerSec` is recalculated on a tick once at least **5 seconds** have passed since the last calculation:
```
filesPerSec = (scanned_now - scanned_at_last_calc) / seconds_since_last_calc
```
It is `null` until the first window completes.

### ETA calculation
```
etaSec = (expected - scanned) / filesPerSec
```
Only computed when `pct > 0`, `pct < 100`, and `filesPerSec > 0`.

---

## Admin Panel UI

The **Scan Queue & Stats** card (`webapp/admin/index.js`) polls the progress
endpoint every 3 s using a `setInterval` started in `mounted()` and cleared
in `beforeDestroy()`.

Each active scan renders as `.sp-card`:

```
● Music                                    37%   est. 48m 38s   29.6/s
[████████████░░░░░░░░░░░░░░░░░░░░░░░░░░]
51,203 / 137,412 files checked                       elapsed: 28m 51s
12 added to DB
› …/Ben Liebrand Series/VA - Grand 12 Inches/Track.flac
```

CSS classes: `.sp-container`, `.sp-card`, `.sp-header`, `.sp-live-dot`,
`.sp-vpath`, `.sp-pct-badge` / `.sp-firstscan-badge`, `.sp-track`,
`.sp-fill` / `.sp-fill-indeterminate`, `.sp-counts`, `.sp-elapsed`,
`.sp-current-file`, `.sp-filepath`.

---

## Player Header Widget

A compact pill appears in the `content-header` → `header-right` area of
the main player screen, visible only to admin users while a scan is running.

```
● Music  [━━━━━━░░░░░░░░░░]  37%  51,203 / 137,412
```

- Same height as the Append All / Play All buttons (`padding: 6px 12px`)
- Min-width 200px, max-width 320px
- Full current file path available as a `title` tooltip on hover
- CSS classes: `.spc-wrap`, `.spc-card`, `.spc-dot`, `.spc-vpath`,
  `.spc-track`, `.spc-fill` / `.spc-fill-ind`, `.spc-pct`, `.spc-count`
- Rendered by `_renderScanProgress()` in `webapp/app.js`, driven by
  `pollScan()`: it calls `/api/v1/db/status` and, when a scan is running
  (`locked`), also `/api/v1/admin/db/scan/progress`
