**Get Albums**
----
  Gets all albums from the indexed library.

* **URL**

  `/api/v1/db/albums`

* **Methods:**

  `GET` — returns all albums with no filtering  
  `POST` — returns albums with optional filtering parameters

---

### GET /api/v1/db/albums

Returns the complete album list for the authenticated user's vpaths.

* **Success Response:**

  * **Code:** 200  
    **Content:**

    ```json
    {
      "albums": [
        { "name": "Thriller", "year": 1982, "album_art_file": "abc123.jpg" },
        { "name": "Homework",  "year": 1997, "album_art_file": null }
      ]
    }
    ```

---

### POST /api/v1/db/albums

Returns albums with optional vpath and filepath filtering. Used by the player to implement Albums-Only and audio-book exclusions.

* **JSON Params** (all optional):

  | Field | Type | Description |
  |---|---|---|
  | `ignoreVPaths` | `string[]` | Exclude entire root vpaths from results |
  | `excludeFilepathPrefixes` | `{ vpath, prefix }[]` | Blacklist — exclude rows where `vpath=X AND filepath LIKE prefix%`. Used to exclude known sub-folders (e.g. AudioBooks). |
  | `includeFilepathPrefixes` | `{ vpath, prefix }[]` | **Whitelist** — for each named parent vpath, only include rows where `filepath LIKE prefix%`. Rows from vpaths not named here pass through unrestricted. Used for Albums-Only filtering. |

* **Filtering precedence:** `ignoreVPaths` → `excludeFilepathPrefixes` → `includeFilepathPrefixes`

* **JSON Example — Albums-Only (show only Music/Albums/ sub-folder):**

  ```json
  {
    "ignoreVPaths": ["Podcasts", "RadioRecs"],
    "includeFilepathPrefixes": [
      { "vpath": "Music", "prefix": "Albums/" }
    ]
  }
  ```

* **JSON Example — audio-book exclusion (blacklist):**

  ```json
  {
    "excludeFilepathPrefixes": [
      { "vpath": "Music", "prefix": "Audiobooks & Podcasts/" }
    ]
  }
  ```

* **Success Response:**

  * **Code:** 200  
    **Content:** Same structure as GET — `{ "albums": [ … ] }`

---

### Child-Vpath Architecture Note

All music files are stored in SQLite under a **single root vpath** (e.g. `Music`). Child vpaths (e.g. `Albums`, `Disco`) are virtual shortcuts — their files live as `vpath = 'Music'` rows with `filepath LIKE 'ChildFolder/%'`. There are no separate DB rows for a child vpath.

When filtering for a child vpath, **always use the whitelist approach** (`includeFilepathPrefixes`) rather than the blacklist (`excludeFilepathPrefixes`). The whitelist is a hard filter; the blacklist only excludes *known* siblings and leaks files stored at the parent root or in any unrecognised sibling.

`GET /api/v1/ping` returns `vpathMeta[vpath] = { parentVpath, filepathPrefix, albumsOnly, … }` so clients know the structure.

See also: [Admin directory flags](admin_directory-flags.md), [Albums-Only feature](../albums-only.md)
