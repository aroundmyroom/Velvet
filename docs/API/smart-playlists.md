**Smart Playlists** *(GitHub Copilot, 2026-03-22)*

Dynamic filter-based playlists that query the library on demand. All routes require authentication. Users can only read and modify their own smart playlists.

See [docs/smart-playlists.md](../smart-playlists.md) for the full user-facing guide.

---

## List saved smart playlists

* **URL:** `GET /api/v1/smart-playlists`
* **Auth:** required

**Response `200`:**
```json
{
  "playlists": [
    {
      "id": 1,
      "name": "Evening Chill",
      "filters": { "genres": ["Electronic"], "minRating": 6, "freshPicks": true, ... },
      "sort": "random",
      "limit_n": 50,
      "created": 1742650000
    }
  ]
}
```

---

## Run a smart playlist (no save)

Executes a filter and returns matching songs without saving anything.

* **URL:** `POST /api/v1/smart-playlists/run`
* **Auth:** required

**Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `filters` | `object` | Yes | Filter object — see [filters schema](#filters-schema). |
| `sort` | `string` | No | One of `artist`, `album`, `year_asc`, `year_desc`, `rating`, `play_count`, `last_played`, `random`. Default: `artist`. |
| `limit` | `number` | No | Max songs to return (1–1000). Default: `100`. |

**Response `200`:**
```json
{
  "songs": [ { "filepath": "Music/artist/album/track.mp3", "metadata": { ... } } ],
  "total": 42
}
```

**Notes:**
- When the client has `freshPicks: true` in filters, it passes `sort: "random"` in the request.
- `selectedVpaths` is resolved server-side: child vpaths are translated to a `filepathPrefix` instead of a vpath exclusion, because child files are stored under the parent vpath in the DB.
- Genre display names are reverse-mapped to raw DB strings automatically (handles multi-value genre fields like `"Pop/Rock, Disco"`).

---

## Count matching songs

Returns only the count of songs that match the filter. Used for the live "X songs match" preview counter in the builder UI.

* **URL:** `POST /api/v1/smart-playlists/count`
* **Auth:** required

**Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `filters` | `object` | Yes | Filter object — see [filters schema](#filters-schema). |

**Response `200`:**
```json
{ "count": 127 }
```

---

## Save a new smart playlist

* **URL:** `POST /api/v1/smart-playlists`
* **Auth:** required

**Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Display name (1–200 chars, trimmed). Must be unique per user. |
| `filters` | `object` | Yes | Filter object. |
| `sort` | `string` | No | Sort order. Default: `artist`. |
| `limit` | `number` | No | Max songs (1–1000). Default: `100`. |

**Response `200`:**
```json
{ "id": 7, "name": "Evening Chill" }
```

**Error `409`:** A playlist with that name already exists for this user.

---

## Update an existing smart playlist

* **URL:** `PUT /api/v1/smart-playlists/:id`
* **Auth:** required

**Body:** Same as save. All fields required.

**Response `200`:** `{}`

**Error `404`:** Playlist not found or belongs to another user.

---

## Delete a smart playlist

* **URL:** `DELETE /api/v1/smart-playlists/:id`
* **Auth:** required

**Response `200`:** `{}`

**Error `404`:** Playlist not found or belongs to another user.

---

## Filters schema

```json
{
  "genres":         ["Rock", "Electronic"],
  "yearFrom":       1990,
  "yearTo":         2009,
  "minRating":      6,
  "playedStatus":   "any",
  "minPlayCount":   0,
  "starred":        false,
  "artistSearch":   "",
  "selectedVpaths": ["Music"],
  "freshPicks":     true
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `genres` | `string[]` | `[]` | Display genre names to include. Empty = all genres. |
| `yearFrom` | `number\|null` | `null` | Earliest release year (inclusive). |
| `yearTo` | `number\|null` | `null` | Latest release year (inclusive). |
| `minRating` | `0\|2\|4\|6\|8\|10` | `0` | Minimum DB rating. `0` = any. |
| `playedStatus` | `"any"\|"never"\|"played"` | `"any"` | Filter by play history. |
| `minPlayCount` | `number` | `0` | When `playedStatus="played"`, require at least this many plays. |
| `starred` | `boolean` | `false` | Only include starred songs. |
| `artistSearch` | `string` | `""` | Case-insensitive artist name substring match. |
| `selectedVpaths` | `string[]` | `[]` | Library (vpath) names to include. Empty = all. Resolved server-side for parent/child relationships. |
| `freshPicks` | `boolean` | `false` | Stored as-is; the client sends `sort="random"` when this is on. Server strips this field before querying. |

---

## Database schema

```sql
CREATE TABLE IF NOT EXISTS smart_playlists (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user     TEXT NOT NULL,
  name     TEXT NOT NULL,
  filters  TEXT NOT NULL DEFAULT '{}',
  sort     TEXT NOT NULL DEFAULT 'artist',
  limit_n  INTEGER NOT NULL DEFAULT 100,
  created  INTEGER NOT NULL,
  UNIQUE(user, name)
);
CREATE INDEX IF NOT EXISTS idx_spl_user ON smart_playlists(user);
```
