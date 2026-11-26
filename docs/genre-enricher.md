# Genre Enricher *(Velvet)*

> Admin tool that fills in or improves the `genre` tag for every artist in your library by querying three sources and letting you pick the best suggestion.

Open it from **Admin → Genre Enricher** in the side-nav. A Last.fm API key is required (External Services → Last.fm); without it the worker does not start. From 1 December 2026 the key only works while its owner has Last.fm Pro.

## What it does

For each distinct artist in your library (`lower(trim(artist))`), the background worker queries all three sources, one after the other:

1. **Last.fm** — `artist.getTopTags`: the first tag with count ≥ 10 that looks like a genre (meta-tags like "seen live" or "favourites" are rejected)
2. **MusicBrainz** — the artist's highest-count genre tag. Needs an artist MBID (from the Tag Workshop `artists_normalized` table or `files.mb_artist_id`); without one the source is marked `nf`
3. **Discogs** — the most common style (or genre) across the artist's 10 most-owned releases. Needs Discogs credentials; without them the source is marked `nf`

Each result is stored in its own column on every row of `files` for that artist. Values are always lowercase. Audio files on disk are never touched.

| Column | Source value | Status column |
|---|---|---|
| `genre_lastfm`   | lowercase genre string | `genre_enrich_lastfm`  (`ok` / `nf` / `error`) |
| `genre_mb`       | lowercase genre string | `genre_enrich_mb`      (`ok` / `nf` / `error`) |
| `genre_discogs`  | lowercase genre string | `genre_enrich_discogs` (`ok` / `nf` / `error`) |
| `genre_user_reviewed` | `1` once the user has acted on this artist | — |

The worker never changes `genre` itself — only the actions below do.

A functional index `idx_files_artist_lc` on `lower(trim(artist))` keeps lookups fast on large libraries. Artist values that are pure digits (years, track numbers) are marked `nf` for all three sources without any request.

### Clean artist names from Tag Workshop

Many libraries contain raw `files.artist` tags that are filename-derived junk — `"01.Abba"`, `"01_Communards"`, `"01. Lady Gaga"` — which never match anything on Last.fm, MusicBrainz or Discogs. At startup the worker reads the Tag Workshop `artists_normalized` table and uses the clean canonical name (e.g. `"ABBA"`, `"Communards"`) for every external API call. For artists with no entry in that table it falls back to `stripDigitPrefix()` from `src/util/artist-normalize.js`, which strips leading track-number prefixes (`01.`, `01_`, `01 `, `A1 `, etc.). The compare endpoint returns both `artist` (raw, used as the row identity for apply/reset actions) and `display_name` (clean, shown in the UI). Running Tag Workshop's artist normalisation populates the mapping; the enricher picks up new entries on its next start.

## The compare view

Three filter tabs:

- **Enriched** — artists where all three sources have been processed but you have not yet made a decision. This is the work queue.
- **No genre yet** — the same, limited to artists whose current genre is empty.
- **Applied** — artists where a decision has already been made.

An **artist search box** (debounced 350 ms) does a case-insensitive `%text%` match across the *entire* result set, not just the current page. A second box filters on an exact current genre (e.g. `other`, to find placeholder genres).

### Per-row actions

- When all three sources agree, or two agree and the third has no data, the row shows the agreed genre with an **Apply** button.
- When all three found nothing, the row offers a one-click "done" (marks it reviewed, genre unchanged).
- Otherwise an **Apply as** picker offers **Last.fm**, **MusicBrainz**, **Discogs** (only sources that returned a value) or **Keep current** (mark as reviewed without changing the genre). The default is Last.fm.
- The **Current genre** cell is editable: type a value and press Enter (or leave the field) to overwrite the genre for that artist. Stored lowercase; marks the artist as reviewed.

## Worker controls

| Button | Effect |
|---|---|
| Start  | Process the queue (artists where `genre_enrich_lastfm`, `genre_enrich_mb` or `genre_enrich_discogs` is NULL). |
| Stop   | Stop after the current artist (force-terminated after 15 s). |
| Reset errors | Clear `error` statuses (and their values) so the worker retries them. |
| Reset not found | Clear `nf` statuses (e.g. after adding a key). |
| Rescan one source | Wipe one source completely (status + suggested value) for a fresh fetch. |
| Reset all | Wipe all three sources' statuses and suggestions. `genre_user_reviewed` and the `genre` column are kept. |

Reset all and Rescan one source ask for a second click to confirm. All reset actions are disabled in the UI, and refused by the API (400), while the worker runs.

### Background behaviour

The worker (`genre-enricher`) runs through the shared worker controller `src/util/worker-controller.js`:

- 60 seconds after server boot it starts on its own if artists are queued and a Last.fm key is set.
- It pauses while a library file scan runs and resumes afterwards. After every scan it auto-starts (staggered 5 s apart with the other background workers) if artists are queued.
- Auto-start is skipped when 500 or more artists are queued — press Start then.
- **Stop** saves `workerAutostart.genre-enricher = false` to the config file so it no longer starts on its own; **Start** sets it back to `true`. See [json_config.md](json_config.md#background-workers-workerautostart).
- **Start** during a scan returns `{ ok: true, pending: true }`; the button shows "Queued" and the worker launches when the scan ends.
- When the queue is empty the worker idles and re-checks every 60 s.

## Apply actions

Bulk actions below the compare table:

- **Apply selected** — apply the picked choice for every ticked row.
- **Apply all agreed** — every unreviewed artist where all three sources return the same genre.
- **Apply 2/3 majority** — every unreviewed artist where two sources agree and the third has no data.
- **Back-fill empty genres** — for every artist with an empty `genre`, apply the chosen source (`Preferred` = MusicBrainz → Discogs → Last.fm). This does not mark artists as reviewed.

The bulk buttons ask for a second click to confirm. Results are shown as toast notifications.

## API

See the **Genre Enricher — Admin** section in [API.md](API.md) for the 13 REST endpoints.

## Implementation notes

- Source files:
  - `src/api/genre-enricher.js` — REST endpoints, schema migration, worker lifecycle, apply logic
  - `src/util/genre-enricher-worker.mjs` — background worker, network calls, DB writes
  - `webapp/admin/index.js` → `genreEnricherView` (`genre-enricher-view`) Vue component
- Genres are always stored lowercase; on every boot a sweep lowercases `genre`, `genre_lastfm`, `genre_mb` and `genre_discogs`.
- The worker writes one UPDATE per artist and source, so an artist with many tracks costs one statement per source, not one per file.
- HTTP requests use a 10-second timeout. Pauses after each call: Last.fm 250 ms, Discogs 600 ms. MusicBrainz requests go through the process-wide MusicBrainz limiter (`src/util/mb-client.mjs`, 1100 ms between requests, shared with the Tag Workshop workers).
