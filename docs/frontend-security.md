# Frontend Security Notes

This guide covers the DOM-safe patterns used in the Velvet frontend.

## Safe rendering rules

- Use `textContent` for plain labels, counts, and status strings.
- Use `setAttribute` or `dataset` for attribute values that come from data.
- Escape user-controlled values before building HTML strings.
- Avoid inline event handlers when the handler argument includes user data.

## Where this matters

- `webapp/assets/js/i18n.js` shows how to build a toast without raw `innerHTML`.
- Mobile screens in `webapp/mobile/app.js` already use escaped render helpers; keep that pattern when adding new markup.

## Practical rule

If a value can come from the library, config, playlist name, artist name, or metadata, treat it as untrusted until it is escaped or written with `textContent`.

## Escaping helpers and where they are not enough

- `esc()` in `webapp/app.js`, `webapp/mobile/app.js` and `webapp/shared/app.js`, and `_esc()` in `webapp/admin/index.js`, escape `& < > "`. They are safe for HTML text and **double-quoted** attributes only.
- They do **not** make a value safe inside an inline event handler (`onclick="f('${esc(x)}')"`): the browser decodes the entities before running the JavaScript. Put the value in a `data-*` attribute and attach the handler with `addEventListener`.
- URLs from outside the library (Deezer, iTunes, Discogs, radio logos) still go through `esc()` inside `src="…"`; a `"` in a remote value would otherwise end the attribute.
- `t(key, params)` interpolates params raw. Escape any untrusted param when the translated string ends up in `innerHTML` or `v-html` (the admin confirm dialog renders title and message with `v-html`).
- Admin toasts: `iziToast` renders `title`/`message` as HTML. Since v0.7.0 `webapp/admin/index.js` wraps `iziToast.show` and escapes both once, so pass plain text and do not call `_esc()` yourself (it would double-escape).

## Server-side counterparts

- XML for Sonos, DLNA and Subsonic is built with `xmlEsc` / `xmlEscape`, which also strip characters XML 1.0 forbids. Numeric fields (`year`, track number, file size) are parsed to integers before they are written.
- Outbound requests to user-supplied URLs go through `src/util/ssrf-check.js`: `safeFetch()` (checks every redirect hop, including DNS) or `safeLookup` for `http.request` (pins the connection to the checked address). Do not call `fetch()` on a user URL directly.
- `/album-art/*` and `/api/v1/radio/art` send `Content-Security-Policy: default-src 'none'; sandbox`, so a remote SVG station logo opened directly can never run script on Velvet's origin.

## Static analysis

The v0.7.0 audit ran [opengrep](https://github.com/opengrep/opengrep) 1.32.0 with the JavaScript, TypeScript, generic, Dockerfile, YAML, Bash and HTML packs of `opengrep-rules`, without a file-size limit (the two frontends are over 1 MB). Most HTML findings are pattern matches that cannot see `esc()`; real issues were found by checking every interpolation the pattern rules flagged. See `docs/dev/security-scan.md` for how to repeat it.

