**Podcast Feeds & Episodes**

Server-side RSS podcast subscription. Users subscribe to RSS 2.0 feed URLs and browse/play episodes directly from the sidebar. No external service or account is required.

All endpoints require authentication. Users can only read and modify their own feeds and episodes.

See [docs/podcasts.md](../podcasts.md) for full feature documentation including RSS parser details, cover art caching, SSRF protection, and the database schema.

---

## Preview a feed URL

Fetches and parses a feed URL without saving anything. Used by the Subscribe form to show feed metadata before committing.

* **URL:** `GET /api/v1/podcast/preview`
* **Query params:** `url` (required)

**Response `200`:**
```json
{
  "title":        "Global News Podcast",
  "description":  "The latest world news from BBC...",
  "author":       "BBC World Service",
  "language":     "en",
  "imgUrl":       "https://...",
  "episodeCount": 257
}
```

**Errors** (all `400`):
- `{"error":"url is required"}` — no URL provided
- `{"error":"Invalid URL"}` — malformed URL
- `{"error":"Only http/https URLs are allowed"}` — other scheme
- `{"error":"That URL is not allowed"}` — SSRF-blocked address
- `{"error":"Feed returned HTTP 404"}` — upstream HTTP error
- `{"error":"Not a valid RSS 2.0 feed"}` — XML parsed but no `<rss><channel>`
- `{"error":"No audio episodes found in this feed"}` — feed has items but none have an audio enclosure

---

## List subscribed feeds

* **URL:** `GET /api/v1/podcast/feeds`

**Response `200`:** Array of feed objects (ordered by `sort_order` asc):
```json
[
  {
    "id": 1,
    "user": "alice",
    "url": "https://podcasts.files.bbci.co.uk/p02nq0gn.rss",
    "title": "Global News Podcast",
    "description": "...",
    "img": "podcast-7ae645a6b74fafe23cf9262a1a999e6e.jpg",
    "author": "BBC World Service",
    "language": "en",
    "last_fetched": 1742500000,
    "created_at":   1742490000,
    "sort_order":   0,
    "episode_count": 257,
    "latest_pub_date": 1742400000
  }
]
```

Timestamps are Unix seconds. Feeds with the same `sort_order` are ordered newest `created_at` first.

`img` is a relative filename; retrieve cover art at `/album-art/{img}`.

---

## Subscribe to a feed

* **URL:** `POST /api/v1/podcast/feeds`

**Body:**

| Field | Required | Description |
|---|---|---|
| `url` | Yes | `http`/`https` RSS URL, max 2048 chars. |
| `name` | No | Custom display name (max 200 chars); overrides the feed's own title. |

**Behaviour:** SSRF check → fetch+parse RSS → download+cache cover art → insert feed + episodes → return new feed object.

**Error `400`:** Validation error, blocked/invalid URL, or upstream fetch/parse failure. There is no duplicate check: subscribing to the same URL twice creates a second feed.

---

## Reorder feeds

Persist a new drag-reorder sequence.

* **URL:** `PUT /api/v1/podcast/feeds/reorder`

**Body:** `{ "ids": [3, 1, 2] }` — complete ordered array of the user's feed IDs.

**Response `200`:** `{}`

---

## Rename a feed / change its URL

* **URL:** `PATCH /api/v1/podcast/feeds/:id`

**Body:** `{ "title": "My Custom Name" }` and/or `{ "url": "https://new.example.com/feed.rss" }` — at least one of the two. `title` max 200 chars; `url` must be `http`/`https`, max 2048 chars.

**Response `200`:** Updated feed object. `404` when the feed is not yours.

---

## Delete (unsubscribe) a feed

Deletes the feed and all its episodes. Cached cover art is deleted from disk if no other feed references it.

* **URL:** `DELETE /api/v1/podcast/feeds/:id`

**Response `200`:** `{}`

---

## Refresh a feed

Re-fetches the RSS and upserts episodes by `guid`: new episodes are added, existing ones get their title, description, audio URL, date, duration and image updated, while `played`/`play_position` are kept. Updates `last_fetched`, and re-caches the cover art if the cached file is missing from disk.

* **URL:** `POST /api/v1/podcast/feeds/:id/refresh`

**Response `200`:** Updated feed object.

---

## Get episodes for a feed

* **URL:** `GET /api/v1/podcast/episodes/:feedId`

Returns episodes sorted by `pub_date DESC` (newest first).

**Response `200`:** Array of episode objects:
```json
[
  {
    "id":            42,
    "feed_id":       1,
    "guid":          "https://example.com/ep42",
    "title":         "Episode 42",
    "description":   "Plain text...",
    "audio_url":     "https://media.example.com/ep42.mp3",
    "pub_date":      1742400000,
    "duration_secs": 2847,
    "img":           null,
    "played":        0,
    "play_position": 0,
    "created_at":    1742490000
  }
]
```

---

## Save episode playback progress

* **URL:** `POST /api/v1/podcast/episode/progress`

**Body:**

| Field | Required | Description |
|---|---|---|
| `episodeId` | Yes | Episode `id` |
| `feedId` | Yes | Feed `id` — verifies ownership |
| `position` | Yes | Playback position in seconds (float) |
| `played` | No | Boolean flag |

**Response `200`:** `{}`

---

## Get episode playback progress

* **URL:** `GET /api/v1/podcast/episode/:id/progress`

**Response `200`:**
```json
{ "episodeId": 42, "feedId": 1, "play_position": 312.5, "played": false, "duration_secs": 2847 }
```

`404` when the episode does not exist or its feed is not yours.

---

## Save episode audio to library

Downloads the episode audio file from the podcast CDN and saves it to the server's AudioBooks/Podcasts folder. The file is streamed directly to disk — not buffered in RAM, safe for large files.

* **URL:** `POST /api/v1/podcast/episode/save`

**Body:**

| Field | Required | Description |
|---|---|---|
| `feedId` | Yes | Feed `id` — verifies the feed belongs to the current user |
| `episodeId` | Yes | Episode `id` — must belong to the given `feedId` |

**Behaviour:**

1. Looks up the first `audio-books` vpath the user has access to.
2. Creates `<vpath root>/<feed title>/` if it does not exist.
3. SSRF-checks the episode `audio_url` (must be `http`/`https`, not private range).
4. Streams the remote audio to `<YYYY-MM-DD Episode Title>.ext` (extension from URL path or `Content-Type` header; defaults to `.mp3`).
5. Deletes the partial file on any write error.

**Response `200`:**
```json
{ "savedTo": "AudioBooks-Podcasts/Global News Podcast/2026-03-24 Episode Title.mp3" }
```

**Errors:**

| Code | Reason |
|---|---|
| `400` | Validation error, no `audio-books` vpath configured for this user, invalid or SSRF-blocked audio URL |
| `404` | Feed or episode not found / not owned by current user |
| `502` | Remote CDN fetch failed |
| `500` | Disk write error |
