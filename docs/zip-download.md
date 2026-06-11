# ZIP Download

Albums and playlists can be downloaded as a ZIP archive directly from the player UI.

## How it works

A small **ZIP** button (download icon) appears in the page header when viewing:
- An **album** (via the Browse → Albums flow)
- A **playlist** (via the sidebar playlist links)

The button is hidden on all other views (home, search, radio, podcasts, etc.).

Clicking the button sends the current song list to the server, which streams back a ZIP archive containing the actual audio files. The archive is downloaded with the album or playlist name as the filename.

## Server-side size limit

Before streaming the ZIP, the server checks the total uncompressed size of all requested files. If the total exceeds the configured limit the request is rejected with HTTP 413 and the app shows a toast:

> ZIP too large — server limit is 500 MB

The limit is configurable in the **Admin → DB Scan Settings** card under **Max ZIP Download Size** (default: 500 MB).

## API

```
POST /api/v1/download/zip
Content-Type: application/json
x-access-token: <token>

{
  "fileArray": "[\"path/to/file1.mp3\", \"path/to/file2.flac\"]",
  "filename": "My Album Name"
}
```

- `fileArray` — JSON-encoded array of server-relative file paths (as returned by library endpoints)
- `filename` — optional; used as the ZIP filename (sanitised, max 120 chars; defaults to `velvet-download`)

On success the response is an `application/zip` stream with `Content-Disposition: attachment; filename="<name>.zip"`.

On size exceeded: `413 { "error": "...", "maxMb": 500, "sizeMb": 732 }`.

## Admin setting

**Max ZIP Download Size** is stored under `scanOptions.maxZipMb` in the config file and can be changed at runtime via:

```
POST /api/v1/admin/db/params/max-zip-mb
{ "maxZipMb": 1000 }
```
