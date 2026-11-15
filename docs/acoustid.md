# AcoustID Fingerprinting — Design & Implementation

This document describes Velvet's AcoustID fingerprinting feature (built). It covers the architecture, binary strategy, Docker integration, admin UI, API key policy, and what builds on it.

---

## Purpose

AcoustID is an open audio fingerprint identification service. Given an audio file, it computes a short hash (a *Chromaprint* fingerprint) of the actual audio content and matches it against a crowdsourced database, returning:

- An **AcoustID track UUID** — a stable, crowd-verified identifier for this recording
- A **MusicBrainz Recording ID (MBID)** — the metadata ID that links to title, artist, album, release year, and track number

**Why do we want this?**  
A significant part of any real music library consists of poorly-tagged files — especially ripped or downloaded MP3s and 12-inch rips from the 80s/90s. These files have wrong titles, missing artists, wrong track numbers, and no album info. The only *reliable* way to identify them is by their audio content, not their tags.

Once MBIDs are stored in the database, Velvet uses them to:
- Feed the **Tag Workshop** (MusicBrainz enrichment, review and batch-apply)
- Look up BPM and key on AcousticBrainz (see [bpm-harmonic.md](bpm-harmonic.md))

**128 kbps files**: Chromaprint analysis is robust against lossy encoding. fpcalc only reads the first 120 seconds of audio, and those frequency patterns are stable at 128 kbps, so low-bitrate files fingerprint as well as FLAC.

---

## Chromaprint / fpcalc Binary

The fingerprint is computed by `fpcalc`, the command-line frontend to the [Chromaprint](https://acoustid.org/chromaprint) library.

**Why `fpcalc` and not an NPM package?**

| Option | Problem |
|---|---|
| `fpcalc` npm (v1.3.0, 2018) | Outdated thin wrapper — requires the binary anyway |
| `@unimusic/chromaprint` (WASM) | Only accepts raw PCM — needs FFmpeg to decode first; adds complexity without benefit |
| `rusty-chromaprint-wasm` (WASM) | Same constraint — PCM only |
| **fpcalc binary (Chromaprint v1.6.1)** | ✅ Handles all formats natively, fast, well-tested, the same tool MusicBrainz Picard and beets use |

`src/util/fpcalc-bootstrap.js` follows the pattern of `ffmpeg-bootstrap.js`:

- On server startup, check `bin/fpcalc/fpcalc` (or `fpcalc.exe` on Windows)
- If missing: download the static binary for this platform from the [Chromaprint GitHub releases](https://github.com/acoustid/chromaprint/releases) (pinned to v1.6.1)
- If present: verify it responds to `fpcalc -version`
- If the bundled binary is an older version, it is upgraded in place (the old one is kept if the download fails)
- On platforms without a download (e.g. Linux armv7), the system `fpcalc` in `PATH` is used (`apt install libchromaprint-tools` / `apk add chromaprint`). If none is found, AcoustID reports fpcalc as unavailable.

### Download targets

| Platform | Archive |
|---|---|
| Linux x86_64 | `chromaprint-fpcalc-1.6.1-linux-x86_64.tar.gz` |
| Linux arm64 | `chromaprint-fpcalc-1.6.1-linux-arm64.tar.gz` |
| macOS (x64 + arm64) | `chromaprint-fpcalc-1.6.1-macos-universal.tar.gz` |
| Windows x64 | `chromaprint-fpcalc-1.6.1-windows-x86_64.zip` |

Every archive is SHA256-verified (hashes are hard-coded) before extraction.

Binary is installed to `bin/fpcalc/fpcalc` (or `bin/fpcalc/fpcalc.exe`) and made executable (`chmod 0o750`) after a runtime download.

---

## Docker Integration

The `Dockerfile` pre-downloads `fpcalc` v1.6.1 at build time for `x86_64` and `aarch64`, extracts it to `bin/fpcalc/fpcalc`, sets the executable bit and runs `fpcalc -version`. If the download fails the build continues and the runtime bootstrap downloads it on first start. This matters for offline deployments, where a runtime download would fail.

---

## API Key Policy

> **The AcoustID API key must NEVER be committed to the repository or appear in any source file.**

### Why

AcoustID API keys are per-application. Once published, they can be abused by third parties. `save/conf/default.json` is covered by `.gitignore` (`save/conf/*`), but source files are not.

### Rule

- The API key is stored **only** in `save/conf/default.json` → field `acoustid.apiKey`
- It is entered through **Admin → AcoustID**
- The Joi config schema (`src/state/config.js`) has `apiKey: Joi.string().allow('').default('')`
- The worker **refuses to start** if `apiKey` is shorter than 4 characters, or if AcoustID is not enabled (Start returns 400)
- The admin UI shows a warning when no key is configured

### Config structure (`save/conf/default.json`)

```json
"acoustid": {
  "enabled": false,
  "apiKey": "",
  "autostart": false
}
```

The `enabled` flag is separate from having a key. Both must be set for the worker to run. `autostart` is written by Velvet: pressing **Start** sets it to `true`, **Stop** sets it to `false` (see [Lifecycle](#lifecycle)).

---

## Database Schema

Five columns on the `files` table (added by `ALTER TABLE ... ADD COLUMN` migrations, existing rows get `NULL`):

| Column | Type | Meaning |
|---|---|---|
| `acoustid_id` | TEXT | AcoustID track UUID |
| `mbid` | TEXT | MusicBrainz Recording ID |
| `acoustid_score` | REAL | Match confidence 0.0–1.0 |
| `acoustid_status` | TEXT | `NULL` = queued · `'pending'` = being processed · `'found'` · `'not_found'` · `'error'` |
| `acoustid_ts` | INTEGER | Unix timestamp of last attempt (for retry backoff) |

On a match the worker also writes `mb_title`, `mb_artist` and `mb_artist_id` from the first recording.

`NULL` on `acoustid_status` is the natural queue marker — every song inserted by the scanner starts with `NULL`, so new songs are queued without any extra signalling between the scanner and the worker.

---

## Architecture — Worker Thread

```
Velvet server process
  └─ src/api/acoustid.js               ← REST endpoints + worker lifecycle (worker-controller)
       └─ src/util/acoustid-worker.mjs   ← Worker thread
            ├─ opens the DB directly via DatabaseSync (WAL mode)
            ├─ spawns fpcalc per file (under ionice -c 3 nice -n 19 when ionice exists)
            ├─ GETs api.acoustid.org/v2/lookup (≤2 req/s)
            └─ writes results straight into the files table
```

### Why a Worker thread (not a child process)?

- The fingerprint job is a **long-running background service**, not a one-shot process like the file scanner
- Worker threads are lighter than child processes and can be started/stopped cleanly
- The worker runs independently from the file scanner; during a scan it is paused and resumes afterwards

### Worker loop

```
on start:
  1. abort if apiKey is shorter than 4 characters
  2. reset rows left as 'pending' by a previous run back to NULL

main loop:
  1. SELECT up to 50 rows WHERE acoustid_status IS NULL
     OR (acoustid_status = 'error' AND acoustid_ts older than 7 days)
     ORDER BY ts ASC  (oldest-indexed files first)
  2. for each row:
     a. mark acoustid_status = 'pending'
     b. spawn: fpcalc -json -length 120 <absolute_path>   (killed after 90 s)
        fpcalc failure or zero duration → 'not_found' (not retried)
     c. GET https://api.acoustid.org/v2/lookup
           ?client=<apiKey>&duration=D&fingerprint=F&meta=recordings&format=json
        HTTP 400/401 (invalid key) → stop the worker with an error; no crash restart,
                                     and its auto-start is switched off until an admin starts it
                                     (the same happens at start when no key is configured)
        other network/API error    → 'error' (retried after 7 days)
     d. pick the result with the highest score
     e. if score ≥ 0.50 and it has a recording: status = 'found', store acoustid_id + mbid + score
        else:                                    status = 'not_found'
     f. wait 500 ms (= 2 req/s, under AcoustID's 3 req/s limit)
  3. if no rows remain: exit (the post-scan auto-start starts it again)
  4. on stop signal: finish the current file, reset 'pending' rows, exit
```

**Rate limiting**: AcoustID's published limit is 3 requests per second. The 500 ms pause after every file keeps the worker at 2 req/s at most. It is hard-coded.

**`-length 120`**: fpcalc only needs the first 120 seconds of audio. This matters for long 7" and 12" versions — they fingerprint equally well from the intro alone.

### Lifecycle

The worker uses the shared `src/util/worker-controller.js` (name `acoustid`), with AcoustID's own autostart flag:

- **Opt-in:** it only starts on its own when `acoustid.autostart` is `true`, i.e. after an admin pressed Start. **Stop** sets it to `false`.
- At boot it auto-starts if `autostart` is `true` and files are queued (no backlog cap at boot).
- It is paused while a library file scan runs and resumed afterwards. After every scan it auto-starts (staggered 5 s apart with the other background workers) when `autostart` is `true` and files are queued — unless 500 or more files are queued; then start it from Admin.
- **Start** during a scan returns `{ ok: true, pending: true }` and the worker launches when the scan ends.
- **Stop** force-terminates the worker if it has not stopped after 30 s.
- After a crash it restarts after 10 s, but only when `autostart` is `true`.
- Start returns 500 when fpcalc is not available.

---

## Files

| File | Purpose |
|---|---|
| `src/util/fpcalc-bootstrap.js` | Download + verify fpcalc binary; exports `fpcalcBin()`, `ensureFpcalc()` |
| `src/util/acoustid-worker.mjs` | Worker thread — the fingerprint engine |
| `src/api/acoustid.js` | REST endpoints + worker lifecycle |
| `src/api/admin.js` | `GET`/`POST /api/v1/admin/acoustid/config` |
| `src/state/config.js` | `acoustidOptions` Joi schema (`enabled`, `apiKey`, `autostart`) |
| `webapp/admin/index.js` | AcoustID admin view |

---

## REST API Endpoints (admin-only, 403 otherwise)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/acoustid/status` | `{ enabled, hasKey, fpcalcAvailable, running, stopping, startedAt, scanActive, stats: { total, found, not_found, errors, pending, queued } }` |
| `POST` | `/api/v1/acoustid/start` | Start the worker. `{ ok: true }`, `{ ok, message: 'Already running' }`, or `{ ok, pending: true }` during a scan; 400 if disabled or no key; 500 if fpcalc is missing |
| `POST` | `/api/v1/acoustid/stop` | Stop the worker after the current song |
| `POST` | `/api/v1/acoustid/reset-errors` | Clear `acoustid_status = 'error'` so those files are retried → `{ ok, reset }` |
| `POST` | `/api/v1/acoustid/reset-not-found` | Re-queue all `not_found` files and start the worker if it is not running → `{ ok, reset, workerStarted }` |
| `POST` | `/api/v1/acoustid/scan-files` | Re-queue specific files (max 500). Body `{ files: [{ filepath, vpath }] }` → `{ ok, queued, workerStarted }` |
| `GET` | `/api/v1/admin/acoustid/config` | `{ enabled, apiKey: masked, hasKey }` |
| `POST` | `/api/v1/admin/acoustid/config` | Save `{ enabled, apiKey }` (key max 64 chars) to `default.json` |

The `apiKey` returned by the GET endpoint is **masked**: the first 6 characters followed by asterisks. Posting the masked value back keeps the stored key.

`reset-not-found` and `scan-files` start the worker without changing `acoustid.autostart`.

---

## Admin UI — AcoustID View

Located in **Admin → AcoustID**.

### Settings
- **Enable AcoustID fingerprinting** checkbox
- **Application API Key** input (masked)
- Hint that the key is stored on the server only, with a link to register a free key at acoustid.org
- Warning when no key is configured, and when fpcalc is not available

### Fingerprinting Progress
- Counters: Processed, Matched, No match, Errors, Queued
- **Start Scanning** / **Stop** button
- Status: Idle / Running / Running — waiting for library scan to finish / Stopping
- Elapsed time, live rate and ETA while running
- **Retry N Errors** button (`reset-errors`)

---

## Security Notes

1. **API key** — never in source code; `.gitignore` covers `save/conf/*`; the GET endpoint masks it
2. **No user data sent to AcoustID** — only the audio fingerprint and duration are transmitted; no filenames, no metadata, no library structure
3. **Rate limit compliance** — hard-coded 500 ms gap between files; not configurable

---

## What builds on this feature

### Tag Workshop (built)
The MBID is the key to MusicBrainz. The Tag Workshop enrichment worker (`src/util/mb-enrich-worker.mjs`, `tagworkshop-enrich`) fetches canonical title, artist, album, track number and year for each MBID. The Tag Workshop admin panel presents the suggested corrections for review before anything is written. See the Tag Workshop section of [API.md](API.md#tag-workshop-velvet).

### MB Text Search Fallback (built)

For files where AcoustID returned `acoustid_status = 'not_found'` (rare recordings, 12-inch rips, bootlegs not in the AcoustID database), Velvet has a **text-search fallback** worker: `src/util/mb-text-search-worker.mjs` (`tagworkshop-text-search`).

**How it works:**

1. Selects files with `acoustid_status = 'not_found'`, `mb_text_search_status IS NULL`, and non-trivial `title` + `artist` tags (length > 2)
2. Skips files where title or artist match placeholder patterns (`unknown`, `track 01`, `various artists`, etc.)
3. Strips common vinyl track-number prefixes from titles before querying (`A1. `, `B2 - `, etc.) via `cleanTitle()`
4. Queries `https://musicbrainz.org/ws/2/recording/?query=artist:"…" AND recording:"…"&limit=5`
5. Picks the best result using score DESC + duration proximity as a tiebreaker
6. Score threshold: **≥ 70** to store a result (MB returns integer 0–100, stored normalised 0.0–1.0)
7. On a match: writes `mb_title`, `mb_artist`, `mb_artist_id`, `mbid` and resets `mb_enrichment_status = NULL` — this makes the MB enrichment worker fetch full album/year/track data for the MBID
8. The text-search worker does not set `tag_status` itself; the enrichment worker classifies the file afterwards (`'confirmed'` only when the file's title, artist, album and year already match MusicBrainz, otherwise `'needs_review'`)

**Rate limiting:** every MusicBrainz request in Velvet goes through one process-wide limiter (`src/util/mb-client.mjs`, 1100 ms between requests); worker threads ask the main thread for a token. The text-search and enrichment workers can therefore run at the same time and together stay under MusicBrainz's 1 req/s limit.

**`mb_text_search_status` state machine:**

| Value | Meaning |
|---|---|
| `NULL` | Not yet attempted (natural queue marker) |
| `'pending'` | In progress — reset to `NULL` on worker restart |
| `'found'` | Match found; `mbid` + `mb_*` columns populated |
| `'not_found'` | No result above threshold after searching |
| `'skipped_no_tags'` | Title or artist matched a placeholder pattern — not worth querying |
| `'skipped_low_score'` | Results returned but all scored below 70 |
| `'error'` | Network or parse error — retried via the retry-errors endpoint |

**DB columns:**

| Column | Type | Description |
|--------|------|-------------|
| `mb_text_search_status` | TEXT | State machine value (see above) |
| `mb_text_search_score` | REAL | Best MB score normalised 0.0–1.0 |
| `mb_text_search_ts` | INTEGER | Unix timestamp of last attempt |

**Admin UI:** a "Step 1b — Text Search Fallback" card in the Tag Workshop panel, with queued / found / not found / skipped / error counts, start/stop and a retry action. Endpoints: `/api/v1/tagworkshop/text-search/start`, `/stop`, `/retry-notfound`, `/errors`, `/retry-errors`.

### Duplicate Detection (idea — not built this way)
Once files have an `acoustid_id`, duplicates could be grouped by it:
```sql
SELECT acoustid_id, COUNT(*) as n, GROUP_CONCAT(filepath)
FROM files WHERE acoustid_id IS NOT NULL
GROUP BY acoustid_id HAVING n > 1
```
The Admin **Duplicate Workshop** exists but does not use `acoustid_id`.

### Other ideas (not tracked here)
- Artist pages from MusicBrainz artist MBIDs (biography, discography, Cover Art Archive artwork)
- Better genre/year data for Auto-DJ and smart playlists
