# Tag Editor / Tag Workshop — Full Design

> **Status**: Design complete. Worker bug fix applied (v6.x.x). Implementation pending user approval of this document.

---

## Background: What We Know About the Library

Analysis run on 2026-04-14 against `save/db/velvet.sqlite`:

| Metric | Count |
|---|---|
| Total songs in DB | 134,431 |
| AcoustID processed (found) | 2,606 (scan still running) |
| AcoustID not found | 55 |
| AcoustID errors | 3 |
| Still queued (NULL status) | 131,766 |
| Missing title (among found) | 318 / 2,606 |
| Missing artist (among found) | 318 / 2,606 |
| Missing album (among found) | 363 / 2,606 |
| Missing year (among found) | 520 / 2,606 |

**Key insight**: ~12% of already-matched songs have missing title/artist, and ~20% are missing year. Extrapolating to the full library once the scan is done, we can expect 15,000–25,000 songs that need tag corrections.

---

## Bug Fix Applied (prerequisite — already done)

**Problem**: The AcoustID worker used `meta: 'recordingids+compress'` which, per the actual API response, strips the `recordings` array entirely and returns only `{id, score}`. This caused all 2,606 processed songs to have `mbid = NULL` despite a `'found'` status.

**Fix applied**:
- Changed worker `meta` flag to `'recordings'` — returns `recordings: [{id, title, artists: [{id, name}], duration}]`
- Worker now stores `mb_title`, `mb_artist`, `mb_artist_id` directly from the AcoustID response (no extra API call needed for basic title/artist)
- Added migration that resets `acoustid_status='found' AND mbid IS NULL` rows back to NULL so they get reprocessed correctly
- Added 3 new DB columns: `mb_title TEXT`, `mb_artist TEXT`, `mb_artist_id TEXT`

**Result after next server restart**: The 2,606 already-processed songs are queued for re-processing. New data will include MBID, canonical title, canonical artist, and artist MBID.

---

## Database Schema — Tag Workshop Columns

### What AcoustID `recordings` meta gives us (stored in Phase 1 — already done)

| Column | Type | Source |
|---|---|---|
| `acoustid_id` | TEXT | AcoustID UUID |
| `mbid` | TEXT | MusicBrainz Recording UUID |
| `acoustid_score` | REAL | Match confidence 0.0–1.0 |
| `mb_title` | TEXT | Canonical MB recording title |
| `mb_artist` | TEXT | Canonical MB artist name |
| `mb_artist_id` | TEXT | MB artist UUID |

### New columns needed for Tag Workshop (Phase 2+)

These are added as non-destructive `ALTER TABLE ADD COLUMN` migrations on startup.

| Column | Type | Source | Phase |
|---|---|---|---|
| `mb_album` | TEXT | MusicBrainz release name | Phase 2 |
| `mb_year` | INTEGER | MusicBrainz release year | Phase 2 |
| `mb_track` | INTEGER | Track position from MB | Phase 2 |
| `mb_release_id` | TEXT | MB release UUID | Phase 2 |
| `mb_enrichment_status` | TEXT | `NULL` / `'pending'` / `'done'` / `'error'` / `'no_data'` | Phase 2 |
| `mb_enriched_ts` | INTEGER | Unix ts of last MB lookup | Phase 2 |
| `tag_status` | TEXT | `NULL` / `'confirmed'` / `'needs_review'` / `'accepted'` / `'skipped'` | Phase 3 |

**Total new columns needed**: 7 (on top of the 3 already added in the bug fix)

---

## Phase 2 — MusicBrainz Enrichment Worker

### Purpose
Use the stored `mbid` to fetch album, year, and track number from the MusicBrainz REST API. Album + year are NOT available from the AcoustID response — a separate MB call is required.

### Rate limit
MusicBrainz requires:
- Strict 1 req/s maximum (harder limit than AcoustID's 3/s)
- `User-Agent` header with app name + contact email
- At 1 req/s with 130K songs: ~36 hours total. The worker runs continuously in the background.

### API call
```
GET https://musicbrainz.org/ws/2/recording/{mbid}?inc=artists+releases+release-groups&fmt=json
```

Sample response structure (relevant fields only):
```json
{
  "id": "ae424ef7-...",
  "title": "Respect (club vocal remix)",
  "length": 402000,
  "releases": [
    {
      "id": "release-uuid",
      "title": "Respect / In and Out of My Life",
      "date": "1994",
      "media": [{ "track-count": 8, "position": 1,
        "tracks": [{ "position": 1, "title": "Respect (club vocal remix)" }] }],
      "release-group": { "primary-type": "Single" }
    }
  ],
  "artist-credit": [{ "artist": { "id": "5fd...", "name": "Adeva" } }]
}
```

### Release selection logic
Each recording can appear on multiple releases (original single, compilation, re-issue). Priority order:
1. `release-group.primary-type` = `"Single"` or `"Album"` (prefer over compilations)
2. Earliest `date` (pick the original release, not a re-issue)
3. Fall back to first release in array

### Worker architecture
Follows the same pattern as `acoustid-worker.mjs`:
- New file: `src/util/mb-enrich-worker.mjs`
- `workerData`: `{ dbPath, freebase_user_agent }`
- Queue: `WHERE mbid IS NOT NULL AND mb_enrichment_status IS NULL`
- Retry: `WHERE mb_enrichment_status = 'error' AND mb_enriched_ts < NOW - 7 days`
- Lifecycle managed from `src/api/acoustid.js` (reuse same admin start/stop UI)
- Runs automatically after AcoustID scan is complete (or independently if manually started)

### Rate limiting detail
```
1000 ms delay between each MB request
Batch size: 50 rows
Idle: sleep 60s when queue is empty
```

---

## Phase 3 — Tag Comparison (Populating `tag_status`)

After MB enrichment writes `mb_album`, `mb_year`, `mb_track` to a row, a comparison step classifies it:

### Comparison algorithm

```js
function compareTags(row) {
  const checks = [];

  // Title comparison (case-insensitive, strip punctuation)
  if (row.mb_title) {
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    checks.push(norm(row.title) === norm(row.mb_title));
  }

  // Artist comparison (same normalisation)
  if (row.mb_artist) {
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    checks.push(norm(row.artist) === norm(row.mb_artist));
  }

  // Year comparison (tolerance: ±1 year for re-issues)
  if (row.mb_year && row.year) {
    checks.push(Math.abs(row.year - row.mb_year) <= 1);
  }

  // Album comparison
  if (row.mb_album && row.album) {
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    checks.push(norm(row.album) === norm(row.mb_album));
  }

  // Missing fields (null in DB but MB has data) = needs review
  const hasMissingData = (
    (!row.title && row.mb_title) ||
    (!row.artist && row.mb_artist) ||
    (!row.year && row.mb_year) ||
    (!row.album && row.mb_album)
  );

  if (hasMissingData) return 'needs_review';
  if (checks.every(Boolean)) return 'confirmed';
  return 'needs_review';
}
```

This runs as a lightweight pass in `sqlite-backend.js` (a single UPDATE ... SET tag_status = CASE ...) — no worker thread needed, runs at MB enrichment completion per batch.

### Why `'confirmed'` songs never appear in the workshop
```sql
-- Workshop only shows:
SELECT * FROM files WHERE tag_status = 'needs_review'
-- confirmed (tag_status = 'confirmed') → invisible to admin
-- skipped (user chose not to change) → invisible too
-- accepted (user applied fix) → invisible (already done)
```

---

## Phase 4 — Tag Workshop UI (Album-Grouped)

### The scale problem
- 130K songs → ~20K `needs_review` rows (estimated, ~15%)
- Showing 20K individual rows = unusable
- **Solution: group by album**, not by song

### Album grouping
```sql
SELECT
  mb_artist,
  mb_album,
  mb_year,
  COUNT(*) AS track_count,
  SUM(CASE WHEN title IS NULL OR title = '' THEN 1 ELSE 0 END) AS missing_titles,
  SUM(CASE WHEN artist IS NULL OR artist = '' THEN 1 ELSE 0 END) AS missing_artists,
  SUM(CASE WHEN year IS NULL OR year = 0 THEN 1 ELSE 0 END) AS missing_years,
  MIN(acoustid_score) AS min_score,
  AVG(acoustid_score) AS avg_score
FROM files
WHERE tag_status = 'needs_review'
GROUP BY mb_artist, mb_album
ORDER BY (missing_titles + missing_artists + missing_years) DESC, track_count DESC
```

This turns 20K song rows into ~2,000–3,000 album cards. Each card shows one album at a time.

### Workshop UI layout (Admin → Tag Workshop)

```
┌─────────────────────────────────────────────────────────────────┐
│ Tag Workshop                           Needs review: 18,432 songs│
│                                     ≈ 2,140 albums              │
├──────────┬────────────────┬──────────────────────────────────────┤
│ Filter:  │ Sort:          │ Auto-accept:                         │
│ ○ All    │ ○ Most missing │ [Accept all where only casing differs]│
│ ○ Missing│ ○ Most tracks  │                  Estimated: ~1,200   │
│ ○ Wrong  │ ○ Low score    │                                      │
└──────────┴────────────────┴──────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Adeva — Respect / In and Out of My Life         Score: 96%      │
│ 8 tracks · Year: file=1994 MB=1989 ⚠                            │
├────────────────┬────────────────┬────────────────────────────────┤
│ Field          │ In file        │ From MusicBrainz               │
├────────────────┼────────────────┼────────────────────────────────┤
│ Artist         │ Adeva          │ Adeva                      ✓   │
│ Album          │ Respect / ...  │ Respect / In and Out of... ✓   │
│ Year           │ 1994           │ 1989                       ⚠   │
│ Tracks missing │ 0              │ 0                          ✓   │
└────────────────┴────────────────┴────────────────────────────────┘
│  [✓ Accept all 8 tracks]  [✏ Edit year then accept]  [✗ Skip]   │
└─────────────────────────────────────────────────────────────────┘
```

### Actions per album card

| Button | Effect |
|---|---|
| **Accept all N tracks** | Writes MB values for all `needs_review` tracks in this album to files + DB; sets `tag_status = 'accepted'` |
| **Edit then accept** | Opens inline editor with MB values pre-filled; user adjusts; writes on confirm |
| **Skip album** | Sets `tag_status = 'skipped'` for all tracks in album; disappears from queue |
| **Auto-accept (casing only)** | Batch: if only difference is capitalisation/punctuation → auto-accept without review |

### Pagination / scale handling
- Load 20 album cards at a time (pagination or infinite scroll)
- Filter chips: "Missing tags" | "Year mismatch" | "Artist mismatch" | "All"
- Sort: "Most broken first" (default) | "Most tracks affected" | "Alphabetical" | "Lowest score"
- Progress bar: "Reviewed X of Y albums"

---

## Phase 5 — Tag Writing

### Library choice
No tag writing library currently in `package.json`. Options evaluated:

| Library | Formats | Notes |
|---|---|---|
| `node-id3` | MP3 only | Mature, pure JS |
| `flac` / `node-flac` | FLAC only | Bindings, partially maintained |
| **ffmpeg (existing)** | All formats | Re-mux with `-c copy` — no re-encoding |
| `exiftool-vendored` | All formats | Requires ExifTool binary |

**Decision: use `bin/ffmpeg/ffmpeg` with `-c copy` stream copy.**

Rationale:
- ffmpeg is already bundled, verified, and managed by `fpcalc-bootstrap` pattern
- Handles `.flac`, `.mp3`, `.aac`, `.m4a`, `.ogg`, `.opus` — everything in the library
- `-c copy` doesn't re-encode audio; only rewrites the container metadata
- No new npm dependency needed
- Tag writing is an infrequent, deliberate admin action — ffmpeg speed is fine

### Write operation

```js
async function writeTagsToFile(absolutePath, tags) {
  const tmp = absolutePath + '.tagtmp';
  const args = [
    '-i', absolutePath,
    '-c', 'copy',
    '-map_metadata', '0',       // start with existing tags
    '-metadata', `title=${tags.title || ''}`,
    '-metadata', `artist=${tags.artist || ''}`,
    '-metadata', `album=${tags.album || ''}`,
    '-metadata', `date=${tags.year || ''}`,
    '-metadata', `track=${tags.track || ''}`,
    '-y', tmp
  ];
  await spawnAsync(ffmpegBin(), args);
  await fs.rename(tmp, absolutePath);
}
```

After writing: trigger a re-index of the affected files via the existing scan API so DB columns (`title`, `artist`, `album`, `year`) are updated from the file.

### Safety
- Write to `file.tagtmp` first, rename only on success
- On error: `file.tagtmp` is deleted, original is untouched
- Only runs on files in configured vpaths (same check as recording-delete)
- Checks file write access before starting (uses the File-Write Access Check pattern from docs/dev/todo.md)

---

## New REST Endpoints

All admin-only (JWT required).

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/tagworkshop/status` | `{ totalNeedsReview, totalConfirmed, totalSkipped, totalAccepted, mbEnrichmentRunning, mbEnrichmentQueued }` |
| `GET` | `/api/v1/tagworkshop/albums` | Paginated album groups (`?page=N&filter=all\|missing\|year\|artist&sort=broken\|tracks\|alpha`) |
| `GET` | `/api/v1/tagworkshop/album/:mbReleaseId` | All track rows for one album card |
| `POST` | `/api/v1/tagworkshop/accept` | Accept MB tags for one album: `{ mb_artist, mb_album, overrides? }` |
| `POST` | `/api/v1/tagworkshop/skip` | Skip album: `{ mb_artist, mb_album }` |
| `POST` | `/api/v1/tagworkshop/bulk-accept-casing` | Auto-accept all albums where only casing/punctuation differs |
| `POST` | `/api/v1/acoustid/start-mb-enrich` | Start MB enrichment worker |
| `POST` | `/api/v1/acoustid/stop-mb-enrich` | Stop MB enrichment worker |

---

## Admin UI — Tag Workshop View

New sidebar entry: **Tag Workshop** (below AcoustID in the enrichment section).

### Cards (left to right in Admin panel):

**1. Progress card**
- AcoustID scan: X / 134,431 songs fingerprinted
- MB enrichment: X / Y songs enriched (starts after AcoustID is done)
- Tag review: X albums reviewed / Y total
- ▶ Start MB enrichment / ⏹ Stop buttons

**2. Bulk actions card**
- "Auto-accept casing-only differences" → shows estimated count before confirm
- "Reset all skipped" → puts skipped albums back into needs_review queue

**3. Album queue** (the main workshop table, described in Phase 4 above)

---

## Implementation Order

When approved, implement in this sequence:

1. **DB migrations** — add 7 new columns (`mb_album`, `mb_year`, `mb_track`, `mb_release_id`, `mb_enrichment_status`, `mb_enriched_ts`, `tag_status`) in `sqlite-backend.js`
2. **`src/util/mb-enrich-worker.mjs`** — MusicBrainz enrichment worker (1 req/s loop)
3. **Comparison pass** — `updateTagStatus()` function called after each MB batch writes
4. **`src/api/tagworkshop.js`** — REST endpoints (status, albums, accept, skip, bulk-accept)
5. **Tag writing** — `writeTagsToFile()` using ffmpeg stream copy; re-index after write
6. **Admin UI** — Tag Workshop view in `webapp/admin/index.js` with album cards
7. **i18n keys** — `admin.tagworkshop.*` in all 12 locale files
8. **Docs + changelog + docs/dev/todo.md cleanup**

---

## What Is NOT in Scope

- Writing tags to podcasts or radio recordings (only `type: music` files)
- Manual entry of tags from scratch (that's the "Manual Fallback" phase in old todo — kept separate)
- Discogs-sourced tags (keep as separate Discogs flow — different source, different confidence)
- Bulk-apply without review (there is always at least an album-level confirmation step)
