**Upload Files**
----
  This endpoint can be used to upload files.

> **Player**: the File Explorer view shows an **Upload** button when `/api/v1/ping` returns `allowUpload: true` (uploads not disabled globally with `noUpload` and the user does not have `allow-upload: false`). It opens a modal with a drag-and-drop zone, a browse button, per-file progress bars, and a directory refresh on completion. Files are pre-validated against the `supportedAudioFiles` list from `/api/v1/ping` before any network request is made.


* **URL**

  `/api/v1/file-explorer/upload`

* **Method:**

  `POST`

* **Headers**

  | Header | Required | Description |
  |---|---|---|
  | `data-location` | Yes | URI-encoded virtual path of the destination directory. Call fails with 403 if omitted. The directory is created if it does not exist. |
  | `x-access-token` | Yes | User authentication token. |
  | `Content-Type` | Yes | `multipart/form-data` (set automatically by the browser / FormData). |

* **Body**

  `multipart/form-data`. Attach one or more audio files as form fields.

* **File Type Restriction**

  Only files whose extension is `true` in the server's `supportedAudioFiles` map
  are accepted (by default `mp3`, `flac`, `wav`, `ogg`, `aac`, `m4a`, `m4b`, `opus`).
  Any other file type (`.pdf`, `.txt`, executables, etc.) is drained and
  discarded server-side — it is **never** written to disk. Directory parts of
  the client filename are stripped, and names starting with `.` are discarded.

  The authoritative list of allowed extensions is returned by
  [`/api/v1/ping`](ping.md) as the `supportedAudioFiles` map.

  If **all** files in the request are rejected for their type, the endpoint returns HTTP 400:
  ```json
  { "error": "File type not allowed: .pdf" }
  ```

  If **some** files are accepted and others rejected, the accepted files are
  saved, the rejected ones are discarded, and HTTP 200 is returned. Callers
  should pre-filter client-side using the `supportedAudioFiles` list from
  `/api/v1/ping`.

* **Success Response:**

  * **Code:** 200 <br />
    **Content:** `{}`

* **Error Response:**

  * **Code:** 403 <br />
    **Content:** `{ "error": "Uploading Disabled" }` — `noUpload` is set, or the user has `allow-upload: false`.

  * **Code:** 403 <br />
    **Content:** `{ "error": "No Location Provided" }` — `data-location` header missing.

  * **Code:** 400 <br />
    **Content:** `{ "error": "File type not allowed: .<ext>" }` — every file in the batch had a disallowed extension.
