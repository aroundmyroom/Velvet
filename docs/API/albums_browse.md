# /api/v1/albums/browse and /api/v1/albums/art-file

*Added in v6.1.0-velvet*

Endpoints that power the Album Library browser. See [docs/albums.md](../albums.md) for the full system overview.

---

## GET /api/v1/albums/browse

Returns the complete album tree built from the database — no filesystem walking.

### Authentication

Requires a valid session token (same as all other API endpoints).

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
      "seriesId": null,
      "discs": [
        {
          "label": null,
          "discIndex": 1,
          "tracks": [
            {
              "filepath": "Music/Albums/The Beatles - Abbey Road (1969)/01 Come Together.flac",
              "title": "Come Together",
              "artist": "The Beatles",
              "number": 1,
              "duration": 259.7,
              "aaFile": null
            }
          ]
        }
      ]
    }
  ],
  "series": [
    {
      "id": "b7d3a1f...",
      "path": "Albums/Mike Platinas Megamixes",
      "displayName": "Mike Platinas Megamixes",
      "artFile": "Albums/Mike Platinas Megamixes/Megamix Vol. 1 (2000)/cover.jpg",
      "aaFile": null,
      "albumIds": ["c1e2d3...", "d4f5e6..."]
    }
  ]
}
```

### Response fields — album object

| Field | Type | Description |
|---|---|---|
| `id` | string | MD5 of the album path — stable identifier |
| `path` | string | Relative path from the vpath root: `Albums/<folder>` |
| `displayName` | string | Folder name of the album |
| `artist` | string \| null | Extracted from folder name before ` - ` separator |
| `year` | string \| null | Extracted from `(YYYY)` pattern in folder name |
| `artFile` | string \| null | Relative path to an on-disk image file (served via `/api/v1/albums/art-file`) |
| `aaFile` | string \| null | Filename of embedded art cached in `image-cache/` (served via `/api/v1/files/art`) |
| `seriesId` | string \| null | `id` of the parent series, or `null` for standalone albums |
| `discs` | array | One or more disc objects (see below) |

### Response fields — disc object

| Field | Type | Description |
|---|---|---|
| `label` | string \| null | Disc sub-folder name (e.g. `"CD 1"`), or `null` for the album root |
| `discIndex` | number | 1-based disc number |
| `tracks` | array | Ordered list of track objects |

### Response fields — track object

| Field | Type | Description |
|---|---|---|
| `filepath` | string | Full player path: `<vpathName>/Albums/...` — use directly with the streaming URL |
| `title` | string | Track title (from DB or cleaned filename) |
| `artist` | string \| null | Track artist from DB |
| `number` | number \| null | Track number |
| `duration` | number \| null | Duration in seconds |
| `aaFile` | string \| null | Per-track embedded art cache filename |

### Response fields — series object

| Field | Type | Description |
|---|---|---|
| `id` | string | MD5 of the series L1 path |
| `path` | string | `Albums/<L1 folder>` |
| `displayName` | string | L1 folder name |
| `artFile` | string \| null | Art file propagated from first member album |
| `aaFile` | string \| null | Embedded art propagated from first member album |
| `albumIds` | string[] | Ordered list of member album `id` values |

### Caching

Results are cached in memory for **5 minutes**. The cache is shared server-side — all users see the same cached response. The cache is invalidated automatically when a full DB scan completes.

---

## GET /api/v1/albums/art-file

Serves an on-disk album art image file (JPG, PNG, or WebP) identified by its relative path as returned in the `artFile` field of the browse response.

### Query parameters

| Parameter | Required | Description |
|---|---|---|
| `p` | Yes | Relative path of the image file, e.g. `Albums/My Album/cover.jpg` |

### Response

- **200** — image file content (`image/jpeg`, `image/png`, or `image/webp`)
- **400** — missing `p` parameter
- **404** — file not found or outside the configured music folder (path traversal blocked)

### Security

The resolved absolute path is verified to start with the configured vpath root before serving. Path traversal attempts (e.g. `../../etc/passwd`) are rejected with 404.

### Example

```
GET /api/v1/albums/art-file?p=Albums/The%20Beatles%20-%20Abbey%20Road%20(1969)/cover.jpg
```
