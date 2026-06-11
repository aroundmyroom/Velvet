# GET /api/v1/db/waveform

Returns a pre-computed waveform amplitude array for a track, used to render
the waveform scrubber in the player.

Requires FFmpeg to be enabled (`transcode.enabled: true`) the first time a
waveform is generated for a given track.  Subsequent requests are served
from the on-disk cache with no FFmpeg involvement.

## Authentication

Required.

## Query Parameters

| Parameter  | Required | Description |
|------------|----------|-------------|
| `filepath` | Yes      | Virtual path to the track, e.g. `rock/Bowie/Heroes.flac` |

## Response

```json
{
  "waveform": [0, 12, 45, 200, 255, 180, ...]
}
```

`waveform` is an array of **800** integers in the range `0–255`, representing
normalised RMS amplitude sampled evenly across the full track duration.

## Error Responses

| Status | Meaning |
|--------|---------|
| `400`  | `filepath` query parameter missing |
| `403`  | File not accessible by the requesting user |
| `404`  | File not found on disk |
| `503`  | FFmpeg not available — enable transcoding in config |

## Caching

Waveform data is cached to disk in `storage.waveformDirectory` (default:
`waveform-cache/`) as `wf-<hash>.json`.  The hash is the content hash stored
in the database, so physically duplicate tracks across different folders share
one cache entry.

Orphaned cache files (tracks removed from the library) are deleted
automatically after each scan completes.
