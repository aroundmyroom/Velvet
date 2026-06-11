# ID3 Tag Editing

Velvet lets admins edit the ID3/Vorbis/MP4 metadata tags stored inside audio files directly from the **Now Playing** modal.  
Tags are rewritten using ffmpeg (`-codec copy` — no re-encode) and the database record is updated immediately so the UI reflects the change without a rescan.

All endpoints below are **admin-only**.

---

## Prerequisites

ID3 tag editing must be enabled in the admin panel before the edit UI appears in the player:

1. Admin panel → **Database** section
2. Find the **"Allow ID3 Tag Editing"** row and click **[edit]**
3. Confirm the change

This writes `scanOptions.allowId3Edit = true` to the server config file.

---

## Enable / Disable

### `POST /api/v1/admin/db/params/allow-id3edit`

Toggles the `allowId3Edit` setting and persists it to the config file.

**Auth**: admin token required.

**Body**
```json
{ "allowId3Edit": true }
```

| Field | Type | Description |
|-------|------|-------------|
| `allowId3Edit` | boolean | `true` to enable, `false` to disable |

**Response**
```json
{}
```

---

## Discogs config — `allowId3Edit` field

[`GET /api/v1/admin/discogs/config`](discogs.md) now includes `allowId3Edit` in its response so the player can decide whether to show the **Edit Tags** button in the Now Playing modal on login and session restore:

```json
{
  "enabled": true,
  "allowArtUpdate": false,
  "allowId3Edit": true,
  "apiKey": "…",
  "apiSecret": "…",
  "userAgentTag": "amr"
}
```

---

## Write Tags

### `POST /api/v1/admin/tags/write`

Rewrites the metadata tags of an audio file on disk using ffmpeg, then updates the corresponding database record.

The operation is **atomic at the filesystem level**: ffmpeg writes to a temporary file in the same directory as the source, then the file is replaced with a single `rename(2)` syscall — the server never serves a partially-written file.

**Auth**: admin token required. `allowId3Edit` must be `true` in server config.

**Body**
```json
{
  "filepath": "Music/Artist/Album/track.mp3",
  "title":    "Fire",
  "artist":   "Dr. Alban",
  "album":    "Look Who's Talking! (The Album)",
  "year":     "1994",
  "genre":    "Eurodance",
  "track":    "7",
  "disk":     "1"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `filepath` | string | ✓ | vpath-relative path as returned by any DB query (e.g. `"Music/folder/file.mp3"`). Must be a path the authenticated user has access to. |
| `title`    | string |   | Pass `""` to explicitly clear the tag. Omit to leave unchanged — **not supported yet; all fields are written when provided.** |
| `artist`   | string |   | |
| `album`    | string |   | |
| `year`     | string or number |   | Mapped to ffmpeg's `date` metadata key. |
| `genre`    | string |   | |
| `track`    | string or number |   | |
| `disk`     | string or number |   | Mapped to ffmpeg's `disc` metadata key. |

**Supported formats**: Any container ffmpeg can demux/remux losslessly — MP3, FLAC, OGG, M4A, M4B, OPUS, AAC, WAV, AIFF, W64, etc.  
For containers that do not support certain tag keys (e.g. WAV has limited metadata support) ffmpeg silently ignores inapplicable keys.

**Process**
1. Resolve the absolute path via `getVPathInfo(filepath, user)` (same path resolver used by Discogs embed)
2. Build ffmpeg `-metadata key=value` arguments for each provided field
3. Run: `ffmpeg -y -i <source> -map 0 -map_metadata 0 -codec copy -metadata … <tmpfile>`
4. Atomically replace source with `tmpfile` via `rename(2)` (same filesystem — no cross-device copy)
5. Update the `files` table in the database: `title`, `artist`, `album`, `year`, `genre`, `track`, `disk`

**Response**
```json
{ "ok": true }
```

**Error responses**

| Status | Meaning |
|--------|---------|
| 400    | `filepath` missing, invalid, or vpath access denied |
| 403    | Not an admin, or `allowId3Edit` is disabled |
| 404    | File not found on disk |
| 500    | ffmpeg error |

---

## Player behaviour

When tag editing is enabled (`allowId3Edit: true`) and the user is logged in as admin, a **✏ Edit Tags** button appears in the **Now Playing** modal beneath the file-path row.

Pressing it reveals an inline form pre-filled with the current tag values. The **Title** field includes a 📄 button next to it — clicking it fills the title input with the filename (last path segment, extension stripped, leading track number pattern like `01 - ` or `01. ` removed). This is useful for songs that have no embedded title tag. On **Apply**:

1. The tags are sent to `POST /api/v1/admin/tags/write`.
2. All matching entries in the in-memory playback queue are updated so the player bar and queue panel reflect the new values immediately.
3. If the edited song is currently loaded in the audio element, `audioEl.load()` is called so the browser re-fetches the newly written file (seeking back to the previous position and resuming playback automatically), preventing any "unplayable file" decode errors from the browser reading a stale stream.

### Write-access guard

The **Edit Tags** button and Discogs/Deezer/iTunes art-search buttons are only shown when the server process has write permission to the song's folder. `GET /api/v1/ping` now includes a `vpathWriteAccess: { [vpathName]: bool }` map (admin-only) checked on every login. If the flag is `false` for the relevant vpath, the art-search section is hidden and attempting to open the album art picker shows a toast: *"Velvet does not have write access to this folder"*.
