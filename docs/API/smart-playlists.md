**Smart Playlists**

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
      "user": "alice",
      "name": "Evening Chill",
      "filters": { "genres": ["Electronic"], "minRating": 6, "freshPicks": true, ... },
      "sort": "random",
      "limit_n": 50,
      "created": 1742650000
    }
  ]
}
```

Sorted by name (case-insensitive). `created` is Unix seconds.

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

`total` is the number of songs returned (at most `limit`). `metadata` holds `artist`, `hash`, `album`, `track`, `disk`, `title`, `year`, `album-art`, `rating`, `play-count`, `last-played`, `genre`, `replaygain-track-db`, `duration`.

**Notes:**
- When the client has `freshPicks: true` in filters, it passes `sort: "random"` in the request.
- `selectedVpaths` is resolved server-side: a selected child vpath becomes a filepath-prefix whitelist on its parent (unless the parent is selected too), because child files are stored under the parent vpath in the DB. Unselected root vpaths are excluded.
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

**Body:** Same as save (`name` and `filters` required; `sort` and `limit` fall back to their defaults when omitted).

**Response `200`:** `{}`

**Error `404`:** Playlist not found or belongs to another user. **Error `409`:** the new name is already used.

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
| `yearFrom` | `number\|null` | `null` | Earliest release year (inclusive), 1000–9999. |
| `yearTo` | `number\|null` | `null` | Latest release year (inclusive), 1000–9999. |
| `minRating` | integer 0–10 | `0` | Minimum DB rating (the UI sends `0`, `2`, `4`, `6`, `8`, `10` = any, 1★…5★). |
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
