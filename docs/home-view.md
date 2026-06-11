# Home View *(GitHub Copilot, 2026-03-27)*

The Home view (`🏠` nav icon) provides a personalised landing page with up to five shelves of content. It is the first screen after login.

---

## Shelves

Each shelf shows a single horizontal row of cards. The number of cards is calculated at load time to exactly fill one row at the current screen width (based on `content-body.clientWidth`, card width 120 px, gap 10 px, minimum 4 cards).

| Shelf ID | Title | Content | Card type |
|---|---|---|---|
| `radio` | Radio Stations | All configured radio streams | Art card (logo / no-art fallback) |
| `podcasts` | Podcasts | All subscribed podcast feeds | Art card (feed art / no-art fallback) |
| `playlists` | Playlists & Folders | All library root folders + saved playlists | Icon card |
| `recent` | Recently Played | Songs most recently played (dynamic, never pinnable) | Art card (album art) |
| `most` | Most Played | Songs with highest play count (dynamic) | Art card (album art) |

A shelf is only rendered if it has at least one item. Empty shelves (all items deselected in Customize mode) are hidden outside edit mode.

---

## Drag to Reorder

Every shelf header contains a **grip handle** (⠿ six-dot icon). Drag from the grip to move a shelf up or down. The new order is saved to `localStorage` (key `ms2_home_order_<username>`) and restored on every subsequent visit.

Default order (used when no saved order exists): `radio → podcasts → playlists → recent → most`.

---

## Customize Mode

A **Customize** button appears in the header of the first shelf. Clicking it toggles edit mode on the whole home view.

### In edit mode

- All cards are shown, including previously hidden ones.
- **Selected** (visible) cards get a coloured border ring.
- **Deselected** (hidden) cards are dimmed to 30 % opacity.
- Click any card to toggle it between selected and deselected.
- Shelves with zero selected cards remain visible so you can re-add items.
- Click **Done** to exit edit mode.

### In normal mode

- Deselected cards are completely hidden.
- Shelves where every card has been deselected are hidden entirely (they reappear when Customize is opened).
- Song shelves (Recently Played, Most Played) are never affected by Customize — they are always shown and have no per-item toggle.

Hidden card IDs are stored in `localStorage` (key `ms2_home_hidden_<username>`).

---

## Recently Played — how plays are recorded

A play is logged by calling `POST /api/v1/db/stats/log-play` as soon as a track starts playing (see [API docs](API/db_stats-queries.md#log-a-play)).

**This is completely independent of scrobbling.** Last.fm and ListenBrainz are purely optional; Recently Played works even when neither is configured.

The home view re-fetches data fresh from the server on every visit, so it always reflects the current state of the play history.

Radio streams and podcast episodes are never logged and never appear in these shelves.

---

## localStorage keys

| Key | Description |
|---|---|
| `ms2_home_order_<username>` | JSON array of shelf IDs in display order |
| `ms2_home_hidden_<username>` | JSON array of hidden card IDs (`rs:<id>`, `pf:<id>`, `ic:vp:<name>`, `ic:pl:<name>`) |

See [localstorage.md](localstorage.md) for full key reference.
