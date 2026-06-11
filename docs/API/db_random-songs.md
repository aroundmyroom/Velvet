**Get Random Songs** *(added by GitHub Copilot, 2026-02-27)*
----
  Returns a single random song from the library, together with an updated
  ignore list to prevent repeats. Used internally by the Auto-DJ feature.

* **URL**

  `/api/v1/db/random-songs`

* **Method:**

  `POST`

* **Headers**

  | Header | Required | Description |
  |---|---|---|
  | `x-access-token` | Yes | User authentication token. |
  | `Content-Type` | Yes | `application/json` |

* **JSON Body**

  All fields are optional.

  | Field | Type | Description |
  |---|---|---|
  | `ignoreList` | `integer[]` | Array of positional indices (from previous responses) to skip so the same song is not repeated immediately. Automatically trimmed to `ignorePercentage × totalSongCount` entries. |
  | `ignorePercentage` | `number` | Fraction (0–1) of the library that may appear in `ignoreList` before old entries are evicted. Defaults to `0.5`. |
  | `ignoreVPaths` | `string[]` | Exclude songs from these virtual paths. |
  | `minRating` | `integer` | Only consider songs with a rating ≥ this value (0–10 scale, matches `POST /api/v1/db/rate-song`). |
  | `filepathPrefix` | `string\|null` | Restrict candidates to songs whose filepath starts with this prefix. Used to limit Auto-DJ to a specific vpath sub-folder. |
  | `artists` | `string[]` | When provided, only songs whose artist is in this list are considered. Used by the Auto-DJ Similar Artists mode (see [`/api/v1/lastfm/similar-artists`](lastfm_similar-artists.md)). |

  ```json
  {
    "ignoreList": [3, 17, 42],
    "ignorePercentage": 0.5,
    "ignoreVPaths": ["Audiobooks"],
    "minRating": 6,
    "artists": ["Iggy Pop", "Lou Reed", "T. Rex"]
  }
  ```

* **Success Response:**

  * **Code:** 200

  ```json
  {
    "songs": [
      {
        "filepath": "/Music/Artist/Album/01 Track.flac",
        "metadata": {
          "artist": "Artist",
          "album": "Album",
          "track": 1,
          "title": "Track Title",
          "year": 1994,
          "album-art": "abcdef1234.jpg",
          "hash": "md5hash",
          "rating": 8,
          "play-count": 5,
          "last-played": 1740000000,
          "replaygain-track": -7.2,
          "duration": 237.431
        }
      }
    ],
    "ignoreList": [3, 17, 42, 88]
  }
  ```

  | Field | Description |
  |---|---|
  | `songs` | Array containing exactly one song object. |
  | `ignoreList` | The input `ignoreList` with the new song's index appended. Pass this back on the next call. |

* **Error Response:**

  * **Code:** 400 — `{ "error": "No songs that match criteria" }` — no songs exist
    that satisfy the `minRating` / `ignoreVPaths` / `filepathPrefix` filters.

* **Notes**

  - The Auto-DJ pre-fetches the next track `max(25, crossfade + 15)` seconds
    before the current track ends to ensure gapless playback.
  - Only one song is returned per call; call again for the next track.
