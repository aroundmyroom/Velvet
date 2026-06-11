**Load Playlist**
----
  Load all songs from a saved playlist, including their metadata.

  *(updated by GitHub Copilot, 2026-02-27)*

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
  * **Content:** Array of playlist entry objects

  ```json
  [
    {
      "id": 42,
      "filepath": "VirtualPath/Artist/Album/track.mp3",
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
  | `metadata` | object | Full metadata from the database; empty object `{}` if not yet cached |

* **Error Responses:**

  * **Code:** 400 — missing `playlistname`
  * **Code:** 401 — missing or invalid token
  * **Code:** 500 — database error

* **Notes:**

  * Metadata is now fully populated from the database (no longer blank).
  * The `id` field is required when calling `POST /api/v1/playlist/remove-song` to remove a specific entry.
  * Playlists are per-user; you will only see playlists belonging to the authenticated user.
