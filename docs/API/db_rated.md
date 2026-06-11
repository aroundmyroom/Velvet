**Get Rated Songs** *(POST variant added by GitHub Copilot, 2026-02-27)*
----
  Returns all songs that the authenticated user has given a rating to (any
  rating value > 0). Used by the v2 "Rated Songs" view.

* **URL (preferred)**

  `/api/v1/db/rated`

* **Method:**

  `POST`

* **Headers**

  | Header | Required | Description |
  |---|---|---|
  | `x-access-token` | Yes | User authentication token. |
  | `Content-Type` | Yes | `application/json` |

* **JSON Body**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `ignoreVPaths` | `string[]` | No | Exclude songs from these virtual paths. |

  ```json
  { "ignoreVPaths": ["Audiobooks"] }
  ```

  Send an empty body `{}` to return all rated songs across all vpaths.

* **Success Response:**

  * **Code:** 200
  * **Content:** Array of [song metadata objects](db_stats-queries.md#song-metadata-object)
    sorted by rating descending.

  ```json
  [
    {
      "filepath": "/Music/Artist/Album/01 Track.flac",
      "metadata": {
        "artist": "Artist",
        "album": "Album",
        "title": "Track Title",
        "rating": 10,
        "play-count": 7,
        ...
      }
    }
  ]
  ```

* **Legacy GET variant**

  `GET /api/v1/db/rated` — same response, no body, no `ignoreVPaths` support.
  Kept for backward compatibility. Use the POST variant for new code.

* **Notes**

  - Only returns songs with `rating > 0`. Songs with `rating = null` or
    `rating = 0` are excluded.
  - See [`POST /api/v1/db/rate-song`](db_rate-song.md) to set ratings.
  - `POST /api/v1/db/random-songs` accepts a `minRating` filter that also
    uses this rating value.
