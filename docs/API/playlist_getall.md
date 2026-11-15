**Get All Playlists**
----
  Gets all playlists of the authenticated user.

* **URL**

  `/api/v1/playlist/getall`

* **Method:**

  `GET`

* **Auth required:** Yes — any logged-in user

* **Success Response:**

  * **Code:** 200 <br />
    **Content:** Array of playlists

    ```json
    [
      { "name": "Driving Music", "created": 1741018432000, "songCount": 42, "totalDuration": 10234 },
      { "name": "Best Of The 80s", "created": 1741018500000, "songCount": 0, "totalDuration": 0 }
    ]
    ```

  | Field | Description |
  |---|---|
  | `name` | Playlist name |
  | `created` | When the playlist was created (Unix epoch, milliseconds) |
  | `songCount` | Number of entries whose file is still in the library |
  | `totalDuration` | Sum of those files' durations, in whole seconds |
