**Similar Artists**
----

Returns artists similar to a given artist from the source chosen under
Admin → Similar artists (ListenBrainz, TIDAL or Last.fm, see
[similar-artists.md](../similar-artists.md)), resolved to the artist names that
exist in your library. Used by the Auto-DJ "Similar Artists" mode, the artist
page, Playing Now and the Home shelves. The path keeps `lastfm` for
compatibility.

When the source is off or not set up (`similarArtists` is `false` in
`GET /api/v1/lastfm/status`) the endpoint returns `{ "artists": [] }`.

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
  | `artists` | Every library artist name that matches one of the source's similar artists (up to 100), by name or by MusicBrainz artist ID. |
  | `displayArtists` | Source names, in similarity order, that have at least one album in the user's vpaths. |
  | `displayVariantMap` | Source name → library variants, for the names in `displayArtists`. |
  | `variantRankMap` | Library variant → 1-based source rank (lower = more similar). |

  When the source knows nothing about the exact credit, the server retries with
  the parts of a collaboration credit (e.g. "A feat. B"). Returns empty lists
  when nothing matches. Source answers are stored in the database for 30 days
  (empty answers 7 days) with 6 h in memory on top; the library resolution is
  cached for 30 min.

* **Notes**
  - Scrobbling (POST `/api/v1/lastfm/scrobble-by-filepath`) needs the user to link a
    Last.fm account (`POST /api/v1/lastfm/connect`); see [lastfm.md](lastfm.md).
