**Genre Groups**

Admin-configurable groupings that control how genres are displayed throughout the app — in the Genre browser, Smart Playlist builder, and the Groups & Genres admin panel.

The admin endpoints require `admin: true` on the user. The user-facing read endpoint is accessible to all authenticated users.

---

## User endpoint: Get genre groups with genres

Returns the genre groups configured by the admin, enriched with the current genre list for the requesting user's vpaths. When no custom groups have been saved, the server builds the groups automatically with the built-in classifier (`src/util/genre-merge.js`), the same grouping the admin panel starts from.

* **URL:** `GET /api/v1/db/genre-groups`
* **Auth:** required (any user)

**Response `200`:**
```json
{
  "groups": [
    {
      "name": "Rock",
      "genres": [
        { "genre": "Classic Rock", "cnt": 312 },
        { "genre": "Punk",         "cnt": 87 }
      ]
    },
    {
      "name": "Other",
      "genres": [
        { "genre": "Spoken Word", "cnt": 3 }
      ]
    }
  ],
  "genres": [
    { "genre": "Classic Rock", "cnt": 312 },
    { "genre": "Electronic",   "cnt": 210 }
  ]
}
```

- `groups` — array of genre groups in display order. Groups left with no genres in the user's library are dropped. Genres not assigned to any group are appended to a group named `Other` (an existing saved group named "other", any case, is reused). Never `null`: without saved groups the automatic groups are returned.
- `genres` — flat merged genre list (all genres regardless of groups), sorted by count descending.

**Notes:**
- Genre names stored in the DB may drift (e.g. `"Rock"` renaming to `"Classic Rock"` after a rescan). The server resolves display names using the current `rawMap` from `mergeGenreRows`. Stale genre names in saved groups are silently dropped.
- The computed `Other` group is never stored in the DB.

---

## Admin: Get groups

Returns the saved groups, normalised to the current genre display names (genres no longer in the library are dropped). When nothing is saved yet, the server returns an automatic grouping from the built-in classifier and sets `isDefault: true`.

* **URL:** `GET /api/v1/admin/genre-groups`
* **Auth:** required (admin only)

**Response `200`:**
```json
{
  "groups": [
    { "name": "Rock",       "genres": ["Classic Rock", "Punk", "Metal"] },
    { "name": "Electronic", "genres": ["House", "Techno", "Ambient"] }
  ],
  "allGenres": ["Classic Rock", "House", "Punk", "Techno"],
  "isDefault": false
}
```

- `allGenres` — every merged genre display name in the admin's library.
- `isDefault` — `true` when the groups are the automatic defaults (nothing saved). The admin UI then saves them straight away.

---

## Admin: Save groups

Replaces the entire saved groups configuration. The body is the array itself (not wrapped in an object).

* **URL:** `POST /api/v1/admin/genre-groups`
* **Auth:** required (admin only)

**Body:**
```json
[
  { "name": "Rock",       "genres": ["Classic Rock", "Punk"] },
  { "name": "Electronic", "genres": ["House", "Techno"] }
]
```

| Field | Type | Required | Description |
|---|---|---|---|
| `[].name` | `string` | Yes | Group display name (max 120 chars). |
| `[].genres` | `string[]` | Yes | Genre display names belonging to this group (max 200 chars each). |

**Response `200`:** `{ "ok": true }` — `400` with `{ "error" }` when the body does not validate.

**Notes:**
- Posting `[]` clears the saved groups (the admin UI's reset).
- The admin UI posts to this endpoint on every change (drag, add, remove, rename) — there is no separate save button.

---

## Storage

Genre groups are stored as one JSON value in the SQLite `genre_groups` table (single row, `id = 1`, column `groups`).
