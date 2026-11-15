**Last.fm — Similar Artists**
----

Returns artists similar to a given artist via the Last.fm API, resolved to the
artist names that exist in your library. Used by the Auto-DJ "Similar Artists"
mode to bias song selection.

Needs a Last.fm API key (`lastFM.apiKey` in the config, set in Admin → Last.fm).
Without a key the endpoint returns `{ "artists": [] }`.

* **URL:** `/api/v1/lastfm/similar-artists`
* **Method:** `GET`
* **Auth required:** Yes — any logged-in user
* **Query Parameters**

  | Param | Required | Description |
  |---|---|---|
  | `artist` | Yes | Artist name (URL-encoded). |

* **Success Response:** 200

  ```json
  {
    "artists": ["Iggy Pop", "Iggy & The Stooges", "Lou Reed"],
    "displayArtists": ["Iggy Pop", "Lou Reed"],
    "displayVariantMap": { "Iggy Pop": ["Iggy Pop", "Iggy & The Stooges"], "Lou Reed": ["Lou Reed"] },
    "variantRankMap": { "Iggy Pop": 1, "Iggy & The Stooges": 1, "Lou Reed": 2 }
  }
  ```

  | Field | Description |
  |---|---|
  | `artists` | Every library artist name that matches one of Last.fm's similar artists (up to 50 from Last.fm). |
  | `displayArtists` | Last.fm names, in similarity order, that have at least one album in the user's vpaths. |
  | `displayVariantMap` | Last.fm name → library variants, for the names in `displayArtists`. |
  | `variantRankMap` | Library variant → 1-based Last.fm rank (lower = more similar). |

  When Last.fm knows nothing about the exact credit, the server retries with the
  parts of a collaboration credit (e.g. "A feat. B"). Returns empty lists when
  nothing matches. Results are cached (6 h for Last.fm data, 30 min for the
  library resolution).

* **Notes**
  - Scrobbling (POST `/api/v1/lastfm/scrobble-by-filepath`) needs the user to link a
    Last.fm account (`POST /api/v1/lastfm/connect`); see [lastfm.md](lastfm.md).
