# Artist Library

The Artist Library is a dedicated view for browsing your music collection by artist. It combines a smart normalisation layer (which collapses tag variants into a single canonical name), a precomputed index in the database, and a rich client-side UI.

---

## Feature overview (v6.8.0 — first release, refinement ongoing)

| Feature | Status |
|---------|--------|
| Artist home page — "Most Songs in Library" shelf | ✅ |
| Artist home page — "Recently Listened" shelf | ✅ |
| Artist home page — "Most Played Artists" shelf | ✅ |
| Shelf drag-to-reorder (persisted per user) | ✅ |
| A–Z letter browse | ✅ |
| Full-text artist search | ✅ |
| Per-artist album grid with series grouping | ✅ |
| Breadcrumb titles while drilling in | ✅ |
| Correct back-navigation at every level | ✅ |
| Artist biography / info panel | 🔜 planned |
| Admin artist image repair (missing/wrong queues + Discogs picker) | ✅ |
| Custom artist image URL apply (admin) | ✅ |
| Auto-hydration from Discogs/Last.fm fallback | ✅ |
| Per-artist discography stats | 🔜 planned |

---

## How the artist index works

### The `artists_normalized` table

All artist intelligence is stored in a single table:

```sql
CREATE TABLE artists_normalized (
  artist_clean       TEXT PRIMARY KEY,   -- canonical display name
  artist_raw_variants TEXT NOT NULL,     -- JSON array of all raw tags that map here
  song_count         INTEGER NOT NULL DEFAULT 0,
  bio                TEXT,               -- plain-text biography (future: auto-fetched)
  image_file         TEXT                -- filename in image-cache/artists/ (future)
);
```

`artist_clean` is the single name shown in the UI. `artist_raw_variants` is a JSON array like `["Madonna","03_Madonna","madonna "]` — every distinct value seen in the `artist` column of the `files` table that was judged to be the same person.

### Normalisation algorithm (`src/util/artist-normalize.js`)

`buildArtistGroups(rows)` is called with every `{ artist, filepath }` row from the DB and returns a map of `canonicalName → Set<rawVariant>`. It runs a series of passes in order:

**Pass 1 — exclusion of junk tags**
- `PURE_DIGITS_RX` — tags that are just digits (`"01"`, `"42"`) are excluded entirely. These are ripped track numbers that ended up in the artist field; they cannot be attributed to a real artist.

**Pass 2 — normalisation to a clean key**
Each raw tag is run through these transforms in order (first match wins):

1. `PAREN_ONLY_RX` — entire field is a remix credit: `" (Nalin & Kane Remix)"` → artist = `"Nalin & Kane"`.
2. `PAREN_SUFFIX_RX` — remix suffix on a main artist: `"EWF (Phats & Small Remix)"` → artist = `"EWF"`.
3. `UNDERSCORE_PREFIX_RX` — filesystem-numbered tag: `"01_Communards"` → `"Communards"` (underscores replaced with spaces).
4. `PADDED_PREFIX_RX` — zero-padded digit prefix: `"01 Madonna"` → `"Madonna"`.
5. `UNPADDED_PREFIX_RX` (safe) — only applied when a clean variant already has many more songs; prevents `"2 Unlimited"` (235 songs) from collapsing into `"Unlimited"`.

**Pass 3 — similarity/containment merge**
After the explicit passes, any *small* group (≤ 5 songs, `SIM_MAX_CANDIDATE`) whose key, at a word boundary, is **contained within** a *large* group's key (≥ 10 songs, `SIM_MIN_TARGET`, ≥ 5× more songs, key ≥ 5 chars) is merged into the larger group. This catches residual malformed tags like `"Nalin & Kane Remix)"` (missing opening paren) that survive the earlier passes.

### When is the index rebuilt?

`rebuildArtistIndex()` runs automatically at the end of every file scan (`src/api/scanner.js`). It also runs on startup and can be triggered manually from **Admin → Database → Rebuild Artist Index** without waiting for a full scan — useful after algorithm improvements.

As of `v6.8.3`, rebuild execution is offloaded to a `worker_thread` so heavy normalization does not block the main server event loop. This keeps audio streaming responsive while the artist index is being rebuilt.

The rebuild:
1. Queries all distinct `(artist, COUNT(*))` rows from `files`.
2. Passes them through `buildArtistGroups()`.
3. DELETEs the entire `artists_normalized` table and re-inserts in a single transaction.
4. Calls `invalidateArtistCache()` so the home-page cache is refreshed.

### Folder-level artist inclusion (`artistsOn`)

Each configured folder now has an Artist Library include flag:

- `artistsOn: true` (default) — folder contributes to artist index + artist features.
- `artistsOn: false` — folder is excluded from artist index rebuilds.

This setting is controlled in **Admin → Directories** via **Artists: On/Off** and applies to:

- Artist Home shelves (Most Songs, Recently Listened, Most Played)
- A-Z letter browse + artist search
- artist image hydration and missing/wrong audit queues

The Admin UI also shows an inline hint beside each folder path:

- root folders affect the whole artist subtree by default
- child folders act as scoped overrides for only their own subfolder prefix inside the parent root

When changed, the server starts a background rebuild of `artists_normalized`, so the toggle response is immediate while updated results appear as soon as rebuild completes.

### Why a precomputed table?

A naive approach would JOIN `files` with a normalisation function on every request. With 130,000+ songs that join would be several seconds on every page load. The precomputed table makes all artist queries O(1) for lookups and O(n_artists) for listing — typically under 5 ms.

---

## API endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/v1/artists/home` | user | Home stats: totalCount, topArtists (top 20 by song count), recentArtists (last 10 played) |
| GET | `/api/v1/artists/letter?l=A` | user | All artists starting with that letter; `l=0` returns all digit-starting names |
| GET | `/api/v1/artists/search?q=…` | user | Full-text search across canonical names and all raw variants (min 2 chars) |
| GET | `/api/v1/artists/images/:filename` | user | Serve a stored artist image from `image-cache/artists/` |
| POST | `/api/v1/artists/mark-image-wrong` | admin | Flag/unflag an artist image as wrong from the player view |
| POST | `/api/v1/db/artists-albums-multi` | user | Albums for one artist (accepts an array of variant names to handle all tag forms) |
| POST | `/api/v1/admin/artists/rebuild-index` | admin | Trigger an immediate index rebuild without a full scan |
| GET | `/api/v1/admin/artists/image-audit?kind=missing|no-image|wrong|with-image` | admin | List pending missing artists, already-tried no-image artists, wrong-image review, and with-image validation |
| GET | `/api/v1/admin/artists/hydration-status` | admin | Live hydration queue status, counters, delay profile, and Discogs readiness |
| POST | `/api/v1/admin/artists/hydration-seed` | admin | Enqueue missing artists on demand (used by the Queue next 500 action) |
| GET | `/api/v1/admin/artists/discogs-candidates?artistKey=...` | admin | Fetch Discogs artist image candidates |
| POST | `/api/v1/admin/artists/apply-image` | admin | Apply selected Discogs/custom image URL to artist |

### Artist object shape (all list endpoints)

```json
{
  "artistKey":    "madonna",
  "canonicalName": "Madonna",
  "songCount":    847,
  "imageFile":    null,
  "bio":          null
}
```

`artistKey` is the lowercase trimmed version of `canonicalName` — use it as a stable identifier for navigation state.

### `POST /api/v1/db/artists-albums-multi`

Request body:
```json
{
  "artists": ["Madonna", "03_Madonna", "madonna "],
  "ignoreVPaths": [],
  "excludeFilepathPrefixes": []
}
```

Response — `albums` array (each album object):
```json
{
  "name":          "Like a Prayer",
  "album_art_file": "Music/Albums/Madonna/Like a Prayer (1989)/cover.jpg",
  "year":          1989,
  "dir":           "Albums/Like a Prayer (1989)/",
  "normDir":       "Albums/Like a Prayer (1989)"
}
```

`normDir` is used client-side as the `albumDir` filter when fetching album songs — it scopes the query to exactly that physical folder so albums that share a tag name (e.g. all discs tagged `"Catalogue"`) each return only their own tracks.

---

## Client-side UI (`webapp/app.js`)

### Artist home (`viewArtists`)

Loads `GET /api/v1/artists/home`. Two draggable shelves (home-shelf style):
- **Most Songs in Library** — top artists ranked by song count
- **Most Played Artists** — top artists ranked by play-event history
- **Recently Listened** — last artists played (from recently-played stats)

Shelf order is persisted to `localStorage` under `ms2_art_order_{username}` and synced on each page load.

Below the shelves: A–Z pill strip and a search bar. Clicking a letter loads `GET /api/v1/artists/letter?l=…`; the search box queries `GET /api/v1/artists/search?q=…` with 250 ms debounce.

The density controls (**List / Comfortable / Compact**) apply to both the filtered result grid and the default home shelves. Preference is persisted per user in localStorage (`ms2_art2_density_{username}` for the current Artists view, `ms2_art_density_{username}` for the legacy Artists view).

For admin users, artist cards/rows include a flag action to mark an artist image as wrong. This feeds the Admin image-repair queue.

### Background image hydration behavior

- Home shelves enqueue hydration for missing artist images.
- Letter browse (`0-9`, `A-Z`) also enqueues hydration for artists in the shown result set.
- Search results enqueue hydration too.
- Hydration runs as a throttled background queue with adaptive delays (`~1.4s` success, `~2.2s` no-image/skip, `~4s` on errors) and a queue cap (800) to protect upstream services.
- When an upstream lookup yields no usable image, the system records the fetch attempt (`last_fetched`) so missing artists are not repeatedly retried and hammered.
- Admin can monitor live queue/rate/error counters via `GET /api/v1/admin/artists/hydration-status` (used by Admin → Artists status panel).
- Admin can force-start hydration on demand with `POST /api/v1/admin/artists/hydration-seed` (wired to **Queue next 500** in Admin → Artists).
- Admin counts now separate **pending missing** artists (never tried yet) from **no image found** artists that were already checked upstream and returned nothing.

### Admin image repair workflow

`Admin → Artists` provides:

- **Missing** queue: artists with no stored image.
- **No image found** queue: artists already checked upstream with no usable result; shown separately so the pending queue stays actionable.
- **With image** queue: artists that already have an image, for manual quality review.
- **Wrong** queue: artists flagged from the player as incorrect image.
- Discogs candidate grid (multiple options) with direct apply.
- Direct image URL apply for manual fixes, with a live preview before applying.
- Admin route CSP explicitly allows external HTTPS image sources and `blob:` previews so Discogs/manual URL previews render correctly in the image repair workflow.
- In **With image**, admins can quickly validate each portrait with **Yes: image is OK** or **No: mark wrong**.
- Live telemetry panel showing whether background hydration is running, queue depth, dropped items (queue cap), and session progress.
- Clear Discogs readiness state (enabled + API credentials) so users understand when Discogs suggestions are unavailable.

When an image is applied, the wrong flag is cleared automatically.

### Per-artist page (`viewArtistAlbums` + `renderAlbumGrid` / `viewArtistProfile2`)

Calls `POST /api/v1/db/artists-albums-multi` with all known variants of the artist name (from `artist_raw_variants`). The result is an album grid with:

- **Series grouping** — albums nested two levels deep in the filesystem are grouped into a series card (stacked visual). Example: `12 inches A-Z/M/Madonna - Catalogue/CD01-On the Radio Part 1/` → L1 folder = `"12 inches A-Z"` → series card labelled `"12 inches A-Z"`.
- **Duplicate-name fallback** — when multiple albums share the same tag name (e.g. 26 CDs all tagged `"Catalogue"`), the display label falls back to the last path segment of `normDir` (`"CD01-On the Radio Part 1"` etc.).
- **Breadcrumb titles** — the page title builds up as you drill: `Propaganda` → `Propaganda – Albums` → `Propaganda – Albums – A Secret Wish`.
- **Correct back-navigation** — pressing `<` returns to exactly the grid level you came from, not the top-level artist page.
- **Category pills** — when the artist's albums fall into recognisable groups (CUE Albums, Series, etc.), filter pills appear above the grid. Selecting a pill filters the grid to that category. Pills are displayed horizontally (flexbox row spanning all grid columns via `grid-column: 1 / -1`). When you click into an album from a category and press back, the category pill and Albums tab are automatically restored to the state they were in when you left.

### Series grouping detail

`_seriesParent(dir)` returns the first path segment when `dir` has two or more segments, otherwise `null`. Albums sharing the same L1 segment form a series; the series card shows as many as 8 sub-albums but clicking it re-renders the grid with those sub-albums only (with `dir` cleared to prevent infinite re-nesting).

---

## Future work

- **Biography panel** — displayed on the per-artist page; text populated from `artists_normalized.bio`, fetched from Last.fm/MusicBrainz on demand or automatically at scan time.
- **Artist image** — stored in `image-cache/artists/` as a 400×400 JPEG; admin can upload a custom image or trigger an auto-fetch from Last.fm.
- **Discography stats** — total songs, total albums, year range, top genres.
- **Related artists** — from Last.fm similar-artists API (already used in Auto-DJ).
