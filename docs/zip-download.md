# ZIP Download

Albums and playlists can be downloaded as a ZIP archive directly from the player UI.

## How it works

A small **ZIP** button (download icon) appears in the page header when viewing:
- An **album**
- A **playlist** (via the sidebar playlist links)
- A **folder** in the file explorer that contains audio files
- Some grouped folder views (e.g. a folder group in the library)

The button is hidden on views that do not pass a ZIP name (home, search, radio, podcasts, etc.).

Next to it, a **Select** button turns on select mode: tick songs and the ZIP contains only the selection (the count is shown on the ZIP button).

Clicking the button sends the song list to the server, which streams back a ZIP archive containing the actual audio files. The archive is downloaded with the album, playlist or folder name as the filename. Files the user cannot access are skipped; if none are left the server returns 404.

## Server-side size limit

Before streaming the ZIP, the server adds up the file sizes of the requested files. If the total exceeds the configured limit the request is rejected with HTTP 413 and the app shows a toast:

> ZIP too large — server limit is 500 MB (increase in Admin → DB Settings)

The limit is configurable in **Admin → Database → DB Scan Settings** under **Max ZIP Download Size** (default: 500 MB). The same limit applies to `POST /api/v1/download/directory` and `GET /api/v1/download/shared`.

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

- `fileArray` — JSON-encoded array of file paths including the vpath (as returned by library endpoints)
- `filename` — optional; used as the ZIP filename (`/ \ : * ? " < > |` replaced with `_`, max 120 chars; defaults to `velvet-download`)

On success the response is an `application/zip` stream with `Content-Disposition: attachment; filename="<name>.zip"`. Files are stored flat in the archive (base name only).

On size exceeded: `413 { "error": "...", "maxMb": 500, "sizeMb": 732 }`. `sizeMb` is the running total at the point the limit was crossed, not the full size.

## Admin setting

**Max ZIP Download Size** is stored under `scanOptions.maxZipMb` in the config file and can be changed at runtime via:

```
POST /api/v1/admin/db/params/max-zip-mb
{ "maxZipMb": 1000 }
```
