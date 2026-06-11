# Library Scanning

Velvet scans your music folders to build the database that powers search, browsing, Recently Added, and all playback features.

---

## Virtual Paths (vpaths)

Every music folder in Velvet is identified by a short **vpath key** (e.g. `Music`, `Blues`, `Audiobooks`).  
This key is used in every API call, in streaming URLs, and in the per-user access control list.

```json
"folders": {
  "Music":      { "root": "/media/music" },
  "Audiobooks": { "root": "/media/audiobooks" }
}
```

A user's `vpaths` array lists which keys they can access.

---

## How scanning works

### Scan process overview

1. A scan task is queued for a vpath (either on boot, on a timer, or triggered manually from the Admin panel).
2. Velvet forks a separate Node.js process (`src/db/scanner.mjs`) for each active scan to keep the main server responsive.
3. The scanner walks the folder tree recursively, calling back into the server API for each file it finds.
4. When a file is **new** (not in the DB for this vpath), it is fully parsed (tags, ReplayGain, album art) and inserted.
5. When a file is **already known** (same relative path + vpath + mtime), it is skipped.  Only missing art or missing cue-points are filled in.
6. After the walk, any file in the DB that was not touched by the current scan is removed (stale file cleanup).

### Scanner-priority write lock

While at least one scan is running, Velvet treats the scanner as the exclusive database writer.

- Background analysis workers that write to the DB (AcoustID, ReplayGain, BPM, Tag Workshop) are deferred until scan completion.
- Admin "Start" actions for those workers return a queued/pending response during active scans, then auto-start when the scan lock releases.
- If a queued start is no longer wanted, the corresponding "Stop" action cancels the pending start.

This prevents write contention patterns such as SQLite busy-lock churn and nested transaction state drift during large scans.

### Root detection and nested vpaths

A configured folder is treated as a **root** when no other configured folder root is a strict parent path.

A configured folder is treated as a **child** when another configured folder root is a strict parent path.

Practical examples:

- `/media/music` + `/media/music/TOP40` + `/media/music/12 inches` → `/media/music` is root; others are children.
- `/music/Reggae` + `/music/Rock` + `/music/World` (without `/music`) → all three are roots (independent scans).
- `/media/music` + `/home` → two independent roots.

The scanner resolves children to their **nearest** parent root and only schedules scan tasks for effective roots.

In Admin -> Directories -> Folder Structure, the hierarchy helper now explains this explicitly:

- ROOT: folders under that root are shown in the file explorer.
- Child: child folders act as shortcuts for file explorer access and as filters for features such as Auto-DJ, Albums Only, and search.
- Exclude: a folder can be excluded from indexing under a root; if it is still covered through a higher-level parent in the hierarchy, it remains accessible there.

### Nested vpaths — no duplicate scanning

If you have a vpath whose root folder sits **inside** another vpath's root, the child is a **nested vpath**.

Example:
```
Music      → /media/music          (parent)
DisconetV8 → /media/music/Disconet/Volume8   (child — nested inside Music)
```

The scanner handles this correctly in two ways:

**`scanAll()` — automatic de-duplication**  
When a full rescan is triggered (on boot or via Admin → Scan All), only the **parent** vpath is queued.  
Child vpaths are detected from computed hierarchy and skipped.  
The parent scan walks through the child folder anyway and registers those files under the child's vpath automatically via `otherRoots` filtering.

**`otherRoots` filter — per-file deduplication during walk**  
Every scan process receives an `otherRoots` list: the root paths of all *other* vpaths that are not children of the current scan.  
When the recursive walker encounters a directory that matches an `otherRoots` entry, it skips into it — preventing the same physical files from being inserted twice.

**What happens when you add a new nested vpath via Admin**  
Adding a vpath via the Admin panel now resolves the computed parent hierarchy first. If the new folder is a child, the parent root is scanned; otherwise the new folder scans directly.  
Files that physically exist inside the parent vpath are already in the DB with their original insertion timestamp, so:
- The new vpath's rows inherit the existing `ts` (insertion timestamp) from the parent — they will **not** flood "Recently Added".
- This ts-inheritance happens automatically in `insertFile()` in both the SQLite and LokiDB backends.

---

## "Recently Added" explained

The **Recently Added** list is ordered by `ts` — the Unix timestamp of when a file was **first inserted into the database**, not the file's creation or modification date on disk.

This means:
- Files that are genuinely new to the library (never scanned before) appear at the top.
- Files added via a new vpath that points at folders already covered by an existing vpath inherit the original `ts` and do **not** appear in Recently Added.

If you add a brand-new vpath pointing at a folder that has never been scanned, all files in that folder will get today's `ts` and will appear in Recently Added — because they are genuinely new to the library.

### Recently Added anti-flood safeguards

To prevent old libraries from being reclassified as newly added during edge-case rescans, Velvet applies two safeguards:

1. **Scanner insert rule** — for files treated as new rows, `ts` defaults to the file's mtime (`modified`) instead of scan wall-clock time.
2. **Finish-scan verifier** — after each scan, the server checks for suspicious rows where `ts` is in the current scan window but `modified` is clearly older. Those rows are automatically clamped back to mtime and logged.

This keeps Recently Added stable even if a path-identity drift or scanner regression causes an existing subtree to be reinserted.

---

## Scan triggers

| Trigger | How |
|---------|-----|
| Server boot | Automatic, after the `bootScanDelay` (default 3 seconds) |
| Scan interval | Automatic, every `scanInterval` hours (default 24) — set to 0 to disable |
| Admin: Scan All | Admin panel → DB → Scan All button |
| Admin: Add folder | Adding a new vpath automatically queues a scan for it |
| API | `POST /api/v1/admin/db/scan/all` |

---

## Scan settings (Admin → DB)

| Setting | Default | Description |
|---------|---------|-------------|
| Scan interval | 24 h | How often automatic rescans run (0 = disabled) |
| Boot scan delay | 3 s | Delay before the first scan after server start |
| Max concurrent scans | 1 | How many vpaths scan in parallel |
| Skip images | false | Skip album art extraction (faster scan on slow disks) |
| Compress images | true | Downsample album art to save disk space |
| Pause between files | 0 ms | Throttle the scanner to reduce disk I/O pressure |

---

## Scan progress

Scan progress is shown in two places while a scan is running:

- **Admin panel** (Admin → Scan Queue & Stats) — detailed card with progress bar, file count, scan rate, estimated time remaining, and current file path.
- **Player header** — compact pill visible to admin users only (percentage + file count, updates every 3 seconds).

See [scan-progress.md](scan-progress.md) for full details.

---

## Scan errors

Files that fail to parse are logged to the `scan_errors` table.  
They can be reviewed in the Admin panel under **Scan Errors**.  
The same recurring error on the same file increments a counter rather than creating duplicate rows.  
Errors older than the configured retention window (default 48 hours) are pruned automatically.

See [scan-error-audit.md](scan-error-audit.md) for full details.

---

## Database engines

Velvet supports two database backends:

| Engine | File | Notes |
|--------|------|-------|
| `sqlite` | `save/db/velvet.sqlite` | **Recommended.** Fast, persistent, WAL mode for concurrent reads |
| `loki` | `save/db/files.loki-v3.db` | In-memory LokiJS, saved periodically — legacy option |

---

## Fields stored per file (`files` table)

| Column | Type | Description |
|--------|------|-------------|
| `title`, `artist`, `album` | TEXT | ID3/Vorbis tags |
| `year`, `genre` | INTEGER / TEXT | From tags. `genre` is normalised via canonicalization (see [Genre Canonicalization](#genre-canonicalization) below) |
| `track`, `disk` | INTEGER | Track number and disc number from tags |
| `filepath`, `vpath` | TEXT | Relative path within the vpath root; vpath key |
| `format` | TEXT | File extension (e.g. `flac`, `mp3`) |
| `hash` | TEXT | MD5 of file contents — used as stable song ID |
| `aaFile` | TEXT | Filename of the cached album art image |
| `art_source` | TEXT | How art was obtained: `embedded`, `directory`, `discogs` |
| `replaygainTrackDb` | REAL | ReplayGain track gain in dB |
| `duration` | REAL | Track length in seconds |
| `bitrate` | INTEGER | Audio bitrate in kbps — see [Audio Format Metadata](#audio-format-metadata) below |
| `sample_rate` | INTEGER | Sample rate in Hz (e.g. `44100`, `48000`, `96000`) |
| `channels` | INTEGER | Number of audio channels (1 = mono, 2 = stereo, etc.) |
| `cuepoints` | TEXT | JSON array of embedded cue sheet markers |
| `artist_id` | TEXT | 16-char hex MD5 of `artist.toLowerCase().trim()` — stable artist ID for Subsonic API |
| `album_id` | TEXT | 16-char hex MD5 of `"artist|||album"` (both lowercased) — stable album ID for Subsonic API |
| `ts` | INTEGER | Unix timestamp of first insertion into the DB |
| `modified` | REAL | File mtime in milliseconds at scan time |
| `sID` | TEXT | Scan run ID — used to detect stale rows after a rescan |

`artist_id` and `album_id` are computed at scan time and backfilled on startup for any records that predate their introduction.

The engine can be changed in Admin → DB.  A rescan is required after switching engines.

---

## Genre Canonicalization

When a song is scanned, the raw `genre` tag value is normalised before storage. The canonicalization step:

1. **Override map** — common variants and acronyms are mapped to their canonical form (e.g. `rnb` → `R&B`, `hip hop` → `Hip-Hop`, `dnb` → `Drum and Bass`, `synthpop` → `Synth-Pop`).
2. **Title-Case fallback** — any genre not in the map is Title-Cased (e.g. `indie rock` → `Indie Rock`).
3. **Underscore/whitespace normalisation** — `_` is replaced with space; consecutive spaces are collapsed.

Canonicalization applies on every scan and rescan. Existing DB rows are updated when a file is rescanned.

---

## Audio Format Metadata

`bitrate`, `sample_rate`, and `channels` are extracted during the scan and stored in the `files` table. They power the **audio format display** shown in the queue panel (e.g. `FLAC · 1027 kbps · 44.1 kHz · Stereo`).

### Extraction logic

The scanner uses [music-metadata](https://github.com/Borewit/music-metadata) with **`{ skipCovers: true, duration: true }`** to parse each file.

- **`duration: true`** is required to obtain accurate bitrates for lossless formats (FLAC, WAV, AIFF). Without it, music-metadata returns `null` for bitrate on these formats because the bitrate is not stored in their file headers — it must be computed from file size and duration.
- For MP3, AAC, Opus, and other lossy formats the bitrate is stored in the stream headers and is returned even without `duration: true`.

### Fallback for lossless files

If `music-metadata` still returns a null bitrate after parsing with `duration: true` (e.g. very short files, unusual encoders), the scanner computes an estimate:

```
bitrate ≈ (file size in bytes × 8) / (duration in seconds × 1000)  [kbps]
```

This uses `fs.statSync()` on the file and the `duration` already present in the parsed metadata.

### When tech-meta is extracted

Tech-meta (`bitrate`, `sample_rate`, `channels`) is extracted in two situations:

1. **New file** — extracted as part of the full parse on first insertion.
2. **Existing file with null tech-meta** — if a file is already in the DB but has no bitrate (e.g. inserted before this feature was added, v6.11.0-velvet), the scanner detects the missing columns (`_needsBitrate` flag) and runs a targeted re-parse of just that file without re-inserting the full row.

To populate tech-meta for all existing files, trigger a full rescan from Admin → Scan All. Files that already have bitrate set are skipped; only files with `bitrate IS NULL` are re-parsed.

### Displayed in the UI

The format strip is shown in the **queue panel** next to the now-playing track:

```
FLAC · 1 027 kbps · 44.1 kHz · Stereo
MP3 · 320 kbps · 44.1 kHz · Stereo
```

The values come from the `metadata` object returned by `GET /api/v1/db/metadata` (`bitrate`, `sample-rate`, `channels` fields).
