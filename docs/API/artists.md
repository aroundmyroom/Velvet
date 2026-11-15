# Artist Library API

Artist Library endpoints for browse, profile, image hydration/admin moderation, and index maintenance. Implemented in `src/api/artists-browse.js` (the index rebuild routes live in `src/api/admin.js`).

Users that only have child vpaths see artists filtered to those folders.

---

## User endpoints

Artist objects in the lists below share this shape:

```json
{ "artistKey": "madonna", "canonicalName": "Madonna", "imageFile": "madonna.jpg", "hasBio": true, "songCount": 123, "rawVariants": ["Madonna", "MADONNA"] }
```

### GET /api/v1/artists/home

Returns Artist Home shelves and totals. Cached for all users (not for child-only users).

```json
{
  "totalCount": 18452,
  "topArtists": [ { "artistKey": "madonna", "canonicalName": "Madonna", "songCount": 123, "imageFile": "madonna.jpg", "hasBio": true, "rawVariants": ["Madonna"] } ],
  "mostPlayedArtists": [ { "artistKey": "cerrone", "canonicalName": "CERRONE", "playCount": 17, "songCount": 54, "imageFile": "cerrone.jpg", "hasBio": false, "rawVariants": ["Cerrone"] } ],
  "recentArtists": [ { "artistKey": "propaganda", "canonicalName": "Propaganda", "songCount": 46, "imageFile": null, "hasBio": false, "rawVariants": ["Propaganda"] } ]
}
```

- `topArtists` — up to 20, by song count
- `mostPlayedArtists` — up to 20, by play count (from play history)
- `recentArtists` — up to 10 most recently played

### GET /api/v1/artists/letter?l=A

Returns artists by leading letter.

- `l=A..Z` => names starting with that letter
- `l=0` => digit-starting names
- Anything else => `400`

Response: `{ "artists": [ … ] }`

### GET /api/v1/artists/search?q=query

Search over canonical names and variants, limited to artists that have songs in the caller's own folders.

- Minimum query length: 2 chars (`400` otherwise)

Response: `{ "artists": [ … ] }`

### GET /api/v1/artists/image?artist=name

Returns `{ "imageFile": "…" }` when a cached image exists for the raw artist tag, else `{}` (and queues the artist for image hydration).

### GET /api/v1/artists/profile?key=artistKey

Returns profile metadata and grouped releases. When the artist has no fanart, or no genre, bio and country, TheAudioDB is asked first. `400` without `key`, `404` for an unknown artist.

Response fields: `artistKey`, `canonicalName`, `bio`, `imageFile`, `imageSource`, `fanartFile`, `mbid`, `genre`, `country`, `formedYear`, `lastFetched`, `releaseCategories[]`.

### GET /api/v1/artists/images/:filename

Serves cached artist image files from `image-cache/artists/`. The filename must be a plain name ending in `.jpg`, `.jpeg`, `.png` or `.webp` (`400` otherwise).

### GET /api/v1/artists/placeholder

Serves the custom placeholder image for artists without a photo, or the built-in default.

---

## Admin actions from player

All return `403` for non-admins and `404` for an unknown `artistKey`.

### POST /api/v1/artists/mark-image-wrong

Marks or clears the wrong-image flag for an artist. `wrong` defaults to `true`.

```json
{ "artistKey": "madonna", "wrong": true }
```

Response: `{ "ok": true, "artistKey": "madonna", "wrong": true }`

### POST /api/v1/artists/set-image

Downloads an image URL, resizes it and stores it as the artist image (source `custom`).

Body: `{ "artistKey": "madonna", "imageUrl": "https://..." }` → `{ "ok": true, "imageFile": "…" }` (`422` when the image cannot be downloaded or processed).

### POST /api/v1/artists/set-name

Overrides the display name.

Body: `{ "artistKey": "madonna", "canonicalName": "Madonna" }` (1–200 chars) → `{ "ok": true, "canonicalName": "Madonna" }`

---

## Admin artist image and index management

All admin-only.

### POST /api/v1/admin/artists/rebuild-index

Starts a background rebuild of `artists_normalized` without waiting for a full scan. Returns `{ "ok": true, "started": true }` at once, or `409` when a rebuild is already running.

### GET /api/v1/admin/artists/rebuild-status

Returns `{ "running", "startedAt", "finishedAt", "lastError" }` for the last rebuild.

### GET /api/v1/admin/artists/image-audit?kind=missing|no-image|wrong|with-image&limit=200

Lists artists for moderation queues. `kind` defaults to `missing`, `limit` to 200.

- `missing`: artist has no stored image and has not been tried upstream yet
- `no-image`: artist has no stored image, but an upstream fetch already returned no usable result
- `wrong`: artist image was flagged as incorrect
- `with-image`: artist image exists for validation/review

Response:

```json
{
  "kind": "missing",
  "counts": { "missing": 18060, "noImage": 7244, "wrong": 1, "withImage": 392 },
  "artists": [
    {
      "artistKey": "chicane",
      "canonicalName": "Chicane",
      "imageFile": null,
      "imageSource": null,
      "songCount": 81,
      "wrongFlag": false,
      "lastFetched": null
    }
  ]
}
```

### GET /api/v1/admin/artists/discogs-candidates?artistKey=...

Returns up to 10 candidate artist portraits from Discogs.

```json
{
  "artistKey": "madonna",
  "canonicalName": "Madonna",
  "candidates": [
    {
      "id": 8760,
      "title": "Madonna",
      "imageUrl": "https://...",
      "thumbUrl": "https://...",
      "sourceUrl": "https://www.discogs.com/artist/8760-Madonna"
    }
  ]
}
```

### GET /api/v1/admin/artists/tadb-candidates?artistKey=...

Returns up to 6 candidates from TheAudioDB (only those with an image), same shape as above plus `genre` and `country`.

### POST /api/v1/admin/artists/apply-image

Downloads and applies a chosen image URL for an artist and clears its wrong-image flag. `source` defaults to `custom`.

```json
{ "artistKey": "madonna", "imageUrl": "https://...", "source": "discogs" }
```

Response: `{ "ok": true, "imageFile": "madonna.jpg", "imageSource": "discogs" }` (`422` when the image cannot be downloaded or processed).

### GET /api/v1/admin/artists/hydration-status

Live queue/throughput status for background artist image hydration.

```json
{
  "running": false,
  "queueLength": 0,
  "queueLimit": 50000,
  "throughputPerMin": null,
  "delayMs": { "ok": 1400, "noImage": 2200, "error": 4000 },
  "discogs": { "enabled": true, "hasApiCredentials": true },
  "stats": {
    "startedAt": 0,
    "enqueued": 0,
    "dropped": 0,
    "processed": 0,
    "succeeded": 0,
    "noImage": 0,
    "failed": 0,
    "lastRunAt": 0,
    "lastSuccessAt": 0,
    "lastErrorAt": 0,
    "lastError": null,
    "lastArtist": null,
    "recentLog": []
  },
  "counts": { "missing": 18060, "noImage": 7244, "wrong": 1, "withImage": 392 }
}
```

### POST /api/v1/admin/artists/hydration-seed

Queues missing artists for background hydration. `limit` 1–100000, default 500.

Request: `{ "limit": 500 }`

Response: `{ "ok": true, "enqueued": 200, …hydration-status fields…, "counts": { … } }`

### POST /api/v1/admin/artists/hydrate-tadb-noimage

Re-queues artists in the `no-image` state, ignoring the retry cooldowns. Same body and response as `hydration-seed`.

### POST /api/v1/admin/artists/enrich-tadb

Re-queues artists that miss TheAudioDB data (bio, fanart, genre). Response: `{ "ok": true, "reset": 12, "enqueued": 40, "message": "…" }`.

### Custom placeholder

- `POST /api/v1/admin/artists/placeholder` — multipart upload of one image (max 10 MB), stored as a 400×400 JPEG at `artist-placeholder.jpg` in the config folder (`save/conf/`) → `{ "ok": true }`
- `DELETE /api/v1/admin/artists/placeholder` — back to the built-in default → `{ "ok": true }`
- `GET /api/v1/admin/artists/placeholder-info` → `{ "hasCustom": true }`
