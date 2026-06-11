# GET /api/v1/files/art

*Added in v5.16.32*

Extracts the embedded album art picture from any audio file on demand — without requiring a full library scan. The result is written to the shared album-art cache and the cache filename is returned.

This endpoint is called automatically by the Velvet client whenever a song is encountered without pre-cached art (unscanned recordings, fresh YouTube downloads, etc.).

---

## Request

```
GET /api/v1/files/art?fp=<filepath>
```

| Parameter | Type | Description |
|---|---|---|
| `fp` | string | The virtual filepath as used across the API (`vpath/relative/path/to/file.mp3`). Must resolve to a file inside a configured vpath. |

Authentication token required (header `x-access-token` or query param `token`).

---

## Response

**200 OK — art found and cached:**

```json
{ "aaFile": "d41d8cd98f00b204e9800998ecf8427e.jpg" }
```

`aaFile` is the filename (not full path) inside the server's album-art cache directory. Pass it to the `artUrl()` helper or construct the URL as:

```
GET /albumart/<aaFile>
```

**200 OK — no embedded art:**

```json
{ "aaFile": null }
```

**400 Bad Request** — `fp` parameter missing or empty.

**403 Forbidden** — `fp` resolves outside all configured vpath roots (path traversal blocked).

**404 Not Found** — file does not exist on disk.

---

## Behaviour

1. Resolves `fp` to an absolute path via the configured vpath map (same security check as the streaming endpoint).
2. Reads embedded picture using `music-metadata` (`parseFile`). Supports all formats that carry embedded images: MP3 (ID3v2), FLAC, M4A/AAC, OGG, Opus, WAV, AIFF.
3. MD5-hashes the raw image bytes to produce the cache filename (`<hash>.jpg`).
4. If the cache file does not already exist, writes it to the `albumArtDirectory`.
5. Returns `{ aaFile: "<hash>.jpg" }`.

The extraction is idempotent — calling it multiple times for the same file is safe and cheap (the cache write is skipped on subsequent calls).

---

## Example

```js
const res = await fetch(`/api/v1/files/art?fp=${encodeURIComponent('LIKA/2026-03-31_LIKA.mp3')}`, {
  headers: { 'x-access-token': token }
});
const { aaFile } = await res.json();
if (aaFile) {
  imgEl.src = `/albumart/${aaFile}`;
}
```
