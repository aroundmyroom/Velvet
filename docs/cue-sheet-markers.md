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

Look for `common.cuesheet` in the parsed metadata — if it contains at least one track with an `INDEX 01` entry, those timestamps are used.

### 2. Sidecar `.cue` file (fallback)

If no embedded cue sheet is found, Velvet looks for a matching `.cue` file in the same directory:

1. First tries `<audio-basename>.cue` — e.g. `my-mix.flac` → `my-mix.cue`
2. Next tries `<audio-filename>.cue` — e.g. `my-mix.flac` → `my-mix.flac.cue`
3. If there is exactly **one** `.cue` file in the directory, uses that.
4. If there are **multiple** `.cue` files (e.g. two-disc set in a flat folder), reads the `FILE` directive of each candidate to find the one that references the current audio file.

The sidecar file must contain a `FILE` line that mentions the audio filename (case-insensitive). The standard `TRACK`/`TITLE`/`INDEX 01 MM:SS:FF` format is parsed where `FF` is frames (1/75th of a second).

---

## Database storage

Cue point data is stored in the `cuepoints` column of the `files` table in `velvet.sqlite`.

| Value | Meaning |
|---|---|
| `NULL` | Not yet checked — will be processed on the next scan |
| `'[]'` | Checked during last scan, no cue data found (sentinel — embedded tag not re-parsed, but **sidecar `.cue` files ARE re-checked** on album open and on playback) |
| `'[{"time":0,"title":"Track 1"}, ...]'` | JSON array of cue point objects |

Each cue point object:
```json
{ "no": 2, "title": "Some Title", "t": 12.4 }
```

- `no` — track number from the CUE sheet (integer)
- `title` — track title from the cue sheet, or `null` if not present
- `t` — seconds from the start of the file (float, rounded to 2 decimal places)

### Existing databases (migration)

If you already have an Velvet database created before this feature was added, the `cuepoints` column is added automatically on first boot via:

```sql
ALTER TABLE files ADD COLUMN cuepoints TEXT;
```

---

## How scanning works

Cue detection is built into the incremental scanner using the same **smart patch** pattern as album art (`_needsArt`):

1. **New file** — cue data is extracted during the full `parseMyFile()` pass and stored in `insertEntries()` immediately.
2. **Existing file, `cuepoints IS NULL`** — `get-file` returns `_needsCue: true`. The scanner re-opens just that file, extracts cue data, and POSTs to `update-cue`. No full re-parse needed.
3. **Existing file, `cuepoints` already set** — skipped entirely.

This means a library of 100k+ files is processed gradually across scans with no performance cliff.

---

## API endpoints

### GET `/api/v1/db/cuepoints`

Returns the cue points for a given file path.

**Query parameters**

| Parameter | Required | Description |
|---|---|---|
| `fp` | Yes | The virtual filepath of the track (relative to the vpath root) |

**Success response** — `200 OK`

```json
{ "cuepoints": [
    { "time": 0,     "title": "Track 01 - Intro" },
    { "time": 45.2,  "title": "Track 02 - Main Theme" },
    { "time": 193.8, "title": "Track 03 - Reprise" }
] }
```

Returns `{ "cuepoints": [] }` when no data exists for that file.

**Authentication** — requires a valid `x-access-token` header or cookie (standard Velvet auth).

---

### POST `/api/v1/scanner/update-cue`

Internal — used by the scanner child process only (requires `scanApproved` middleware). Writes cue point data (or the `'[]'` sentinel) back to the database.

```json
{
  "filepath": "12 inches/DJ Mix.flac",
  "vpath": "Music",
  "cuepoints": "[{\"time\":0,\"title\":\"Track 01\"}]"
}
```

---

## Client-side rendering

### `loadCuePoints(filepath)`

Called on every track change (normal play, next/prev, Auto-DJ crossfade handoff, and session restore on page load). Fetches from `/api/v1/db/cuepoints?fp=` and calls `renderCueMarkers()`.

### `renderCueMarkers()`

Builds `<button class="cue-tick">` elements and inserts them into `#cue-markers` (main player) and `#np-cue-markers` (Now Playing modal). Each tick:

- Is positioned as `left: <pct>%` based on `t / duration`
- Shows a tooltip via `data-label` attribute (rendered via CSS `::after` as `"<no>. <title>"`) on hover
- Seeks `audioEl.currentTime` on click using `e.stopPropagation()` to avoid conflicting with the seek bar's own click handler
- Track 1 at `t=0` is excluded by the filter `cp.t > 0` — the very start needs no marker

Markers are cleared and re-rendered on every track change.

---

## CSS classes

| Class | Element | Description |
|---|---|---|
| `.cue-markers` | Container `<div>` | Absolutely positioned overlay inside `.prog-track` |
| `.cue-tick` | `<button>` | Individual tick mark; 12px wide hit zone |
| `.cue-tick::before` | Pseudo | The visible 4px stem — amber (`rgba(255,190,30,.9)`) in dark mode, purple (`rgba(109,60,230,.8)`) in light mode |
| `.cue-tick::after` | Pseudo | Tooltip bubble shown on hover |

The tick container uses `top: 0; bottom: 0` so ticks are contained entirely within the seek bar rail (currently 6px tall, 8px on hover).

---

## Limitations & known behaviour

- **First track at time 0** is intentionally excluded from rendering (`cp.t > 0` filter). The very start position needs no marker since playback always begins there.
- **Sentinel `'[]'`** blocks re-parsing the **embedded** CUE tag (which can't change without the audio file itself changing). However, **sidecar `.cue` files are always re-checked** on two occasions:
  1. When the user opens the album detail view (`GET /api/v1/albums/detail`) — if a valid `.cue` is found, cuepoints are written to the DB immediately.
  2. When the file is played (`GET /api/v1/db/cuepoints`) — the sidecar is re-checked synchronously before returning the empty result.
  This means users can fix or add a sidecar `.cue` file and the changes will be picked up **without a full rescan** — just open the album or play the track.
- **Duration must be available** in the `<audio>` element for percentage positions to be calculated correctly. If `audioEl.duration` is `NaN` or `0` on the first render call, the ticks will all pile up at position 0. `renderCueMarkers()` also re-fires on `loadedmetadata` to correct this.
- **Sidecar `.cue` multi-disc sets** — when two FLAC+CUE pairs are placed in the **same flat folder** (e.g. `Album/disc1.flac` + `Album/disc1.cue` + `Album/disc2.flac` + `Album/disc2.cue`), the album browser treats each file as its own virtual disc and displays CD1 / CD2 tabs, exactly as it does when the pairs are in named subfolders (`CD1/`, `CD2/`). Both the `_buildDiscList` logic and the `_findCuePath` sidecar lookup were updated to handle this case — the CUE file is matched by reading the `FILE` directive when the filename alone is ambiguous.
