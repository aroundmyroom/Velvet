**Rate Song** *(added by GitHub Copilot, 2026-02-27)*
----
  Sets or clears the star rating for a song for the currently authenticated
  user. Ratings are stored per-user in `user_metadata` and do not affect other
  users' ratings.

* **URL**

  `/api/v1/db/rate-song`

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
  | `filepath` | `string` | Yes | Full virtual path to the song (e.g. `/Music/artist/song.flac`). |
  | `rating` | `integer\|null` | Yes | Integer 0–10 (`0` = no stars, `10` = 5 stars), or `null` to clear the rating. The v2 UI maps 1–5 stars to values 2, 4, 6, 8, 10. |

  ```json
  {
    "filepath": "/Music/Daft Punk/Random Access Memories/01 Give Life Back to Music.flac",
    "rating": 8
  }
  ```

* **Success Response:**

  * **Code:** 200
  * **Content:** `{}`

* **Error Response:**

  * **Code:** 400 — Joi validation error (missing or out-of-range fields).
  * **Code:** 500 — `{ "error": "File Not Found" }` — filepath does not exist in the DB.

* **Notes**

  - The rating is stored in `user_metadata.rating` keyed by the song's MD5
    hash, so it survives file moves/renames as long as the content hash matches.
  - In the v2 **Now Playing** modal, the rating helper text is contextual:
    `Clear rating` is only shown when a rating already exists; otherwise the UI
    shows a translated hint telling the user to click the stars to add one.
  - Auto-DJ's `minRating` filter uses this value — a `minRating` of `6` means
    only songs rated 3 stars (value ≥ 6) are candidates.
  - `POST /api/v1/db/random-songs` accepts a `minRating` param that filters
    against this value.
