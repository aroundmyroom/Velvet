**Upload Files**
----
  This endpoint can be used to upload files.

> **GUIv2 client**: the File Explorer view shows an **Upload** button whenever the server is configured with `noUpload: false`. Clicking it opens a modal with a drag-and-drop zone, a browse button, per-file progress bars, and automatic directory refresh on completion. Files are pre-validated against the `supportedAudioFiles` list from `/api/v1/ping` before any network request is made.


* **URL**

  `/api/v1/file-explorer/upload`

* **Method:**

  `POST`

* **Headers**

  | Header | Required | Description |
  |---|---|---|
  | `data-location` | Yes | URI-encoded virtual path of the destination directory. Call fails with 403 if omitted. |
  | `x-access-token` | Yes | User authentication token. |
  | `Content-Type` | Yes | `multipart/form-data` (set automatically by the browser / FormData). |

* **Body**

  `multipart/form-data`. Attach one or more audio files as form fields.

* **File Type Restriction** *(added by GitHub Copilot, 2026-02-27)*

  Only files whose extension appears in the server's `supportedAudioFiles` list
  are accepted (e.g. `mp3`, `flac`, `wav`, `ogg`, `aac`, `m4a`, `m4b`, `opus`).
  Any other file type (`.pdf`, `.txt`, executables, etc.) is drained and
  discarded server-side — it is **never** written to disk.

  The authoritative list of allowed extensions is returned by
  [`/api/v1/ping`](ping.md) as the `supportedAudioFiles` map.

  If **all** files in the request are rejected the endpoint returns HTTP 400:
  ```json
  { "error": "File type not allowed: .pdf" }
  ```

  If **some** files are accepted and others rejected, the accepted files are
  saved, the rejected ones are discarded, and HTTP 200 is returned. Callers
  should pre-filter client-side using the `supportedAudioFiles` list from
  `/api/v1/ping` (the v2 and alpha UIs both do this).

* **Success Response:**

  * **Code:** 200 <br />
    **Content:** `{}`

* **Error Response:**

  * **Code:** 403 <br />
    **Content:** `{ "error": "No Location Provided" }` — `data-location` header missing.

  * **Code:** 400 *(added by GitHub Copilot, 2026-02-27)* <br />
    **Content:** `{ "error": "File type not allowed: .<ext>" }` — every file in the batch had a disallowed extension.

  * **Code:** 500 <br />
    **Content:** `{ error: 'Not a directory' }`
