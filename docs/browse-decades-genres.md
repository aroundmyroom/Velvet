# Browse — Decades & Genres

Decades and Genres are two dedicated navigation views reachable from the left sidebar. Both share the same drill-down UI.

---

## How it works

### Decades

The **Decades** view lists every decade represented in your library (years 1900–2030) as a card showing the decade label (e.g. *1980s*) and counts of tracks and albums.

Clicking a decade opens the **Detail view** with two tabs:

| Tab | Content |
|-----|---------|
| **Albums** | Album grid — virtual-scrolled, same card style as the main Albums view |
| **Tracks** | Track list — virtual-scrolled with sort bar |

If a decade has no albums (e.g. isolated tracks with year 1905 but no known album), the Tracks tab is selected automatically so the content is never blank.

### Genres

The **Genres** view lists all normalised genres with track counts, as chips. When an admin has set up genre groups (Admin → Groups & Genres), the chips are shown in collapsible group sections; genres not in any group go to an **Other** section. Clicking a genre opens the same Albums/Tracks tab UI.

Genre normalisation is handled server-side (`src/util/genre-merge.js`): multi-value fields are split on `,` `;` `/`, near-duplicates are merged (`Synth-pop` = `Synthpop` = `Synth Pop`), noise tags (`Genre`, `Misc`, bare numbers, …) are dropped, and genres with fewer than 10 songs are folded into the most word-similar larger genre (or dropped when none is similar).

---

## Tab bar controls

Both views share the same tab bar layout:

```
[ Albums N ]  [ Tracks N ]           [ Filter…  ×]
```

### Albums tab
- Virtual album grid — only visible cards are in the DOM
- Clicking a card opens that album's track list (`viewAlbumSongs`); Back returns to the decade/genre detail view

### Tracks tab
- Virtual scroll — renders only the visible window plus an 8-row buffer; smooth at 5 000+ tracks
- **Sort bar** with pills: **Artist** / **Title** / **Album** / **Year**
  - Click the active pill to toggle ↑ ascending / ↓ descending
  - Client-side sort — instant, no extra network request
  - `S.curSongs` and the Play-all / Add-all header buttons update to match the current sort

### Filter input
- Right-aligned in the tab bar; always visible
- **Albums tab:** filters by album name or artist (case-insensitive substring)
- **Tracks tab:** filters by title, artist, or album
- No extra API call — all filtering is client-side over the data already loaded
- Filter value is **preserved when switching tabs** (e.g. type "Pink Floyd", switch from Albums to Tracks without losing the query)
- The **×** clear button appears only when the field is non-empty; clicking it resets the filter and re-focuses the input
- Tab count pills always show the **total unfiltered count** so users can see the full size of the set

---

## API endpoints

| Method | Path | Parameters | Returns |
|--------|------|-----------|---------|
| `GET` / `POST` | `/api/v1/db/decades` | POST: `{ ignoreVPaths? }` | `{ decades: [{ decade, cnt, albums }] }` |
| `POST` | `/api/v1/db/decade/albums` | `{ decade, ignoreVPaths?, excludeFilepathPrefixes? }` | `{ albums: [{ name, artist, year, album_art_file }] }` |
| `POST` | `/api/v1/db/decade/songs` | `{ decade, ignoreVPaths? }` | `[song…]` (full metadata objects) |
| `GET` / `POST` | `/api/v1/db/genres` | POST: `{ ignoreVPaths? }` | `{ genres: [{ genre, cnt }] }` |
| `GET` | `/api/v1/db/genre-groups` | — | `{ groups, genres }` — the admin's groups, or automatic groups when none are saved |
| `POST` | `/api/v1/db/genre/albums` | `{ genre, ignoreVPaths?, excludeFilepathPrefixes? }` | `{ albums: [{ name, artist, year, album_art_file }] }` |
| `POST` | `/api/v1/db/genre/songs` | `{ genre, ignoreVPaths? }` | `[song…]` (full metadata objects) |

All responses are filtered by the requesting user's accessible vpaths (and child-vpath scopes).

---

## Key frontend functions

| Function | File | Purpose |
|----------|------|---------|
| `viewDecades()` | `webapp/app.js` | Renders the decade grid |
| `viewDecadeDetail(decade, label, defaultTab)` | `webapp/app.js` | Opens the shared detail view for a decade |
| `viewGenres()` | `webapp/app.js` | Renders the genre chips / group sections |
| `viewGenreDetail(genre, defaultTab)` | `webapp/app.js` | Opens the shared detail view for a genre |
| `_viewBrowseDetail({...})` | `webapp/app.js` | Parallel-fetches albums + songs, renders tab bar and filter |
| `_mountAlbumVScroll(albums, buildCard, onClick, containerEl)` | `webapp/app.js` | Virtual album grid, optional target container |
| `_mountSongVScroll(allSongs, container)` | `webapp/app.js` | Virtual track list with sort bar |
| `_showSongsIn(songs, container)` | `webapp/app.js` | Thin wrapper over `_mountSongVScroll` |

---

## DB functions

| Function | Module | Query |
|----------|--------|-------|
| `getDecades(vpaths, ignoreVPaths, includeFilepathPrefixes)` | `src/db/manager.js` | Distinct decades with track + album counts |
| `getAlbumsByDecade(decade, vpaths, ignoreVPaths, excludeFilepathPrefixes, includeFilepathPrefixes)` | `src/db/manager.js` | Albums for a decade |
| `getSongsByDecade(decade, vpaths, username, ignoreVPaths, includeFilepathPrefixes)` | `src/db/manager.js` | All tracks for a decade (year range) |
| `getGenres(vpaths, ignoreVPaths, opts)` | `src/db/manager.js` | Raw genre strings with track counts (merged by `mergeGenreRows()`) |
| `getAlbumsByGenre(rawGenres, vpaths, ignoreVPaths, excludeFilepathPrefixes, includeFilepathPrefixes)` | `src/db/manager.js` | Albums for a genre (post-normalisation) |
| `getSongsByGenreRaw(rawGenres, vpaths, username, ignoreVPaths, includeFilepathPrefixes)` | `src/db/manager.js` | All tracks for a genre |
