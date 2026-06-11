# Radio API

All endpoints require a valid `token` query parameter (or `Authorization: Bearer` header) from a logged-in user.  
Station data is **per-user** — each user manages their own list of channels.

---

## Admin: enable / disable radio globally

### `GET /api/v1/admin/radio/config`
> Admin only

Returns whether the radio feature is enabled server-wide.

**Response**
```json
{ "enabled": true }
```

---

### `POST /api/v1/admin/radio/config`
> Admin only

Enable or disable radio for all users.

**Body** `application/json`
```json
{ "enabled": true }
```

**Response** `{}`

---

## Check if radio is enabled

### `GET /api/v1/radio/enabled`
> All authenticated users

**Response**
```json
{ "enabled": true }
```

---

## Station CRUD

### `GET /api/v1/radio/stations`

Return all stations belonging to the authenticated user, ordered by `sort_order`.

**Response** — array of station objects:
```json
[
  {
    "id": 3,
    "name": "Radio Paradise",
    "genre": "Rock, Eclectic",
    "country": "USA",
    "link_a": "https://stream.radioparadise.com/flac",
    "link_b": "https://stream.radioparadise.com/aac-320",
    "link_c": null,
    "img": "radio-fe73c592013b08b387c233897774790b.png",
    "sort_order": 0
  }
]
```

**`img` field** — always a local filename when present. Access the logo via the standard album-art endpoint:
```
GET /album-art/{img}?token=TOKEN
```
If the cached file is missing on disk the field is returned as `null`.

---

### `POST /api/v1/radio/stations`

Create a new station.

**Body** `application/json`
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string (≤120) | ✅ | Display name |
| `link_a` | string (≤1024) | ✅ | Primary stream URL (HTTP/HTTPS, no `.m3u8`) |
| `link_b` | string (≤1024) | — | Fallback stream URL |
| `link_c` | string (≤1024) | — | Second fallback stream URL |
| `genre` | string (≤80) | — | Comma-separated, e.g. `"Rock, Pop"` |
| `country` | string (≤80) | — | Country name |
| `img` | string (≤1024) | — | Remote image URL — server downloads and caches it; not stored as a URL |

When `img` is a remote URL the server fetches it, saves it as `radio-{md5}.{ext}` in the album-art cache, and stores only the local filename. Subsequent requests for the station logo go through `/album-art/`.

**Response**
```json
{ "id": 4 }
```

---

### `PUT /api/v1/radio/stations/:id`

Update an existing station. Accepts the same body as `POST`. Passing a new `img` URL forces a re-download of the logo.

**Response** `{}`

**Errors**
- `404` — station not found or belongs to another user

---

### `DELETE /api/v1/radio/stations/:id`

Delete a station. The cached logo file is removed from disk if no other station references it.

**Response** `{}`

---

### `PUT /api/v1/radio/stations/reorder`

Persist a new display order for the authenticated user's stations.

**Body**
```json
{ "ids": [3, 1, 4, 2] }
```

All IDs must belong to the authenticated user. The array represents the desired order from first to last.

**Response** `{}`

---

## Stream proxy

### `GET /api/v1/radio/stream?url=ENCODED_STREAM_URL`

Pipes a live radio stream through the Velvet server. This is required because the browser's Web Audio API (`createMediaElementSource`) marks the audio element as CORS-tainted for cross-origin sources — streams that lack CORS headers would be silenced. The proxy makes every stream appear same-origin to the browser.

- SSRF-protected: loopback / RFC-1918 addresses are rejected with `403`
- No `.m3u8` playlists
- Content-Type is normalised: AAC+ / HE-AAC streams are served as `audio/aac` so Chrome recognises them

---

## ICY now-playing metadata

### `GET /api/v1/radio/nowplaying?url=ENCODED_STREAM_URL`

Opens the stream using HTTP/1.1, reads the first ICY `StreamTitle` metadata block, and returns it.

> Uses `node:http` / `node:https` (never `fetch`) because CDN servers only inject ICY metadata on HTTP/1.1 connections; `fetch()` negotiates HTTP/2 via ALPN and never receives ICY headers.

**Response**
```json
{ "title": "Radiohead - Creep" }
```

Returns `{ "title": null }` if no ICY metadata is found or the stream does not support it. The raw `StreamTitle` string is returned as-is — stations use different conventions (`Artist - Title` vs `Title - Artist`) so no splitting is performed.

---

## Art proxy (CORS bypass)

### `GET /api/v1/radio/art?url=ENCODED_IMAGE_URL`

Fetches a remote image server-side and forwards it to the browser, bypassing CORS restrictions on remote logo URLs in the admin edit form. Only used during station editing in the UI.

- SSRF-protected
- Only forwards `image/*` content types
- `Cache-Control: public, max-age=86400`
