# Technology Choices — The Hows and the Whys

Every external service, library, and binary used in Velvet was a deliberate choice. This document explains what each one does, why it was picked over alternatives, and what the trade-offs are. If you are evaluating this project, auditing its dependencies, or just curious why a particular tool is in the stack — this is the place to look.

---

## FFmpeg

**What it does in Velvet:** Four distinct jobs:

1. **Transcoding** — Re-encodes any audio file on-the-fly to MP3, Opus, or AAC at the bitrate the client requests. This is how a FLAC file on your server plays on a phone with limited bandwidth: the server decodes FLAC and pipes compressed audio directly to the browser.
2. **Waveform generation** — Decodes audio to raw PCM (32-bit float, 4000 Hz mono) via a pipe. Server-side JavaScript then computes 600 RMS values with a γ=0.7 perceptual curve and caches the result. This gives the seek bar its waveform display.
3. **Scan error repair** — Re-muxes corrupt FLAC, MP3, and WAV files in-place (stream-copy first, then a full re-encode fallback). Strips broken APEv2 tags and corrupt embedded images. Available from the Admin → Scan Errors panel.
4. **Tag writing** — Rewrites ID3/Vorbis tags (title, artist, album, year, genre) without re-encoding the audio, using FFmpeg's `-metadata` flag with `-c copy`.

**Why FFmpeg and not something else?**

FFmpeg is the most complete open-source media processing toolkit that exists. The realistic alternatives for each task above are:

| Alternative | Why not used |
|---|---|
| Node.js audio decoders (e.g. `node-lame`) | Format coverage is limited; no FLAC, no Opus; unmaintained |
| Web Audio API on the server | Doesn't exist server-side in a useful form |
| GStreamer | Complex pipeline setup; no easy Node.js bindings for streaming |
| sox | No codec coverage for modern formats (Opus, AAC) |

FFmpeg handles every format in the supported list (FLAC, MP3, AAC, Opus, OGG, WAV, AIFF, W64…) with a single statically linked binary. Velvet spawns it directly (`node:child_process`) and pipes its output into the HTTP response stream; there is no wrapper library.

`src/util/ffmpeg-bootstrap.js` downloads a static build (BtbN) into `bin/ffmpeg/` on first start, or when the binary there is older than v6, so users do not need to install it separately.

---

## LRCLIB — Lyrics

**What it does:** Fetches time-synced LRC lyrics (with millisecond timestamps) or plain-text lyrics for the currently playing track. The lyrics display in the full-screen Lyrics visualizer mode and scroll in sync with the music.

**Why LRCLIB and not Musixmatch, Genius, or others?**

| Service | API key required | Free | Synced (LRC) lyrics | Notes |
|---|---|---|---|---|
| **LRCLIB** | No | Yes, completely | Yes | Community-maintained, open database |
| Musixmatch | Yes | Limited (free tier is restricted) | Yes, but behind paywall | Commercial; lyrics must be attributed; display rules apply |
| Genius | Yes | Yes | No — plain text only | No timestamps; not suitable for sync |
| AZLyrics | No official API | — | No | Scraping violates ToS |
| Netease / QQ Music | China-region services | Yes | Yes | Requires VPN or China account for non-Chinese tracks |

LRCLIB is the only service that is completely free, requires no API key or account, and provides synced LRC lyrics for western music. It is also open-source — anyone can run their own instance or contribute lyrics.

**How the matching works:** Velvet calls lrclib's `/api/get` endpoint with artist, title and the track's duration (in seconds). The duration comes from the database (populated at scan time) when it has one, otherwise from the client. If that exact-duration call finds nothing (or the track has no duration), a second call is made without a duration, matching on artist and title only.

Successful results are cached in `save/lyrics/` so each track is only fetched once. "Not found" is never cached, so a later lookup tries again.

---

## Discogs — Album Art

**What it does:** Fetches cover art for tracks that have no embedded album art. It searches the Discogs database by artist + album name, downloads the cover image, and saves it to `image-cache/` along with three thumbnail sizes (`zs-` 92 px, `zl-` 256 px, `zm-` 512 px).

**Why Discogs and not MusicBrainz, Spotify, or others?**

| Service | API key required | Free | Coverage | Notes |
|---|---|---|---|---|
| **Discogs** | Yes (free registration) | Yes | Excellent for physical releases; strong for 7" singles, 12" mixes, rare records | Rate-limited but generous for personal use |
| MusicBrainz Cover Art Archive | No | Yes | Good for mainstream releases | Coverage is thinner for non-mainstream and non-Western music |
| Spotify API | Yes | Yes (limited) | Excellent for modern releases | Terms of service forbid caching images; album art is served from Spotify CDN and must stay there |
| Last.fm images | API key | Yes | Moderate | Being phased down; image API less reliable |
| iTunes / Apple Music | Apple credentials | Limited | Strong for popular music | ToS restrictions on caching and display |

Discogs was chosen because it has the deepest catalogue of any music database for physical releases — especially for dance music, 12" singles, obscure pressings, and vinyl-era content. It is a free API (registration required), and its terms for personal, self-hosted use are permissive. Spotify's images explicitly cannot be cached under their developer ToS, which makes them incompatible with a self-hosted server.

The API key and secret are configured once in the admin panel under External Services → Discogs.

---

## Last.fm and similar artists

**Last.fm** reports played tracks to the user's Last.fm profile after 30 seconds of playback (scrobbling) and supplies the artist bio. For scrobbling it is the de facto standard; most people who care about scrobbling already have an account. Velvet also sends listens to ListenBrainz and to multi-scrobbler.

**Similar artists** (Auto-DJ similar mode, artist pages, Home shelves) used Last.fm `artist.getSimilar` until v0.10.5. From 1 December 2026 a Last.fm API key only works while its owner has Last.fm Pro, so the admin now picks one source under Admin → Similar artists ([similar-artists.md](similar-artists.md)):

| Service | Notes |
|---|---|
| **ListenBrainz** (default) | No key for similar artists, up to 100 with a score; needs MusicBrainz artist IDs. Very strong on niche artists, can drift towards general pop for very popular ones |
| **TIDAL** | Free developer app (client credentials); rank order only, no score |
| **Last.fm** `artist.getSimilar` | Mature data, but needs Last.fm Pro from 1 December 2026 |
| Deezer | Keyless, but its terms of 27 October 2026 require an approved application; at most 20 results, no score |
| Spotify | Related artists closed to new apps |
| Apple Music | Developer program costs $99 a year |
| TasteDive, music-map | Weak results, or scraping only |
| MusicBrainz, Wikidata, Discogs, TheAudioDB | No similarity data |
| AcousticBrainz | Stopped collecting data in 2022 |

---

## Butterchurn / Milkdrop Visualizer

**What it does:** Renders the Milkdrop full-screen music visualizer using WebGL. Milkdrop is a shader-based visualizer with hundreds of community presets that animate in sync with the audio. Butterchurn is a JavaScript port of Winamp's Milkdrop 2 plugin.

**Why Butterchurn?**

Milkdrop has one of the largest and most creative preset libraries of any music visualizer ever made — most of it created by the community over 20+ years. Butterchurn makes this entire history available in a browser tab via WebGL with no plugin required. It is also open-source.

Custom GLSL visualizers do not have this preset depth, and building a shader visualizer from scratch would be a significant engineering effort for diminishing returns when Butterchurn already exists.

The preset library is bundled in `webapp/assets/js/lib/` so it works fully offline.

---

## audioMotion-analyzer — Spectrum Visualizer

**What it does:** Renders a configurable real-time frequency spectrum analyser in the full-screen visualizer. Velvet ships 6 hand-curated presets: Mirror Peaks, LED Dual, Radial, Octave Reflex, Velvet, and Line Stereo.

**Why audioMotion-analyzer and not a custom canvas implementation?**

A basic spectrum analyser with `AnalyserNode.getByteFrequencyData()` and a canvas draw loop is straightforward — several hundred lines of code. But audioMotion-analyzer provides:

- Logarithmic frequency scaling (matches how hearing works)
- Octave-band averaging (smoother, more musical)
- Multiple built-in graph modes (mirror, radial, bars, line)
- High-DPI canvas handling
- Smooth interpolation and configurable decay

Building all of this correctly from scratch (especially the logarithmic binning and anti-aliasing) would be several times the code and testing effort. The library is MIT-licensed, maintained, and adds only ~100 KB to the bundle.

---

## VoltViz — Modern Visualizer Collection

**What it does:** Adds a fifth visualizer mode with 40+ modern styles (WebGL and, where the browser supports it, WebGPU) by [Sander de Wildt](https://github.com/sanderdw/voltviz), MIT-licensed.

**Why VoltViz?**

Milkdrop covers the classic preset aesthetic and audioMotion covers precise spectrum displays; VoltViz fills the gap with contemporary shader scenes, particle fields and stylised spectrum displays, without writing and maintaining dozens of shaders ourselves. It is vendored as an ES module in `webapp/assets/js/lib/voltviz/` (works offline) and loaded with a dynamic `import()` only the first time the VoltViz mode is chosen, so player start-up is unchanged. It reads the same post-EQ/ReplayGain analyser tap as Milkdrop and audioMotion and never connects to the speakers. See [visualizer.md](visualizer.md).

---

## SQLite (`node:sqlite`)

**What it does:** Stores all music metadata (tracks, artists, albums, ratings, playlists, user settings, waveform presence flags, scrobble history, etc.).

**Why SQLite and not PostgreSQL, MySQL, or MongoDB?**

Velvet is a personal self-hosted music server. It is designed to run on a Raspberry Pi, a home NAS, or a low-spec VPS — not a managed database tier. SQLite is:

- **Zero-install** — no separate database server process
- **Built into Node.js v22** via the `node:sqlite` module (`DatabaseSync`) — no native addon or third-party driver needed
- **Adequate performance** — WAL mode, a 32 MB page cache, and prepared statements handle even 100,000+ track libraries without event-loop stalls
- **Single file** — the entire database is `velvet.sqlite`; a backup is one consistent snapshot of it (`VACUUM INTO`, see [backup.md](backup.md))

PostgreSQL or MySQL would require a running database server, a separate install step, and connection management. For a single-user personal server that holds music metadata, that is unjustified complexity.

SQLite is the only database engine.

---

## Web Audio API — Audio Engine

**What it does:** The entire audio pipeline runs through the browser's native Web Audio API. The signal chain (simplified) is:

```
MediaElementSource
  → GainNode          (per-element, for gapless/crossfade switching)
  → GainNode          (ReplayGain normalisation)
  → GainNode          (fixed headroom gain)
  → 8× BiquadFilter   (equaliser bands)
      ├→ AnalyserNode (Milkdrop tap, pre-balance)
  → StereoPannerNode  (stereo balance)
      ├→ L/R AnalyserNodes (VU / spectrum, post-balance)
  → GainNode          (cast mute: 0 while casting to MPV/Sonos)
  → AudioContext.destination
```

Volume is set on the audio element itself.

**Why build this rather than using an audio library?**

No JavaScript audio library provides gapless playback, crossfade, a full EQ, ReplayGain normalisation, stereo balance, and a visualizer tap — all simultaneously — without browser plugins. The Web Audio API is a browser standard (no library needed) and gives direct access to the audio graph at every point. This makes it possible to:

- Tap the signal before the StereoPannerNode for the Milkdrop visualizer (so balance changes do not skew it), and after it for the VU meters (so they show the balance)
- Apply ReplayGain as a `GainNode` without any perceived volume jump between tracks
- Schedule gapless crossfades using `AudioContext.currentTime` for sample-accurate timing

---

## Subsonic Protocol

**What it does:** Velvet exposes a Subsonic REST API (version 1.16.1 + Open Subsonic extensions) in addition to its own native API. This lets any Subsonic-compatible mobile app (DSub, Symfonium, Substreamer, Ultrasonic) connect to Velvet as if it were a Subsonic or Navidrome server.

**Why implement Subsonic rather than building a native app?**

Building a polished native mobile app for iOS and Android is a significant ongoing engineering and maintenance effort.The Subsonic protocol is a well-established open standard with many mature, actively maintained third-party clients. By implementing the protocol server-side, Velvet users get the benefit of those clients for free — each with their own UI, caching strategies, offline sync features, and platform-native experiences.

The Open Subsonic extension layer (`openSubsonic: true`) allows newer clients to detect extended capabilities beyond what classic Subsonic defined.

---

## music-metadata — Tag Parsing

**What it does:** At scan time, reads every audio file and extracts all metadata tags: title, artist, album, year, genre, track number, disc number, ReplayGain values, embedded album art, and CUE sheet data. Supports ID3v1, ID3v2, Vorbis Comments, APEv2, RIFF INFO, and more.

**Why this library?**

`music-metadata` is the best-maintained, most format-comprehensive audio tag parser in the Node.js ecosystem. It is actively maintained by a single dedicated author who responds to issues, handles edge cases from real-world files, and supports every audio container in Velvet's list. Alternatives like `node-id3` cover only MP3/ID3; `taglib-node` requires native compiled bindings; and format hand-rolling would introduce a maintenance burden for every obscure tag variant in real music collections.

---

## Summary Table

| Technology | Category | Why chosen |
|---|---|---|
| FFmpeg | Audio processing | Only tool covering all formats; transcoding + waveform + repair + tag writing in one binary |
| LRCLIB | Lyrics | Free, no API key, synced LRC timestamps, open-source; duration-matched first |
| Discogs | Album art | Best catalogue depth for physical/vinyl releases; free personal-use API; cacheable images |
| Last.fm | Scrobbling + artist bio | De facto scrobbling standard; API key needs Last.fm Pro from 1 December 2026 |
| ListenBrainz / TIDAL | Similar artists for Auto-DJ | ListenBrainz needs no key and gives a score; TIDAL is a free developer app; Last.fm stays available as a third source |
| Butterchurn | Milkdrop visualizer | 20+ years of community presets; WebGL; open-source; no alternative has this library |
| audioMotion-analyzer | Spectrum visualizer | Logarithmic scaling, octave bands, multiple modes; saves ~500 lines of custom canvas code |
| VoltViz | Modern visualizer styles | 40+ WebGL/WebGPU styles, MIT; lazy-loaded so it costs nothing until used |
| SQLite (`node:sqlite`) | Database | Zero-install, built into Node v22, single-file backup, adequate for personal server scale |
| Web Audio API | Audio engine | Native browser standard; only option for gapless, crossfade, EQ, and ReplayGain simultaneously |
| Subsonic protocol | Mobile clients | Reuses mature third-party apps; avoids cost of building native apps from scratch |
| music-metadata | Tag parsing | Most complete Node.js tag parser; handles every format in the supported list |
