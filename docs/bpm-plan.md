# BPM Octave Correction — Implementation Plan

## The Problem

Essentia's `RhythmExtractor2013` suffers from classic **octave ambiguity**: it detects the correct
beat grid, but it sometimes picks the half-note pulse instead of the quarter-note pulse (or vice
versa). This yields 2× or ½× the perceptually correct tempo.

Examples from our DB (pre-correction):
- 75 BPM pop/disco track → stored as **150 BPM**
- 87 BPM slow soul track → stored as **174 BPM** (misread as DnB)
- 174 BPM DnB track → stored as **87 BPM** (misread as slow)

Scale (confirmed by DB query, May 2026):
- **16,058** essentia tracks stored at 130–170 BPM (likely doubled pop/funk/disco)
- **3,068** essentia tracks stored at 80–95 BPM (possibly halved DnB/techno)
- Total affected: ~19,000 of 62,131 essentia-analyzed tracks (~31%)

Genre coverage: **78%** of all tracks have a genre ID3 tag (104K of 134K).

---

## Root Cause: Auto-DJ Anchor Drift

The immediate user symptom is not just wrong BPM display — it's the Auto-DJ escalating toward
faster and faster music. This is caused by anchor drift:

```
Session start: user plays a 75 BPM song (correctly stored from tag)
→ anchor = 75
→ Auto-DJ picks a 150 BPM song (doubled, but passes matchDouble filter)
→ _bpmHistoryPush(150) → history = [75, 150] → anchor = 112
→ Auto-DJ now targets 112 BPM → picks songs at 110–120
→ those push 120 → anchor = 118 → targets 120–130 …
→ session escalates from 75 BPM feel to 128 BPM feel over ~8 songs
```

The `matchDouble` / `matchHalf` octave filter correctly *accepts* doubled songs for playback —
but the push to history was using the raw stored value, dragging the anchor.

---

## Three-Phase Fix

### Phase 1 — Auto-DJ Anchor Drift ✅ DONE

**File:** `webapp/app.js` — `_bpmHistoryPush()`

**What changes:** Before pushing a new BPM to the rolling 8-song history, snap it to the closest
octave relative to the existing anchor. If anchor=75 and incoming=150, push 75 instead.

```js
// Before (causes drift):
_bpmHistory.push(bpm);

// After (Phase 1):
let b = bpm;
if (_bpmAnchor != null) {
  const half   = bpm / 2;
  const double = bpm * 2;
  if (Math.abs(half   - _bpmAnchor) < Math.abs(b - _bpmAnchor)) b = half;
  if (Math.abs(double - _bpmAnchor) < Math.abs(b - _bpmAnchor)) b = double;
}
_bpmHistory.push(b);
```

**What it fixes:** The session anchor stays stable even when doubled/halved BPMs are in the DB.
**What it does NOT fix:** The stored BPM values themselves — `150` stays as `150` in the DB.

**Risk:** Zero. Client-side only. No DB changes. No server restart needed beyond normal deploy.

---

### Phase 2 — Genre-Matrix DB Correction (PLANNED)

**Goal:** Correct the ~19,000 wrongly-stored essentia BPM values in the DB using the genre tag.

#### Genre-Window Matrix

| Genre keywords (case-insensitive) | Family | Target window | Correction |
|---|---|---|---|
| `hip-hop`, `hip hop`, `rap`, `trap`, `r&b`, `rnb`, `soul`, `funk` | Hip-Hop / Soul | 60–115 BPM | if stored >115: halve; if stored <60: double |
| `reggae`, `dancehall`, `dub` | Reggae | 60–105 BPM | if stored >105: halve |
| `house`, `euro house`, `euro-house`, `eurodance`, `dance`, `club`, `trance`, `techno`, `electronic`, `electro` | Electronic 4/4 | 115–145 BPM | if stored <115: double; if stored >145: halve |
| `drum and bass`, `drum & bass`, `d&b`, `dnb`, `jungle` | DnB | 155–190 BPM | if stored <155: double |
| `dubstep`, `grime` | Dubstep/Grime | 135–150 BPM | if stored <135: double; if stored >150: halve |
| `disco` | Disco | 95–135 BPM | if stored >135: halve; if stored <95: double |
| `top 40`, `pop`, `pop rock`, `rock` | Pop/Rock fallback | **no correction** | too ambiguous |
| no genre tag / unknown | Unknown | **no correction** | no genre data |

#### Special handling for our data

- `"Top 40"` (16,039 tracks) → **no auto-correction**. Too wide a range of real tempos.
- `"Dance"` → map to Electronic 4/4 window (120–140 typical).
- `"Disco"` → own window 95–135, separate from House to avoid over-correcting slow disco.
- Genre strings can contain multiple values (`"House, Trance, Chillout"`) → use keyword search, not exact match.
- Only correct `bpm_source = 'essentia'` rows — never touch `bpm_source = 'tag'` (user-provided).

#### Implementation steps

1. **Add `bpm_raw` column** to `files` table — store original Essentia value before correction.
   ```sql
   ALTER TABLE files ADD COLUMN bpm_raw REAL;
   ```
2. **Admin-triggered endpoint** `POST /api/v1/admin/bpm/genre-correct` — never auto-run on startup.
3. **Logic per row:**
   - Skip if `bpm_source != 'essentia'`
   - Skip if genre is NULL or empty, or matches no family
   - Skip if BPM is already within the target window
   - Write `bpm_raw = bpm` before update
   - Apply halving or doubling (single step only — no iterative loop)
   - Mark `bpm_status = 'genre-corrected'` for auditability
4. **Dry-run mode** (`?dryRun=true`) — returns JSON counts of what would change per genre family, without writing anything.
5. **Undo** — `POST /api/v1/admin/bpm/genre-correct-undo` — restores `bpm = bpm_raw` where `bpm_status = 'genre-corrected'`.
6. **Admin UI** — button in the BPM/Audio Analysis card: "Correct BPM by Genre (dry run)" → "Apply".

#### Risk assessment

- Genre strings are messy — false positives possible (e.g., a legitimate 130 BPM Hip-Hop track halved to 65).
- Always run dry-run first and review the counts.
- The `bpm_raw` column makes this fully reversible.
- **Do not run Phase 2 before Phase 3 is at least partially in place** — otherwise re-analysis will overwrite the corrected values.

---

### Phase 3 — Essentia Worker: Estimates-Based Detection (PLANNED)

**File:** `src/util/essentia-bpm-worker.mjs`

**Goal:** Detect octave errors at analysis time using the audio signal itself — no genre needed.

#### How it works

`rhythmResult.estimates` is a `VectorFloat` containing multiple BPM candidates from different
analysis passes. When Essentia doubles the tempo, `bpm/2` typically still has significant
representation in the estimates array.

Detection logic:
```js
const rawBpm  = rhythmResult.bpm;
const halfBpm = rawBpm / 2;

// Count estimates near rawBpm vs near halfBpm
let countFull = 0, countHalf = 0;
const nEst = rhythmResult.estimates.size();
for (let i = 0; i < nEst; i++) {
  const e = rhythmResult.estimates.get(i);
  if (Math.abs(e - rawBpm)  <= 5) countFull++;
  if (Math.abs(e - halfBpm) <= 5) countHalf++;
}

// If half-tempo is at least 75% as well-represented as full, prefer half
if (rawBpm > 120 && countHalf >= countFull * 0.75 && halfBpm >= 60) {
  bpm = Math.round(halfBpm * 10) / 10;
}
```

Apply genre window as secondary validation: if genre tag is available and the corrected value
falls within the genre family window, confirm; if it would fall outside, keep original.

#### What this fixes

- Only affects newly analyzed tracks (files without a stored BPM yet).
- After Phase 2 corrects existing data, Phase 3 ensures re-analyzed files don't regress.
- The ~4,800 tracks reset for re-analysis after the May 19 backup incident benefit immediately.

#### Threshold tuning

The `0.75` ratio and `±5 BPM` tolerance window are starting estimates. These should be validated
against a sample of known-wrong tracks before committing. Consider logging `countFull`,
`countHalf`, and the final decision to the worker's debug output initially.

---

## Summary Table

| Phase | Fixes | Scope | Risk | Status |
|---|---|---|---|---|
| 1 — Anchor drift | Auto-DJ no longer escalates tempo | Client-side only, 1 function | Zero | ✅ Done |
| 2 — Genre matrix | Corrects ~19K wrong stored values | DB update, admin-triggered | Low–Medium | Planned |
| 3 — Estimates | Prevents recurrence on new analysis | Essentia worker | Low | Planned |
