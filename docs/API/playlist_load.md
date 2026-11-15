**Load Playlist**
----
  Load all songs from a saved playlist, including their metadata.

* **URL**

  `/api/v1/playlist/load`

* **Method:**

  `POST`

* **Headers**

  `x-access-token` — JWT auth token (required)

* **Request Body (JSON)**

  **Required:**
  `playlistname` — Name of the playlist to load (string)

* **Success Response:**

  * **Code:** 200
  * **Content:** Array of playlist entry objects, in playlist order

  ```json
  [
    {
      "id": 42,
      "filepath": "Music/Artist/Album/track.mp3",
      "metadata": {
        "artist": "Artist Name",
        "album": "Album Name",
        "title": "Track Title",
        "year": 2023,
        "track": 1,
        "duration": 213.4
      }
    }
  ]
  ```

  | Field | Type | Description |
  |---|---|---|
  | `id` | integer | Playlist entry row ID — used by `playlist/remove-song` |
  | `filepath` | string | Virtual path to the audio file |
  | `metadata` | object | Metadata from the database (same fields as `POST /api/v1/db/metadata`); empty object `{}` when the file is not in the library |

* **Error Responses:**

  * **Code:** 401 — missing or invalid token

* **Notes:**

  * The body is not validated: a missing `playlistname` loads a playlist named `"undefined"` and returns `[]`.
  * Playlists are per-user; you only see playlists belonging to the authenticated user.
