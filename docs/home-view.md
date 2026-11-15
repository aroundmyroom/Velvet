# Home and Shortcuts views

The player has two landing views in the left nav:

- **Home** (house icon) — a personal summary of what you play. It opens after
  login unless you pinned another start view.
- **Shortcuts** (four-squares icon) — shelves of radio stations, podcasts,
  folders, playlists and songs that you can re-order and hide.

Both views fetch fresh data from the server on every visit. Audiobook
libraries are left out of the song shelves.

The number of cards per shelf is worked out at load time from the width of
`content-body` (130 px per card): at least 6 on Home, at least 4 on Shortcuts.

---

## Home

From top to bottom:

| Section | Content |
|---|---|
| Greeting | "Good morning / afternoon / evening, *name*", plus a stats strip: songs played today, this week, and the listening streak in days (shown from 2 days). A one-time tip strip can appear below it until dismissed. |
| Recently Added | Recently added songs grouped by album folder (a `CD1`/`Disc 2` sub-folder counts as its album), with a **NEW** badge. Click opens the album with the new songs marked. |
| Continue Listening | Recently played songs, one per album. |
| Yesterday / Last Week, Same Day / Last Month, Same Day / Last Year, Same Day | Up to 10 songs you played on that day (`GET /api/v1/db/home-summary`). A section only appears once your play history is at least that old (1, 7, 30, 365 days). |
| Nostalgia / Current Favourites | Your most played songs, split by year: songs from more than 10 years ago are Nostalgia, the rest Current Favourites. Each needs at least 3 songs; if neither has 3, a plain **Most Played** shelf is shown instead. |

Empty sections are not shown. Clicking a song card plays it.

---

## Shortcuts

| Shelf ID | Title | Content |
|---|---|---|
| `radio` | Radio Stations | All configured radio streams |
| `podcasts` | Podcasts | All subscribed podcast feeds |
| `playlists` | Playlists & Folders | Your library folders + saved playlists |
| `recent` | Recently Played | Songs most recently played |
| `most` | Most Played | Songs with the highest play count (play count shown) |

When a Last.fm API key is set, up to two **Because you listened to *artist***
shelves are added at the end: two random artists from your most played songs,
filled with library songs by similar artists.

A shelf is only shown if it has at least one item.

### Drag to reorder

Every shelf header has a **grip handle** (six-dot icon). Drag from the grip to
move a shelf up or down. Default order: `radio → podcasts → playlists → recent → most`.

### Customise

The **Customise** button above the shelves toggles edit mode:

- All cards are shown; hidden cards are dimmed.
- Click a radio, podcast, folder or playlist card to hide or show it.
- Shelves where every card is hidden stay visible so you can bring cards back.
- Click **Done** to leave edit mode.

Outside edit mode hidden cards are not shown, and a shelf where every card is
hidden is not shown either. Song shelves have no per-card toggle.

### Where this is stored

| Key | Description |
|---|---|
| `ms2_home_order_<username>` | JSON array of shelf IDs in display order |
| `ms2_home_hidden_<username>` | JSON array of hidden card IDs (`rs:<id>`, `pf:<id>`, `ic:vp:<name>`, `ic:pl:<name>`) |

Both are kept in `localStorage` and also saved to your user settings
(`home_order`, `home_hidden` prefs) so they follow you to other browsers. See
[localstorage.md](localstorage.md) for the full key reference.

---

## How plays are recorded

A play is logged with `POST /api/v1/db/stats/log-play` as soon as a track
starts (see [API docs](API/db_stats-queries.md#log-a-play)).

**This is independent of scrobbling.** Last.fm and ListenBrainz are optional;
Recently Played and the Home sections work without them.

Radio streams and podcast episodes are never logged and never appear in these
shelves.
