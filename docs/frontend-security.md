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