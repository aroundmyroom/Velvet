# Queue Search

Finds a song that's already in your playback queue — without scrolling through
a long list by hand — and jumps you straight to it.

Lives under **Up Next** in the queue panel, above the queue list itself.

---

## How it works

Type an artist name or song title. Every match is highlighted in place with a
gold left-edge marker and the matched text underlined in the title/artist —
the rest of the queue stays visible and in its original order, since order is
what a queue is for. The list automatically scrolls to the first match so you
don't have to hunt for it.

Click a highlighted row to play it, same as any other queue row.

The match count next to the search box shows how many songs matched. Clear
the box (✕ button, or Escape) to remove the highlights.

Matching is case- and accent-insensitive ("café" matches "cafe") and checks
both the track title and the displayed artist (respecting the **album artist**
toggle when that's active for albums-only content).

## Why highlight instead of filter

The file-explorer and library search boxes elsewhere in Velvet hide
non-matching rows. The queue search deliberately does not — a queue's order
tells you what's coming up next, and hiding rows would break that context
(especially with Auto-DJ, where a long queue is exactly when this feature is
most useful). Highlighting keeps the whole queue visible while making the
song you're after easy to spot.

## Scope

Implemented in the desktop/tablet player (`webapp/index.html` +
`webapp/app.js`). The mobile PWA (`webapp/mobile/`) has its own, separate
queue UI and does not currently include this.
