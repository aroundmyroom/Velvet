# Albums-Only Folders

## The Problem Velvet Used to Have

Velvet has always been great at discovering music. But it always faced one awkward question: *what actually counts as an album?*

The answer used to be: anything the scanner found with a non-empty `album` tag. That sounds reasonable — until you look at a real-world music library.

If you store DJ sets, radio recordings, compilations of random singles, 12-inch singles filed by artist, or just loose tracks dropped into a folder, all of them have `album` tags. Your Albums view would end up looking like a garage sale — hundreds of entries that are technically *tagged* as albums but are not albums in any meaningful sense. The system had no way to tell the difference between *Thriller* and *"Various - Top 40 Radio Rip - 1987-03-12"*.

## The Solution: Let You Decide

With the **Albums-Only** flag, **you** determine which folders contain real albums — and only those folders feed the Albums view.

The idea is simple: when you flag a folder as Albums-Only, the Albums view draws exclusively from that folder. Everything else — singles collections, DJ sets, radio rips — stays in your library for playback and Auto-DJ, but does not clutter your Albums browser.

If no folder has the flag set, the Albums view continues to work exactly as before — it shows everything.

## How to Enable It

Open the **Admin panel → Directories** card. Each folder has a toggle labelled **Alb: On / Alb: Off**. Flip it on for every folder that should contribute to the Albums view.

The change takes effect immediately — no rescan required.

## Setting It Up for Your Library

### "I only have albums"

If your entire library is organised album-by-album, the easiest approach is to flag **every** folder (including all child folders under a root) as Albums-Only. The Albums view will show everything, exactly as before, but it is now explicit and consistent.

### "I have a mix of albums and other content"

This is where Albums-Only really shines. Suppose your root vpath is `Music`, and underneath it you have:

- `Music/Albums/` — fully organised albums
- `Music/Disco/` — single tracks and 12-inch edits
- `Music/TOP40/` — radio-rip collections
- `Music/DJ-Sets/` — recorded DJ sets

Flag `Albums` as Albums-Only. The Albums view will now show only what lives inside `Music/Albums/`. Everything else remains available for search, Auto-DJ, and the file browser — it just does not appear in the Albums tab.

### "I have multiple album folders under one root"

You can flag as many child folders as you like. If `Music/Albums/` and `Music/Classical/` are both Albums-Only, both contribute to the Albums view. Everything else under `Music/` is excluded.

### "My root folder itself is an albums folder"

Flagging a root vpath (one without a parent) as Albums-Only includes the **entire** root, with no prefix filtering. All albums found anywhere under that root will appear.

## Child Vpaths Under the Hood

Velvet stores all music in SQLite under the root vpath. A child vpath like `Albums` is a virtual shortcut — the actual DB rows are stored as `vpath = 'Music'` with `filepath LIKE 'Albums/%'`. There are no separate rows for `Albums` in the database.

This is exactly how Auto-DJ handles child-vpath filtering: it does not try to exclude everything else — it *whitelists* the specific prefix. When `Albums` is Albums-Only, the query becomes:

```sql
WHERE vpath = 'Music' AND filepath LIKE 'Albums/%'
```

This is a hard whitelist. Files stored directly at the root (`Music/loose-track.mp3`) and files in any non-vpath subfolder cannot leak in, regardless of how many sibling folders exist or whether they have been defined as vpaths.

## What the Albums-Only Flag Does NOT Affect

- **Genres / Decades**: the genre browser and decade browser always show the full library. They are independent views and are never filtered by Albums-Only.
- **Auto-DJ**: has its own, independent vpath selection in the DJ panel.
- **Search**: always searches the whole library.
- **File browser / dirparser**: unaffected.
- **Playback**: any track can always be played; Albums-Only is purely a view filter.

## API

For API consumers:

- `GET /api/v1/ping` — the `vpathMeta` object now carries `albumsOnly: bool` per vpath.
- `PATCH /api/v1/admin/directory/flags` — set `albumsOnly: true|false` for a folder.
- `POST /api/v1/db/albums` and `POST /api/v1/db/artists-albums` — accept `includeFilepathPrefixes` (whitelist) in addition to the existing `ignoreVPaths` and `excludeFilepathPrefixes` parameters. The player uses these automatically based on the vpathMeta data.

See [API/db_albums.md](API/db_albums.md) and [API/admin_directory-flags.md](API/admin_directory-flags.md) for full parameter reference.
