# YouTube Download API

*Requires the user flag `allow-youtube-download` (set per user in Admin → Users).*

All three endpoints return `403` if `noUpload: true` is set in the server config. `metadata` and the download start also return `403` when the user lacks `allow-youtube-download`; `downloads` lets admins in without the flag (and shows them every user's jobs). `metadata` and the download start refuse a URL that is not http(s) or whose host resolves to a private or loopback address (`400`).

---

## GET /api/v1/ytdl/metadata

Fetch metadata for a YouTube URL without downloading anything.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `url` | string | Full YouTube video URL |

**Response:**

```json
{
  "title": "Song Title",
  "artist": "Artist Name",
  "album": "",
  "year": "2024",
  "thumbnail": "https://i.ytimg.com/vi/XXXX/maxresdefault.jpg"
}
```

- `album` is always an empty string (YouTube has no album concept — fill it in the UI before downloading)
- `thumbnail` is the thumbnail URL yt-dlp reports, or `null`
- `year` is the release year, else the upload year, or empty string if unavailable
- `artist` is parsed from an `"Artist - Title"` video title, else taken from yt-dlp's `artist` / uploader / channel; noise such as "(Official Video)" and "feat. …" is stripped from the title

**Errors:** `400` for a missing/invalid URL, a URL on a private or loopback host ("That URL is not allowed"), or when yt-dlp fails.

---

## POST /api/v1/ytdl/

Start an async download. Returns a `jobId` immediately; the download runs in the background.

**Request body:**

```json
{
  "url": "https://www.youtube.com/watch?v=XXXX",
  "outputCodec": "opus",
  "metadata": {
    "title": "Song Title",
    "artist": "Artist Name",
    "album": "Album Name",
    "year": "2024"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | Yes | YouTube video URL (http/https only) |
| `outputCodec` | `"opus"` \| `"mp3"` \| `"m4a"` \| `"ogg"` | No | Output format — defaults to `opus` |
| `metadata.title` | string | No | Title tag (max 200 chars) |
| `metadata.artist` | string | No | Artist tag (max 200 chars) |
| `metadata.album` | string | No | Album tag (max 200 chars) |
| `metadata.year` | string | No | Year tag (max 4 chars) |

**Response (200 OK):**

```json
{
  "jobId": "3",
  "message": "Download started"
}
```

Poll `GET /api/v1/ytdl/downloads` with this `jobId` to track progress and get the final file path.

**Errors:**

| Status | Meaning |
|---|---|
| 400 | Validation error, invalid URL, a URL on a private or loopback host, or no YouTube/recordings folder configured |
| 403 | User does not have `allow-youtube-download`, or `noUpload` is set on the server |

---

## GET /api/v1/ytdl/downloads

Returns the caller's own tracked download jobs (running + recently finished); an admin sees every user's jobs. Each job carries the `user` who started it. Jobs live in memory only; finished entries are removed (when the next download finishes) once they are older than 10 minutes.

**Response:**

```json
{
  "1": {
    "status": "done",
    "url": "https://www.youtube.com/watch?v=XXXX",
    "title": "Song Title",
    "started": 1714900000000,
    "user": "alice",
    "finished": 1714900045000,
    "filePath": "Artist - Song Title.opus",
    "vpath": "YouTube",
    "filepath": "YouTube/Artist - Song Title.opus"
  },
  "2": {
    "status": "running",
    "url": "https://www.youtube.com/watch?v=YYYY",
    "title": "Another Song",
    "started": 1714900100000,
    "user": "alice"
  }
}
```

Response is keyed by `jobId`. Possible `status` values:

| Status | Meaning |
|---|---|
| `running` | Download in progress |
| `done` | Completed — `filePath` (file name), `vpath` and `filepath` (the DB/player path) are set |
| `error` | Failed — `error` field contains the error message |

The client should poll every 2 seconds until `status` is `done` or `error`. Maximum recommended poll duration is 10 minutes before treating a job as timed out.

---

## Technical notes

- All intermediate files (raw stream, thumbnail) are written to a private temp directory under the OS temp folder and deleted unconditionally after every download — nothing lands in the music folder until the final file is moved into place.
- Files are saved to the first accessible folder of type `youtube` in the user's vpaths; if none exists, falls back to `type: recordings`. Returns 400 if neither is configured.
- Filenames are sanitised and de-duplicated automatically (`Artist - Title.opus`, or `Artist - Title_1.opus` if a collision exists).
- Tags are written with an ffmpeg codec copy (no re-encode). The YouTube thumbnail is embedded as cover: as an attached picture stream for MP3/M4A, and as a Vorbis `METADATA_BLOCK_PICTURE` (base64) for Opus/OGG — see [youtube-download.md](../youtube-download.md) for details.
- Both yt-dlp and ffmpeg are managed automatically by Velvet — no manual installation required.
- Note on format quality: YouTube streams are lossy (Opus ~160 kbps or AAC). Re-encoding to another format does not recover quality. `opus` is recommended as it copies the native stream without re-encoding.

