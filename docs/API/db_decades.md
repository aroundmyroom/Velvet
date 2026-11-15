**Decade Browsing**
----

Browse the library by decade (1960s, 1970s, …). For a user who only has child vpaths, results are limited to those folders.

---

### List decades

* **URL:** `/api/v1/db/decades`
* **Methods:** `GET` · `POST`
* **POST body (optional)**

  | Field | Type | Description |
  |---|---|---|
  | `ignoreVPaths` | `string[]` | Exclude these virtual paths from counts. |

* **Success Response:** 200

  ```json
  {
    "decades": [
      { "decade": 1970, "cnt": 1200, "albums": 95 },
      { "decade": 1980, "cnt": 3400, "albums": 260 },
      { "decade": 1990, "cnt": 2870, "albums": 210 }
    ]
  }
  ```

  `decade` is the year the decade begins (1980 = 1980–1989), `cnt` the number of songs, `albums` the number of distinct album tags. Only years 1900–2030 count. Sorted by decade ascending.

---

### Albums for a decade

* **URL:** `/api/v1/db/decade/albums`
* **Method:** `POST`
* **JSON Body**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `decade` | `integer` | Yes | Decade start year (e.g. `1980`). |
  | `ignoreVPaths` | `string[]` | No | Exclude these virtual paths. |
  | `excludeFilepathPrefixes` | `{ vpath, prefix }[]` | No | Exclude rows under these prefixes. |

  ```json
  { "decade": 1970 }
  ```

* **Success Response:** 200

  ```json
  {
    "albums": [
      {
        "name":           "Never Mind the Bollocks",
        "artist":         "Sex Pistols",
        "year":           1977,
        "album_art_file": "abcdef1234.jpg"
      }
    ]
  }
  ```

  One entry per album + artist pair, sorted by year, then album name. Songs without an album tag are left out.

---

### Songs for a decade

* **URL:** `/api/v1/db/decade/songs`
* **Method:** `POST`
* **JSON Body:** `decade` (integer, required), `ignoreVPaths` (optional)
* **Success Response:** 200 — array of song objects (same shape as [`POST /api/v1/db/metadata`](db_metadata.md)), sorted by artist, album, disc, track.
