**Podcast Feeds & Episodes** *(GitHub Copilot, 2026-03-21)*

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

**Errors:** `400` for invalid URL, SSRF-blocked address, HTTP errors, non-RSS XML, or feeds with no audio episodes.

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
    "episode_count": 257
  }
]
```

`img` is a relative filename; retrieve cover art at `/album-art/{img}`.

---

## Subscribe to a feed

* **URL:** `POST /api/v1/podcast/feeds`

**Body:**

| Field | Required | Description |
|---|---|---|
| `url` | Yes | `http`/`https` RSS URL, max 2048 chars. |
| `name` | No | Custom display name; overrides the feed's own title. |

**Behaviour:** SSRF check → fetch+parse RSS → download+cache cover art → insert feed + episodes → return new feed object.

**Error `400`:** Feed URL already subscribed, or upstream fetch/parse failure.

---

## Reorder feeds

Persist a new drag-reorder sequence.

* **URL:** `PUT /api/v1/podcast/feeds/reorder`

**Body:** `{ "ids": [3, 1, 2] }` — complete ordered array of the user's feed IDs.

**Response `200`:** `{}`

---

## Rename a feed

* **URL:** `PATCH /api/v1/podcast/feeds/:id`

**Body:** `{ "title": "My Custom Name" }`

**Response `200`:** Updated feed object.

---

## Delete (unsubscribe) a feed

Deletes the feed and all its episodes. Cached cover art is deleted from disk if no other feed references it.

* **URL:** `DELETE /api/v1/podcast/feeds/:id`

**Response `200`:** `{}`

---

## Refresh a feed

Re-fetches the RSS and upserts new episodes. Existing episodes are never overwritten (preserves `played`/`play_position`). Updates `last_fetched`.

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
| `played` | No | Boolean flag (default `false`) |

**Response `200`:** `{}`

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
