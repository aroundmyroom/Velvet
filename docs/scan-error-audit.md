# Scan Error Audit

Velvet records every file that fails during a library scan into a persistent **scan error log** visible in the Admin Panel. Errors are deduplicated by file + error type so a recurring problem shows a count instead of flooding the log with identical rows.

---

## How it works

When the scanner child process encounters a problem with a file it calls the `POST /api/v1/scanner/report-error` endpoint, which:

1. Computes a **GUID** = `md5(relativeFilePath + '|' + errorType)`.
2. If a row with that GUID already exists → increments `count`, updates `last_seen`.
3. If not → inserts a new row with `count = 1`.

This means **the same file scanned 3 times with the same error appears once in the log with `3× detected`** rather than 3 separate rows.

At the **start of every scan run** the scanner calls `POST /api/v1/scanner/prune-errors`, which deletes all rows whose `last_seen` timestamp is older than the configured retention window.

---

## Error types

| Badge | Meaning |
|---|---|
| **Parse Error** | `music-metadata` failed to read tags / format info from the audio file |
| **Album Art** | Could not extract embedded cover art, read a directory image, or compress it |
| **CUE Sheet** | Failed to parse an embedded or sidecar `.cue` file |
| **DB Insert** | The file could not be inserted / updated in the database |
| **Other** | Any other uncategorised error |

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

**Sidebar → Scan Errors** (under the Server section). A red badge on the menu item shows the current error count at page load.

### Controls
- **Refresh** — reload the error list from the server.
- **Clear All** — delete the entire error history (confirmation required). Errors will reappear on the next scan if the underlying problems persist.
- **Keep errors for** dropdown — set retention window (saved immediately).

### Type filter chips
Click any chip (Parse Error / Album Art / CUE Sheet / DB Insert) to filter the table to just that category. Click the same chip again or "All" to clear the filter.

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
| `GET` | `/api/v1/admin/db/scan-errors` | Return all errors, sorted newest-first |
| `GET` | `/api/v1/admin/db/scan-errors/count` | Return `{count: N}` |
| `DELETE` | `/api/v1/admin/db/scan-errors` | Clear all errors |
| `POST` | `/api/v1/admin/db/params/scan-error-retention` | Set retention: `{hours: 12\|24\|48\|72\|168\|336\|720}` |

Scanner-internal endpoints (require scanner token):

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/scanner/report-error` | Insert or increment an error entry |
| `POST` | `/api/v1/scanner/prune-errors` | Prune entries older than retention window |

---

## Error row schema

```json
{
  "guid":        "md5(filepath|errorType)",
  "filepath":    "relative/path/to/file.flac",
  "vpath":       "Music",
  "error_type":  "parse | art | cue | insert | other",
  "error_msg":   "Error message text (max 500 chars)",
  "stack":       "Full stack trace (max 2000 chars)",
  "first_seen":  1740000000,
  "last_seen":   1740003600,
  "count":       3
}
```

---

## Existing log files

The scan error audit works **alongside** the existing Winston log files — it does not replace them. File system logs live in `save/logs/` and can be downloaded from **Admin → Logs**. The audit DB gives you a structured, queryable, deduplicated view of scan failures without having to parse raw log files.
