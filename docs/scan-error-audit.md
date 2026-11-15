# Scan Error Audit

Velvet records every file that fails during a library scan into a persistent **scan error log** visible in the Admin Panel. Errors are deduplicated by file + error type so a recurring problem shows a count instead of flooding the log with identical rows.

---

## How it works

When the scanner child process encounters a problem with a file it calls the `POST /api/v1/scanner/report-error` endpoint, which:

1. Uses a **GUID** = `md5(relativeFilePath + '|' + errorType)` (computed by the scanner).
2. If a row with that GUID already exists → increments `count`, updates `last_seen`, refreshes the message/stack and clears any earlier "fixed" mark.
3. If not → inserts a new row with `count = 1`.

This means **the same file scanned 3 times with the same error appears once in the log with `3× detected`** rather than 3 separate rows.

At the **start of every scan run** the scanner calls `POST /api/v1/scanner/prune-errors`, which deletes all rows whose `last_seen` timestamp is older than the configured retention window, and rows marked fixed more than 48 h ago.

At the **end of every successful scan** (finish-scan), errors for that vpath that were not seen again during the scan are deleted — the problem is gone.

After a file parses cleanly, the scanner calls `POST /api/v1/scanner/confirm-ok`; errors for that file that were already marked fixed get a `confirmed_at` timestamp.

---

## Error types

| `error_type` | Badge | Meaning |
|---|---|---|
| `parse` | **Parse Error** | `music-metadata` failed to read tags / format info, or the file hash failed |
| `art` | **Album Art** | Could not extract embedded cover art, read a directory image, or compress it |
| `cue` | **CUE Sheet** | Failed to parse an embedded or sidecar `.cue` file |
| `insert` | **DB Insert** | The file could not be inserted / updated in the database |
| `duration` | `duration` | Duration could not be read in the gap-fill pass |
| `bitrate` | `bitrate` | Tech-meta (bitrate etc.) could not be read in the gap-fill pass |
| other | **Other** | Any other uncategorised error |

The UI has labels for `parse`, `art`, `cue`, `insert` and `other`; `duration` and `bitrate` show their raw type name.

---

## Configuration — retention period

Go to **Admin → Scan Errors** and use the **"Keep errors for"** dropdown:

| Option | Description |
|---|---|
| 12 hours | Short window — use when you scan very frequently |
| 1 day | Good default for once-a-day scans |
| **2 days** *(default)* | Survives a missed scan cycle |
| 3 days | — |
| 1 week | Permanent-ish; useful for debugging intermittent issues |
| 2 weeks | — |
| 30 days | Long-term audit |

The setting is saved to `save/conf/default.json` under `scanOptions.scanErrorRetentionHours` and takes effect immediately on the next scan.

---

## Admin Panel UI

**Sidebar → Scan Errors** (under the Config section). A badge on the menu item shows the number of actionable errors (not fixed, and the file is still in the library) at page load.

### Controls
- **Refresh** — reload the error list from the server.
- **Clear All** — delete the entire error history (confirmation required). Errors will reappear on the next scan if the underlying problems persist.
- **Keep errors for** dropdown — set retention window (saved immediately).

### Type filter chips
Click any chip (one per error type present in the list) to filter the table to just that category. Click the same chip again or "All" to clear the filter.

### Fix this error
Each expanded row has a **Fix this error** button (`POST /api/v1/admin/db/scan-errors/fix`):

| Type | Action |
|---|---|
| `art` | Strips embedded images with ffmpeg, then rescan |
| `parse`, `duration` | Rewrites the file with ffmpeg, then rescan. The audio stream is copied (remuxed) without re-encoding. A FLAC file is re-encoded (lossless) instead when the error was reported by the player, or when the stream copy fails. Other formats are never re-encoded: a failed stream copy marks them **Unrecoverable**. Files with no valid audio stream are marked **Unrecoverable** — delete them. Unsupported formats are just dismissed |
| `cue` | Marks the error as dismissed |
| others | Marks the error as dismissed |

Fixed rows show a badge and are removed automatically 48 h after the fix. Rows whose file is no longer in the library are shown as "Gone from library".

### Error table columns
| Column | Description |
|---|---|
| **Type** | Colour-coded badge for the error category |
| **File** | Library path tag + shortened file path. Click the path to copy the full path to the clipboard |
| **Issue** | First 500 characters of the error message |
| **Detections** | How many times this error has been seen (`Nx detected` badge if > 1) |
| **First Seen** | When the error was first recorded (relative + absolute on hover) |
| **Last Seen** | When the error was most recently seen |

### Expanded row
Click any row to expand it and see:
- Full file path (click to copy)
- Full error message
- Stack trace (scrollable, monospace)
- Metadata chips: library path, first/last detected with absolute timestamps, total count

---

## API reference

All scan-error admin endpoints require an admin JWT token (`x-access-token` header).

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/admin/db/scan-errors?limit=N` | Return `{ errors: [...], total }` — fixed rows first, then by `last_seen` newest-first. `limit` defaults to 500, max 5000 |
| `GET` | `/api/v1/admin/db/scan-errors/count` | Return `{count: N}` — actionable errors only |
| `DELETE` | `/api/v1/admin/db/scan-errors` | Clear all errors |
| `POST` | `/api/v1/admin/db/scan-errors/fix` | Body `{guid}` — try to fix one error (see above); returns `{ ok, action }` |
| `POST` | `/api/v1/admin/db/params/scan-error-retention` | Set retention: `{hours: 12\|24\|48\|72\|168\|336\|720}` |

Scanner-internal endpoints (require scanner token):

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/scanner/report-error` | Insert or increment an error entry |
| `POST` | `/api/v1/scanner/confirm-ok` | Mark fixed errors for a file as confirmed after a clean parse |
| `POST` | `/api/v1/scanner/prune-errors` | Prune entries older than retention window |

---

## Error row schema

```json
{
  "guid":        "md5(filepath|errorType)",
  "filepath":    "relative/path/to/file.flac",
  "vpath":       "Music",
  "error_type":  "parse | art | cue | insert | duration | bitrate",
  "error_msg":   "Error message text (max 500 chars)",
  "stack":       "Full stack trace (max 2000 chars)",
  "first_seen":  1740000000,
  "last_seen":   1740003600,
  "count":       3,
  "fixed_at":    null,
  "fix_action":  null,
  "confirmed_at": null,
  "file_in_db":  1
}
```

`file_in_db` is computed in the list response (1 when the file still has a row in `files`).

---

## Existing log files

The scan error audit works **alongside** the existing Winston log files — it does not replace them. File system logs live in `save/logs/` and can be downloaded from **Admin → Logs**. The audit DB gives you a structured, queryable, deduplicated view of scan failures without having to parse raw log files.
