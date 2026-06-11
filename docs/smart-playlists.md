# Smart Playlists

Smart Playlists are dynamic filter-based playlists that query the live music library on demand. Unlike static playlists (which store a fixed list of songs), smart playlists re-evaluate each time they are run.

## How it works

1. Open the **Smart Playlists** section in the sidebar and click **+** to open the builder.
2. Set your filter criteria (genre, year range, min rating, play status, starred, artist search, library).
3. Pick sort order and max song count.
4. Optionally enable **Fresh Picks** for a different random selection every time.
5. The "X songs match" counter updates live as you adjust filters.
6. Click **▶ Preview** to run and see the results.
7. Click **Save** to give it a name and save it permanently.
8. Saved playlists appear in the sidebar — click to run them at any time.

## Filter options

| Filter | Description |
|---|---|
| **Genres** | Multi-select chip list grouped by genre category. Leave empty for all genres. Clicking a group name selects/deselects the entire group. Genre groups are configured by the admin under **Groups & Genres**. |
| **Libraries** | Toggle pills — one per music library (vpath). Shown only when the server has more than one music folder. Deselect a library to exclude it. Selecting only a child sub-library correctly applies a filepath prefix filter. Only shown for music-type folders (audiobooks are excluded). |
| **Year range** | From/to year range. Leave empty for any year. |
| **Min rating** | Minimum star rating (raw DB: 0=any, 2=★, 4=★★, 6=★★★, 8=★★★★, 10=★★★★★). |
| **Play status** | Any / Never played / Played / At least N plays. |
| **Starred only** | Checkbox — only include starred songs. |
| **Artist search** | Case-insensitive substring match on artist name. |

## Fresh Picks

The **Fresh Picks** toggle (shown below the Sort section) makes the playlist return a different random selection every time it is opened.

- When enabled, `sort=random` is used at run time regardless of the saved sort setting.
- The underlying saved sort preference is preserved and used when Fresh Picks is off.
- A shuffle icon (⇄) appears next to the playlist name in the sidebar nav.
- A **New picks** button appears in the results header — click it to re-shuffle without editing.
- Preview also honours Fresh Picks: clicking ▶ Preview with Fresh Picks on always shows a fresh selection.

Typical use: set genre filters to your taste, leave the max songs at 50, enable Fresh Picks — click the playlist daily for a new discovery mix.

## Sort options

`artist` (default), `album`, `year_asc`, `year_desc`, `rating`, `play_count`, `last_played`, `random`

## API

All routes require authentication (token in query string or cookie).

### `GET /api/v1/smart-playlists`
Returns all saved smart playlists for the current user.

**Response:** `{ playlists: [{ id, name, filters, sort, limit_n, created }] }`

### `POST /api/v1/smart-playlists/run`
Executes a smart playlist filter and returns matching songs (without saving).

**Body:** `{ filters, sort, limit }`  
**Response:** `{ songs: [...], total: N }`

### `POST /api/v1/smart-playlists/count`
Returns a count of matching songs (for the live preview counter).

**Body:** `{ filters }`  
**Response:** `{ count: N }`

### `POST /api/v1/smart-playlists`
Saves a new named smart playlist.

**Body:** `{ name, filters, sort, limit }`  
**Response:** `{ id, name }`

### `PUT /api/v1/smart-playlists/:id`
Updates an existing smart playlist.

**Body:** `{ name, filters, sort, limit }`

### `DELETE /api/v1/smart-playlists/:id`
Deletes a smart playlist.

## Database schema

```sql
CREATE TABLE IF NOT EXISTS smart_playlists (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user     TEXT NOT NULL,
  name     TEXT NOT NULL,
  filters  TEXT NOT NULL DEFAULT '{}',  -- JSON
  sort     TEXT NOT NULL DEFAULT 'artist',
  limit_n  INTEGER NOT NULL DEFAULT 100,
  created  INTEGER NOT NULL,
  UNIQUE(user, name)
);
CREATE INDEX IF NOT EXISTS idx_spl_user ON smart_playlists(user);
```

The `filters` field is a JSON blob with the shape:

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
| `genres` | `string[]` | `[]` | Display genre names to include. Empty = all. |
| `yearFrom` | `number\|null` | `null` | Earliest release year. |
| `yearTo` | `number\|null` | `null` | Latest release year. |
| `minRating` | `0\|2\|4\|6\|8\|10` | `0` | Minimum DB rating value. `0` = any. |
| `playedStatus` | `"any"\|"never"\|"played"` | `"any"` | Filter by play history. |
| `minPlayCount` | `number` | `0` | When `playedStatus="played"`, minimum play count. |
| `starred` | `boolean` | `false` | If true, only starred songs. |
| `artistSearch` | `string` | `""` | Substring match on artist name. |
| `selectedVpaths` | `string[]` | `[]` | Library names to include. Empty = all. |
| `freshPicks` | `boolean` | `false` | Client-only flag; stored as-is. Server ignores it (sort is provided separately). |
