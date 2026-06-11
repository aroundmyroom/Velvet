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

## Features

### Chapter navigation
Prev/next chapter buttons appear in the transport bar when the current track is from an `audio-books` vpath. Chapter points come from:
- Embedded chapters in `.m4b` files (extracted via ffprobe at scan time, stored as cuepoints)
- Sidecar `.cue` files alongside an audio file
- CUE data embedded in FLAC files

The **previous chapter** button restarts the current chapter if you are more than 3 seconds into it, or goes to the preceding chapter if you are within 3 s of the chapter start.

### Chapter bar
A thin strip below the main progress bar displays coloured tick marks for every chapter, with the current chapter highlighted in the accent colour.

### Playback speed
A speed button (showing the current multiplier, e.g. `1.25×`) opens a popup with six options: 0.75×, 1×, 1.25×, 1.5×, 1.75×, 2×. The setting is saved per-user in localStorage and restored on the next visit.

Speed control is **only shown** for audiobook tracks — it is automatically hidden during normal music playback.

### Per-book progress
Velvet remembers your position in every audiobook:

- Position is saved every 5 seconds while playing, immediately on pause, and when you close the tab.
- When you re-open a track you were part-way through, playback automatically resumes from where you left off.
- When a track finishes naturally (plays to the end), the saved position is cleared so it starts from the beginning next time.
- Up to 200 book positions are stored simultaneously; the oldest entry is dropped when the limit is reached.

### M4B support
`.m4b` audio-book files are fully supported. Velvet extracts embedded chapter metadata via **ffprobe** in two ways:

1. **At scan time** — when you run a library scan, `src/db/scanner.mjs` calls ffprobe and stores chapters as cuepoints in the database. Subsequent plays read directly from the DB (instant).
2. **On first play (no rescan needed)** — if an `.m4b` was already indexed before this feature was added, the server runs ffprobe automatically the first time you play the file, stores the result, and returns the chapters in the same request.

Chapter navigation appears for any `.m4b` with two or more embedded chapters.

### Chapters appear immediately
Chapter tick marks are rendered as soon as the browser has parsed the file header (the `loadedmetadata` / `durationchange` events), which happens within a second or two even for multi-hour files. Chapter display is completely independent of waveform generation.

### No auto-resume on reload
Audiobooks are never auto-started when the page is reloaded — even if the "Auto-resume on reload" preference is enabled. The saved position is restored and the controls are shown, but the user presses play deliberately.

## Audiobook controls at a glance

| Control | Behaviour |
|---------|-----------|
| ⏮ prev chapter | Restart current chapter (if >3 s in) or go to previous |
| ⏭ next chapter | Jump to the start of the next chapter |
| `1.0×` speed badge | Opens speed popup: 0.75×, 1×, 1.25×, 1.5×, 1.75×, 2× |
| Chapter tick bar | Shows all chapters; current chapter highlighted + labelled |

## Files changed

| File | What changed |
|------|--------------|
| `src/db/scanner.mjs` | `extractM4bChapters()` — runs ffprobe, stores chapters as cuepoints at scan time |
| `src/db/task-queue.js` | Passes `ffprobePath` to scanner via `jsonLoad` |
| `src/api/db.js` | `GET /api/v1/db/cuepoints` — on-demand M4B extraction if file has no cuepoints yet |
| `webapp/index.html` | `#ab-prev-chap-btn`, `#ab-next-chap-btn`, `#ab-speed-btn`, `#ab-speed-pop`, `#ab-chapter-bar` |
| `webapp/style.css` | Audiobook control styles (speed popup, chapter bar, speed label) |
| `webapp/app.js` | `_isAudioBookSong()`, `_updateAudioBookMode()`, `_updateAudioBookChapterBar()`, `_toggleSpeedPop()`, `_applyBookSpeed()`, per-book position save/restore/clear, `durationchange`/`loadedmetadata` listeners, reload-race fix, no-auto-resume guard |
| `webapp/locales/*.json` | 4 new keys: `player.ctrl.prevChapter`, `player.ctrl.nextChapter`, `player.ctrl.playbackSpeed`, `player.audiobook.chapterN` |
