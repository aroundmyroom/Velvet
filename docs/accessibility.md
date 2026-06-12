# Accessibility & Keyboard Shortcuts

Velvet's web player is built to work with a keyboard and assistive technology
(screen readers). This page documents the keyboard shortcuts and the
accessibility features added in **v0.1.0**.

## Keyboard shortcuts

Shortcuts are active anywhere in the player **except** while typing in a text
field. Press **`?`** at any time to open an in-app cheat-sheet of this list.

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Seek backward / forward 5 seconds |
| `Shift` + `←` / `→` | Previous / next track |
| `↑` / `↓` | Volume up / down 5% |
| `M` | Mute / unmute |
| `S` | Toggle shuffle |
| `R` | Cycle repeat mode (off → all → one) |
| `/` | Jump to Search and focus the search box |
| `?` | Show / hide this keyboard-shortcuts overlay |
| `Esc` | Close the open dialog, menu, or the Now-Playing / visualizer view |

## Screen-reader & focus features

- **Seek bar** — the progress/seek bars are exposed as ARIA sliders
  (`role="slider"`), are keyboard-focusable, and announce the current position
  (e.g. *“1:23 / 4:05”*, or *“Live stream”* for radio). Use `←` / `→` to scrub.
- **Icon buttons** — icon-only controls carry an `aria-label` (derived from their
  translated tooltip) so screen readers announce what each button does.
- **Dialogs** — every modal is announced as a dialog (`role="dialog"`,
  `aria-modal`), **traps keyboard focus** while open, closes on `Esc`, and
  **returns focus** to the control that opened it when dismissed.
- **Localised** — all labels above are translated through Velvet's i18n system,
  so screen-reader announcements follow the selected language.

## Notes

- The shortcuts never fire while a text input, textarea, or editable field has
  focus, so typing a search term or playlist name is unaffected.
- `?` is `Shift` + `/` on most keyboard layouts.
