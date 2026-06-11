**Download Files as ZIP**
----

Streams a ZIP archive containing the requested audio files.

* **URL**

  `/api/v1/download/zip`

* **Method:**

  `POST`

* **Auth:** required — `x-access-token` header or `?token=` query parameter

* **Request Body (JSON)**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `fileArray` | string (JSON-encoded array) | ✅ | Array of server-relative file paths, e.g. `'["Music/Artist/track.mp3"]'` |
  | `filename` | string | optional | Base name for the ZIP file (sanitised, max 120 chars; defaults to `velvet-download`) |

  ```json
  {
    "fileArray": "[\"Music/Artist/Album/01 Track.mp3\", \"Music/Artist/Album/02 Track.flac\"]",
    "filename": "Artist - Album"
  }
  ```

* **Success Response:**

  HTTP 200 with `Content-Type: application/zip` and `Content-Disposition: attachment; filename="Artist - Album.zip"`. The body is a streaming ZIP archive.

* **Error Responses:**

  | Code | Meaning |
  |---|---|
  | 400 | Missing or invalid `fileArray` |
  | 413 | Total file size exceeds the server limit — body: `{ "error": "...", "maxMb": 500, "sizeMb": 732 }` |

* **Notes:**

  - The size guard is a pre-flight check against the raw (uncompressed) file sizes. Actual ZIP transfer will be similar in size since audio files are already compressed.
  - The configurable size limit (`scanOptions.maxZipMb`, default 500 MB) can be updated at runtime via `POST /api/v1/admin/db/params/max-zip-mb` (admin only).
