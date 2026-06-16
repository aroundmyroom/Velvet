# Player UI/UX Improvement Plan

A staged plan to improve the **main web player** (`webapp/index.html` + `webapp/app.js` + `webapp/style.css`). Scope is the player surface only — admin (`webapp/admin/`) and the separate mobile build (`webapp/mobile/`) are out of scope here.

Each wave ships as its own `feat/…` branch → PR → CI gate → human merge, so nothing is a big-bang change. Version bumps belong to `/release`, not the feature PRs.

## Status at a glance

| Wave | Theme | Status |
|---|---|---|
| 1 | Perceived performance & feedback | ✅ **Merged** (PR #7) |
| 2 | Empty states & onboarding | ✅ **Merged** (PR #9) |
| 3a | Command palette (`Cmd/Ctrl+K`) | ✅ **Merged** (PR #10) |
| 3b | Queue: jump-to-now-playing + drag drop-indicator | ✅ **Merged** (PR #12) |
| 3c | Queue multi-select + synced lyrics | 📋 Planned (follow-up PRs) |
| 4 | Visual delight (buffered bar + view cross-fade; album-art accent already existed) | ✅ **Merged** (PR #14) |
| — | Reliability: localStorage queue-persistence fix + content-hash cache-busters | ✅ **Merged** (PR #16, #17) |
| 5 | Design-system foundation | 📋 Planned |
| 6 | Accessibility deltas | 📋 Planned |

Legend: ✅ merged · 🔄 in review · 📋 planned

---

## Already in Velvet — deliberately NOT re-built

Exploration confirmed these already exist; the plan excludes them to avoid duplicate work (philosophy: *fewer things, landed safely*):

- Keyboard shortcuts (Space / seek / skip / volume / M / S / R / `/`) **and** the `?` cheat-sheet overlay
- ARIA `role="slider"` seek bars; modals with `role="dialog"`, focus-trap, focus-return, `Esc`-to-close
- `aria-label` on icon-only buttons (from translated tooltips)
- Three themes (Velvet / Dark / Light) with `localStorage` persistence + `color-scheme`
- EQ, crossfade, gapless, Auto-DJ, sleep timer, ReplayGain, transcode, visualizers
- Drag-drop queue reorder (virtual-scrolled), context menu, now-playing modal, toasts
- Customizable, draggable Home shelves
- **Per-device density persistence** (comfy/compact/list) — already saved to `localStorage` in every view

---

## Wave 1 — Perceived performance & feedback ✅ Merged (PR #7)

What shipped:

1. **Skeleton loaders** — shimmer placeholders shaped like the result (Artists, Album Library, search, Home shelves) via `skeletonGrid` / `skeletonRows` / `skeletonShelf`.
2. **`prefers-reduced-motion`** — global CSS reset neutralises all animation/transition; a `_reducedMotion()` JS guard skips the Auto-DJ dice throw and title marquee.
3. **`:focus-visible` ring** — new per-theme `--focus` token; keyboard-only outline on nav/icon buttons, rows, cards, sliders.
4. **Stacking toasts** — stack instead of overwrite, announce via `role="status"` / `role="alert"`, support an optional action button.
5. **Optimistic add-to-playlist** — instant confirmation with a **Retry** action on failure.

> Also landed alongside: a CI fix to install `ffmpeg` on the test runner (the test fixtures generate audio via `ffmpeg`).

---

## Wave 2 — Empty states & onboarding 🔄 PR #9 (open)

What's in the PR:

1. **Reusable `emptyState()`** — icon + title + message + optional CTA. Unifies the previously inconsistent placeholders for: empty queue, empty playlist, no starred songs, zero search results. CTAs route through the sidebar via one delegated listener.
2. **First-run tip strip** — a quiet, dismissible strip on Home pointing at the `?` shortcuts overlay and Auto-DJ; gated on `localStorage` `velvet.seen.intro`, shown once.
3. **Density persistence — *skipped, already done*.** The comfy/compact/list toggle already persists per-device via `localStorage`. Only cross-device sync (via `user_settings`) would be net-new, and it's low-value — deferred unless you want it.

---

## Wave 3 — Discoverability & power-user UX 📋 Next

1. **Command palette (`Ctrl`/`Cmd`+`K`)** — the headline feature. A fuzzy launcher to jump to any view, run an action (play/pause, shuffle, start Auto-DJ, open EQ), or search the library. Registers in the same global keydown handler that powers `?`. Highest delight-per-effort item in the whole plan.
2. **Queue quality-of-life** — a *jump-to-now-playing* button, a real *drop-indicator line* during drag (today only a background highlight), and optional *multi-select* for bulk remove / add-to-playlist.
3. **Up-next peek** — hovering the Next button previews the upcoming track (title + art).
4. **Synced lyrics panel** *(larger; needs an API check first)* — a Lyrics service already exists in admin; surface it client-side as an opt-in panel in the now-playing modal.

Suggested split: ship #1 (command palette) on its own; #2–#3 as a second PR; #4 only after confirming the lyrics API.

---

## Wave 4 — Visual delight & cohesion 📋 Planned

1. **Album-art dynamic accent** — extend the existing `_applyAlbumArtTheme` hook so the now-playing view tints accents from cover art (with a `lockAccent` guard, already noted in `docs/dev/todo.md`).
2. **View Transitions API** — soft cross-fade between views (`document.startViewTransition`) with a reduced-motion fallback.
3. **Buffered-range indicator** on the progress bar (how much is loaded behind the playhead).

---

## Wave 5 — Design-system foundation 📋 Planned (touches many files — do incrementally)

1. **Spacing + type scale tokens** — introduce `--sp-1…--sp-8` and a `--type-*` scale, then migrate player components off ad-hoc px values. Per-component, not big-bang, to keep diffs reviewable.
2. **Button variant classes** — `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.btn-icon` to replace inconsistent inline-style buttons in player modals.
3. **Icon system pass** — consolidate the mix of inline SVG / CSS-mask data-URIs / static files behind one convention (sprite or shared `icon()` helper).

---

## Wave 6 — Accessibility deltas 📋 Planned

1. **`aria-live` now-playing announcement** — a visually-hidden live region that announces track changes to screen readers.
2. **Colorblind-safe / high-contrast themes** — align with the existing *Customizable Themes* plan in `docs/dev/todo.md` (hue wheel + contrast-ratio display + deuteranopia/protanopia/tritanopia/high-contrast presets) rather than building a parallel one.
3. **Contrast + WCAG audit** — set an AA target and fix failing pairs (notably the low-contrast `--t3`/`--t4` text on dark surfaces).

---

## Recommended sequencing

Waves 1–2 (highest felt impact, lowest risk) first — done / in review. **Wave 3's command palette** is the standout "wow" and lands independently. Waves 5–6 are foundational/long-tail and best done incrementally so each diff stays small and reviewable.

## Constraints that govern every wave

- **Worktree, not production.** All work happens in `/home/velvet-work/<name>` on a `feat/…` branch → PR → CI gate. `/home/velvet` stays on `main`. Never push `main` or merge without an explicit order.
- **i18n mandatory.** Every new user-visible string gets a `player.*` key in **all 12 locale files** (en + nl authored, the other 10 seeded with English). `node scripts/locale-parity.cjs` must be green.
- **Gates before commit.** `npm test` (216), locale parity, `node scripts/sync-webapp-version.cjs` (no diff), and the artist-placeholder regression (47 checks) when artist/album views are touched.
- **No version bump in feature PRs** — that's `/release`.

## How each wave is verified

- Develop in a worktree; if a live check is needed, run a second instance on a non-3000 port — never restart `music.service` for unmerged code.
- Local: `npm test`, `node scripts/locale-parity.cjs`, `node scripts/sync-webapp-version.cjs`, `node --check webapp/app.js`.
- Behaviour check in a real browser (skeletons on slow loads, focus ring on Tab, reduced-motion, command palette on `Cmd-K`, empty-state CTAs, toast stacking/Retry) — these can't be driven headlessly.
- Confirm no regression to existing keyboard shortcuts, the `?` overlay, or modal focus-traps.
