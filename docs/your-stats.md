# Your Stats — Listening Statistics

Velvet tracks your listening activity privately, on your own server. No data leaves your instance.

---

## How it works

Every time you play a song, the player sends a lightweight event to the server:

| Event | When | What it records |
|---|---|---|
| `play-start` | Immediately on song load | `file_hash`, `started_at`, `duration_ms`, `source`, `session_id` |
| `play-end` | Track finishes naturally | `played_ms`; `completed = true` when `played_ms` ≥ 90 % of the track |
| `play-skip` | Another track is started before this one ended (Next, a click in the queue, …) | `played_ms`, `skipped = true` |
| `pause` | You pause the track | `pause_count + 1` |
| `play-stop` | Playback stops, or the tab/window closes (via `sendBeacon`) | `played_ms`; `completed` when ≥ 90 % was heard |
| `session-end` | Tab/window closes | `ended_at` on the session row |

A **session** = one page load. All plays in that browser tab share a single `session_id` (random hex id generated at load time).

A `play-start` for the same song within 10 minutes of an earlier play that did
not complete (for example after a page reload) re-uses that event instead of
counting a new play.

Radio and podcast listening are recorded separately (`radio-start`/`radio-stop`,
`podcast-start`/`podcast-end`) and shown in their own cards.

When you listen in a Velvet Room, the server records the play events for you,
so the same statistics apply.

All song data is stored in two SQLite tables: `play_events` and `listening_sessions`
(radio and podcasts: `radio_play_events`, `podcast_play_events`).

---

## User view

Click **Your Stats** in the sidebar to see your statistics.

### Period picker

Choose the time window at the top:

| Period | Coverage |
|---|---|
| Week | Current ISO week (Mon–Sun) |
| Month | Current calendar month |
| Quarter | Current quarter (Q1–Q4) |
| Half-Year | H1 (Jan–Jun) or H2 (Jul–Dec) |
| Year | Full calendar year |

Use **← Earlier** / **Later →** to move one period at a time.

- **Earlier** goes further back in time (up to 260 periods back).
- **Later** moves toward the current period.
- **⇐ (back 1 year)** and **⇒ (forward 1 year)** jump one full year at a time (52 weeks, 12 months, 4 quarters, 2 half-years or 1 year).
- The **Now** button (shown when not on the current period) jumps back to the present.

All labels in this view use i18n keys (`player.wrapped.*`), so they follow the active UI language.

### Summary strip

| Metric | Description |
|---|---|
| Plays | Total songs started |
| Listened | Sum of `played_ms` across all events |
| Unique songs | Distinct tracks heard |
| Pauses | Total pauses |
| Skip rate | Skipped events ÷ total plays |
| Library covered | Unique songs ÷ total files in your libraries |

### Top Songs / Top Artists

Top 10 by play count, with album art thumbnails.

### Listening by Hour / Listening by Day

Bar charts showing when you listen most.

### Your Personality

A rule-based type assigned from your listening patterns (first match wins),
with your completion rate and your longest and average session:

| Type | Condition |
|---|---|
| Night Owl | >40 % of plays between 22:00–04:00 |
| Album Completionist | Completion rate >85 % AND skip rate <10 % |
| Restless Skipper | Skip rate >40 % |
| Early Bird | >30 % of plays in the hours 06–09 |
| Explorer | >30 % of plays are songs you never played before this period |
| Consistent Listener | Fallback |

### Fun Facts

- Top song total hours
- Most loyal song (100 % completion, ≥5 plays)
- Most skipped artist (≥5 plays)
- Most back-to-back replayed song
- Earliest play time of day
- Best day (most listening time)
- New discoveries count

### Radio / Podcasts / Unplayed Gems

Radio and Podcasts cards appear when you listened to radio or podcasts in the
period. **Unplayed Gems** shows how many songs you have never heard, with a
**Browse** link.

### Listening History

- Sidebar → **History & Stats** → **Listening History** shows the last 7 days by default (`Today`, `Yesterday`, then weekday pills).
- Hour chips inside a selected day are ordered latest-to-earliest.
- The date picker fetches any specific calendar day on demand (`fromMs`/`toMs` on `GET /api/v1/history`).
- Reset returns to the normal 7-day list.
- Playback recorded by the browser, Server Remote, Server Speaker, Sonos, and other authenticated clients uses the same user-scoped event ledger. Recently Played, play counts, statistics, completion/skip rates, listening totals, and Auto-DJ history therefore stay aligned across clients.

---

## Privacy

- **All data is local.** Play events are stored only in `save/db/velvet.sqlite`.
- **No external calls.** The stats system makes no network requests.
- **No older data.** Historical play counts from `user_metadata.pc` are not imported — only events recorded since this feature was added.
- Tags are never duplicated into `play_events` — stats always JOIN to the `files` table at query time, so tag edits are reflected automatically.

---

## Admin — Play Stats panel

Accessible from the admin sidebar → **Play Stats**.

Shows:
- Song play events, radio sessions and podcast episodes (all users)
- Estimated DB storage used
- Per-user breakdown (songs, song time, radio sessions and time, podcast episodes and time)

### Deleting events

Under **Delete Events in Range**, pick a user and a **From** / **To** date-time
(quick select: last 1h, 6h, 12h, today, yesterday), then click **Delete events
in range** and confirm. All song, radio and podcast events of that user in that
window are deleted. Sessions with no remaining events are also cleaned up.

### Fix Missing Metadata

For files with no embedded tags at all, **Derive metadata from folder names**
fills artist, album and title from the parent folder name (pattern
`Artist - Release info`) in the Velvet database only. A preview shows how many
files qualify first.

---

## Database schema

```sql
play_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  file_hash    TEXT NOT NULL,        -- joins to files.hash
  started_at   INTEGER NOT NULL,     -- Unix ms
  ended_at     INTEGER,
  duration_ms  INTEGER,              -- track total from files.duration * 1000
  played_ms    INTEGER,              -- ms actually heard
  completed    INTEGER DEFAULT 0,    -- 1 if played_ms >= 90% of duration_ms
  skipped      INTEGER DEFAULT 0,    -- 1 if user skipped
  source       TEXT,                 -- 'manual'|'queue'|'shuffle'|'autodj'|'playlist'|'smart-playlist'
  session_id   TEXT,
  pause_count  INTEGER DEFAULT 0
)

listening_sessions (
  session_id   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  total_tracks INTEGER DEFAULT 0
)
```

---

## API reference

### Player event endpoints (JWT-authenticated)

```
POST /api/v1/wrapped/play-start
  body: { filePath, sessionId, source }
  returns: { ok, eventId }        (resumed: true when an earlier event is re-used)

POST /api/v1/wrapped/play-end
  body: { eventId, playedMs }

POST /api/v1/wrapped/pause
  body: { eventId }

POST /api/v1/wrapped/play-skip
  body: { eventId, playedMs }

POST /api/v1/wrapped/play-stop
  body: { eventId, playedMs }

POST /api/v1/wrapped/session-end
  body: { sessionId }

POST /api/v1/wrapped/radio-start     body: { stationName, stationId?, sessionId }
POST /api/v1/wrapped/radio-stop      body: { eventId, listenedMs }
POST /api/v1/wrapped/podcast-start   body: { episodeId, feedId, sessionId }
POST /api/v1/wrapped/podcast-end     body: { eventId, playedMs, completed }
```

### Stats endpoints (JWT-authenticated)

```
GET /api/v1/user/wrapped?period=monthly&offset=0
  period: weekly | monthly | quarterly | half-yearly | yearly
  offset: -260 … 0
  → full stats object for the authenticated user

GET /api/v1/user/wrapped/periods
  → { periods: [ { year, month, play_count } ] }   (up to 36 months)

GET /api/v1/history[?fromMs=&toMs=]
  → { events: [...] }   (last 7 days by default)
```

### Admin endpoints (admin-only)

```
GET  /api/v1/admin/wrapped/stats
     → { total_events, total_radio, total_podcast, storage_bytes, per_user: [...] }

POST /api/v1/admin/wrapped/purge
     body: { userId, fromMs, toMs }
     → { ok, deleted }

GET  /api/v1/admin/wrapped/backfill-folder-metadata/preview
POST /api/v1/admin/wrapped/backfill-folder-metadata
```
