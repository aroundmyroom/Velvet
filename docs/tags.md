# Velvet — Tag System & Album Version Detection

This document covers everything about how Velvet reads, stores, and presents **album edition / version** metadata — from the raw ID3 specification through the scanner pipeline, the admin configuration panel, and the user-facing UI in the Album Library and Search.

---

## Table of Contents

1. [Background — The Tag Diversity Problem](#background)
2. [ID3 Tag Specification — The Relevant Frames](#id3-spec)
3. [Equivalent Tags in Other Formats](#other-formats)
4. [How Velvet Reads Version Tags — the Scanner Pipeline](#scanner-pipeline)
5. [Configurable Tag Field Priority](#configurable-priority)
6. [Heuristic Fallback — When No Tag Exists](#heuristic)
7. [Database Storage](#database)
8. [Admin UI — Album Version Tag Fields](#admin-ui)
9. [Admin API Endpoints](#admin-api)
10. [Album Library — Version Badges & Filter Pills](#album-library)
11. [Search — Version Badges in Results](#search)
12. [Setting Tags in Your Tagger](#tagging-guide)

---

## 1. Background — The Tag Diversity Problem {#background}

Users with well-organised libraries often own multiple editions of the same album — an original 1980 pressing, a 1996 remaster, and a 2024 hi-res SACD transfer. In the database all three have `album = "Rumours"` and potentially `year = 1977`. Without an additional distinguishing field the player can only show three identical cards.

The complication: **there is no single universally adopted tag for album edition information**. Different rippers, taggers, and workflows store this information in wildly different places. A hardcoded check of three fields would silently miss most real-world libraries. Velvet solves this with a fully configurable, priority-ordered field list combined with an intelligent heuristic fallback.

---

## 2. ID3 Tag Specification — The Relevant Frames {#id3-spec}

ID3v2 is the metadata standard embedded in MP3, AIFF, and WAV files. Every piece of metadata is a **frame** identified by a 4-character code.

### Standard frames used for version/edition

| Frame ID | Name | Meaning | Typical use |
|----------|------|---------|-------------|
| `TIT3`   | Subtitle / content description | A subtitle or secondary title for the track or album | Default output of dBpoweramp, EAC |
| `TSST`   | Set subtitle | Subtitle for the whole disc set | Rare; some compilation taggers |
| `TDES`   | Podcast description | Free text description | Not relevant for music |
| `COMM`   | Comment | Free-form text comment | iTunes, foobar2000 — lowest priority |

### TXXX — User-defined text frames

Because no fixed frame can cover every possible metadata need, ID3v2 provides `TXXX` — a **user-defined text frame**. Every `TXXX` frame has two parts: a *description* (the key you choose) and a *text* (the value). Multiple `TXXX` frames can exist in the same file as long as each has a unique description.

```
Frame ID:    TXXX
Description: EDITION          ← you choose this name
Text:        Deluxe Edition   ← the actual value
```

In Velvet's config and throughout this document, TXXX frames are written as `TXXX:DESCRIPTION` — for example `TXXX:EDITION`, `TXXX:VERSION`, `TXXX:QUALITY`.

Common `TXXX` descriptions used for album version information:

| Config entry | Description field | Example value |
|---|---|---|
| `TXXX:EDITION` | `EDITION` | `Deluxe Edition` |
| `TXXX:VERSION` | `VERSION` | `2016 Remaster` |
| `TXXX:ALBUMVERSION` | `ALBUMVERSION` | `Expanded Edition` |
| `TXXX:QUALITY` | `QUALITY` | `24bit/96kHz` |
| `TXXX:REMASTER` | `REMASTER` | `2003 Remaster` |
| `TXXX:DESCRIPTION` | `DESCRIPTION` | Various |
| `TXXX:RELEASETYPE` | `RELEASETYPE` | `Album`, `Compilation` |

### ID3v2 frame encoding notes

- All text frames can be encoded as Latin-1, UTF-16 (with BOM), or UTF-8 (ID3v2.4).
- `TXXX` is an `ID3v2` `T` frame (text frame) — it can appear multiple times with different descriptions.
- Velvet uses the `music-metadata` library to parse ID3 tags; it handles all encoding variants transparently.

---

## 3. Equivalent Tags in Other Formats {#other-formats}

### Vorbis Comments (FLAC, OGG, Opus)

Vorbis comments are free-form `KEY=value` pairs. There is no strict standard for the keys, but community convention has converged on:

| Vorbis key | ID3 equivalent | Used by |
|---|---|---|
| `SUBTITLE` | `TIT3` | Direct cross-format equivalent |
| `DISCSUBTITLE` | `TSST` | MusicBrainz Picard standard output |
| `EDITION` | `TXXX:EDITION` | Beets, custom workflows |
| `VERSION` | `TXXX:VERSION` | MusicBrainz Picard scripts |
| `ALBUMVERSION` | `TXXX:ALBUMVERSION` | Variant spelling |
| `QUALITY` | `TXXX:QUALITY` | Custom home workflows |
| `REMASTER` | `TXXX:REMASTER` | Custom home workflows |
| `COMMENT` | `COMM` | General comment |

When you configure `TXXX:EDITION` in Velvet's tag field list, the scanner automatically looks for the Vorbis key `EDITION` in FLAC/OGG/Opus files — the `TXXX:` prefix is stripped and the bare key name is used for Vorbis lookups.

### iTunes / MP4 / M4A — Custom Atoms

iTunes uses **freeform atoms** with the structure `----:com.apple.iTunes:FIELDNAME`. These behave identically to Vorbis comments for custom data.

| iTunes atom | Meaning |
|---|---|
| `----:com.apple.iTunes:EDITION` | Album edition |
| `----:com.apple.iTunes:VERSION` | Version string |
| `----:com.apple.iTunes:QUALITY` | Audio quality |

### APE Tags (WavPack, Monkey's Audio)

APE tags are simple `Key=Value` text pairs, case-insensitive. Common keys: `Edition`, `Version`, `SubTitle`, `Comment`.

### Format mapping summary

| Config entry | MP3 (ID3) | FLAC/OGG/Opus (Vorbis) | M4A (iTunes) | WavPack/APE |
|---|---|---|---|---|
| `TIT3` | `TIT3` frame | `SUBTITLE` key | `©des` description | `SubTitle` |
| `SUBTITLE` | `TIT3` frame | `SUBTITLE` key | — | — |
| `DISCSUBTITLE` | `TSST` frame | `DISCSUBTITLE` key | — | — |
| `TXXX:EDITION` | `TXXX` desc=`EDITION` | `EDITION` key | `----:com.apple.iTunes:EDITION` | `Edition` |
| `TXXX:VERSION` | `TXXX` desc=`VERSION` | `VERSION` key | `----:com.apple.iTunes:VERSION` | `Version` |
| `EDITION` | `TXXX` desc=`EDITION` (fallback) | `EDITION` key | same | same |

---

## 4. How Velvet Reads Version Tags — the Scanner Pipeline {#scanner-pipeline}

The album version detection pipeline runs inside the file scanner (`src/db/scanner.mjs`) for every audio file. It has four stages:

### Stage 1 — Build native tag map (`buildNativeMap`)

After `music-metadata` parses the file, its `parsed.native` object is flattened into a clean lookup structure:

```js
{
  txxx:       { "EDITION": "Deluxe Edition", "VERSION": "2016 Remaster", … },
  vorbis:     { "SUBTITLE": "Remaster", … },
  ape:        { "EDITION": "Box Set", … },
  itunesCustom: { "EDITION": "Expanded Edition", … }
}
```

This is built once per file and avoids repeated iteration of the raw tag arrays.

### Stage 2 — Resolve a single configured field (`resolveTagField`)

Given one field name from the configured list (e.g. `"TXXX:EDITION"`), the resolver checks each tag format in order:

1. **TXXX prefix** — looks up `nativeMap.txxx["EDITION"]`
2. **Common alias** — for standard cross-format fields (`TIT3`, `SUBTITLE`, `DISCSUBTITLE`, `COMMENT`) uses `music-metadata`'s normalised `common.*` properties
3. **Raw native key** — checks `nativeMap.vorbis`, `nativeMap.ape`, and `nativeMap.itunesCustom` for the bare key name

### Stage 3 — Walk the priority list (`deriveAlbumVersion`)

The main orchestrator walks the admin-configured field list (or the built-in default) and returns the first non-empty value found:

```
TIT3 → SUBTITLE → DISCSUBTITLE → TXXX:EDITION → TXXX:VERSION → …
```

If the priority list is exhausted with no match, it falls through to the heuristic.

### Stage 4 — Heuristic fallback (`parseVersionHeuristic`)

Runs when no configured tag field produced a value. See [Section 6](#heuristic) for full details.

The source of each detected value is stored alongside the value itself (see [Section 7](#database)):

| Source string | Meaning |
|---|---|
| `TIT3` | Matched the `TIT3` configured field |
| `TXXX:EDITION` | Matched a TXXX user-defined frame |
| `EDITION` | Matched a bare Vorbis/APE key |
| `heuristic:title` | Inferred from the album title string |
| `heuristic:folder` | Inferred from the folder name |
| `inferred:audio` | Derived from audio properties (bit depth / sample rate) |

---

## 5. Configurable Tag Field Priority {#configurable-priority}

The tag field list is stored in `save/conf/default.json` under the key `albumVersionTags`:

```json
{
  "albumVersionTags": [
    "TIT3",
    "SUBTITLE",
    "DISCSUBTITLE",
    "TXXX:EDITION",
    "TXXX:VERSION",
    "TXXX:ALBUMVERSION",
    "TXXX:QUALITY",
    "TXXX:REMASTER",
    "TXXX:DESCRIPTION",
    "EDITION",
    "VERSION",
    "ALBUMVERSION",
    "QUALITY",
    "REMASTER"
  ]
}
```

**Default priority rationale:**

1. `TIT3` / `SUBTITLE` — Most widely written by rippers (dBpoweramp, EAC, XLD)
2. `DISCSUBTITLE` — Standard MusicBrainz Picard output for edition variants
3. `TXXX:EDITION`, `TXXX:VERSION`, `TXXX:ALBUMVERSION` — Explicit user-defined TXXX fields
4. `TXXX:QUALITY`, `TXXX:REMASTER`, `TXXX:DESCRIPTION` — Audio quality / remaster / description TXXX variants
5. `EDITION`, `VERSION`, `ALBUMVERSION`, `QUALITY`, `REMASTER` — Vorbis/APE bare key equivalents

You can change this order in **Admin → Database → Album Version Tag Fields**. Placing your primary tag first minimises the number of fields the scanner has to check.

---

## 6. Heuristic Fallback — When No Tag Exists {#heuristic}

For files that have no edition tags at all, the scanner attempts to extract version information from three places:

### 6.1 Album title string

Many users include edition markers in the album name itself:
- `"Rumours (Deluxe Edition)"`
- `"The Division Bell [24bit/96kHz Remaster]"`
- `"Abbey Road — 50th Anniversary Edition"`

### 6.2 Folder name

The immediate parent folder sometimes carries the edition:
- `Music/Pink Floyd/The Division Bell [HiRes]/`
- `Music/Fleetwood Mac/Rumours (Deluxe 2004)/`

### 6.3 Audio properties inference

If the file has `bitsPerSample ≥ 24` and `sampleRate ≥ 88200 Hz`, the scanner stores `Hi-Res Nbit/NkHz` as the version (e.g. `Hi-Res 24bit/96kHz`). This is the lowest-priority fallback.

### Pre-normalisation

Before pattern matching, the input string is normalised:
- Unicode diacritics stripped (NFD decompose → strip combining marks)
- All dash variants (em-dash, en-dash, figure dash) unified to hyphen
- Non-ASCII characters replaced with space
- Result lowercased and whitespace collapsed

### Pattern matching

| Input (after normalise) | Output label |
|---|---|
| `deluxe edition` | `Deluxe Edition` |
| `expanded edition` | `Expanded Edition` |
| `anniversary edition` / `40th anniversary` | `Anniversary Edition` |
| `remaster` / `remastered` / `remasterised` | `Remaster` |
| `2016 remaster` / `remaster 2016` | `2016 Remaster` |
| `hi-res` / `hires` / `hi res` | `Hi-Res` |
| `24bit` / `24-bit` | `24bit` |
| `96khz` / `96.0 kHz` | `96kHz` |
| `dsd64` / `dsd 128` | `DSD64` |
| `sacd` | `SACD` |
| `bonus edition` | `Bonus Edition` |
| `box set` | `Box Set` |
| `live` (standalone) | `Live` |
| `mono` | `Mono` |
| `stereo` | `Stereo` |
| `complete edition` | `Complete Edition` |

### Combined signals

When a string contains both edition and quality signals (e.g. `"Deluxe Edition 24bit/96kHz"`), both are extracted and joined: `Deluxe Edition · 24bit/96kHz`.

### Confidence gate

Heuristics only fire on strings that contain brackets `(…)` / `[…]` **or** a recognised keyword. Plain album names like `"The Division Bell"` never trigger a false positive.

### Fuzzy matching

For the most commonly misspelled edition words, Levenshtein distance ≤ 1 is checked before the regex battery. This handles real library typos like `"Dleuxe Edition"` or `"Remastered edition"`.

---

## 7. Database Storage {#database}

Two columns were added to the `files` table (auto-migrated on first startup if absent):

```sql
ALTER TABLE files ADD COLUMN album_version       TEXT;     -- "Deluxe Edition", "Hi-Res 24bit/96kHz", etc.
ALTER TABLE files ADD COLUMN album_version_source TEXT;    -- which field/method produced the value
ALTER TABLE files ADD COLUMN bit_depth           INTEGER;  -- bitsPerSample from audio codec info
```

`album_version_source` stores a short machine-readable string that allows the admin UI to show a breakdown of how version data was gathered across the library.

The `fts_files` full-text-search table was extended to include `album_version` — so a search for "deluxe" or "24bit" also matches album versions.

All album query functions (`getArtistAlbums`, `getArtistAlbumsMulti`, `getAlbums`, `searchAlbumsByArtist`, `byArtist`, `searchByX`) propagate `album_version` through their SQL and include it in every API response object.

`renderMetadataObj()` includes `album-version` and `bit-depth` in the per-track metadata response returned by `POST /api/v1/db/metadata`.

---

## 8. Admin UI — Album Version Tag Fields {#admin-ui}

**Location**: Admin panel → **Database** tab → **Album Version Tag Fields** card.

### What the card shows

- A reorderable list of tag field names that the scanner will check, in priority order.
- Each field shows a format badge: `ID3`, `TXXX`, `Vorbis/APE`, or `iTunes` — derived automatically from the field name.
- An **inventory breakdown** below the list: counts of how many files in the library have version data sourced from each field or method (e.g. `TIT3: 4 820`, `heuristic:title: 312`, `inferred:audio: 1 041`). This tells you at a glance which fields are actually being used in your library.

### Actions

| Action | Description |
|---|---|
| **Add field** | Type a field name and press Add. Accepts any string; format badge is inferred. |
| **Remove** | Click × next to any field to remove it from the list. |
| **Move up / Move down** | Reorder the priority. The top entry is checked first. |
| **Reset to defaults** | Restores the built-in default list. |
| **Save** | Writes the updated list to `save/conf/default.json`. Takes effect on the next scan. |

### Re-scanning after changing the list

After saving a new field order, trigger a rescan (**Admin → Scanner → Rescan All**) to apply the new priority to all files. The scanner only writes `album_version` if it is currently `NULL` or if a force-rescan is run.

---

## 9. Admin API Endpoints {#admin-api}

### `GET /api/v1/admin/db/album-version-inventory`

Returns a breakdown of how many files have `album_version` sourced from each field or method.

**Auth**: Admin token required.

**Response**:
```json
[
  { "source": "TIT3",             "count": 4820 },
  { "source": "TXXX:EDITION",     "count": 312  },
  { "source": "heuristic:title",  "count": 219  },
  { "source": "heuristic:folder", "count": 91   },
  { "source": "inferred:audio",   "count": 1041 }
]
```

---

### `POST /api/v1/admin/db/params/album-version-tags`

Updates the tag field priority list in `save/conf/default.json`.

**Auth**: Admin token required.

**Body**:
```json
{ "tags": ["TIT3", "SUBTITLE", "TXXX:EDITION", "TXXX:VERSION"] }
```

**Validation**: Array of strings, max 20 entries, each string ≤ 60 characters, only safe characters (`A-Z`, `0-9`, `-`, `:`, `_`).

**Response**: `{ "ok": true }`

---

## 10. Album Library — Version Badges & Filter Pills {#album-library}

### Version badges

Every album card in the Album Library displays a version badge whenever `album_version` is set:

- **Album Library grid** — badge appears below the album title on each card
- **Artist profile album grid** — badge next to the year; albums that share the same title but have different versions get a subtle outline highlight (sibling group)
- **Now Playing pane album grid** — same badge treatment
- **Album songs view** — a version header badge is shown at the top of the track list

### Edition filter pills

When the library contains at least one album with `album_version` set, an **Edition** filter bar appears above the album grid:

```
Edition:  [Deluxe Edition]  [Remaster]  [Hi-Res 24bit/96kHz]  [SACD]  …
```

**Behaviour:**
- Pills start **off** — no filtering is active, all albums are visible.
- Clicking a pill **enables** it (shown with a highlight) — only albums matching that version are shown.
- Multiple pills can be active simultaneously — albums matching **any** selected version are shown.
- Clicking an active pill again deactivates it.
- When all pills are off, all albums are visible (same as the default unfiltered state).

**Filter state persistence**: The active source filters (vpath selectors) and version pills are preserved when navigating into an album and pressing Back — the Library view restores exactly the scroll position and selected pills.

### Series view — version filtering inside a collection

When a series (artist discography collection) is opened from the Album Library, the version pills are inherited from the library view. If you had "Deluxe Edition" selected when entering a series, the series view opens with "Deluxe Edition" pre-selected and filters applied immediately.

Inside the series view, the full density control (List / Comfy / Compact) is available alongside the version pills — using the same `localStorage` preference as the main library and artist library views.

---

## 11. Search — Version Badges in Results {#search}

The **Albums** tab in Search shows a version badge inline with each album name when `album_version` is set. This makes it easy to distinguish between e.g. `Rumours — Deluxe Edition` and the standard release when both appear in search results.

Because `album_version` is indexed in the `fts_files` FTS5 table, searching for `"deluxe"`, `"remaster"`, or `"24bit"` will also match on version tags — not just album titles.

---

## 12. Setting Tags in Your Tagger {#tagging-guide}

### foobar2000

1. Select tracks → right-click → **Properties**
2. Click the `...` button (extra fields) → **New**
3. Field name: `EDITION` → Value: `Deluxe Edition`
4. This writes a `TXXX:EDITION` frame to MP3; for FLAC it writes `EDITION=Deluxe Edition` as a Vorbis comment.

### Mp3tag

1. Select tracks → tag panel on the left
2. Click `+` to add a custom field
3. Field: `TXXX:EDITION` → Value: `Deluxe Edition`
4. Mp3tag uses the `TXXX:` prefix notation directly; for FLAC it strips the prefix and writes a Vorbis comment.

### MusicBrainz Picard

Picard automatically writes `DISCSUBTITLE` when the MusicBrainz release has a release description. To write custom TXXX fields, use a Picard scripting plugin or post-processing script.

### EAC / dBpoweramp / XLD

These rippers write `TIT3` (subtitle) when you fill in the "subtitle" field during rip configuration. This is the **highest-priority** field in Velvet's default list.

### What Velvet stores

Regardless of which tagger you use, after the next rescan:
- `album_version` is populated in the DB
- Version badges appear in the Album Library, Artist profiles, and Search
- Edition filter pills appear in the Album Library toolbar

### Recommended tagging practice

For maximum compatibility across different players and taggers, use **both** the format-native field and the TXXX field:
- For MP3: `TIT3 = Deluxe Edition` **and** `TXXX:EDITION = Deluxe Edition`
- For FLAC: `SUBTITLE = Deluxe Edition` **and** `EDITION = Deluxe Edition`

This ensures the tag is visible in any player, not just Velvet.
