# AcoustID Fingerprinting — Design & Implementation Plan

This document describes the planned AcoustID fingerprinting feature for Velvet. It covers the architecture, binary strategy, Docker integration, admin UI, API key policy, and the roadmap beyond this feature.

---

## Purpose

AcoustID is an open audio fingerprint identification service. Given an audio file, it computes a short hash (a *Chromaprint* fingerprint) of the actual audio content and matches it against a crowdsourced database of 60+ million tracks, returning:

- An **AcoustID track UUID** — a stable, crowd-verified identifier for this recording
- A **MusicBrainz Recording ID (MBID)** — the definitive metadata ID that links to title, artist, album, release year, and track number

**Why do we want this?**  
A significant part of any real music library consists of poorly-tagged files — especially ripped or downloaded MP3s and 12-inch rips from the 80s/90s. These files have wrong titles, missing artists, wrong track numbers, and no album info. The only *reliable* way to identify them is by their audio content, not their tags.

AcoustID gives us a ground-truth identity for every file. Once we have MBIDs stored in the database, we can:
- Cross-reference against MusicBrainz for authoritative title/artist/album/year
- Feed the Tag Workshop (Phase 2 in `docs/dev/todo.md`) for review and batch-apply
- Link artist pages to MusicBrainz discographies
- Power duplicate detection (same MBID → same recording, even if you have 3 different copies)

**128 kbps files**: Chromaprint FFT analysis is robust against lossy encoding. The algorithm extracts frequency patterns from the first ~120 seconds of audio, which are stable at 128 kbps. There is **no accuracy difference** compared to 320 kbps or FLAC. Every file in your library — regardless of bitrate — will fingerprint accurately.

---

## Chromaprint / fpcalc Binary

The fingerprint is computed by `fpcalc`, the command-line frontend to the [Chromaprint](https://acoustid.org/chromaprint) library, developed by Lukáš Lalinský (AcoustID's author).

**Why `fpcalc` and not an NPM package?**

| Option | Problem |
|---|---|
| `fpcalc` npm (v1.3.0, 2018) | Outdated thin wrapper — requires the binary anyway |
| `@unimusic/chromaprint` (WASM) | Only accepts raw PCM — needs FFmpeg to decode first; adds complexity without benefit |
| `rusty-chromaprint-wasm` (WASM) | Same constraint — PCM only |
| **fpcalc binary (Chromaprint v1.5.1)** | ✅ Handles all formats natively, fast, well-tested, identical tool used by MusicBrainz Picard, beets, and every serious music tagger |

We use a `fpcalc-bootstrap.js` modelled exactly on the existing `ffmpeg-bootstrap.js`:

- On server startup, check `bin/fpcalc/fpcalc` (or `fpcalc.exe` on Windows)
- If missing: auto-download the correct static binary from the official [Chromaprint GitHub releases](https://github.com/acoustid/chromaprint/releases)
- If present: verify it is executable and responds to `fpcalc -version`

### Download targets

| Platform | Archive |
|---|---|
| Linux x86_64 | `chromaprint-fpcalc-1.5.1-linux-x86_64.tar.gz` |
| Linux aarch64 | `chromaprint-fpcalc-1.5.1-linux-aarch64.tar.gz` |
| macOS (x64 + arm64) | `chromaprint-fpcalc-1.5.1-macos-x86_64.tar.gz` |
| Windows x64 | `chromaprint-fpcalc-1.5.1-windows-x86_64.zip` |

Binary is installed to `bin/fpcalc/fpcalc` (or `bin/fpcalc/fpcalc.exe`). The `bin/fpcalc/` directory follows the same gitignore pattern as `bin/ffmpeg/` and `bin/yt-dlp/`.

---

## Docker Integration

`fpcalc` must be **pre-baked into the Docker image**, exactly like `yt-dlp`. This is critical because:

1. The Chromaprint release is a static binary (~5 MB) — no dependencies
2. Downloading at container startup would fail for air-gapped or offline deployments
3. Docker images are rebuilt on every release tag — fresh binary is always included

### Dockerfile addition (in `RUN` block, after the yt-dlp block)

```dockerfile
# Pre-download fpcalc (Chromaprint) for AcoustID fingerprinting.
# Static binary, no dependencies. Falls back gracefully if download fails.
RUN arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  url="https://github.com/acoustid/chromaprint/releases/download/v1.5.1/chromaprint-fpcalc-1.5.1-linux-x86_64.tar.gz" ;; \
      aarch64) url="https://github.com/acoustid/chromaprint/releases/download/v1.5.1/chromaprint-fpcalc-1.5.1-linux-aarch64.tar.gz" ;; \
      *)       url="" ;; \
    esac; \
    if [ -n "$url" ]; then \
      mkdir -p bin/fpcalc && \
      if wget -q -O /tmp/fpcalc.tar.gz "$url" && \
         tar -xzf /tmp/fpcalc.tar.gz -C /tmp && \
         find /tmp -name 'fpcalc' -type f -exec mv {} bin/fpcalc/fpcalc \; && \
         chmod +x bin/fpcalc/fpcalc && \
         rm -f /tmp/fpcalc.tar.gz && \
         bin/fpcalc/fpcalc -version; then \
        echo "fpcalc pre-download OK"; \
      else \
        rm -rf bin/fpcalc && echo "fpcalc pre-download failed (will auto-download at runtime)"; \
      fi; \
    fi
```

**Executable bit**: `chmod +x` is set during the Docker build and cannot be lost unless the image is rebuilt incorrectly. The `fpcalc-bootstrap.js` also re-applies `chmod 0o755` after any runtime auto-download, mirroring the pattern in `ffmpeg-bootstrap.js`.

---

## API Key Policy

> **The AcoustID API key must NEVER be committed to the repository or appear in any source file.**

### Why

AcoustID API keys are per-application. Once published, they can be abused by third parties, violating AcoustID's non-commercial terms. The key `save/conf/default.json` is covered by `.gitignore` (`save/conf/*`), but source files like `config.js` are not.

### Rule

- The API key is stored **only** in `save/conf/default.json` → field `acoustid.apiKey`
- It is entered through the **Admin panel → AcoustID** settings section
- The server's Joi config schema has `apiKey: Joi.string().allow('').default('')` — an empty string is the hardcoded default
- The AcoustID worker will **refuse to start** if `apiKey` is empty or has fewer than 8 characters
- The admin UI shows a clear warning when no key is configured

### Config structure (`save/conf/default.json`)

```json
"acoustid": {
  "enabled": false,
  "apiKey": ""
}
```

The `enabled` flag is separate from having a key. Both must be true for the worker to run. This way an admin can configure the key, save it, then deliberately toggle the scanner on/off independently.

---

## Database Schema

Five new columns are added to the `files` table via `ALTER TABLE ... ADD COLUMN` migrations. SQLite `ADD COLUMN` is non-destructive — existing rows get `NULL` for the new columns automatically. No data migration is required.

```sql
ALTER TABLE files ADD COLUMN acoustid_id TEXT;
ALTER TABLE files ADD COLUMN mbid TEXT;
ALTER TABLE files ADD COLUMN acoustid_score REAL;
ALTER TABLE files ADD COLUMN acoustid_status TEXT;
ALTER TABLE files ADD COLUMN acoustid_ts INTEGER;

CREATE INDEX IF NOT EXISTS idx_files_acoustid_status ON files(acoustid_status);
```

| Column | Type | Meaning |
|---|---|---|
| `acoustid_id` | TEXT | AcoustID track UUID (e.g. `9ff43b6a-4f16-427c-93c2-...`) |
| `mbid` | TEXT | MusicBrainz Recording ID — key for future enrichment |
| `acoustid_score` | REAL | Match confidence 0.0–1.0 (typically ≥0.85 = reliable) |
| `acoustid_status` | TEXT | `NULL` = never tried · `'pending'` = in queue · `'found'` · `'not_found'` · `'error'` |
| `acoustid_ts` | INTEGER | Unix timestamp of last attempt (for retry backoff) |

`NULL` on `acoustid_status` is the natural queue marker — **every** song inserted by the scanner starts with `NULL`, so new songs are automatically queued without any extra signaling between the scanner and the fingerprint worker.

---

## Architecture — Worker Thread

```
Velvet server process
  └─ src/api/acoustid.js          ← Admin REST endpoints + worker lifecycle manager
       └─ src/util/acoustid-worker.mjs   ← Worker thread (long-running, independent)
            ├─ opens DB via DatabaseSync (WAL mode supports concurrent reads)
            ├─ spawns bin/fpcalc/fpcalc per file
            ├─ POSTs to api.acoustid.org (≤2 req/s)
            └─ writes results back via POST to internal API
```

### Why a Worker thread (not a child process)?

- The fingerprint job is a **continuous background service**, not a one-shot process like the file scanner
- Worker threads share the process heap, are lighter than child processes, and can be started/stopped cleanly
- Follows the same pattern as `src/util/artist-rebuild-worker.mjs` already in the codebase
- The worker runs independently from the file scanner — it never blocks or delays a rescan

### Worker loop

```
on startup:
  1. verify fpcalc binary exists (bootstrap if not)
  2. verify apiKey is set and non-empty — abort with clear log message if not

main loop:
  1. SELECT up to 50 rows WHERE acoustid_status IS NULL
     OR (acoustid_status = 'error' AND acoustid_ts < NOW - 7 days)
     ORDER BY ts ASC  (oldest-indexed files first)
  2. for each row:
     a. mark acoustid_status = 'pending'
     b. spawn: fpcalc -json -length 120 <absolute_path>
     c. parse JSON output → { duration, fingerprint }
     d. POST https://api.acoustid.org/v2/lookup
           ?client=<apiKey>&duration=D&fingerprint=F
           &meta=recordingids+compress
     e. pick result with highest score
     f. if score ≥ 0.50: status = 'found', store acoustid_id + mbid + score
        else:            status = 'not_found'
     g. on any error:    status = 'error', store timestamp
     h. wait 500 ms (= 2 req/s, safely under AcoustID's 3 req/s limit)
  3. if no rows remain: sleep 60 s, then loop again
  4. on stop signal: finish current row, then exit cleanly
```

**Rate limiting**: AcoustID's published limit is **3 requests per second**. We use 500 ms delays = 2 req/s. For a library of 10,000 songs this equals approximately 83 minutes of background processing total. The worker runs at low priority and has no effect on playback or UI responsiveness.

**`-length 120`**: fpcalc only needs the first 120 seconds of audio to compute a reliable fingerprint. This matters for 80s 7" and 12" versions — they are long but fingerprint equally well from the intro alone.

---

## New Files

| File | Purpose |
|---|---|
| `src/util/fpcalc-bootstrap.js` | Download + verify fpcalc binary; export `fpcalcBin()` |
| `src/util/acoustid-worker.mjs` | Worker thread — the fingerprint engine |
| `src/api/acoustid.js` | REST endpoints + worker lifecycle (start/stop/status) |
| `docs/acoustid.md` | This document |

---

## Modified Files

| File | Change |
|---|---|
| `Dockerfile` | Add fpcalc pre-download block (after yt-dlp block) |
| `src/state/config.js` | Add `acoustidOptions` Joi schema; add `acoustid` to root schema |
| `src/db/sqlite-backend.js` | `ALTER TABLE ADD COLUMN` for 5 new columns + index |
| `src/db/manager.js` | Export new AcoustID read/write helpers |
| `src/server.js` | Import + `setup(velvet)` call for `acoustid.js` |
| `webapp/admin/index.js` | Add `acoustid-view` component + sidebar entry |
| `webapp/locales/en.json` | Add `admin.acoustid.*` keys |
| `webapp/locales/nl.json` | Dutch translations |
| `webapp/locales/*.json` (×10) | English placeholder for all other locales |
| `docs/dev/todo.md` | Remove Tag Workshop Phase 2 AcoustID items (completed) |
| `changes-velvet.md` | Versioned entry |

---

## REST API Endpoints (`/api/v1/acoustid/*`, admin-only)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/acoustid/status` | `{ total, fingerprinted, pending, notFound, errors, running, enabled, hasKey }` |
| `POST` | `/api/v1/acoustid/start` | Start the worker thread (idempotent if already running) |
| `POST` | `/api/v1/acoustid/stop` | Signal worker to stop cleanly after current song |
| `GET` | `/api/v1/admin/config/acoustid` | Read `{ enabled, apiKey: masked }` from config |
| `POST` | `/api/v1/admin/config/acoustid` | Save `{ enabled, apiKey }` to `default.json` |

The `apiKey` returned by the GET endpoint is **masked** (e.g. `QRFXOk****`) — it never echoes the full key to the client.

---

## Admin UI — AcoustID View

Located in **Admin → AcoustID** sidebar section. Follows the same card layout as the Discogs settings panel.

### Settings card
- **Enable AcoustID fingerprinting** toggle
- **Application API key** input field (password type, masked)
- *"Never share your API key. It is stored only in your server config and never sent to GitHub."* — hint text
- **Save settings** button
- Warning banner: `⚠ No API key configured — fingerprinting is disabled` (shown when key is empty)

### Progress card
- `Fingerprinted: 8,432 / 12,105 songs (69.6%)`
- Progress bar (green)
- **▶ Start scanning** / **⏹ Stop scanning** button (toggles based on `running` state)
- Status badge: `Idle` / `Running` / `Stopping…`
- Informational note: *"Processing rate: ~2 songs/second. A library of 10,000 songs takes approximately 83 minutes."*

### Results breakdown
- Found: 8,200
- Not found: 232 *(short clips, recordings, radio captures)*
- Errors: 12 *(unreadable files — check scan errors log)*
- Not yet processed: 3,661

---

## Security Notes

1. **API key** — never in source code, `.gitignore` covers `save/conf/*`
2. **Worker auth** — the worker communicates back to the server via internal POST with a JWT minted at startup (same pattern as the file scanner)
3. **No user data sent to AcoustID** — only the audio fingerprint hash and duration are transmitted; no filenames, no metadata, no library structure
4. **Rate limit compliance** — hard-coded 500 ms minimum gap between requests; the worker cannot be configured to go faster

---

## What Comes After This Feature

Building AcoustID fingerprinting is **Phase 1 of metadata enrichment**. Here is what it unlocks:

### Phase 2 — Tag Workshop (already in docs/dev/todo.md)
The MBID stored in the database becomes the key to MusicBrainz. A second call to `musicbrainz.org/ws/2/recording/<mbid>?inc=artists+releases` retrieves:
- Canonical title, artist, album, track number, release year
- Multiple releases the recording appeared on (pick the most relevant)
- Artist MBIDs (enabling artist disambiguation and linking)

The Tag Workshop admin panel presents these suggested corrections in a review table — one row per file with a confidence indicator. Actions: **Accept** (write tags), **Edit** (inline), **Skip**.

### Phase 2b — MB Text Search Fallback (implemented)

For files where AcoustID returned `acoustid_status = 'not_found'` (rare recordings, 12-inch rips, bootlegs not in the AcoustID database), Velvet includes a **text-search fallback** worker: `src/util/mb-text-search-worker.mjs`.

**How it works:**

1. Selects all files with `acoustid_status = 'not_found'`, `mb_text_search_status IS NULL`, and non-trivial `title` + `artist` tags (length > 2)
2. Skips files where title or artist match placeholder patterns (`unknown`, `track 01`, `various artists`, etc.)
3. Strips common vinyl track-number prefixes from titles before querying (`A1. `, `B2 - `, etc.) via `cleanTitle()`
4. Queries `https://musicbrainz.org/ws/2/recording/?query=artist:"…" AND recording:"…"&limit=5`
5. Picks the best result using score DESC + duration proximity as a tiebreaker
6. Score threshold: **≥ 70** to store a result (MB returns integer 0–100, stored normalised 0.0–1.0)
7. On a match: writes `mb_title`, `mb_artist`, `mb_artist_id`, `mbid` and resets `mb_enrichment_status = NULL` — this triggers the existing MB enrichment worker to fetch full album/year/track data for the MBID
8. Results are always `tag_status = 'needs_review'` — never `'confirmed'` (text-match is fundamentally less reliable than an audio fingerprint)

**Rate limiting:** 1,100 ms between requests (safely under MusicBrainz's 1 req/s limit). The text-search worker and the MB enrichment worker run independently — if both are active simultaneously they share the 1 req/s budget between them. Start only one at a time for large libraries.

**`mb_text_search_status` state machine:**

| Value | Meaning |
|---|---|
| `NULL` | Not yet attempted (natural queue marker) |
| `'pending'` | In progress — reset to `NULL` on worker restart |
| `'found'` | Match found; `mbid` + `mb_*` columns populated |
| `'not_found'` | No result above threshold after searching |
| `'skipped_no_tags'` | Title or artist matched a placeholder pattern — not worth querying |
| `'skipped_low_score'` | Results returned but all scored below 70 |
| `'error'` | Network or parse error — will be retried via retry-notfound endpoint |

**New DB columns added by migration:**

| Column | Type | Description |
|--------|------|-------------|
| `mb_text_search_status` | TEXT | State machine value (see above) |
| `mb_text_search_score` | REAL | Best MB score normalised 0.0–1.0 |
| `mb_text_search_ts` | INTEGER | Unix timestamp of last attempt |

Index: `idx_files_mb_text_search_status ON files(mb_text_search_status)`

**Admin UI:** A "Step 1b — MB Text Search" card in the Tag Workshop panel. Shows queued / found / not found / skipped / error counts, start/stop buttons, and a "Retry not-found" action. Albums containing text-matched tracks show a match-source badge in the album list.

### Phase 3 — Duplicate Detection
Once every file has an `acoustid_id`, finding duplicates is trivial:
```sql
SELECT acoustid_id, COUNT(*) as n, GROUP_CONCAT(filepath) 
FROM files WHERE acoustid_id IS NOT NULL 
GROUP BY acoustid_id HAVING n > 1
```
This catches duplicates that have completely different filenames and tags — something no string-matching approach can do. The admin panel shows pairs/groups side by side for manual selection.

### Phase 4 — Artist Page enrichment
MusicBrainz artist MBIDs (derived from the recording MBID) enable:
- Official artist biography (from MusicBrainz or Wikipedia via wikidata)
- Complete structured discography (all studio albums, EPs, live albums) from MB
- Album artwork sourced from Cover Art Archive (CC-licensed) instead of Discogs only

### Phase 5 — Better Auto-DJ
Having reliable genre/year/artist data from MusicBrainz (not just the original tags) improves:
- The decade browser accuracy
- Genre-based smart playlists
- Reducing false matches in the similar-artists Auto-DJ mode (Last.fm uses MB artist IDs internally)

---

## Implementation Order

1. `fpcalc-bootstrap.js` — binary download + `fpcalcBin()` export
2. `Dockerfile` — add fpcalc pre-download block
3. DB schema migrations (5 columns + index)
4. Config Joi schema (`acoustidOptions`)
5. `acoustid-worker.mjs` — core loop
6. `acoustid.js` — REST API + worker lifecycle
7. Wire into `server.js`
8. Admin UI component (`acoustid-view`) + i18n keys in all 12 locales
9. Docs + changelog + `docs/dev/todo.md` cleanup
