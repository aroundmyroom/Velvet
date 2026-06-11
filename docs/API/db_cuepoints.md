**Get Cue Points**
----
  Returns the CUE sheet track markers for a given file.

* **URL**

  /db/cuepoints

* **Method:**

  `GET`

* **URL Params**

  **Required:**

  `fp=[string]` — the virtual filepath of the audio file (relative to the vpath root, as returned by library/search endpoints)

* **Success Response:**

  * **Code:** 200 <br />
    **Content:** Array of cue point objects ordered by time

    ```json
    {
      "cuepoints": [
        { "no": 1, "title": "Opening",    "t": 0 },
        { "no": 2, "title": "Main Theme", "t": 45.2 },
        { "no": 3, "title": "Finale",     "t": 193.8 }
      ]
    }
    ```

    Returns an empty array when no cue data exists for the file:

    ```json
    { "cuepoints": [] }
    ```

* **Cue point object fields**

  | Field   | Type    | Description                                              |
  |---------|---------|----------------------------------------------------------|
  | `no`    | integer | Track number from the CUE sheet                         |
  | `title` | string\|null | Track title from cue sheet, `null` if not present  |
  | `t`     | float   | Seconds from the start of the file (2 decimal places)   |

* **Notes**

  * Data is sourced from the `cuepoints` column in the SQLite `files` table.
  * The column is populated during library scanning from embedded CUE sheets (e.g. FLAC `CUESHEET` tag) or sidecar `.cue` files in the same directory.
  * A result of `[]` may mean either no cue data exists OR the file has not yet been scanned for cues. Files with `cuepoints IS NULL` are processed by the scanner on the next scan pass.
