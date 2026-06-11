**Genre Groups** *(GitHub Copilot, 2026-03-22)*

Admin-configurable groupings that control how genres are displayed throughout the app — in the Genre browser, Smart Playlist builder, and the Groups & Genres admin panel.

All admin endpoints require `admin: true` on the user. The user-facing read endpoint is accessible to all authenticated users.

---

## User endpoint: Get genre groups with genres

Returns the genre groups configured by the admin, enriched with the current genre list for the requesting user's vpaths. When no custom groups have been saved, `groups` is `null` and the client falls back to the built-in `GENRE_BUCKETS` classification.

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

- `groups` — array of genre groups in display order. Genres not assigned to any group are appended into an `Other` group automatically. `null` when no custom groups have been saved.
- `genres` — flat merged genre list (all genres regardless of groups), sorted by count descending.

**Notes:**
- Genre names stored in the DB may drift (e.g. `"Rock"` renaming to `"Classic Rock"` after a rescan). The server resolves display names using the current `rawMap` from `mergeGenreRows`. Stale genre names in saved groups are silently dropped.
- The `Other` group is computed at request time and never stored in the DB.

---

## Admin: Get saved groups

Returns the raw saved groups configuration (no genre enrichment).

* **URL:** `GET /api/v1/admin/genre-groups`
* **Auth:** required (admin only)

**Response `200`:**
```json
{
  "groups": [
    { "name": "Rock",       "genres": ["Classic Rock", "Punk", "Metal"] },
    { "name": "Electronic", "genres": ["House", "Techno", "Ambient"] }
  ]
}
```

Returns `{ "groups": [] }` when no groups have been saved yet. On first admin visit, the admin UI auto-seeds from the built-in genre auto-classifier and saves the result.

---

## Admin: Save groups

Replaces the entire saved groups configuration.

* **URL:** `POST /api/v1/admin/genre-groups`
* **Auth:** required (admin only)

**Body:**
```json
{
  "groups": [
    { "name": "Rock",       "genres": ["Classic Rock", "Punk"] },
    { "name": "Electronic", "genres": ["House", "Techno"] }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `groups` | `array` | Yes | Ordered array of group objects. |
| `groups[].name` | `string` | Yes | Group display name (max 200 chars). |
| `groups[].genres` | `string[]` | Yes | Genre display names belonging to this group. |

**Response `200`:** `{}`

**Notes:**
- The `Other` catch-all group is not stored; it is always computed dynamically.
- Auto-save: the admin UI posts to this endpoint on every mutation (drag, add, remove, rename) — no explicit save button needed.

---

## Storage

Genre groups are stored as JSON in the DB under a single settings key:

```sql
-- SQLite: settings table
INSERT OR REPLACE INTO settings (key, value) VALUES ('genre_groups', '[{"name":"Rock","genres":[...]}]');
```

For the Loki in-memory backend, groups are stored in the `settings` collection with the same key.
