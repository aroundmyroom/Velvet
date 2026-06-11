# Keyboard Shortcuts

All shortcuts are global and work as long as focus is **not** inside a text
input or editable field (e.g. the search box, playlist rename field).

## Playback

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `←` | Seek back 5 seconds |
| `→` | Seek forward 5 seconds |
| `Shift` + `←` | Previous track |
| `Shift` + `→` | Next track |

## Volume

| Key | Action |
|-----|--------|
| `↑` | Volume +5% |
| `↓` | Volume −5% |
| `M` | Mute / Unmute toggle |

## Queue & UI

| Key | Action |
|-----|--------|
| `S` | Toggle shuffle |
| `Esc` | Close modal / visualizer / context menu |

## Notes

- Arrow keys (`←` `→` `↑` `↓`) without `Shift` always control **seek and
  volume** — they will not accidentally skip tracks.
- Use `Shift+←` / `Shift+→` to skip tracks from the keyboard.
- `M` cleans up after itself: un-muting restores the previous volume level.
- Shortcuts are implemented in `webapp/v2/app.js` in the
  `// Keyboard shortcuts` block near the bottom of the file.
