# Tag Workshop

> **Status**: Built. Admin → Tools → **Tag Workshop**. This page started as the design for the feature; it now describes what the code does. The original design notes that were not built (or were built differently) are listed at the end.

The Tag Workshop compares the tags in your files with MusicBrainz data and lets an admin write corrected tags to the files, album by album. It never changes a file without an admin action.

---

## Pipeline overview

1. **AcoustID** (Admin → External Services → AcoustID) fingerprints songs and stores `acoustid_id`, `acoustid_score`, `mbid`, `mb_title`, `mb_artist`, `mb_artist_id` (worker `src/util/acoustid-worker.mjs`, AcoustID `meta: 'recordings'`).
2. **Step 1 — MusicBrainz enrichment** (`src/util/mb-enrich-worker.mjs`) looks up each matched recording on MusicBrainz and stores album, year, track, release and album-artist, then classifies `tag_status`.
3. **Step 1b — Text search fallback** (`src/util/mb-text-search-worker.mjs`) searches MusicBrainz by title + artist for songs AcoustID could not match, stores the MBID, and hands them to the enrichment worker.
4. **Step 2 — Review & apply**: album cards for everything with `tag_status = 'needs_review'`; the admin writes the tags to the files.

---

## Database columns (`files` table)

All added as non-destructive `ALTER TABLE ADD COLUMN` migrations on startup.

| Column | Type | Written by |
|---|---|---|
| `acoustid_id`, `acoustid_score`, `acoustid_status`, `acoustid_ts` | | AcoustID worker |
| `mbid` | TEXT | AcoustID worker or text search |
| `mb_title`, `mb_artist`, `mb_artist_id` | TEXT | AcoustID worker or text search |
| `mb_album` | TEXT | enrichment — release title |
| `mb_year` | INTEGER | enrichment — release year (1900–2100) |
| `mb_track` | INTEGER | enrichment — track position |
| `mb_release_id` | TEXT | enrichment — MB release UUID |
| `mb_album_artist` | TEXT | enrichment — release artist credit |
| `mb_album_dir` | TEXT | enrichment — the file's album folder, used to split one release over several folders |
| `mb_enrichment_status` | TEXT | `NULL` (queued) / `'pending'` / `'done'` / `'error'` / `'no_data'` |
| `mb_enriched_ts` | INTEGER | Unix ts of last MB lookup |
| `mb_enrichment_error` | TEXT | plain-language error message |
| `mb_text_search_status`, `mb_text_search_score`, `mb_text_search_ts`, `mb_text_search_error` | | text search worker |
| `tag_status` | TEXT | `NULL` / `'confirmed'` / `'needs_review'` / `'accepted'` / `'skipped'` |

---

## MusicBrainz enrichment worker

- Queue: `mbid IS NOT NULL AND mb_enrichment_status IS NULL AND (acoustid_status = 'found' OR mb_text_search_status = 'found')`, 50 rows per batch. When the queue is empty it sleeps 60 s and checks again.
- Call: `GET https://musicbrainz.org/ws/2/recording/{mbid}?inc=artists+releases+release-groups+media&fmt=json`. Merged MBIDs (301/302/307/308) are followed up to 3 times. 404 → `no_data`.
- Transient errors (503, 429, timeout) are retried twice (after 30 s, then 60 s); after that the row is `error` with a plain-language message. **Retry all** (`POST /api/v1/tagworkshop/enrich/retry-errors`) puts failed rows back in the queue.
- Rows left `pending` by an interrupted run are reset to the queue when the worker starts.

### Rate limit

All MusicBrainz calls in Velvet share one process-wide limiter in `src/util/mb-client.mjs`: 1 request per 1100 ms. Worker threads ask the main thread for a token, so the enrichment and text-search workers can run at the same time without exceeding the limit. Requests carry the `MB_USER_AGENT` header.

### Release selection

A recording can appear on many releases. The worker sorts them:

1. `release-group.primary-type`: `Album` before `Single` before anything else
2. Earliest `date`
3. Otherwise the original order

### Classification (`tag_status`)

After a successful lookup, the file's tags are compared with the MB values (normalised: lowercase, only `a-z0-9`). Year allows ±1. A field MB has no value for counts as a match.

- all match → `confirmed` (never shown in the workshop)
- any difference → `needs_review`
- a release without usable data → `needs_review` / `no_data`

### Lifecycle

Both workers use `src/util/worker-controller.js`:

- They pause on every scan start and resume after.
- After every scan, and 15 s after boot, they auto-start if they have queued work — unless the admin pressed **Stop** (stored as `workerAutostart.tagworkshop-enrich` / `workerAutostart.tagworkshop-text-search = false`; **Start** sets it back to `true`).
- Auto-start is skipped when 500 or more rows are queued; start those from the admin panel.
- **Stop** force-terminates the worker after 30 s.

See [json_config.md](json_config.md) "Background workers (workerAutostart)".

---

## Text search fallback

- Queue: `acoustid_status = 'not_found'`, `mb_text_search_status IS NULL`, title and artist each longer than 2 characters; oldest first, 50 per batch.
- Placeholder titles/artists (`Track 1`, `Untitled`, `Unknown`, `Various Artists`, …) are not queried; leading track numbers like `A1. ` are stripped.
- A match with score ≥ 70 stores `mbid`, `mb_title`, `mb_artist`, `mb_artist_id` and clears `mb_enrichment_status`, so the enrichment worker picks it up.
- Albums that contain text-search matches get a **Text match** badge in the review list (less certain than a fingerprint).
- **Retry not found** (`POST /api/v1/tagworkshop/text-search/retry-notfound`) and **Retry errors** reset rows for another run.

---

## Review & apply (Admin UI)

The view has these parts:

- **Library Coverage** — total tracks, identified by AcoustID, identified by text search, not identified, review queue.
- **Step 1 / Step 1b** cards — start/stop, counters (total, done, no data, errors, queued) and the list of failed files.
- **Step 2 — Review & Apply to Files** — counters (needs review, all match, applied to files, left unchanged) and the album list.

### Album list

Albums are grouped by `mb_release_id` + album folder (`mb_album_dir`), 40 per page, with a search box (album or artist), page jump, and:

| Filter | Shows albums with |
|---|---|
| `all` | everything in `needs_review` |
| `missing` | a track with empty title, artist or album |
| `year` | a year that differs from MB by more than 1 (or is empty) |
| `artist` | an artist that differs from MB |
| `junk` | a track whose artist tag is only digits |

| Sort | Order |
|---|---|
| `broken` (default) | most tracks needing a fix first |
| `tracks` | most tracks first |
| `alpha` | MB artist, then album |

### Actions

| Action | Effect |
|---|---|
| **Compare & apply tags** | Opens a side-by-side view (your file vs MusicBrainz). Any suggested value can be edited before writing |
| **Write tags to files** | Writes title, artist, album artist, album, year, track to every track of the album: the admin panel calls `POST /api/v1/tagworkshop/accept-track` once per track (with any edited values as `overrides`) |
| **Accept selected** | Select several albums on a page and accept them in one batch |
| **Shelve** | `POST /api/v1/tagworkshop/skip` — sets `tag_status = 'skipped'`; the album moves to the **Shelved** tab, no files are touched |
| **Move back to review** | `POST /api/v1/tagworkshop/unshelve` |
| **Bulk apply (casing only)** | `POST /api/v1/tagworkshop/bulk-accept-casing` — applies MB values to every `needs_review` track whose tags already match after normalisation (only casing/punctuation differ). Needs a second click to confirm |

---

## Tag writing

Tags are written with the bundled ffmpeg through `writeTags()` in `src/util/ffmpeg-tags.js`:

- stream copy (`-c copy`), existing tags kept (`-map_metadata 0`) and the new values applied; MP3 is written as ID3v2.3
- ffmpeg writes a temp file next to the original, then one atomic rename; on error the temp file is removed and the original is untouched
- embedded covers are kept; for Ogg/Opus the cover is extracted and re-embedded (`METADATA_BLOCK_PICTURE`)
- supported formats: mp3, flac, ogg, opus, m4a, aac, wav, wma, aiff, aif
- the path is resolved inside the vpath root (`resolvePathWithinRoot`)

After writing, the DB row is updated directly (`updateFileTags`), `tag_status` is set to `accepted`, and the stored mtime is synced to the file — so no rescan is needed and the song does not reappear in Recently Added. Tracks whose tags already equal the final values are marked `accepted` without touching the file. If the disk write fails, the DB is still updated and the error is listed.

---

## REST endpoints

All admin-only (JWT required). See [API.md](API.md) for the full list.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/tagworkshop/status` | `{ mb, textSearch, tags, coverage, enrich }` — worker stats, tag status counts, library coverage, running flags |
| `POST` | `/api/v1/tagworkshop/enrich/start` / `stop` | Start / stop the enrichment worker |
| `POST` | `/api/v1/tagworkshop/enrich/files` | `{ files: [{ filepath, vpath }] }` (max 500) — re-queue specific files and start the worker |
| `GET` | `/api/v1/tagworkshop/enrich/errors` | Failed enrichment rows (max 200) |
| `POST` | `/api/v1/tagworkshop/enrich/retry-errors` | Re-queue failed rows |
| `POST` | `/api/v1/tagworkshop/text-search/start` / `stop` | Start / stop the text-search worker |
| `POST` | `/api/v1/tagworkshop/text-search/retry-notfound` | Re-queue `not_found` rows |
| `GET` | `/api/v1/tagworkshop/text-search/errors` | Failed text-search rows (max 200) |
| `POST` | `/api/v1/tagworkshop/text-search/retry-errors` | Re-queue failed text-search rows |
| `GET` | `/api/v1/tagworkshop/folder?path=<vpath>/<dir>` | Files in one folder with DB tags + MB data (child vpaths resolved to their parent) |
| `GET` | `/api/v1/tagworkshop/albums` | `?page=N&filter=all\|missing\|year\|artist\|junk&sort=broken\|tracks\|alpha&q=` → `{ albums, total, page, pageSize }` |
| `GET` | `/api/v1/tagworkshop/album/:mb_release_id` | `?album_dir=` — all tracks of one album card |
| `POST` | `/api/v1/tagworkshop/accept-track` | `{ filepath, vpath, overrides? }` → `{ ok, error }`, `{ ok, skippedEqual }` when the file already has these tags, or `{ ok, skipped }` when no matching track is found |
| `POST` | `/api/v1/tagworkshop/skip` | `{ mb_release_id, album_dir? }` — shelve |
| `POST` | `/api/v1/tagworkshop/unshelve` | `{ mb_release_id, album_dir? }` |
| `GET` | `/api/v1/tagworkshop/shelved` | `?page=N` — shelved albums |
| `POST` | `/api/v1/tagworkshop/bulk-accept-casing` | Apply all casing-only differences |

---

## Original design notes — not built as planned

- MB enrichment controls were planned under `/api/v1/acoustid/start-mb-enrich` / `stop-mb-enrich`; they live under `/api/v1/tagworkshop/enrich/*` instead.
- Albums were planned to be grouped by `mb_artist` + `mb_album`; they are grouped by `mb_release_id` + album folder.
- A "Lowest score" sort and a "Reviewed X of Y albums" progress bar were planned; not built.
- The design called for a rescan after writing tags; the DB is updated directly instead.
- Out of scope, still not built: writing tags to podcasts/radio recordings, Discogs-sourced tags, applying changes without any admin confirmation.
