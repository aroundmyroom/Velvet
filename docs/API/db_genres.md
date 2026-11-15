**Genre Browsing**
----

Endpoints for listing genres and fetching songs and albums by genre. For a user who only has child vpaths, results are limited to those folders. Admin-defined genre groups are documented in [admin_genre-groups.md](admin_genre-groups.md). Genre strings
from the database are normalised before being returned: multi-value fields
(`"Pop/Rock"`, `"Disco, Funk"`) are split, near-duplicate spellings
(`"Synthpop"` / `"Synth-pop"`) are merged, and rare genres (< 10 songs) are
folded into the closest matching larger genre.

---

### List genres

* **URL:** `/api/v1/db/genres`
* **Methods:** `GET` · `POST`
* **POST body (optional)**

  | Field | Type | Description |
  |---|---|---|
  | `ignoreVPaths` | `string[]` | Exclude these virtual paths from counts. |

* **Success Response:** 200

  ```json
  {
    "genres": [
      { "genre": "Rock",       "cnt": 1240 },
      { "genre": "Electronic", "cnt":  870 },
      { "genre": "Jazz",       "cnt":  430 }
    ]
  }
  ```

  Sorted by `cnt` descending.

---

### Songs for a genre

* **URL:** `/api/v1/db/genre/songs`
* **Method:** `POST`
* **JSON Body**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `genre` | `string` | Yes | Display genre name as returned by the list endpoint. |
  | `ignoreVPaths` | `string[]` | No | Exclude these virtual paths. |

  ```json
  { "genre": "Rock", "ignoreVPaths": ["Audiobooks"] }
  ```

* **Success Response:** 200

  Array of song metadata objects (same shape as `/api/v1/db/album-songs`).
  An unknown genre returns `[]`.

* **Notes**
  - The lookup handles multi-value DB rows: a song tagged `"Pop/Rock"` will
    appear in both `"Pop"` and `"Rock"` results.
  - Case-insensitive match is used as a fallback.

---

### Albums for a genre

* **URL:** `/api/v1/db/genre/albums`
* **Method:** `POST`
* **JSON Body:** `genre` (string, required), `ignoreVPaths` (optional), `excludeFilepathPrefixes` (`{ vpath, prefix }[]`, optional)
* **Success Response:** 200

  ```json
  { "albums": [ { "name": "Supernature", "artist": "Cerrone", "year": 1977, "album_art_file": "abc123.jpg" } ] }
  ```

  One entry per album + artist pair, sorted by artist, then album. An unknown genre returns `{ "albums": [] }`.
