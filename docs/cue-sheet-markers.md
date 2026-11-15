# CUE Sheet Track Markers

Velvet can read CUE sheet data from your audio files and display the individual tracks as clickable markers on the seek bar. This lets you jump directly to any chapter or track within a single long audio file (common with DJ mixes, classical recordings, vinyl rips, and compilation FLACs).

---

## What it looks like

When a file has cue point data the seek bar shows small vertical tick marks — one per track entry. Hovering a tick shows the track title and index. Clicking a tick seeks directly to that track's start time.

The ticks appear in both the main player bar and inside the Now Playing modal.

---

## Source formats supported

### 1. Embedded cue sheet (preferred)

Some encoders write the CUE sheet directly into the audio file's tags (e.g., in a `CUESHEET` field of a FLAC file). Velvet uses [music-metadata](https://github.com/borewit/music-metadata) to extract this automatically.

Velvet reads `common.cuesheet` from the parsed metadata. Each track's `INDEX 01` offset (in samples) is divided by the sample rate; the lead-out track (number 170) is skipped. At least **two** markers are needed, otherwise the embedded sheet is ignored.

### 2. Sidecar `.cue` file (fallback)

If no embedded cue sheet is found, Velvet looks for a matching `.cue` file in the same directory. The scanner tries:

1. `<audio-filename>.cue` — e.g. `my-mix.flac` → `my-mix.flac.cue`
2. `<audio-basename>.cue` — e.g. `my-mix.flac` → `my-mix.cue`
3. the only `.cue` file in the directory, if there is exactly one

The play-time re-check (`GET /api/v1/db/cuepoints`) tries `<audio-basename>.cue`, then the only `.cue` in the directory. The album detail view tries `<audio-basename>.cue`, `<audio-filename>.cue`, the only `.cue`, and — when there are **several** `.cue` files (e.g. a two-disc set in a flat folder) — the one whose `FILE` directive references the audio file.

The sidecar must have exactly one `FILE` line, and its file name must match the audio file's name ignoring the extension (case-insensitive) — so `FILE "album.wav"` works for `album.flac`. The standard `TRACK`/`TITLE`/`INDEX 01 MM:SS:FF` format is parsed where `FF` is frames (1/75th of a second). At least two tracks are needed.

### 3. M4B chapters

For `.m4b` files with no cue data, chapters are read with `ffprobe -show_chapters` (at least two chapters; untitled ones become `Chapter N`).

---

## Database storage

Cue point data is stored in the `cuepoints` column of the `files` table in `velvet.sqlite`.

| Value | Meaning |
|---|---|
| `NULL` | Not yet checked — will be processed on the next scan |
| `'[]'` | Checked, no cue data found (sentinel — embedded tag not re-parsed, but **sidecar `.cue` files ARE re-checked** on album open and on playback) |
| `'[{"no":1,"title":"Intro","t":0}, ...]'` | JSON array of cue point objects |

Each cue point object:
```json
{ "no": 2, "title": "Some Title", "t": 12.4 }
```

- `no` — track number from the CUE sheet (integer)
- `title` — track title from the cue sheet, or `null` if not present
- `t` — seconds from the start of the file (float, rounded to 2 decimal places)

The `cuepoints` column is part of the `files` table schema.

---

## How scanning works

Cue detection is built into the incremental scanner using the same **smart patch** pattern as album art (`_needsArt`):

1. **New or changed file** — cue data is extracted during the full `parseMyFile()` pass (embedded → sidecar → M4B chapters) and stored by `insertEntries()`.
2. **Existing file, `cuepoints IS NULL`** — `get-files-batch` returns `_needsCue: true`. The scanner re-opens just that file, extracts cue data (same order), and POSTs the result or the `'[]'` sentinel to `update-cue`. No full re-parse needed.
3. **Existing file, `cuepoints` already set** — skipped.

If the player asks for cue points of a file that is still `NULL`, `GET /api/v1/db/cuepoints` extracts them on demand and stores the result.

This means a library of 100k+ files is processed gradually across scans with no performance cliff.

---

## API endpoints

### GET `/api/v1/db/cuepoints`

Returns the cue points for a given file path.

**Query parameters**

| Parameter | Required | Description |
|---|---|---|
| `fp` | Yes | The track's filepath including the vpath (e.g. `Music/12 inches/DJ Mix.flac`) |

**Success response** — `200 OK`

```json
{ "cuepoints": [
    { "no": 1, "title": "Intro",      "t": 0 },
    { "no": 2, "title": "Main Theme", "t": 45.2 },
    { "no": 3, "title": "Reprise",    "t": 193.8 }
] }
```

Returns `{ "cuepoints": [] }` when no data exists for that file (or on any error).

**Authentication** — requires a valid `x-access-token` header or cookie (standard Velvet auth).

---

### POST `/api/v1/scanner/update-cue`

Internal — used by the scanner child process only (requires `scanApproved` middleware). Writes cue point data (or the `'[]'` sentinel) back to the database.

```json
{
  "filepath": "12 inches/DJ Mix.flac",
  "vpath": "Music",
  "cuepoints": "[{\"no\":1,\"title\":\"Track 01\",\"t\":0},{\"no\":2,\"title\":\"Track 02\",\"t\":312.5}]"
}
```

---

## Client-side rendering

### `loadCuePoints(filepath)`

Called on every track change (normal play, next/prev, Auto-DJ crossfade handoff, and session restore on page load). Fetches from `/api/v1/db/cuepoints?fp=` and calls `renderCueMarkers()`.

### `renderCueMarkers()`

Builds `<span class="cue-tick">` elements and inserts them into `#cue-markers` (main player) and `#np-cue-markers` (Now Playing modal). Each tick:

- Is positioned as `left: <pct>%` based on `t / duration`
- Shows a tooltip via `data-label` attribute (rendered via CSS `::after` as `"<no>. <title>"`, or `Track <no>` without a title) on hover
- Seeks the current track on click, using `e.stopPropagation()` to avoid conflicting with the seek bar's own click handler
- Track 1 at `t=0` is excluded by the filter `cp.t > 0` — the very start needs no marker

Markers are cleared on every track change and rendered once the duration is known. M4B chapters also drive the audiobook chapter bar.

---

## CSS classes

| Class | Element | Description |
|---|---|---|
| `.cue-markers` | Container `<div>` | Absolutely positioned overlay inside `.prog-track` |
| `.cue-tick` | `<span>` | Individual tick mark; 12px wide hit zone |
| `.cue-tick::before` | Pseudo | The visible 4px stem — amber (`rgba(255,190,30,.9)`) in dark mode, purple (`rgba(109,60,230,.8)`) in light mode |
| `.cue-tick::after` | Pseudo | Tooltip bubble shown on hover |

The tick container uses `inset: 0` so ticks are contained entirely within the seek bar rail (`.prog-track`, 5px tall).

---

## Limitations & known behaviour

- **First track at time 0** is intentionally excluded from rendering (`cp.t > 0` filter). The very start position needs no marker since playback always begins there.
- **Sentinel `'[]'`** blocks re-parsing the **embedded** CUE tag (which can't change without the audio file itself changing). However, **sidecar `.cue` files are always re-checked** on two occasions:
  1. When the user opens the album detail view (`GET /api/v1/albums/detail`) — if a valid `.cue` is found, cuepoints are written to the DB immediately.
  2. When the file is played (`GET /api/v1/db/cuepoints`) — the sidecar is re-checked synchronously before returning the empty result.
  This means users can fix or add a sidecar `.cue` file and the changes will be picked up **without a full rescan** — just open the album or play the track.
- **Duration must be available** in the `<audio>` element for percentage positions to be calculated. `renderCueMarkers()` does nothing while `audioEl.duration` is unknown and is called again when the duration becomes available.
- **Sidecar `.cue` multi-disc sets** — when two FLAC+CUE pairs are placed in the **same flat folder** (e.g. `Album/disc1.flac` + `Album/disc1.cue` + `Album/disc2.flac` + `Album/disc2.cue`), the album browser treats each file as its own virtual disc and displays CD1 / CD2 tabs, exactly as it does when the pairs are in named subfolders (`CD1/`, `CD2/`). The album detail lookup (`_findCuePath`) matches the CUE file by its `FILE` directive when the filename alone is ambiguous. The scanner and the play-time check do not do this matching; with several `.cue` files they only find a sidecar named after the audio file.
