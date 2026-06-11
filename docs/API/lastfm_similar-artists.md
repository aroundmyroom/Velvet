**Last.fm — Similar Artists** *(GitHub Copilot, 2026-03-04)*
----

Returns artists similar to a given artist via the Last.fm API. Used by the
Auto-DJ "Similar Artists" mode to bias random song selection.

A built-in Last.fm API key is included; no configuration is required.

* **URL:** `/api/v1/lastfm/similar-artists`
* **Method:** `GET`
* **Query Parameters**

  | Param | Required | Description |
  |---|---|---|
  | `artist` | Yes | Artist name (URL-encoded). |

* **Success Response:** 200

  ```json
  { "artists": ["Iggy Pop", "Lou Reed", "T. Rex", "Queen"] }
  ```

  Up to 20 artists, ordered by similarity score descending.
  Returns `{ "artists": [] }` when no results are found or the artist is unknown to Last.fm.

* **Notes**
  - Artist names must match Last.fm's database. Exact tag spelling matters.
  - Scrobbling (POST `/api/v1/lastfm/scrobble-by-filepath`) requires per-user
    Last.fm credentials set in the user config (`lastfm-user`, `lastfm-password`).
