# Album Library

*Introduced in v6.1.0-velvet. Category folder pills added v6.14.18-velvet.*

The Album Library is a dedicated, full-featured view for browsing, navigating, and playing your music collection organised as albums. It is a **DB-driven, performant browser** that automatically groups albums into series, handles multi-disc albums, resolves cover art from disk or embedded tags, detects single-file CUE-sheet albums, and shows edition/version badges.

---

## Quick start

1. **Create your folder structure** (see [Folder layout](#folder-layout) below).
2. **Mark the folder as Albums Only** — Admin → Directories → click **Albums Only: Off** on the folder card so it reads **Albums Only: On**. See [albums-only.md](albums-only.md).
3. **Run a scan** — Admin → Database → **Start A Scan** (or wait for the scheduled scan).
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
| `Cerrone Discography/Downloads uitzoeken/Some Mix.flac` | Album under category `Downloads uitzoeken` (only when that name is in the category list) |
| `Hit Mix/Hit Mix '88 CD - 1/01 Track.flac` | Disc suffix pattern — treated as a disc of `Hit Mix`, not a sub-album |

---

## Album vs Series vs Disc detection

The tree is built from the file paths in the database, working **bottom-up** from each file (`src/api/albums-browse.js`, disc rule in `src/util/album-dir.js`):

| Condition | Result |
|---|---|
| The file's folder matches the disc pattern | The **album** is the folder above it; the disc folder becomes a disc tab |
| Otherwise | The **album** is the file's own folder |
| Files sitting directly in the albumsOnly root | Ignored (no album folder) |

The folder above the album is its **artist folder** (category folders are skipped, see below). When an artist folder holds **two or more** albums they are grouped into a **series** card; an artist folder with a single album, or an album directly under the root, is shown as a **standalone album** card.

Inside one album folder, if there are two or more files and every one carries its own CUE data, each file becomes its own disc.

### Disc folder patterns

A folder is treated as a *disc* (not a separate album) when its name matches any of these (case-insensitive):

| Pattern | Matches | Does not match |
|---|---|---|
| Starts with `CD` or `Disc` + optional dash + digit | `CD 1`, `Disc 2`, `CD-3`, `disc1` | `Disconet`, `2CD` |
| Ends with `CD` / `Disc` + optional dash + number | `Hit Mix '88 CD - 1`, `Album Disc 2` | `CD Edition`, `2xCD` |
| Bare one or two digit number | `1`, `2`, `12` | `12 Hits` |

The same disc rule is used by the Subsonic album id, the Tag Workshop grouping and ReplayGain album gain.

---

## Category folders

*Added in v6.14.18-velvet.*

Sometimes an artist or series folder contains sub-folders that are **not** albums or discs, but **categories** — e.g. `[Live]`, `[Compilations]`, `Downloads uitzoeken`. Without special handling these look like artist folders of their own and pollute the artist grouping.

**Category folders are transparent containers.** When a folder name in the album's artist path matches the configured list (`albumCategoryFolders` in the config):
- It is stripped from the album's artist path (so the album groups under the real artist, not under `[Live]`)
- Its name is stored as a `categoryLabel` on the album
- The album card shows a small category badge, and the series/artist view shows **category pills**

### Category pill UI

In the **Album Series** view and the **Artist profile → Albums** tab, a pill row appears above the grid when at least one album has a category label:

```
[ Albums (12) ]  [ Live (3) ]  [ Compilations (2) ]  [ Downloads uitzoeken (1) ]
```

**Albums** shows the albums without a category; each other pill shows only the albums of that category. Brackets are dropped from the pill label.

### Configuring category folders

Go to **Admin → Artist Albums** (Config section of the admin menu); the **Album Category Folders** card is at the top.

- The list shows the current category names as chips.
- Type a name and click **Add** (or press Enter) — it is saved straight away.
- Click the ✕ on a chip to remove it — also saved straight away.
- **Save** stores the list as shown.
- Changes take effect immediately — no rescan needed.

**Default list.** Until the list has been saved once, the server uses **no** category folders. The admin card pre-fills a suggested list (English bracketed and plain names such as `[Live]`, `Live`, `[Compilations]`, `Singles`, `B-Sides`, plus Dutch, German, French, Italian and Spanish variants such as `Compilaties`, `Kompilationen`, `Raretés`, `Raccolte`, `Recopilaciones`); it becomes active when you add, remove or save.

Add any folder name that appears in your own collection (max 50 names, 120 characters each). The match is case-sensitive and exact.

---

## Single-file albums with CUE sheets

The Album Library fully supports **single-file rips** (one FLAC or WAV file per album) accompanied by a CUE sheet. The CUE sheet is used to split playback into individual tracks with correct titles and times.

### CUE detection order

During the scan (`src/db/scanner.mjs`):

1. **Embedded CUE sheet** — stored inside the file (e.g. a FLAC `CUESHEET` block). Detected automatically — no extra file needed.
2. **Sidecar `{filename}.cue`** — double-extension variant, e.g. `Sade - Promise.flac.cue`. Checked first among the sidecars.
3. **Sidecar `{basename}.cue`** — e.g. `Sade - Promise.cue` next to `Sade - Promise.flac`.
4. **Sole `.cue` in the folder** — if the folder contains exactly one `.cue` file.
5. **M4B chapters** — for `.m4b` files with no CUE data, chapters are read with ffprobe.

A sidecar is only used when it has exactly one `FILE` line and that line matches the audio file by base name (the extension is ignored, so `FILE "Sade - Promise.wav"` is accepted for `Sade - Promise.flac`). At least two tracks are needed.

When an album is opened, single-file discs without CUE data are checked again for a sidecar `.cue` on disk, so a fixed CUE file shows up without a rescan. A `.cue` that exists but does not match is shown with a "CUE file invalid" badge.

> **Note:** EAC always writes `FILE "album.wav" WAVE` in the CUE, even when ripping to FLAC. Velvet accepts this — it compares base names only, ignoring the extension.

### What you see in the UI

When a single-file album is detected as having CUE points:
- The album detail view shows a CUE badge and individual track rows with track numbers, titles, and durations derived from the CUE offsets.
- Clicking a track starts playback from that position.
- The progress bar shows the position within the full file, with tick marks at the track boundaries.
- **+ Add to Queue** and the per-track **⋯** menu work as for normal albums.

---

## Album version badges

*Introduced in v6.14.x-velvet.*

When an album folder contains version or edition information, Velvet extracts it and shows it as a small badge on the album card (e.g. `Remaster`, `Deluxe`, `Japan Press`).

### Where version info comes from

The scanner only does this for files inside an albumsOnly folder. The first match wins:

1. **Tag fields** — a configurable list of tag fields (`albumVersionTags` in the config):
   - Default fields: `TIT3`, `SUBTITLE`, `DISCSUBTITLE`, `TXXX:EDITION`, `TXXX:VERSION`, `TXXX:ALBUMVERSION`, `TXXX:QUALITY`, `TXXX:REMASTER`, `TXXX:DESCRIPTION`, `EDITION`, `VERSION`, `ALBUMVERSION`, `QUALITY`, `REMASTER`. `COMMENT` is not in the default list (too noisy) but can be added.
2. **Album title heuristics** — edition keywords in the `album` tag.
3. **Folder name heuristics** — the same keywords in the album's folder name.
4. **Audio properties** — 24-bit files at 88.2 kHz or higher get `Hi-Res <bits>bit/<kHz>kHz`.

When any album has a version, the Album Library shows version filter pills above the grid.

### Configuring version tag fields

Go to **Admin → Database** → **Album Version Tag Fields** card. Add any tag field name your ripping software writes (max 20 fields). Click **Save**; the new fields are used in the next scan.

---

## Cover art resolution

For every album the player shows the first art it finds in this order:

1. **Art from the DB** (`aaFile`) — the image the scanner stored in the image cache (`image-cache/` by default) for one of the album's tracks. This can be embedded art or a folder image the scanner picked up.
2. **Folder image recorded by the scanner** (`cover_file`) — served from disk via `/api/v1/albums/art-file`.
3. **Folder image found when browsing** — only for albums with neither of the above, the album folder is checked for these names, in order:
   ```
   cover.jpg  Cover.jpg  cover.jpeg  Cover.jpeg
   front.jpg  Front.jpg  front.jpeg  Front.jpeg
   frente.jpg Frente.jpg frente.jpeg Frente.jpeg
   Folder.jpg folder.jpg Folder.jpeg folder.jpeg
   cover.png  Cover.png  front.png   Front.png  frente.png  Frente.png
   cover.webp Cover.webp frente.webp Frente.webp
   ```
   then the first disc sub-folder, for multi-disc albums that store art per disc.

If none found, a placeholder icon is shown. A series card uses the art of its first album that has any.

### Adding cover art manually

Drop a supported filename into the album folder. The browse cache lives for **5 minutes**, so the art appears on a browse after that. If the album already has DB art, that art keeps priority. Admins can also pick a cover from the album detail view (art edit overlay); it is written as `cover.jpg` in the album folder and the cache is cleared at once.

```
/media/music/Albums/Sade/Diamond Life (1984)/cover.jpg
```

---

## Browsing the Album Library

### Main grid

Open **Albums** in the left nav. The main grid shows:
- **Series cards** — a representative cover + series name + number of albums.
- **Standalone album cards** — cover + album title + year, with version and category badges and a disc count for multi-disc albums.

Use the **filter box** above the grid to filter as you type: series by name, albums by title, artist or category. The sort button switches between name (A–Z, Z–A) and year (newest, oldest); the density buttons switch between comfy, compact and list. Sort and density are remembered per user in this browser. With two or more albumsOnly sources a pill per source appears; with album versions present, version pills appear.

### Series view

Click a series card to see all albums in the series. Each album card shows:
- Cover art
- Album title
- Year (if available)
- Edition/version badge (if detected)
- **Category pills** — if the series contains categorised albums, a pill row appears at the top. Click a pill to filter.

### Album detail view

Click an album card to open the full detail (loaded from `/api/v1/albums/detail`):
- **Disc tabs** — for multi-disc albums, one tab per disc. Click to switch; the **+** on a tab appends that disc to the queue.
- **Track list** — track number, title, track artist (when it differs from the album artist), duration, and a **⋯** menu per track. Drag-to-reorder is not available here; use the queue panel.
- **CUE tracks** — for single-file CUE albums, individual tracks are listed with their durations from the CUE offsets.
- **▶ Play** — replaces the queue with the current disc and plays it from the first track.
- **+ Add to Queue** / **+ Add to Playlist** — the current disc.
- **Clicking a track row** depends on the **Full disc** toggle next to the hint above the track list: on, it replaces the queue with the disc and plays from that track; off, it only adds that track to the queue. The choice is remembered per user in this browser.

### Restore previous queue

Playing an album (or a single song) replaces the queue. If that was a mistake, the **Up Next** bar of the queue panel shows an accent-coloured **Restore previous queue** button (curved-arrow icon; hover to see how many songs it holds). It puts the old queue back and continues the song that was playing, from where it was; a song that was paused comes back paused. Then click the track again with the album click mode set to *single track* if you only wanted that one song.

- Clicking another track in the same album keeps the original queue as the one to restore, so it is never overwritten by the album itself.
- **Clear queue** (the bin) can be undone the same way. One click empties the whole queue and stops playback; in a room the playing song stays, because the room's queue is shared.
- The previous queue is kept in memory only (a page reload drops it), and the button disappears once it has been used.

---

## Admin tools

### Admin → Artist Albums

| Panel | Purpose |
|---|---|
| **Album Category Folders** | Configure folder names that are treated as category containers |
| **Artist Albums Diagnostic** | Inspect how a specific artist's albums are structured in the DB |

### Admin → Database

| Panel | Purpose |
|---|---|
| **Album Version Tag Fields** | Configure which tag fields the scanner reads for edition/version info |

### Admin → Directories

| Setting | Effect |
|---|---|
| **Albums Only: On/Off** button | Marks the folder as an Album Library source. All its contents appear in the Album Library. |
| Multiple folders can be Albums Only | All are merged into one Album Library. |

---

## Folder structure requirements

Enable **Albums Only** on a folder via Admin → Directories → **Albums Only: Off/On** button on the folder card.

- Any folder except `recordings`, `youtube` and `excluded` folders can be marked `albumsOnly: true`.
- **Multiple** folders can be Albums Only simultaneously — all are merged into one Album Library.
- A folder can be a **root vpath** (its own DB entry) or a **child vpath** (a sub-folder of another vpath). Child vpath files are already stored in the DB under the parent root — they are never indexed separately.
- If no folder has `albumsOnly` set, the system falls back to the first root vpath that has an `Albums/` sub-directory on disk (legacy fallback for older configurations).
- The `albumsOnly` flag takes effect immediately — no server restart or rescan required.
- Users only see albums from sources whose vpath is in their own vpath list.

---

## Caching

| Scenario | Behaviour |
|---|---|
| First load | DB read + in-memory tree build + parallel art checks on disk |
| Subsequent loads | served from a 5-minute in-memory cache, no DB or filesystem access |
| After a new scan | new files show up once the 5-minute cache expires |
| After adding a cover image | art appears within 5 minutes (cache TTL) |
| After changing `albumCategoryFolders`, an `albumsOnly` flag, or setting a cover from the player | cache is cleared at once |

---

## API

| Endpoint | Description |
|---|---|
| `GET /api/v1/albums/browse` | Returns the album tree `{ albums, series }` (slim: no track lists) |
| `GET /api/v1/albums/detail?id=<albumId>` | Returns one album with its discs and tracks |
| `GET /api/v1/albums/art-file?p=<path>` | Serves an on-disk art file by its relative path |
| `POST /api/v1/albums/set-art` | Admin only: downloads a cover (`releaseId` from Discogs or `coverUrl`) and writes it as `cover.jpg` in the album folder |

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
