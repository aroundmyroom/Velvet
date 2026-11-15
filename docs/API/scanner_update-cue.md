**Scanner — Update CUE Points**
----
  Internal scanner endpoint. Writes cue points (track markers) for an
  already-indexed file.

  Called by the scanner's cue-detection path. The scanner looks for an
  embedded cue sheet, then a sidecar `.cue` file, then (for `.m4b`) chapters,
  and writes the result via this endpoint. Sending `'[]'` is the sentinel
  meaning "checked — no cue found", which prevents the file from being
  rechecked on every scan.

> **Note:** All `/api/v1/scanner/*` routes need a scanner token (a JWT with
> `scan: true`, created per scan job); any other caller gets
> `403 { "error": "Access Denied" }`. Not intended for external clients.

* **URL**

  `/api/v1/scanner/update-cue`

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
  | `cuepoints` | `string` | JSON-serialised array of cue points, or `'[]'` meaning none found. |

  ```json
  {
    "filepath": "Artist/Album/01 Track.flac",
    "vpath": "Music",
    "cuepoints": "[{\"no\":1,\"title\":\"Part 1\",\"t\":0},{\"no\":2,\"title\":\"Part 2\",\"t\":183.5}]"
  }
  ```

  Each embedded-cue entry is `{ no, title, t }` (`t` in seconds). An embedded
  cue is only stored when it has more than one track.

* **Success Response:**

  * **Code:** 200  
    **Content:** `{}`

* **Error Response:**

  * **Code:** 500 if the DB write fails.

See also: [/db/cuepoints](db_cuepoints.md) — read cue points for a file.
