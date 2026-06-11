# BPM & Harmonic Mixing

Velvet collects BPM and musical key data for your library and uses it to enable tempo-continuous and harmonically-compatible song selection in Auto-DJ.

---

## How BPM and key data is collected

Three tiers run independently. Each fills in data the previous tier did not cover.

| Tier | Source | CPU cost | Expected coverage |
|------|--------|----------|-------------------|
| **Tier 1** | Embedded file tags (passive — no action needed, runs during normal library scan) | Zero | ~3 % BPM / ~1 % key |
| **Tier 0** | AcousticBrainz online API (requires MBID-matched files from AcoustID) | Zero | ~68 % of MBID files |
| **Tier 2** | Essentia local audio analysis | High (background) | 100 % fallback — not yet implemented |

**Recommended order:** Tier 1 is passive. Run Tier 0 overnight — it contacts AcousticBrainz at 1 req/s and requires no CPU. Tier 2 will fill the rest when implemented.

---

## BPM & Key Analysis panel (Admin)

Go to **Admin → BPM & Key Analysis**.

### Library Coverage

Two progress bars show what percentage of your library currently has BPM and musical key data, with a breakdown by source (Tags / AcousticBrainz / Essentia).

### Step 1 — AcousticBrainz API

AcousticBrainz holds pre-computed BPM and key for millions of MusicBrainz-identified recordings. Velvet queries it for all files that have been fingerprinted by the AcoustID worker.

- **Start**: launches a background worker thread. Rate-limited to 1 request/second to respect the AcousticBrainz API.
- **Stop**: gracefully stops after the current file. Progress is preserved — resume any time.
- **Reset errors**: re-queues any files that returned a network/parse error on a previous run.
- **Auto-start**: 90 seconds after server boot, the worker starts automatically if there are files queued — no manual action needed after a server restart.

If a file's MBID is not found in AcousticBrainz (`404`), it is marked `not_found` and skipped. These will be handled by Tier 2 (Essentia) when available.

### Step 2 — Essentia Audio Analysis

Not yet implemented. Will analyse remaining files locally using the Essentia `streaming_extractor_music` binary (first 30 s per file). Coming in a future update.

### Reset all BPM data

Clears all collected BPM and key data from your library and resets all worker progress. A confirmation step is required. Cannot be used while either worker is running.

---

## Auto-DJ — BPM Continuity & Harmonic Mixing

Open the **Auto-DJ panel** (▶▶ button or via the queue panel) to enable the new options.

### BPM Continuity

When enabled, only songs that **have BPM data AND fall within ±N BPM** of the session anchor (see below) are selected. Songs without BPM data are always **excluded** — the server requires `f.bpm IS NOT NULL` when this feature is on.

- **BPM Tolerance** slider (shown when BPM Continuity is on): range 1–20 BPM, default ±8. Higher values allow more tempo variation; lower values enforce strict tempo matching.

#### BPM octave equivalence

A song at 145 BPM and a song at 72.5 BPM are the same tempo at different octave doublings — they feel identical to mix. Velvet automatically treats these as compatible.

When a BPM anchor is set, Auto-DJ checks **three windows at once**:

| Window | Range | Tolerance scaling |
|--------|-------|------------------|
| Normal (1×) | `anchor ± tol` | as set |
| Half-time (½×) | `anchor/2 ± tol/2` | halved |
| Double-time (2×) | `anchor×2 ± tol×2` | doubled |

A song is accepted if its BPM falls in **any** of the three windows. Tolerance scales proportionally so a ±8 BPM window at 140 BPM becomes ±4 at 70 BPM and ±16 at 280 BPM — keeping the relative tightness consistent.

> **Example:** anchor 145 BPM, tolerance ±8 → accepts 137–153 BPM (normal), 68.5–76.5 BPM (half-time), or 274–306 BPM (double-time).

This is always active when BPM Continuity is on — no separate setting is needed.

### Harmonic Mixing

When enabled, only songs that **have musical key data AND whose key is harmonically compatible** with the session anchor are selected. Songs without key data are always **excluded** — the server requires `f.musical_key IS NOT NULL` when this feature is on.

Compatible keys for a track at Camelot position NX are:
- **Same number, both modes**: NA and NB (e.g. 8A ↔ 8B — relative major/minor, same feel)
- **One step clockwise (dominant)**: (N+1)A and (N+1)B
- **One step counter-clockwise (subdominant)**: (N−1)A and (N−1)B

This gives **6 compatible Camelot slots** per track. Keys are stored as long-form names (`A minor`, `C major`, `F# major`, `A# major`, etc.) and expanded to all matching raw key names before the SQL query.

> **Example:** anchor 8A (A minor) → compatible: 7A (D minor), 7B (F major), 8A (A minor), 8B (C major), 9A (E minor), 9B (G major).

---

## Session anchors — how drift is prevented

### The problem without anchors

Without a fixed reference point, BPM and key filtering would drift across the session:

| Song | BPM | Reference | Range used |
|------|-----|-----------|------------|
| 1 | 112 | current song (112) | 104–120 |
| 2 | 120 | current song (120) | 112–128 |
| 3 | 128 | current song (128) | 120–136 |
| 4 | 136 | current song (136) | 128–144 |

Starting at 112, you would be at 144 BPM after just four tracks — a completely different feel — without the listener changing any setting.

The same drift happens with harmonic keys: each selected song becomes the new reference and the key zone shifts one step at a time around the Camelot Wheel.

### The anchor solution

When Auto-DJ makes its **first filtered selection** of the session, it locks a **BPM anchor** and a **Camelot anchor** to the starting song's values. Every subsequent selection is filtered against those locked anchor values — never against the current playing song.

| Song | BPM | Anchor | Range used |
|------|-----|--------|------------|
| 1 | 112 | **locked → 112** | 104–120 |
| 2 | 120 | 112 (unchanged) | 104–120 |
| 3 | 117 | 112 (unchanged) | 104–120 |
| 4 | 108 | 112 (unchanged) | 104–120 |

The BPM zone stays at 104–120 for the entire session regardless of which songs are chosen. The same applies to the key zone.

### Free-pick songs do not lock the anchor

When the session starts from a song that has **no BPM data**, Auto-DJ picks the next song freely (no BPM filter applied). That freely-picked song does **not** lock the BPM anchor — it would be arbitrary to anchor the entire session to a BPM that was never filtered against.

The anchor stays `null` until:
- The user manually plays a song that has BPM data (that song's BPM locks the anchor), or
- Auto-DJ picks a song that was meaningfully filtered (i.e. the pick was constrained by a BPM range because the current song already had BPM data).

This prevents a common frustration where the anchor would lock to a random disco track at 120 BPM just because it happened to be the first Auto-DJ pick of the session, forcing every subsequent song to match 120 BPM.

### What the status chip shows

The chip in the Now Playing label (visible when Auto-DJ is active) always shows the **anchor** value — for example `BPM 112 ±8` — not the current song's BPM. This is the zone the system is filtering against.

### When anchors reset

Anchors are intentionally reset in the following situations so the next DJ session starts fresh from the new context:

| Event | BPM anchor | Camelot anchor |
|-------|-----------|----------------|
| User manually plays a song (not Auto-DJ generated) | ✓ reset | ✓ reset |
| Auto-DJ is stopped | ✓ reset | ✓ reset |
| BPM Continuity is toggled off | ✓ reset | — |
| Harmonic Mixing is toggled off | — | ✓ reset |

After a reset the anchors are `null`. The next time Auto-DJ calls for a song and the feature is enabled, it locks fresh anchors to whatever song is playing at that moment.

---

## Combining BPM Continuity, Harmonic Mixing, and Similar Artists

All three Auto-DJ modes work together:

1. **Similar Artists** (requires Last.fm API key): fetches artists similar to the current track from Last.fm.
2. The server queries the DB for a random song from those artists **that also matches the anchor BPM range and/or Camelot key zone**.
3. The client applies a second check (`_djSongBlocked`) against the anchor values.
4. If no song passes within 3 attempts, the engine applies the server-side fallback chain (see below).

---

## Server-side fallback chain

When filters are active and reduce the candidate pool to zero, the server degrades gracefully through three tiers rather than failing with an error. The client retry limit is 3 attempts per tier.

| BPM On | Key On | Tier 1 tried first | Tier 2 if Tier 1 = 0 | Tier 3 if Tier 2 = 0 |
|--------|--------|-------------------|----------------------|----------------------|
| ✓ | ✓ | BPM range + Camelot key zone | BPM range only | Random |
| ✓ | ✗ | BPM range only | — | Random |
| ✗ | ✓ | Camelot key zone only | — | Random |
| ✗ | ✗ | Random | — | — |

**In each tier, the `ignoreArtists` cooldown is applied first.** If dropping the artist cooldown (but keeping BPM/key) yields results, that is used before degrading to the next tier.

The Similar Artists filter (if active) is also dropped before the artist cooldown, following the same pattern.

---

## Key format

Musical keys are stored in standard long-form notation: `C major`, `A minor`, `F# minor`, `A# major`, etc. Both flat and sharp enharmonic variants are stored and supported:

| Flat name | Sharp name | Camelot |
|-----------|------------|--------|
| `Ab minor` | `G# minor` | 1A |
| `Eb minor` | `D# minor` | 2A |
| `Bb minor` | `A# minor` | 3A |
| `Ab major` | `G# major` | 4B |
| `Eb major` | `D# major` | 5B |
| `Bb major` | `A# major` | 6B |

When harmonic mixing is active, the server expands Camelot codes to all matching raw key names before the SQL `IN (...)` clause — both flat and sharp variants are included. This is why `A# major` (667 songs), `G# major` (353), `D# major` (257), etc. are properly matched.

---

## API endpoints

All endpoints require an admin-level token (`x-access-token`).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/admin/bpm/status` | Combined coverage stats + worker status |
| `POST` | `/api/v1/admin/bpm/ab/start` | Start AcousticBrainz worker |
| `POST` | `/api/v1/admin/bpm/ab/stop` | Stop AcousticBrainz worker |
| `POST` | `/api/v1/admin/bpm/ab/reset-failed` | Reset `ab_status='error'` rows to NULL |
| `POST` | `/api/v1/admin/bpm/essentia/start` | HTTP 501 — not yet implemented |
| `POST` | `/api/v1/admin/bpm/essentia/stop` | No-op |
| `POST` | `/api/v1/admin/bpm/essentia/reset-failed` | Reset `bpm_status='error'` rows |
| `POST` | `/api/v1/admin/bpm/reset-all` | Clear all BPM data (409 if workers running) |

See also: [docs/acoustid.md](acoustid.md) for AcoustID fingerprinting (prerequisite for Tier 0).
