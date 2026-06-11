# Loudness Normalisation in Velvet

## What it does

Velvet measures the loudness of every audio file in your library using
the **EBU R128 / ReplayGain 2.0** standard and stores the results in the
database. The player then adjusts the volume of each track so they all sound
equally loud — regardless of how the original files were mastered.

At the core of every track measurement is one number: **Integrated Loudness**,
measured in LUFS (Loudness Units relative to Full Scale). The system computes
how loud a track actually sounds to human ears — not just how loud its
waveform peaks are — and derives a **Gain** value (in dB) to bring that track
to a consistent reference level of **−18 LUFS**.

### Database columns written per track

| Column | Description |
|---|---|
| `rg_integrated_lufs` | Measured integrated loudness (LUFS) |
| `rg_true_peak_dbfs` | True inter-sample peak (dBFS) |
| `rg_track_gain_db` | Per-track gain to reach −18 LUFS |
| `rg_lra` | Loudness Range — dynamic width of the recording |
| `rg_album_gain_db` | Shared album-level gain across all tracks of the same album |
| `rg_album_peak_dbfs` | Worst-case true peak across the album |
| `rg_measured_ts` | Unix timestamp of measurement (−1 = failed) |
| `rg_measurement_tool` | `"rsgain"` or `"ffmpeg"` |

Tag-sourced fallback values (read at scan time) are also stored:
`rg_tag_track_gain`, `rg_tag_track_peak`, `rg_tag_album_gain`,
`rg_tag_album_peak`, `r128_track_gain_db`, `r128_album_gain_db`.

### Player-side application

The player reads the `rg` object from the track metadata response
(`GET /api/v1/db/metadata`). `resolveTrackGain()` applies a priority chain:

1. **Measured value** — from the worker analysis (`rg_track_gain_db` /
   `rg_album_gain_db`). Most accurate.
2. **R128 tag** — `R128_TRACK_GAIN` / `R128_ALBUM_GAIN` from Opus files, with
   a +5 dB reference offset (Opus uses −23 LUFS; we normalise to −18 LUFS).
3. **ReplayGain tag** — classic `REPLAYGAIN_TRACK_GAIN` / `REPLAYGAIN_ALBUM_GAIN`
   already embedded in the file at scan time.

The resolved gain is applied via a Web Audio `GainNode`. Three user settings
control the final level:

- **Mode** — *Track* (each track normalised independently) or *Album* (use the
  album gain to preserve the relative loudness dynamics within an album — a
  quiet intro track stays quieter than the loud finale).
- **Pre-amp** — an additional offset in the range −10 to +10 dB. Useful when
  you want every track at a consistent level but slightly louder or quieter
  than the −18 LUFS reference.
- **Clip Prevention** — when enabled, the gain is reduced if it would cause the
  true peak to exceed 0 dBTP after adjustment.

Settings are persisted in `localStorage` and synced across devices via user
preferences.

### Transcode path

When the player requests a server-side transcode (e.g. for format conversion
or bitrate reduction), the resolved gain is passed through to ffmpeg via a
`volume=<linear>,alimiter` filter chain, so even transcoded streams arrive at
the correct loudness.

### MPV cast path

When the user activates **Cast to server speaker** (MPV), the browser sends
the RG mode, pre-amp and clip-prevention settings along with the track filepath.
The server resolves the gain from the database using the same priority chain as
the browser player, then applies it via MPV's IPC command:

```
{ "command": ["af", "set", "volume=<linear>"] }
```

This fires immediately after MPV's `file-loaded` event, ensuring every cast
track plays at the correct loudness level. If a track has no RG data, the filter
is cleared and MPV plays at its natural level.

---

## Why EBU R128 — not RMS, not ReplayGain 1.0

### The problem with RMS loudness

The classic approach (ReplayGain 1.0, MP3Gain) divides audio into blocks,
computes RMS power, and averages them. RMS power is a good proxy for
instantaneous energy, but it does not model hearing:

- A bass-heavy track measured at −14 dBFS RMS sounds much louder than a
  treble-heavy track at the same RMS, because human hearing is more sensitive
  at mid and high frequencies.
- Silence, audience noise and reverb tails count towards the average — a track
  with a 30-second quiet intro and 3 minutes of loud music gets a lower
  "average" than it sounds.

### What EBU R128 adds

**ITU-R BS.1770-4**, which EBU R128 is built on, introduces two innovations:

1. **K-weighting** — a pre-emphasis filter applied before measurement. It
   models the frequency sensitivity of human hearing: mid and high frequencies
   are boosted, low frequencies are attenuated. A bass-heavy mastered track and
   a neutral mastered track at the same perceived loudness will measure at the
   same LUFS.

2. **Gating** — 400 ms measurement blocks are discarded if their loudness is
   more than 10 LU below the average of all non-silent blocks (relative gate)
   or below −70 LUFS absolute. Silence and quiet passages do not lower the
   measurement. Only the "active programme" is measured.

The result is a loudness value that correlates closely to perceived equal
loudness across genres, mastering styles, and dynamic ranges.

### Why −18 LUFS as reference (not −14, not −23)

- **−23 LUFS** is the EBU R128 broadcast reference (used by Opus `R128_*`
  tags). It leaves too much headroom for music playback.
- **−14 LUFS** is the Spotify / streaming reference. It is equivalent to the
  classic ReplayGain 1.0 target (89 dB SPL with the original pink-noise
  reference).
- **−18 LUFS** is the **ReplayGain 2.0** reference — a reasonable middle
  ground adopted by the rsgain, loudgain, and bs1770gain projects. It matches
  the recommendation in the ReplayGain 2.0 specification and gives adequate
  headroom for peak-normalised content while still sounding full.

We chose **−18 LUFS** because:
- It is the formal ReplayGain 2.0 spec target.
- `rsgain` (the primary tool) defaults to −18 LUFS.
- It maintains backwards compatibility with existing RG tags written by tools
  that follow the RG 2.0 spec.

---

## Why rsgain as the primary tool

Two tools can measure EBU R128 / BS.1770-4:

| | **rsgain** | **ffmpeg `ebur128`** |
|---|---|---|
| Core library | **libebur128** — the canonical C reference implementation | ffmpeg's own BS.1770 re-implementation |
| True peak detection | Dedicated polyphase FIR interpolator | General-purpose libswresample resampling |
| Accuracy | Reference spec; used as the baseline by the BSI | Typically < 0.1 LU difference from reference |
| Speed | Per-file spawns; tab-delimited output; no stderr scraping | Per-file spawns; stderr scraping |
| Tag writing | Can write RG tags back to files | Audio processing only |
| Availability | Linux x64 static binary only | Always available (bundled ffmpeg) |

**rsgain is preferred because**:
- `libebur128` *is* the reference implementation that EBU R128 was defined
  against. Any other tool is measured against it.
- The tab-delimited output (`custom --tagmode=s -O`) is machine-readable with no
  stderr scraping.
- Per-file spawning is fast; true-peak detection is more accurate than ffmpeg's.

**ffmpeg is the fallback** on platforms where no rsgain binary is available
(Docker arm64, Windows, macOS). The accuracy difference is immaterial in
practice — both give results within the measurement uncertainty of the standard.

The binary is auto-downloaded from the
[complexlogic/rsgain GitHub releases](https://github.com/complexlogic/rsgain)
using the same bootstrap pattern as ffmpeg itself (`bin/rsgain/rsgain`).
Minimum required version: **3.7** (tested; uses `custom --tagmode=s -O` for
per-file tab-delimited output). The Dockerfile pre-downloads it for x64 container builds.

---

## Album gain — how it is computed

Track gain normalises each track to −18 LUFS independently. This is correct
for shuffle playback but wrong for album listening: a quiet ambient intro
track on a concept album *should* be quieter than the loud finale — that is
an artistic decision. Album gain preserves this relationship.

**Album grouping**: tracks are grouped by `mb_album_dir` (the MusicBrainz
album directory field) when available, or by `(vpath, album_artist/artist,
album)` when not. This matches the same grouping used by the Tag Workshop.

**Album gain calculation**: once all tracks in a group are measured, the
worker computes the mean integrated loudness across the group and derives a
single shared gain:

```
album_gain = −18 − mean(integrated_lufs for all tracks in album)
```

The album peak is the worst-case `rg_true_peak_dbfs` across the group. Both
values are written to every track in the group.

Album gain is only written **after every track in the album is measured** — a
partial result would be inaccurate and potentially confuse players that mix
track and album gain values.

---

## Worker design

The measurement runs in a **Node.js worker thread** (`rg-analysis-worker.mjs`)
so it never blocks the HTTP server or the main DB writer.

- **Batch size**: 50 files per cycle, with a 50 ms yield between files to
  avoid I/O saturation on spinning disks.
- **Idle sleep**: when the queue is empty, the worker sleeps for 60 seconds
  before re-checking.
- **Failure handling**: files that fail measurement are marked
  `rg_measured_ts = −1` with a reason code (`measure_failed`, `timed_out`,
  `file_not_found`, `missing_vpath`, `resource_fork`) and the actual error
  text from rsgain/ffmpeg stored in `rg_measurement_error`. They are excluded
  from normal queue cycling.
- **Timeout**: proportional to file duration — `max(120 s, duration × 0.5 s)`
  so long files (audiobooks, megamixes) get a realistic budget instead of a
  hard 2-minute cap.
- **Shelving** (`rg_measured_ts = −2`): files that can never be analysed
  (silence, test tones, macOS resource forks, unsupported containers) can be
  permanently excluded via the Shelve button in the failed files modal.
  Shelved files survive Reset All and are never touched by the worker again.
- **Smart Reset Failed**: the "Reset Failed" button checks each failed file on
  disk. Files missing from disk are purged from the DB (preventing a retry
  cycle); only files that still exist are re-queued for retry.
- **macOS resource forks**: files whose basename starts with `._` are
  immediately marked `resource_fork` without running rsgain — they are never
  audio and should be shelved.
- **Re-measurement with rsgain**: when rsgain becomes available after a prior
  ffmpeg-only run, files previously measured by ffmpeg are added back to the
  queue for re-measurement (more accurate true-peak detection).
- **Auto-start**: the API module starts the worker automatically 60 seconds
  after server boot if there are unmeasured files in the queue — no manual
  action needed.

---

## Admin UI — Normalisation Workshop

The **Normalisation Workshop** panel (Admin → Tools → Normalisation) shows:

- Which measurement tool is active (rsgain or ffmpeg fallback)
- Library progress: measured / total / pending / failed / shelved / existing tags
- Per-tool breakdown (how many measured by rsgain vs ffmpeg)
- Start / Stop / Reset Failed / Undo Reset All controls
- Live status polling (every 3 s while running, 15 s while idle)

When the library scanner refreshes a file because its path, mtime, or hash changed, Velvet now preserves any existing ReplayGain analysis for that row instead of treating it as brand-new pending work. That prevents false jumps in the workshop's pending count after rescans of already-analysed files.

### Failed file inspector

Clicking the **Failed ℹ** row opens a modal listing every failed file with:
- Filename and full path (on hover)
- Error detail text from rsgain/ffmpeg (e.g. `[✘] Could not open input: Invalid data found`, or `No loudness data — file may be silent, too short, or in an unsupported format`)
- Failure reason badge: Measurement error / Timed out / File not found / Folder not configured / Resource fork
- Duration
- Per-row **Shelve** button and **Shelve all** button

### Undo Reset All

Before clearing all measurements, `resetRgAll()` snapshots the existing data into a `rg_backup` table. An amber banner appears in the admin UI letting you undo the reset at any time until the worker starts again (the backup is discarded once re-measurement begins). The backup survives server restarts.

---

## Priority chain — `resolveTrackGain()`

When the player requests metadata, `resolveTrackGain(row, mode)` determines
the best available gain in this priority order:

```
1. Measured (rg_track_gain_db / rg_album_gain_db)  ← preferred
2. R128 tag  (r128_track_gain_db + 5.0 dB offset)  ← Opus native
3. ReplayGain tag (rg_tag_track_gain)               ← classic embedded tag
4. null                                             ← no normalisation
```

The +5 dB offset on R128 converts from Opus's −23 LUFS reference to the
−18 LUFS reference used everywhere else in the system.

`mode` is `'track'` (default) or `'album'`. When `'album'` is requested and
no album gain is available, the function falls back to track gain silently.

---

## Security and correctness considerations

- **Read-only measurement**: the worker never modifies audio files. All
  results are stored only in the Velvet SQLite database. File-tag
  writeback is intentionally out of scope.
- **No shell injection**: rsgain is spawned via Node.js `spawn()` with an
  explicit argument array — no shell interpolation.
- **WAL mode**: the worker opens the DB in WAL mode with a 30-second busy
  timeout, so measurement writes never block the main server.
- **True-peak clipping prevention**: when Clip Prevention is enabled, the
  player reduces gain further if `gain + resolvedPeak > 0 dBTP` to avoid
  audible clipping after the GainNode.

---

## Related files

| File | Role |
|---|---|
| `src/util/rsgain-bootstrap.js` | Download/verify rsgain binary |
| `src/util/rg-analysis-worker.mjs` | Background measurement worker thread |
| `src/api/rg-analysis.js` | REST API + worker lifecycle |
| `src/db/sqlite-backend.js` | DB schema (14 RG columns) + helper functions |
| `src/db/scanner.mjs` | Reads existing RG/R128 tags at scan time |
| `src/api/db.js` | `resolveTrackGain()` + `rg` object in metadata response |
| `src/api/transcode.js` | `spawnTranscode(gainDb)` — gain applied to transcode |
| `webapp/app.js` | Player: `_applyRGGain()`, mode/preamp/clip settings |
| `webapp/admin/index.js` | Normalisation Workshop admin component |
| `docs/replaygain-plan.md` | Original design plan (pre-implementation) |
