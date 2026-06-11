# Search

The search view is accessible via the magnifying-glass icon in the bottom navigation bar.

## Basic usage

Type at least 2 characters — results appear after a 600 ms debounce. The search
matches against:

| Field | Shown as |
|---|---|
| ID3 `artist` | Artists section |
| ID3 `album` | Albums section |
| ID3 `title` | Songs section |
| Filename (`filepath`) | Songs section (filename-only rows, deduplicated against title hits) |

Multi-word queries (e.g. *chaka khan fate*) additionally run a cross-field scan
so that tokens spread across different tags still produce a match.

Server-side search results are capped at **30 items per category** (`albums`,
`title`, `files`) to keep broad queries responsive and avoid heavy FTS scans.
A note is shown when there are more matches — refine the query to narrow down.

## Vpath filter pills

When the library has more than one vpath configured, a pill row appears below
the search input.

- **All pills ON** by default — searches across the entire library.
- **Toggle a pill OFF** to exclude that vpath from results.
- At least one pill must remain ON (the last selected pill cannot be deselected).
- Selection is preserved across back-navigations within the same session
  (stored in `S.searchVpaths`).

### Child vpaths (sub-folder scopes)

Some vpaths are sub-folders of a parent vpath (e.g. `TOP40` lives inside the
`Music` root). All files are indexed under the parent vpath in the database;
the child vpath is a virtual scope defined by a filepath prefix.

When the selected pills all resolve to the same parent vpath, `doSearch()` sends
`filepathPrefix` to the server instead of `ignoreVPaths`. This correctly scopes
results to files whose `filepath` column starts with the child folder prefix —
the same mechanism used by Auto-DJ.

## API

```
POST /api/v1/db/search
```

| Field | Type | Description |
|---|---|---|
| `search` | string (required) | Search term |
| `ignoreVPaths` | string[] (optional) | Vpath keys to exclude from results |
| `filepathPrefix` | string (optional) | Restrict results to files whose filepath starts with this prefix (used for child-vpath scoping) |
| `noArtists` | boolean (optional) | Skip artist search |
| `noAlbums` | boolean (optional) | Skip album search |
| `noTitles` | boolean (optional) | Skip title search |
| `noFiles` | boolean (optional) | Skip filename search |

**Response:**
```json
{
  "artists": [{ "name": "...", "album_art_file": "..." }],
  "albums":  [{ "name": "...", "album_art_file": "..." }],
  "title":   [{ "name": "Artist - Title", "filepath": "...", "album_art_file": "..." }],
  "files":   [{ "name": "...", "filepath": "...", "album_art_file": "..." }]
}
```

## Search engine — SQLite FTS5

All music searches run against a **FTS5 virtual table** (`fts_files`) instead
of `LIKE '%…%'` full-table scans.

| Property | Value |
|---|---|
| Tokenizer | `unicode61 remove_diacritics 1` |
| Diacritic folding | yes — café matches cafe |
| Case | insensitive |
| Prefix matching | yes — `lenn*`, `talk*` |
| Ranking | BM25 (best matches first) |
| Columns indexed | `title`, `artist`, `album`, `filepath` |
| Backing table | external-content on `files` |

The index is kept in sync automatically:

| Event | FTS action |
|---|---|
| File inserted during scan | row added to FTS index |
| File removed (stale / vpath delete) | row removed or full rebuild |
| Tag edited via admin panel | old entry deleted, new entry inserted |
| First start after upgrade | full rebuild if index is empty |

## Excluding words from results

Prefix a word with `-` or precede it with `NOT` to exclude results that
contain that word:

| Query | Meaning |
|---|---|
| `talking -heads` | tracks with "talking" but NOT "heads" |
| `talking NOT heads` | same |
| `chaka khan -remix` | Chaka Khan tracks that are not remixes |

Multiple exclusions are supported: `disco -medley -megamix`.

