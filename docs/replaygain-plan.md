# ReplayGain — Design Plan for Velvet

## Executive Summary

Velvet currently stores only `replaygainTrackDb` — a single dB value
read from whatever REPLAYGAIN_TRACK_GAIN tag happens to exist in the file (if
any). There is no peak measurement, no album gain, no EBU R128 measurement, no
clipping prevention, no pre-amplification, and **no way to generate RG data for
files that lack tags entirely**.

This document describes a best-in-class, standards-based ReplayGain 2.0
implementation using ITU-R BS.1770-4 / EBU R128 measurements.

**Primary tool: `rsgain`** (uses `libebur128` — the canonical C reference
library). Auto-bootstrapped from GitHub releases; user can disable it in
configuration and Velvet falls back transparently to ffmpeg's own
`ebur128` filter. Playback uses a lossless true-peak limiter on both the
Web Audio path and the server-side transcode path.

---

## Why "dumb average loudness" is wrong — and what EBU R128 fixes

Classic implementations divide the audio into small blocks, compute RMS power
per block, then average. This treats a symphony orchestra and a brick-walled
pop track identically — the orchestra has huge dynamic swings that average to
the same RMS as a compressed track that is audibly **much** louder at the
listening seat.

**EBU R128 / ITU-R BS.1770** adds two innovations:

1. **K-weighting filter** — pre-emphasis that models human ear sensitivity
   (boosted high frequencies, rolled off low), so bass-heavy tracks don't get
   measured as quieter than they really are.

2. **Gating** — 400 ms measurement blocks are discarded if their level is more
   than 10 LU below the average of ungated blocks (relative gate) or below -70
   LUFS (absolute gate). Silence, audience noise and reverb tails do not
   inflate or deflate the result. A track with 30 seconds of quiet intro and
   3 minutes of loud music gets measured for its loud music, not the average of
   both.

The result: the measured **Integrated Loudness** (LUFS) correlates much more
closely to perceived equal-loudness than any RMS-only scheme.

**True peak** extends this: after decoding, inter-sample peaks (peaks that
exist in the continuous analogue signal but fall between digital samples) can
exceed 0 dBFS. ffmpeg's `ebur128=peak=true` and the `loudnorm` filter both
internally upsample to 192 kHz to detect these. A track stored at -0.1 dBFS
may have true peaks at +0.5 dBTP after decoding — storing only the sample peak
leads to clipping after gain application.

---

## Current State

| Field | Source | Status |
|---|---|---|
| `replaygainTrackDb` | File tag scan (music-metadata) | Only populated if tag exists in file |
| Album gain | — | **Not stored** |
| Track peak (sample) | — | **Not stored** |
| True peak (inter-sample) | — | **Not stored** |
| Integrated LUFS (measured) | — | **Not stored** |
| Loudness Range (LRA) | — | **Not stored** |
| Pre-amplification | — | **Not in player** |
| Clipping prevention | — | **Not in player** |
| Opus R128_TRACK_GAIN | — | **Not handled** |
| Server-side analysis worker | — | **Does not exist** |

**Player (app.js)**: applies `10^(gain/20)` via Web Audio `GainNode`. No
clipping prevention. No pre-amp. No album mode. Falls back to gain=1.0 if no
tag present.

**Transcode path**: no volume/loudness filter applied during streaming
transcode.

---

## Target Architecture

### Measurement standard: EBU R128 / RG 2.0

- Reference level: **−18 LUFS** (ReplayGain 2.0 spec; backwards-compatible
  with classic RG which calibrated to an equivalent −14 dB pink noise)
- Gain formula: `RG = −18 − I_measured` where I is the gated integrated
  loudness in LUFS
- True peak: measured via 192 kHz upsampled inter-sample peak detection
- Loudness range (LRA): stored as informational metadata; high LRA ≥ 15 LU
  signals a dynamic recording that may need special pre-amp treatment

### Measurement toolchain: rsgain (primary) + ffmpeg (fallback)

Two tools can perform EBU R128 / BS.1770-4 measurement. Velvet tries
them in priority order:

| | rsgain | ffmpeg `ebur128` |
|---|---|---|
| Underlying library | **libebur128** (reference C impl) | Own BS.1770 re-implementation |
| True peak method | Dedicated polyphase FIR interpolator (4× oversample <96 kHz) | General-purpose libswresample resampling |
| Integrated loudness accuracy | Reference spec | Typically < 0.1 LU difference |
| Machine-readable output | Tab-delimited stdout | Parsed from human-readable stderr |
| Multi-file album scan | Single invocation | One invocation per file |
| Available as static binary | Linux x64, Windows x64, macOS | Always (bundled with Velvet) |
| Tag write-back (future) | Native, all formats | Complex stderr/stream-copy dance |

**rsgain is preferred** because libebur128 is the specification reference and
its true peak interpolator is more accurate. ffmpeg is always available as a
transparent fallback — the stored values are compatible (same columns, same
units, same reference level).

#### rsgain Bootstrap

A new module `src/util/rsgain-bootstrap.js` — mirrors the ffmpeg-bootstrap
pattern:

- Binary stored in `bin/rsgain/rsgain[.exe]`
- On startup: check binary exists and `rsgain --version` returns a major
  version ≥ MIN_RSGAIN_MAJOR (3); download if not.
- **Version strategy**: the bootstrap checks the GitHub releases API
  (`https://api.github.com/repos/complexlogic/rsgain/releases/latest`) to
  discover the current release tag, then constructs the asset URL dynamically.
  This mirrors the BtbN daily-check pattern so the binary auto-updates.
  Version is re-checked once per day (same `_updateTimer` pattern as ffmpeg-bootstrap.js`).

  Exact URL construction:
  1. Fetch `https://api.github.com/repos/complexlogic/rsgain/releases/latest` → JSON
  2. Read `tag_name` (e.g. `"v3.7"`)
  3. Strip the leading `v` to get the version number: `const ver = tag_name.slice(1)` → `"3.7"`
     ⚠️ The GitHub **tag** includes the `v` prefix, but the **asset filenames do not**.
     `rsgain-v3.7-Linux.tar.xz` would be wrong — the correct filename is `rsgain-3.7-Linux.tar.xz`.
  4. Construct download URL: `https://github.com/complexlogic/rsgain/releases/download/${tag_name}/rsgain-${ver}-${platformSuffix}.${ext}`

  Minimum version constant:
  ```js
  const MIN_RSGAIN_MAJOR = 3;   // must be ≥ v3.x; v3.0 introduced the Custom Mode -s flag
  ```

  Version check after download (and on every startup):
  ```js
  // rsgain --version outputs: "rsgain v3.7"
  const out = execSync(`${rsgainBin()} --version`, { encoding: 'utf8' });
  const m   = /rsgain v(\d+)\.(\d+)/.exec(out);
  const major = m ? parseInt(m[1], 10) : 0;
  if (major < MIN_RSGAIN_MAJOR) {
    // binary is too old — re-download
  }
  ```

  Daily timer (same `_updateTimer` pattern as `ffmpeg-bootstrap.js`):
  ```js
  const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;  // 24 hours
  let _updateTimer = null;
  function _scheduleCheck() {
    _updateTimer = setTimeout(async () => {
      await _checkOrDownload();
      _scheduleCheck();
    }, CHECK_INTERVAL_MS);
    _updateTimer.unref();  // don't keep the event loop alive
  }
  ```

| Platform | Asset pattern | Notes |
|---|---|---|
| Linux x64 | `rsgain-{v}-Linux.tar.xz` | Static, no system deps |
| Linux arm64 | *no static build yet* | Auto-fallback to ffmpeg |
| Windows x64 | `rsgain-{v}-win64.zip` | |
| Windows arm64 | *no static build* | Auto-fallback to ffmpeg |
| macOS arm64 | `rsgain-{v}-macOS-arm64.zip` | Not codesigned |
| macOS x86_64 | `rsgain-{v}-macOS-x86_64.zip` | Not codesigned |

**No SHA256 checksum file** is published by the rsgain project alongside
releases, so integrity verification is done by running `rsgain --version`
after extraction and confirming the major version matches the expected tag.

**macOS quarantine**: after extraction on macOS, remove the quarantine
extended attribute before use:

```js
if (process.platform === 'darwin') {
  await execa('xattr', ['-d', 'com.apple.quarantine', binPath]).catch(() => {});
}
```

**Version parsing**: `rsgain --version` outputs `rsgain v3.7` — extract with
`/rsgain v(\d+)\.(\d+)/.exec(stdout)`, then check major ≥ MIN_RSGAIN_MAJOR.

```js
// src/util/rsgain-bootstrap.js (ESM, same structure as ffmpeg-bootstrap.js)
export function rsgainBin() {
  return path.join(BUNDLED_RSGAIN_DIR, `rsgain${binaryExt}`);
}
export function rsgainAvailable() {
  return _available;   // set after successful init
}
```

#### Docker deployment

The Docker image already pre-downloads small static binaries at **build time**
(yt-dlp, fpcalc follow this pattern). rsgain follows the same convention so
the binary is baked into the image layer — no network request on container
startup.

**Dockerfile addition** (place after the fpcalc pre-download block):

```dockerfile
# Pre-download rsgain for EBU R128 measurement (Linux x64 only — no arm64 static build).
# arm64 containers fall back to ffmpeg ebur128 automatically.
RUN arch="$(uname -m)"; \
    if [ "$arch" = "x86_64" ]; then \
      tag=$(wget -qO- "https://api.github.com/repos/complexlogic/rsgain/releases/latest" \
            | grep '"tag_name"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/') && \
      mkdir -p bin/rsgain && \
      if [ -n "$tag" ] && \
         wget -q -O /tmp/rsgain.tar.xz \
           "https://github.com/complexlogic/rsgain/releases/download/v${tag}/rsgain-${tag}-Linux.tar.xz" && \
         tar -xJf /tmp/rsgain.tar.xz -C bin/rsgain --strip-components=1 rsgain-${tag}-Linux/rsgain && \
         chmod +x bin/rsgain/rsgain && \
         rm -f /tmp/rsgain.tar.xz && \
         bin/rsgain/rsgain --version; then \
        echo "rsgain pre-download OK (v${tag})"; \
      else \
        rm -rf bin/rsgain && echo "rsgain pre-download failed (ffmpeg fallback will be used)"; \
      fi; \
    else \
      echo "rsgain skipped (arch=${arch}, no static build available — ffmpeg fallback)"; \
    fi
```

Note that `xz-utils` is already installed in the base Dockerfile (`wget xz-utils`
in the first `apt-get` layer) so the `tar -xJf` extraction works without
additional packages.

**Volume layout — bin/ is NOT mounted:**

```yaml
volumes:
  - /host/save:/app/save          # config + DB — PERSISTENT
  - /host/music:/music            # library — PERSISTENT
  - /host/image-cache:/app/image-cache
  - /host/waveform-cache:/app/waveform-cache
  # bin/ is NOT listed — binary lives inside the image layer
```

The rsgain binary at `bin/rsgain/rsgain` is inside the container's writable
layer. When the image is updated (`docker pull` + `docker compose up -d`), the
new container gets the freshly pre-downloaded binary from the new image.
The runtime bootstrap (`src/util/rsgain-bootstrap.js`) will still do a daily
version-check and re-download if the pre-baked binary is below `MIN_RSGAIN_MAJOR`
— this handles the case where someone runs an old image version long-term without
rebuilding.

**arm64 Docker** (Raspberry Pi 4/5, Oracle ARM, Apple Silicon remote host):
No static Linux arm64 build exists for rsgain. The bootstrap skips the download
silently and sets `rsgainAvailable() = false`. The RG worker automatically uses
ffmpeg's `ebur128` filter instead. No configuration change needed — the fallback
is fully transparent.

#### Config control


New key in `save/conf/default.json` (optional, with defaults):

```json
"rg": {
  "tool": "auto"   // "auto" | "rsgain" | "ffmpeg"
}
```

- `"auto"` (default): use rsgain if bootstrap succeeded; otherwise ffmpeg
- `"rsgain"`: require rsgain; log error and skip measurement if unavailable
- `"ffmpeg"`: skip rsgain bootstrap entirely, always use ffmpeg

Admins can also toggle this from the Normalization Workshop UI without
editing JSON.

#### rsgain invocation (measurement only, no file writes)

```bash
rsgain custom -s n -t -q /path/to/file.flac
```

- `-s n` — tag mode `n` = skip writing tags (Custom Mode only)
- `-t` — use true peak (libebur128 polyphase FIR, 4× oversample)
- `-q` — quiet mode: suppresses progress bar and summary, but **the header
  row is still emitted** (`File\tLoudness\t...`). The parser must skip lines
  that start with `File\t`.

Stdout (tab-delimited, header + one data row per file):
```
File\tLoudness\tRange\tTrue_Peak\tReference\tWill_Clip\tPeak_Amplitude\tNew_Peak\tGain
/path/to/file.flac\t-18.30 LUFS\t8.40 LU\t-1.20 dBTP\t-18.00 LUFS\tNo\t0.867\t0.867\t+0.00 dB
```

Parse only data rows (skip lines where `cols[0] === 'File'` or starts with `#`):
- `[1]` → `rg_integrated_lufs` — strip ` LUFS`, parse float
- `[2]` → `rg_lra` — strip ` LU`, parse float
- `[3]` → `rg_true_peak_dbfs` — strip ` dBTP`, parse float

Then derive: `rg_track_gain_db = −18.0 − rg_integrated_lufs`

If rsgain exits non-zero or stdout contains no valid data row, treat as
measurement failure (same as ffmpeg fallback failure path).

#### ffmpeg fallback invocation

```bash
ffmpeg -i /path/to/file.flac -af ebur128=peak=true -f null /dev/null
```

This is a **non-destructive read-only pass**. Parse stderr:

```
    I:         -18.3 LUFS    → rg_integrated_lufs
    LRA:         8.4 LU      → rg_lra
    True peak:   -1.2 dBFS   → rg_true_peak_dbfs (max across channels)
```

Derive: `rg_track_gain_db = −18.0 − rg_integrated_lufs`

**Why not `loudnorm` for measurement?** `loudnorm` is a *processing* filter —
it changes the audio while measuring. For pure measurement, `ebur128` is
correct. `loudnorm` dual-pass gives the same integrated loudness result but
adds unnecessary audio processing overhead and outputs the audio, wasting I/O.

### Album gain

Album gain requires treating all tracks in an album as a single continuous
programme. Two options:

**Option A (recommended for the initial implementation):** Compute the
album's integrated loudness as the power-mean of individual track integrated
loudnesses, weighted by track duration:

```
I_album = 10 * log10( Σ(10^(I_i/10) * duration_i) / Σ(duration_i) )
rg_album_gain_db = −18.0 − I_album
rg_album_peak_dbfs = max(rg_true_peak_dbfs) across album tracks
```

This is the approach used by `loudgain` and is accurate for albums where all
tracks are measured individually. It avoids re-reading every track when a
single track changes.

**Option B (future, perfect accuracy):** Concatenate all tracks via ffmpeg
`concat` demuxer and measure as one stream. Exact per EBU R128 spec but
expensive and must be re-run any time the album changes.

**Album grouping key** — `mb_album_dir` first, then metadata fallback:

1. **`mb_album_dir` (preferred)**: The `mb_album_dir` column stores the
   directory portion of the filepath (e.g. `Albums/Artist/Abbey Road (1969)/`).
   This column is already populated for all MB-enriched files and backfilled
   on migration. Query: `WHERE vpath = ? AND mb_album_dir = ?`. This handles
   the edge case of two different albums sharing the same title by the same
   artist in different directories.
2. **Metadata fallback** (when `mb_album_dir IS NULL`): group by
   `(vpath, COALESCE(album_artist, artist), album)` — less precise but
   works for un-enriched files.

In both cases, `vpath` must be the **ROOT DB vpath** (e.g. `Music`), not a
child vpath name. See the albumsOnly section below.

---

## Database Schema Additions

Fourteen new columns added to `files` via migration:

```sql
-- Measured values (from worker: rsgain or ffmpeg ebur128)
ALTER TABLE files ADD COLUMN rg_integrated_lufs  REAL;    -- measured integrated loudness (LUFS), gated EBU R128
ALTER TABLE files ADD COLUMN rg_true_peak_dbfs   REAL;    -- inter-sample true peak (dBTP)
ALTER TABLE files ADD COLUMN rg_track_gain_db    REAL;    -- = −18 − rg_integrated_lufs
ALTER TABLE files ADD COLUMN rg_lra              REAL;    -- loudness range (LU), informational
ALTER TABLE files ADD COLUMN rg_album_gain_db    REAL;    -- album-level gain (dB)
ALTER TABLE files ADD COLUMN rg_album_peak_dbfs  REAL;    -- album true peak (dBTP)
ALTER TABLE files ADD COLUMN rg_measured_ts      INTEGER; -- unix epoch when measured; NULL=pending; -1=failed
ALTER TABLE files ADD COLUMN rg_measurement_tool TEXT;    -- 'rsgain' | 'ffmpeg' — which tool produced the values

-- Tag-sourced values (from scanner, zero extra CPU — read from existing file tags)
ALTER TABLE files ADD COLUMN rg_tag_track_gain   REAL;    -- REPLAYGAIN_TRACK_GAIN (dB) from file tag
ALTER TABLE files ADD COLUMN rg_tag_track_peak   REAL;    -- REPLAYGAIN_TRACK_PEAK (linear 0..1+) from file tag
ALTER TABLE files ADD COLUMN rg_tag_album_gain   REAL;    -- REPLAYGAIN_ALBUM_GAIN (dB) from file tag
ALTER TABLE files ADD COLUMN rg_tag_album_peak   REAL;    -- REPLAYGAIN_ALBUM_PEAK (linear) from file tag
ALTER TABLE files ADD COLUMN r128_track_gain_db  REAL;    -- Opus R128_TRACK_GAIN (dB, −23 LUFS reference)
ALTER TABLE files ADD COLUMN r128_album_gain_db  REAL;    -- Opus R128_ALBUM_GAIN (dB, −23 LUFS reference)
```

**`replaygainTrackDb` (existing column)** is kept as-is and continues to be
populated by the scanner from `REPLAYGAIN_TRACK_GAIN`. It acts as the legacy
fallback in `resolveTrackGain()`. The new `rg_tag_track_gain` column stores
the same value but is populated more explicitly; during the scanner migration
both are written. Eventually `replaygainTrackDb` can be deprecated.

**`rg_measurement_tool`** enables targeted re-analysis: when rsgain becomes
available after having fallen back to ffmpeg, the worker can query
`WHERE rg_measurement_tool = 'ffmpeg'` and re-measure with the better tool.

### Gain priority at playback (both player and transcode):

1. `rg_track_gain_db` — server-measured EBU R128 (most accurate, present once
   worker has run; preferred over tag values regardless of which tool produced it)
2. `rg_tag_track_gain` — REPLAYGAIN_TRACK_GAIN from the file tag (scanned on
   ingest; may come from Picard/beets/rsgain applied externally)
3. `replaygainTrackDb` — legacy alias of the above, still populated for
   backwards compatibility with existing clients
4. `r128_track_gain_db + 5.0` — Opus R128 tag converted to −18 LUFS reference
5. `null` — no adjustment

For album mode, same priority chain using `rg_album_gain_db` →
`rg_tag_album_gain` → `null`.

---

## Scanner Improvements (tag-side, zero extra CPU)

The scanner already calls `music-metadata`. Extend it to read and store all RG
tags that may already exist in the file, so externally-tagged libraries get full
data immediately without waiting for the worker:

```js
// scanner.mjs additions in buildSongInfo():
"rg_tag_track_gain":  song.replaygain_track_gain?.dB   ?? null,
"rg_tag_track_peak":  song.replaygain_track_peak        ?? null,  // linear, e.g. 0.987654
"rg_tag_album_gain":  song.replaygain_album_gain?.dB   ?? null,
"rg_tag_album_peak":  song.replaygain_album_peak        ?? null,
// Opus R128 tags (stored as Q7.8 fixed-point int in the container,
// music-metadata returns it decoded in dB already):
"r128_track_gain_db": song.r128_track_gain               ?? null,  // native -23 LUFS ref
"r128_album_gain_db": song.r128_album_gain               ?? null,
```

**Opus R128 note**: The Opus container's native `R128_TRACK_GAIN` tag uses
−23 LUFS as its reference (not −18 LUFS). When building the playback gain
value, add +5 dB to convert to RG 2.0 reference:
`gain = r128_track_gain_db + 5.0`

### Gain resolution function (server-side, used by `/api/v1/db/metadata` etc.):

```js
function resolveTrackGain(row, mode = 'track') {
  if (mode === 'album' && row.rg_album_gain_db != null)   return { gain: row.rg_album_gain_db,   peak: row.rg_album_peak_dbfs, src: 'measured_album' };
  if (mode === 'album' && row.rg_tag_album_gain != null)  return { gain: row.rg_tag_album_gain,   peak: row.rg_tag_album_peak,  src: 'tag_album' };
  if (row.rg_track_gain_db  != null)  return { gain: row.rg_track_gain_db,  peak: row.rg_true_peak_dbfs, src: 'measured' };
  if (row.r128_track_gain_db != null) return { gain: row.r128_track_gain_db + 5.0, peak: null, src: 'r128' };
  if (row.replaygainTrackDb != null)  return { gain: row.replaygainTrackDb,  peak: row.rg_tag_track_peak, src: 'tag' };
  return null;
}
```

---

## RG Analysis Worker

New file: `src/util/rg-analysis-worker.mjs`

A worker thread (same pattern as `acoustid-worker.mjs`) that:

1. Queries files with `rg_measured_ts IS NULL` OR
   `(rg_measured_ts > 0 AND rg_measurement_tool = 'ffmpeg' AND rsgainAvailable())`
   — the second condition re-measures ffmpeg-measured files when rsgain
   later becomes available.
   Batches of 50 files.
2. For each file: invokes rsgain (primary) or ffmpeg ebur128 filter (fallback) —
   see **Measurement invocation** section below.
3. Parses output to extract integrated LUFS, LRA, true peak.
4. Writes `rg_integrated_lufs`, `rg_true_peak_dbfs`, `rg_track_gain_db`,
   `rg_lra`, `rg_measured_ts` (Unix epoch), `rg_measurement_tool` ('rsgain'|'ffmpeg').
5. On measurement failure: writes `rg_measured_ts = -1`. The scanner's upsert
   resets this to NULL when a file is re-indexed (hash changed → new row;
   same file → worker can be asked to retry via admin UI).
6. After each track is written, checks if its album is now complete → if so,
   computes and writes `rg_album_gain_db` and `rg_album_peak_dbfs` for all
   tracks in that album group.
7. Reports progress via `parentPort.postMessage({ type: 'status', stats })`

### Throttling

Unlike AcoustID/MB workers (which hit external APIs at 1 req/s), the RG worker
is CPU/disk-bound. It processes as fast as the hardware allows but yields
between files to keep the event loop responsive:

```js
const YIELD_BETWEEN_FILES_MS = 50;  // configurable; 0 = max speed
```

Recommended: run at lower I/O priority (`setpriority(PRIO_PROCESS, 0, 10)` or
`ionice -c 3` wrapper) to avoid affecting streaming.

### Robustness

- **DB write retry**: same `dbWriteWithRetry` pattern (60 × 3 s = 3 min) as
  MB worker
- **Auto-start on server boot**: if `COUNT(*) WHERE rg_measured_ts IS NULL > 0`
  → start worker automatically (same 15 s deferred start as tagworkshop)
- **Tool timeout**: 120 s per file (long FLAC files on slow disk) — applies
  to both rsgain and ffmpeg invocations
- **Corrupt file handling**: non-zero exit code or unparseable output → file
  marked `rg_measured_ts = -1`. The worker skips these on subsequent passes.
  An admin "Retry failed" button in the Normalization Workshop resets all
  `-1` rows back to NULL.
  Re-indexing a file (modified → new hash) resets `rg_measured_ts` to NULL
  automatically via the scanner upsert.
- **Re-measure with better tool**: worker checks on startup: if rsgain is now
  available but previous measurements used ffmpeg, queues a re-analysis pass
  (configurable, default: on). Tracked via `rg_measurement_tool` column.

### Measurement invocation (rsgain primary, ffmpeg fallback):

```js
// Worker selects tool at startup; _measureTool is set once during init.
// Falls back automatically if rsgain is unavailable.

if (rsgainAvailable() && rgTool !== 'ffmpeg') {
  // rsgain: tab-delimited stdout, single pass, no file writes
  const args = ['custom', '-s', 'n', '-t', '-q', absolutePath];
  const proc = spawn(rsgainBin(), args, { timeout: 120_000 });
  // Parse proc.stdout — tab-delimited row, columns 1/2/3 = loudness/range/truepeak
  // e.g.: "/path/file.flac\t-18.30 LUFS\t8.40 LU\t-1.20 dBTP\t..."
} else {
  // ffmpeg fallback: parse stderr ebur128 summary block
  const args = ['-i', absolutePath, '-af', 'ebur128=peak=true', '-f', 'null', '/dev/null'];
  const proc = spawn(ffmpegBin(), args, { timeout: 120_000 });
  // Parse proc.stderr for:
  //   "    I:         -18.3 LUFS"
  //   "    LRA:         8.4 LU"
  //   "    True peak:   -1.2 dBFS"  (max of all channels)
}
```

### Album completion detection:

```sql
-- "complete" = every track in the album has been processed (success OR failed)
-- Note: rg_measured_ts = -1 (failed) is still NOT NULL, so COUNT() includes it.
SELECT COUNT(*) AS total,
       COUNT(rg_measured_ts) AS processed
FROM files
WHERE vpath = ? AND album = ? AND (album_artist = ? OR artist = ?)
```

⚠️ **Operator precedence bug (fixed):** The previous version had:
`AND rg_measured_ts IS NOT NULL OR rg_measured_ts = -1` — the bare `OR`
binds to the full WHERE, leaking rows from other albums. The correct form
above uses no extra OR at all: `COUNT(rg_measured_ts)` counts all non-NULL
rows, and since `-1 IS NOT NULL` is true in SQLite, failed tracks are
included in the count automatically.

When `total == processed`: compute power-mean album gain from tracks where
`rg_measured_ts > 0` (skip failed tracks), then write `rg_album_gain_db`
and `rg_album_peak_dbfs` to all rows in the album group.

---

### albumsOnly and child-vpath album grouping

#### Absolute path resolution

The worker passes `workerData.folders` — a flat map of **ROOT vpath name →
absolute filesystem root**. This is the same pattern as `acoustid-worker.mjs`
(line 229: `const rootDir = folders[row.vpath]`).

Files under an albumsOnly **child vpath** (e.g. a vpath named `Albums-Only`
with root `/music/Albums/`) are stored in the DB with the **parent ROOT
vpath** (e.g. `vpath = 'Music'`) and `filepath = 'Albums/Artist/Album/track.flac'`.
The child vpath name never appears in the `files` table.

```js
// CORRECT — works for both root and child-vpath files:
const rootDir      = folders[row.vpath];   // looks up ROOT vpath root
const absolutePath = path.join(rootDir, row.filepath);
// → /music/Albums/Artist/Abbey Road/Come Together.flac

// WRONG — child vpath name is NOT in `folders`:
const rootDir = folders['Albums-Only'];    // undefined → crash
```

The `folders` object passed to the worker should include **only ROOT vpaths**
(those without a `parentVpath`). Child vpaths are excluded because their
files are already accessible via the parent's `folders` entry.

#### Album grouping key in the worker

Use the two-tier key described in the Album gain section:

```js
// Step 6: after writing a track's RG values, check album completion.
// Build the grouping key from the row's data:
const albumKey = row.mb_album_dir
  ? { vpath: row.vpath, mb_album_dir: row.mb_album_dir }
  : { vpath: row.vpath, artist: row.album_artist || row.artist, album: row.album };
```

**Completion query (mb_album_dir branch):**
```sql
SELECT COUNT(*) AS total, COUNT(rg_measured_ts) AS processed
FROM files
WHERE vpath = ? AND mb_album_dir = ?
```

**Completion query (metadata fallback branch):**
```sql
SELECT COUNT(*) AS total, COUNT(rg_measured_ts) AS processed
FROM files
WHERE vpath = ? AND (album_artist = ? OR artist = ?) AND album = ?
  AND mb_album_dir IS NULL
```

#### New file added to an already-measured album

When the scanner re-indexes a folder and adds a new track to an album that
was already fully measured (`rg_album_gain_db IS NOT NULL` on all existing
tracks), the new track row has `rg_measured_ts = NULL`. This automatically
invalidates the album group — `total > processed` — so the album gain will
**not** be recalculated until the new track is also measured.

However, the existing tracks still have their old `rg_album_gain_db`.
To ensure a correct re-calculation, the worker must reset `rg_album_gain_db`
on all sibling tracks the moment it picks up the new track:

```js
// Worker step 1 / batch-fetch: for each new file (rg_measured_ts IS NULL),
// check if its album already has rg_album_gain_db populated.
// If so, clear it on all siblings immediately so album mode falls back to
// track gain until the new measurement is complete.
if (siblingsHaveAlbumGain) {
  db.prepare(`
    UPDATE files SET rg_album_gain_db = NULL, rg_album_peak_dbfs = NULL
    WHERE vpath = ? AND mb_album_dir = ?
  `).run(row.vpath, row.mb_album_dir);
}
```

This guarantees that during the window between "new track added" and "worker
finishes measuring it", the player uses per-track gain instead of a stale
album gain that doesn't account for the new track's loudness.

#### Auto-start trigger for new albumsOnly content

Same as the general auto-start: the worker queries
`COUNT(*) WHERE rg_measured_ts IS NULL > 0` on boot (15 s deferred), plus
the scanner can emit an `rg-needed` event that wakes the worker immediately
(optional Phase 2+ enhancement). No special albumsOnly handling needed — the
new track rows with `NULL` timestamps are already picked up by the standard
batch query regardless of which vpath (root or child) they logically belong to.

---

---

## Playback Path — Player (Web Audio API, `app.js`)

### What exists

- `_rgGainNode` (Web Audio `GainNode`) applies `10^(gain/20)` on track change
- Cross-fade properly ramps the RG gain node during transitions
- Toggle stored in localStorage as `ms2_rg_<user>`

### What to add

#### 1. Album gain mode

Add `S.rgMode` with values `'track'` | `'album'`. Default: `'track'`.
The metadata response already carries both gains; the player picks based on mode.

#### 2. Pre-amplification

Add `S.rgPreamp` (dB), range −12 to +12, default 0. Persisted in localStorage.
Combined scale factor:

```js
const totalGainDb  = (rg?.gain ?? 0) + S.rgPreamp;
```

Expose as a slider in the settings panel next to the RG toggle.

#### 3. Clipping prevention

After applying gain + pre-amp, check against true peak:

```js
// peakLinear: linear true peak from server (10^(rg.peak/20))
// If applying totalGainDb would push peak above -0.5 dBFS (0.944 linear),
// reduce gain to prevent it.
const maxLinear   = Math.pow(10, -0.5 / 20);     // -0.5 dBFS safety ceiling
const peakLinear  = rg?.peak != null ? Math.pow(10, rg.peak / 20) : 1.0;
const rawScale    = Math.pow(10, totalGainDb / 20);
const safeScale   = Math.min(rawScale, maxLinear / peakLinear);
_rgGainNode.gain.setTargetAtTime(safeScale, audioCtx.currentTime, 0.01);
```

This is the RG 2.0 spec "reduced gain" clipping prevention — no limiting, just
silently back off the gain for individual tracks where clipping would occur.
Audiophile-safe: zero distortion, zero pumping.

#### 4. Metadata exposure

Extend the track object with:

```js
{
  rg: {
    trackGain:  row.rg_track_gain_db  ?? row.replaygainTrackDb,
    albumGain:  row.rg_album_gain_db  ?? null,
    truePeak:   row.rg_true_peak_dbfs ?? null,
    albumPeak:  row.rg_album_peak_dbfs ?? null,
    lra:        row.rg_lra            ?? null,
    src:        'measured' | 'tag' | 'r128' | null,
  }
}
```

Display in the now-playing panel: gain value, source badge, LRA if interesting
(≥ 12 LU → show "High dynamic range").

---

## Playback Path — Transcode (`transcode.js`)

For remote clients (mobile, external players using the transcode endpoint), add
an optional volume filter to the ffmpeg args when RG data is available:

```js
// In spawnTranscode(), when rgGainDb is non-null and rgEnabled:
// Apply gain + clipping prevention via filter chain:
// 1. volume= applies the linear gain
// 2. aresample=192000 upsamples for true-peak detection
// 3. alimiter applies a look-ahead true-peak limiter at -1 dBTP
// 4. aresample= back to the codec's preferred rate

const filterChain = [
  `volume=${totalGainDb}dB`,
  'aresample=192000',
  'alimiter=limit=0.891:level=false:asc=true',   // 0.891 ≈ -1 dBTP
  `aresample=${targetSampleRate}`,
].join(',');

args.push('-af', filterChain);
```

**`alimiter` flag note**: the `asc=true` parameter requires ffmpeg ≥ 5.0.
The `level=false` flag (do not apply input gain normalisation) has been
available since ffmpeg 4.x. Use this minimum-compat form when targeting
Docker images or older installs:

```js
'alimiter=limit=0.891:level=false',   // drop asc=true for wider compat
```

If `alimiter` is not available at all (very old ffmpeg), fall back to just
`volume=XdB` with no limiter — acceptable degradation since our pre-computed
gain values already incorporate clipping prevention at scan time.

**Why `alimiter` and not `loudnorm` here**: `loudnorm` is an AGC — it changes
the relative loudness of different parts of the track. We have already computed
the exact linear gain needed via EBU R128 measurement; we just need to apply
that gain and then protect the ceiling with a transparent true-peak limiter.
`alimiter` with a 100 ms look-ahead is transparent and introduces no
pumping or audible compression artefacts, unlike `loudnorm`'s AGC.

The `volume=XdB, aresample=192k, alimiter, aresample` chain is **functionally
identical** to what the `loudnorm` filter does internally, but applied with
pre-computed exact values instead of a dynamic estimation.

---

## Opus R128 Tag Handling (Special Case)

Opus files use `R128_TRACK_GAIN` and `R128_ALBUM_GAIN` (Q7.8 fixed-point
integer in the container header, decoded by music-metadata to dB). These are
referenced to **−23 LUFS** (the Opus spec reference level), not −18 LUFS.

When resolving gain for an Opus file:
- If `rg_track_gain_db` is available (server-measured, already at −18 LUFS
  reference) → use as-is.
- Else if `r128_track_gain_db` is present → `effective_gain = r128_track_gain_db + 5.0`
  (converting from −23 LUFS to −18 LUFS reference).
- Else fall back to `replaygainTrackDb` (if file was externally tagged with
  REPLAYGAIN_ Vorbis comments alongside the R128 tag — both can coexist).

The worker's measurement is format-agnostic (ffmpeg decodes Opus natively) so
Opus files go through exactly the same `ebur128` pipeline as MP3 or FLAC.

---

## Admin UI — "Normalization Workshop"

A new admin view under Tools (next to Tag Workshop and Artist Workshop):

### Overview card

| Metric | Value |
|---|---|
| Files with measured RG | 42,381 / 87,614 |
| Files with tag-only RG | 3,211 |
| Files with no RG data | 42,022 |
| Albums with album gain | 3,104 |
| Worker status | ● Running / ◌ Idle |

### Controls

- **Start / Stop analysis worker**
- **Re-analyse all** (resets `rg_measured_ts` for all files → full re-scan)
- **Re-analyse album** (targeted: reset one album's tracks)
- **Pre-amplification default** (server-wide default, users can override in
  player settings)

### File list (optional, later phase)

Browsable by album — shows track gain, album gain, LRA, true peak per track.
Highlights outliers (e.g. LRA > 20 LU — likely needs pre-amp boost for
classical listening).

---

## Admin Settings — Write Tags to Files (Optional / Destructive)

An opt-in setting: **Write RG tags back to audio files** after measurement.

- Uses ffmpeg stream copy (`-c copy`) with `-metadata REPLAYGAIN_TRACK_GAIN=...`
  — same approach as Tag Workshop
- Writes: REPLAYGAIN_TRACK_GAIN, REPLAYGAIN_TRACK_PEAK, REPLAYGAIN_ALBUM_GAIN,
  REPLAYGAIN_ALBUM_PEAK, REPLAYGAIN_TRACK_RANGE, REPLAYGAIN_REFERENCE_LOUDNESS
- For Opus: ALSO writes R128_TRACK_GAIN (Q7.8 integer), since that is what
  hardware Opus players expect
- Protected by a confirmation dialog: "This writes permanently to your audio
  files. Make sure your files are backed up."
- Useful for portability: tagged files carry their RG data to any player

This is **not required** for Velvet playback (DB is authoritative) but
gives portability.

---

## Implementation Phases

### Phase 1 — Foundation (DB + scanner + tag reading)

1. DB migration: add 14 new columns to `files` (8 measured + 6 tag-sourced)
2. Scanner: read and store all 6 tag-sourced RG fields into the new columns;
   continue writing `replaygainTrackDb` for backwards compatibility
3. API: extend metadata response with full RG object
4. Player: use `rg.trackGain` with fallback chain, add pre-amp slider (default 0),
   add clipping prevention, add album mode toggle
5. `resolveTrackGain()` utility function used by all API endpoints

### Phase 2 — Analysis worker + rsgain bootstrap

6. `src/util/rsgain-bootstrap.js` — auto-download rsgain static binary
   (same pattern as `ffmpeg-bootstrap.js`; Linux x64/Windows/macOS; arm64
   falls back to ffmpeg silently)
7. `src/util/rg-analysis-worker.mjs` — single-pass EBU R128 measurement;
   uses rsgain by default, ffmpeg when rsgain unavailable/disabled
8. `src/api/rg-analysis.js` — HTTP endpoint wrapper (start/stop/status)
   including `GET /api/v1/admin/rg/tool` → `{ tool: 'rsgain'|'ffmpeg', reason }`
9. Auto-start on boot if queue > 0
10. Album gain computation after album completion

### Phase 3 — Transcode integration

11. `transcode.js`: apply `volume= / aresample / alimiter` chain when RG data
    available and client requests it (query param `rg=1`)
12. Subsonic: populate full `replayGain` object (trackGain, albumGain, trackPeak,
    albumPeak, fallbackGain, fallbackPeak)

### Phase 4 — Admin UI

13. Normalization Workshop view in admin
14. Worker progress display — includes active tool badge (rsgain v3.7 / ffmpeg)
15. Config toggle: Tool preference (`auto` / `rsgain` / `ffmpeg`)
16. Optional tag write-back

---

## Test Scenarios

These scenarios must pass before any phase is considered complete.

### Phase 1 — DB / Scanner / Player

| # | Scenario | Expected |
|---|---|---|
| T1 | File with `REPLAYGAIN_TRACK_GAIN = -6.50 dB` in tags | `rg_tag_track_gain = -6.5`, `replaygainTrackDb = -6.5`, player gains by `10^(-6.5/20)` |
| T2 | File with `REPLAYGAIN_ALBUM_GAIN = -7.20 dB` in tags | `rg_tag_album_gain = -7.2`, album mode applies it |
| T3 | Opus file with `R128_TRACK_GAIN = -640` (Q7.8 = -2.5 dB) | `r128_track_gain_db = -2.5`, player applies `-2.5 + 5.0 = +2.5 dB` |
| T4 | File with no RG tags | All RG columns NULL, player gain = 1.0 (no change) |
| T5 | Pre-amp = +6 dB, track gain = -8 dB | `totalGainDb = -2`, scale = `10^(-2/20)` |
| T6 | Track gain = +10 dB, true peak = -0.3 dBTP | Clipping prevention reduces gain so `peak_linear × scale ≤ 0.944` |
| T7 | Track gain = +2 dB, true peak = -3 dBTP | No clipping prevention needed; full gain applied |
| T8 | RG toggle off | `_rgGainNode.gain = 1.0` regardless of track data |

### Phase 2 — Analysis Worker

| # | Scenario | Expected |
|---|---|---|
| T9 | Worker runs rsgain on a known FLAC (reference: −18.3 LUFS) | `rg_integrated_lufs ≈ -18.3`, `rg_track_gain_db ≈ -0.3 ± 0.1`, `rg_measurement_tool = 'rsgain'` |
| T10 | Same file with ffmpeg fallback | Values within 0.2 LU of rsgain measurement |
| T11 | rsgain configured as `"tool": "ffmpeg"` | Worker uses ffmpeg; `rg_measurement_tool = 'ffmpeg'`; no rsgain process spawned |
| T12 | rsgain binary absent (`rsgainAvailable() = false`, `tool = 'auto'`) | Worker falls back to ffmpeg silently; logs `[rg-worker] rsgain unavailable, using ffmpeg` |
| T13 | Corrupt / undecodable file | `rg_measured_ts = -1`, worker continues to next file |
| T14 | Album of 10 tracks — 9 measured, 1 pending | `rg_album_gain_db = NULL` until 10th track measured |
| T15 | Album of 10 tracks — all measured | `rg_album_gain_db` populated on all 10 rows; power-mean formula verified against loudgain's output for same album |
| T16 | Album with 1 failed track (`rg_measured_ts = -1`) | Album gain computed from the 9 successful tracks; -1 track excluded from power-mean |
| T17 | rsgain becomes available after ffmpeg measurement | Re-analysis pass re-measures `rg_measurement_tool = 'ffmpeg'` rows; updates values |
| T18 | rsgain stdout header row `File\tLoudness\t...` | Parser skips it; no parse error |
| T19 | Server restart with 500 files pending | Worker auto-starts within 15 s; resumes from `rg_measured_ts IS NULL` |
| T31 | Album entirely under albumsOnly child vpath (`Music/Albums/Beatles/Abbey Road/`) | Worker resolves absolute path via ROOT vpath `Music`; all 17 tracks grouped by `mb_album_dir = 'Albums/Beatles/Abbey Road/'`; `rg_album_gain_db` populated once all 17 measured |
| T32 | New track added to already-measured album (albumsOnly folder) | On worker pickup of new NULL row: siblings' `rg_album_gain_db` reset to NULL immediately; album gain recalculated after new track is measured; player falls back to track gain during the window |

### Phase 3 — Transcode

| # | Scenario | Expected |
|---|---|---|
| T20 | Transcode request with `rg=1`, track gain = -5 dB | ffmpeg args include `volume=-5dB,aresample=192000,alimiter=...` |
| T21 | Transcode request without `rg=1` | No volume filter in ffmpeg args |
| T22 | Subsonic `getSong` with RG data | `<replayGain trackGain="-5.0" trackPeak="0.95" albumGain="-4.8" albumPeak="0.92"/>` |

### Phase 4 — Bootstrap

| # | Scenario | Expected |
|---|---|---|
| T23 | Fresh install Linux x64 | `bin/rsgain/rsgain` downloaded; `rsgain --version` returns major ≥ 3 |
| T24 | Fresh install Linux arm64 | No rsgain download attempted; `rsgainAvailable() = false`; worker uses ffmpeg |
| T25 | `rsgain --version` returns < 3 (old binary) | Re-download triggered |
| T26 | GitHub releases API unreachable | Existing binary used if present and version OK; else graceful fallback to ffmpeg |
| T27 | macOS: binary downloaded | `xattr -d com.apple.quarantine` called; binary executable |

### Regression tests (run against existing test suite)

| # | Scenario | Expected |
|---|---|---|
| T28 | Existing `replaygainTrackDb` in DB pre-migration | Migration adds new columns as NULL; existing value preserved; player still applies it |
| T29 | Subsonic client not requesting RG | Existing Subsonic response format unchanged (backwards compat) |
| T30 | Crossfade enabled with RG on | `_rgGainNode` correctly ramped during crossfade — existing behaviour not broken |

---

## What We Are NOT Doing (and Why)

**Not using `loudnorm` for per-file processing**: `loudnorm` is an AGC that
dynamically changes the gain envelope within a track. For tracks with sufficient
headroom for a linear gain adjustment, it is unnecessary complexity. For tracks
without enough headroom (e.g. +8 dB needed but true peak at 0 dBFS), the
clipping prevention via `alimiter` on the playback path handles it transparently.
`loudnorm` would audibly compress the dynamics of high-LRA recordings (orchestral,
jazz) when applied in single-pass mode — exactly the opposite of the "perceived
loudness" goal.

**Not storing a single `loudnorm` measurement as a replacement for RG**: The Music
Assistant approach (cache the `loudnorm` linear output from first playback) is a
clever workaround for not having proper measurement infrastructure, but it
produces a value that is slightly different from a true EBU R128 measurement
because `loudnorm`'s measurement block includes its own AGC artefacts. We measure
directly with rsgain (libebur128) — or ffmpeg `ebur128` as fallback — both are
read-only, non-destructive, and produce exact EBU R128 integrated loudness values.

**Not bundling loudgain**: loudgain (Moonbase59 fork) is also libebur128-based and
produces identical measurements to rsgain, but it has been dormant since 2019.
rsgain is its actively maintained successor, the current MusicBrainz Picard backend,
and is available in Debian 13 / Ubuntu 24.04 / Fedora official packages.

**Not implementing `loudnorm` two-pass for transcoding**: This would require
running ffmpeg twice per transcode request — unacceptable latency for streaming.
Instead, we pre-compute the gain offline and apply a simple `volume=` + limiter
at stream time.

---

## References

- [EBU R128 Loudness Standard](https://tech.ebu.ch/docs/tech/tech3341.pdf)
- [ITU-R BS.1770-5](https://www.itu.int/rec/R-REC-BS.1770-5-202311-I/en)
- [ReplayGain 2.0 specification](https://wiki.hydrogenaudio.org/index.php?title=ReplayGain_2.0_specification)
- [ffmpeg loudnorm filter](https://k.ylo.ph/2016/04/04/loudnorm.html) — Kyle Swanson, the filter's author
- [rsgain](https://github.com/complexlogic/rsgain) — actively maintained RG 2.0 scanner, MusicBrainz Picard backend, uses libebur128
- [loudgain](https://github.com/Moonbase59/loudgain) — rsgain's predecessor (libebur128, dormant since 2019)
- [libebur128](https://github.com/jiixyj/libebur128) — the canonical EBU R128 C library underlying rsgain/loudgain
- [ffmpeg ebur128 filter docs](https://ffmpeg.org/ffmpeg-filters.html#ebur128)
