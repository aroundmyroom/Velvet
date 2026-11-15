**Delete Playlist**
----
  Delete one of the authenticated user's playlists.

* **URL**

  `/api/v1/playlist/delete`

* **Method:**

  `POST`

* **Auth required:** Yes — any logged-in user (only their own playlists)

*  **JSON Params**

  **Required:**

  `playlistname` - The name of the playlist

* **JSON Example**

  ```json
  { "playlistname": "Best of Bieber" }
  ```

* **Success Response:**

  * **Code:** 200 <br />
    **Content:** `{}`

* **Notes:**

  - Deleting a name that does not exist is a no-op and still returns `{}`.
