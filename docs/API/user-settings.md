# User Settings — `/api/v1/user/settings`

*GitHub Copilot, 2026-03-18*

Persists all user preferences and the playback queue to the server database, keyed by username. Enables seamless session handoff across browsers and devices — load the page on any device and resume exactly where you left off.

---

## GET `/api/v1/user/settings`

Returns the stored preferences and queue for the authenticated user.

**Auth:** `x-access-token` header (or session cookie)

**Response**

```json
{
  "prefs": {
    "vol": "80",
    "balance": "0",
    "theme": "velvet",
    "bar_top": "0",
    "repeat": "all",
    "crossfade": "5",
    "gapless": "1",
    "rg": "1",
    "eq": "[0,0,0,0,0,0,0,0]",
    "eq_on": "true",
    "trans": "1",
    "trans_codec": "mp3",
    "trans_bitrate": "192",
    "trans_algo": "fast",
    "vu_mode": "ppm",
    "ppm_bright": "1",
    "spec_style": "bars",
    "ref": "0",
    "time_flipped": "0",
    "dyn_color": "1",
    "auto_resume": "1",
    "autodj": "1",
    "dj_similar": "1",
    "dj_dice": "0",
    "dj_min_rating": "6",
    "dj_vpaths": "[\"Music\"]",
    "dj_filter_on": "1",
    "dj_filter_words": "[\"live\",\"remix\"]",
    "dj_ignore": "[]",
    "dj_artist_history": "[\"Radiohead\",\"Björk\"]"
  },
  "queue": {
    "queue": [
      { "filepath": "Music/artist/album/01-song.flac", "title": "Song", "artist": "Artist", "album": "Album" }
    ],
    "idx": 0,
    "time": 143.2,
    "playing": true,
    "savedAt": 1742300000000
  }
}
```

All `prefs` values are raw strings (as stored in localStorage). Missing keys mean the user has not set that preference yet — apply defaults.

`queue.savedAt` is a Unix millisecond timestamp of when the queue was last written. `queue` may be `null` if the user has never persisted a queue.

---

## POST `/api/v1/user/settings`

Saves preferences and/or queue for the authenticated user. The body is **merged** — you can send only `prefs`, only `queue`, or both in one call.

**Auth:** `x-access-token` header (or session cookie)  
**Content-Type:** `application/json`

**Body**

```json
{
  "prefs": { "vol": "75", "theme": "dark" },
  "queue": {
    "queue": [ { "filepath": "Music/...", "title": "...", "artist": "..." } ],
    "idx": 0,
    "time": 0,
    "playing": false,
    "savedAt": 1742300001000
  }
}
```

Both `prefs` and `queue` are optional. `prefs` is merged at the key level (only supplied keys are updated). `queue` replaces the entire stored queue object.

**Response**

```json
{ "ok": true }
```

---

## Usage pattern for iOS / native clients

```
1. POST /api/v1/auth/login          → receive token
2. GET  /api/v1/user/settings       → restore queue + prefs on startup
3. POST /api/v1/user/settings       → save on song change, setting change, app background
```

Always include `savedAt: Date.now()` in the queue object. It is stored as metadata and visible in the response so clients can show when the queue was last saved.
