**Download Files as ZIP**
----

Streams a ZIP archive containing the requested audio files. Implemented in `src/api/download.js`.

* **URL**

  `/api/v1/download/zip`

* **Method:**

  `POST`

* **Auth:** required — `x-access-token` header or `?token=` query parameter

* **Request Body (JSON)**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `fileArray` | string (JSON-encoded array) | ✅ | Array of player file paths, e.g. `'["Music/Artist/track.mp3"]'` |
  | `filename` | string | optional | Base name for the ZIP file (`/ \ : * ? " < > |` replaced by `_`, max 120 chars; defaults to `velvet-download`) |

  ```json
  {
    "fileArray": "[\"Music/Artist/Album/01 Track.mp3\", \"Music/Artist/Album/02 Track.flac\"]",
    "filename": "Artist - Album"
  }
  ```

* **Success Response:**

  HTTP 200 with `Content-Type: application/zip` and `Content-Disposition: attachment; filename="Artist - Album.zip"`. The body is a streaming ZIP archive. Files are stored under their base name (no folders).

* **Error Responses:**

  | Code | Meaning |
  |---|---|
  | 404 | None of the files is accessible — `{ "error": "No accessible files found" }` |
  | 413 | Total file size exceeds the server limit — body: `{ "error": "...", "maxMb": 500, "sizeMb": 732 }` |
  | 500 | `fileArray` is not valid JSON, or the archive failed |

* **Notes:**

  - Files the user cannot access, or that are missing, are skipped.
  - The size guard is a pre-flight check against the raw file sizes. Actual ZIP transfer will be similar in size since audio files are already compressed.
  - The size limit (`scanOptions.maxZipMb`, default 500 MB) can be changed at runtime via `POST /api/v1/admin/db/params/max-zip-mb` (admin only).

---

**Other download endpoints**

| Method & path | Body | Result |
|---|---|---|
| `POST /api/v1/download/directory` | `{ "directory": "Music/Artist/Album" }` | ZIP of the whole folder as `velvet-directory.zip` (same size limit; `400` when not a directory) |
| `POST /api/v1/download/m3u` | `{ "path": "Music/Playlists/list.m3u" }` | ZIP named `<playlist>.zip` with the playlist's songs (entries outside the library root are skipped) plus the playlist file |
| `GET /api/v1/download/shared` | — | ZIP of a shared playlist as `velvet-shared.zip`; needs a shared-playlist token |
