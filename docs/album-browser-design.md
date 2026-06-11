# Music Library Analysis & Album Browser Design Document

> **Scope**: New "Album Library" view in the Velvet UI — a separate menu item
> that does NOT replace the existing file-browser or albums view. Built on top
> of the existing Velvet Node.js server, SQLite `files` table, and current
> API infrastructure.

---

## 1. Filesystem Analysis Results

### 1.1 Base Path

The Albums collection lives at `/media/music/Albums` (capital A), served as
the `Music` vpath, relative path prefix `Albums/`.

- **75 top-level entries** in `/media/music/Albums`
- **~2,980 tracks** scanned into the `files` table under `vpath = 'Music'`
  with `filepath LIKE 'Albums/%'`
- **~2,376 FLAC** + **~350 MP3** + **~250 WAV** files (maxdepth 5 scan)
- **295 metadata files** (.cue + .m3u + .nfo combined)

---

### 1.2 The Four Structural Patterns

After scanning the full directory tree, every entry in `/media/music/Albums`
falls into one of four patterns:

#### Pattern A — Direct Album (flat, 1 level)

The root entry _is_ the album. Audio files sit directly inside it.

```
Albums/
  Alexander Robotnick - The Disco Tech of/
    Alexander Robotnick - The Disco Tech of.flac   ← single full-mix file
  Betty Wright - Betty Wright Live (this is the night 8min)/
    01 Betty Wright - ...flac
    02 Betty Wright - ...flac
    Scans/
  Elysium Project - Regenerated - 2002/
    01 - Elysium Project - ...flac
  GAIA - Moons Of Jupiter - 2019 (320 kbps)/
    01 ...flac
  Koto - Return Of The Dragon/
    ...
  Shakedown - You Think You Know [2002]/
    ...
```

Naming convention in root: `Artist - Album (Year) [Format]`

#### Pattern B — Direct Album with Disc Sub-folders (2 levels)

The root entry is the album, but discs are split into sub-folders.

```
Albums/
  Art of Noise, The - And What Have You Done With My Body, God/
    CD1 - The Very Start of Noise/
      01 Art of Noise, The - Beat Box (One Made Earlier).wav
      02 Art of Noise, The - Once Upon a Lime.wav
      ...
    CD2 - Found Sounds & Field Trips/
    CD3 - Who's Affraid of... Goodbye/
    CD4 - Extended Play/

  Danny Howells - Choice - A Collection Of Classics (2006) [flac]/
    CD1/
      01 - ...flac
    CD2/

  Frankie Goes to Hollywood - Frankie Said (Japanese Release)/
    CD1/
    CD2/

  Get Down With The Philly Sound (2010) FLAC/
    Artwork/                  ← non-audio subfolder
    Disc 1 - The Originals/
      01. Harold Melvin & The Blue Notes - ...flac
    Disc 2 - The Reworks/
    Disc 3 - Japan Only Bonus CD/

  Happy Summer Party Mix (2CD) (1999)/
    CD1/
      Happy Summer Party Mix (CD1).wav   ← single WAV + CUE per disc
    CD2/
      Happy Summer Party Mix (CD2).wav

  Jean Michel Jarre - The Concerts in China (...) FLAC/
    Disc 1/
    Disc 2/

  Marillion - 1983 - Script for a Jester's Tear (2020 Deluxe Edition) [FLAC]/
    Disc 1/
    Disc 2/
    Disc 3/

  Mix 96  - 1996 - 2CD - FLAC - 20002 - MECADO/
    CD1/
    CD2/

  VA (2006) The TOMMY BOY Story, Vol. 01 [FLAC]/
    DISC 01/
      The Tommy Boy Story, Vol. 1.cue
    DISC 02/
```

#### Pattern C — Series Container → Individual Albums (3 levels)

The root entry groups a series. Each sub-folder is one album. Albums may
themselves be single-disc (files directly) or multi-disc (another disc level).

```
Albums/
  Bolero Mix 1 tm16 (Flac)/      ← series container
    1986 - Bolero Mix 1 (Flac)/  ← single-disc album
      01 ...flac
      covers/
    1992 - Bolero Mix 9 (Flac)/  ← multi-disc album inside series
      Cd 1/
        01 ...flac
      Cd 2/
      covers/
    1999 - Bolero Mix 16 (Flac)/
      Cd 1/
      Cd 2/
      Cd 3/
      Cd 4/

  Club Epic/
    Various Artists - Club Epic ... Volume 1 [1990] [FLAC] {EK 46087}/
      01 - The Isley Brothers - ...flac
    Various Artists - Club Epic ... Volume 2 [1992] [FLAC] {EK 52402}/

  Disconet/
    Disconet Greatest Hits vol.1 (Flac)/
      01 ...flac
    Disconet Greatest Hits vol.2 (Flac)/
    ...vol.27 (Flac)/

  Greg Wilson Edits/
    Greg Wilson - Credit To The Edit - Vol.1 [2005]/
      01. The Salsoul Orchestra - ...flac
    Vol.2 / Vol.3

  VA - Dance Classics - Pop Edition/
    2009 VA - Dance Classics - Pop Edition [RDM048]/
      CD1/
        Dance Classics - Pop Edition Disc 1.cue
        01 ...flac / or single flac+cue
      CD2/
        ...
    2010 VA - Dance Classics - Pop Edition Vol. 2 [RDM102]/
      CD1/ CD2/ CD3/
    ...Vol.3 through Vol.12

  VA - ID&T Classics/
    2008 - VA - ID&T Classics Part 1 [7011254] WEB/
      01 ...flac
    Part 2, Part 4–9

  VA - The Mood Mosaic Vol.1-19/
    VA - The Mood Mosaic 11. Feelin' Funky [2002] FLAC/
      01 ...flac
    VA - The Mood Mosaic 15 Supercool! (2017) [FLAC]/

  Hit Mix/                        ← series with multi-disc sub-albums
    Hit Mix '87/
      Various Artists - Hit Mix.flac   ← single FLAC full mix
      Сканы/
    Hit Mix '88/
      Hit Mix '88  CD - 1/             ← disc folders embedded in album name
        ...flac
      Hit Mix '88  CD - 2/
    ...Hit Mix '92 through '2008      (each with CD - 1 / CD - 2)
    Holiday Hit Mix '95/
      Holiday Hit Mix '95 CD - 1/
      Holiday Hit Mix '95 CD - 2/
    The Millenium Hitmix .../
      01/                              ← numeric disc folders
      02/

  Max Mix/
    1985 - Max Mix - CD 112/
      01 ...flac
      Covers/
    1985 - Max Mix 2 - CD 135/
    ...Max Mix 3 through 12
    Max Mix 40 Anniversary (2 Cd)(2025)(Wav)/
      Cd 1/
      Cd 2/
```

#### Pattern D — Artist Discography Container (3–4 levels)

The root entry is an artist, sub-folders organise by release type, inside are
individual releases.

```
Albums/
  Emma Hewitt/
    Albums/
      (2012) Emma Hewitt - Burn The Sky Down (Bonus Track Edition) .../
        01. Emma Hewitt - ...flac
      (2012) Emma Hewitt - Starting Fires (Acoustic EP) .../
    Singles & EPs/
      (2009) Dash Berlin feat. Emma Hewitt - Waiting .../
        01. Dash Berlin feat. Emma Hewitt - Waiting (Extended Mix).flac
      (2011) Cosmic Gate & Emma Hewitt - Be Your Sound .../
        01. Cosmic Gate & Emma Hewitt - Be Your Sound (Extended Mix).flac
      ...60+ single releases

  Sade (Japan Originals & Remasters)/
    01_Sade_Originals/
      Sade -1984- Diamond Life (Japan 1st press ...)/
        01 ...flac
        Covers/ Spectr/
      Sade -1985- Promise .../
      Sade -1988- Stronger Than Pride .../
      Sade -2010- Soldier Of Love (Sony Epic US)/
    02_Sade_Japan Remasters/
      Sade -1984- Diamond Life (MHCP 603)/
      Sade -1985- Promise (MHCP 604)/
      ...
    03_Sade_Singles/ 04_Side-projects/ 05_Bootlegs/ 06_5CD_EU_non-remasters_TRX/

  Propaganda - 2021 Digital EPs + Albums/
    01. Propaganda - (The Nine Lives Of) Dr. Mabuse (2021 Digital EP)/
    02. Propaganda - Dr. Mabuse (His Last Will And Testament) (2021 Digital EP)/
    ...16 sub-release folders
```

---

### 1.3 Disc Folder Naming Variants

All naming variants actually found on disk:

| Variant | Example folder | Albums using it |
|---|---|---|
| `CD1` / `CD2` | `Danny Howells - Choice/CD1` | Danny Howells, Frankie GFTH, Mix 96 |
| `CD1 - Label` | `Art of Noise/CD1 - The Very Start of Noise` | Art of Noise |
| `Cd 1` / `Cd 2` | `Bolero Mix 9/Cd 1` | Bolero Mix series |
| `Disc 1` / `Disc 2` | `Get Down With The Philly Sound/Disc 1 - The Originals` | JMJ China, Marillion, M&M Mixes |
| `DISC 01` / `DISC 02` | `VA Tommy Boy Story/DISC 01` | VA Tommy Boy Story |
| `CD - 1` / `CD - 2` | inside Hit Mix folder names | Hit Mix series (embedded in path) |
| `01` / `02` | `Millenium Hitmix/01` | Millenium Hitmix |

The regex to detect disc folders:
```js
/^(CD|Cd|Disc|DISC|cd|disc)\s*[-–]?\s*(\d+)/i
// or purely numeric:
/^\d{1,2}$/
```

---

### 1.4 Audio Content Types Found

| Type | Description | Example |
|---|---|---|
| **Multi-track FLAC** | Individual tracks, tagged | `Club Epic Vol.2/01 - The Isley Brothers - It's A Disco Night.flac` |
| **Multi-track WAV** | Individual tracks, often untagged | `TUTB3/01. Double Trouble & The Rebel MC - Just Keep Rockin.wav` |
| **Single-file FLAC** | Full album/mix as 1 file | `Hit Mix '87/Various Artists - Hit Mix.flac` |
| **Single-file WAV + CUE** | Full mix + chapter markers | `DJ Paul's Megamix (1995)/DJ Paul's Megamix.wav` + `.cue` |
| **Single FLAC + CUE** | Full mix in FLAC + CUE sheet | `VA Dance Classics Pop Edition Vol.9/CD1/....flac.cue` |

---

### 1.5 Album Art

Art is stored **alongside the audio files** in the album/disc folder, or in a
sibling subfolder (`Covers/`, `covers/`, `Scans/`, `scans/`, `artwork/`).
The per-disc art (`CD - 1.jpg`, `CD - 2.jpg`) is found in Sade/Hit Mix boxes.

**Most common filenames (ordered by frequency):**

| Filename | Count | Note |
|---|---|---|
| `cover.jpg` | 80 | Preferred — use as primary lookup |
| `front.jpg` | 57 | Front cover |
| `Folder.jpg` | 49 | Windows rip convention |
| `folder.jpg` | 39 | Lowercase variant |
| `back.jpg` / `Back.jpg` | 49+13 | Back cover — not needed for player |
| `CD.jpg` / `cd.jpg` | 22+17 | Disc label graphic |

**Art resolution order** for a given audio folder:
1. `cover.jpg` → `Cover.jpg`
2. `front.jpg` → `Front.jpg`
3. `Folder.jpg` → `folder.jpg`
4. Any `*.jpg` not containing "back", "Back", "CD", "cd", "inlay", "OBI"
5. Fall back to `/api/v1/files/art?fp=<vpath/subfolder/file>` (embedded tag)
6. No art → show placeholder

---

### 1.6 SQLite Data Quality for Albums

Key findings from querying `files` WHERE `filepath LIKE 'Albums/%'`:

- **2,980 rows total** in Albums
- **WAV files are mostly untagged** — `title`, `artist`, `album`, `disk`,
  `track` are all NULL (scanner reads tags that don't exist)
- **FLAC files** are well-tagged in most cases
- The `disk` column has values `null | 1 | 2 | 3` — populated only where
  the FLAC itself carries embedded disc number tags
- Many Albums-vpath albums won't appear in the existing `getAlbums()` query
  because `album IS NOT NULL` filters them out

**Consequence**: The existing `POST /api/v1/db/albums` API cannot be used as
the data source for the new Album Browser. It must be supplemented or replaced
with a filesystem-first scan.

---

## 2. Data Model

The Album Browser needs a **filesystem-derived** data model, not a pure
metadata model. The unit of identity is **folder path**, not album/artist tag.

### 2.1 Core Types

```js
// A "leaf" folder = a folder that directly contains audio files
// (the place you'd press play to hear music)
LeafFolder {
  path:      string,       // relative to /media/music, e.g. "Albums/Bolero Mix 1 tm16 (Flac)/1999 - Bolero Mix 16 (Flac)/Cd 1"
  label:     string,       // derived display label (see §2.3)
  discIndex: number|null,  // 1-based if this is a disc sub-folder, else null
  tracks:    Track[],
  artFile:   string|null,  // absolute fs path to best art image found
  hasCue:    boolean,      // true if a .cue file is present
  isSingleFile: boolean,   // true if only 1 audio file (full mix / single-file album)
}

Track {
  number:    number|null,  // parsed from filename or metadata
  title:     string,       // from metadata if available, else parsed from filename
  artist:    string|null,  // from metadata (may be null for WAV)
  file:      string,       // filename only, e.g. "01 - Respect (Club Vocal Remix).flac"
  streamUrl: string,       // Velvet stream URL for this file
  duration:  number|null,  // seconds, from DB if available
  aaFile:    string|null,  // cached art hash from files table
}

Album {
  id:          string,     // MD5 of the album's root path (stable identifier)
  path:        string,     // relative path from /media/music
  displayName: string,     // cleaned name for UI display (see §2.3)
  artist:      string|null,
  year:        string|null,
  artFile:     string|null,
  isMultiDisc: boolean,
  isSingleFile: boolean,   // entire album = 1 file (may or may not have CUE)
  hasCue:      boolean,
  discs:       LeafFolder[],  // length=1 for single-disc albums
  seriesPath:  string|null,   // relative path of the containing series folder
}

SeriesOrCollection {
  id:          string,
  path:        string,
  displayName: string,
  artFile:     string|null,
  albums:      Album[],
}
```

### 2.2 Concrete Examples

**Single-disc, multi-track FLAC:**
```json
{
  "id": "a1b2c3...",
  "path": "Albums/Elysium Project - Regenerated - 2002",
  "displayName": "Elysium Project - Regenerated",
  "artist": "Elysium Project",
  "year": "2002",
  "artFile": "/media/music/Albums/Elysium Project - Regenerated - 2002/cover.jpg",
  "isMultiDisc": false,
  "isSingleFile": false,
  "hasCue": false,
  "discs": [
    {
      "path": "Albums/Elysium Project - Regenerated - 2002",
      "label": "CD 1",
      "discIndex": 1,
      "hasCue": false,
      "isSingleFile": false,
      "tracks": [
        { "number": 1, "title": "...", "file": "01 - ...flac", "streamUrl": "..." }
      ]
    }
  ],
  "seriesPath": null
}
```

**Multi-disc album (4 CDs), single-file + CUE per disc:**
```json
{
  "id": "d4e5f6...",
  "path": "Albums/Art of Noise, The - And What Have You Done With My Body, God",
  "displayName": "Art of Noise — And What Have You Done With My Body, God",
  "artist": "Art of Noise, The",
  "year": null,
  "artFile": null,
  "isMultiDisc": true,
  "isSingleFile": false,
  "hasCue": false,
  "discs": [
    { "label": "CD 1 — The Very Start of Noise", "discIndex": 1, "hasCue": false, "isSingleFile": false, "tracks": [ ... ] },
    { "label": "CD 2 — Found Sounds & Field Trips", "discIndex": 2, ... },
    { "label": "CD 3 — Who's Affraid of... Goodbye", "discIndex": 3, ... },
    { "label": "CD 4 — Extended Play", "discIndex": 4, ... }
  ]
}
```

**Single-file WAV + CUE:**
```json
{
  "id": "e7f8g9...",
  "path": "Albums/DJ Paul's Megamix (1995)",
  "displayName": "DJ Paul's Megamix",
  "artist": "DJ Paul",
  "year": "1995",
  "isMultiDisc": false,
  "isSingleFile": true,
  "hasCue": true,
  "discs": [
    {
      "label": "CD 1",
      "discIndex": 1,
      "hasCue": true,
      "isSingleFile": true,
      "tracks": [
        { "number": 1, "title": "...", "file": "DJ Paul's Megamix.wav", "cueOffset": 0 },
        { "number": 2, "title": "...", "file": "DJ Paul's Megamix.wav", "cueOffset": 185.3 }
      ]
    }
  ]
}
```

**Album inside a series container:**
```json
{
  "id": "h1i2j3...",
  "path": "Albums/Bolero Mix 1 tm16 (Flac)/1999 - Bolero Mix 16 (Flac)",
  "displayName": "Bolero Mix 16",
  "artist": "Raul Orellana",
  "year": "1999",
  "isMultiDisc": true,
  "discs": [
    { "label": "Cd 1", "discIndex": 1, "tracks": [ ... ] },
    { "label": "Cd 2", "discIndex": 2, "tracks": [ ... ] },
    { "label": "Cd 3", "discIndex": 3, "tracks": [ ... ] },
    { "label": "Cd 4", "discIndex": 4, "tracks": [ ... ] }
  ],
  "seriesPath": "Albums/Bolero Mix 1 tm16 (Flac)"
}
```

### 2.3 Display Name Derivation

The raw folder names embed year, format, catalogue ID, and other noise. Strip
known suffixes before displaying:

```js
function cleanAlbumName(raw) {
  return raw
    // Remove leading year: "1986 - Bolero Mix 1 (Flac)" → "Bolero Mix 1 (Flac)"
    .replace(/^\d{4}\s*[-–]\s*/, '')
    // Remove format tags: (Flac), (flac), [FLAC], (320 kbps), (WAV) etc.
    .replace(/\s*[\[(](flac|wav|mp3|320\s*kbps|aac|ogg|web|cd-flac|hi-?res|24bit[^\])]*)[\])]/gi, '')
    // Remove catalogue IDs: {EK 46087}, [BCM 12211], [BBE 129CCD]
    .replace(/\s*[\[{][A-Z0-9 \-]+[\]}]/g, '')
    // Remove remaster/edition noise: "(2024 Remaster)", "(2020 Deluxe Edition)"
    .replace(/\s*\(\d{4}\s*(remaster|remastered|deluxe edition|anniversary|reissue)[^)]*\)/gi, '')
    // Trim
    .trim();
}
```

Year extraction:
```js
function extractYear(folderName) {
  // "1992 - Bolero Mix 9 (Flac)" → "1992"
  const leadYear = folderName.match(/^(\d{4})\s*[-–]/);
  if (leadYear) return leadYear[1];
  // "(1978)" or "[1978]" anywhere in name
  const embedded = folderName.match(/[\[(](\d{4})[\])]/);
  if (embedded) return embedded[1];
  return null;
}
```

---

## 3. New API Endpoint Design

### 3.1 `GET /api/v1/albums/browse`

Returns the full structured album tree for the Albums vpath. Auth required.

**Response:**
```json
{
  "albums": [ Album, ... ],
  "series": [ SeriesOrCollection, ... ]
}
```

**Server-side logic (pseudocode):**

```js
async function browseAlbums(rootPath) {
  const DISC_RE = /^(CD|Cd|Disc|DISC|cd|disc)\s*[-–]?\s*(\d+)/i;
  const NUMERIC_RE = /^\d{1,2}$/;
  const SCAN_RE = /^(covers|scans|artwork|spectr|tauanalyzer|сканы|jpg|scan)/i;
  const AUDIO_EXT = /\.(flac|mp3|wav|ogg|m4a|aiff)$/i;

  function isDiscFolder(name) {
    return DISC_RE.test(name) || NUMERIC_RE.test(name);
  }

  function isScanFolder(name) {
    return SCAN_RE.test(name);
  }

  function getArtFile(folderPath) {
    for (const name of ['cover.jpg','Cover.jpg','front.jpg','Front.jpg','Folder.jpg','folder.jpg']) {
      if (fs.existsSync(path.join(folderPath, name))) return path.join(folderPath, name);
    }
    // Any jpg not obviously a back/inlay
    const jpgs = fs.readdirSync(folderPath).filter(f => /\.jpe?g$/i.test(f)
      && !/back|Back|inlay|OBI|CD |cd |spectr/i.test(f));
    return jpgs.length ? path.join(folderPath, jpgs[0]) : null;
  }

  function buildLeafFolder(folderPath, discIndex) {
    const entries = fs.readdirSync(folderPath);
    const audioFiles = entries.filter(f => AUDIO_EXT.test(f)).sort();
    const cueFiles   = entries.filter(f => /\.cue$/i.test(f));
    const artFile    = getArtFile(folderPath); // check here AND parent

    const tracks = audioFiles.map(f => {
      const numMatch = f.match(/^(\d+)/);
      const num = numMatch ? parseInt(numMatch[1]) : null;
      // Strip number + separators + extension from title
      const title = f.replace(/^\d+\s*[-–.]\s*/, '').replace(/\.[^.]+$/, '');
      // Look up in SQLite files table for richer metadata
      const row = db.prepare('SELECT title, artist, duration, aaFile FROM files WHERE filepath = ?')
        .get(`Albums/${path.relative('/media/music/Albums', folderPath)}/${f}`);
      return {
        number: row ? row.track ?? num : num,
        title:  row?.title ?? title,
        artist: row?.artist ?? null,
        file:   f,
        streamUrl: `/api/v1/stream?filePath=${encodeURIComponent(`Music/${path.relative('/media/music', folderPath)}/${f}`)}`,
        duration: row?.duration ?? null,
        aaFile: row?.aaFile ?? null,
      };
    });

    return {
      path: path.relative('/media/music', folderPath),
      label: path.basename(folderPath),
      discIndex,
      tracks,
      artFile,
      hasCue: cueFiles.length > 0,
      isSingleFile: audioFiles.length === 1,
    };
  }

  function buildAlbum(folderPath, seriesPath) {
    const name = path.basename(folderPath);
    const children = fs.readdirSync(folderPath, { withFileTypes: true });
    const subDirs  = children.filter(d => d.isDirectory() && !isScanFolder(d.name));
    const audioFiles = children.filter(f => f.isFile() && AUDIO_EXT.test(f.name));

    let discs = [];

    if (audioFiles.length > 0) {
      // Audio directly in this folder → single-disc leaf
      discs.push(buildLeafFolder(folderPath, 1));
    }

    // Also check sub-folders
    for (const sub of subDirs) {
      const subPath = path.join(folderPath, sub.name);
      if (isDiscFolder(sub.name)) {
        const discNum = extractDiscNumber(sub.name);
        discs.push(buildLeafFolder(subPath, discNum));
      }
    }

    // Sort discs by discIndex
    discs.sort((a, b) => (a.discIndex ?? 0) - (b.discIndex ?? 0));

    // Determine art: check album folder, then first disc folder
    const artFile = getArtFile(folderPath)
      ?? (discs[0] ? discs[0].artFile : null);

    return {
      id: md5(folderPath),
      path: path.relative('/media/music', folderPath),
      displayName: cleanAlbumName(name),
      artist: extractArtist(name),
      year: extractYear(name),
      artFile,
      isMultiDisc: discs.length > 1,
      isSingleFile: discs.length === 1 && discs[0].isSingleFile,
      hasCue: discs.some(d => d.hasCue),
      discs,
      seriesPath: seriesPath ? path.relative('/media/music', seriesPath) : null,
    };
  }
  // ... top-level dispatch: for each entry in /media/music/Albums,
  // detect pattern A/B/C/D and recurse appropriately
}
```

### 3.2 Reused Existing Endpoints

| Endpoint | Purpose in Album Browser |
|---|---|
| `GET /api/v1/stream?filePath=Music/Albums/...` | Stream audio file |
| `GET /api/v1/files/art?fp=Music/Albums/.../file.flac` | On-demand embedded art extraction |
| `GET /api/v1/db/albums` (existing) | NOT used — see §1.6 |
| `POST /api/v1/db/album-songs` (existing) | NOT used for Albums-vpath |
| Auth cookie / JWT | Standard authentication, unchanged |

### 3.3 Optional: `GET /api/v1/albums/art?path=<rel>`

Thin wrapper that resolves filesystem art for a given folder path (avoids
exposing absolute paths to the client). Returns `{ url: "/..." }`.

---

## 4. UI/UX Design Specification

### 4.1 Navigation

New sidebar item: **"Album Library"** (icon: grid/album cover), separate
from the existing Albums entry under the file browser. Sits alongside
Home, File Explorer, Playlists, etc.

URL/state: `view = 'album-library'`

### 4.2 Album Grid View (default)

- **Grid layout**: Cover art + album name + year line, ~180×180px cards
- Series/collection entries show as a "folder card" with stacked-cover
  visual (e.g. 2–4 cover thumbnails in a grid)
- Badge on cards:
  - 2-disc icon for multi-disc albums
  - "CUE" badge if content is a single-file + cue-sheet album
  - "WAV" badge if content is untagged WAV
- Filter/search bar at the top: filters by `displayName` and `artist`
  (client-side, no round-trip needed once loaded)

### 4.3 Series/Collection Drill-Down

Clicking a series card (e.g. "Bolero Mix", "Hit Mix", "Dance Classics - Pop
Edition") opens a **Series View**:
- Header: series name + cover art
- Sub-grid of individual album cards within that series
- Back button → returns to Album Grid

### 4.4 Album Detail View

Clicking an album card opens the **Album Detail View**:

```
┌─────────────────────────────────────────────────────┐
│  [Cover Art 200×200]  Artist - Album Title          │
│                       Year · N tracks · Format      │
│                       [▶ Play All] [+ Add to Queue] │
├─────────────────────────────────────────────────────┤
│  [CD 1] [CD 2] [CD 3] [CD 4]   ← disc tabs         │
│  ─────────────────────────────                      │
│  ① Track Title                         3:42  [▶]   │
│  ② Track Title                         4:15  [▶]   │
│  ...                                                │
└─────────────────────────────────────────────────────┘
```

- **Disc tabs**: shown only if `isMultiDisc === true`
- Tab label comes from `LeafFolder.label`, which preserves the descriptive
  disc name if present (e.g. "CD 1 — The Very Start of Noise")
- **Single-file + CUE albums**: track list shows CUE chapters with their
  offsets. Play button seekes the single audio file to `cueOffset`. If no
  CUE chapters are parsed, shows a single "Play" button for the whole file.
- **WAV untagged tracks**: display filename-derived title (number stripped).
  No metadata enrichment attempted unless DB has a row.
- **Play All Disc**: loads all tracks of the active disc tab into the queue
  in order, replacing current queue (with confirmation if queue non-empty)
- **Play All Album**: loads all discs sequentially into the queue
- **Add to Queue**: appends without replacing

### 4.5 Player Integration

The Album Browser uses the **existing Velvet player** — it calls the same
`addToQueue()` and `openPlaylist()` functions that the rest of the app uses.
No new player component.

For CUE-sheet single-file albums: playback is seek-based using the existing
`audio.currentTime` mechanism. The track list in the queue panel shows the
chapter title with the seek offset stored as metadata.

### 4.6 State Preservation

- The selected disc tab is remembered while navigating within the same
  album detail view session
- Return from detail → grid restores scroll position (CSS `scroll-behavior: smooth`, JS `scrollTop` save/restore)
- The current view path (`album-library`, `album-library/series/...`,
  `album-library/album/...`) is reflected in the browser URL hash so
  back/forward navigation works

---

## 5. Implementation Plan

### Phase 1 — Server: New browse endpoint

**File**: `src/api/albums-browse.js` (new file)

1. Implement `buildAlbumTree(albumsRootPath)` — recursive directory walker
   that applies the 4 structural patterns
2. Detect disc folders using the regex variants found on disk
3. Skip known non-audio sub-folders: `covers`, `scans`, `artwork`, `Spectr`,
   `TauAnalyzer`, `Сканы`, `jpg`, `Assets`
4. Enrich with SQLite data using a single bulk query:
   `SELECT filepath, title, artist, track, disk, duration, aaFile FROM files WHERE filepath LIKE 'Albums/%'`
   → build a `Map<filepath, row>` for O(1) lookup
5. Art resolution per folder
6. Return `{ albums, series }` — cache result for 5 minutes (simple
   `lastBuilt` timestamp + stored result, invalidated on file-scan complete
   event)
7. Register: `velvet.get('/api/v1/albums/browse', handler)` in `src/api/`
   and include in `src/server.js`

**Estimated row counts after the endpoint is live:**
- ~65 direct albums (patterns A+B)
- ~10 series containers (pattern C: Bolero Mix, Club Epic, Disconet,
  Dance Classics, ID&T Classics, Hit Mix, Max Mix, M&M Mixes, Mood Mosaic,
  Turn Up The Bass, Soviett, Boot Mixes, etc.)
- ~2 artist discography containers (pattern D: Emma Hewitt, Sade, Propaganda)

### Phase 2 — Client: Album Grid + Series Drill-Down

**File**: `webapp/app.js` additions only (no new files)

1. New `view = 'album-library'` handler in the existing view router
2. `renderAlbumLibrary()` — fetch from `/api/v1/albums/browse`, build grid
3. `renderSeriesView(seriesId)` — sub-grid for a series
4. `renderAlbumDetail(albumId)` — detail view with disc tabs
5. Art serving: use `/api/v1/files/art?fp=…` endpoint for embedded art
   fallback; for filesystem art, use a thin new endpoint
   `GET /api/v1/albums/art-file?p=<relative-path>` that streams the image
   directly (auth-gated)

**CSS**: re-use existing `.card`, `.grid-view`, `.modal-box`, etc. from
`style.css`. Add `.album-grid`, `.disc-tab`, `.track-row` in a new
`<style>` block or appended to `style.css`.

### Phase 3 — CUE Sheet Support

Parse `.cue` files server-side when building the album tree:
```
TRACK 01 AUDIO
  TITLE "Bob Marley vs Funkstar De Luxe - Sun Is Shining"
  INDEX 01 00:00:00
TRACK 02 AUDIO
  TITLE "..."
  INDEX 01 04:23:15   ← MM:SS:FF (frames, 75fps)
```
Convert `MM:SS:FF` → seconds: `minutes*60 + seconds + frames/75`.
Return chapter list as `tracks` with `cueOffset` instead of separate files.

---

## 6. Edge Cases & Decisions

| Situation | Decision |
|---|---|
| Missing cover art | Show generic album placeholder SVG (dark grey with music note). Do NOT auto-fetch from Discogs — too noisy for compilation albums. Optional: add a per-album "fetch art" button that calls the existing Discogs endpoint. |
| WAV files with null metadata | Use filename parsing for track number and title display. Do not show null artist. |
| Single-file FLAC/WAV without CUE | Show as "Play" button only — no track list breakdown. Display a single row labeled "Full Mix". |
| Sub-folders that are not disc folders and not scan folders | Treat as an ambiguous sub-album. Log a warning, show it as a child album entry (Pattern D resolution). |
| Very long series (Disconet vol.1–27, ID&T Parts 1–9, Dance Classics Vol.1–12) | Paginate within the series view at 20 albums per page, or lazy-render with IntersectionObserver. |
| Album in both single-file and multi-track versions (e.g. Bolero Mix with duplicate WAV + FLAC copies) | The tree walker will return both as separate Disc entries if they're in different sub-folders. Show both. Do not attempt deduplication. |
| Scan/artwork sub-folders (Covers/, Scans/, Spectr/, Сканы/) | Always skip — never descend into these. |
| Zip files (one `.zip` was found: `Dance Smash 25 jaar.zip`) | Skip silently — not audio, not a folder. |
| Emma Hewitt Singles & EPs (60+ folders) | Series drill-down with type grouping: show "Albums" and "Singles & EPs" as sub-categories within the artist view. |
| Sade deep nesting (4 levels: artist → category → album → Covers/) | The walker detects Category folders `01_Sade_Originals`, `02_Sade_Japan Remasters` etc. as non-disc, non-audio containers and recurses into them as series. |

---

## 7. What the Existing Albums View Cannot Do (and Why)

This section explains why a new endpoint/view is needed rather than fixing
the existing one.

| Current behaviour | Root cause | New approach |
|---|---|---|
| WAV albums invisible (album = null) | `getAlbums()` filters `WHERE album IS NOT NULL` | Filesystem-first: folder path as identity |
| Disc tabs absent | `getAlbumSongs()` returns flat list, UI ignores `disk` column | LeafFolder model built from disc sub-folders |
| Series show as separate unlabelled albums | No concept of parent series folder | Series container detection |
| Art missing for many Albums entries | Scanner reads embedded tags; WAV files have no tags | Filesystem art resolution (cover.jpg etc.) |
| CUE sheet albums show 0 tracks | Scanner does not parse `.cue` files for track listing | CUE parser in browse endpoint |
