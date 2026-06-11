# Podcasts & Feeds

Velvet includes a full server-side podcast feed subscription system. Users subscribe to RSS 2.0 feed URLs and browse episodes directly from the sidebar. No external podcast service or account is required.

---

## Navigation

The **Listen** section in the sidebar contains:

| Button | View |
|---|---|
| **Podcasts** | All subscribed feeds as a card grid |
| **Feeds** | Subscribe / manage podcast feeds |
| **Radio Streams** | Live radio (shown when enabled) |

The Listen section is only visible when at least one of the following is true:
- A radio station is configured
- At least one podcast feed is subscribed
- An `audio-books` folder is configured

---

## Feed Card Grid

Each subscribed feed is shown as a card with:
- Cover art (downloaded and cached locally)
- Feed title, author
- Episode count + last refreshed timestamp
- **Refresh** button — re-fetches the RSS and upserts any new episodes
- **Rename** button — set a custom display name for the feed
- **Unsubscribe** button — removes the feed and all its episodes; cached cover art is deleted if no other feed references it

Cards can be **drag-reordered** using the six-dot handle that appears on hover. The new order is persisted immediately.

---

## Episode List

Clicking a feed card opens the episode list for that feed:
- Episodes sorted newest first
- Each row shows: title, publish date, duration, a **Save** button, and a **Play** button
- Click **Play** to stream the episode through the standard player bar (seek, volume, crossfade all work normally)
- Click **Save** (↓ icon) to download and save the episode audio to the server's AudioBooks/Podcasts folder (see below)
- A back arrow returns to the feed card grid

---

## Save Episode to Library

The **Save** button on each episode row downloads the episode audio file directly from the podcast CDN to the server.

### How it works
1. The button sends `POST /api/v1/podcast/episode/save` with `feedId` and `episodeId`.
2. The server finds the first `audio-books` vpath the user has access to.
3. A subfolder named after the podcast feed title is created inside that vpath root if it doesn't exist.
4. The episode audio is streamed (not buffered in RAM) from the remote CDN to disk.
5. On success a toast shows the saved filename; on error a red toast shows the reason.

### Saved file path
```
<AudioBooks vpath root>/<Feed Title>/<YYYY-MM-DD Episode Title>.ext
```
Example: `Audiobooks & Podcasts/Global News Podcast/2026-06-17 Global News Podcast.mp3`

### File naming rules
- Feed title and episode title are sanitised: path-special characters (`/ \ : * ? " < > |`) stripped, repeated `..` collapsed, leading/trailing whitespace removed.
- Feed subfolder name capped at 80 characters; episode name capped at 100 characters.
- File extension comes from the URL path (`.mp3`, `.m4a`, `.ogg`, etc.); if not present, falls back to the `Content-Type` header; defaults to `.mp3`.

### Button states
| State | Appearance |
|---|---|
| Idle | Download arrow (↓) icon, dimmed |
| Saving | Spinning arc |
| Saved | Green ✓; toast "Saved: filename.mp3" |
| Error | Red ✕; error toast with reason |

The button resets to idle after 4 seconds so the episode can be saved again if needed.

### Requirements
- At least one `audio-books` vpath must be configured and accessible to the user.
- The episode audio URL must be an `http`/`https` URL and must not point to a private/local network range (SSRF protection).

---

## Playback

Podcast episodes play through the existing player. The audio URL from the RSS `<enclosure>` or `<ppg:enclosureSecure>` element (BBC/HTTPS) is streamed via the server-side radio stream proxy (`GET /api/v1/radio/stream`) for full same-origin Web Audio API compatibility.

Because a podcast episode uses an external URL as its filepath, the following normally-automatic player actions are **silently skipped**:
- Waveform fetch
- Song rating (star) save
- Last.fm scrobbling (no filepath in DB)

---

## RSS Parsing

The server uses `fast-xml-parser` v5 to parse RSS 2.0 feeds. Supported feed types have been validated against:

| Feed | Source | Notes |
|---|---|---|
| BBC Global News Podcast | `podcasts.files.bbci.co.uk` | `<ppg:enclosureSecure>` for HTTPS audio; `<itunes:duration>` as integer seconds |
| NHK World Radio Japan | `www3.nhk.or.jp` | Standard `<enclosure>`; `<itunes:duration>` as integer seconds |
| Anchor/Spotify feeds | `anchor.fm` | `<itunes:duration>` as `HH:MM:SS` string; `<guid>` as plain UUID |

**Duration normalisation:** `_parseDuration()` handles both integer seconds (`1690`) and `HH:MM:SS` / `MM:SS` strings (`00:51:54`).

**HTML cleaning:** episode descriptions often contain raw HTML tags and entity-encoded HTML (`&lt;p&gt;`). Both forms are stripped to produce plain text.

**Entities decoded:** after stripping tags, standard XML entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&#nnnn;`, `&#xhhhh;`) are decoded so plain text reads correctly.

**processEntities: false** is set on the parser — feeds like Anchor/Spotify embed hundreds of HTML entities in `<itunes:summary>` fields; the default entity limit of 1000 is easily exceeded with large episode archives.

---

## Cover Art

When subscribing (or on refresh when art is not yet cached), the server:

1. Downloads the cover art URL from `<itunes:image href>` or `<image><url>`
2. Validates the `Content-Type` is `image/*`
3. Saves it as `podcast-{md5hash}.{ext}` in the album-art directory
4. The filename stored in the DB is relative; the client resolves it via `/album-art/{filename}`

Art is shared: if two feeds happen to have the same image URL, they share the same cached file. The file is deleted only when the last feed referencing it is unsubscribed.

The orphan-cleanup script (`cleanup-albumart.mjs`) recognises `podcast-*` filenames as live references and never deletes them.

---

## SSRF Protection

All outbound fetch calls (RSS fetch, art download) pass through `_ssrfCheck(hostname)`, which blocks:
- `localhost`, `::1`
- `127.x.x.x`
- RFC-1918 private ranges: `10.x.x.x`, `192.168.x.x`, `172.16–31.x.x`

Any URL matching these ranges returns `400 {"error":"That URL is not allowed"}`.

---

## Database Schema

Two tables are created on first boot (both SQLite and in-memory Loki backends):

### `podcast_feeds`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `user` | TEXT | Owner username |
| `url` | TEXT | RSS feed URL |
| `title` | TEXT | Display name (may be overridden by user rename) |
| `description` | TEXT | Feed description (HTML-stripped) |
| `img` | TEXT | Local filename (`podcast-{hash}.{ext}`) or null |
| `author` | TEXT | From `<itunes:author>` |
| `language` | TEXT | From `<language>` |
| `last_fetched` | INTEGER | Unix timestamp of last refresh |
| `sort_order` | INTEGER | Drag-reorder position (0 = first) |
| `created_at` | INTEGER | Unix timestamp of subscription |

Index: `idx_pf_user` on `(user)`.

### `podcast_episodes`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `feed_id` | INTEGER FK | References `podcast_feeds.id` |
| `guid` | TEXT | From RSS `<guid>` — unique per feed |
| `title` | TEXT | Episode title (HTML-stripped) |
| `description` | TEXT | Episode description (HTML-stripped) |
| `audio_url` | TEXT | Direct HTTPS audio URL |
| `pub_date` | INTEGER | Unix timestamp |
| `duration_secs` | INTEGER | Normalised to seconds |
| `img` | TEXT | Episode-level art URL (if present) |
| `played` | INTEGER | 0/1 flag |
| `play_position` | REAL | Resume position in seconds |
| `created_at` | INTEGER | Unix timestamp |

Unique constraint: `(feed_id, guid)` — prevents duplicate episodes on refresh. Upsert uses `INSERT OR IGNORE` so existing episode progress (`played`, `play_position`) is never overwritten when refreshing.

Index: `idx_pe_feed_id` on `(feed_id)`.

---

## REST API

All podcast endpoints require authentication (JWT token via `?token=` query param or `Authorization: Bearer` header). Users can only read and modify their own feeds and episodes.

---

### `GET /api/v1/podcast/preview`

Preview a feed URL without saving it. Used by the Subscribe form to show feed metadata before committing.

**Query params:**

| Param | Required | Description |
|---|---|---|
| `url` | yes | RSS feed URL (`http://` or `https://` only) |

**Response `200`:**
```json
{
  "title": "Global News Podcast",
  "description": "The latest world news from BBC...",
  "author": "BBC World Service",
  "language": "en",
  "imgUrl": "https://...",
  "episodeCount": 257
}
```

**Errors:**
- `400 {"error":"url is required"}` — no URL provided
- `400 {"error":"Invalid URL"}` — malformed URL
- `400 {"error":"That URL is not allowed"}` — SSRF-blocked address
- `400 {"error":"Feed returned HTTP 404"}` — upstream HTTP error
- `400 {"error":"Not a valid RSS 2.0 feed"}` — XML parsed but no `<rss><channel>`
- `400 {"error":"No audio episodes found in this feed"}` — feed has items but none have an audio enclosure

---

### `GET /api/v1/podcast/feeds`

Returns the authenticated user's subscribed feeds, ordered by `sort_order` ascending.

**Response `200`:** Array of feed objects:
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
    "created_at": 1742490000,
    "sort_order": 0,
    "episode_count": 257
  }
]
```

`img` is a relative filename; retrieve the art at `/album-art/{img}`.

---

### `POST /api/v1/podcast/feeds`

Subscribe to a new feed.

**Body:**
```json
{ "url": "https://example.com/feed.rss", "name": "Optional custom name" }
```

| Field | Required | Validation |
|---|---|---|
| `url` | yes | `http`/`https`, max 2048 chars |
| `name` | no | Max 200 chars; overrides the feed's own title if provided |

**Behaviour:**
1. SSRF check on the URL
2. Fetch + parse the RSS (15 s timeout, follows redirects)
3. Download and cache feed cover art
4. Insert feed row + all episodes into the DB
5. Return the newly created feed object (same shape as the list endpoint)

**Errors:** same as `/preview`, plus `400` if the feed URL is already subscribed.

---

### `PUT /api/v1/podcast/feeds/reorder`

Persist a new drag-reorder sequence.

**Body:**
```json
{ "ids": [3, 1, 2] }
```

`ids` is the complete ordered array of feed IDs belonging to the requesting user. The server sets `sort_order = position_index` for each ID. IDs not belonging to the user are ignored.

**Response `200`:** `{}`

---

### `PATCH /api/v1/podcast/feeds/:id`

Rename a feed.

**Body:**
```json
{ "title": "My Custom Name" }
```

**Response `200`:** Updated feed object.

**Errors:**
- `404 {"error":"Feed not found"}` — feed doesn't exist or belongs to another user

---

### `DELETE /api/v1/podcast/feeds/:id`

Unsubscribe from a feed. Cascades: all episodes for that feed are deleted. If no other feed references the same cover art file, the cached image is deleted from disk.

**Response `200`:** `{}`

**Errors:**
- `404 {"error":"Feed not found"}`

---

### `POST /api/v1/podcast/feeds/:id/refresh`

Re-fetch the RSS and upsert any new episodes. Existing episodes are never overwritten (their `played`/`play_position` values are preserved). Updates `last_fetched`.

**Response `200`:** Updated feed object (with refreshed `episode_count` and `last_fetched`).

**Errors:**
- `404 {"error":"Feed not found"}`
- `400` — upstream fetch or parse error

---

### `GET /api/v1/podcast/episodes/:feedId`

Returns all episodes for a feed, sorted by `pub_date DESC, id DESC` (newest first).

The feed must belong to the requesting user.

**Response `200`:** Array of episode objects:
```json
[
  {
    "id": 42,
    "feed_id": 1,
    "guid": "https://example.com/episodes/ep42",
    "title": "Episode 42: Something Interesting",
    "description": "Plain text description...",
    "audio_url": "https://media.example.com/ep42.mp3",
    "pub_date": 1742400000,
    "duration_secs": 2847,
    "img": null,
    "played": 0,
    "play_position": 0,
    "created_at": 1742490000
  }
]
```

**Errors:**
- `404 {"error":"Feed not found"}`

---

### `POST /api/v1/podcast/episode/progress`

Save playback progress for an episode (resume position and played flag).

**Body:**
```json
{
  "episodeId": 42,
  "feedId": 1,
  "position": 183.5,
  "played": false
}
```

| Field | Required | Description |
|---|---|---|
| `episodeId` | yes | Episode `id` |
| `feedId` | yes | Feed `id` — used to verify ownership |
| `position` | yes | Current playback position in seconds (float) |
| `played` | no | Boolean; defaults to `false` |

**Response `200`:** `{}`

**Errors:**
- `400` — validation failure
- `404 {"error":"Feed not found"}` — feed doesn't exist or belongs to another user
