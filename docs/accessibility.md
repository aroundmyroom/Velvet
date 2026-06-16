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
| `Ctrl` / `⌘` + `K` | Open the command palette — fuzzy jump to any view or transport action |
| `?` | Show / hide this keyboard-shortcuts overlay |
| `Esc` | Close the open dialog, menu, command palette, or the Now-Playing / visualizer view |

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
- **Focus ring** — a clear `:focus-visible` outline follows keyboard navigation
  across nav buttons, icon buttons, song/queue rows, cards and sliders. It is
  shown only for keyboard interaction, never for mouse or touch.
- **Toasts** — status messages announce politely (`role="status"`); errors
  announce assertively (`role="alert"`). Multiple toasts stack rather than
  replacing one another, and may offer an action (e.g. **Retry**).
- **Now-playing announcements** — a visually-hidden polite live region
  (`role="status"`, `aria-live="polite"`) announces *“Now playing: &lt;title&gt; —
  &lt;artist&gt;”* whenever the track changes.

## Themes & contrast

Five themes are available from the sidebar switcher: **Velvet** (default), **Dark**,
**Light**, **High contrast**, and **Colorblind-safe**. The choice persists per user.

- **WCAG AA** — normal text meets the 4.5:1 contrast minimum in Velvet, Dark and
  Light. **High contrast** pushes well past AAA (white text on black, with a yellow
  accent for controls/fills so they never blend into white text or borders).
  **Colorblind-safe**
  uses a blue/orange palette that never relies on red↔green distinctions
  (deuteranopia/protanopia friendly).

## Reduced motion

Velvet honours the operating-system *“reduce motion”* preference
(`prefers-reduced-motion`). When it is enabled, all CSS animations and
transitions are neutralised, and the auto-triggered JavaScript animations — the
Auto-DJ dice throw and the scrolling-title marquee — are skipped. Loading
**skeleton** placeholders still render, just without their shimmer sweep.

## Notes

- The shortcuts never fire while a text input, textarea, or editable field has
  focus, so typing a search term or playlist name is unaffected.
- `?` is `Shift` + `/` on most keyboard layouts.
