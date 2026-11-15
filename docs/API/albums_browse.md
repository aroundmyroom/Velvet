# /api/v1/albums/browse, /detail, /art-file and /set-art

Endpoints that power the Album Library browser. See [docs/albums.md](../albums.md) for the full system overview.

The album sources are the folders flagged `albumsOnly` (see [Admin directory flags](admin_directory-flags.md)); when none is flagged, the first root vpath with an `Albums/` subdirectory on disk is used.

---

## GET /api/v1/albums/browse

Returns the album tree built from the database — no filesystem walking. Albums are returned **without** their track lists; fetch those with `GET /api/v1/albums/detail`.

### Authentication

Requires a valid session token. A user only sees albums and series whose source vpath is in their own vpath list.

### Response

```json
{
  "albums": [
    {
      "id": "a3f1e2c...",
      "path": "Albums/The Beatles - Abbey Road (1969)",
      "displayName": "The Beatles - Abbey Road (1969)",
      "artist": "The Beatles",
      "year": "1969",
      "artFile": "Albums/The Beatles - Abbey Road (1969)/cover.jpg",
      "aaFile": null,
      "album_version": null,
      "categoryLabel": null,
      "seriesId": null,
      "sourceVpath": "Albums",
      "rawArtistTags": ["The Beatles"],
      "discCount": 1,
      "totalTracks": 17
    }
  ],
  "series": [
    {
      "id": "b7d3a1f...",
      "path": "Albums/Mike Platinas Megamixes",
      "displayName": "Mike Platinas Megamixes",
      "artFile": "Albums/Mike Platinas Megamixes/Megamix Vol. 1 (2000)/cover.jpg",
      "aaFile": null,
      "albumIds": ["c1e2d3...", "d4f5e6..."],
      "sourceVpath": "Albums"
    }
  ]
}
```

When no album source exists the response is `{ "albums": [], "series": [], "error": "No albumsOnly vpath or Albums/ folder found" }`.

### Response fields — album object

| Field | Type | Description |
|---|---|---|
| `id` | string | SHA-256 of the album path — stable identifier |
| `path` | string | Album folder path inside the source, e.g. `Albums/<folder>` |
| `displayName` | string | Folder name of the album |
| `artist` | string \| null | From the folder name before ` - `, else the folder directly above the album |
| `year` | string \| null | From a `(YYYY)` in the folder name, or a leading `YYYY -` |
| `artFile` | string \| null | Relative path to an on-disk image file (served via `/api/v1/albums/art-file`) |
| `aaFile` | string \| null | Filename of embedded art cached in the album-art directory |
| `album_version` | string \| null | Album version tag from the DB, when set |
| `categoryLabel` | string \| null | Category folder label, when the album sits under one |
| `seriesId` | string \| null | `id` of the parent series, or `null` for standalone albums |
| `sourceVpath` | string \| null | The album source vpath name |
| `rawArtistTags` | string[] \| null | Artist tags (album artist, else artist) found on more than half of the album's tracks |
| `discCount` | number | Number of discs |
| `totalTracks` | number | Number of tracks over all discs |

### Response fields — series object

A series is an artist folder that holds more than one album.

| Field | Type | Description |
|---|---|---|
| `id` | string | SHA-256 of the series folder path |
| `path` | string | Series folder path |
| `displayName` | string | Last segment of the series folder path |
| `artFile` | string \| null | Art from the first member album that has art |
| `aaFile` | string \| null | Embedded art from the first member album that has art |
| `albumIds` | string[] | Ordered list of member album `id` values |
| `sourceVpath` | string | The album source vpath name |

### Caching

The full album tree is cached in memory for **5 minutes** and shared by all users (the per-user vpath filter is applied on each response). The cache is also cleared when an admin changes the `albumsOnly` or `dlnaEnabled` flag of a folder, and after `POST /api/v1/albums/set-art`.

---

## GET /api/v1/albums/detail

Returns one album with its disc and track lists.

### Query parameters

| Parameter | Required | Description |
|---|---|---|
| `id` | Yes | Album `id` from the browse response |

### Response

The album object from the browse response (without `discCount`/`totalTracks`) plus `discs`:

| Field | Type | Description |
|---|---|---|
| `discs[].label` | string \| null | Disc sub-folder name (e.g. `"CD 1"`), or `null` for the album root |
| `discs[].discIndex` | number | 1-based disc number |
| `discs[].aaFile` | string \| null | Embedded art of the first track in that disc that has one |
| `discs[].tracks[].filepath` | string | Full player path through the root DB vpath — use directly with the streaming URL |
| `discs[].tracks[].title` | string | Track title (from DB or cleaned filename) |
| `discs[].tracks[].artist` | string \| null | Album artist, else track artist, from DB |
| `discs[].tracks[].number` | number \| null | Track number (from DB or filename) |
| `discs[].tracks[].duration` | number \| null | Duration in seconds |
| `discs[].tracks[].aaFile` | string \| null | Per-track embedded art cache filename |
| `discs[].tracks[].cuepoints` | array | `[{ no, title, t }]` when the file has at least 2 CUE points, else `[]` |

For a single-file disc without CUE points, the sidecar `.cue` file is re-read from disk on each request; when it now yields at least 2 points they are returned and stored in the DB.

- **400** — missing `id`
- **404** — album not found

---

## GET /api/v1/albums/art-file

Serves an on-disk album art image identified by its relative path as returned in the `artFile` field.

### Query parameters

| Parameter | Required | Description |
|---|---|---|
| `p` | Yes | Relative path of the image file, e.g. `Albums/My Album/cover.jpg` |

### Response

- **200** — image file content
- **400** — missing `p`, or `p` does not end in `.jpg`, `.jpeg`, `.png`, `.webp` or `.gif`
- **404** — file not found in any album source, or outside the source root

### Security

For each album source the resolved absolute path must stay inside that source's root; a path that escapes it is skipped, so traversal attempts end in 404.

### Example

```
GET /api/v1/albums/art-file?p=Albums/The%20Beatles%20-%20Abbey%20Road%20(1969)/cover.jpg
```

---

## POST /api/v1/albums/set-art

Admin only. Downloads a cover image, converts it to JPEG and writes it as `cover.jpg` in the album folder.

### Body

| Field | Type | Required | Description |
|---|---|---|---|
| `albumPath` | string | Yes | The album `path` from the browse response |
| `releaseId` | integer | one of these | Discogs release id to take the cover from |
| `coverUrl` | string | one of these | `http(s)` URL of an image (Deezer, iTunes, pasted URL) |

### Response

- **200** — `{ "artFile": "<albumPath>/cover.jpg" }`
- **400** — validation failed
- **403** — not an admin
- **404** — album folder not found
- **502** — image download failed
- **500** — writing the cover failed
