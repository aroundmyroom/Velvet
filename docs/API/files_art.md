# GET /api/v1/files/art

Extracts album art for any audio file on demand — without requiring a full library scan. The result is written to the shared album-art cache and the cache filename is returned.

The Velvet client calls this endpoint whenever a song is encountered without pre-cached art (unscanned recordings, fresh YouTube downloads, etc.).

---

## Request

```
GET /api/v1/files/art?fp=<filepath>
```

| Parameter | Type | Description |
|---|---|---|
| `fp` | string | The player filepath as used across the API (`vpath/relative/path/to/file.mp3`). Must resolve to a file inside a vpath the user may access. |

Authentication token required (header `x-access-token` or query param `token`).

---

## Response

**200 OK — art found and cached:**

```json
{ "aaFile": "d41d8cd98f00b204e9800998ecf8427e.jpg" }
```

`aaFile` is the filename (not full path) inside the server's album-art cache directory. Pass it to the client's `artUrl()` helper or construct the URL as:

```
GET /album-art/<aaFile>?compress=s
```

(`compress=s|l|m` serves the `zs-`/`zl-`/`zm-` thumbnail.)

**200 OK — no art found, file missing on disk, or the file could not be parsed:**

```json
{ "aaFile": null }
```

**400 Bad Request** — `fp` parameter missing or empty.

**403 Forbidden** — `fp` does not resolve inside a vpath the user may access.

---

## Behaviour

1. Resolves `fp` to an absolute path via the configured vpath map.
2. For known audio extensions, reads the first embedded picture with `music-metadata` (`parseFile`).
3. Without an embedded picture, looks for a folder image in the same directory, then in the parent directory (for `CD1`/`CD2` sub-folders): `cover`, `folder`, `front`, `frente` or `artwork` with `.jpg`, `.jpeg` or `.png`.
4. MD5-hashes the image bytes to produce the cache filename (`<md5>.<ext>`, the same name the scanner uses).
5. Writes the file and its `zl-`/`zs-`/`zm-` thumbnails to `albumArtDirectory` when they do not exist yet (thumbnails only when image compression is on).
6. Returns `{ aaFile }`.

The extraction is idempotent — calling it multiple times for the same file is safe and cheap (existing cache files are not rewritten). The DB record is not updated.

---

## Example

```js
const res = await fetch(`/api/v1/files/art?fp=${encodeURIComponent('LIKA/2026-03-31_LIKA.mp3')}`, {
  headers: { 'x-access-token': token }
});
const { aaFile } = await res.json();
if (aaFile) {
  imgEl.src = `/album-art/${encodeURIComponent(aaFile)}?compress=s&token=${token}`;
}
```
