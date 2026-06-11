# Browser Compatibility

## Minimum supported browser

**CleverShare's embedded browser (Chromium-based, ~2021 era)** is the lowest baseline we target.
Nothing older than this will be supported or accommodated.

| Feature required | Minimum version |
|---|---|
| Web Audio API (`AudioContext`) | Chrome 35+ / Firefox 25+ |
| Canvas 2D (`getContext('2d')`) | Universally available |
| `canvas.roundRect()` | Chrome 99+ (Jan 2022) — **polyfilled** |
| CSS Grid / `dvh` units | Chrome 108+ (Nov 2022) |
| `OffscreenCanvas` | Chrome 69+ |

## CleverShare polyfill note

CleverShare's browser predates the native `CanvasRenderingContext2D.roundRect()` API
(shipped Chrome 99, January 2022).  Without it every canvas draw call in the VU
meters, spectrum analyser, and ref-level knob throws a silent `TypeError` and the
canvases stay blank.

A lightweight polyfill is baked into `webapp/v2/app.js` at startup that implements
`roundRect` using standard `arcTo` calls:

```js
if (typeof CanvasRenderingContext2D !== 'undefined' &&
    !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) { … };
}
```

This is the **only** concession made for legacy browsers.  Any further regressions
on CleverShare or other older environments should be investigated case-by-case; we
will not broadly lower the baseline.

## Web Audio failure handling

If a browser does not expose `AudioContext` or `webkitAudioContext` at all, the app
detects this once at load time via the `_webAudioSupported` flag and:

- hides the entire VU / spectrum strip (`#vu-spec-row`) gracefully
- skips all `ensureAudio()` calls so no uncaught exceptions occur
- wraps the actual `AudioContext` constructor in a `try/catch` as a runtime safety net

Music playback still works normally — only the visualisation strip is affected.
