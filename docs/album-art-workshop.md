# Album-Art Workshop

Admin tool to find and fix album covers across the library. Source priority is
**MusicBrainz / Cover Art Archive first**, then Discogs → Deezer → iTunes.

Open it at **Admin → Album-Art Workshop**. It has two modes.

## Philosophy — detect automatically, apply only on a human decision

The admin keeps **total control** over what is written to the real library on
disk. The workshop may *detect* candidate covers automatically — from a track's
MusicBrainz release id and from targeted searches — but it never decides for you.
The source of truth might be MusicBrainz, Discogs, Deezer or iTunes; **which one
is correct is always the admin's call.**

This matters because the library is not mostly "real" albums. It holds many
singles, 12-inches and loose songs that will never have — or were never meant to
have — album art. A search will happily return plausible-looking covers for these,
so **false positives are expected and common.** The workshop therefore treats
every suggestion as a proposal: it detects and previews, but **nothing is written
to disk until someone confirms it is the right cover.**

## Mode 1 — Missing covers

Finds albums (folders) where **no** track has art and suggests covers.

**Journey: find → preview → apply → verify → restore**

1. **Find** — click **Find missing covers** (global pass, up to 200 albums, paced
   for API rate limits), or **Find missing covers (MusicBrainz)** in the
   MusicBrainz box to fetch only official Cover Art Archive covers for albums that
   have a MusicBrainz release id. Per-album, the **Find cover** button (on a card
   with no suggestion yet) searches just that folder on demand.
2. **Filter** — status chips (Suggested / Pending / Not found / Applied / Skipped /
   Error) and, for Suggested, a **source** row: All · ♪ MusicBrainz · Discogs ·
   Deezer · iTunes (with counts). Use the search box to narrow by artist/album.
3. **Preview** — click any cover (the big one or a small alternate) to open a
   **large preview**. Nothing is applied until you press **Apply this cover** —
   this prevents storing a wrong cover you couldn't see clearly. **Back** returns
   to the grid. When a card's only suggestion is the official Cover Art Archive
   cover, a **Seek alternative covers** button queries Discogs, Deezer and iTunes
   on demand so you have other options to compare against.
4. **Apply** — writes `cover.jpg` into the album folder, caches the image +
   thumbnails, and points every track in the folder at it. Multi-select +
   **Apply best cover to selected** applies the preferred suggestion to many
   albums at once.
5. **Verify** — the **Applied** filter shows each album with the cover that is now
   stored.
6. **Restore** — every apply snapshots the previous art, so the Applied view has a
   **Restore** button that reverts to exactly what was there before (folder cover
   and DB pointers). Restored albums return to Suggested so you can pick again.

### Settings
- **Prefer official Cover Art Archive covers** (on by default) — CAA-first.
- **Auto-approve the best match** — applies the top suggestion automatically.
- **Auto-suggest for newly added folders** — runs after each library scan.
- **Shelve** a folder to hide it (and everything under it) from the workshop.

## Mode 2 — Fix a cover

For albums that **already have a (wrong) cover** — these never appear under
"Missing covers". Search by artist/album, pick the album (its current cover is
shown), then choose a replacement from **all sources** (MusicBrainz + Discogs +
Deezer + iTunes) or paste a **manual URL**. Click a suggestion to preview, then
apply. The same snapshot/restore applies, so a fix is always reversible from the
Applied view.

## How covers are written
- `cover.jpg` is written into the album folder; the cached art + `zs/zl/zm`
  thumbnails go to the art cache; `files.aaFile` / `art_source='workshop'` are set
  for every track. Audio files are **not** modified (no ID3 embedding).
- On apply, the prior `cover.jpg` is backed up to `cover.velvet-prev.jpg` and the
  previous DB art is recorded, enabling exact restore.

## API
See the **Album-Art Workshop** section in [API.md](API.md) for the full endpoint
list (`/api/v1/admin/art/*`).
