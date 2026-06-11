# save/lyrics

Server-side lyrics cache. One file is written per track:

- `<md5hash>.json` — synced (LRC) or plain-text lyrics fetched from lrclib.net
- `<md5hash>.none` — sentinel indicating no lyrics were found, suppressing repeated network requests

Files are safe to delete — they will be re-fetched on demand.
