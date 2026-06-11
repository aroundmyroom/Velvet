**Query Play Statistics** *(documented by GitHub Copilot, 2026-02-27)*
----
  Three endpoints to query play-history data for the authenticated user.
  All return arrays of song metadata objects in the standard format.

---

### Recently Added

* **URL**

  `/api/v1/db/recent/added`

* **Method:**

  `POST`

* **JSON Body**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `limit` | `integer` | Yes | Maximum number of songs to return (min 1). |
  | `ignoreVPaths` | `string[]` | No | Exclude songs from these virtual paths. |

* **Success Response:**

  * **Code:** 200
  * **Content:** Array of [song metadata objects](#song-metadata-object) sorted
    by scan timestamp descending (most recently added first).

---

### Recently Played

* **URL**

  `/api/v1/db/stats/recently-played`

* **Method:**

  `POST`

* **JSON Body**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `limit` | `integer` | Yes | Maximum number of songs to return (min 1). |
  | `ignoreVPaths` | `string[]` | No | Exclude songs from these virtual paths. |

* **Success Response:**

  * **Code:** 200
  * **Content:** Array of song metadata objects sorted by `last-played`
    timestamp descending.

---

### Most Played

* **URL**

  `/api/v1/db/stats/most-played`

* **Method:**

  `POST`

* **JSON Body**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `limit` | `integer` | Yes | Maximum number of songs to return (min 1). |
  | `ignoreVPaths` | `string[]` | No | Exclude songs from these virtual paths. |

* **Success Response:**

  * **Code:** 200
  * **Content:** Array of song metadata objects sorted by `play-count`
    descending.

---

### Song Metadata Object

All three endpoints return arrays of objects in this shape:

```json
{
  "filepath": "/Music/Artist/Album/01 Track.flac",
  "metadata": {
    "artist": "Artist",
    "album": "Album",
    "track": 1,
    "disk": 1,
    "title": "Track Title",
    "year": 1994,
    "album-art": "abcdef1234.jpg",
    "hash": "md5hash",
    "rating": 8,
    "play-count": 12,
    "last-played": 1740000000,
    "replaygain-track": -7.2,
    "duration": 237.431
  }
}
```

| Field | Description |
|---|---------|
| `filepath` | Virtual path — `/<vpath>/relative/path/to/file.ext` |
| `album-art` | Filename inside the `image-cache` directory, or `null`. |
| `rating` | Integer 0–10, or `null`. See [`/api/v1/db/rate-song`](db_rate-song.md). |
| `play-count` | Times the song has been played by this user, or `null`. |
| `last-played` | Unix timestamp (seconds) of last play, or `null`. |
| `replaygain-track` | ReplayGain track gain in dB, or `null`. |
| `duration` | Track length in seconds (float, e.g. `237.431`), or `null` for tracks not yet rescanned. |

---

### Log a Play *(GitHub Copilot, 2026-03-27)*

Records a play against the authenticated user immediately — increments `play-count` and updates `last-played` timestamp.  This endpoint is called by the player unconditionally for every non-radio, non-podcast track and is **independent of scrobbling** (Last.fm / ListenBrainz).  Recently Played and Most Played therefore work even when no external scrobbling service is configured.

* **URL**

  `/api/v1/db/stats/log-play`

* **Method:**

  `POST`

* **JSON Body**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `filePath` | `string` | Yes | Full virtual path of the song (e.g. `/Music/Artist/song.flac`). External URLs (`http://…`) are rejected with `{ ok: false }`. |

* **Success Response:**

  * **Code:** 200
  * **Content:** `{ "ok": true }` — or `{ "ok": false }` when the file cannot be resolved in the DB.

* **Notes:**
  * Radio streams and podcast episodes are never passed to this endpoint.
  * If the file has no existing `user_metadata` row one is created with `pc = 1`.
  * If a row already exists `pc` is incremented and `lp` is updated.
  * Changes are flushed to disk immediately via `db.saveUserDB()`.
