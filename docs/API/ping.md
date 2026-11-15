**Ping**
----
  Used to check if the user is logged in. Also returns the user's vpaths,
  folder metadata and permissions.

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
    "vpaths": ["Music", "Albums", "Audiobooks"],
    "noUpload": false,
    "supportedAudioFiles": {
      "mp3": true, "flac": true, "wav": true, "ogg": true, "aac": true,
      "m4a": true, "m4b": true, "opus": true, "m3u": false
    },
    "vpathMetaData": {
      "Music":      { "type": "music", "parentVpath": null, "filepathPrefix": null, "allowRecordDelete": false, "albumsOnly": false },
      "Albums":     { "type": "music", "parentVpath": "Music", "filepathPrefix": "Albums/", "allowRecordDelete": false, "albumsOnly": true },
      "Audiobooks": { "type": "audio-books", "parentVpath": null, "filepathPrefix": null, "allowRecordDelete": false, "albumsOnly": false }
    },
    "vpathWriteAccess": { "Music": true, "Albums": true, "Audiobooks": false },
    "allowRadioRecording": false,
    "allowYoutubeDownload": false,
    "allowUpload": true,
    "allowServerRemote": false,
    "allowMpvCast": false,
    "version": "0.9.3",
    "defaultTheme": "velvet"
  }
  ```

  | Field | Type | Description |
  |---|---|---|
  | `vpaths` | `string[]` | Virtual paths the authenticated user has access to. |
  | `noUpload` | `boolean` | `true` when the server has uploads globally disabled. |
  | `supportedAudioFiles` | `object` | Map of file extension → `boolean` (config `supportedAudioFiles`). Extensions set to `true` are playable and uploadable. |
  | `vpathMetaData` | `object` | Per-vpath metadata. See table below. |
  | `vpathWriteAccess` | `object` | **Admins only.** Map of vpath → `true` when the server can write to that folder's root. Used to gate art-search and tag-edit buttons. |
  | `allowRadioRecording` | `boolean` | User has `allow-radio-recording`. |
  | `allowYoutubeDownload` | `boolean` | User has `allow-youtube-download`. |
  | `allowUpload` | `boolean` | `false` when `noUpload` is set or the user has `allow-upload: false`. |
  | `allowServerRemote` | `boolean` | Server Audio (MPV) is enabled and the user does not have `allow-server-remote: false`. |
  | `allowMpvCast` | `boolean` | Server Audio (MPV) is enabled and the user is an admin or has `allow-mpv-cast: true`. |
  | `version` | `string` | Server version from `package.json`. |
  | `defaultTheme` | `string` | Server default theme (config `ui`, without a `velvet-` prefix). |

  **`vpathMetaData[vpath]` fields:**

  | Field | Type | Description |
  |---|---|---|
  | `type` | `string` | Folder type: `"music"`, `"audio-books"`, `"recordings"`, `"youtube"`, `"excluded"` |
  | `parentVpath` | `string\|null` | Set when this is a **child vpath** — the root vpath that actually holds the files in the DB. Child vpaths have no DB rows of their own; their files are stored under the parent with `filepath LIKE filepathPrefix + '%'`. `null` for a root vpath. |
  | `filepathPrefix` | `string\|null` | The sub-folder prefix within the parent vpath, ending in `/` (e.g. `"Albums/"`). `null` for a root vpath. |
  | `albumsOnly` | `boolean` | `true` when this folder is flagged as Albums-Only. See [Albums-Only](../albums-only.md). |
  | `allowRecordDelete` | `boolean` | `true` when users may delete recordings in this folder. |

* **Error Response:**

  * **Code:** 401 — `{ "error": "Authentication Error" }` when the token is missing or invalid.

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
  { "status": "ok", "instanceId": "…", "hasUsers": true }
  ```

  | Field | Description |
  |---|---|
  | `status` | Always `"ok"`. |
  | `instanceId` | ID of this server instance. The client uses it to detect a different server and clear stale local storage. |
  | `hasUsers` | `true` when at least one user is configured (login required); `false` on a no-auth server. |
