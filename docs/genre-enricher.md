# Genre Enricher *(Velvet)*

> Admin tool that fills in or improves the `genre` tag for every artist in your library by querying three sources in parallel and letting you pick the best suggestion.

The Genre Enricher is shipped in v7.2.3-velvet. Open it from **Admin → Genre Enricher** in the side-nav.

## What it does

For each distinct artist in your library, the background worker queries:

1. **Last.fm** — most common tag (excluding rejected meta-tags like "seen live")
2. **MusicBrainz** — most common artist tag
3. **Discogs** — artist style list (joined with " / ")

Each result is stored in its own column on every row of `files` for that artist:

| Column | Source value | Status column |
|---|---|---|
| `genre_lastfm`   | normalised lowercase genre string | `genre_enrich_lastfm`  (`ok` / `nf` / `error`) |
| `genre_mb`       | normalised lowercase genre string | `genre_enrich_mb`      (`ok` / `nf` / `error`) |
| `genre_discogs`  | normalised lowercase genre string | `genre_enrich_discogs` (`ok` / `nf` / `error`) |
| `genre_user_reviewed` | `1` once the user has acted on this artist | — |

A functional index `idx_files_artist_lc` on `lower(trim(artist))` keeps lookups fast even on libraries with hundreds of thousands of rows.

### Clean artist names from Tag Workshop

Many libraries contain raw `files.artist` tags that are filename-derived junk — `"01.Abba"`, `"01_Communards"`, `"01. Lady Gaga"` — which never match anything on Last.fm, MusicBrainz or Discogs. Since v7.2.13-velvet the worker consults the Tag Workshop `artists_normalized` table at startup and uses the clean canonical name (e.g. `"ABBA"`, `"Communards"`) for every external API call. For artists with no entry in that table the worker falls back to `stripDigitPrefix()` from `src/util/artist-normalize.js`, which strips leading track-number prefixes (`01.`, `01_`, `01 `, `A1 `, etc.). The compare endpoint returns both `artist` (raw, used as the row identity for apply/reset actions) and `display_name` (clean, shown in the UI). Running Tag Workshop's artist normalisation populates the mapping; the enricher will automatically pick up new entries on its next start.

## The two-tab compare view

- **Enriched** — artists where all three sources have been processed but the user has not yet made a decision. This is the work queue.
- **Applied** — artists where a decision has already been made. Audit trail; can be re-applied to overwrite.

Both tabs share an **artist search box** (debounced 350 ms). The filter does a case-insensitive `%text%` match across the *entire* result set, not just the current page.

### Per-row picker

Each row offers four radio choices:

- **MB** — apply the MusicBrainz suggestion
- **Discogs** — apply the Discogs suggestion
- **Last.fm** — apply the Last.fm suggestion
- **Keep current** — mark as reviewed without changing the genre (useful when none of the three sources returned anything sensible but the file already has a hand-curated genre)
- **Custom** — type any value (free-text input, stored lowercase)

The default pre-selected source is **MusicBrainz → Discogs → Last.fm** priority, falling back to **Keep current** when all three sources came back `nf` but a `current_genre` already exists.

## Worker controls

| Button | Effect |
|---|---|
| Start  | Begin processing the queue (`genre_enrich_lastfm IS NULL` OR `genre_enrich_mb IS NULL` OR `genre_enrich_discogs IS NULL`). |
| Stop   | Stop after the current artist completes. |
| Reset errors | Clear `error` statuses so the worker re-tries them. |
| Reset not-found | Clear `nf` statuses (e.g. after a Last.fm API key change). |
| Reset source | Wipe one source completely (status + suggested value) for a full re-scan from scratch. |
| Reset all | Wipe everything including `genre_user_reviewed`. |

## Apply actions

Three bulk actions are exposed at the top of the compare view:

- **Apply selected** — apply the currently picked radio for every visible row.
- **Apply all empty** — for every artist that currently has an empty `genre`, apply the chosen source (`preferred` = the same MB → Discogs → Last.fm fallback).
- **Set current genre** — type a genre and apply it directly to the focused artist (also marks as reviewed).

All three actions surface their result via toast notifications (top-center, iziToast).

## API

See the **Genre Enricher — Admin** section in [docs/API.md](API.md) for the 11 REST endpoints.

## Implementation notes

- Source files:
  - `src/api/genre-enricher.js` — REST endpoints + start/stop bridge + apply logic
  - `src/util/genre-enricher-worker.mjs` — background worker, network calls, batched DB writes
  - `webapp/admin/index.js` → `genreEnricherView` Petite-Vue component
  - `webapp/admin/index.html` → side-nav entry + view template
- Genres are always stored lowercase. The `apply` endpoint normalises via `String(g).trim().toLowerCase()` before writing.
- The worker batches writes per artist so a single artist with many tracks results in one transaction, not N.
- HTTP requests use a 12-second timeout and respect per-source rate limits (Discogs gets the longest pause).
