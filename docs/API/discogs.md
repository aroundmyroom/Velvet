# Discogs Cover Art Integration

Velvet uses the [Discogs API v2](https://www.discogs.com/developers/) to search for release cover art and embed it directly into audio files. Deezer and iTunes searches are proxied as extra cover sources. Implemented in `src/api/discogs.js`; the config routes live in `src/api/admin.js`.

The Discogs endpoints are **admin-only**. `coverart` and `embed` answer `404` when Discogs is switched off (`discogs.enabled: false`).

---

## Requirements & Policy

- **API credentials are optional.** Without a key + secret, requests are sent unauthenticated and Discogs applies its lower rate limit. With a registered key + secret every request carries `Authorization: Discogs key=…, secret=…`. One cover search fetches several releases, so the limit can be reached quickly; Velvet then answers `429`.
- **Registering:** Get a free key + secret at [discogs.com/settings/developers](https://www.discogs.com/settings/developers). Enter them in the admin panel — they are stored server-side in the config file.
- **User-Agent**: `Velvet/dev/{tag} +https://github.com/aroundmyroom/Velvet` when key, secret and a tag are set (`tag` is a 0–4 character alphanumeric instance identifier set in the admin panel), otherwise `Velvet/dev +https://github.com/aroundmyroom/Velvet`.
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
  "userAgentTag": "amr",
  "itunesEnabled": true,
  "deezerEnabled": true
}
```

`enabled`, `itunesEnabled` and `deezerEnabled` default to `true`. `allowId3Edit` — whether the admin has enabled ID3 tag editing (see [admin_id3-tags.md](admin_id3-tags.md)); the player uses it to decide whether to show the **Edit Tags** button in the Now Playing modal.

---

### `POST /api/v1/admin/discogs/config`
Saves Discogs configuration (to the config file and the running server).

**Auth**: admin token required.

**Body** (all fields required)
```json
{
  "enabled": true,
  "allowArtUpdate": false,
  "apiKey": "your_key",
  "apiSecret": "your_secret",
  "userAgentTag": "amr",
  "itunesEnabled": true,
  "deezerEnabled": true
}
```

**Response**
```json
{}
```

---

## Cover Art Search

### `GET /api/v1/discogs/coverart`

Searches Discogs for up to 8 release covers matching the given metadata. Returns base64-encoded images ready for display — no extra requests from the browser, avoiding CORS issues.

**Auth**: admin token required. Discogs must be enabled.

**Query parameters**

| Parameter  | Type   | Description |
|------------|--------|-------------|
| `artist`   | string | Artist name (from the tag) |
| `title`    | string | Track title or bare filename (cleaned automatically) |
| `album`    | string | Album name (from the tag) |
| `year`     | string | Release year |
| `filepath` | string | Song path; used to fill in artist/album from folder names (for compilations) and to find a catalogue number |

At least one of `artist`, `title`, or `album` is required (after the `filepath` enrichment).

**Search strategy**: several Discogs database searches are sent in parallel, in three phases — album searches (album + artist + year, the album with disc suffixes such as `CD2` stripped, its first segment, a catalogue number found in the album or path, "X Presents" labels), then title searches, then artist/title-from-filename searches. Phase C goes first for a compilation album when artist and title are known. Up to 18 unique results are ranked by phase and how well the artist matches, and the first 12 are resolved to their primary image (a master is resolved to its main release). Hash/ID suffix segments (e.g. `.G12U`) and audio extensions are stripped from filenames before searching.

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

Up to 8 choices, one per release. `thumbB64` is a JPEG data URI of the release's primary image.

**Error responses**

| Status | Meaning |
|--------|---------|
| 400    | No artist/title/album provided |
| 403    | Not an admin |
| 404    | Discogs not enabled |
| 429    | Discogs rate limit reached: every lookup failed and at least one was rate-limited (when some lookups succeed, the others are skipped) |
| 500    | Discogs API error |

### `GET /api/v1/discogs/release-images?id=X&type=release|master`

Admin only. Returns the cover of one Discogs release or master (`type` defaults to `release`) in the same `{ "choices": [ … ] }` shape. `400` for an invalid id, `429` on the Discogs rate limit.

---

## Embed Cover Art

### `POST /api/v1/discogs/embed`

Downloads a cover image and embeds it into an audio file using ffmpeg (no re-encode). The image is also cached in the album-art directory and the database record is updated so the player bar and grid views reflect the new art immediately without rescanning.

**Auth**: admin token required. Discogs must be enabled.

**Body**
```json
{
  "filepath": "Music/Artist/Album/track.flac",
  "releaseId": 249504
}
```

| Field | Required | Description |
|---|---|---|
| `filepath` | ✓ | Player path (starting with the vpath) the authenticated user has access to |
| `releaseId` | one of these | Discogs release id — its primary image is used |
| `coverUrl` | one of these | Direct `http(s)` image URL (e.g. from Deezer or iTunes). Private/loopback hosts are refused. |

The downloaded data must be a JPEG.

**Embeddable formats**: MP3, M4A, M4B, MP4, FLAC (attached picture stream) and OGG/OGA/OPUS (`METADATA_BLOCK_PICTURE`).

**Other formats** (WAV, AIFF, W64, …): the audio file is not modified. When the folder has no `cover.jpg` yet, the image is written there (max 1200 px, JPEG). The response then has `"cacheOnly": true` and `coverFile: "cover.jpg"` when one was written.

**Process**
1. Get the image: the primary (else first) image of `https://api.discogs.com/releases/{releaseId}`, or `coverUrl`
2. Write it to a temp file in the OS temp directory
3. Embed with ffmpeg via a hidden temp file next to the song, then an atomic rename; when the result shows timestamp (PTS) errors, the audio is remuxed and the cover embedded again
4. Store the new file mtime in the DB so the next scan does not treat the file as changed
5. Write `{md5}.jpg` plus `zl-` (256 px), `zs-` (92 px) and `zm-` (512 px) thumbnails to the album-art directory (via sharp)
6. Update the DB record (art source `discogs`, or `deezer` when `coverUrl` was used)
7. Delete the old art file and its thumbnails when no other song still uses it

When **Allow Art Update** is enabled (`allowArtUpdate: true`), songs that already have art also show the art picker in the Now Playing modal.

**Response**
```json
{ "ok": true, "aaFile": "d41d8cd98f00b204e9800998ecf8427e.jpg", "cacheOnly": false, "coverFile": null }
```

`aaFile` is the filename (MD5 of the image + `.jpg`) in the album-art directory. The client uses it to update the in-memory queue so the player bar and queue panel refresh without a page reload.

**Error responses**

| Status | Meaning |
|--------|---------|
| 400    | Invalid/missing `filepath`, `releaseId`/`coverUrl`, path access denied, or a refused `coverUrl` |
| 403    | Not an admin |
| 404    | Discogs not enabled, file not found on disk, or release has no cover image |
| 500    | ffmpeg error, non-JPEG image or Discogs API error |

### `POST /api/v1/discogs/save-folder-cover`

Admin only. Writes the song's cached art as `cover.jpg` (max 1200 px) in the song's folder and records it as the album cover.

Body: `{ "filepath": "Music/Artist/Album/track.flac" }` → `{ "ok": true }`. `404` when the file or its cached art is missing.

---

## Deezer Album Art Proxy

### `GET /api/v1/deezer/search`

Server-side proxy for the Deezer album search (Deezer sends no CORS headers). **Admin only** (`403` otherwise), like the iTunes and Discogs searches; its only callers are the admin art pickers.

Query: `q`, or `artist` and/or `album` (an "X Presents" artist is dropped). Returns Deezer's own JSON for `search/album` (limit 10). `400` without a query, `429` on the Deezer rate limit, `502` when the request fails.

---

## iTunes Album Art Proxy

### `GET /api/v1/itunes/search`

Server-side proxy for the [iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/). No Apple developer credentials required.

**Auth**: admin token required.

**Query parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `artist`  | optional | Artist name (an "X Presents" artist is dropped) |
| `album`   | optional | Album title |

If both are empty the response is `{ "results": [] }`. Up to 10 albums are asked for.

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

- `coverUrl` — 3000×3000 px artwork URL
- `thumb` — 250×250 px thumbnail for the picker grid
- `label` — `"Collection Name (YYYY)"` suitable for display

**Error responses**

| Status | Meaning |
|--------|---------|
| 403    | Not an admin |
| 429    | iTunes rate limit reached |
| 502    | iTunes API request failed |

### Per-service admin toggles

Each art service can be switched on or off in the admin panel (Discogs config page). Config keys in the `discogs` block of the config file:

| Key | Default | Description |
|-----|---------|-------------|
| `discogs.enabled` | `true` | Discogs search and embed |
| `discogs.itunesEnabled` | `true` | Show iTunes art picker in Now Playing modal |
| `discogs.deezerEnabled` | `true` | Show Deezer art picker in Now Playing modal |

These are read/written via `GET /api/v1/admin/discogs/config` and `POST /api/v1/admin/discogs/config`.
