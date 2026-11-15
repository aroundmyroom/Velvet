# ListenBrainz Scrobbling

Velvet supports scrobbling to [ListenBrainz](https://listenbrainz.org/), the open-source alternative to Last.fm. You only need a free ListenBrainz account.

## How It Works

Velvet submits two types of events to ListenBrainz for every track you play:

| Event | When | What it does |
|-------|------|--------------|
| **Listening Now** | Immediately at track start | Shows under "Listening Now" on your ListenBrainz profile |
| **Scrobble** | 30 seconds after track starts | Permanently recorded in your listen history |

Radio streams and podcast episodes are not sent.

ListenBrainz and Last.fm can be active simultaneously: if both are configured, both receive every event. The Now Playing view shows a badge per service (for example "ListenBrainz ✓" after a successful scrobble, "ListenBrainz ✗" after a failure).

When a song plays in a [Velvet Room](rooms.md), the server sends both events itself for the user who started the song, so they also arrive when no browser is open.

## Admin Setup

1. Go to **Admin panel → External Services → ListenBrainz**.
2. Tick **Enable ListenBrainz scrobbling for users** and save.

This enables the feature server-wide. Users who have not connected a token are unaffected.

## User Setup

1. Get your token at **[listenbrainz.org/settings](https://listenbrainz.org/settings/)** (scroll to "User Token").
2. In the main app sidebar, click **ListenBrainz**.
3. Paste the token and click **Connect**. Velvet validates the token with the ListenBrainz API before saving.
4. To stop scrobbling, click **Disconnect**.

Plays reported by Subsonic clients are forwarded to ListenBrainz only when the user turns on **Forward to ListenBrainz** in the player's **Subsonic** page.

## Token Storage

Tokens are stored in the Velvet config file (`save/conf/default.json`):
- **Multi-user mode**: under `users.<username>.listenbrainz-token`
- **No-auth mode**: under `listenBrainz.noAuthToken`

Tokens survive server restarts in both modes.

## API Endpoints

| Method | Path | Access |
|--------|------|--------|
| `GET` | `/api/v1/admin/listenbrainz/config` | Admin only — returns `{ enabled }` |
| `POST` | `/api/v1/admin/listenbrainz/config` | Admin only — body: `{ enabled: boolean }` — returns `{}` |
| `GET` | `/api/v1/listenbrainz/status` | Any authenticated user — returns `{ serverEnabled, linked }` |
| `POST` | `/api/v1/listenbrainz/connect` | Any authenticated user — body: `{ lbToken }` — returns `{ linked: true, lbUsername }`, or 401 when ListenBrainz rejects the token |
| `POST` | `/api/v1/listenbrainz/disconnect` | Any authenticated user — returns `{}` |
| `POST` | `/api/v1/listenbrainz/playing-now` | Any authenticated user — body: `{ filePath }` — sends the Listening Now ping; returns `{ sent }` (`false` when there is no token or the file is unknown) |
| `POST` | `/api/v1/listenbrainz/scrobble-by-filepath` | Any authenticated user — body: `{ filePath }` — records the listen; returns `{}`, or `{ scrobble: false }` when there is no token or the file is unknown |

The player calls the last two only when the admin switch is on and the user is linked.

## ListenBrainz API Used

- **Validate token:** `GET https://api.listenbrainz.org/1/validate-token` (Authorization: Token)
- **Listening Now ping:** `POST https://api.listenbrainz.org/1/submit-listens` with `listen_type: "playing_now"` — no `listened_at` field; sent at track start
- **Scrobble:** `POST https://api.listenbrainz.org/1/submit-listens` with `listen_type: "single"` — includes `listened_at` Unix timestamp; sent after 30 s

Each submission includes artist, title and album (when present), with `submission_client` and `media_player` set to `Velvet`. Requests time out after 8 seconds.
