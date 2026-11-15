# Audiobook mode

Velvet has dedicated audiobook support for vpaths configured with `type: "audio-books"`.

## Configuration

In your config, set the vpath type to `audio-books`:

```json
"AudioBooks-Podcasts": {
  "root": "/media/music/Audiobooks & Podcasts",
  "type": "audio-books"
}
```

A child vpath (a sub-folder of another library) can also be of type
`audio-books`; its files count as audiobooks too.

Audiobook folders are left out of Auto-DJ and of the Home shelves.

## Features

### Chapter navigation
Prev/next chapter buttons appear in the transport bar for any file with chapter
marks (not only audiobooks). Chapter points come from:
- Embedded chapters in `.m4b` files (extracted via ffprobe, stored as cuepoints)
- Sidecar `.cue` files alongside an audio file
- CUE data embedded in the audio file (e.g. FLAC)

The **previous chapter** button restarts the current chapter if you are more than 3 seconds into it, or goes to the preceding chapter if you are within 3 s of the chapter start.

### Chapter indicator
A small line in the player shows *Chapter N of M* and the chapter title
(*Track N of M* for a non-audiobook file with CUE tracks).

### Playback speed
A speed button (showing the current multiplier, e.g. `1.25×`) opens a popup of speed options. The chosen speed is saved per user in localStorage (`ms2_book_speed_<username>`) and restored on the next visit.

Speed control is **only shown** for audiobook tracks; normal music always plays at 1×.

### Per-book position
Velvet remembers your position in every audiobook file:

- Position is saved every 5 seconds while playing and immediately on pause.
- When you re-open a file you were part-way through, playback resumes from where you left off.
- When a file finishes naturally (plays to the end), the saved position is cleared so it starts from the beginning next time.
- Up to 200 positions are stored; the oldest entry is dropped when the limit is reached.
- Positions live in localStorage (`ms2_book_positions_<username>`) and are also saved to your user settings, so they follow you to other browsers.

### M4B support
Velvet extracts embedded `.m4b` chapter metadata via **ffprobe** in two ways:

1. **At scan time** — `src/db/scanner.mjs` calls ffprobe and stores chapters as cuepoints in the database. Later plays read them from the DB.
2. **On first play (no rescan needed)** — if a file has no cuepoint data yet, `GET /api/v1/db/cuepoints` runs ffprobe the first time you play it, stores the result, and returns the chapters in the same request.

Chapters are used for any `.m4b` with two or more embedded chapters.

### Chapters appear immediately
The chapter indicator is updated as soon as the browser has parsed the file header (the `loadedmetadata` / `durationchange` events), which happens within a second or two even for multi-hour files. It does not wait for the waveform.

### No auto-resume on reload
Audiobooks are never auto-started when the page is reloaded — even if the "Auto-resume on reload" preference is enabled. The saved position is restored and the controls are shown, but you press play yourself.

## Audiobook controls at a glance

| Control | Behaviour |
|---------|-----------|
| ⏮ prev chapter | Restart current chapter (if >3 s in) or go to previous |
| ⏭ next chapter | Jump to the start of the next chapter |
| `1×` speed badge | Opens the speed popup |
| Chapter indicator | *Chapter N of M* + chapter title |

## Where it lives

| File | What |
|------|------|
| `src/db/scanner.mjs` | `extractM4bChapters()` — runs ffprobe, stores chapters as cuepoints at scan time |
| `src/db/task-queue.js` | Passes `ffprobePath` to the scanner |
| `src/api/db.js` | `GET /api/v1/db/cuepoints` — on-demand M4B / CUE extraction if the file has no cuepoints yet |
| `webapp/index.html` | `#ab-prev-chap-btn`, `#ab-next-chap-btn`, `#ab-speed-btn`, `#ab-speed-pop`, `#ab-chapter-bar` |
| `webapp/style.css` | Audiobook control styles (speed popup, chapter indicator, speed label) |
| `webapp/app.js` | `_isAudioBookSong()`, `_updateAudioBookMode()`, `_updateAudioBookChapterBar()`, `_toggleSpeedPop()`, `_applyBookSpeed()`, per-book position save/restore/clear, no-auto-resume guard |
| `webapp/locales/*.json` | `player.ctrl.prevChapter`, `player.ctrl.nextChapter`, `player.ctrl.playbackSpeed`, `player.audiobook.chapterN`, `player.audiobook.trackN` |
