# Velvet Debug Options

This file documents the debug options and diagnostic logs currently in the code.

## 1) Server: Auto-DJ log lines (always on)

There is no switch: the server always writes short `[autodj]` lines to its log (stdout, so `journalctl` on a
systemd install).

| Line | Written by | When |
|---|---|---|
| `[autodj] pool user=… → N candidates (…)` | `src/api/db.js` | Every `POST /api/v1/db/random-songs` Auto-DJ batch |
| `[autodj] similar-artists "…" → N from Last.fm …, M in library` | `src/api/scrobbler.js` | Every similar-artist lookup (or `→ 0 (tried: …)` when none) |
| `[autodj] ▶ user: "artist — title" score=… cands=… similar=… \| bpm a→b key … year … genre …` | `src/util/autodj-log.js` | When the web player reports the start of an Auto-DJ pick (`POST /api/v1/wrapped/play-start` with `source=autodj` and a `dj` trace) |
| `[autodj] radio user=… seed="…" → n/count tracks …` | `src/autodj/library.js` | Server-side radio chain (Subsonic similar songs) |
| `[autodj] <label> user=… after "…" → "…" in …ms (…)` | `src/autodj/library.js` | Server-side next pick (Velvet Rooms, `POST /api/v1/autodj/next`) |

### Watch logs
```bash
journalctl -fu music.service | grep autodj
```

## 2) Browser: boot/play restore tracing (`localStorage.ms2_dbg_boot`)

### What it does
Enables verbose `[BOOT]` console warnings in `webapp/app.js` for:
- restoreQueue lifecycle
- AudioContext state/resume behavior
- play/pause guard paths
- stalled/reload recovery path

### Enable (DevTools console)
```js
localStorage.ms2_dbg_boot = '1';
location.reload();
```

### Disable
```js
localStorage.removeItem('ms2_dbg_boot');
location.reload();
```

## 3) Browser: Auto-DJ pick reasoning (console)

`_djPickSong()` in `webapp/app.js` logs each pick with `console.debug`:
`[Auto-DJ] picked from N candidates: artist — title | bpm=… key=… score=…`. Show "Verbose" messages in the DevTools
console to see it. Similar-artist lookups and genre escapes are logged with `console.log` (`[Auto-DJ] Last.fm similar
to …`, `[Auto-DJ] Genre escape: …`).

The only hard block in the browser Auto-DJ is the keyword filter (`_djSongBlocked`); BPM, key, genre and similar
artists are scored, not filtered, so there are no per-candidate rejection logs.

## 4) Fast troubleshooting flow for Auto-DJ

1. `journalctl -fu music.service | grep autodj`
2. In the browser console, enable Verbose messages.
3. Reproduce with Auto-DJ and compare:
   - the pool size the server returned (`[autodj] pool …`)
   - the similar-artist result (`[autodj] similar-artists …`)
   - the score and context of the pick (`[autodj] ▶ …` on the server, `[Auto-DJ] picked …` in the browser)

When `random-songs` answers `400 No songs that match criteria`, the hard scope (collections, rating, duration window)
matches nothing; the similar-artist list and the cooldown are dropped first before it gets there.

## 5) Scope note

The only runtime debug toggle in the code is `localStorage.ms2_dbg_boot`. The `[autodj]` and `[Auto-DJ]` lines are
always on. Other `console.debug('[velvet]', ...)` occurrences are regular diagnostic logs.
