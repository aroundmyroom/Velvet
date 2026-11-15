**Get Artists**
----
  Gets all distinct `artist` tags in the user's vpaths, sorted case-insensitively. For the normalised Artist Library see [artists.md](artists.md).

* **URL**

  `/api/v1/db/artists`

* **Method:**

  `GET` (no filters) or `POST` (with filters)

* **JSON Params** (`POST`, all optional): `ignoreVPaths` (`string[]`), `excludeFilepathPrefixes` and `includeFilepathPrefixes` (`{ vpath, prefix }[]`) — see [db_albums.md](db_albums.md).

  For a user who only has child vpaths, the list is limited to those folders in both forms.

* **Success Response:**

  * **Code:** 200 <br />
    **Content:**

    ```json
    { "artists": ["Artist 1", "Artist 2", "Artist 3"] }
    ```
