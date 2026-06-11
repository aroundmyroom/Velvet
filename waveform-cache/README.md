# waveform-cache

Server-generated waveform data files (`wf-<hash>.json`).

One JSON file is created per indexed track the first time the waveform scrubber
is used for that track.  Files are automatically removed during post-scan
orphan cleanup when the corresponding track is no longer in the library.

The directory can be configured via `storage.waveformDirectory` in the mStream
config file.  It is safe to delete all files here — they will be regenerated on
demand (requires FFmpeg/transcoding to be enabled).
