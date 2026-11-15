**Search DB**
----
  Searches artists, folders, albums, file paths and titles for a given string.

* **URL**

  `/api/v1/db/search`

* **Method:**

  `POST`

* **JSON Params**

   | Field | Type | Required | Description |
   |---|---|---|---|
   | `search` | `string` | Yes | Search text. Words starting with `-` exclude results that contain that word (`love -remix`). Words without a letter or digit are ignored. |
   | `noArtists`, `noAlbums`, `noTitles`, `noFiles`, `noFolders` | `boolean` | No | `true` skips that result group. |
   | `ignoreVPaths` | `string[]` | No | Exclude these root vpaths. |
   | `filepathPrefix` | `string` | No | Only files whose path starts with this prefix (albums, files, titles). |
   | `excludeFilepathPrefixes` | `{ vpath, prefix }[]` | No | Exclude files under these prefixes (albums, files, titles). |

* **JSON Example**

  ```json
  {
    "search": "The Offsp"
  }
  ```

* **Success Response:**

  * **Code:** 200 <br />
    **Content:**

    ```json
    {
      "artists": [ { "name": "The Offspring", "variants": ["The Offspring", "Offspring"] } ],
      "folders": [ { "vpath": "Music", "dirpath": "Punk/The Offspring", "folder_name": "The Offspring", "browse_path": "/Music/Punk/The Offspring" } ],
      "albums":  [ { "name": "Smash", "album_art_file": "abc.jpg", "album_version": null, "duration": 210.5, "filepath": false } ],
      "files":   [ { "name": "Music/Punk/The Offspring/Smash/05 Self Esteem.mp3", "album_art_file": null, "album_version": null, "duration": 257.1, "filepath": "Music/Punk/The Offspring/Smash/05 Self Esteem.mp3" } ],
      "title":   [ { "name": "The Offspring - Self Esteem", "album_art_file": null, "album_version": null, "duration": 257.1, "filepath": "Music/Punk/The Offspring/Smash/05 Self Esteem.mp3" } ]
    }
    ```

    - Albums, files and titles are capped at 30 entries each.
    - Artists come from the normalised artist index (see [artists.md](artists.md)).
    - A search with no usable word returns all five groups empty.
