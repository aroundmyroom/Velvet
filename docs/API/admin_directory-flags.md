# Admin — Directory Flags

**Update per-folder flags for an existing configured directory.**

---

## PATCH /api/v1/admin/directory/flags

Toggles feature flags on a vpath that is already configured in Velvet. At least one flag must be provided.

* **Auth:** admin token required

* **JSON Params:**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `vpath` | `string` | ✅ | The vpath name to update (alphanumeric + hyphens) |
  | `allowRecordDelete` | `boolean` | one of these | Allow users to delete their own recordings. Only valid for `type: recordings` folders. |
  | `albumsOnly` | `boolean` | one of these | Mark this folder as Albums-Only — its content will be included in the Albums view when the flag is active. Not allowed on `type: recordings` folders. |

  At least one of `allowRecordDelete` or `albumsOnly` must be present.

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

- If **no** folder has `albumsOnly: true`, the Albums view shows everything (original behaviour).
- Flagging a **root** vpath (no parent) includes all files under that root.
- Flagging a **child** vpath includes only the files under its `filepathPrefix` within the parent vpath.
- Multiple child folders from the same parent can all be flagged — they are combined with OR logic (whitelist union).

The flag is propagated to the client via `GET /api/v1/ping` in `vpathMeta[vpath].albumsOnly`.

See [Albums-Only feature documentation](../albums-only.md) for the full user-facing guide.
