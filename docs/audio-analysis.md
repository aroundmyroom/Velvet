# Audio Analysis & Acoustic Similarity — Design Plan

This document describes the plan to add per-track audio analysis to Velvet, enabling acoustically-aware smart playlists and Auto-DJ improvements.

> **Status:** only part of this plan is built — Essentia BPM + musical-key analysis (see [Implementation Phases](#implementation-phases) and [BPM & Harmonic Mixing](bpm-harmonic.md)). Timbre (MFCC/HPCP), danceability, loudness features, the `audio_features` table and the "Build Similar Playlist" UI are **not** built. Sections 1–6 below are the original design, not a description of shipped code.

---

## Goal

A user selects a song and the system builds a playlist of up to 200 acoustically similar songs from the library — matching by tempo (BPM), musical key, timbre, and energy level. This is completely separate from Last.fm-based similar artists, which is based on listening history data. This is based purely on the actual audio content.

---

## What Essentia Can Do For Us

[Essentia](https://essentia.upf.edu) is a C++ music analysis library from the Music Technology Group (Universitat Pompeu Fabra, Barcelona). [Essentia.js](https://github.com/MTG/essentia.js) is its WebAssembly port, usable in both browsers and Node.js.

Relevant algorithms for our use case (all available in the WASM backend):

| Algorithm | Category | What it gives us |
|---|---|---|
| `RhythmExtractor2013` | Rhythm | BPM + beat positions + confidence |
| `Danceability` | Rhythm | Danceability score 0–3 (higher = more danceable) |
| `KeyExtractor` | Tonal | Key (e.g. "C") + scale ("major"/"minor") + keyStrength |
| `HPCP` | Tonal | Harmonic Pitch Class Profile — 12-dim vector, harmonic fingerprint |
| `MFCC` | Spectral | 13 cepstral coefficients per frame — encode timbral character |
| `SpectralContrast` | Spectral | Spectral contrast bands — distinguishes acoustic vs electronic |
| `LoudnessEBUR128` | Loudness | Integrated loudness, true peak |
| `DynamicComplexity` | Loudness | How dynamic the track is (compression level) |

The WASM backend **cannot decode audio files itself** — it processes raw PCM float arrays. This is fine for us: we already use FFmpeg to decode audio to raw PCM for waveform generation. We can reuse that same pipeline.

---

## Why Not Use an External Service?

| Service | Notes | Why not |
|---|---|---|
| Spotify Audio Features API | BPM, key, energy, danceability | You cannot fetch features for tracks not in Spotify's catalogue; requires OAuth; your private FLAC library is not indexed by Spotify |
| AcousticBrainz | Similar feature set | Stopped collecting new data in 2022; existing data is still served and Velvet uses it for BPM/key only (Tier 0, see [bpm-harmonic.md](bpm-harmonic.md)) |
| AudD | Recognition + features | Paid; fingerprinting-based, doesn't cover all tracks |
| DIY with Essentia | Full access, runs offline | Our choice |

Essentia runs entirely on your server. No API keys, no network calls, no catalogue coverage problems.

---

## Essentia.js License

Essentia.js is licensed under **AGPL v3**. This project is already distributed as source under GPL-3.0, so the compliance requirement is to keep the corresponding source and license notice available wherever this feature is shipped. For a personal self-hosted server, this is still fine; for packaged releases, keep the AGPL notice with the release artifacts.

---

## Architecture (original design — not built as written)

What was actually built is a worker thread, `src/util/essentia-bpm-worker.mjs`, that writes `bpm` and `musical_key` straight into the `files` table. There is no `src/db/audio-analyzer.mjs` and no `audio_features` table.

### 1. Analysis Script — `src/db/audio-analyzer.mjs` (not built)

A standalone Node.js script (same pattern as `scanner.mjs`) that:

1. Loads the Essentia WASM module once
2. Enumerates all tracks in the DB that do **not** yet have a `audio_features` row
3. For each unanalysed track:
   - Decodes audio to raw PCM (22050 Hz, mono) via FFmpeg pipe — same as waveform generation
   - Runs the PCM through Essentia algorithms frame-by-frame
   - Computes aggregate features (mean MFCC, mean HPCP, BPM, key, energy, danceability)
   - Writes a row to `audio_features` table keyed by file `hash`
4. On completion of each batch, reports progress back to the server via a callback (same pattern as scanner)
5. Can be interrupted and resumed at any time — tracks already in `audio_features` are skipped

**Processing rate estimate:** On a modern x86 server, Essentia analysis runs at approximately 5–30× real-time for a full feature set. For a 3-minute song: roughly 10–30 seconds. For 130,000 tracks: roughly 1 week at the low end. This is fine per the requirement.

### 2. Database Schema (not built)

Planned table, created with a migration-safe `CREATE TABLE IF NOT EXISTS`:

```sql
CREATE TABLE IF NOT EXISTS audio_features (
  hash        TEXT PRIMARY KEY,
  bpm         REAL,
  bpm_confidence REAL,
  key_name    TEXT,           -- e.g. "C"
  key_scale   TEXT,           -- "major" | "minor"
  key_strength REAL,          -- 0..1
  danceability REAL,          -- 0..3
  loudness    REAL,           -- LUFS (EBU R128 integrated)
  dynamic_complexity REAL,
  mfcc_mean   TEXT,           -- JSON array of 13 floats
  hpcp_mean   TEXT,           -- JSON array of 12 floats
  analyzed_at INTEGER         -- Unix timestamp
);
```

**Why store MFCC and HPCP as JSON strings?** SQLite has no native array type. The vectors are small (13 and 12 floats respectively) — serialising as JSON adds ~200 bytes per track and avoids a separate table or blob encoding.

### 3. Similarity Computation (planned scoring — not built)

What is built instead is `getSimilarSongs(hash, limit)` in `src/db/sqlite-backend.js`: it reads `bpm` and `musical_key` from `files`, takes up to 2000 candidates inside a BPM window of ±10 % (at least ±5 BPM), and scores them by BPM proximity plus Camelot key compatibility (same key +2, adjacent key +1). No timbre, danceability or loudness.

Given a seed track (song A), find the N most similar songs in the library:

**Scoring function** (weighted sum of normalised distances):

```
score = w_bpm   × bpm_score(A, B)
      + w_key   × key_score(A, B)
      + w_mfcc  × cosine_similarity(A.mfcc_mean, B.mfcc_mean)
      + w_hpcp  × cosine_similarity(A.hpcp_mean, B.hpcp_mean)
      + w_dance × (1 - |A.danceability - B.danceability| / 3)
      + w_loud  × (1 - |A.loudness - B.loudness| / 20)   -- capped at 20 LUFS diff

-- Default weights (tunable per user):
w_bpm   = 0.25
w_key   = 0.20
w_mfcc  = 0.30   -- timbre is the strongest "sounds like" signal
w_hpcp  = 0.10
w_dance = 0.10
w_loud  = 0.05
```

**BPM score**: `1 - min(|A.bpm - B.bpm|, |A.bpm - 2×B.bpm|, |2×A.bpm - B.bpm|) / A.bpm`
Half/double tempo is considered compatible (a 120 BPM track fits a 60 BPM playlist).

**Key score**: Based on the Circle of Fifths distance. Same key = 1.0; adjacent key = 0.9; relative major/minor = 0.8; two steps away = 0.5; opposite = 0.0. This implements a lightweight version of the Camelot Wheel concept.

**Cosine similarity**: Standard dot-product / (|A| × |B|). Both MFCC and HPCP vectors are unit-normalised before storage to make this a single dot product at query time.

**Performance on 130K tracks**: Loading all 130K feature rows (~40–80 MB of JSON), deserialising MFCC/HPCP vectors, and computing cosine similarity for each pair takes roughly 2–5 seconds in Node.js. This is acceptable for an on-demand "build playlist" action. For real-time Auto-DJ (needs a result immediately), a pre-built nearest-neighbour index or a faster pre-filter (BPM range + key group) reduces the candidate set to ~100–500 before running the full similarity computation.

### 4. API Endpoints

Built:

```
GET  /api/v1/db/similar?hash=<32-char hex>&limit=<1–200, default 50>
  → [track objects sorted by BPM/key score, highest first]
     (filtered to the user's folders; 400 if hash is not a 32-char hex MD5)
```

Worker start/stop is done with the BPM endpoints (`/api/v1/admin/bpm/essentia/start`, `/stop`, `/reset-failed` and `GET /api/v1/admin/bpm/status`) — see [bpm-harmonic.md](bpm-harmonic.md#api-endpoints).

Planned, not built: a `seed_weight=timbre|rhythm|mixed` parameter on `/db/similar`, and separate `/api/v1/admin/audio-analysis/start|status|stop` endpoints. A `GET /api/v1/db/audio-features/:hash` route existed for a while but was removed together with the unused `audio_features` table.

### 5. Admin Panel Integration (built differently)

Built as **Admin → BPM & Key Analysis → Step 2 — Essentia Audio Analysis** (queued count, Start/Stop, "Re-queue skipped"). The original design below had more:

- Shows analysis progress bar: `X / Y tracks analysed (Z%)`
- **Start Analysis** button — starts the background job if not already running
- **Stop** button — interrupts the current run gracefully (it stores progress per track, so resuming picks up where it left off)
- Settings: throttle (concurrent jobs = 1; add inter-track sleep ms for low-power servers)
- Info text: "Analysis processes one track at a time. A library of 130,000 songs may take several days. The server remains fully usable during analysis."

### 6. Player UI Integration (not built)

The player does not call `/api/v1/db/similar`. BPM and key are shown in the Now Playing line of the queue panel (e.g. `128 BPM · A minor (8A)`), and Auto-DJ uses them as scoring signals (BPM Continuity, Harmonic Mixing — see [bpm-harmonic.md](bpm-harmonic.md)). Everything below is still a plan.

**"Similar Songs" playlist builder (Now Playing modal):**
- New "≈ Build Similar Playlist" button in the Now Playing modal (only visible when the current track has audio features)
- Opens a small options sheet: seed strength radio (timbre / rhythm / mixed), length (50 / 100 / 200), vpath filter pills
- Sends `GET /api/v1/db/similar?hash=…&limit=…` and inserts results into the queue

**Auto-DJ: new "Acoustic" mode:**
- Adds a fourth Auto-DJ mode alongside Random, Similar Artists, Last Played
- Picks the next song based on similarity to the current track
- Uses a lightweight fast path (BPM ± 10% + compatible key pre-filter → full cosine on the ~500 candidate set)

**Song detail display:**
- If `audio_features` row exists, show BPM, key, and danceability below the track title in the Now Playing modal
- Displayed as: `♩ 124 BPM  •  A minor  •  ⚡ 78% danceable`

---

## Implementation Phases

### Phase 1 — Backend Core (BPM + key only) ✅ Built
- ✅ `src/util/essentia-bpm-worker.mjs` — worker thread: FFmpeg decodes to mono 22050 Hz PCM → Essentia WASM (`RhythmExtractor2013` + `KeyExtractor`) → `UPDATE files SET bpm, musical_key, bpm_source='essentia'`. Queue: files where `(bpm IS NULL OR musical_key IS NULL) AND bpm_status IS NULL`. Only a window of `scanOptions.analyzeBpmWindowSec` seconds (default 60, `0` = whole file) from the middle of the track is decoded. Files longer than 20 minutes are skipped; files that fail are marked `bpm_status='error'` and are only retried after "Re-queue skipped" (`/essentia/reset-failed`).
- ✅ Worker lifecycle through `src/util/worker-controller.js` (name `bpm-essentia`): paused during file scans, auto-started after each scan (see [bpm-harmonic.md](bpm-harmonic.md#background-worker-behaviour)), Stop force-terminates after 120 s.
- ✅ `getSimilarSongs(hash, limit)` — BPM proximity + Camelot key compatibility, reading `files.bpm` / `files.musical_key`
- ✅ `GET /api/v1/db/similar?hash=&limit=` — similar tracks endpoint (no UI uses it yet)
- ✅ `POST /api/v1/admin/bpm/essentia/start` / `stop` / `reset-failed`
- ✅ Octave correction of doubled tempos — see [bpm-plan.md](bpm-plan.md)
- ✗ `audio_features` table, `saveAudioFeatures()` / `getAudioFeatures()` and `GET /api/v1/db/audio-features/:hash` — added early, never filled by any worker, then removed.
- **Dependency**: `essentia.js` ^0.1.3 (AGPL v3, runs on Node 24)

### Phase 2 — Admin UI
- ✅ Essentia start/stop and progress in **Admin → BPM & Key Analysis** (Step 2)
- [ ] Per-track `analyzed_at` visible in the scan error detail (so you can tell which files were skipped)

### Phase 3 — Player UI
- [ ] "Build Similar Playlist" button + options sheet in Now Playing modal
- ✅ BPM and key shown in the queue panel's Now Playing line (danceability: not built)
- [ ] Auto-DJ: "Acoustic" mode (Auto-DJ already scores BPM and key — see [bpm-harmonic.md](bpm-harmonic.md))

### Phase 4 — Tuning (optional, post-launch)
- [ ] User-adjustable similarity weighting sliders in player Settings panel
- [ ] Pre-built nearest-neighbour index (ANN) for sub-100ms similar-song lookup at scale
- Subsonic `getSimilarSongs` / `getSimilarSongs2` no longer return empty: they return a radio chain built by the server-side Auto-DJ (`src/autodj/radio.js`), with Last.fm `track.getSimilar` as fallback. They do not use `getSimilarSongs()` from this plan.

---

## Technical Constraints & Risks

| Risk | Mitigation |
|---|---|
| Essentia.js WASM build is large (~5–8 MB) | Loaded only in the worker thread, not in the main server thread |
| AGPL license | Personal self-hosted use is fine; document if distributing |
| Essentia.js not actively maintained since 2021 | Pinned to `^0.1.3`; WASM builds are self-contained |
| Node.js WASM compatibility | Resolved: runs on Node 24 |
| Memory pressure on Raspberry Pi / low-RAM VPS | One file at a time; only a 60 s window is decoded by default; decoded PCM over 60 MB is retried at 11025 Hz, and marked as error if still too large |
| Analysis quality for electronic music | MFCC is best for timbre; for pure BPM-based matching, `RhythmExtractor2013` is state-of-the-art |

---

## Fallback: Pure-Node.js Implementation (not needed — Essentia.js works)

If Essentia.js WASM had been incompatible with Node or too heavy, all required features can be implemented in ~600 lines of pure Node.js mathematics (FFT via standard library + typed arrays):

- **BPM**: Autocorrelation of onset strength signal (standard MIR)
- **Key**: Krumhansl-Schmuckler profile correlation against 24 major/minor templates
- **Timbre**: 13-coefficient MFCC from mel-filter-bank → DCT (DCT is in Node.js stdlib via `crypto` / can be written as a 13-line matrix multiply)

This avoids all external dependencies. Decision point: try Essentia.js first; implement pure-JS if it fails.

---

## References

- Essentia C++ algorithms reference: https://essentia.upf.edu/algorithms_reference.html
- Essentia.js GitHub: https://github.com/MTG/essentia.js
- Krumhansl-Schmuckler key detection: Krumhansl 1990, "Cognitive Foundations of Musical Pitch"
- Camelot Wheel / harmonic mixing: https://mixedinkey.com/camelot-wheel
