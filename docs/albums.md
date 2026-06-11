# Album Library

*Introduced in v6.1.0-velvet. Category folder pills added v6.14.18-velvet.*

The Album Library is a dedicated, full-featured view for browsing, navigating, and playing your music collection organised as albums. It is a **DB-driven, performant browser** that automatically groups albums into series, handles multi-disc albums, resolves cover art from disk or embedded tags, detects single-file CUE-sheet albums, and shows edition/version badges.

---

## Quick start

1. **Create your folder structure** (see [Folder layout](#folder-layout) below).
2. **Mark the folder as Albums Only** — Admin → Directories → edit the folder → toggle **Albums Only** → Save.
3. **Run a scan** — Admin → Database → Start Scan (or wait for the scheduled scan).
4. **Open the Album Library** — click **Albums** in the left navigation.

That is all. No extra configuration is required for basic use.

---

## Folder layout

The Album Library reads file paths from the database. It expects music to be organised under an *albumsOnly* folder:

```
<albumsOnly root>/
  <artist or series>/
    <album folder>/
      track.flac          ← standalone album, tracks directly in folder
      cover.jpg

  <artist or series>/
    <album 1>/
      CD 1/               ← multi-disc: sub-folder matches disc pattern
        01 Track.flac
      CD 2/
        01 Track.flac
      cover.jpg

  <series name>/
    <sub-album 1>/        ← series: sub-folders do NOT match disc pattern
      01 Track.flac
    <sub-album 2>/
      01 Track.flac

  <artist or series>/
    [Live]/               ← category container (see Category folders below)
      <album folder>/
        01 Track.flac
```

### Real-world examples

| Path (relative to albumsOnly root) | Result |
|---|---|
| `Sade/Diamond Life (1984)/01 Smooth Operator.flac` | Standalone album by Sade |
| `The Beatles/Abbey Road (1969)/CD 1/01 Come Together.flac` | Multi-disc album, disc tab "CD 1" |
| `Cerrone Discography/Cerrone I (1976)/01 Love In C Minor.flac` | Album inside a series |
| `Cerrone Discography/[Live]/Cerrone Live At Palais Des Congrès/01.flac` | Album under category `[Live]` |
| `Cerrone Discography/Downloads uitzoeken/Some Mix.flac` | Album under category `Downloads uitzoeken` |
| `Hit Mix/Hit Mix '88 CD - 1/01 Track.flac` | Disc suffix pattern — treated as disc, not sub-album |

---

## Album vs Series vs Disc detection

The system inspects every **L1 folder** (direct child of the albumsOnly root):

| Condition | Result |
|---|---|
| All files sit directly in the L1 folder | **Standalone album** |
| All L2 sub-folders match the disc pattern | **Multi-disc album** — each L2 becomes a disc tab |
| L2 sub-folders do NOT match the disc pattern | **Series** — each L2 becomes its own album card |

### Disc folder patterns

A sub-folder is treated as a *disc* (not a separate album) when its name matches any of:

| Pattern | Matches | Does not match |
|---|---|---|
| Starts with `CD`, `Disc`, `DISC` + optional dash + digit | `CD 1`, `Disc 2`, `CD-3`, `DISC 1` | `Disconet`, `2CD` |
| Ends with `CD` / `Disc` + optional dash + digit | `Hit Mix '88 CD - 1`, `Album Disc 2` | `CD Edition`, `2xCD` |
| Bare one or two digit number | `1`, `2`, `12` | `12 Hits` |

The suffix pattern (`…CD - N`) was added in v6.14.18-velvet to handle EAC-style disc naming where the disc indicator comes at the end of the folder name.

---

## Category folders

*Added in v6.14.18-velvet.*

Sometimes an artist or series folder contains sub-folders that are **not** albums or discs, but **categories** — e.g. `[Live]`, `[Compilations]`, `Downloads uitzoeken`. Without special handling these look like series sub-albums and pollute the artist grouping.

**Category folders are transparent containers.** When a folder name matches the configured list:
- It is stripped from the album's artist path (so the album groups under its grandparent, not under `[Live]`)
- Its name is stored as a `categoryLabel` on the album
- The series/artist view shows **category pills** — one pill per distinct category in that series

### Category pill UI

In the **Album Series** view and the **Artist → Albums tab**, a pill row appears above the grid when at least one album in the series has a category label:

```
[ Albums ]  [ Live ]  [ Compilations ]  [ Downloads uitzoeken ]
```

Clicking a pill filters the grid to show only albums of that category. Clicking the active pill again (or clicking **Albums**) resets to show everything.

### Configuring category folders

Go to **Admin → Database → Artist Albums** and look for the **Album Category Folders** section.

- The list shows the current category names (one per line / one per chip).
- Click **Add** to type a new name, then **Save**.
- Click the × on an existing chip to remove it, then **Save**.
- Changes take effect immediately — no rescan needed.

**Default category names** (shipped with Velvet):

| Name | Language |
|---|---|
| `[Live]`, `Live`, `Live Albums` | English |
| `[Compilations]`, `Compilations`, `Compilation` | English |
| `[Singles]`, `Singles`, `EPs & Singles` | English |
| `[Remixes]`, `Remixes` | English |
| `Downloads uitzoeken`, `Compilaties`, `Live Albums` | Dutch |
| `Compilations`, `En direct` | French |
| `Sampler`, `Live-Alben` | German |
| `Compilazioni`, `Dal vivo` | Italian |
| `Recopilaciones`, `En vivo` | Spanish |

Add any folder name that appears in your own collection. The match is case-sensitive and exact.

---

## Single-file albums with CUE sheets

The Album Library fully supports **single-file rips** (one FLAC or WAV file per album) accompanied by a CUE sheet. The CUE sheet is used to split playback into individual tracks with correct titles and times.

### CUE detection order

1. **Embedded CUE sheet** — stored inside the FLAC file's `CUESHEET` block (written by EAC and dBpoweramp in lossless mode). Detected automatically — no extra file needed.
2. **Sidecar `{filename}.cue`** — e.g. `Sade - Promise.cue` next to `Sade - Promise.flac`. The `FILE` line in the `.cue` may reference either the exact filename OR the same base name with a different extension (e.g. `FILE "Sade - Promise.wav"` is accepted for `Sade - Promise.flac`).
3. **Sidecar `{filename}.flac.cue`** — double-extension variant (e.g. `Sade - Promise.flac.cue`). This takes priority over the bare `.cue` when both exist.
4. **Sole `.cue` in the folder** — if the folder contains exactly one `.cue` file and its `FILE` line matches the audio file by base name, it is used.

> **Note:** EAC always writes `FILE "album.wav" WAVE` in the CUE, even when ripping to FLAC. Velvet accepts this — it compares base names only, ignoring the extension.

### What you see in the UI

When a single-file album is detected as having CUE points:
- The album detail view shows individual track rows with track numbers, titles, and durations derived from the CUE offsets.
- Clicking a track starts playback from that position.
- The progress bar shows the position within the full file, with track boundaries visible.
- "Add all to queue" and per-track "+" queue buttons work as expected.

---

## Album version badges

*Introduced in v6.14.x-velvet.*

When an album folder contains version or edition information, Velvet extracts it and shows it as a small badge on the album card (e.g. `Remaster`, `Deluxe`, `Japan Press`).

### Where version info comes from

1. **Tag fields** — the scanner reads a configurable list of tag fields:
   - Default fields: `TIT3`, `TXXX:EDITION`, `TXXX:VERSION`, `COMMENT` (and Vorbis equivalents).
   - Custom fields can be added via Admin → Database → Artist Albums → **Album Version Tag Fields**.
2. **Folder name heuristics** — year patterns, press info, edition keywords in the folder name are also recognised.

### Configuring version tag fields

Go to **Admin → Database → Artist Albums** → **Album Version Tag Fields**. Add any tag field name your ripping software writes. Click **Save**; the new fields are used in the next scan.

---

## Cover art resolution

For every album the system looks for cover art in this priority order:

1. **Image file in the album folder** — scanned top-down:
   ```
   cover.jpg   Cover.jpg   front.jpg   Front.jpg
   Folder.jpg  folder.jpg
   cover.png   Cover.png   front.png   Front.png
   cover.webp  Cover.webp
   ```
2. **Image file inside the first disc sub-folder** — for multi-disc albums that store art per-disc.
3. **Embedded art from the DB** (`aaFile`) — extracted during file scanning, cached in `image-cache/`.

If none found, a placeholder icon is shown.

### Adding cover art manually

Drop a supported filename into the album folder. The cache TTL is **5 minutes** — art appears automatically on the next browse.

```
/media/music/Albums/Sade/Diamond Life (1984)/cover.jpg
```

---

## Browsing the Album Library

### Main grid

Open **Albums** in the left nav. The main grid shows:
- **Series cards** — a representative cover + series name + number of albums.
- **Standalone album cards** — cover + album title + year.

Use the **search box** (top right) to filter by title, artist, or year as you type.

### Series view

Click a series card to see all albums in the series. Each album card shows:
- Cover art
- Album title
- Year (if available)
- Edition/version badge (if detected)
- **Category pills** — if the series contains categorised albums, a pill row appears at the top. Click a pill to filter.

### Album detail view

Click an album card to open the full detail:
- **Disc tabs** — for multi-disc albums, one tab per disc. Click to switch.
- **Track list** — track number, title, duration. Drag-to-reorder is not available here; use the queue panel.
- **CUE tracks** — for single-file CUE albums, individual tracks are listed with their chapter time offsets.
- **Play album** button — clears the queue and plays the full album from the first track.
- **Add to queue** (+ icon per track) — appends the selected track.
- **Play from here** — clicking a track row starts the album from that track. If the queue is not empty, the album is appended (not replaced).

---

## Admin tools

### Admin → Database → Artist Albums

This page contains two configuration panels and a diagnostic tool:

| Panel | Purpose |
|---|---|
| **Album Version Tag Fields** | Configure which tag fields the scanner reads for edition/version info |
| **Album Category Folders** | Configure folder names that are treated as category containers |
| **Artist Albums Diagnostic** | Inspect how a specific artist's albums are structured in the DB |

### Admin → Directories

| Setting | Effect |
|---|---|
| **Albums Only** toggle | Marks the folder as an Album Library source. All its contents appear in the Album Library. |
| Multiple folders can be Albums Only | All are merged into one Album Library. |

---

## Folder structure requirements

Enable **Albums Only** on a folder via Admin → Directories → edit → **Albums Only** toggle → Save.

- Any folder of type `music` or `audio-books` can be marked `albumsOnly: true`.
- **Multiple** folders can be Albums Only simultaneously — all are merged into one Album Library.
- A folder can be a **root vpath** (its own DB entry) or a **child vpath** (a sub-folder of another vpath). Child vpath files are already stored in the DB under the parent root — they are never indexed separately.
- If no folder has `albumsOnly` set, the system falls back to auto-detecting any root vpath that has an `Albums/` sub-directory on disk (legacy fallback for older configurations).
- The `albumsOnly` flag takes effect immediately — no server restart or rescan required.

---

## Performance

| Scenario | Timing |
|---|---|
| First load (fresh cache) | ~60 ms — DB read + in-memory tree build + parallel art resolution |
| Subsequent loads | instant — 5-minute in-memory cache, no DB or filesystem access |
| After a new scan | cache is invalidated automatically |
| After adding a cover image | art appears within 5 minutes (cache TTL) |
| After changing `albumCategoryFolders` in admin | takes effect immediately — no rescan needed |

---

## API

| Endpoint | Description |
|---|---|
| `GET /api/v1/albums/browse` | Returns the full album tree `{ albums, series }` |
| `GET /api/v1/albums/art-file?p=<path>` | Serves an on-disk art file by its relative path |

See [docs/API/albums_browse.md](API/albums_browse.md) for full request/response details.

---

## Changelog

| Version | Change |
|---|---|
| v6.1.0-velvet | Initial Album Library — series/disc detection, cover art, DB-driven browser |
| v6.14.x-velvet | Album version badges — edition/version detection from tags and folder name |
| v6.14.17-velvet | Fix: track click in album detail no longer clears an existing queue |
| v6.14.18-velvet | Fix: disc-suffix folder names (e.g. `Hit Mix '88 CD - 1`) now recognised as discs |
| v6.14.18-velvet | Fix: sidecar `.cue` detection now accepts EAC's `.wav` FILE reference for FLAC files; also tries `{file}.flac.cue` double-extension sidecar |
| v6.14.18-velvet | Feat: category folder pills — `[Live]`, `[Compilations]`, `Downloads uitzoeken`, etc. |
