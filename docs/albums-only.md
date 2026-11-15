# Albums-Only Folders

## The Problem Velvet Used to Have

Velvet has always been great at discovering music. But it always faced one awkward question: *what actually counts as an album?*

The answer used to be: anything the scanner found with a non-empty `album` tag. That sounds reasonable — until you look at a real-world music library.

If you store DJ sets, radio recordings, compilations of random singles, 12-inch singles filed by artist, or just loose tracks dropped into a folder, all of them have `album` tags. Your Albums view would end up looking like a garage sale — hundreds of entries that are technically *tagged* as albums but are not albums in any meaningful sense. The system had no way to tell the difference between *Thriller* and *"Various - Top 40 Radio Rip - 1987-03-12"*.

## The Solution: Let You Decide

With the **Albums-Only** flag, **you** determine which folders contain real albums — and only those folders feed the Album Library (the **Albums** button in the player's left navigation).

When you flag a folder as Albums-Only, the Album Library draws exclusively from that folder. Everything else — singles collections, DJ sets, radio rips — stays in your library for playback and Auto-DJ, but does not clutter your Albums browser.

If no folder has the flag set, the Album Library falls back to the first root folder that has an `Albums/` sub-folder on disk. If there is no such folder either, the Album Library is empty and asks you to enable Albums Only on at least one folder.

## How to Enable It

Open the **Admin panel → Directories**. Each folder card has a button labelled **Albums Only: On / Albums Only: Off**. Click it for every folder that should contribute to the Album Library. The button is not shown for `recordings`, `youtube` and `excluded` folders; those can not be Albums-Only.

The change takes effect immediately for browsing — no rescan required. Album version badges are only extracted for files inside Albums-Only folders, so they appear after the next scan.

## Setting It Up for Your Library

### "I only have albums"

If your entire library is organised album-by-album, the easiest approach is to flag the root folder as Albums-Only. The Album Library then shows everything under it.

### "I have a mix of albums and other content"

This is where Albums-Only really shines. Suppose your root vpath is `Music`, and underneath it you have:

- `Music/Albums/` — fully organised albums
- `Music/Disco/` — single tracks and 12-inch edits
- `Music/TOP40/` — radio-rip collections
- `Music/DJ-Sets/` — recorded DJ sets

Add `Music/Albums/` as its own (child) folder named `Albums` and flag it as Albums-Only. The Album Library will now show only what lives inside `Music/Albums/`. Everything else remains available for search, Auto-DJ, and the file browser — it just does not appear in the Albums view.

### "I have multiple album folders under one root"

You can flag as many child folders as you like. If `Music/Albums/` and `Music/Classical/` are both Albums-Only, both contribute to the Album Library. Everything else under `Music/` is excluded. With two or more sources the Album Library shows a pill per source so you can filter by source.

### "My root folder itself is an albums folder"

Flagging a root vpath (one without a parent) as Albums-Only includes the **entire** root, with no prefix filtering. All albums found anywhere under that root will appear.

## Child Vpaths Under the Hood

Velvet stores all music in SQLite under the root vpath. A child vpath like `Albums` is a virtual shortcut — the actual DB rows are stored as `vpath = 'Music'` with `filepath LIKE 'Albums/%'`. There are no separate rows for `Albums` in the database.

This is exactly how Auto-DJ handles child-vpath filtering: it does not try to exclude everything else — it *whitelists* the specific prefix. When `Albums` is Albums-Only, the query becomes:

```sql
WHERE vpath = 'Music' AND filepath LIKE 'Albums/%'
```

This is a hard whitelist. Files stored directly at the root (`Music/loose-track.mp3`) and files in any non-vpath subfolder cannot leak in, regardless of how many sibling folders exist or whether they have been defined as vpaths.

## Where Else the Flag Is Used

- **Artist profile**: the *Albums* section shows Album Library albums; the *Songs* section shows the artist's tracks that are **not** in an Albums-Only folder.
- **Album song list** (opening an album from an artist page): restricted to Albums-Only folders, except when opened from search.
- **DLNA**: when no folder has a `dlnaEnabled` setting yet, DLNA falls back to the Albums-Only folders.
- **Album version badges**: the scanner only extracts `album_version` for files in Albums-Only folders.

## What the Albums-Only Flag Does NOT Affect

- **Genres / Decades**: the genre browser and decade browser always show the full library.
- **Auto-DJ**: has its own, independent vpath selection in the DJ panel.
- **Search**: always searches the whole library.
- **File browser**: unaffected.
- **Subsonic**: the album lists span all of the user's folders; Albums-Only scoping is not applied there.
- **Playback**: any track can always be played; Albums-Only is purely a view filter.

## API

For API consumers:

- `GET /api/v1/ping` — the `vpathMetaData` object carries `albumsOnly: bool` per vpath (plus `parentVpath` and `filepathPrefix`).
- `PATCH /api/v1/admin/directory/flags` — set `albumsOnly: true|false` for a folder.
- `GET /api/v1/albums/browse` — the Album Library tree built from the Albums-Only sources.
- `POST /api/v1/db/albums`, `POST /api/v1/db/artists-albums` and `POST /api/v1/db/album-songs` — accept `includeFilepathPrefixes` (whitelist) and `excludeFilepathPrefixes` in addition to `ignoreVPaths`. The player builds these from the `vpathMetaData` data.

See [API/db_albums.md](API/db_albums.md), [API/albums_browse.md](API/albums_browse.md) and [API/admin_directory-flags.md](API/admin_directory-flags.md) for full parameter reference.
