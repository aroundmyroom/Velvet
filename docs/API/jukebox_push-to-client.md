**Push Message To Jukebox Instance**
----
  Send a command to a player running in Jukebox Mode. The server forwards it over
  that player's WebSocket.

* **URL**

  `/api/v1/jukebox/push-to-client`

* **Method:**

  `POST`

* **Auth required:** Yes — any logged-in user (the remote page uses the Jukebox token it gets for the session code)

*  **JSON Params**

   **Required:**

   `code` - The code generated when the player started Jukebox Mode<br/>
   `command` - Command to push to the player

   **Optional:**

   `file` - filepath, used by `addSong`

* **JSON Example**

  ```json
  {
    "code": "aB3xYz9p",
    "command": "addSong",
    "file": "Music/Artist/Album/track.flac"
  }
  ```

* **List Of Commands**

  - `next`
  - `previous`
  - `playPause`
  - `addSong`
  - `getPlaylist`
  - `removeSong`
  - `getNowPlaying`
  - `goToSong`

  The server only checks that the command is in this list; the player decides what to do with it.

* **Success Response:**

  * **Code:** 200 <br />
    **Content:** `{}`

* **Error Responses:**

  | Code | Body | Cause |
  |---|---|---|
  | 400 | `{ "error": "Command Not Recognized" }` | `command` is not in the list above |
  | 400 | `{ "error": "<validation message>" }` | Missing `code` or `command` |
  | 404 | `{ "error": "Code Not Found" }` | No connected player has this code |
