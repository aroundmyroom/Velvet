**Scanner — Update Album Art** *(added by GitHub Copilot, 2026-02-27)*
----
  Internal scanner endpoint. Updates only the `aaFile` (album art filename)
  column for an existing DB record without changing the `ts` (last-scanned
  timestamp) or any other metadata field.

  This is used by the `_needsArt` backfill path: if a file already exists in
  the DB but has no album art, the scanner re-parses its metadata (with
  `skipCovers: false`) and, if art is found, calls this endpoint instead of
  re-inserting the whole record. This ensures the song does not re-appear in
  the "Recently Added" view.

> **Note:** This endpoint is protected by the scanner middleware
> (`req.scanApproved === true`). It is not intended to be called by
> external clients.

* **URL**

  `/api/v1/scanner/update-art`

* **Method:**

  `POST`

* **Headers**

  | Header | Required | Description |
  |---|---|---|
  | `x-access-token` | Yes | Internal scanner token (short-lived, generated per scan job). |
  | `Content-Type` | Yes | `application/json` |

* **JSON Body**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `filepath` | `string` | Yes | Relative filepath within the vpath root (as returned in `_needsArt` response). |
  | `vpath` | `string` | Yes | Virtual path the file belongs to. |
  | `aaFile` | `string` | Yes | Album art filename (hash + extension) to store, e.g. `"abc123.jpg"`. |
  | `scanId` | `string` | Yes | Scan session UUID. |

  ```json
  {
    "filepath": "Artist/Album/01 Track.flac",
    "vpath": "Music",
    "aaFile": "d41d8cd98f00b204e9800998ecf8427e.jpg",
    "scanId": "a5kdlrOP"
  }
  ```

* **Success Response:**

  * **Code:** 200
  * **Content:** `{}`
