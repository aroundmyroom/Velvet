# Artist Library API

Artist Library endpoints for browse, profile, image hydration/admin moderation, and index maintenance.

---

## User endpoints

### GET /api/v1/artists/home

Returns Artist Home shelves and totals.

Response shape:

```json
{
  "totalCount": 18452,
  "topArtists": [ { "artistKey": "madonna", "canonicalName": "Madonna", "songCount": 123, "imageFile": "madonna.jpg" } ],
  "mostPlayedArtists": [ { "artistKey": "cerrone", "canonicalName": "CERRONE", "playCount": 17, "songCount": 54, "imageFile": "cerrone.jpg" } ],
  "recentArtists": [ { "artistKey": "propaganda", "canonicalName": "Propaganda", "songCount": 46, "imageFile": null } ]
}
```

### GET /api/v1/artists/letter?l=A

Returns artists by leading letter.

- `l=A..Z` => names starting with that letter
- `l=0` => digit-starting names

Response:

```json
{ "artists": [ { "artistKey": "abba", "canonicalName": "ABBA", "songCount": 45, "imageFile": null } ] }
```

### GET /api/v1/artists/search?q=query

Full-text search over canonical names and variants.

- Minimum query length: 2 chars

Response:

```json
{ "artists": [ { "artistKey": "a-ha", "canonicalName": "A-Ha", "songCount": 31, "imageFile": null } ] }
```

### GET /api/v1/artists/profile?key=artistKey

Returns profile metadata and grouped releases.

Response includes:

- `artistKey`
- `canonicalName`
- `bio`
- `imageFile`
- `imageSource`
- `lastFetched`
- `releaseCategories[]`

### GET /api/v1/artists/images/:filename

Serves cached artist image files from `image-cache/artists/`.

---

## Admin actions from player

### POST /api/v1/artists/mark-image-wrong

Marks or clears wrong-image flag for an artist.

Request body:

```json
{ "artistKey": "madonna", "wrong": true }
```

Response:

```json
{ "ok": true, "artistKey": "madonna", "wrong": true }
```

---

## Admin artist image and index management

### POST /api/v1/admin/artists/rebuild-index

Triggers immediate rebuild of `artists_normalized` without waiting for full scan.

### GET /api/v1/admin/artists/image-audit?kind=missing|no-image|wrong|with-image&limit=300

Lists artists for moderation queues.

- `missing`: artist has no stored image and has not been tried upstream yet
- `no-image`: artist has no stored image, but an upstream fetch already returned no usable result
- `wrong`: artist image exists but was flagged as incorrect
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

Returns candidate artist portraits from Discogs.

Response:

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

### POST /api/v1/admin/artists/apply-image

Downloads and applies chosen image URL for an artist.

Request:

```json
{ "artistKey": "madonna", "imageUrl": "https://...", "source": "discogs" }
```

Response:

```json
{ "ok": true, "imageFile": "madonna.jpg", "imageSource": "discogs" }
```

### GET /api/v1/admin/artists/hydration-status

Live queue/throughput status for background artist image hydration.

Response:

```json
{
  "running": false,
  "queueLength": 0,
  "queueLimit": 800,
  "delayMs": { "ok": 1400, "noImage": 2200, "error": 4000 },
  "discogs": { "enabled": true, "hasApiCredentials": true },
  "stats": {
    "enqueued": 0,
    "dropped": 0,
    "processed": 0,
    "succeeded": 0,
    "noImage": 0,
    "failed": 0,
    "startedAt": 0,
    "lastRunAt": 0,
    "lastSuccessAt": 0,
    "lastErrorAt": 0,
    "lastError": null
  },
  "counts": { "missing": 18060, "wrong": 1, "withImage": 392 }
}
```

### POST /api/v1/admin/artists/hydration-seed

Queues missing artists for background hydration on demand.

Request:

```json
{ "limit": 500 }
```

Response:

```json
{
  "ok": true,
  "enqueued": 200,
  "running": true,
  "queueLength": 200,
  "queueLimit": 800,
  "counts": { "missing": 18060, "wrong": 1, "withImage": 392 }
}
```
