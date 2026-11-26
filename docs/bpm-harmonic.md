# BPM & Harmonic Mixing

Velvet collects BPM and musical key data for your library and uses it in Auto-DJ to keep the tempo steady and to prefer harmonically compatible songs.

---

## How BPM and key data is collected

Three sources fill the same `bpm` / `musical_key` columns of the `files` table. Each one only adds what the others did not cover.

| Tier | Source | CPU cost | Notes |
|------|--------|----------|-------|
| **Tier 1** | Embedded file tags (passive — read during the normal library scan) | Zero | Stored with `bpm_source = 'tag'` |
| **Tier 0** | AcousticBrainz online API (needs a MusicBrainz recording ID from the AcoustID worker) | Zero | Stored with `bpm_source = 'acousticbrainz'` |
| **Tier 2** | Essentia local audio analysis (Essentia.js WASM in a worker thread) | High (background) | Fallback for every file still missing BPM or key; `bpm_source = 'essentia'` |

**Recommended order:** Tier 1 is passive. Run Tier 0 first — it only makes network requests (about 3 per second) and uses no CPU. Tier 2 then fills the rest.

---

## BPM & Key Analysis panel (Admin)

Go to **Admin → BPM & Key Analysis**.

### Library Coverage

Two progress bars show what share of your library has BPM and musical key data, with a breakdown by source (Tags / AcousticBrainz / Essentia).

### Step 1 — AcousticBrainz API

AcousticBrainz holds pre-computed BPM and key for many MusicBrainz recordings. Velvet queries `https://acousticbrainz.org/api/v1/<mbid>/low-level` for every file that AcoustID matched (`acoustid_status = 'found'` and an MBID). If there are no such files the panel tells you to run [AcoustID](acoustid.md) first.

- **Start**: launches the `bpm-ab` worker thread. It waits 350 ms between requests (about 2.8 per second) and backs off 5 s once on HTTP 429.
- **Stop**: stops after the current file (force-terminated after 60 s). Progress is kept — resume any time.
- **Reset errors**: clears `ab_status = 'error'` so those files are tried again.
- **Recheck not-found**: re-queues files where AcousticBrainz returned `404` (`ab_status = 'not_found'`). Only while the worker is stopped (409 otherwise).

A file whose MBID is not in AcousticBrainz is marked `not_found`. If it still has no BPM or key, Tier 2 (Essentia) picks it up.

### Step 2 — Essentia Audio Analysis

The `bpm-essentia` worker analyses files that still have no BPM or no key (`bpm_status IS NULL`) locally:

- FFmpeg decodes a window from the middle of the track to mono 22050 Hz PCM. The window length is `scanOptions.analyzeBpmWindowSec` (default 60 s; `0` = whole file).
- Essentia `RhythmExtractor2013` gives the BPM, `KeyExtractor` the key. Doubled tempos are halved at analysis time (see [bpm-plan.md](bpm-plan.md), Phase 3).
- Files longer than 20 minutes are skipped (marked as error) — they are usually DJ mixes. If the decoded audio is over 60 MB the file is decoded again at 11025 Hz; if it is still too large it is marked as error.
- Error/skipped files are not retried until you press **Re-queue skipped** (clears `bpm_status = 'error'`).
- **Stop** stops after the current file (force-terminated after 120 s).

### Step 3 — Genre-Based Octave Correction

Corrects doubled or halved Essentia BPM values using the genre tag (only `bpm_source = 'essentia'` rows). Run **Dry Run (preview)** first, pick the rows to change, then apply them; **Undo genre correction** restores the original values. See [bpm-plan.md](bpm-plan.md), Phase 2 for the genre windows. Not available while the Essentia worker runs (409).

### Reset all BPM data

Clears all BPM and key data (from every source, including tags) and resets AcousticBrainz/Essentia progress. A confirmation step is required. Not possible while either worker is running (409).

### Background worker behaviour

Both workers (`bpm-ab`, `bpm-essentia`) run through the shared worker controller (`src/util/worker-controller.js`):

- 90 seconds after server boot, each worker starts on its own if it has queued files.
- They pause while a library file scan runs and resume when it ends. After every scan they auto-start (staggered 5 s apart with the other background workers) if they have queued work.
- Auto-start is skipped when 500 or more files are queued — start the worker from Admin then.
- **Stop** saves `workerAutostart.bpm-ab` / `workerAutostart.bpm-essentia = false` to the config file, so the worker no longer starts on its own; **Start** sets it back to `true`. See [json_config.md](json_config.md#background-workers-workerautostart).
- **Start** during a scan returns `status: "pending"` and the worker launches when the scan ends.

---

## Auto-DJ — BPM Continuity & Harmonic Mixing

Open the **Auto-DJ** settings in the player to find the options.

Auto-DJ asks the server for a batch of candidate songs (`POST /api/v1/db/random-songs` with `returnAll: true`). The server only applies the hard scope: selected collections, minimum rating, track-length window, the similar-artist list and the artist cooldown. BPM and key are **not** hard filters: the player scores every candidate and plays the one with the highest score. The only hard block on the client is the keyword filter. Songs without BPM or key data are not excluded — they get a neutral score for that signal.

Scoring weights (`_djScoreSong` in `webapp/app.js`):

| Signal | Weight | Notes |
|--------|--------|-------|
| Similar artist (rank from the [similar-artists source](similar-artists.md)) | 0.35 | When there is no similar-artist data, this share is spread over BPM, genre and harmonic |
| BPM proximity | 0.25 | Full score inside ±tolerance, falling to 0 at ±2× tolerance |
| Genre | 0.13 | |
| Harmonic (Camelot) | 0.07 | Same key 1.0, adjacent 0.7, two steps 0.3 |
| Year/era | 0.10 | ±12 years |
| Artist diversity | 0.10 | Penalises artists played recently |

BPM and key are always part of the score. The two toggles change which BPM reference is used and what the status chip shows.

### BPM Continuity

- **BPM Tolerance** slider (shown when BPM Continuity is on): 1–20 BPM, default ±8.
- **Base BPM** (shown when BPM Continuity is on): a fixed BPM (20–300) to steer towards. Empty = "auto (follows session)".
- With BPM Continuity on, the BPM of each Auto-DJ song is added to a rolling history of the last 8 songs; the **anchor** is the rounded average of that history. Without a Base BPM, the BPM reference for scoring is `60 % current song + 40 % anchor`, so the tempo can move slowly but does not run away. With a Base BPM set, the base replaces the anchor and the history is not used.
- With BPM Continuity off, the history is cleared and only the current song's BPM is used as reference.

### Harmonic Mixing

Compatible keys for a track at Camelot position NX are:
- **Same number, both modes**: NA and NB (e.g. 8A ↔ 8B — relative major/minor)
- **One step clockwise**: (N+1)A and (N+1)B
- **One step counter-clockwise**: (N−1)A and (N−1)B

This gives **6 compatible Camelot slots** per track.

> **Example:** 8A (A minor) → compatible: 7A (D minor), 7B (F major), 8A (A minor), 8B (C major), 9A (E minor), 9B (G major).

The harmonic score always compares a candidate with the key of the **current** song. When Harmonic Mixing is on, the first Auto-DJ song with a key locks a **Camelot anchor**; that anchor is what the status chip shows. The **ⓘ** button next to the toggle opens a Camelot wheel reference.

---

## Session anchors

### Picks without BPM ("free picks")

When Auto-DJ picks a song that has no BPM, the pick is marked as free. A free pick adds nothing to the BPM or year history, and for the next pick the BPM reference is not blended (the current BPM, or else the anchor, is used on its own). Manually playing a song clears the flag.

### What the status chip shows

The chip in the Now Playing label (visible when Auto-DJ is on) shows `BPM <ref> ±<tol>` — the Base BPM (marked `base`), else the anchor, else the current song's BPM — and `♪ <Camelot code>` for the Camelot anchor (or the current song's key). A dash means there is no data yet.

### When anchors reset

| Event | BPM history/anchor | Camelot anchor |
|-------|-----------|----------------|
| User manually plays a song (not Auto-DJ generated) | ✓ reset | ✓ reset |
| Auto-DJ is stopped | ✓ reset | ✓ reset |
| BPM Continuity is toggled off | ✓ reset | — |
| A Base BPM is set | ✓ reset | — |
| Harmonic Mixing is toggled off | — | ✓ reset |

The BPM history and Camelot anchor are kept per user in `localStorage`, so they survive a page reload.

---

## Velvet Rooms and Music Assistant

A Velvet Room's Auto-DJ and the Subsonic `getSimilarSongs` radio (used by Music Assistant) run on the server in `src/autodj/` and use the same settings (BPM Continuity, Base BPM, tolerance) and the same kind of scoring.

---

## Key format

Musical keys are stored in long-form notation: `C major`, `A minor`, `F# minor`, `A# major`, etc. Flat and sharp spellings map to the same Camelot code:

| Flat name | Sharp name | Camelot |
|-----------|------------|--------|
| `Ab minor` | `G# minor` | 1A |
| `Eb minor` | `D# minor` | 2A |
| `Bb minor` | `A# minor` | 3A |
| `Ab major` | `G# major` | 4B |
| `Eb major` | `D# major` | 5B |
| `Bb major` | `A# major` | 6B |

---

## API endpoints

All endpoints require an admin token (`x-access-token`); others get 403.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/admin/bpm/status` | `{ ab, essentia, coverage }` — worker state, counts and coverage by source |
| `POST` | `/api/v1/admin/bpm/ab/start` | Start AcousticBrainz worker (`status: "pending"` during a scan) |
| `POST` | `/api/v1/admin/bpm/ab/stop` | Stop AcousticBrainz worker |
| `POST` | `/api/v1/admin/bpm/ab/reset-failed` | Reset `ab_status='error'` rows to NULL |
| `POST` | `/api/v1/admin/bpm/ab/reset-not-found` | Reset `ab_status='not_found'` rows to NULL (409 while running) |
| `POST` | `/api/v1/admin/bpm/essentia/start` | Start Essentia worker (`status: "pending"` during a scan) |
| `POST` | `/api/v1/admin/bpm/essentia/stop` | Stop Essentia worker |
| `POST` | `/api/v1/admin/bpm/essentia/reset-failed` | Reset `bpm_status='error'` rows to NULL |
| `POST` | `/api/v1/admin/bpm/reset-all` | Clear all BPM data (409 if a worker runs) |
| `POST` | `/api/v1/admin/bpm/genre-correct` | Genre octave correction; `?dryRun=true` previews without writing |
| `POST` | `/api/v1/admin/bpm/genre-correct-selected` | Apply chosen dry-run rows. Body: `{ corrections: [{ filepath, vpath, bpm, corrected }] }` |
| `POST` | `/api/v1/admin/bpm/genre-correct-undo` | Restore `bpm_raw` for all genre-corrected rows |

The three genre-correct endpoints return 409 while the Essentia worker runs.

See also: [acoustid.md](acoustid.md) for AcoustID fingerprinting (needed for Tier 0) and [audio-analysis.md](audio-analysis.md) for the wider audio-analysis plan.
