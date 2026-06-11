**Playlist Management** *(documented by GitHub Copilot, 2026-02-27)*
----
  Endpoints for creating playlists and adding/removing individual songs.
  For bulk save/replace operations see [`/playlist/save`](playlist_save.md).

---

### Create a New Playlist

* **URL**

  `/api/v1/playlist/new`

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
  | `title` | `string` | Yes | Name for the new playlist. Must be unique for this user. |

  ```json
  { "title": "Sunday Morning Mix" }
  ```

* **Success Response:**

  * **Code:** 200
  * **Content:** `{}`

* **Error Response:**

  * **Code:** 400 — `{ "error": "Playlist Already Exists" }`

---

### Add a Song to a Playlist

* **URL**

  `/api/v1/playlist/add-song`

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
  | `song` | `string` | Yes | Full virtual filepath of the song to add (e.g. `/Music/Artist/song.flac`). |
  | `playlist` | `string` | Yes | Name of an existing playlist owned by this user. |

  ```json
  {
    "song": "/Music/Daft Punk/Random Access Memories/01 Give Life Back to Music.flac",
    "playlist": "Sunday Morning Mix"
  }
  ```

* **Success Response:**

  * **Code:** 200
  * **Content:** `{}`

* **Notes**

  - Does not deduplicate — the same song can be added multiple times.
  - The playlist must already exist; use `/playlist/new` to create it first.

---

### Remove a Song from a Playlist

* **URL**

  `/api/v1/playlist/remove-song`

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
  | `id` | `integer` | Yes | Internal row ID of the playlist entry to remove. This is the `id` field returned in each object by `POST /api/v1/playlist/load`. |

  ```json
  { "id": 42 }
  ```

* **Success Response:**

  * **Code:** 200
  * **Content:** `{}`

* **Error Response:**

  * **Code:** 500 — the entry does not exist or belongs to a different user.

* **Notes**

  - The `id` value is included in each song object returned by `POST /api/v1/playlist/load`.
  - This endpoint removes a single entry by row ID, not by filepath — if the
    same song appears twice in a playlist, only the one with the matching `_plid`
    is removed.
