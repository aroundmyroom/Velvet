# POST /api/v1/playlist/rename

Renames an existing playlist for the authenticated user.

**Auth required**: Yes

## Request

```json
POST /api/v1/playlist/rename
Content-Type: application/json

{
  "oldName": "My Playlist",
  "newName":  "My Renamed Playlist"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `oldName` | string | ✓ | Current name of the playlist |
| `newName` | string | ✓ | New name to assign |

## Responses

### 200 OK
```json
{}
```

### 400 Bad Request
```json
{ "error": "Playlist name already in use" }
```
Returned when `newName` is already taken by another playlist of the same user.

## Notes

- The rename is atomic — `UPDATE playlists SET name = ? WHERE user = ? AND name = ?`
- If `oldName` does not exist the update is a no-op (returns 200, no error)
- Smart playlists are not affected by this endpoint

*Added v6.0.1-velvet*
