**Get Songs for Album**
----
  Retrieves all songs and metadata for a given album, sorted by disc, track and file path.

* **URL**

  `/api/v1/db/album-songs`

* **Method:**

  `POST`

* **Auth:** any user (only the user's own vpaths are searched)

*  **JSON Params** (all optional)

   | Field | Type | Description |
   |---|---|---|
   | `album` | `string` | Album tag. Omitted or empty → songs with no album tag. |
   | `artist` | `string` | Match `album_artist` (else `artist`) exactly |
   | `artists` | `string[]` | Same as `artist`, for several names (wins over `artist`) |
   | `year` | `number` | Only songs with this year |
   | `albumDir` | `string` | Only files under this folder (filepath relative to the vpath) |
   | `folderOnly` | `boolean` | `true` ignores `album`/`artist`/`artists` — `albumDir` alone defines the album |
   | `ignoreVPaths` | `string[]` | Exclude entire root vpaths |
   | `excludeFilepathPrefixes` | `{ vpath, prefix }[]` | Exclude rows under these prefixes |
   | `includeFilepathPrefixes` | `{ vpath, prefix }[]` | Whitelist — only rows under these prefixes for the named vpaths |

* **JSON Example**

  ```json
  {
    "album": "Album Name",
    "artist": "Artist"
  }
  ```

* **Success Response:**

  * **Code:** 200 <br />
    **Content:** an array of song objects, the same shape as [`POST /api/v1/db/metadata`](db_metadata.md):

    ```json
    [
      {
        "filepath": "Music/path/to/file.mp3",
        "metadata": {
          "artist": "Artist",
          "album": "Greatest Hits",
          "track": 9,
          "title": "Title",
          "year": 1988,
          "album-art": "album-art-filename.jpg",
          "hash": "md5 hash",
          "duration": 237.431
        },
        "rg": null
      }
    ]
    ```
