**Reset Play Statistics** *(added by GitHub Copilot, 2026-02-27)*
----
  Two endpoints to reset per-user play statistics. Both operate only on the
  authenticated user's data — other users are not affected. Ratings are not
  touched.

---

### Reset Most-Played Counts

* **URL**

  `/api/v1/db/stats/reset-play-counts`

* **Method:**

  `POST`

* **Headers**

  | Header | Required | Description |
  |---|---|---|
  | `x-access-token` | Yes | User authentication token. |

* **Body**

  Empty / no body required.

* **Success Response:**

  * **Code:** 200
  * **Content:** `{ "success": true }`

* **Effect**

  Zeros the `pc` (play-count) column in `user_metadata` for every song belonging
  to the authenticated user. The Most Played view will show an empty state
  until songs are played again.

---

### Reset Recently Played

* **URL**

  `/api/v1/db/stats/reset-recently-played`

* **Method:**

  `POST`

* **Headers**

  | Header | Required | Description |
  |---|---|---|
  | `x-access-token` | Yes | User authentication token. |

* **Body**

  Empty / no body required.

* **Success Response:**

  * **Code:** 200
  * **Content:** `{ "success": true }`

* **Effect**

  Clears the `lp` (last-played timestamp) column in `user_metadata` for every
  song belonging to the authenticated user. The Recently Played view will show
  an empty state until songs are played again.
