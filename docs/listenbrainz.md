# ListenBrainz Scrobbling

Velvet supports scrobbling to [ListenBrainz](https://listenbrainz.org/) — the open-source, privacy-friendly alternative to Last.fm. ListenBrainz has no rate limits and does not require a paid or external account beyond a free registration.

## How It Works

Velvet submits two types of events to ListenBrainz for every track you play:

| Event | When | What it does |
|-------|------|--------------|
| **Listening Now** | Immediately at track start | Appears on your ListenBrainz profile dashboard **instantly** under "Listening Now" |
| **Scrobble** | 30 seconds after track starts | Permanently recorded in your listen history |

ListenBrainz and Last.fm can be active simultaneously: if both are configured, both receive every event. The now-playing badge shows "Last.fm ✓ · ListenBrainz ✓" (or each service independently).

> **Why two events?** ListenBrainz's permanent listen history can take 10–20 minutes to show after submission. The "Listening Now" ping appears on your profile instantly, so your friends and followers see what you're playing in real time.

## Admin Setup

1. Go to **Admin panel → External Services → ListenBrainz**.
2. Tick **Enable ListenBrainz scrobbling for users** and save.

This enables the feature server-wide. Users who have not connected a token are unaffected.

## User Setup

1. Get your token at **[listenbrainz.org/settings](https://listenbrainz.org/settings/)** (scroll to "User Token").
2. In the main app sidebar, click **ListenBrainz** (only visible when admin has enabled it).
3. Paste the token and click **Connect**. Velvet validates the token with the ListenBrainz API before saving.
4. To stop scrobbling, click **Disconnect**.

## Token Storage

Tokens are stored in the Velvet config file (`save/conf/default.json`):
- **Multi-user mode**: under `users.<username>.listenbrainz-token`
- **No-auth mode**: under `listenBrainz.noAuthToken`

Tokens survive server restarts in both modes.

## Listening Now (Now Playing)

When you start a track, Velvet immediately sends a `playing_now` notification to ListenBrainz. This:

- Shows your current track under **"Listening Now"** on your public ListenBrainz profile page
- Updates in real time as you skip between tracks
- Is visible to anyone who visits your ListenBrainz profile
- Disappears automatically once you stop playing or the session ends

This is separate from your listen history — it requires no waiting and no delay.

## API Endpoints

| Method | Path | Access |
|--------|------|--------|
| `GET` | `/api/v1/admin/listenbrainz/config` | Admin only |
| `POST` | `/api/v1/admin/listenbrainz/config` | Admin only — body: `{ enabled: boolean }` |
| `GET` | `/api/v1/listenbrainz/status` | Any authenticated user — returns `{ serverEnabled, linked }` |
| `POST` | `/api/v1/listenbrainz/connect` | Any authenticated user — body: `{ token }` |
| `POST` | `/api/v1/listenbrainz/disconnect` | Any authenticated user |
| `POST` | `/api/v1/listenbrainz/playing-now` | Any authenticated user — body: `{ filePath }` — sends instant Listening Now ping |
| `POST` | `/api/v1/listenbrainz/scrobble-by-filepath` | Any authenticated user — body: `{ filePath }` — records permanent listen after 30 s |

## ListenBrainz API Used

- **Validate token:** `GET https://api.listenbrainz.org/1/validate-token` (Authorization: Token)
- **Listening Now ping:** `POST https://api.listenbrainz.org/1/submit-listens` with `listen_type: "playing_now"` — no `listened_at` field; sent at track start
- **Scrobble:** `POST https://api.listenbrainz.org/1/submit-listens` with `listen_type: "single"` — includes `listened_at` Unix timestamp; sent after 30 s
