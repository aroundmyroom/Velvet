# Live Scan Progress

## How Velvet scans your library

Understanding when Velvet reads, updates, or ignores a file helps explain what you see in the scan progress UI.

### What triggers a scan

A scan runs when:
- You click **Scan** in the admin panel (manual trigger)
- The server starts and auto-scan is enabled in config
- A folder is added or changed in Admin → Directories

Each configured root vpath is scanned separately. Child vpaths (Albums Only, sub-folder shortcuts) are **not** scanned independently — they share the parent vpath's files.

---

### Per-file decision: what the scanner does with each file

For every audio file found on disk, the scanner checks the database and takes **one** of these paths:

| Situation | What happens |
|---|---|
| **File not in DB** | Fully parsed (tags + art + duration + bitrate), inserted as a new row. Appears in Recently Added. |
| **File in DB, date unchanged** | Skipped entirely — DB record is stamped with the new scan ID but no tags are re-read. Fast. |
| **File in DB, date changed** | Old DB row deleted, file fully re-parsed and re-inserted. `ts` (first-added timestamp) is preserved so it does not re-appear in Recently Added. |
| **File in DB, hash is null** | Treated as stale (previous parse failed) — re-parsed and re-inserted. |
| **File removed from disk** | After the scan completes, any DB row whose scan ID was not updated is deleted (pruned as stale). |

> **Key point:** the scanner uses each file's **"date/time modified"** as the change signal — not the file content or tags. This is the same date and time you see in Windows Explorer's detail column or in the output of `ls -l` on Linux. If you edit tags with an external tool, the file's "date/time modified" is updated and the file is re-parsed on the next scan. Some tools have an option to **preserve** the original date — if that option is on, Velvet will not notice the change and the scan will skip the file.

---

### Album art: when is it read?

| Source | When it is read |
|---|---|
| **Embedded art** (ID3 / Vorbis / MP4 cover tag) | On first insert or when the file is re-parsed ("date/time modified" changed). Cached to `albumArtDirectory` as a JPEG. |
| **Folder art** (`cover.jpg`, `folder.jpg`, etc.) | Same — read during parse, cached alongside embedded art. |
| **Discogs art** (assigned in Velvet) | Stored in the DB as a separate `aaFile` reference. Preserved across rescans even when the file is re-parsed — it is never overwritten by a scan. |
| **Art added externally after initial scan** | Not picked up automatically. Trigger a rescan, or — if the file's "date/time modified" did not change — use Admin → Tag Workshop → "Re-read art" to force re-extraction without a full rescan. |
| **Art changed inside Velvet** (Tag Editor) | Written to the file on disk, "date/time modified" updated automatically, picked up on next scan. |

---

### Tags: when are they read or updated?

| Action | Effect on DB |
|---|---|
| **External tag editor** changes tags + updates "date/time modified" | Picked up on next scan (file treated as modified). |
| **External tag editor** changes tags but keeps original "date/time modified" | Not picked up — scanner sees no change. Run a manual scan after, or disable the "preserve timestamps" option in your tag editor. |
| **Velvet Tag Editor** changes tags | Written to file, "date/time modified" updated automatically, DB updated immediately (no rescan needed). |
| **Velvet Tag Workshop** (bulk fix) | Same — DB updated immediately and "date/time modified" synced to prevent a false "modified" signal on next scan. |
| **No changes** | Nothing is written. The scan only stamps a new scan ID on the existing row. |

---

### Artist index rebuild

At the end of every scan, Velvet rebuilds the **Artist Library index** (`artists_normalized` table) in a background worker thread. This:
- Groups artist name variants (e.g. `"DJ Deep"` / `" DJ Deep"` / `"01 DJ Deep"`) into a single canonical entry
- Preserves all manually set data: artist images, fanart, bios, genre, country, MBID
- Triggers the artist image hydration queue for any newly discovered artists

This runs automatically — you do not need to trigger it manually.

---

Velvet shows real-time scan progress in two places while a scan is running:

1. **Admin Panel** — a detailed card in the Scan Queue & Stats section
2. **Player header** — a compact single-row pill (admin users only)

Both update every 3 seconds and disappear automatically when the scan finishes.

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
| Current file path | ✓ (truncated, 60 chars) | tooltip on hover |
| First-scan shimmer | ✓ (no baseline exists) | ✓ |
| Elapsed time | ✓ | — |

---

## First scan vs. subsequent scans

- **Subsequent scans**: the file count from the previous scan is used as a
  baseline (`expected`).  Progress is shown as a percentage fill.
- **First scan** (empty DB / vpath never scanned before): `expected` is `null`.
  An indeterminate shimmer animation plays instead, and the badge says
  `first scan`.  The file counter still increments as files are processed.

---

## How it works — backend

### `src/state/scan-progress.js`
Pure in-memory module, no database.  Resets on server restart.

```
startScan(scanId, vpath, expected)   called when a scan fork is created
tick(scanId, filepath)               called per file in get-file endpoint
finish(scanId)                       called on scan completion/close
getAll()                             returns snapshot array for the API
```

Data stored per scan:
```json
{
  "scanId": "UyU04tkR",
  "vpath": "Music",
  "expected": 137412,
  "scanned": 51203,
  "currentFile": "/media/music/Artist/Album/Track.flac",
  "startedAt": 1740912345000,
  "filesPerSec": 29.6
}
```

### `src/db/task-queue.js`
- Before forking: `db.countFilesByVpath(vpath)` → `startScan(id, vpath, count)`
- On child `close`: `finish(scanId)`

### `src/api/scanner.js`
- `POST /api/v1/scanner/get-file`: `tick(scanId, filepath)` at the top of the handler
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
    "expected": 137412,
    "pct": 37,
    "currentFile": "/media/music/Artist/Album/Track.flac",
    "elapsedSec": 1731,
    "filesPerSec": 29.6,
    "etaSec": 2918
  }
]
```
Returns `[]` when no scan is active.

### Rate calculation
`filesPerSec` is recalculated every **5 seconds** using a sliding window:
```
filesPerSec = (scanned_now - scanned_5s_ago) / 5
```

### ETA calculation
```
etaSec = (expected - scanned) / filesPerSec
```
Only computed when `pct > 0`, `pct < 100`, and `filesPerSec > 0`.

---

## Admin Panel UI

The **Scan Queue & Stats** card (`webapp/admin-v2/`) polls the progress
endpoint every 3 s using a `setInterval` started in `mounted()` and cleared
in `beforeDestroy()`.

Each active scan renders as `.sp-card`:

```
● Music                                    37%   est. 48m 38s   29.6/s
[████████████░░░░░░░░░░░░░░░░░░░░░░░░░░]
51,203 / ~137,412 files                              elapsed: 28m 51s
↳ …/Ben Liebrand Series/VA - Grand 12 Inches/Track.flac
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
● Music  [━━━━━━░░░░░░░░░░]  37%  51,203 / ~137,412
```

- Same height as the Append All / Play All buttons (`padding: 6px 12px`)
- Min-width 200px, max-width 320px
- Full current file path available as a `title` tooltip on hover
- CSS classes: `.spc-wrap`, `.spc-card`, `.spc-dot`, `.spc-vpath`,
  `.spc-track`, `.spc-fill` / `.spc-fill-ind`, `.spc-pct`, `.spc-count`
- Rendered by `_renderScanProgress()` in `webapp/v2/app.js`, driven by the
  existing `pollScan()` function which now queries the progress endpoint
  instead of just `/api/v1/db/status`

---

## Compatibility

`countFilesByVpath(vpath)` is implemented in both `src/db/sqlite-backend.js`
and `src/db/loki-backend.js` and delegated through `src/db/manager.js`.
The feature works identically on both database backends.
