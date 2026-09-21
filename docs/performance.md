# Performance notes

## Album art caching
`/album-art/:file` serves files from `albumArtDirectory`. File names are content hashes, so
responses carry `Cache-Control: public, max-age=31536000, immutable`. Reverse proxies and
browsers keep covers without revalidating. The fallback SVG (no art) is `no-store`.

## Scanner and the event loop
Velvet runs SQLite and request handling on one Node thread. The scanner child reports every
file to `/api/v1/scanner/get-files-batch`; anything synchronous in that handler stalls all users.
The art checks (`_buildFileFlags`, `_dirCoverChanged`, `_dirHasNewArt` in `src/api/scanner.js`)
therefore use `fs.promises`, cache one `readdir`/`stat` per folder per scan, and process each
batch with 8 concurrent workers. No mount-specific behaviour is assumed, so it works the same on
local disks, NFS, Samba/CIFS and Docker bind mounts.

## Tips for network-mounted libraries
- Schedule the daily scan (`scanOptions.scanStartTime`) outside listening hours.
- For NFS, avoid `acregmin=0,acdirmin=0`; a modest attribute cache (e.g. 30 s) cuts stat round trips.
