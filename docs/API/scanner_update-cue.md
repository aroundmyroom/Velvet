**Scanner — Update CUE Points** *(added by GitHub Copilot, 2026-03-02)*
----
  Internal scanner endpoint. Writes CUE sheet chapter markers (cue points)
  for an already-indexed file.

  Called by the scanner CUE-detection path: after a file has been inserted or
  confirmed in the DB, the scanner inspects its embedded CUE sheet (if any)
  and writes the resulting chapter array via this endpoint. Sending `'[]'`
  is the sentinel value meaning "checked — no CUE found", which prevents the
  file from being rechecked on every scan.

> **Note:** This endpoint is protected by the scanner middleware
> (`req.scanApproved === true`). It is not intended to be called by
> external clients.

* **URL**

  `/api/v1/scanner/update-cue`

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
  | `filepath` | `string` | Yes | Relative filepath within the vpath root. |
  | `vpath` | `string` | Yes | Virtual path the file belongs to. |
  | `cuepoints` | `string` | Yes | JSON-serialised array of chapter objects, or `'[]'` meaning no CUE data found. |

  ```json
  {
    "filepath": "Artist/Album/01 Track.flac",
    "vpath": "Music",
    "cuepoints": "[{\"title\":\"Part 1\",\"time\":0},{\"title\":\"Part 2\",\"time\":183.5}]"
  }
  ```

* **Success Response:**

  * **Code:** 200  
    **Content:** `{}`

* **Error Response:**

  * **Code:** 500 if DB write fails (logged server-side).

See also: [/db/cuepoints](db_cuepoints.md) — read cue points for a file (public endpoint).
