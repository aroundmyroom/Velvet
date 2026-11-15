**Query Play Statistics**
----
  Endpoints to query recently added songs and the play history of the authenticated user.
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
  | `excludeFilepathPrefixes` | `{ vpath, prefix }[]` | No | Exclude songs under these prefixes. |

* **Success Response:**

  * **Code:** 200
  * **Content:** Array of [song metadata objects](#song-metadata-object), each with an extra `ts` field (time the file was added, Unix seconds). Only songs from the 7 most recent calendar days that had additions are returned, newest first.

---

### Recently Added — grouped by day

* **URL:** `/api/v1/db/recent/added/by-day`
* **Method:** `POST`
* **JSON Body** (all optional)

  | Field | Type | Description |
  |---|---|---|
  | `maxDays` | `integer` | 1–30, default 7 — number of days with additions to return. |
  | `maxFolders` | `integer` | 1–1000, default 700 — total number of folder cards. |
  | `ignoreVPaths` | `string[]` | Exclude these virtual paths. |
  | `excludeFilepathPrefixes` | `{ vpath, prefix }[]` | Exclude songs under these prefixes. |

* **Success Response:** 200

  ```json
  [
    {
      "date": "2026-11-14",
      "dayLabel": "Saturday (14-11)",
      "folders": [
        { "dir": "Albums/Artist - Album", "label": "Artist - Album", "artist": "Artist", "art": "abc.jpg", "ts": 1763100000, "songs": [ { "filepath": "…", "metadata": { … } } ] }
      ]
    }
  ]
  ```

  Disc sub-folders (`CD 1`, `Disc 2`, `Side A`…) are collapsed into one folder card. A folder only lists the songs added on the same day as its newest song.

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
  | `excludeFilepathPrefixes` | `{ vpath, prefix }[]` | No | Exclude songs under these prefixes. |

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
  | `excludeFilepathPrefixes` | `{ vpath, prefix }[]` | No | Exclude songs under these prefixes. |

* **Success Response:**

  * **Code:** 200
  * **Content:** Array of song metadata objects sorted by `play-count`
    descending.

---

### Song Metadata Object

These endpoints return objects in this shape (all fields are listed in [db_metadata.md](db_metadata.md)):

```json
{
  "filepath": "Music/Artist/Album/01 Track.flac",
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
    "last-played": 1740000000000,
    "replaygain-track-db": -7.2,
    "duration": 237.431
  },
  "rg": null
}
```

| Field | Description |
|---|---------|
| `filepath` | Player path — `<vpath>/relative/path/to/file.ext` |
| `album-art` | Filename inside the album-art cache directory, or `null`. |
| `rating` | Integer 0–10, or `null`. See [`/api/v1/db/rate-song`](db_rate-song.md). |
| `play-count` | Times the song has been played by this user, or `null`. |
| `last-played` | Unix timestamp in **milliseconds** of the last play, or `null`. |
| `replaygain-track-db` | ReplayGain track gain tag in dB, or `null`. |
| `duration` | Track length in seconds (float, e.g. `237.431`), or `null` for tracks not yet rescanned. |

---

### Log a Play

Records a play against the authenticated user immediately — increments `play-count` and sets `last-played` to now. The web player calls it when a track starts, for every track that is not a radio stream or podcast episode, and it is **independent of scrobbling** (Last.fm / ListenBrainz). Recently Played and Most Played therefore work even when no external scrobbling service is configured.

* **URL**

  `/api/v1/db/stats/log-play`

* **Method:**

  `POST`

* **JSON Body**

  | Field | Type | Required | Description |
  |---|---|---|---|
  | `filePath` | `string` | Yes | Player filepath of the song (e.g. `Music/Artist/song.flac`). External URLs (`http://…`) are rejected with `{ ok: false }`. |

* **Success Response:**

  * **Code:** 200
  * **Content:** `{ "ok": true }` — or `{ "ok": false }` when the file cannot be resolved.

* **Notes:**
  * A file that is on disk but not yet in the DB is indexed on demand first.
  * If the file has no `user_metadata` row for the user, one is created with `pc = 1`; otherwise `pc` is incremented. `lp` is set to `Date.now()`.
