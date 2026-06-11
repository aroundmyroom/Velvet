**Decade Browsing** *(GitHub Copilot, 2026-03-04)*
----

Browse the library by decade (1960s, 1970s, …).

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
      { "decade": 1980, "cnt": 3400 },
      { "decade": 1990, "cnt": 2870 },
      { "decade": 1970, "cnt": 1200 }
    ]
  }
  ```

  `decade` is the year the decade begins (1980 = 1980–1989). Sorted by `cnt` descending.

---

### Albums for a decade

* **URL:** `/api/v1/db/decade/albums`
* **Method:** `POST`
* **JSON Body**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `decade` | `integer` | Yes | Decade start year (e.g. `1980`). |
  | `ignoreVPaths` | `string[]` | No | Exclude these virtual paths. |

  ```json
  { "decade": 1980 }
  ```

* **Success Response:** 200

  ```json
  {
    "albums": [
      {
        "album":  "Never Mind the Bollocks",
        "artist": "Sex Pistols",
        "year":   1977,
        "aa":     "abcdef1234.jpg"
      }
    ]
  }
  ```
