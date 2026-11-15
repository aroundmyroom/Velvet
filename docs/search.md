# Search

The search view is opened with **Search** (magnifying-glass icon) in the player's navigation.

## Basic usage

Type at least 2 characters — results appear after a 600 ms debounce. The search
matches against:

| Source | Shown as |
|---|---|
| Artist index (`artists_normalized`, trigram search on canonical names) | Artists section |
| Folder names (trigram search) | Folders section — opens the folder in the file browser |
| ID3 `album` (plus albums whose `artist` matches) | Albums section |
| ID3 `title` | Songs section |
| Filename (`filepath`) | Songs section (filename-only rows, deduplicated against title hits) |

Multi-word queries (e.g. *chaka khan fate*) additionally run a cross-field scan
so that tokens spread across different tags still produce a match.

When results fall into two or more sections, a tab bar (**All** plus one tab per
section with its count) appears above the results. The chosen tab is kept when you
come back from a drill-down.

Server-side search results are capped at **30 items per category** (`albums`,
`title`, `files`) to keep broad queries responsive and avoid heavy FTS scans.
Artist and folder results are not capped. The Songs section shows 50 rows first and
loads the rest as you scroll.

Audiobook folders are left out of search results.

## Vpath filter pills

When you have access to more than one vpath, a pill row appears below
the search input.

- **All pills ON** by default — searches across the entire library.
- **Toggle a pill OFF** to exclude that vpath from results.
- At least one pill must remain ON (the last selected pill cannot be deselected).
- Selection is preserved across back-navigations until the page is reloaded
  (stored in `S.searchVpaths`).

### Child vpaths (sub-folder scopes)

Some vpaths are sub-folders of a parent vpath (e.g. `TOP40` lives inside the
`Music` root). All files are indexed under the parent vpath in the database;
the child vpath is a virtual scope defined by a filepath prefix.

When the selected pills are all children of the same parent vpath, `doSearch()`
limits the search to that parent. With exactly one child selected it also sends
`filepathPrefix`, so results are scoped to files whose `filepath` column starts with
the child folder prefix — the same mechanism used by Auto-DJ.

## API

```
POST /api/v1/db/search
```

| Field | Type | Description |
|---|---|---|
| `search` | string (required) | Search term |
| `ignoreVPaths` | string[] (optional) | Vpath keys to exclude from results |
| `filepathPrefix` | string (optional) | Restrict results to files whose filepath starts with this prefix (used for child-vpath scoping) |
| `excludeFilepathPrefixes` | `{ vpath, prefix }[]` (optional) | Leave out files under these prefixes |
| `noArtists` | boolean (optional) | Skip artist search |
| `noFolders` | boolean (optional) | Skip folder search |
| `noAlbums` | boolean (optional) | Skip album search |
| `noTitles` | boolean (optional) | Skip title search |
| `noFiles` | boolean (optional) | Skip filename search |

**Response:**
```json
{
  "artists": [{ "name": "...", "variants": ["...", "..."] }],
  "folders": [{ "vpath": "...", "dirpath": "...", "folder_name": "...", "browse_path": "/vpath/dir" }],
  "albums":  [{ "name": "...", "album_art_file": "...", "album_version": null }],
  "title":   [{ "name": "Artist - Title", "filepath": "...", "album_art_file": "...", "duration": 213.4 }],
  "files":   [{ "name": "...", "filepath": "...", "album_art_file": "...", "duration": 213.4 }]
}
```

## Search engine — SQLite FTS5

All song, album and filename searches run against a **FTS5 virtual table** (`fts_files`)
instead of `LIKE '%…%'` full-table scans.

| Property | Value |
|---|---|
| Tokenizer | `unicode61 remove_diacritics 1` |
| Diacritic folding | yes — café matches cafe |
| Case | insensitive |
| Prefix matching | yes — the query is matched as a phrase with a prefix on the last word (`lenn` finds `Lennon`) |
| Ranking | BM25 (best matches first) |
| Columns indexed | `title`, `artist`, `album_artist`, `album`, `album_version`, `filepath` |
| Backing table | external-content on `files` |

The index is kept in sync automatically:

| Event | FTS action |
|---|---|
| File inserted during scan | row added to FTS index |
| File removed (stale / vpath delete) | row removed or full rebuild |
| Tag edited | old entry deleted, new entry inserted |
| Server start | full rebuild if the index is (nearly) empty or misses a column |

## Artist results — tracks shortcut

Each artist row in the **Artists** section has a small list icon on the right side of the row. Clicking the icon opens a flat track list for that artist — all their songs matched by metadata tags — with **Play All** and **Append All** controls. The **back button** returns to the search results.

Clicking the artist *name* (anywhere except the icon) opens the full artist profile (albums, bio). The tracks shortcut is an additive path that skips the profile.

The track list is fetched via `POST /api/v1/db/artist-folder-songs` using the artist name and all name variants returned by the search response (e.g. `"Bob Marley"` and `"Bob Marley & The Wailers"`). Songs in audiobook folders and in Albums-Only folders are left out (those are reached through the profile's Albums tab).

## Album results

Clicking an album result opens it in the Album Library when its folder is part of it (so CUE-backed albums expand into their tracks); otherwise a plain song list for that album tag is shown.

## Song results in an Albums-Only folder

Clicking a song result that lives in an **Albums-Only** vpath opens its album in the Album Library instead of playing the bare file, so CUE-backed albums expand into their tracks. The album is found by folder: first the song's own folder, then one level up, so a track in a disc subfolder (`…/Album (2CD)/cd2/track.mp3`) opens `…/Album (2CD)`.

If no album matches, the song plays and is queued directly. Velvet does not guess an album from the song's `album` tag, because folders with mixed tags would open an album that doesn't exist. The **+** button always queues the song directly.

## Excluding words from results

Prefix a word with `-` to exclude results that contain that word:

| Query | Meaning |
|---|---|
| `talking -heads` | tracks with "talking" but NOT "heads" |
| `chaka khan -remix` | Chaka Khan tracks that are not remixes |

Multiple exclusions are supported: `disco -medley -megamix`. Exclusions apply to
albums, songs and filenames, not to the artist and folder sections.
