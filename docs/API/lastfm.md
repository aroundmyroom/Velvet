# Last.fm Integration

Velvet integrates with [Last.fm](https://www.last.fm) so every song you play is automatically scrobbled to your profile.  
Authentication uses the Last.fm **Mobile Session** flow — your password is sent once to Last.fm, a session key is returned and stored, and the password is never saved to disk.

---

## How it works for users

1. Open **Connectors → Last.fm** in the player sidebar.
2. Enter your Last.fm username and Last.fm password and click **Connect**.
3. Velvet authenticates with Last.fm and stores only the session key in `save/conf/default.json`.  
   Your password is discarded immediately.
4. After 30 seconds of continuous playback, the track is scrobbled automatically.
5. The **Now Playing details modal** shows **Last.fm: Scrobbled ✓** (green) after a successful scrobble or an error message (red) if it failed.
6. To unlink your Last.fm account, click **Disconnect** in the same section.

---

## Admin — enable/disable & API key management

Admins can enable or disable Last.fm scrobbling entirely from the **Last.fm** section of the Admin panel (Admin → Last.fm). When disabled:
- The Last.fm nav button is hidden in the player sidebar for all users.
- Scrobble timers never fire — no calls to Last.fm are made.

Admins enter the Last.fm API key and shared secret here. There is no built-in key: without one, connecting, scrobbling and similar-artists do not work.

- The shared secret is only returned to admins (via the admin config endpoint below); regular users never receive it.
- All changes take effect immediately without restarting the server.

To get your own credentials: <https://www.last.fm/api/account/create>

---

## API Endpoints

All endpoints require a valid user token (`x-access-token` header or `token` query param).

---

### GET `/api/v1/lastfm/status`

Returns whether Last.fm is enabled server-side and the Last.fm username currently linked to the authenticated Velvet user.

**Response**
```json
{ "serverEnabled": true, "hasApiKey": true, "linkedUser": "yourusername" }
```
`hasApiKey` is `true` when an API key is configured.
Returns `null` for `linkedUser` when no account is linked.  
`serverEnabled` is `false` when the admin has disabled Last.fm — the player uses this to hide the nav button and suppress scrobbling for all users.

---

### POST `/api/v1/lastfm/connect`

Authenticates with Last.fm and links the account to the current Velvet user.  
The password is used once to obtain a session key and is never stored.

**Request body**
```json
{
  "lastfmUser":     "yourusername",
  "lastfmPassword": "your-lastfm-password"
}
```

**Response** (success)
```json
{ "linkedUser": "yourusername" }
```

**Errors**
| Status | Meaning |
|--------|---------|
| 401 | Last.fm rejected the credentials (wrong username/password or API key) |
| 502 | Could not reach Last.fm |

---

### POST `/api/v1/lastfm/disconnect`

Removes the Last.fm link for the current Velvet user.  
Clears `lastfm-user`, `lastfm-session`, and `lastfm-password` (legacy) from config and runtime.

**Request body** — empty `{}`

**Response** — `{}`

---

### POST `/api/v1/lastfm/scrobble-by-filepath`

Scrobbles a track by its Velvet filepath to Last.fm.  
This is the endpoint the player calls automatically after 30 seconds of playback. It does not
change the play count: that is raised once per play by `POST /api/v1/db/stats/log-play` at the start.

**Request body**
```json
{ "filePath": "Music/Artist/Album/track.mp3" }
```

**Response** — `{}`

Also returns `{}` when no Last.fm account is linked (nothing is sent).  
Returns `{ "scrobble": false }` when the file is not found in the database for this user.

---

### POST `/api/v1/lastfm/scrobble-by-metadata`

Scrobbles a track by providing the metadata directly (no file lookup).

**Request body**
```json
{
  "track":  "Heroes",
  "artist": "David Bowie",
  "album":  "Heroes"
}
```
`track` is required; `artist` and `album` are optional.

**Response** — `{ "scrobble": false }` if no Last.fm account is linked, otherwise `{}`

---

### GET `/api/v1/lastfm/similar-artists`

Returns similar artists from Last.fm for the given artist name, resolved to library artist names.

**Query param** — `?artist=David+Bowie`

**Response** — `{ artists, displayArtists, displayVariantMap, variantRankMap }`. See [lastfm_similar-artists.md](lastfm_similar-artists.md).

---

### GET `/api/v1/lastfm/artist-info`

Artist bio and stats from Last.fm.

**Query param** — `?artist=David+Bowie`

**Response**
```json
{ "bio": "David Robert Jones …", "tags": ["rock", "glam rock"], "listeners": 4000000, "plays": 300000000 }
```
`bio` is the Last.fm summary with HTML removed; `tags` holds up to 5 tags. Returns `{}` when there is no API key or Last.fm does not know the artist.

---

### GET `/api/v1/admin/lastfm/config`  *(admin only)*

Returns the current Last.fm server configuration.

**Response**
```json
{
  "enabled":   true,
  "apiKey":    "your-lastfm-api-key",
  "apiSecret": "your-lastfm-shared-secret"
}
```
Both values are returned as stored (empty string when not set). This endpoint is admin-only.

---

### POST `/api/v1/admin/lastfm/config`  *(admin only)*

Updates the global Last.fm enabled flag, API key, and shared secret.  
Takes effect immediately — no server restart required.

**Request body**
```json
{
  "enabled":   true,
  "apiKey":    "your-lastfm-api-key",
  "apiSecret": "your-lastfm-shared-secret"
}
```

**Response** — `{}`

---

## Config file reference

After a user connects, their `save/conf/default.json` will contain:

```json
"users": {
  "dennis": {
    "password": "<pbkdf2 hash>",
    "salt": "<salt>",
    "vpaths": ["Music"],
    "lastfm-user":    "yourusername",
    "lastfm-session": "<session key from Last.fm>"
  }
}
```

`lastfm-password` is a legacy field kept for backwards compatibility.  
On next connect, it is replaced by `lastfm-session` and the plain-text password is removed.

---

## Scrobble timing

| Event | Trigger |
|-------|---------|
| Song starts playing | 30-second countdown begins |
| User skips before 30 s | Timer is cancelled — no scrobble |
| Crossfade / gapless handoff | Timer restarts for the new track |
| Server restart | Session key is loaded from config — scrobbling resumes immediately |
