# Podcasts & Feeds

Velvet includes a full server-side podcast feed subscription system. Users subscribe to RSS 2.0 feed URLs and browse episodes directly from the sidebar. No external podcast service or account is required.

---

## Navigation

The **Streams & Feeds** section in the sidebar contains:

| Button | View |
|---|---|
| **Audio Content** | Your `audio-books`, `recordings` and `youtube` folders |
| **Podcast Feeds** | Subscribe to feeds and manage them (card grid) |
| **YouTube** | YouTube download (when allowed) |
| **Radio Streams** | Live radio (shown when radio is enabled) |
| **Sonos Radio** | Sonos radio (when Sonos is set up) |

Podcast Feeds is always available, so the section is always shown: you need
it to add your first feed.

The subscribed feeds also appear as a shelf on the **Shortcuts** view (see
[home-view.md](home-view.md)).

---

## Feed Card Grid

The **Podcast Feeds** view has a subscribe form (RSS URL, optional name,
**Preview** before **Subscribe**) and the subscribed feeds. Each feed is shown
as a card with:
- Cover art (downloaded and cached locally)
- Feed title, author
- Episode count, date of the latest episode and last refreshed timestamp
- **Refresh** button — re-fetches the RSS and adds new episodes
- **Rename** button — edit the display name and the feed URL
- **Unsubscribe** button — removes the feed and all its episodes; cached cover art is deleted if no other feed references it

Cards can be **drag-reordered** using the drag handle. The new order is saved immediately.

---

## Episode List

Clicking a feed card opens the episode list for that feed:
- Episodes sorted newest first
- Each row shows: title, publish date, duration, a **Save** button, and a **Play** button
- Click **Play** to stream the episode through the standard player bar; an episode you were part-way through resumes where you left off
- Click **Save** (↓ icon) to download and save the episode audio to the server's AudioBooks/Podcasts folder (see below)
- A back arrow returns to the feed card grid

---

## Save Episode to Library

The **Save** button on each episode row downloads the episode audio file directly from the podcast CDN to the server.

### How it works
1. The button sends `POST /api/v1/podcast/episode/save` with `feedId` and `episodeId`.
2. The server takes the first `audio-books` vpath in the user's vpath list.
3. A subfolder named after the podcast feed title is created inside that vpath root if it doesn't exist.
4. The episode audio is streamed (not buffered in RAM) from the remote CDN to disk (2-minute timeout to start the download).
5. The server answers `{ savedTo: "<vpath>/<Feed Title>/<file>" }`; the player shows a toast with the file name, or a red toast with the reason.

### Saved file path
```
<AudioBooks vpath root>/<Feed Title>/<YYYY-MM-DD Episode Title>.ext
```
Example: `Audiobooks & Podcasts/Global News Podcast/2026-06-17 Global News Podcast.mp3`

### File naming rules
- Feed title and episode title are sanitised: path-special characters (`/ \ : * ? " < > |`) stripped, runs of dots collapsed to one, whitespace collapsed and trimmed.
- Feed subfolder name capped at 80 characters; episode name capped at 100 characters.
- The date prefix is left out when the episode has no publish date.
- File extension comes from the URL path (`mp3`, `m4a`, `ogg`, `flac`, `opus`, `aac`, `wav`); if not present, from the `Content-Type` header; defaults to `.mp3`.

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

Podcast episodes play through the existing player. The audio URL from the RSS `<enclosure>`, `<ppg:enclosureSecure>` (BBC/HTTPS) or audio `<media:content>` element is streamed via the server-side radio stream proxy (`GET /api/v1/radio/stream`) for full same-origin Web Audio API compatibility.

Progress is saved to the server (`POST /api/v1/podcast/episode/progress`)
every 15 seconds while playing, on pause and when you switch to another
track; an episode that plays to the end is marked played. Resuming starts
from the saved position unless the episode is marked played, is within 2
seconds of the start, or within 30 seconds of the end.

Listening time is recorded for **Your Stats** (podcast card) with
`podcast-start` / `podcast-end` events — see [your-stats.md](your-stats.md).
Episodes are not logged as song plays and never appear in Recently Played.

Because a podcast episode uses an external URL as its filepath, the following normally-automatic player actions are **skipped**:
- Waveform fetch
- Song rating (star) save
- Scrobbling (Last.fm, ListenBrainz) and webhooks

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

1. Downloads the cover art URL from `<itunes:image href>` or `<image><url>` (10 s timeout)
2. Validates the `Content-Type` is `image/*`
3. Saves it as `podcast-{sha256 of the URL}.{ext}` in the album-art directory
4. The filename stored in the DB is relative; the client resolves it via `/album-art/{filename}`

On refresh the art is only downloaded again when the cached file is missing
from disk.

Art is shared: if two feeds happen to have the same image URL, they share the same cached file. The file (and its `zs-`/`zl-`/`zm-` thumbnails) is deleted only when the last feed referencing it is unsubscribed.

---

## SSRF Protection

All outbound fetches (RSS, art, episode download) use `isPrivateHost()` and
`safeFetch()` from `src/util/ssrf-check.js`. They block:
- `localhost` / `*.localhost`, `0.x.x.x`, `127.x.x.x`
- private ranges `10.x.x.x`, `192.168.x.x`, `172.16–31.x.x`
- link-local `169.254.x.x` (cloud metadata)
- IPv6 `::1`, `::`, `fc00::/7`, `fe80::/10` and IPv4-mapped forms of the above
- host names that resolve (DNS) to any of these addresses

Redirects are followed up to 5 hops, each hop checked again; only `http`/`https` is allowed.

A private address given directly in a feed URL returns `400 {"error":"That URL is not allowed"}`; one reached through DNS or a redirect returns `400` with the fetch error.

Every fetch also has a size cap and a time limit that cover the whole body: feeds 20 MB / 15 s, artwork 10 MB / 10 s, episode downloads 2 GiB / 60 min. A larger body or a slower server aborts the fetch.

---

## Database Schema

Two tables are created on first boot:

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

Unique constraint: `(feed_id, guid)` — prevents duplicate episodes on refresh. The upsert (`ON CONFLICT … DO UPDATE`) refreshes an existing episode's title, description, audio URL, date, duration and art, but never touches its progress (`played`, `play_position`). An item without a `<guid>` uses its audio URL as the guid.

Index: `idx_pe_feed_id` on `(feed_id)`.

---

## REST API

All podcast endpoints require authentication, and users can only read and modify their own feeds and episodes. The full request/response reference is in [API/podcasts.md](API/podcasts.md); the route list is in [API.md](API.md#podcasts-velvet).
