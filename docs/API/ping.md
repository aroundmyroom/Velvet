**Ping**
----
  Used to check if the user is logged in. Also used to get the vPath and
  server capabilities.

* **URL**

  `/api/v1/ping`

* **Method:**

  `GET`

* **Headers**

  | Header | Required | Description |
  |---|---|---|
  | `x-access-token` | Yes | User authentication token. |

* **Success Response:**

  * **Code:** 200

  ```json
  {
    "vpaths": ["Music", "Albums", "Disco", "Audiobooks"],
    "playlists": [{"name": "Favourites"}],
    "noUpload": false,
    "transcode": {
      "defaultCodec": "opus",
      "defaultBitrate": "96k",
      "defaultAlgorithm": "stream"
    },
    "supportedAudioFiles": {
      "mp3": true,
      "flac": true,
      "wav": true,
      "ogg": true,
      "aac": true,
      "m4a": true,
      "m4b": true,
      "opus": true,
      "m3u": false
    },
    "vpathMetaData": {
      "Music":      { "type": "music" },
      "Albums":     { "type": "music", "parentVpath": "Music", "filepathPrefix": "Albums/",  "albumsOnly": true },
      "Disco":      { "type": "music", "parentVpath": "Music", "filepathPrefix": "Disco/" },
      "Audiobooks": { "type": "audiobooksPodcasts" }
    }
  }
  ```

  | Field | Type | Description |
  |---|---|---|
  | `vpaths` | `string[]` | Virtual paths the authenticated user has access to. |
  | `playlists` | `object[]` | User's saved playlists. |
  | `noUpload` | `boolean` | `true` when the server has uploads globally disabled. |
  | `transcode` | `object\|false` | Transcode settings, or `false` if disabled. |
  | `supportedAudioFiles` | `object` | Map of file extension → `boolean`. Extensions set to `true` are playable and uploadable. Use this to validate files before upload. *(added by GitHub Copilot, 2026-02-27)* |
  | `vpathMetaData` | `object` | Per-vpath metadata. See table below. |

  **`vpathMetaData[vpath]` fields:**

  | Field | Type | Description |
  |---|---|---|
  | `type` | `string` | Folder type: `"music"`, `"audiobooksPodcasts"`, `"recordings"` |
  | `parentVpath` | `string\|undefined` | Set when this is a **child vpath** — the root vpath that actually holds the files in the DB. Child vpaths have no DB rows of their own; all their files are stored under the parent with `filepath LIKE filepathPrefix + '%'`. |
  | `filepathPrefix` | `string\|undefined` | The sub-folder prefix within the parent vpath (e.g. `"Albums/"`). Only present when `parentVpath` is set. |
  | `albumsOnly` | `boolean\|undefined` | `true` when this folder is flagged as Albums-Only. When any folder carries this flag, the Albums view shows content exclusively from flagged folders. See [Albums-Only](../albums-only.md). |
  | `allowRecordDelete` | `boolean\|undefined` | `true` when users are permitted to delete their own recordings (only on `type: recordings` folders). |

  `transcode` is `false` when the server has transcoding disabled.

* **Error Response:**

  Forwards to `/login` if not logged in.

---

**Public Ping**
----
  Lightweight reachability check that requires no authentication. Useful for
  checking whether the server is online before attempting a login.

* **URL**

  `/api/v1/ping/public`

* **Method:**

  `GET`

* **Headers**

  None required.

* **Success Response:**

  * **Code:** 200

  ```json
  { "status": "ok" }
  ```

* **Notes**

  This endpoint is intentionally minimal — it confirms the server process is
  running and reachable but returns no user or configuration data.
