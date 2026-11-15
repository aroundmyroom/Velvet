**Get Random Songs**
----
  Returns random songs from the library for Auto-DJ. Two modes:

  - **Single pick** (default) — one random song plus an updated ignore list to prevent repeats.
  - **Batch mode** (`returnAll: true`) — a pool of up to 500 candidates; the client scores them (genre, BPM, key) and picks one. This is what the web player's Auto-DJ uses.

  Clients that want the server to do the whole Auto-DJ pick (scoring included) use [`POST /api/v1/autodj/next`](../API.md#library) instead — the Samsung TV app and Server Remote do.

* **URL**

  `/api/v1/db/random-songs`

* **Method:**

  `POST`

* **Headers**

  | Header | Required | Description |
  |---|---|---|
  | `x-access-token` | Yes | User authentication token. |
  | `Content-Type` | Yes | `application/json` |

* **JSON Body**

  All fields are optional.

  | Field | Type | Mode | Description |
  |---|---|---|---|
  | `returnAll` | `boolean` | — | `true` switches to batch mode. |
  | `ignoreVPaths` | `string[]` | both | Exclude songs from these root vpaths. |
  | `filepathPrefix` | `string\|null` | both | Only songs whose filepath starts with this prefix. |
  | `excludeFilepathPrefixes` | `{ vpath, prefix }[]` | both | Exclude rows under these prefixes. |
  | `includeFilepathPrefixes` | `{ vpath, prefix }[]` | both | Whitelist — only rows under these prefixes for the named vpaths. |
  | `minRating` | `integer` | both | Only songs with a rating ≥ this value (0–10, as `POST /api/v1/db/rate-song`). |
  | `artists` | `string[]` | both | Only songs by these artists (Similar Artists mode, see [`/api/v1/lastfm/similar-artists`](lastfm_similar-artists.md)). Dropped when nothing matches. |
  | `ignoreArtists` | `string[]` | both | Artist cooldown list — skipped when possible, dropped when it would leave nothing. |
  | `minDuration` / `maxDuration` | `number` | both | Track-length window in **seconds**; `0` or omitted = no bound, capped at 86400. A hard filter, never relaxed. A backwards window returns 400. |
  | `allowUnknownDuration` | `boolean` | both | Default `false`: songs with no known duration are left out when a window is set. |
  | `ignoreList` | `integer[]` | single | Positions from previous responses to skip. Trimmed to `ignorePercentage × matching songs` entries. |
  | `ignorePercentage` | `number` | single | Fraction (0–1) of the matches that may be in `ignoreList`. Default `0.5`. |
  | `genres` | `string[]` | single | Genre display names (as `GET /api/v1/db/genres`). |
  | `genreMode` | `string` | single | `whitelist` (default) or `blacklist` for `genres`. |
  | `bpmRanges` | `{ min, max }[]` | single | Allowed BPM ranges. Wins over `bpmMin`/`bpmMax`/`requireBpm`. |
  | `bpmRangesWide` | `{ min, max }[]` | single | Wider ranges tried when the normal ranges find nothing. |
  | `bpmMin` / `bpmMax` / `requireBpm` | `number` / `number` / `boolean` | single | Simple BPM window. |
  | `musicalKeys` / `requireMusicalKey` | `string[]` / `boolean` | single | Allowed keys. |

  In single-pick mode the BPM/key/genre wishes are relaxed step by step (drop the cooldown list, drop the key, use the wide ranges, ignore the genre) before giving up; songs whose BPM/key is known to be in range are preferred over untagged ones.

  ```json
  {
    "ignoreList": [3, 17, 42],
    "ignorePercentage": 0.5,
    "ignoreVPaths": ["Audiobooks"],
    "minRating": 6,
    "artists": ["Iggy Pop", "Lou Reed", "T. Rex"]
  }
  ```

* **Success Response — single pick:**

  * **Code:** 200

  ```json
  {
    "songs": [
      {
        "filepath": "Music/Artist/Album/01 Track.flac",
        "metadata": {
          "artist": "Artist",
          "album": "Album",
          "track": 1,
          "title": "Track Title",
          "year": 1994,
          "album-art": "abcdef1234.jpg",
          "hash": "md5hash",
          "rating": 8,
          "play-count": 5,
          "last-played": 1740000000,
          "duration": 237.431
        },
        "rg": null
      }
    ],
    "ignoreList": [3, 17, 42, 88]
  }
  ```

  | Field | Description |
  |---|---|
  | `songs` | Array containing exactly one song object (same shape as [`POST /api/v1/db/metadata`](db_metadata.md)). |
  | `ignoreList` | The ignore list with the new song's position appended. Pass this back on the next call. |

* **Success Response — batch mode:**

  `{ "songs": [ … ] }` — up to 500 song objects. With an `artists` filter at most 10 songs per artist are sampled. When the admin has approved genre families, each song's `metadata` also carries `genre-family`.

* **Error Response:**

  * **Code:** 400 — `{ "error": "No songs that match criteria" }`
  * **Code:** 400 — `{ "error": "minDuration must be <= maxDuration" }`

* **Notes**

  - The web player prefetches the next Auto-DJ song 2 seconds after the last queue item starts, so a manual skip advances at once. A second prefetch fires when that item has less than `max(25, crossfade + 15)` seconds left (`max(45, …)` in Similar Artists mode).
