# Visualizer

Open the full-screen visualizer with the visualizer button in the player bar
(or from the Now Playing view). Move the mouse to show the top bar; `Esc`
closes it.

## Modes

The mode button cycles through five modes:

| Mode | What it shows | Changing the look |
|---|---|---|
| **Milkdrop** | Butterchurn port of Winamp's MilkDrop, thousands of presets, auto-cycles every 15 s | Previous / next preset buttons |
| **Spectrum** | Seven built-in canvas displays (bars, mirror, radial, oscilloscope, waterfall, VU needles, Lissajous) | Click the picture |
| **AudioMotion** | audioMotion-analyzer with six curated presets | Click the picture |
| **Lyrics** | Album art with synced lyrics | — |
| **VoltViz** | 50+ modern WebGL/WebGPU styles by Sander de Wildt | Previous / next buttons or the style list |

## VoltViz

- **Choosing a style.** The previous/next buttons step through the styles and
  the name appears in the bar. The style list next to them groups all styles
  and jumps straight to one. The chosen style is remembered per user in this
  browser (`voltviz_style`, see [localstorage.md](localstorage.md)); if a
  remembered style no longer exists, the first style is used.
- **WebGPU styles** are listed only when the browser exposes WebGPU
  (`navigator.gpu`) *and* returns a GPU adapter. Everything else needs WebGL
  or a plain canvas.
- **Tempo.** For tracks with an analysed BPM (see [bpm-harmonic.md](bpm-harmonic.md))
  the BPM is handed to VoltViz (`bpm` / `setBpm`) and updated on every track
  change; without one it gets `null`. The styles react to the audio itself
  either way.
- **Loading.** The VoltViz code (`webapp/assets/js/lib/voltviz/`) is
  downloaded the first time you select the mode, not at player start-up.
  While it loads the bar shows *Loading VoltViz…*.
- **When it can't run.** If the module cannot load or the browser/GPU cannot
  create the renderer, a message appears and the visualizer returns to the
  previous mode. A single style that the GPU rejects shows a message and the
  previous style stays.
- **Resources.** Switching to another mode or closing the visualizer destroys
  the VoltViz renderer, so no animation or GPU work keeps running in the
  background.

## What the visualizer listens to

All audio-reactive modes (Milkdrop, Spectrum, AudioMotion, VoltViz) read the
browser's own audio graph *after* the EQ and ReplayGain, so they show what you
hear. Nothing is connected to the speakers twice.

They need the browser's audio engine: play a song first, otherwise the
visualizer asks you to. When the music plays on another output (a Velvet Room,
Sonos, server audio), VoltViz behaves exactly like the other audio-reactive
modes: it reacts to whatever runs through this browser's audio graph (when
casting, that graph keeps running muted so the meters and visualizers stay
fed).
