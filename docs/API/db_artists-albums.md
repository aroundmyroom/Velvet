**Get All Albums for an Artist**
----
  Retrieves all albums for a given artist name, with optional vpath and filepath filtering.

* **URL**

  `/api/v1/db/artists-albums`

* **Method:**

  `POST`

* **JSON Params:**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `artist` | `string` | ✅ | Artist name to look up |
  | `ignoreVPaths` | `string[]` | no | Exclude entire root vpaths from results |
  | `excludeFilepathPrefixes` | `{ vpath, prefix }[]` | no | Blacklist — exclude rows where `vpath=X AND filepath LIKE prefix%` |
  | `includeFilepathPrefixes` | `{ vpath, prefix }[]` | no | **Whitelist** — for each named parent vpath, only include rows where `filepath LIKE prefix%`. Used for Albums-Only filtering. |

* **JSON Example:**

  ```json
  {
    "artist": "Cerrone",
    "includeFilepathPrefixes": [
      { "vpath": "Music", "prefix": "Albums/" }
    ]
  }
  ```

* **Success Response:**

  * **Code:** 200  
    **Content:**

    ```json
    {
      "albums": [
        { "name": "Supernature", "year": 1977, "album_art_file": "abc123.jpg" },
        { "name": "Cerrone IV",  "year": 1978, "album_art_file": null }
      ]
    }
    ```

See also: [db_albums.md](db_albums.md), [Admin directory flags](admin_directory-flags.md)
