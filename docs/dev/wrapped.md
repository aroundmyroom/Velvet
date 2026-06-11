# Velvet — Wrapped Implementation Plan

> Read this before writing a single line of code.
> One phase at a time. Approval required before starting each phase.

---

## What we already have (relevant to this feature)

### DB (SQLite only — LokiJS phased out)
- `files` table: `hash`, `title`, `artist`, `album`, `year`, `genre`, `duration` (seconds), `vpath`, `filepath`, `artist_id`, `album_id`
- `user_metadata`: `hash`, `user`, `pc` (play count), `lp` (last played ms), `rating`, `starred`
- Migration pattern: `CREATE TABLE IF NOT EXISTS` in `init()` + `ALTER TABLE … ADD COLUMN` try/catch blocks
- Indexes added with `CREATE INDEX IF NOT EXISTS` — always idempotent, no migrations needed

### Player (webapp/app.js)
- `Player.playAt(idx)` — fires on every new track start. Already calls:
  - `api('POST', 'api/v1/db/stats/log-play', { filePath })` — immediately (no 30s delay)
  - Last.fm / ListenBrainz scrobble — after 30 s timeout
- `Player.next()` — called by skip button, `prev()`, `_onAudioEnded()` → natural end
- `_onAudioEnded()` — fires when HTML audio element fires `ended` (natural completion)
- `S.playSource` — tracks where a song came from: `null | { type:'playlist'|'smart-playlist'|'home'|'radio'|'podcast', name }`
- `S.shuffle` — boolean
- `S.autoDJ` — boolean
- `audioEl.currentTime` available at skip time to compute `played_ms`
- `audioEl.duration` available for total duration

### Existing `log-play` endpoint
`POST /api/v1/db/stats/log-play` in `src/api/db.js`  
Currently just increments `pc` and sets `lp` in `user_metadata`. We will **augment** this — not replace it — by also inserting into `play_events`.

### Auth
- `req.user.username` — current logged-in user (string)
- `req.user.vpaths` — array of vpaths
- No-auth mode: username = `'velvet-user'`

### API pattern
- `src/api/<name>.js` exports `setup(velvet)` — registered in `src/server.js`
- Routes are JWT-protected after the `authApi.setup(velvet)` call

### Admin panel pattern
- Vue 2 components in `webapp/admin/index.js`
- Card structure: `<div class="card"><div class="card-content">…</div></div>` inside `.container > .row > .col.s12`
- `API.axios({ method, url, data })` for all admin API calls
- `iziToast` for feedback
- `ADMINDATA` global — server-rendered object injected into the page HTML

---

## What we are building: Wrapped

A privacy-first, on-server listening statistics system. Zero external calls.  
All data stays in the user's own SQLite database.

---

## Phase 1 — Database schema

### Tables to create

**`play_events`** — one row per playback event (append-only)

```sql
CREATE TABLE IF NOT EXISTS play_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  file_hash    TEXT NOT NULL,
  started_at   INTEGER NOT NULL,   -- Unix ms
  ended_at     INTEGER,            -- null if session crashed / still playing
  duration_ms  INTEGER,            -- track total duration (from files.duration * 1000)
  played_ms    INTEGER,            -- ms actually heard (set on end/skip/stop)
  completed    INTEGER DEFAULT 0,  -- 1 if played_ms >= 90% of duration_ms
  skipped      INTEGER DEFAULT 0,  -- 1 if stopped before 30% of duration_ms
  source       TEXT,               -- 'manual'|'queue'|'shuffle'|'autodj'|'playlist'|'smart-playlist'
  session_id   TEXT                -- groups events in one listening session
)
```

Indexes:
- `(user_id, started_at)` — time-range queries (all wrapped stats)
- `(user_id, file_hash)` — per-song history
- `(session_id)` — session aggregation
- `(user_id, completed)` — completion rate

**`listening_sessions`** — one row per session

```sql
CREATE TABLE IF NOT EXISTS listening_sessions (
  session_id   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  started_at   INTEGER NOT NULL,   -- Unix ms
  ended_at     INTEGER,            -- updated on session_end
  total_tracks INTEGER DEFAULT 0   -- incremented on each play_start in session
)
```

Index: `(user_id, started_at)` for per-period aggregation.

### Migration strategy
Same as all existing tables:
1. Add `CREATE TABLE IF NOT EXISTS` blocks inside `init()` in `sqlite-backend.js`
2. Add `CREATE INDEX IF NOT EXISTS` after the table block
3. No ALTER TABLE needed on first rollout

### Design decisions
- `play_events` is **append-only** — no UPDATE or DELETE except the admin purge
- `ended_at` / `played_ms` are set by separate `play_end` / `play_skip` / `play_stop` events (Phase 2)
- `duration_ms` is stored at insert time from the DB row (no re-lookup later)
- `file_hash` is the SHA256 hash already in `files.hash` — joins cleanly
- We do NOT store `title`/`artist` in `play_events` — always JOIN to `files` at query time so tag edits are reflected in stats automatically
- `user_id` = `req.user.username` (same as `user_metadata.user`)

### Where in the codebase
- Table definitions: `src/db/sqlite-backend.js` → `init()`
- DB helper functions: `src/db/sqlite-backend.js` (new export functions at the bottom)
- Exposed via manager: `src/db/manager.js` (thin re-exports)

---

## Phase 2 — Player-side event hooks

### New API endpoints (src/api/wrapped.js)

```
POST /api/v1/wrapped/play-start
  body: { filePath, sessionId, source }
  action: INSERT into play_events (started_at=now, user_id, file_hash, duration_ms, source, session_id)
          UPSERT listening_sessions (increment total_tracks)
  returns: { eventId }   ← client stores this to correlate the end/skip/stop

POST /api/v1/wrapped/play-end
  body: { eventId, playedMs }
  action: UPDATE play_events SET ended_at, played_ms, completed WHERE id=eventId AND user_id=?

POST /api/v1/wrapped/play-skip
  body: { eventId, playedMs }
  action: UPDATE play_events SET ended_at, played_ms, skipped=1 WHERE id=eventId AND user_id=?

POST /api/v1/wrapped/play-stop
  body: { eventId, playedMs }
  action: UPDATE play_events SET ended_at, played_ms WHERE id=eventId AND user_id=?

POST /api/v1/wrapped/session-end
  body: { sessionId }
  action: UPDATE listening_sessions SET ended_at WHERE session_id=? AND user_id=?
```

Note: `play_end` / `play_skip` / `play_stop` all differ only in what flags they set.  
We can unify into one endpoint internally but keep semantic names for clarity.

### Player changes (webapp/app.js)

**Session management:**
- `_wrappedSessionId` — module-level UUID, generated once per page load
- `_wrappedEventId` — set by `play_start` response, used for end/skip/stop
- `_wrappedTrackStart` — `Date.now()` when current track started
- Session lives for the page session (no 30min timeout on client — server can infer gaps)

**Hooks:**

| Where | Existing code | New call |
|---|---|---|
| `Player.playAt()` | `api('POST','api/v1/db/stats/log-play',…)` | + `api('POST','api/v1/wrapped/play-start', { filePath, sessionId, source })` |
| `_onAudioEnded()` (natural end) | `Player.next()` | + fire `play-end` with `playedMs = audioEl.duration * 1000` before next() |
| `Player.next()` (skip) | increment idx | + if previous `_wrappedEventId` exists AND `_onAudioEnded` didn't fire it, fire `play-skip` with `playedMs = audioEl.currentTime * 1000` |
| `Player.toggle()` / pause | pause | no event needed (pausing doesn't end the event) |
| Page `beforeunload` | nothing | fire `play-stop` with best-effort `playedMs` + `session-end` (navigator.sendBeacon) |

**Source detection:**
```js
function _wrappedSource() {
  if (S.autoDJ) return 'autodj';
  if (S.shuffle) return 'shuffle';
  if (S.playSource?.type === 'playlist') return 'playlist';
  if (S.playSource?.type === 'smart-playlist') return 'smart-playlist';
  return 'manual';
}
```

**Skip vs end disambiguation:**
- `_wrappedEndedNaturally` boolean flag set to `true` in `_onAudioEnded()` before calling `Player.next()`
- `Player.next()` checks this flag — if false → it's a user-initiated skip → fire `play-skip`
- Flag reset to `false` at start of each `Player.playAt()`

**Reliability:**
- All wrapped API calls are `.catch(() => {})` — never block playback
- `navigator.sendBeacon` for beforeunload (fire-and-forget, works on tab close)

---

## Phase 3 — Stats computation

### New file: `src/db/wrapped-stats.mjs`

Pure SQLite aggregation — no in-memory work.

#### Main function signature
```js
export async function getWrappedStats(userId, fromMs, toMs)
```
Returns a single flat object (see below).

#### Period helper
```js
export function getPeriodBounds(period, offset = 0)
// period: 'weekly'|'monthly'|'quarterly'|'half-yearly'|'yearly'
// offset: 0 = current, -1 = previous, etc.
// returns: { from: ms, to: ms, label: '2026-W14' | 'March 2026' | 'Q1 2026' | … }
```

#### Stats returned

```js
{
  // ── Counts ──
  total_plays,          // INTEGER
  unique_songs,         // INTEGER  
  completed_plays,      // INTEGER
  skipped_plays,        // INTEGER
  total_listening_ms,   // BIGINT (sum of played_ms)
  
  // ── Rates ──
  skip_rate,            // FLOAT 0..1
  completion_rate,      // FLOAT 0..1
  library_coverage_pct, // FLOAT 0..100 (unique_songs / total files in library)

  // ── Top lists ──
  top_songs: [          // top 10 by play count
    { hash, title, artist, album, aaFile, play_count, total_played_ms }
  ],
  top_artists: [        // top 10 by play count
    { artist, artist_id, play_count, total_played_ms }
  ],
  top_albums: [         // top 5 by play count
    { album, artist, album_id, aaFile, play_count }
  ],

  // ── Temporal ──
  listening_by_hour:    // array[24] of play counts (index = hour 0..23)
  listening_by_weekday: // array[7] of play counts (index = 0=Mon..6=Sun)
  top_listening_day: {  // single day with most listening_ms
    date,               // 'YYYY-MM-DD'
    total_listening_ms
  },

  // ── Session insights ──
  avg_session_length_ms,
  longest_session: {
    session_id,
    started_at,
    ended_at,
    total_tracks
  },

  // ── Discovery ──
  new_discoveries,      // songs played for THE FIRST TIME in this period (debut in play_events)

  // ── Fun facts ──
  fun_facts: {
    top_song_hours,           // string: "If you played [song] on repeat, you'd have heard it for X hours"
    most_skipped_artist,      // { artist, skip_rate } — highest skip rate, min 5 plays
    earliest_play,            // string: '07:23' — earliest time of day you started music
    most_loyal_song,          // { title, artist } — 100% completion rate, min 5 plays
    night_owl_score,          // FLOAT 0..1 — % of plays between 22:00–04:00
    most_replayed_song        // { title, artist, replay_count } — most back-to-back replays in period
  },

  // ── Personality ──
  personality: {
    type,      // 'Night Owl' | 'Album Completionist' | 'Restless Skipper' | 'Daytime Listener' | 'Explorer'
    desc       // Short description string
  },

  // ── Meta ──
  period_label,   // e.g. 'March 2026'
  from_ms,
  to_ms,
  generated_at    // ms
}
```

#### Personality algorithm
Simple rule-based, evaluated in priority order:
1. `night_owl_score > 0.40` → **Night Owl** — "Most of your listening happens after 10 PM"
2. `completion_rate > 0.85 AND skip_rate < 0.10` → **Album Completionist** — "You actually listen to the whole track"
3. `skip_rate > 0.40` → **Restless Skipper** — "You know what you want and you want it now"
4. `listening_by_hour[6..9] is dominant` → **Early Bird** — "Your day starts with music"
5. `new_discoveries / total_plays > 0.30` → **Explorer** — "Always hunting for something new"
6. fallback → **Consistent Listener**

---

## Phase 4 — API endpoints

### File: `src/api/wrapped.js` (extends Phase 2 file)

```
GET  /api/v1/user/wrapped?period=weekly|monthly|quarterly|half-yearly|yearly&offset=0
     → full stats object for req.user.username

GET  /api/v1/user/wrapped/periods
     → { periods: [ { period, offset, label, play_count } ] }
     Lists all non-empty time buckets the user has data in (most recent first, max 24 entries)
     Used by the UI prev/next navigation to know what's available
```

Both are GET, JWT-protected, user sees only their own data.

---

## Phase 5 — Admin Panel card

### New view in `webapp/admin/index.js`: `wrapped-admin-view`

Card content:
- **Total play events in DB** (all users, all time) — large number
- **DB storage used by play_events** — `SELECT SUM(payload) FROM dbstat WHERE name='play_events'` (SQLite `dbstat` virtual table)
- **Per-user breakdown** — table: username | events | listening time
- **Purge old events** — number input "Keep last N months" + Confirm button
  - `DELETE FROM play_events WHERE started_at < ?`
  - Sessions with no remaining events also purged
  - Confirmed with `adminConfirm()` (same pattern as scan-errors clear)

### New admin API endpoints (src/api/admin.js additions)

```
GET  /api/v1/admin/wrapped/stats
     → { total_events, storage_bytes, per_user: [...] }

POST /api/v1/admin/wrapped/purge
     body: { keepMonths: number }   min 1, max 60
     → { deleted: number }
```

---

## Phase 6 — Wrapped UI page

### New view in `webapp/app.js`: `viewWrapped()`

#### Layout
```
[Period picker: ← Week / Month / Quarter / Half-year / Year →]

[Summary strip: X plays · Y hours · Z unique songs · skip rate%]

[Top Songs]       [Top Artists]
[1. Song — X plays]  [1. Artist — Y plays]
...               ...

[Listening Heatmap]
   Mon Tue Wed Thu Fri Sat Sun
0h  ·   ·   ·   ·   ·   ○   ○
6h  ○   ·   ·   ·   ·   ●   ○
12h ●   ●   ○   ●   ●   ○   ●
18h ○   ●   ●   ○   ●   ●   ●
22h ○   ○   ·   ○   ○   ●   ●

[Fun Facts]                    [Your Listening Personality]
┌─────────────────────┐       ┌─────────────────────┐
│ 🦉 Night Owl        │       │ Album Completionist  │
│ 43% after 10 PM     │       │ You finish what       │
└─────────────────────┘       │ you start             │
┌─────────────────────┐       └─────────────────────┘
│ 🎵 Most loyal song  │
│ "Blue Monday"       │
│ finished 100%       │
└─────────────────────┘

[New Discoveries] — songs played for the first time this period
```

#### Navigation
- Period selector tabs at top: Week · Month · Quarter · Half-Year · Year
- ← / → arrows to navigate offset (previous/next period)
- Arrows disabled when no data available (from `/wrapped/periods` response)
- "No data for this period" state when `total_plays === 0`

#### Sidebar nav
- New nav item "Wrapped" (waveform/chart icon) — same pattern as Subsonic, Albums, etc.

#### Heatmap implementation
- Pure CSS grid — no canvas, no external library
- 7 columns (days) × 24 rows (hours) — cells colored by play_count
- 4 intensity levels: empty / light / medium / heavy
- Responsive: collapses gracefully on mobile

---

## Implementation order within each phase

### Phase 1 (DB)
1. `sqlite-backend.js` — add table + index definitions in `init()`
2. `sqlite-backend.js` — add 8 new export functions:
   - `insertPlayEvent(event)` → `id`
   - `updatePlayEvent(id, userId, { ended_at, played_ms, completed, skipped })`
   - `upsertListeningSession(session)`
   - `updateListeningSession(sessionId, userId, { ended_at })`
   - `getWrappedPeriods(userId)` → period list
   - `getPlayEventsInRange(userId, fromMs, toMs)` → raw events + joined file data (for stats computation)
   - `getWrappedAdminStats()` → admin overview
   - `purgePlayEvents(beforeMs)` → deleted count
3. `manager.js` — re-export all 8

### Phase 2 (Player hooks)
1. `src/api/wrapped.js` — play-start / play-end / play-skip / play-stop / session-end endpoints
2. `webapp/app.js` — add tracking variables + 5 hook points

### Phase 3 (Stats)
1. `src/db/wrapped-stats.mjs` — `getWrappedStats()` + `getPeriodBounds()`

### Phase 4 (API)
1. Extend `src/api/wrapped.js` — add GET /wrapped and GET /wrapped/periods
2. `src/server.js` — import + register `wrappedApi.setup(velvet)`

### Phase 5 (Admin)
1. `src/api/admin.js` — add 2 admin endpoints
2. `webapp/admin/index.js` — add `wrapped-admin-view` component + nav entry

### Phase 6 (UI)
1. `webapp/app.js` — `viewWrapped()` function + nav item
2. `webapp/style.css` or inline styles — heatmap CSS grid

---

## Decisions (confirmed)

1. **Session**: One `sessionId` per page load — no timeout needed. `listening_sessions` tracks the full page session.

2. **play-start timing**: Fire immediately on `playAt()`. No delay. Short/accidental plays will be captured; `skipped=1` if stopped before 30%.

3. **Historical data**: No import. Stats start from the date Wrapped is first deployed (April 2026). The UI will note the data start date — e.g. "Stats available from April 2026".

4. **Admin purge scope**: Per-user when users exist. In no-auth mode (single user), purge applies to the single `'velvet-user'` account.

---

## Files to create / modify

| File | Action |
|---|---|
| `src/db/sqlite-backend.js` | Modify — add tables, indexes, 8 functions |
| `src/db/manager.js` | Modify — re-export new functions |
| `src/db/wrapped-stats.mjs` | **Create new** |
| `src/api/wrapped.js` | **Create new** |
| `src/api/admin.js` | Modify — 2 new endpoints |
| `src/server.js` | Modify — import + register wrappedApi |
| `webapp/app.js` | Modify — tracking vars + hooks + viewWrapped() |
| `webapp/admin/index.js` | Modify — new card component |
| `webapp/style.css` | Modify — heatmap styles |
