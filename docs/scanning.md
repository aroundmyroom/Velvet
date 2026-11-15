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

1. A scan task is queued for a vpath (on boot, on a timer, or triggered manually from the Admin panel). Folders of type `recordings`, `youtube` or `excluded` are never scanned on their own — full scans, scheduled scans and per-folder scans all skip them. A `recordings` or `youtube` folder that sits inside a music root is still indexed by the parent's scan (its files get the parent's vpath); an `excluded` child is skipped by that walk too.
2. Velvet forks a separate Node.js process (`src/db/scanner.mjs`) for each active scan to keep the main server responsive.
3. The scanner walks the folder tree recursively and asks the server about files in batches (`POST /api/v1/scanner/get-files-batch`).
4. When a file is **new** (not in the DB for this vpath) or **changed** (mtime differs, no hash stored, or the row was added on demand outside a scan), it is fully parsed (tags, ReplayGain, album art, cue points) and inserted.
5. When a file is **already known** (same relative path + vpath + mtime), it is not re-parsed. Only missing pieces are filled in: art (missing, or the folder cover changed/was added), cue points, duration, tech-meta (bitrate etc.) and album version.
6. After the walk, any file in the DB that was not confirmed by the current scan is removed (stale file cleanup). As a safety guard, pruning is skipped when fewer than 70% of the vpath's DB rows were confirmed.

### Safety guards

- **Mount guard** — after every successful scan Velvet writes `.velvet.md` to the vpath root. If a vpath already has rows in the DB, the file is missing and the folder is empty, the scan is aborted and no library rows are removed. A walk that finds zero files for a vpath with existing rows is also aborted.
- **Directory integrity check** — if any directory could not be fully read, finish-scan (and pruning) is blocked: the scan is aborted, no rows are removed, and rows already written by this scan stay. The abort deletes the resume checkpoint, so the next scan of that vpath is a fresh full scan (the scanner log line "Scan will resume on next start" is not accurate).
- **Short writes** — the scanner sends its parsed rows in batches (`POST /api/v1/scanner/add-files`); the server writes each batch in one short transaction inside that request. No transaction stays open between requests, so playlist saves, ratings and other writes work normally during a scan, and a stopped or aborted scan keeps the batches it already wrote.
- **Resume** — an interrupted scan (server stop, crash) leaves a checkpoint in `scan-state/<vpath>.json` next to the database directory (`save/scan-state/` by default), valid for 48 h. The next scan of that vpath reuses the scan ID and skips directories that were already completed. Admin → Database shows a **Resume Scan** button when a checkpoint exists.

### Background workers during a scan

While at least one scan is running, the scanner is the main database writer.

- Background workers (ReplayGain, BPM, genre enricher, Tag Workshop, AcoustID) are paused when a scan starts and resumed when the last scan ends.
- Admin "Start" actions for those workers return a pending response during active scans; the worker starts when the scan ends. "Stop" cancels a pending start.
- After every scan, workers that have queued work auto-start, staggered 5 s apart, unless the admin pressed Stop for that worker. Auto-start is skipped when the backlog is 500 items or more; start those from Admin. See [json_config.md](json_config.md) "Background workers (workerAutostart)".

This prevents SQLite busy-lock churn during large scans.

### Root detection and nested vpaths

A configured folder is treated as a **root** when no other configured folder root is a strict parent path.

A configured folder is treated as a **child** when another configured folder root is a strict parent path.

Practical examples:

- `/media/music` + `/media/music/TOP40` + `/media/music/12 inches` → `/media/music` is root; others are children.
- `/music/Reggae` + `/music/Rock` + `/music/World` (without `/music`) → all three are roots (independent scans).
- `/media/music` + `/home` → two independent roots.

The scanner resolves children to their **nearest** parent root and only schedules scan tasks for effective roots.

In Admin → Directories → Folder Structure, the hierarchy helper explains this:

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
When a full rescan is triggered (on boot, on the timer or via Admin → Start A Scan), only **root** vpaths are queued.  
Child vpaths are detected from the computed hierarchy and skipped.  
The parent scan walks through the child folder and stores those files under the **parent** vpath (e.g. `vpath='Music'`, `filepath='Disconet/Volume8/…'`). Child vpaths never get rows of their own; they act as filters on the parent's rows.

**`otherRoots` filter — no double indexing during the walk**  
Every scan process receives an `otherRoots` list: the root paths of all *other* vpaths that are not children of the current scan.  
When the recursive walker meets a directory that matches an `otherRoots` entry, it skips it — so the same physical files are not inserted twice. Child folders of type `excluded` are skipped too (`excludedPaths`), and their rows are pruned at finish-scan.

**What happens when you add a new nested vpath via Admin**  
Adding a vpath via the Admin panel resolves the computed parent hierarchy first. If the new folder is a child, the parent root is scanned; otherwise the new folder scans directly.  
Because the child's files are already in the DB under the parent, nothing new is inserted and "Recently Added" is not flooded.  
When a file is inserted whose hash already exists in the DB (for example a new root vpath that overlaps a folder already indexed elsewhere), `insertFile()` reuses the existing row's `ts`.

---

## "Recently Added" explained

The **Recently Added** list is ordered by `ts` — the Unix timestamp of when a file was **first inserted into the database**, not the file's creation or modification date on disk.

This means:
- Files that are genuinely new to the library (never scanned before) appear at the top.
- Files whose hash already exists in the DB inherit the original `ts` and do **not** appear in Recently Added.

If you add a brand-new vpath pointing at a folder that has never been scanned, all files in that folder get the scan time as `ts` and appear in Recently Added — because they are genuinely new to the library.

### Recently Added anti-flood rules

To stop old files from being reclassified as newly added on a rescan:

1. **Changed files keep their `ts`** — when a known file is re-indexed (mtime changed, e.g. after a tag edit), the original `ts` is carried over.
2. **mtime fallback** — if a re-indexed row has no `ts` to carry over, `insertFile()` uses the file's mtime (`modified`) instead of the scan time.
3. **Hash match** — a new row whose hash already exists in the DB reuses that row's `ts`.

---

## Scan triggers

| Trigger | How |
|---------|-----|
| Server boot | `bootScanDelay` seconds (default 3) after start, a scan runs only if **Boot Scan Enabled** is on (default off) or the last scan is older than one `scanInterval`. Only in interval mode (no daily start time set) |
| Scan interval | Automatic, every `scanInterval` hours (default 24) — set to 0 to disable all automatic scans |
| Daily start time | If `scanStartTime` (`HH:MM`) is set, the automatic scan runs once a day at that time instead of every N hours from boot |
| Admin: Start A Scan | Admin → Database → Scan Queue & Stats → **Start A Scan** |
| Admin: Add folder | Adding a new vpath automatically queues a scan for it (or for its parent root) |
| API | `POST /api/v1/admin/db/scan/all` |

---

## Scan settings (Admin → Database)

| Setting | Config key (`scanOptions`) | Default | Description |
|---------|-----------|---------|-------------|
| Scan Interval | `scanInterval` | 24 h | How often automatic rescans run (0 = disabled) |
| Daily Start Time | `scanStartTime` | empty | Optional `HH:MM`; scan once a day at that time |
| Boot Scan Delay | `bootScanDelay` | 3 s | Delay before the boot-time scan check |
| Boot Scan Enabled | `bootScanEnabled` | false | Always scan on boot (otherwise only when overdue) |
| Max Concurrent Scans | `maxConcurrentTasks` | 1 | How many vpaths scan in parallel |
| Skip Image Metadata | `skipImg` | false | Skip embedded album art extraction (faster scan on slow disks) |
| Compress Images | `compressImage` | true | Downsample album art to save disk space |

`scanOptions.pause` (default 0 ms) throttles the scanner between files to reduce disk I/O pressure; it is set in the config file only.

---

## Scan progress

Scan progress is shown in two places while a scan is running:

- **Admin panel** (Admin → Database → Scan Queue & Stats) — detailed card with progress bar, file count, scan rate, estimated time remaining, and current file path.
- **Player** — compact card per scanning vpath, visible to admin users only (vpath, bar, percentage + file count; updates every 3 seconds).

See [scan-progress.md](scan-progress.md) for full details.

---

## Scan errors

Files that fail to parse are logged to the `scan_errors` table.  
They can be reviewed in the Admin panel under **Scan Errors**.  
The same recurring error on the same file increments a counter rather than creating duplicate rows.  
Errors older than the configured retention window (default 48 hours) are pruned automatically.

See [scan-error-audit.md](scan-error-audit.md) for full details.

---

## Database

Velvet uses SQLite (`node:sqlite`) only. The database file is `save/db/velvet.sqlite`, in WAL mode for concurrent reads.

---

## Fields stored per file (`files` table)

| Column | Type | Description |
|--------|------|-------------|
| `title`, `artist`, `album` | TEXT | ID3/Vorbis tags |
| `year`, `genre` | INTEGER / TEXT | From tags. `genre` is normalised via canonicalization (see [Genre Canonicalization](#genre-canonicalization) below) |
| `track`, `disk` | INTEGER | Track number and disc number from tags |
| `filepath`, `vpath` | TEXT | Relative path within the vpath root; vpath key |
| `format` | TEXT | File extension (e.g. `flac`, `mp3`) |
| `hash` | TEXT | MD5 of the first 512 KB of the file — used as stable song ID |
| `audio_hash` | TEXT | SHA-256 of lowercased artist + album + title + rounded duration |
| `aaFile` | TEXT | Filename of the cached album art image (`''` = checked, no art found) |
| `art_source` | TEXT | How art was obtained, e.g. `embedded`, `directory`, `discogs`, `deezer`, `workshop` |
| `replaygainTrackDb` | REAL | ReplayGain track gain in dB |
| `duration` | REAL | Track length in seconds |
| `bitrate` | INTEGER | Audio bitrate in kbps — see [Audio Format Metadata](#audio-format-metadata) below |
| `sample_rate` | INTEGER | Sample rate in Hz (e.g. `44100`, `48000`, `96000`) |
| `channels` | INTEGER | Number of audio channels (1 = mono, 2 = stereo, etc.) |
| `bit_depth` | INTEGER | Bits per sample, when the format reports it |
| `cuepoints` | TEXT | JSON array of cue sheet markers (`'[]'` = checked, none found) |
| `artist_id` | TEXT | 16-char hex MD5 of `artist.toLowerCase().trim()` — stable artist ID for Subsonic API |
| `album_id` | TEXT | 16-char hex MD5 of the file's album folder (`dir|||vpath|||folder`, disc folders like `CD1` collapse into the album above). Files directly in a vpath root fall back to MD5 of `"artist|||album"` (both lowercased) |
| `ts` | INTEGER | Unix timestamp of first insertion into the DB |
| `modified` | REAL | File mtime in milliseconds at scan time |
| `sID` | TEXT | Scan run ID — used to detect stale rows after a rescan |

`artist_id` and `album_id` are computed at scan time and backfilled on startup for any records that predate their introduction.

**Multi-value artist tags are never split.** music-metadata pre-splits some
artist tags (ID3v2.3 `/` separators, multiple Vorbis `ARTIST` comments,
NUL-separated ID3v2.4 frames); when a split is detected the scanner restores
the as-written value from the container's native frame (`TPE1` / `ARTIST` /
`©ART`), joining genuinely multi-valued frames with `", "` — so `AC/DC` stays
`AC/DC` and a two-value `ARTIST` frame becomes `A, B`, exactly as tagged.

---

## Genre Canonicalization

When a song is scanned, the raw `genre` tag value is normalised before storage. The canonicalization step:

1. **Override map** — common variants and acronyms are mapped to their canonical form (e.g. `rnb` → `R&B`, `hip hop` → `Hip-Hop`, `dnb` → `Drum and Bass`, `synthpop` → `Synth-Pop`).
2. **Title-Case fallback** — any genre not in the map is Title-Cased (e.g. `indie rock` → `Indie Rock`).
3. **Underscore/whitespace normalisation** — `_` is replaced with space; consecutive spaces are collapsed.

Canonicalization applies whenever a file is parsed (new or changed files). Unchanged files are not re-parsed, so their stored genre stays as it was.

---

## Audio Format Metadata

`bitrate`, `sample_rate`, and `channels` are extracted during the scan and stored in the `files` table. They power the **audio format display** shown in the queue panel (e.g. `FLAC · 1027 kbps · 44.1 kHz · Stereo`).

### Extraction logic

On first insertion the values come from the normal [music-metadata](https://github.com/Borewit/music-metadata) parse of the file (`format.bitrate`, `format.sampleRate`, `format.numberOfChannels`, `format.bitsPerSample`).

For some lossless formats (FLAC, WAV, AIFF) that parse can return no bitrate, because it is not stored in the file headers. Those rows are filled in by the targeted re-parse below, which uses **`{ skipCovers: true, duration: true }`** so music-metadata computes the bitrate from size and duration.

### Fallback for lossless files

If `music-metadata` still returns a null bitrate after parsing with `duration: true` (e.g. very short files, unusual encoders), the scanner computes an estimate:

```
bitrate ≈ (file size in bytes × 8) / (duration in seconds × 1000)  [kbps]
```

This uses `fs.statSync()` on the file and the `duration` already present in the parsed metadata.

### When tech-meta is extracted

Tech-meta (`bitrate`, `sample_rate`, `channels`) is extracted in two situations:

1. **New file** — extracted as part of the full parse on first insertion.
2. **Existing file with null tech-meta** — if a file is already in the DB but has no bitrate, the server flags it (`_needsBitrate`) and the scanner runs a targeted re-parse of just that file (`POST /api/v1/scanner/update-tech-meta`) without re-inserting the full row.

Any normal rescan fills in missing tech-meta. Files that already have bitrate set are skipped; only files with `bitrate IS NULL` are re-parsed.

### Displayed in the UI

The format strip is shown in the **queue panel** next to the now-playing track (BPM and key are appended when known):

```
FLAC · 1 027 kbps · 44.1 kHz · Stereo
MP3 · 320 kbps · 44.1 kHz · Stereo
```

The values come from the `metadata` object returned by `POST /api/v1/db/metadata` (`bitrate` in bits per second, `sample-rate`, `channels` fields).
