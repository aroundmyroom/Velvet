# Discogs Cover Art Integration

Velvet uses the [Discogs API v2](https://www.discogs.com/developers/) to search for and embed release cover art directly into audio files.

All Discogs endpoints are **admin-only** and require Discogs to be enabled in the server configuration.

---

## Requirements & Policy

- **API credentials are optional.** Discogs permits unauthenticated requests at **25 requests/minute**. With a registered key + secret the limit is **60 requests/minute**. Each cover art search consumes up to ~10 requests (search + individual release fetches), so the unauthenticated limit can be reached quickly with frequent searches.
- **Registering:** Get a free key + secret at [discogs.com/settings/developers](https://www.discogs.com/settings/developers). Enter them in the admin panel — they are stored server-side only and never exposed to non-admin users.
- **User-Agent**: Built as `Velvet/dev/{tag} +https://github.com/aroundmyroom/Velvet` where `tag` is a configurable 1–4 alphanumeric instance identifier set in the admin panel. The base prefix is hardcoded.
- **Terms**: Usage is subject to the [Discogs API Terms of Use](https://support.discogs.com/hc/articles/360009334593-API-Terms-of-Use).

---

## Configuration

### `GET /api/v1/admin/discogs/config`
Returns the current Discogs configuration.

**Auth**: admin token required.

**Response**
```json
{
  "enabled": true,
  "allowArtUpdate": false,
  "allowId3Edit": false,
  "apiKey": "your_key",
  "apiSecret": "your_secret",
  "userAgentTag": "amr"
}
```

`allowId3Edit` — whether the admin has enabled ID3 tag editing (see [admin_id3-tags.md](admin_id3-tags.md)). The player reads this field on login, session restore, and page visibility change to decide whether to show the **✏ Edit Tags** button in the Now Playing modal.

---

### `POST /api/v1/admin/discogs/config`
Saves Discogs configuration.

**Auth**: admin token required.

**Body**
```json
{
  "enabled": true,
  "allowArtUpdate": false,
  "apiKey": "your_key",
  "apiSecret": "your_secret",
  "userAgentTag": "amr"
}
```

**Response**
```json
{ "success": true }
```

---

## Cover Art Search

### `GET /api/v1/discogs/coverart`

Searches Discogs for up to 8 release covers matching the given metadata. Returns base64-encoded thumbnails ready for display — no extra requests from the browser, avoiding CORS issues.

**Auth**: admin token required. Discogs must be enabled.

**Query parameters**

| Parameter | Type   | Description |
|-----------|--------|-------------|
| `artist`  | string | Artist name (from ID3 tag) |
| `title`   | string | Track title or bare filename (parsed automatically) |
| `album`   | string | Album name (from ID3 tag) |
| `year`    | string | Release year (from ID3 tag) |

At least one of `artist`, `title`, or `album` is required.

**Search strategy** (tried in order, stops at 3 results):
1. Exact `release_title=album` + `artist` + `year`
2. Album with disc suffix stripped (`CD2`, `Disc 2`, `Vol. 2`, etc.)
3. First segment of album title before comma/dash (e.g. `"Journey into paradise"` from `"Journey into paradise, The Larry Levan Story CD2"`)
4. Free-text `q=artist+cleanAlbum`
5. `release_title=title` (when title differs from album)
6. Filename parsing — handles both:
   - **Spaced `Artist - Title` convention**: `Kool & the Gang - Fresh (Mark Berry Remix).G12U.wav` → `artist="Kool & the Gang"`, `title="Fresh (Mark Berry Remix)"`
   - **CamelCase/dash filenames**: `RobinS-ShowMeLove-Acappella.G12U.wav` → `artist="Robin S"`, `title="Show Me Love"`
7. Artist-only master search (last resort)

Hash/ID suffix segments (e.g. `.G12U`, `.3FAB8`) and audio extensions are automatically stripped from filenames before searching.

**Response**
```json
{
  "choices": [
    {
      "releaseId": 249504,
      "releaseTitle": "Kool & The Gang - Fresh",
      "year": "1985",
      "thumbB64": "data:image/jpeg;base64,/9j/4AAQ..."
    }
  ]
}
```

Up to 8 choices are returned. `thumbB64` is a JPEG data URI (fetched from `uri150`, ~150×150 px).

**Error responses**

| Status | Meaning |
|--------|---------|
| 400    | No artist/title/album provided |
| 403    | Not an admin |
| 404    | Discogs not enabled |
| 500    | Discogs API error |

---

## Embed Cover Art

### `POST /api/v1/discogs/embed`

Downloads the full-resolution primary image for a Discogs release and embeds it into an audio file using ffmpeg. The image is also cached in `image-cache/` and the database is updated so the player bar and grid views reflect the new art immediately without rescanning.

For **WAV, AIFF, and W64** containers — which do not support embedded cover art — the ffmpeg step is skipped. The image is still downloaded, cached in `image-cache/`, and the database record is updated. The response includes `"cacheOnly": true`. Art stored this way is lost on a database reset or album-art cache wipe.

When **Allow Art Update** is enabled in the admin panel (`allowArtUpdate: true`), songs that already have art will also show the Fix Art picker in the Now Playing modal. On a successful embed the old art file (`{hash}.jpg`, `zl-{hash}.jpg`, `zs-{hash}.jpg`) is deleted from `image-cache/` if no other song in the database still references it.

**Auth**: admin token required. Discogs must be enabled.

**Body**
```json
{
  "filepath": "music/Artist/Album/track.flac",
  "releaseId": 249504
}
```

`filepath` must be a vpath-relative path the authenticated user has access to.

**Supported formats for embed**: MP3, FLAC, OGG, M4A, M4B, OPUS (any container that supports attached picture streams).

**Cache-only formats**: WAV, AIFF, W64 — these containers cannot hold embedded cover art. The image is cached to `image-cache/` and the DB record is updated, but the audio file is not modified. Response includes `"cacheOnly": true`.

**Process**
1. Fetch full-res primary image from `https://api.discogs.com/releases/{releaseId}`
2. Write image to temp file
3. Run ffmpeg: `-c copy -disposition:v:0 attached_pic` (lossless, no re-encode)
4. Copy temp output over original file (cross-device safe)
5. Write to `image-cache/{md5}.jpg`
6. Create compressed variants `zl-{md5}.jpg` (256 px) and `zs-{md5}.jpg` (92 px) via Jimp
7. Update database record with new `album-art` value

**Response**
```json
{ "ok": true, "aaFile": "d41d8cd98f00b204e9800998ecf8427e.jpg", "cacheOnly": false }
```

`aaFile` is the filename (MD5 hash + `.jpg`) inside `image-cache/`. The client uses this to update the in-memory queue so the player bar and queue panel refresh without a page reload.  
`cacheOnly` is `true` for WAV/AIFF/W64 files (art cached to DB only, not embedded).

**Error responses**

| Status | Meaning |
|--------|---------|
| 400    | Invalid/missing `filepath` or `releaseId` |
| 403    | Not an admin or path access denied |
| 404    | File not found on disk, or release has no cover image on Discogs |
| 500    | ffmpeg error or Discogs API error |

---

## iTunes Album Art Proxy *(v6.5.0-velvet)*

### `GET /api/v1/itunes/search`

Server-side proxy for the [iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/). No Apple developer credentials required.

**Auth**: admin token required.

**Query parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `artist`  | optional | Artist name |
| `album`   | optional | Album title |

At least one of `artist` or `album` must be non-empty; if both are empty the response is `{ "results": [] }`.

**Response**
```json
{
  "results": [
    {
      "coverUrl": "https://is1-ssl.mzstatic.com/image/thumb/.../3000x3000bb.jpg",
      "label": "Album Name (2012)",
      "thumb": "https://is1-ssl.mzstatic.com/image/thumb/.../250x250bb.jpg"
    }
  ]
}
```

- `coverUrl` — 3000×3000 px full-res artwork URL (highest quality Apple provides)
- `thumb` — 250×250 px thumbnail for the picker grid
- `label` — `"Collection Name (YYYY)"` suitable for display

**Error responses**

| Status | Meaning |
|--------|---------|
| 403    | Not an admin |
| 502    | iTunes API request failed |

### Per-service admin toggles

Each art service (Discogs, Deezer, iTunes) can be enabled or disabled independently in the admin panel (Discogs config page).

Config keys stored in `default.json` under the `discogs` block:

| Key | Default | Description |
|-----|---------|-------------|
| `discogs.itunesEnabled` | `true` | Show iTunes art picker in Now Playing modal |
| `discogs.deezerEnabled` | `true` | Show Deezer art picker in Now Playing modal |

These are read/written via `GET /api/v1/admin/discogs/config` and `POST /api/v1/admin/discogs/config`.

