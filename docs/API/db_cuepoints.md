**Get Cue Points**
----
  Returns the CUE sheet track markers (or M4B chapters) for a given file. Used by the player seek bar.

* **URL**

  `/api/v1/db/cuepoints`

* **Method:**

  `GET`

* **URL Params**

  **Required:**

  `fp=[string]` — the player filepath of the audio file, starting with the vpath (e.g. `Music/Mixes/set.flac`), as returned by library/search endpoints

* **Success Response:**

  * **Code:** 200 <br />
    **Content:** an object with the cue points ordered by time

    ```json
    {
      "cuepoints": [
        { "no": 1, "title": "Opening",    "t": 0 },
        { "no": 2, "title": "Main Theme", "t": 45.2 },
        { "no": 3, "title": "Finale",     "t": 193.8 }
      ]
    }
    ```

    Returns an empty array when no cue data exists, or on any error (unknown file, no access):

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

  * Data comes from the `cuepoints` column in the SQLite `files` table, filled during scanning from embedded CUE sheets or a sidecar `.cue` file.
  * When the column is still `NULL`, the endpoint extracts on demand: M4B chapters via ffprobe, otherwise the embedded CUE sheet and then a sidecar `.cue` file. The result is stored; `'[]'` is stored when nothing was found.
  * When `'[]'` is stored, the sidecar `.cue` file is checked again on every request, so a `.cue` added later is picked up without a rescan.
  * A sidecar is used when it has the same base name as the audio file, or is the only `.cue` file in the folder, and has exactly one `FILE` line that refers to this audio file. At least 2 points are needed.
