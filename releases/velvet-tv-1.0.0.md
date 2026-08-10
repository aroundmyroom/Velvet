# Velvet TV 1.0 — Samsung Smart TV app

The first public release of **Velvet TV**, a native-feeling big-screen client
for your Velvet music server on **Samsung Tizen 5.5+** TVs (2020 models and
newer). Side-load it once and drive your whole library from the couch with the
TV remote.

## Download & install

- **Asset:** `velvet-tv-<version>.wgt` (attached below)
- The build ships **without any server address or credentials** — you sign in to
  your own Velvet server on the TV.

Install with **Apps2Samsung** — a community side-loader that uploads a *custom
WGT file* straight to your TV, no Tizen Studio or developer certificate needed:

- 👉 <https://github.com/Apps2Samsung/Apps2Samsung>

Quick version:

1. On the TV: open **Apps**, type `12345`, enable **Developer Mode**, and enter
   your PC’s IP address.
2. Run **Apps2Samsung** on that PC and point it at the TV’s IP.
3. Choose **Custom WGT file → `velvet-tv-<version>.wgt` → Install**.
4. Launch **Velvet TV**, enter your server URL + login, and you’re in.

Full guide: [`docs/tizen-tv.md`](https://github.com/aroundmyroom/Velvet/blob/main/docs/tizen-tv.md).

## What’s inside

**Browse & play**
- Home, **Albums**, **Artists**, **Playlists** and **Auto-DJ**, streamed from
  your own server.
- **CUE-sheet albums** are split into individual tracks — selecting a track
  seeks to its start and stops cleanly at the boundary, auto-advancing.
- **Multi-disc sets** are grouped under disc headers (“CD 1”, “Disc 2”, …).
- Each album shows **year • track count • total duration**; the currently
  playing track is highlighted.
- **A–Z quick-jump strip** on the Albums view — press **Right**, pick a letter,
  jump straight to it. Only letters that have albums are shown.

**Remote-first UX**
- Complete D-pad navigation across menu, grid, A–Z strip and player bar.
- Dedicated **media keys** wired up: Play/Pause, Fast-Forward → next,
  Rewind → previous, Stop → pause.
- **Now Playing** overlay with a large VU meter and a **waveform seek bar**
  (scrub with Left/Right).
- Built-in **MilkDrop-style visualizer**, launched on demand from the overlay.
- Screen stays awake while music plays.

**Privacy & safety**
- The public `.wgt` contains **no server URL and no credentials** — nothing
  private is baked into a shared build.
- Households that want a pre-configured build can bake in their own server via a
  git-ignored `velvet-tv.config.json` (see the docs); those builds print a clear
  “do not distribute” warning.

## Compatibility

Targets **Tizen 5.5 / Chromium 69**. Audio and visuals avoid the Web Audio API
(which silences audio on Samsung panels) and use Canvas 2D driven by the
server’s pre-computed waveform envelope.

---

_Build the release asset yourself with:_ `npm run build:tizen:dist`
