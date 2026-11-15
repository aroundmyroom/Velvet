# Browser Compatibility

## Minimum supported browser

**CleverShare's embedded browser (Chromium-based, ~2021 era)** is the lowest baseline we target.
Nothing older than this will be supported or accommodated.

| Feature required | Minimum version |
|---|---|
| Web Audio API (`AudioContext`) | Chrome 35+ / Firefox 25+ |
| Canvas 2D (`getContext('2d')`) | Universally available |
| `canvas.roundRect()` | Chrome 99+ (Jan 2022) — **polyfilled** |
| CSS Grid | Chrome 57+ |
| `dvh` units | Chrome 108+ (Nov 2022) — older browsers fall back to `vh` |

## CleverShare polyfill note

CleverShare's browser predates the native `CanvasRenderingContext2D.roundRect()` API
(shipped Chrome 99, January 2022).  Without it every canvas draw call in the VU
meters, spectrum analyser, and ref-level knob throws a silent `TypeError` and the
canvases stay blank.

A lightweight polyfill is baked into `webapp/app.js` at startup that implements
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

## Native iOS Players

Native iOS players use standard percent-encoded media URLs. Velvet decodes the
library name and every remaining path segment before resolving the requested file
inside its configured library root. This supports library names with spaces,
including child libraries, while retaining the same root-confinement and access
checks as other media requests.

Over the Subsonic API Velvet reports track bitrate in kbps (`bitRate`): the
scanned bitrate when known, otherwise an average for the file format.

## Web Audio failure handling

If a browser does not expose `AudioContext` or `webkitAudioContext` at all (or has no 2D canvas), the app
detects this once at load time via the `_webAudioSupported` flag and:

- hides the entire VU / spectrum strip (`#vu-spec-row`) gracefully
- skips all `ensureAudio()` calls so no uncaught exceptions occur
- wraps the actual `AudioContext` constructor in a `try/catch` as a runtime safety net

Music playback still works normally — only the visualisation strip is affected.
