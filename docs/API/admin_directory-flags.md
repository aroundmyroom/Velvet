# Admin — Directory Flags

**Update per-folder flags for an existing configured directory.**

---

## PATCH /api/v1/admin/directory/flags

Toggles feature flags on a vpath that is already configured in Velvet. At least one flag must be provided.

* **Auth:** admin token required

* **JSON Params:**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `vpath` | `string` | ✅ | The vpath name to update |
  | `allowRecordDelete` | `boolean` | one of these | Allow users to delete recordings. Only valid for `recordings` and `youtube` folders. |
  | `albumsOnly` | `boolean` | one of these | Mark this folder as Albums-Only — its content is used by the Albums view. Not allowed on `recordings` / `youtube` folders. |
  | `dlnaEnabled` | `boolean` | one of these | Serve this folder over DLNA/UPnP. Not allowed on `recordings`, `youtube` or `excluded` folders. |
  | `artistsOn` | `boolean` | one of these | Include this folder in the artist features (artist index). Not allowed on `excluded` folders. Changing it starts a background rebuild of the artist index. |

  At least one of `allowRecordDelete`, `albumsOnly`, `dlnaEnabled` or `artistsOn` must be present. Setting `allowRecordDelete`, `albumsOnly` or `dlnaEnabled` to `false` removes the key from the folder config.

* **Request Example — enable Albums-Only:**

  ```json
  {
    "vpath": "Albums",
    "albumsOnly": true
  }
  ```

* **Request Example — disable Albums-Only:**

  ```json
  {
    "vpath": "Albums",
    "albumsOnly": false
  }
  ```

* **Request Example — allow recording deletion:**

  ```json
  {
    "vpath": "RadioRecs",
    "allowRecordDelete": true
  }
  ```

* **Success Response:**

  * **Code:** 200  
    **Content:** `{}`

* **Error Responses:**

  | Code | Reason |
  |---|---|
  | 400 | Validation failed, no flag provided, or flag not applicable to folder type |
  | 404 | `vpath` not found in current config |

---

## albumsOnly behaviour

When `albumsOnly: true` is set on one or more folders, the Albums view will **only** show albums from those folders. All other folders are excluded from the albums browser (they remain fully accessible for playback, search, and Auto-DJ).

- If **no** folder has `albumsOnly: true`, Velvet falls back to the first root vpath that has an `Albums/` subdirectory on disk (unless that subdirectory is itself a configured vpath).
- Flagging a **root** vpath (no parent) includes all files under that root.
- Flagging a **child** vpath includes only the files under its `filepathPrefix` within the parent vpath.
- Multiple child folders from the same parent can all be flagged — they are combined with OR logic (whitelist union).

The flag is propagated to the client via `GET /api/v1/ping` in `vpathMetaData[vpath].albumsOnly`.

See [Albums-Only feature documentation](../albums-only.md) for the full user-facing guide.
