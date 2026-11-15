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

[`GET /api/v1/admin/discogs/config`](discogs.md) (admin only) includes `allowId3Edit` in its response so the player can decide whether to show the **Edit Tags** button in the Now Playing modal on login and session restore:

```json
{
  "enabled": true,
  "allowArtUpdate": false,
  "allowId3Edit": true,
  "apiKey": "…",
  "apiSecret": "…",
  "userAgentTag": "amr",
  "itunesEnabled": true,
  "deezerEnabled": true
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
| `title`    | string |   | Pass `""` to clear the tag. Omit a field to leave that tag (and its DB column) unchanged. The player always sends all seven fields. |
| `artist`   | string |   | |
| `album`    | string |   | |
| `year`     | string or number |   | Mapped to ffmpeg's `date` metadata key. |
| `genre`    | string |   | |
| `track`    | string or number |   | |
| `disk`     | string or number |   | Mapped to ffmpeg's `disc` metadata key. |

**Supported formats**: Any container ffmpeg can remux losslessly — MP3, FLAC, OGG, M4A, M4B, OPUS, AAC, WAV, AIFF, W64, etc.  
For containers that do not support certain tag keys (e.g. WAV has limited metadata support) ffmpeg silently ignores inapplicable keys.

**Process** (`writeTags()` in `src/util/ffmpeg-tags.js`)
1. Resolve the absolute path via `getVPathInfo(filepath, user)`
2. Build ffmpeg `-metadata key=value` arguments for each provided field (Ogg/Opus also get them on the audio stream)
3. MP3, M4A/M4B/MP4 and FLAC: `ffmpeg -y -i <source> -map 0 -c copy -map_metadata 0 -metadata … <tmpfile>` (MP3 adds `-id3v2_version 3`); other formats map only the audio (`-map 0:a`). Ogg/Opus files with a cover have the cover extracted and re-embedded so it is kept.
4. Atomically replace the source with the temp file (a hidden `.velvet-tag-*` file in the same folder) via `rename(2)`
5. Update the `files` table for the provided fields (`title`, `artist`, `album`, `year`, `genre`, `track`, `disk`) and store the new file mtime so the scanner does not treat the file as changed

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
3. If the edited song is the one playing, playback is paused before the write; afterwards the audio source is reloaded with a cache-buster and starts again **from the beginning** (byte offsets change when the file is rewritten). When casting to Server Audio (MPV) or Sonos, the cast is reloaded as well.

### Write-access guard

`GET /api/v1/ping` includes a `vpathWriteAccess: { [vpathName]: bool }` map for admin users. When the flag is `false` for the song's root vpath, the Discogs/Deezer/iTunes art-search section is hidden and opening the album art picker shows a toast that Velvet has no write access to the folder. The **Edit Tags** button itself is not gated by this map; a write to a read-only folder fails with `500`.
