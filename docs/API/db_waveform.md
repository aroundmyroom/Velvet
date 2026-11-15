# GET /api/v1/db/waveform

Returns a pre-computed waveform amplitude array for a track, used to render
the waveform scrubber in the player.

The first request for a track decodes it with Velvet's bundled ffmpeg
(`bin/ffmpeg/`, see `src/util/ffmpeg-bootstrap.js`). Subsequent requests are
served from the on-disk cache with no ffmpeg involvement. At most two ffmpeg
waveform jobs run at the same time; requests for the same track share one job.

## Authentication

Required.

## Query Parameters

| Parameter  | Required | Description |
|------------|----------|-------------|
| `filepath` | Yes      | Player path to the track, starting with the vpath, e.g. `Music/Bowie/Heroes.flac` |
| `prefetch` | No       | `1` queues the job at background priority (behind live requests) |

## Response

```json
{
  "waveform": [0, 12, 45, 200, 255, 180, ...]
}
```

`waveform` is an array of **600** integers in the range `0–255`: RMS amplitude
per segment of the track (mono, decoded at 4000 Hz), scaled to the 99th
percentile and shaped with a 0.7 gamma curve.

## Error Responses

| Status | Meaning |
|--------|---------|
| `400`  | `filepath` query parameter missing |
| `403`  | File not accessible by the requesting user |
| `404`  | File not in the DB and not found on disk |
| `503`  | The ffmpeg binary is missing |

## Caching

Waveform data is cached to disk in `storage.waveformDirectory` (default:
`waveform-cache/`) as `wf2-<hash>.json`. The hash is the content hash stored
in the database, so physically duplicate tracks across different folders share
one cache entry (a file not yet in the DB uses a SHA-256 of its path). Older
`wf-<hash>.json` files are deleted at startup.

Cache files of tracks removed from the library are deleted when a folder scan
finishes and in the orphan cleanup that runs once the task queue is idle.
