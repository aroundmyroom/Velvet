# BPM & Harmonic Mixing — Full Implementation Plan

> **Status**: Built. All three tiers, the admin panel and the Auto-DJ use are in the code.
> Some parts were built differently from this plan (see the table below and the
> **Built:** notes in each section). The **APPROVE / REJECT** lines are left from the
> planning stage. User guide: [`docs/bpm-harmonic.md`](../bpm-harmonic.md).
> Octave (half/double tempo) correction: [`docs/bpm-plan.md`](../bpm-plan.md).

### Build status

| Part | State | Where |
|------|-------|-------|
| DB columns `bpm`, `musical_key`, `bpm_source`, `ab_status`, `bpm_status` (+ `bpm_raw`) | Built | `src/db/sqlite-backend.js` `init()` |
| Tier 1 — tags | Built | `src/db/scanner.mjs` `parseMyFile()` |
| Tier 0 — AcousticBrainz | Built | `src/util/ab-bpm-worker.mjs`, `src/api/bpm-analysis.js` |
| Tier 2 — Essentia | Built, but with **essentia.js (WASM)** + ffmpeg, not the Essentia binary | `src/util/essentia-bpm-worker.mjs` |
| `src/util/essentia-bootstrap.js`, `bin/essentia/`, `profile.yaml` | **Not built** (not needed with WASM) | — |
| Admin panel | Built | `bpm-workshop-view` in `webapp/admin/index.js` |
| Auto-DJ use | Built, as **soft scoring**, not as hard filters | `_djScoreSong()` in `webapp/app.js`; `scoreSong()` in `src/autodj/scoring.js` |
| Camelot helpers | Built | `webapp/app.js` (`_CAMELOT`, `toCamelot`, `camelotNeighbours`); server: `src/util/camelot.js`, `src/autodj/scoring.js` |

---

## What this enables

Auto-DJ today picks songs randomly within genre/year/artist filters.
Adding BPM and key data unlocks two complementary DJ techniques:

- **BPM continuity** — the next song is within ±N BPM of the current track (configurable tolerance, default ±8). No jarring tempo jumps during crossfade.
- **Harmonic mixing (Camelot Wheel)** — the next song shares a compatible key. Avoids tonal clashes. The DJ industry standard.
- Both can be enabled independently or together. The filter is **NULL-permissive**: songs without BPM/key data remain in the Auto-DJ pool — the library never runs dry even during early collection.

**Built:** the web player does not filter on BPM/key. It fetches a candidate pool
(`POST /api/v1/db/random-songs` with `returnAll: true`) and scores each song in
`_djScoreSong()`; a song without BPM or key gets a neutral score, so it stays in the
pool. Rooms score the same way on the server (`src/autodj/scoring.js`).

---

## Data sources — tiered strategy

Three independent sources are queried in priority order. Each tier fills in data for files the previous tier did not cover.

| Tier | Source | Effort | Expected coverage | CPU cost |
|------|--------|--------|-------------------|----------|
| **Tier 0** | AcousticBrainz live API | 0.5–1 day | ~68 % (91,992 MBID files) | Zero |
| **Tier 1** | Embedded file tags (scanner) | 2–3 h | ~3 % BPM / ~1 % key | Zero — passive |
| **Tier 2** | Essentia local audio analysis | 2–3 days | 100 % fallback | High (background) |

**Recommended execution order:** Tier 1 is passive (next scan), Tier 0 runs overnight (free), Tier 2 fills the rest.

---

## Tool analysis

### Tools evaluated

| Tool | Detects | Prebuilt binary | License | Verdict |
|------|---------|-----------------|---------|---------|
| **Essentia `streaming_extractor_music`** | BPM + key + danceability | ✅ Static Linux binary | AGPL-3.0 | **Winner (Tier 2)** |
| **AcousticBrainz API** | BPM + key (Essentia results, MBID-indexed) | n/a — HTTP API | CC0 | **Winner (Tier 0)** |
| aubio | BPM only, no key. Last release 2019 | via apt | GPL-3.0 | ❌ Rejected |
| libkeyfinder | Key only, no BPM. No prebuilt binary | Must compile | GPL-3.0 | ❌ Rejected |
| Camelot-Wheel-Notation JS | Key compatibility rules only | n/a — pure JS | MIT | ✅ Inline in `webapp/app.js` |

**Essentia wins** because: single binary for BPM + key in one pass, prebuilt static binary (same bootstrap pattern as `rsgain`/`yt-dlp`), first-30 s mode gives ~90 % accuracy at 10 % of full-analysis CPU time, and it is the same engine that powers AcousticBrainz.

**Built:** Velvet uses the `essentia.js` npm package (WASM) instead of the binary.
ffmpeg decodes the audio; `RhythmExtractor2013` gives BPM and `KeyExtractor` gives the key.

**AcousticBrainz** stopped collecting in July 2022, but the API and website remain live as read-only. MetaBrainz has not announced a shutdown. Treated as best-effort: if it goes offline, Tier 2 handles all remaining files.

---

## Camelot Wheel — key compatibility

Industry standard for harmonic mixing. Each key maps to a 2-character code (`1A`–`12A` = minor, `1B`–`12B` = major). Compatible keys for a smooth transition: same slot, ±1 step on the wheel, or the parallel mode (A↔B same number).

| # | A (minor) | B (major) | | # | A (minor) | B (major) |
|---|-----------|-----------|---|---|-----------|-----------|
| 1 | Ab minor | B major | | 7 | D minor | F major |
| 2 | Eb minor | F# / Gb major | | 8 | A minor | C major |
| 3 | Bb minor | Db / C# major | | 9 | E minor | G major |
| 4 | F minor | Ab major | | 10 | B minor | D major |
| 5 | C minor | Eb major | | 11 | F# minor | A major |
| 6 | G minor | Bb major | | 12 | C# minor | E major |

**Compatibility rule** — from current Camelot code `NX`:
- `NA` and `NB` — same slot, both modes
- `(N−1)A`, `(N−1)B` — one step CCW
- `(N+1)A`, `(N+1)B` — one step CW

This gives 6 compatible keys per song. Inline JS in `webapp/app.js` (built; the real
`_CAMELOT` map also has the enharmonic names `G# minor`, `D# minor`, `A# minor`,
`G# major`, `D# major`, `A# major`). The server copy is `CAMELOT` / `CAMELOT_TO_KEYS` /
`toCamelot()` in `src/util/camelot.js`, and `camelotNeighbours()` in `src/autodj/scoring.js`:

```js
const _CAMELOT = {
  'Ab minor':'1A','B major':'1B',
  'Eb minor':'2A','F# major':'2B','Gb major':'2B',
  'Bb minor':'3A','Db major':'3B','C# major':'3B',
  'F minor':'4A','Ab major':'4B',
  'C minor':'5A','Eb major':'5B',
  'G minor':'6A','Bb major':'6B',
  'D minor':'7A','F major':'7B',
  'A minor':'8A','C major':'8B',
  'E minor':'9A','G major':'9B',
  'B minor':'10A','D major':'10B',
  'F# minor':'11A','A major':'11B',
  'C# minor':'12A','E major':'12B',
};
function toCamelot(musicalKey) {
  if (!musicalKey) return null;
  return _CAMELOT[musicalKey] ?? null;
}
function camelotNeighbours(code) {
  if (!code) return null;
  const num = parseInt(code, 10);
  const letter = code.slice(-1);
  const other = letter === 'A' ? 'B' : 'A';
  const prev = ((num - 2 + 12) % 12) + 1;
  const next = (num % 12) + 1;
  return new Set([
    `${num}${letter}`, `${num}${other}`,
    `${prev}${letter}`, `${prev}${other}`,
    `${next}${letter}`, `${next}${other}`,
  ]);
}
```

---

## DB schema — full migration

All new columns are added in `src/db/sqlite-backend.js` `init()` inside the existing migration block (same pattern as `bit_depth`, `mb_release_id`, etc.). Columns are nullable — no existing rows are affected.

```sql
ALTER TABLE files ADD COLUMN bpm            INTEGER;
  -- Rounded BPM, valid range 20–300. NULL = not yet collected.

ALTER TABLE files ADD COLUMN musical_key    TEXT;
  -- "C major", "A minor", "F# minor", etc. (standard notation, ≤ 12 chars)
  -- NULL = not yet collected.

ALTER TABLE files ADD COLUMN bpm_source     TEXT;
  -- 'tag' | 'acousticbrainz' | 'essentia' — provenance of bpm/musical_key

ALTER TABLE files ADD COLUMN ab_status      TEXT;
  -- NULL = not yet tried  |  'done' = AB returned data
  -- 'not_found' = MBID not in AB (Essentia will pick up)
  -- 'error' = network/parse error (reset-able and retriable)

ALTER TABLE files ADD COLUMN bpm_status     TEXT;
  -- NULL = not yet tried  |  'done' = Essentia succeeded
  -- 'error' = Essentia failed (reset-able and retriable)
```

**Built:** these columns exist, plus `bpm_raw REAL` (the value before genre octave
correction, see `docs/bpm-plan.md`) and indexes `idx_files_bpm`, `idx_files_musical_key`.
`bpm` has INTEGER type, but the Essentia worker writes one decimal (e.g. `128.5`), so
values can be fractional. `bpm_status` can also be `'pending'` (in progress) or
`'genre-corrected'`.

**Priority rules:**
1. Scanner (Tier 1) writes `bpm`/`musical_key` only if currently NULL (`COALESCE` in UPDATE).
   **Built differently:** unchanged files are not re-parsed. When a changed file is
   re-inserted, the old value is kept if the file has no BPM/key tag
   (`_preserveBpm` / `_preserveMusicalKey` in `src/api/scanner.js` → `src/db/scanner.mjs`).
2. AB worker (Tier 0) overwrites tag values (AB = Essentia-quality, more reliable than user tags).
3. Essentia worker (Tier 2) always writes its own result regardless of source.

---

---

# TIER 0 — AcousticBrainz API Lookup

> **APPROVE / REJECT**

> **Built** in `src/util/ab-bpm-worker.mjs` + `src/api/bpm-analysis.js`. Differences from
> the plan: ~2.8 req/s (350 ms between requests), 8 s HTTP timeout, User-Agent
> `Velvet/1.0 (https://github.com/aroundmyroom/Velvet)`, the queue also retries
> `ab_status='error'` rows, an extra `POST /api/v1/admin/bpm/ab/reset-not-found`
> route, and the worker auto-starts (see "Workers are opt-in" below).

### What it does

Queries the AcousticBrainz live API for every file that has an MBID (91,992 files — 68 % of the library). AcousticBrainz ran Essentia on millions of recordings and stored BPM + key indexed by MBID. This delivers production-quality data overnight at zero CPU cost.

### Prerequisites

File must have `acoustid_status = 'found'` AND `mbid IS NOT NULL`. Already collected by the existing AcoustID worker. No binary to install.

### API call

```
GET https://acousticbrainz.org/api/v1/{mbid}/low-level
User-Agent: Velvet/1.0 (https://github.com/aroundmyroom/Velvet)
```

**Response parsing:**
```js
const data       = JSON.parse(body);
const bpm        = Math.round(data.rhythm.bpm);   // e.g. 128
const key        = data.tonal.key_key;             // "C#"  (note: key_key not key_temperley)
const scale      = data.tonal.key_scale;           // "major" or "minor"
const musicalKey = `${key} ${scale}`;              // → "C# minor"
```

Note: AB live API field is `tonal.key_key` + `tonal.key_scale`. Essentia's local extractor (Tier 2) uses `tonal.key_temperley.key` + `tonal.key_temperley.scale`. Different paths, same data model — handled in their respective workers.

### Coverage estimate

- 91,992 files have MBIDs
- AcousticBrainz holds ~6 M unique recordings — expected hit rate ~60–80 %
- Expected BPM+key collected: **55,000–73,000 files** with zero CPU

### Rate and runtime

Plan: 1,100 ms between requests (same as `mb-enrich-worker.mjs`):
- 91,992 requests × 1.1 s = ~28 h at 1 req/s
- Can be stopped and resumed. Progress is saved per `ab_status`.

**Built:** `RATE_DELAY_MS = 350` (~2.8 req/s), so a full run of 91,992 files takes
about 9 h.

### New files

| File | Description |
|------|-------------|
| `src/util/ab-bpm-worker.mjs` | Worker thread — rate-limited AB API loop |
| `src/api/bpm-analysis.js` | REST endpoints for Tier 0 and Tier 2 workers |

### Worker design (`src/util/ab-bpm-worker.mjs`)

Mirrors `mb-enrich-worker.mjs`:

```
workerData: { dbPath }

Queue SQL:
  SELECT rowid, filepath, vpath, mbid
  FROM files
  WHERE acoustid_status = 'found'
    AND mbid IS NOT NULL
    AND (ab_status IS NULL OR ab_status = 'error')   -- built: errors are retried
  LIMIT 50

Per-request:
  GET https://acousticbrainz.org/api/v1/{mbid}/low-level
  Timeout: 8 s (built; plan said 25 s)

On 200:
  Parse bpm (20–300) and key (non-empty, ≤ 12 chars)
  UPDATE files SET bpm=?, musical_key=?, bpm_source='acousticbrainz', ab_status='done'

On 404:
  UPDATE files SET ab_status='not_found'  -- no data in AB; Tier 2 picks up

On error / timeout / 5xx:
  UPDATE files SET ab_status='error'
  continue (do not stop worker)

On HTTP 429:
  back off 5 s, retry once; if still 429 → ab_status='error'

Messages to parent thread:
  { type: 'ready' }
  { type: 'progress', currentFile, vpath, processedCount }
  { type: 'status',   stats: { total, done, not_found, errors, queued } }
  { type: 'stopped' }
  { type: 'error', message }
```

### REST endpoints (`src/api/bpm-analysis.js`)

```
POST /api/v1/admin/bpm/ab/start          start AB worker (admin only)
POST /api/v1/admin/bpm/ab/stop           stop after current file
GET  /api/v1/admin/bpm/status            combined status (both workers + coverage)
POST /api/v1/admin/bpm/ab/reset-failed   reset ab_status='error' → NULL (re-queue)
POST /api/v1/admin/bpm/ab/reset-not-found  reset ab_status='not_found' → NULL (built extra; 409 while AB runs)
POST /api/v1/admin/bpm/reset-all         clear bpm/musical_key/bpm_source/ab_status/bpm_status
                                         for entire library (requires confirmation, workers must be stopped)
```

All built. Every `/api/v1/admin/bpm/*` route returns 403 for non-admins. Start replies
`{ ok: true }`, `{ ok: true, status: 'already_running' }` or `{ ok: true, status: 'pending' }`
(queued while a file scan runs). Reset routes reply `{ ok: true, reset: <count> }`.

`GET /api/v1/admin/bpm/status` response shape:
```json
{
  "ab": {
    "running": false, "stopping": false,
    "currentFile": null, "processedCount": 0,
    "stats": { "total": 91992, "done": 0, "not_found": 0, "errors": 0, "queued": 91992 }
  },
  "essentia": {
    "running": false, "stopping": false,
    "currentFile": null, "processedCount": 0,
    "stats": { "total": 134599, "done": 0, "errors": 0, "queued": 134599 },
    "binaryAvailable": true
  },
  "coverage": {
    "hasBpm": 0, "hasKey": 0, "total": 134599,
    "bySource": { "tag": 0, "acousticbrainz": 0, "essentia": 0 }
  }
}
```

### Failsafes (Tier 0)

| Scenario | Handling |
|----------|----------|
| AB returns invalid JSON | Catch parse error → `ab_status='error'`, continue |
| BPM out of range (< 20 or > 300) | Discard BPM, store key if valid. `ab_status='done'` |
| Key string empty or > 12 chars | Discard key, store BPM if valid |
| Both BPM and key invalid | `ab_status='error'` |
| Network timeout (> 8 s built; plan 25 s) | `ab_status='error'`, continue |
| HTTP 429 | Back off 5 s, retry once; if still 429 → `ab_status='error'` |
| AB goes offline permanently | All pending land in `ab_status='error'` → reset-failed → Tier 2 handles them |
| Worker crashes | `_worker.on('error')` + `_worker.on('exit')` in parent resets `_running`, logs |
| DB locked (scanner/other worker running) | `busy_timeout` 5 min + `dbWriteWithRetry()` from `src/util/worker-helpers.mjs` |
| Server restart mid-run | `ab_status IS NULL` files continue from rowid ordering; `ab_status='error'` files stay reset-able |
| Stop requested | Drain after current HTTP request completes, send `{ type: 'stopped' }`, exit |
| Pending state after crash | Built: rows are set to `ab_status='pending'` while in flight; on worker start any `'pending'` → NULL |

### Test scenarios (Tier 0)

1. **Happy path** — file with MBID, AB returns 200 with valid BPM + key → `bpm` set, `musical_key` set, `bpm_source='acousticbrainz'`, `ab_status='done'`.
2. **404 from AB** — MBID in our DB but not in AB → `ab_status='not_found'`, `bpm` and `musical_key` remain NULL (Tier 2 eligible).
3. **BPM = 0 returned** — rejected by range check; key stored if valid; `ab_status='done'`.
4. **Concurrent scanner write** — SQLite PRAGMA busy_timeout 60 s handles the lock; retry succeeds.
5. **Reset failed** — 5 rows have `ab_status='error'` → POST ab/reset-failed → all 5 reset to NULL → queued count increases by 5 on next status poll.
6. **Stop / resume** — worker stopped at 5,000 processed → `ab_status IS NULL` for remaining 86,992 → restart → resumes from first `ab_status IS NULL` row in rowid order.
7. **Worker already running** — second POST /ab/start → `{ ok: true, status: 'already_running' }`, no duplicate spawned.
8. **Non-admin call** — POST /ab/start from non-admin user → HTTP 403.
9. **reset-all while running** — POST /reset-all returns HTTP 409 "Stop all workers before resetting".

---

---

# TIER 1 — Embedded Tag Extraction

> **APPROVE / REJECT**

### What it does

`music-metadata` already reads `common.bpm` and `common.key` from ID3 TBPM/TKEY, Vorbis BPM/INITIALKEY, MP4 `tmpo`, etc. The scanner already parses these but currently discards them. This tier simply stores them in the DB on every scan.

**Passive — no admin panel or worker needed.** Tag data is written during normal library scans. Coverage is low (~3 % BPM, ~1 % key) but it is instant and requires zero extra work from the user.

> **Built.** The code below is in `parseMyFile()` (it sets `songInfo._bpm` and
> `songInfo._musicalKey`). The insert in `src/db/sqlite-backend.js` sets
> `bpm_source='tag'` when either value is present. There is no `COALESCE` update; see
> the "Priority rules" note above for how analysed values survive a re-scan.

### Changes

**`src/db/scanner.mjs`** — in `parseMyFile()`, after `bitrate`/`sampleRate` extraction:

```js
// BPM from embedded tags (ID3 TBPM, Vorbis BPM, MP4 tmpo)
let _bpm = null;
if (songInfo.bpm != null) {
  const n = Math.round(Number(songInfo.bpm));
  if (Number.isFinite(n) && n >= 20 && n <= 300) _bpm = n;
}

// Musical key from embedded tags (ID3 TKEY, Vorbis INITIALKEY)
let _musicalKey = null;
const rawKey = songInfo.key ?? null;
if (rawKey && typeof rawKey === 'string') {
  const k = rawKey.trim().slice(0, 12);
  if (k.length > 0) _musicalKey = k;
}
```

Pass `_bpm` and `_musicalKey` to `insertFileRow` / `updateFileRow`.

**`src/db/sqlite-backend.js`**:
- `insertFileRow`: add `_bpm`, `_musicalKey` params, write only if non-null
- `updateFileRow`: use `COALESCE(bpm, ?)` — **never overwrite non-NULL value** (preserves AB/Essentia results on re-scan)
- `renderMetadataObj()` + `mapFileRow()`: expose `bpm` and `musical_key` in API response
  (built: `renderMetadataObj()` in `src/api/db.js` returns `metadata.bpm` rounded to an
  integer and `metadata["musical-key"]`, with a hyphen)

**Priority (UPDATE SQL):**
```sql
bpm         = COALESCE(bpm, ?),
musical_key = COALESCE(musical_key, ?),
bpm_source  = CASE WHEN bpm IS NULL AND ? IS NOT NULL THEN 'tag' ELSE bpm_source END
```

### Failsafes (Tier 1)

| Scenario | Handling |
|----------|----------|
| `common.bpm` is `"128.5"` | `Math.round(Number(...))` → 129 |
| `common.bpm` is `"0"` or `"9999"` | Rejected by 20–300 range check |
| `common.key` is null or empty | Rejected by length check |
| `common.key` is a Camelot code `"8A"` | Stored as-is. Not built: the `_CAMELOT` map has no self-referential entries, so `toCamelot("8A")` returns `null` and the key is treated as unknown |
| Re-scan after Tier 0 or Tier 2 ran | `COALESCE` in UPDATE preserves the better data source |
| `common.bpm` is NaN after Number() | `Number.isFinite(n)` check rejects it |

### Test scenarios (Tier 1)

1. **MP3 with TBPM=128 and TKEY=Am** → `bpm=128`, `musical_key='Am'`, `bpm_source='tag'`.
2. **FLAC with no BPM or key tags** → both remain NULL, no change.
3. **File with BPM=9999** → rejected, `bpm` stays NULL.
4. **Re-scan after Tier 0 set bpm=130** → `COALESCE` keeps `bpm=130`, tag value discarded.
5. **File with Camelot key `"8A"`** → stored as `musical_key='8A'`.
6. **File with `common.bpm = "not a number"`** → `Number("not a number")` = NaN → `Number.isFinite` = false → rejected.

---

---

# TIER 2 — Essentia Local Audio Analysis

> **APPROVE / REJECT**

### What it does

For all files still missing BPM or key after Tiers 0 and 1, run the Essentia `streaming_extractor_music` binary locally. Analyses the first 30 s per file, extracts BPM + key in ~2–5 s per file. CPU-intensive — runs as an opt-in background worker controlled from the admin Tools panel.

**Estimated runtime:** With ~60,000–75,000 files remaining after Tiers 0+1, and ~3 s per file + 200 ms cooldown: approximately 55–70 hours of continuous runtime. Stop and resume at any time — progress is saved per `bpm_status`.

> **Built differently** in `src/util/essentia-bpm-worker.mjs` (no binary, no bootstrap):
> - Uses the `essentia.js` npm package (WASM), loaded once per worker.
> - ffmpeg (`ffmpegBin()`) decodes the audio to mono 22,050 Hz f32le PCM over a pipe.
> - BPM from `RhythmExtractor2013` (with a half-tempo check), key from `KeyExtractor`
>   (`"<key> <scale>"`). BPM is stored with one decimal.
> - Window: `scanOptions.analyzeBpmWindowSec` (default 60 s), taken from the **middle**
>   of the track; `0` = whole file.
> - Files longer than 20 min are skipped (`bpm_status='error'`). If the decoded PCM is
>   over 60 MB it retries at 11,025 Hz, then gives up with `'error'`.
> - Timeout: 0.3 s per second of audio decoded, at least 60 s. 200 ms pause between files.
> - Batches of 20; when the queue is empty it waits 1 min and checks again.
> - The sections "New binary", "profile.yaml" and "Output parsing" below are the
>   original plan and were **not built**.

### New binary: Essentia (not built)

```
bin/essentia/essentia_streaming_extractor_music    ← static Linux x86_64 binary (~15 MB)
bin/essentia/profile.yaml                          ← 30-second speed profile
```

Bootstrap file `src/util/essentia-bootstrap.js` mirrors `src/util/rsgain-bootstrap.js`:
1. Check if `bin/essentia/essentia_streaming_extractor_music` exists
2. If not: download tarball from `https://essentia.upf.edu/documentation/extractors/essentia-extractor-v2.1-beta6-linux-x86_64.tar.gz`, extract, `chmod +x`
3. Write `bin/essentia/profile.yaml` with the 30-second speed profile (below)
4. Export `essentiaExtractorBin()` / `essentiaAvailable()` helpers

**profile.yaml:**
```yaml
startTime: 0
endTime: 30
outputFrames: 0
outputFormat: json
requireMbid: false
indent: 0
rhythm:
  method: degara
  minTempo: 40
  maxTempo: 208
tonal:
  frameSize: 4096
  hopSize: 2048
```

**Output parsing:**
```js
const raw        = JSON.parse(fs.readFileSync(tmpJson, 'utf8'));
const bpm        = Math.round(raw.rhythm.bpm);
const key        = raw.tonal.key_temperley.key;    // "C"
const scale      = raw.tonal.key_temperley.scale;  // "major" or "minor"
const musicalKey = `${key} ${scale}`;              // → "C major"
```

### New files

| File | Description | State |
|------|-------------|-------|
| `src/util/essentia-bootstrap.js` | Download + validate binary, write profile.yaml | Not built |
| `src/util/essentia-bpm-worker.mjs` (plan name: `essentia-worker.mjs`) | Worker thread — Essentia analysis per file | Built (WASM) |

### Worker design (`src/util/essentia-bpm-worker.mjs`)

Plan below. Built version: `workerData: { dbPath, folders, ffmpegBin, bpmWindowSec }`,
ffmpeg decode + WASM instead of steps 3–4 and 7, `LIMIT 20`.

```
workerData: { dbPath, folders, essentiaBin }

Queue SQL:
  SELECT rowid, filepath, vpath
  FROM files
  WHERE format IS NOT NULL
    AND (bpm IS NULL OR musical_key IS NULL)
    AND (bpm_status IS NULL)
  ORDER BY rowid
  LIMIT 50

Per-file:
  1. Resolve path: folders[vpath] + '/' + filepath
  2. Check file exists — if not: bpm_status='error', skip
  3. Write tmp output: os.tmpdir() + '/ess_' + hash + '.json'
  4. Spawn: essentia_streaming_extractor_music <audioPath> <tmpJson> <profilePath>
     Timeout: 60 s. Kill with SIGKILL on timeout.
  5. On exit code 0: parse tmpJson, validate bpm (20–300) and key (non-empty, ≤ 12 chars)
  6. UPDATE files SET bpm=?, musical_key=?, bpm_source='essentia', bpm_status='done'
  7. Delete tmpJson
  8. On error / timeout / bad exit: bpm_status='error', delete tmpJson, log filepath

Cooldown: 200 ms between files (workerData.yieldMs, default 200)

Messages to parent:
  { type: 'ready' }
  { type: 'progress', currentFile, vpath, processedCount }
  { type: 'status',   stats: { total, done, errors, queued } }
  { type: 'stopped' }
  { type: 'error', message }
```

### REST endpoints (additional in `src/api/bpm-analysis.js`)

```
POST /api/v1/admin/bpm/essentia/start          start Essentia worker (admin only)
POST /api/v1/admin/bpm/essentia/stop           stop after current file
POST /api/v1/admin/bpm/essentia/reset-failed   reset bpm_status='error' → NULL
```

All three built. Also built (not in this plan): genre octave correction routes
`POST /api/v1/admin/bpm/genre-correct` (`?dryRun=true` for a preview),
`POST /api/v1/admin/bpm/genre-correct-selected` and `POST /api/v1/admin/bpm/genre-correct-undo`
— see `docs/bpm-plan.md`. They return 409 while the Essentia worker runs.

### Failsafes (Tier 2)

The two binary rows are plan only (no binary is downloaded). Built: if `essentia.js`
fails to load, the worker sends `{ type: 'error' }` and stops. `binaryAvailable` in the
status reply is always `true`.

| Scenario | Handling |
|----------|----------|
| Essentia binary missing on first start | `ensureEssentia()` downloads it before spawning. If download fails → POST /essentia/start returns `{ error: 'Essentia binary not available' }` |
| Download fails (no internet, upf.edu down) | Error surfaced in POST /start response; admin can retry |
| Audio file not found on disk | `bpm_status='error'`, log filepath, continue |
| Essentia exits non-zero | `bpm_status='error'`, delete tmp JSON, continue |
| Essentia hangs (> 60 s) | `childProcess.kill('SIGKILL')`, `bpm_status='error'` (built: the ffmpeg decode has the timeout) |
| JSON output malformed | Catch parse error → `bpm_status='error'` |
| BPM out of range | Store NULL for BPM, store key if valid, `bpm_status='done'` |
| Only key is invalid | Store BPM if valid, `musical_key` stays NULL, `bpm_status='done'` |
| Temp JSON disk full | Catch write error → stop worker (disk full is fatal), send `{ type: 'error' }` |
| Worker crashes (uncaught) | `_worker.on('error')` + `_worker.on('exit')` in parent resets `_running`, logs |
| Stop requested | Drain after current Essentia spawn completes, send `stopped`, exit |
| Server restart mid-run | `bpm_status IS NULL` rows continue from rowid order; `bpm_status='error'` stay reset-able |
| Running concurrently with AB worker | AB targets `ab_status IS NULL`, Essentia targets `bpm_status IS NULL` — no same-file collisions. SQLite WAL handles concurrent writes |

### Test scenarios (Tier 2)

1. **Happy path** — file with no tags, Essentia runs → `bpm=128`, `musical_key='C major'`, `bpm_source='essentia'`, `bpm_status='done'`.
2. **File deleted since scan** — file not found on disk → `bpm_status='error'`, worker continues.
3. **Essentia binary missing** — plan only; not applicable to the WASM build.
4. **Stop mid-analysis** — stop signal after file N → drains that file → `{ type: 'stopped' }` → `_running=false` in parent.
5. **Reset failed** — 20 files have `bpm_status='error'` → POST reset-failed → all 20 reset to NULL → queued increases by 20 on next poll.
6. **AB and Essentia running simultaneously** — AB on MBID files, Essentia on non-MBID files. SQLite WAL + busy_timeout handles concurrent writes.
7. **File has bpm from Tier 0, missing key** — WHERE `(bpm IS NULL OR musical_key IS NULL)` includes this row → Essentia fills key only. After: `bpm` stays from AB, `musical_key` added from Essentia, `bpm_status='done'`.
8. **Non-audio file** (e.g. `.jpg` accidentally in DB) — Essentia exits non-zero → `bpm_status='error'`, skipped permanently unless reset.
9. **Non-admin call** → HTTP 403.
10. **reset-all while running** → HTTP 409 "Stop all workers before resetting".

---

---

# Admin UI — "BPM & Key Analysis" Tool Card

**Location:** Admin → Tools section, same row as Normalisation Workshop and Tag Workshop.

> **Built:** `bpm-workshop-view` in `webapp/admin/index.js`, side-nav item
> `data-admin-view="bpm-workshop-view"` in `webapp/admin/index.html` (label key
> `admin.nav.bpmWorkshop`), next to the Tag Workshop and Normalisation Workshop items.
> It polls `GET /api/v1/admin/bpm/status` every 2 s while a worker runs, 30 s when idle.
> It also has "reset not found" and the genre octave correction controls. The layout
> below is the plan sketch; the real panel may differ in detail.

### Layout

```
┌─ BPM & Key Analysis ──────────────────────────────────────────────────────┐
│ Collects BPM and musical key for your library. Enables BPM-continuity and  │
│ harmonic mixing in Auto-DJ.                                                 │
│                                                                             │
│ LIBRARY COVERAGE                                                            │
│  Has BPM:  12,450 / 134,599  ( 9.2 %)   ▓▓░░░░░░░░░░░░░░░░░░░░░           │
│  Has key:  12,450 / 134,599  ( 9.2 %)   ▓▓░░░░░░░░░░░░░░░░░░░░░           │
│  Source — Tags: 0  AcousticBrainz: 12,450  Essentia: 0                     │
│                                                                             │
│ ── STEP 1 — AcousticBrainz API  (68% of library, zero CPU) ───────────────│
│ ℹ Queries AcousticBrainz for your MBID-matched files at 1 req/s.           │
│   Takes ~28 hours for the full eligible set. Stop and resume any time.     │
│   Prerequisite: AcoustID fingerprinting must have run first.               │
│                                                                             │
│ [▶ Start]  [■ Stop]   ● Idle                                               │
│  Total: 91,992   Done: 12,450   Not found: 320   Errors: 5   Queued: 79,217│
│  [Reset errors]                                                             │
│  ▶ Music/12 Inches/Various Artists - Megamix 84/track.flac                 │
│                                                                             │
│ ── STEP 2 — Essentia Audio Analysis  (CPU-intensive fallback) ─────────────│
│ ℹ Analyses remaining files locally (first 30 s each). Est. ~65 h for       │
│   70,000 files. Stop and resume at any time.                               │
│   ⚠ Essentia binary (~15 MB) will be downloaded on first start.            │
│                                                                             │
│ [▶ Start]  [■ Stop]   ● Idle                                               │
│  Total: 134,599   Done: 0   Errors: 0   Queued: 134,599                    │
│  [Reset errors]                                                             │
│                                                                             │
│ ──────────────────────────────────────────────────────────────────────────│
│ [Reset ALL BPM data]  ← clears bpm/musical_key/bpm_source/ab_status/       │
│                          bpm_status for entire library. Requires confirm.  │
└───────────────────────────────────────────────────────────────────────────┘
```

### Vue component

**Name:** `bpm-workshop-view` — registered in admin nav under Tools, same as `rg-workshop-view`.

**Pattern:** Mirrors `rg-workshop-view` exactly:
- `setInterval` poll at 2,000 ms when either worker is running, 30,000 ms when idle
- `currentFile` displayed with `▶` prefix and monospace font
- Progress shown as: `Done: X  Errors: Y  Queued: Z`
- `resetConfirm: false` toggle for the Reset All button (click once to arm, click again to confirm — same as `admin.rg.confirmResetAll` pattern)

**State:**
```js
ab: {
  running: false, stopping: false,
  currentFile: null, processedCount: 0,
  stats: { total: 0, done: 0, not_found: 0, errors: 0, queued: 0 }
},
essentia: {
  running: false, stopping: false,
  currentFile: null, processedCount: 0,
  stats: { total: 0, done: 0, errors: 0, queued: 0 },
  binaryAvailable: null
},
coverage: { hasBpm: 0, hasKey: 0, total: 0, bySource: { tag: 0, acousticbrainz: 0, essentia: 0 } },
resetConfirm: false
```

**CRITICAL — i18n note:** Do NOT define a `t()` method inside the component's `methods` block. `t()` is inherited from `Vue.prototype` via `I18NSTATE` — defining it locally breaks reactivity and shows raw keys in the UI.

### Admin nav entry

Plan was a JS nav array entry. Built as static HTML in `webapp/admin/index.html`:
```html
<div class="side-nav-item" data-admin-view="bpm-workshop-view">
  ...
  <span data-i18n="admin.nav.bpmWorkshop">BPM &amp; Key Analysis</span>
</div>
```

---

---

# Auto-DJ Integration

> **APPROVE / REJECT** — depends on at least Tier 0 or Tier 1 having run (otherwise no data to filter on, but it is safe to enable in advance since the filter is NULL-permissive).

> **Built differently.** What the code does today:
> - **Web player** (`webapp/app.js`): fetches the whole candidate pool from
>   `POST /api/v1/db/random-songs` with `returnAll: true` and **no** BPM/key params.
>   `_djScoreSong()` then scores each song: BPM proximity (60 % current track, 40 %
>   `S.djBpmBase` or the session anchor, within `S.djBpmTolerance`) and Camelot match
>   (same key 1.0, neighbour 0.7, two steps 0.3, no key 0.4). Songs are never excluded
>   for BPM/key. `_djSongBlocked()` only checks the word filter.
> - **Track change**: `_currentBpm` / `_currentCamelot` / `_currentNeighbours` are set
>   in `Player.playAt()`, not in `_onMeta()` / `_trackChanged()`.
> - **Server filter** (`_appendBpmKeyFilters()` in `src/db/sqlite-backend.js`, used by
>   `getRandomSongs()`, `countFilesForRandom()` and the Auto-DJ pick helpers) is **strict**,
>   not NULL-permissive: with `bpmMin`/`bpmMax`/`bpmRanges`/`musicalKeys` set, songs with
>   NULL BPM/key are left out. `musicalKeys` are **Camelot codes** (e.g. `"8A"`),
>   expanded to key names with `CAMELOT_TO_KEYS`. The random-songs route also accepts
>   `bpmRanges`, `bpmRangesWide`, `requireBpm` and `requireMusicalKey`, and relaxes the
>   filters step by step when nothing matches. The AI queue (`src/api/ai-queue.js`) uses it.
> - **Rooms and other clients**: rooms score on the server with `scoreSong()` in
>   `src/autodj/scoring.js`. `POST /api/v1/autodj/next` (being added) gives Tizen and the
>   server remote the same server-side pick.
>
> The code blocks below are the original plan.

### Backend: `getRandomSongs()` filter params

In `src/db/sqlite-backend.js` `getRandomSongs()`, after the existing `toYear` block:

```js
// BPM continuity filter — NULL-permissive (songs without BPM always included)
if (opts.bpmMin != null) {
  whereSql += ' AND (f.bpm IS NULL OR f.bpm >= ?)';
  params.push(Number(opts.bpmMin));
}
if (opts.bpmMax != null) {
  whereSql += ' AND (f.bpm IS NULL OR f.bpm <= ?)';
  params.push(Number(opts.bpmMax));
}
// Harmonic key filter — NULL-permissive
if (Array.isArray(opts.musicalKeys) && opts.musicalKeys.length > 0) {
  const kIn = opts.musicalKeys.map(() => '?').join(',');
  whereSql += ` AND (f.musical_key IS NULL OR f.musical_key IN (${kIn}))`;
  params.push(...opts.musicalKeys);
}
```

### `renderMetadataObj()` additions

```js
bpm:         row.bpm         ?? null,
musical_key: row.musical_key ?? null,
```

### Client-side in `webapp/app.js`

**Camelot helpers** — added near the top of `webapp/app.js` (after the existing constants section):
```js
const _CAMELOT = { ... };   // table from Camelot Wheel section above
function toCamelot(musicalKey) { ... }
function camelotNeighbours(code) { ... }
```

**Track change hook** — in `_onMeta()` / `_trackChanged()`:
```js
_currentBpm        = nowPlaying.bpm ?? null;
_currentCamelot    = toCamelot(nowPlaying.musical_key);
_currentNeighbours = camelotNeighbours(_currentCamelot);
```

**`_djSongBlocked(song)`** — add at the end (before `return false`):
```js
// BPM continuity (only if both sides have data)
if (S.djBpmContinuity && _currentBpm && song.bpm) {
  if (Math.abs(song.bpm - _currentBpm) > (S.djBpmTolerance ?? 8)) return true;
}
// Harmonic mixing (only if both sides have data)
if (S.djHarmonicMixing && _currentCamelot && song.musical_key) {
  const cand = toCamelot(song.musical_key);
  if (cand && !_currentNeighbours.has(cand)) return true;
}
```

**Auto-DJ prefetch** — `autoDJPrefetch()` already sends filter params to `/api/v1/db/random-songs`. Add to the params object:
```js
if (S.djBpmContinuity && _currentBpm) {
  p.bpmMin = _currentBpm - (S.djBpmTolerance ?? 8);
  p.bpmMax = _currentBpm + (S.djBpmTolerance ?? 8);
}
if (S.djHarmonicMixing && _currentNeighbours) {
  p.musicalKeys = [..._currentNeighbours];
}
```

**Auto-DJ panel additions** (three new controls below existing genre/year sliders):
- **BPM Continuity** checkbox toggle, default OFF
- **BPM Tolerance** `<input type="range" min="1" max="20" step="1">` label `player.autodj.bpmTolerance`, shown only when BPM Continuity is ON
- **Harmonic Mixing** checkbox toggle, default OFF

State stored in `S` / `localStorage`.

**Built:** all three controls exist (`#dj-bpm-tol` slider, 1–20). Also built: a base BPM
(`S.djBpmBase`, 20–300 or auto) and a Camelot wheel popup (`_camelotWheelHTML()`).
localStorage keys: `ms2_dj_bpm_cont_<user>`, `ms2_dj_bpm_tol_<user>`,
`ms2_dj_bpm_base_<user>`, `ms2_dj_harmonic_<user>`.

### Failsafes (Auto-DJ integration)

| Scenario | Handling |
|----------|----------|
| Current song has no BPM, BPM Continuity ON | `_currentBpm = null` → skip BPM check entirely |
| Candidate has no BPM, current has BPM | NULL-permissive SQL: candidate passes server-side filter |
| Key in Camelot format `"8A"` | Extend `_CAMELOT` map to include Camelot codes as self-referential entries (not built) |
| Auto-DJ exhausts all candidates | Same fallback as today; Auto-DJ retries or stops per config |
| `djBpmTolerance` = 0 | Only exact BPM matches accepted — valid edge case |
| BPM Continuity ON but library has 0 % BPM coverage | No songs blocked (all NULL-permissive), Auto-DJ works normally |

### Test scenarios (Auto-DJ integration)

Plan scenarios. With the built soft scoring, 1–3 describe the server filter only (and
it is strict: NULL rows are not returned); the web player does not send these params.

1. **BPM filter** — current song 128 BPM, tolerance ±8 → server receives `bpmMin=120, bpmMax=136` → only songs with `bpm BETWEEN 120 AND 136` OR `bpm IS NULL` returned.
2. **Harmonic filter** — current song `"A minor"` (8A) → `musicalKeys = ['8A','8B','7A','7B','9A','9B']` sent to server → songs with those keys OR NULL returned.
3. **Both filters** — only songs matching BPM range AND key set (or NULL for either) returned.
4. **No BPM data yet** — all songs have `bpm IS NULL` → filter passes all → Auto-DJ unchanged.
5. **Toggle OFF** — when `S.djBpmContinuity = false`, no bpmMin/bpmMax sent → server ignores BPM.

---

---

# i18n Keys

All new user-visible strings use the existing `t()` / `this.t()` system. Add to **all 12 locale files** — en.json + nl.json with real translations, the other 10 with English placeholders.

After adding keys, run the locale sync script from `copilot-instructions.md` to verify and fill all 12 files.

**Built:** these keys are in `webapp/locales/en.json` (plus more added later, e.g. the
Camelot wheel `player.autodj.camelot*` keys).

### Admin keys

```json
// webapp/locales/en.json  (authoritative — add these)
"admin.nav.bpmWorkshop": "BPM & Key Analysis",
"admin.bpmAnalysis.title": "BPM & Key Analysis",
"admin.bpmAnalysis.desc": "Collects BPM and musical key for your library to enable BPM-continuity and harmonic mixing in Auto-DJ.",
"admin.bpmAnalysis.coverageTitle": "Library Coverage",
"admin.bpmAnalysis.coverageHasBpm": "Has BPM",
"admin.bpmAnalysis.coverageHasKey": "Has key",
"admin.bpmAnalysis.coverageSource": "Source — Tags: {{tags}}  AcousticBrainz: {{ab}}  Essentia: {{essentia}}",
"admin.bpmAnalysis.abTitle": "Step 1 — AcousticBrainz API",
"admin.bpmAnalysis.abDesc": "Queries AcousticBrainz for your MBID-matched files at 1 req/s. Zero CPU — runs in the background.",
"admin.bpmAnalysis.abPrereqNoMbids": "No MBID-matched files found. Run AcoustID fingerprinting first.",
"admin.bpmAnalysis.abPrereqAllDone": "All {{total}} eligible files have already been looked up.",
"admin.bpmAnalysis.btnStart": "Start",
"admin.bpmAnalysis.btnStop": "Stop",
"admin.bpmAnalysis.btnStopping": "Stopping…",
"admin.bpmAnalysis.statusRunning": "Running",
"admin.bpmAnalysis.statusStopping": "Stopping",
"admin.bpmAnalysis.statusIdle": "Idle",
"admin.bpmAnalysis.statsTotal": "Total eligible",
"admin.bpmAnalysis.statsDone": "Done",
"admin.bpmAnalysis.statsNotFound": "Not found in AB",
"admin.bpmAnalysis.statsErrors": "Errors",
"admin.bpmAnalysis.statsQueued": "Queued",
"admin.bpmAnalysis.btnResetErrors": "Reset errors",
"admin.bpmAnalysis.msgResetErrors": "Reset {{count}} failed rows — re-queued",
"admin.bpmAnalysis.essentiaTitle": "Step 2 — Essentia Audio Analysis",
"admin.bpmAnalysis.essentiaDesc": "Analyses remaining files locally using Essentia (first 30 s each). CPU-intensive — stop and resume any time.",
"admin.bpmAnalysis.essentiaDownloadNote": "The Essentia binary (~15 MB) will be downloaded on first start.",
"admin.bpmAnalysis.resetAllBtn": "Reset all BPM data",
"admin.bpmAnalysis.resetAllConfirm": "This will clear all BPM and key data from your entire library and reset all worker progress. Are you sure?",
"admin.bpmAnalysis.msgResetAll": "Reset {{count}} files — all BPM data cleared",
"admin.bpmAnalysis.msgStarted": "Worker started",
"admin.bpmAnalysis.msgStopping": "Stopping after current file…"
```

```json
// webapp/locales/nl.json  (Dutch — add these)
"admin.nav.bpmWorkshop": "BPM- en toonsoortanalyse",
"admin.bpmAnalysis.title": "BPM- en toonsoortanalyse",
"admin.bpmAnalysis.desc": "Verzamelt BPM en toonsoort voor je bibliotheek zodat Auto-DJ op tempo en harmonie kan mixen.",
"admin.bpmAnalysis.coverageTitle": "Bibliotheekdekking",
"admin.bpmAnalysis.coverageHasBpm": "Heeft BPM",
"admin.bpmAnalysis.coverageHasKey": "Heeft toonsoort",
"admin.bpmAnalysis.coverageSource": "Bron — Tags: {{tags}}  AcousticBrainz: {{ab}}  Essentia: {{essentia}}",
"admin.bpmAnalysis.abTitle": "Stap 1 — AcousticBrainz API",
"admin.bpmAnalysis.abDesc": "Vraagt AcousticBrainz op voor je MBID-bestanden (1 verzoek/s). Geen CPU-belasting — draait op de achtergrond.",
"admin.bpmAnalysis.abPrereqNoMbids": "Geen MBID-bestanden gevonden. Voer eerst de AcoustID-fingerprinter uit.",
"admin.bpmAnalysis.abPrereqAllDone": "Alle {{total}} geschikte bestanden zijn al opgezocht.",
"admin.bpmAnalysis.btnStart": "Starten",
"admin.bpmAnalysis.btnStop": "Stoppen",
"admin.bpmAnalysis.btnStopping": "Bezig met stoppen…",
"admin.bpmAnalysis.statusRunning": "Actief",
"admin.bpmAnalysis.statusStopping": "Bezig met stoppen",
"admin.bpmAnalysis.statusIdle": "Inactief",
"admin.bpmAnalysis.statsTotal": "Totaal geschikt",
"admin.bpmAnalysis.statsDone": "Klaar",
"admin.bpmAnalysis.statsNotFound": "Niet gevonden in AB",
"admin.bpmAnalysis.statsErrors": "Fouten",
"admin.bpmAnalysis.statsQueued": "In wachtrij",
"admin.bpmAnalysis.btnResetErrors": "Fouten resetten",
"admin.bpmAnalysis.msgResetErrors": "{{count}} mislukte rijen gereset — opnieuw in wachtrij",
"admin.bpmAnalysis.essentiaTitle": "Stap 2 — Essentia-audioanalyse",
"admin.bpmAnalysis.essentiaDesc": "Analyseert overgebleven bestanden lokaal met Essentia (eerste 30 s per bestand). CPU-intensief — stop en hervat wanneer je wilt.",
"admin.bpmAnalysis.essentiaDownloadNote": "Het Essentia-programma (~15 MB) wordt bij de eerste start gedownload.",
"admin.bpmAnalysis.resetAllBtn": "Alle BPM-data resetten",
"admin.bpmAnalysis.resetAllConfirm": "Dit wist alle BPM- en toonsoortdata uit je bibliotheek en reset alle werkvoortgang. Weet je het zeker?",
"admin.bpmAnalysis.msgResetAll": "{{count}} bestanden gereset — alle BPM-data gewist",
"admin.bpmAnalysis.msgStarted": "Worker gestart",
"admin.bpmAnalysis.msgStopping": "Bezig met stoppen na huidig bestand…"
```

### Player Auto-DJ keys

```json
// en.json
"player.autodj.bpmContinuity": "BPM Continuity",
"player.autodj.bpmTolerance": "BPM Tolerance: ±{{n}}",
"player.autodj.harmonicMixing": "Harmonic Mixing"

// nl.json
"player.autodj.bpmContinuity": "BPM-continuïteit",
"player.autodj.bpmTolerance": "BPM-tolerantie: ±{{n}}",
"player.autodj.harmonicMixing": "Harmonisch mixen"
```

Other 10 locales (`de`, `fr`, `es`, `it`, `pt`, `pl`, `ru`, `zh`, `ja`, `ko`) receive the English value as placeholder via the sync script.

---

---

# Data Flow Summary

```
(As built.)

TIER 1 (passive — during every library scan)
  src/db/scanner.mjs
    → music-metadata common.bpm + common.key
    → validate (20–300, ≤ 12 chars)
    → changed file: keep old analysed value if the tag is empty (_preserveBpm)
    → files.bpm, files.musical_key, files.bpm_source='tag'

TIER 0 (worker — auto-starts or admin Start)
  src/util/ab-bpm-worker.mjs
    → GET acousticbrainz.org/api/v1/<mbid>/low-level
    → parse rhythm.bpm + tonal.key_key + tonal.key_scale
    → validate → UPDATE bpm, musical_key, bpm_source='acousticbrainz', ab_status='done'
    → 404 → ab_status='not_found'  (Tier 2 eligible)
    → error → ab_status='error'  (retried on the next batch; reset-able)

TIER 2 (worker — auto-starts or admin Start, CPU-intensive)
  src/util/essentia-bpm-worker.mjs
    → ffmpeg decode → mono 22,050 Hz PCM (60 s window from the middle by default)
    → essentia.js RhythmExtractor2013 + KeyExtractor
    → validate → UPDATE bpm, musical_key, bpm_source='essentia', bpm_status='done'
    → error → bpm_status='error'  (reset-able)

AUTO-DJ (web player)
  webapp/app.js
    → Player.playAt(): read song.bpm + song.musical_key
    → toCamelot() + camelotNeighbours() → _currentNeighbours
    → POST /api/v1/db/random-songs { returnAll: true } → candidate pool
    → _djScoreSong(): soft BPM + harmonic score (no hard filter)

AUTO-DJ (rooms / other clients)
  src/autodj/scoring.js scoreSong() on the server
```

---

# File Change Summary

As built (names corrected to the real code):

| File | Change | Tiers |
|------|--------|-------|
| `src/db/sqlite-backend.js` | Migration: 6 columns (incl. `bpm_raw`); `_appendBpmKeyFilters()` used by `getRandomSongs()` etc.; `getBpmStats()`, `resetAbErrors()`, `resetAbNotFound()`, `resetEssentiaErrors()`, `resetAllBpmData()`, `genreCorrectBpm*()` | 0+1+2 |
| `src/api/db.js` | `renderMetadataObj()` exposes `bpm` + `musical-key`; random-songs BPM/key params | 1 |
| `src/db/scanner.mjs` | Extract + validate bpm and key from music-metadata | 1 |
| `src/util/ab-bpm-worker.mjs` | NEW — AcousticBrainz API worker thread | 0 |
| `src/util/essentia-bootstrap.js` | Not built (WASM needs no binary) | 2 |
| `src/util/essentia-bpm-worker.mjs` | NEW — Essentia (WASM) analysis worker thread | 2 |
| `src/util/camelot.js` | Server Camelot map + `toCamelot()` + `camelotCompat()` | Auto-DJ |
| `src/api/bpm-analysis.js` | NEW — REST endpoints for both workers | 0+2 |
| `src/server.js` | Calls `bpmAnalysisApi.setup(velvet)` | 0+2 |
| `webapp/app.js` | `_CAMELOT` table + helpers; `_djScoreSong()` BPM+key scoring; `Player.playAt()` current track state; Auto-DJ panel toggles+slider | Auto-DJ |
| `src/autodj/scoring.js` | Server-side `scoreSong()` + `camelotNeighbours()` for rooms | Auto-DJ |
| `webapp/admin/index.js` | `bpm-workshop-view` component | 0+2 |
| `webapp/admin/index.html` | Side-nav item for `bpm-workshop-view` | 0+2 |
| `webapp/locales/*.json` | `admin.bpmAnalysis.*` + `player.autodj.*` keys | all |
| `package.json` | `essentia.js` dependency | 2 |
| `docs/bpm-harmonic.md` | User-facing feature docs (plan name was `docs/harmonic-mixing.md`) | all |

---

# Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| `musical_key` stored as `"C major"` string | Essentia and AB both output standard notation. Camelot conversion at read time — no lossy conversion at write time. Also displayable in UI as-is. |
| BPM as `INTEGER` | Sub-BPM precision is noise for DJ filtering. `Math.round()` on write. (Built: tags and AB round; Essentia keeps one decimal.) |
| NULL-permissive SQL filter | Songs without BPM/key data always remain in the Auto-DJ pool. Library never runs dry. (Built: the web player gets this by soft scoring; the SQL filter itself is strict.) |
| First 30 s for Essentia | 90 % accuracy at 10 % of CPU time. Sufficient for DJ tempo and key detection. (Built: 60 s window from the middle, `scanOptions.analyzeBpmWindowSec`.) |
| `key_temperley` for Essentia output | Best-validated algorithm for Western pop/electronic/dance music. (Built: essentia.js `KeyExtractor` with its defaults.) |
| Separate `ab_status` and `bpm_status` columns | Independent reset per source. If AB goes offline: reset ab_status='error' rows → Tier 2 picks up without a full library reset. |
| `bpm_source` column | Diagnostic: "how many files from tags vs AB vs Essentia?". Useful for admin coverage card. |
| AB overwrites tag values | AcousticBrainz = Essentia-quality data. More reliable than user-entered tags. COALESCE in scanner ensures this priority. |
| Workers are opt-in (admin clicks Start) | CPU-intensive analysis must not auto-start on a live server with users. AB worker follows the same deferred-autostart pattern as rg-analysis (60 s delay, only if queued > 0). |
| Essentia Tier 2 is never auto-started | Always explicit. Downloading 15 MB binary should not happen without user intent. |

**Built differently:** both workers auto-start, 90 s after boot and after every file
scan, via `createWorkerController()` in `src/util/worker-controller.js`. Auto-start only
runs when 1–499 files are queued (a bigger backlog must be started from Admin) and when
`workerAutostart["bpm-ab"]` / `workerAutostart["bpm-essentia"]` in the config is not `false`.

---

## References

- Essentia extractor docs: https://essentia.upf.edu/streaming_extractor_music.html
- Essentia prebuilt binaries: https://essentia.upf.edu/documentation/extractors/
- AcousticBrainz API: https://acousticbrainz.org/api (CC0 data — BPM+key by MBID)
- AcousticBrainz dump: https://data.metabrainz.org/pub/musicbrainz/acousticbrainz/dumps/ (590 GB compressed — not recommended)
- Camelot Wheel JS reference: https://github.com/regorxxx/Camelot-Wheel-Notation (MIT)
- Existing worker pattern references: `src/util/mb-enrich-worker.mjs`, `src/util/rg-analysis-worker.mjs`, `src/api/rg-analysis.js`, `src/util/worker-controller.js`
