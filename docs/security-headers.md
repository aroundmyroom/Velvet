# Security Headers

Velvet uses Helmet on its Express entry points to set well-known defensive headers.

## Coverage

- Main server: `src/server.js` — Helmet with a custom Content-Security-Policy (Helmet's default directives, plus `img-src 'self' data: https://flagcdn.com` and `worker-src 'self' blob:`; `upgrade-insecure-requests` is removed so plain-HTTP LAN setups keep working).
- DLNA server: `src/api/dlna.js` — `helmet()` with its defaults.

## Exceptions

- `/admin` and the player page (`/`, `/index.html`) add `'unsafe-eval'` to `script-src` (the Vue 2 template compiler and the visualizer presets need `new Function()`), and add `https:` and `blob:` to `img-src`.
- `/rest` (Subsonic API) relaxes `Cross-Origin-Resource-Policy`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` so clients running in their own web views can read the responses.
- `/album-art/*` and `/api/v1/radio/art` set their own strict policy: `default-src 'none'; style-src 'unsafe-inline'; sandbox`.

## Notes

- Helmet is applied at the app boundary so all routes inherit the same baseline headers.
- Keep route-specific exceptions narrow if a future endpoint needs to opt out of a particular header.
