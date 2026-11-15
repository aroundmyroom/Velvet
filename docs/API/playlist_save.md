**Save Playlist**
----
  Save a playlist. If a playlist with this name already exists for the user, it is
  replaced (all its entries are deleted first). Runs in one transaction.

* **URL**

  `/api/v1/playlist/save`

* **Method:**

  `POST`

* **Auth required:** Yes — any logged-in user

*  **JSON Params**

   **Required:**

   `title` - The name of the playlist<br />
   `songs` - Array of virtual filepaths (root vpath first, e.g. `Music/Artist/song.mp3`), in order. May be empty, but must be present (a missing `songs` answers `400`).<br />

   **Optional:**

   `live` - Boolean, stored on the playlist's header row (default `false`)

* **JSON Example**

  ```json
  {
    "title": "New Playlist",
    "songs": ["Music/Artist/Album/song1.mp3", "Music/Artist/Album/song2.mp3"]
  }
  ```

* **Success Response:**

  * **Code:** 200 <br />
    **Content:** `{}`
