# Smart Playlist ML

Velvet includes a beta ML-based Smart Playlist system that learns your listening patterns by time of day and generates personalised playlists for each time slot.

## Time slots

| Slot | Hours |
|------|-------|
| Morning | 06:00 – 10:59 |
| Afternoon | 11:00 – 16:59 |
| Evening | 17:00 – 21:59 |
| Night | 22:00 – 05:59 |

## How it works

1. Every time you play a track, a row is inserted in `play_events` (by the Your Stats engine, see [your-stats.md](your-stats.md)).
2. The Smart Playlist background worker reads new events and updates a per-user, per-slot [Exponential Moving Average](https://en.wikipedia.org/wiki/Moving_average#Exponential_moving_average) profile vector. It runs 2 minutes after server start, then every hour, and also 2 minutes after a completed play (at most one extra run per 2 minutes). It goes through the background task broker, so it waits while a scan runs.
3. The profile is a 7-element vector: genre, release year, BPM, musical key (Camelot position), track duration, plus two fixed placeholder values (0.5).
4. The worker scores your entire library against each profile using cosine similarity and caches the top-50 tracks per slot in the database (one song per artist, songs missing genre/BPM/key score lower).

In the player the result is shown as **Listening Habits** in the sidebar, with
a tab per time slot. The nav button only appears when the feature is enabled.
In the admin panel it is under **Smart Playlist**.

## Enabling the beta

The feature is controlled by `BETA_SMART_PLAYLIST` in `src/beta-flags.js`.
It is currently **`true` (enabled)**. To turn it off:

1. Open `src/beta-flags.js`
2. Set `BETA_SMART_PLAYLIST = false`
3. Restart the server: `systemctl restart music.service`

When off, the user endpoints answer `501` and the background worker does not
run. The admin panel section and admin API endpoints are always available.

## API endpoints

### User endpoints (requires beta flag)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/smartplaylist/generated` | Get top-50 tracks for the current (or requested) time slot |
| POST | `/api/v1/smartplaylist/save-as-playlist` | Save a slot playlist as a regular playlist |

#### GET `/api/v1/smartplaylist/generated`

Query parameters:
- `slot` (optional) — one of `morning`, `afternoon`, `evening`, `night`. Defaults to the current slot based on server time.

Response:
```json
{
  "slot": "evening",
  "tracks": ["Music/Artist/Album/track.flac", "..."],
  "generated_at": 1748700000000
}
```

If no playlist has been generated yet:
```json
{
  "slot": "evening",
  "tracks": [],
  "generated_at": null,
  "message": "No playlist generated yet — listening more will improve results"
}
```

#### POST `/api/v1/smartplaylist/save-as-playlist`

Body:
```json
{
  "name": "My Evening Mix",
  "slot": "evening"
}
```

Response:
```json
{ "saved": 50, "name": "My Evening Mix" }
```

### Admin endpoints

All under `/api/v1/admin/smartplaylist/` — require admin user.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/admin/smartplaylist/status` | Feature status + per-user profile stats |
| POST | `/api/v1/admin/smartplaylist/generate` | Trigger generation immediately |
| POST | `/api/v1/admin/smartplaylist/reset-profiles` | Clear EMA profiles for a user |

#### GET `/api/v1/admin/smartplaylist/status`

```json
{
  "enabled": false,
  "stats": {
    "profiles": [
      { "user_id": "admin", "slot": "evening", "play_count": 42, "updated_at": 1748700000000 }
    ],
    "generated": [
      { "user_id": "admin", "slot": "evening", "generated_at": 1748700000000, "track_count": 50 }
    ],
    "slotCounts": [
      { "user_id": "admin", "morning": 10, "afternoon": 25, "evening": 42, "night": 3 }
    ]
  }
}
```

`slotCounts` is the number of `play_events` per user per slot (local time).

#### POST `/api/v1/admin/smartplaylist/reset-profiles`

Body (optional — omitting `userId` resets the calling user's profiles):
```json
{ "userId": "someuser" }
```

## Database tables

### `sp_slot_profiles`

Stores the EMA profile vector for each (user, slot) pair.

| Column | Type | Description |
|--------|------|-------------|
| user_id | TEXT | Username |
| slot | TEXT | `morning`, `afternoon`, `evening`, or `night` |
| profile | TEXT | JSON array of 7 floats (the EMA vector) |
| play_count | INTEGER | Number of plays processed for this slot |
| last_event_id | INTEGER | Last `play_events.id` processed (high-water mark) |
| updated_at | INTEGER | Unix ms timestamp of last update |

### `sp_generated_playlists`

Cached top-50 track list per (user, slot), updated on every worker run.

| Column | Type | Description |
|--------|------|-------------|
| user_id | TEXT | Username |
| slot | TEXT | Time slot |
| tracks | TEXT | JSON array of `"vpath/filepath"` strings |
| generated_at | INTEGER | Unix ms timestamp of last generation |

## Feature vector dimensions

| Index | Name | Range | Source |
|-------|------|-------|--------|
| 0 | genre_bucket | 0–1 | Hash of `files.genre` → 20 buckets |
| 1 | year_norm | 0–1 | `files.year` normalised 1950–2030 |
| 2 | bpm_norm | 0–1 | `files.bpm` normalised 40–220 BPM |
| 3 | key_norm | 0–1 | Camelot wheel position 1–12 |
| 4 | dur_norm | 0–1 | `files.duration` normalised 30–600 s |
| 5 | danceability | 0.5 | Fixed value, not computed |
| 6 | energy | 0.5 | Fixed value, not computed |

Dimensions 5 and 6 are constant; they stay in the vector so stored 7-element
profiles keep working. Missing genre, year, BPM, key or duration fall back to a
midpoint value.

## EMA learning rates

| Event type | Alpha |
|-----------|-------|
| Completed play (≥ 90 % heard) | 0.15 |
| Partial play (> 30 s, not completed) | 0.05 |
| Play of 30 s or less, not completed | not used |

A minimum of **3 counted plays (completed or partial) per slot** is required before a playlist is generated for that slot.

## Improving results

- **BPM & Key data**: Run the BPM & Key analysis in the admin panel to fill `bpm` and `musical_key`. This improves the `bpm_norm` and `key_norm` dimensions.
- **Play through tracks fully**: Completed plays carry 3× the learning weight of partial plays. Short plays (30 s or less) produce no profile updates.
- **Time diversity**: Listening at different times of day builds richer slot profiles. A user who only listens in the evening will only have a useful `evening` profile.
