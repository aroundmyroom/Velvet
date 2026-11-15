**Scanner — Update Album Art**
----
  Internal scanner endpoint. Updates the album-art columns (`aaFile`,
  `art_source`, `cover_file`) and the scan id (`sID`) of an existing DB
  record, without re-inserting it or changing `ts` or any other metadata field.

  Used by the `_needsArt` backfill path: if a file already exists in the DB
  but has no album art (or its cached art file is missing), the scanner
  re-parses the file and calls this endpoint instead of re-inserting the
  whole record, so the song does not re-appear in "Recently Added". The
  scanner always calls it, with `aaFile: ""` as the sentinel for "checked, no
  art found", so the file is not re-parsed on every scan.

> **Note:** All `/api/v1/scanner/*` routes need a scanner token (a JWT with
> `scan: true`, created per scan job); any other caller gets
> `403 { "error": "Access Denied" }`. Not intended for external clients.

* **URL**

  `/api/v1/scanner/update-art`

* **Method:**

  `POST`

* **Headers**

  | Header | Required | Description |
  |---|---|---|
  | `x-access-token` | Yes | Scanner token. |
  | `Content-Type` | Yes | `application/json` |

* **JSON Body** (not validated)

  | Field | Type | Description |
  |---|---|---|
  | `filepath` | `string` | Relative filepath within the vpath root. |
  | `vpath` | `string` | Root vpath the file belongs to. |
  | `aaFile` | `string` | Album art filename (hash + extension), or `""` when no art was found. |
  | `scanId` | `string` | Scan session id; stored as the row's `sID`. |
  | `artSource` | `string \| null` | Optional. Where the art came from. |
  | `coverFile` | `string \| null` | Optional. The folder cover file used, if any. |

  ```json
  {
    "filepath": "Artist/Album/01 Track.flac",
    "vpath": "Music",
    "aaFile": "d41d8cd98f00b204e9800998ecf8427e.jpg",
    "scanId": "a5kdlrOP",
    "artSource": null,
    "coverFile": null
  }
  ```

* **Success Response:**

  * **Code:** 200
  * **Content:** `{}`
