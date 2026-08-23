# Velvet — Home Assistant Integration: Investigation & Implementation Plan

> **Status:** Plan only — no code written. All architectural claims are derived
> from the actual Velvet source tree (`src/`). File references are exact.

---

## Executive Summary

**Recommended architecture: Home Assistant → Velvet Server Speaker (mpv) as primary
player, with optional Sonos / DLNA player entities for existing hardware.**

The Server Speaker is the only Velvet output target that is:
1. Fully controlled by authenticated REST (start/stop/seek/volume/queue)
2. Permanently running on the same machine as Velvet
3. Headless-capable
4. Not dependent on a browser session being alive

All three bugs that would make it unreliable in HA automation (no push events,
heartbeat watchdog stops mpv, no "play this album" shortcut) are small Velvet
changes, not architectural rebuilds.

The HA integration itself is a standard `custom_component` with a
`MediaPlayerEntity`, a `DataUpdateCoordinator` that polls
`/api/v1/server-playback/status` every ~2 s, and a `MediaSource` for library
browsing. Sonos and DLNA are **not** exposed through this integration — HA already
has first-class Sonos and DLNA integrations that work without Velvet.

---

## 1. Current Velvet Architecture — Verified Facts

### Backend
- **Runtime:** Node.js v24 / Express 5
- **Entry point:** `src/server.js` → `serveIt(configFile)`
- **Database:** SQLite via `node:sqlite` `DatabaseSync` — file `save/db/velvet.sqlite`
- **Auth:** JWT (`jsonwebtoken`). Secret in `save/conf/default.json`. Tokens do not expire unless the secret is rotated. Token passed as header `x-access-token`, cookie, query param, or body field. See `src/api/auth.js`.
- **Config:** `src/state/config.js` — loaded from `save/conf/default.json`
- **No mDNS / Zeroconf / SSDP self-advertisement** — confirmed by grep; nothing in the codebase advertises the main HTTP server. (DLNA does advertise itself on the LAN via SSDP, but only as a UPnP MediaServer, not the Velvet API endpoint.)

### Frontend (browser player)
- **Technology:** Vanilla JS, no framework. Single file `webapp/app.js` (~10k+ lines).
- **Queue:** Stored client-side in JS state + persisted server-side via `POST /api/v1/queue`. The queue object `{ queue[], idx, currentFilepath, time, playing, savedAt, browserId }` is opaque to the server — the server just stores/returns it.
- **Now-playing:** Browser-side only. No server-side now-playing state for the browser player.
- **Playback control:** Browser performs all audio decoding via the HTML5 `<audio>` element. There is **no server-side state** for the browser player — the server cannot tell whether the browser is playing, paused, or what track it is on, except via the jukebox cache.
- **Remote control:** Via WebSocket jukebox session (`src/api/remote.js`). Works only while a browser tab with the player is open and connected. Not suitable for headless HA automation.

### Server Speaker (mpv)
Source file: `src/api/server-playback.js`

Key verified facts:
- Spawns `mpv --idle --no-video --gapless-audio --input-ipc-server=<tmpdir>/mpv-velvet-<pid>.sock`
- Communicates with mpv via Unix domain socket (JSON IPC protocol)
- Server-side queue mirror (`serverQueue[]` + `currentIndex`) kept in module-scope memory
- **Heartbeat watchdog:** `POST /api/v1/server-playback/heartbeat` must be called every 8 s or mpv stops after 300 s. This exists to stop mpv if the browser casting it crashes — **it will stop HA's playback if HA doesn't send heartbeats**
- ReplayGain applied via mpv `af volume=` filter on every `file-loaded` event
- Balance supported via mpv `lavfi pan` filter
- Volume: mpv `volume` property, also via `amixer` ALSA — 0–130 range
- Loop: none / one / all — `cycle` command exposed
- No shuffle in mpv; not tracked
- Gapless: `--gapless-audio=yes` — fully functional
- ALSA health check + auto-fix: `GET /api/v1/server-playback/audio-health`
- `bootMpv()` / `killMpv()` / `isRunning()` are exported; mpv auto-boots on first `addToQueue` call if `serverAudio.enabled` is true in config

**Functional gaps for HA use:**
1. No SSE/WebSocket push — HA must poll `GET /api/v1/server-playback/status`
2. Heartbeat watchdog requires HA to send `POST /api/v1/server-playback/heartbeat` periodically
3. No "play album/playlist/artist" shortcut — HA must resolve filepaths itself, then call `queue/add` per track
4. No persistent player identity — `running: false` means mpv stopped (e.g. end of queue); HA cannot distinguish "idle" from "crashed"
5. No `queue/add-many` (the docs list it; it is **not implemented** in `server-playback.js` — only single-track `queue/add` exists)

### Sonos
Source file: `src/api/sonos.js`

- Velvet acts as a **command bridge**: it sends UPnP SOAP calls directly to Sonos devices on port 1400
- Discovery: SSDP M-SEARCH (`urn:schemas-upnp-org:device:ZonePlayer:1`) via raw UDP
- State polling: Velvet does NOT subscribe to Sonos GENA events (the library that did was removed due to EADDRINUSE). State is polled on demand.
- Volume / mute: `RenderingControl` SOAP
- Grouping: not implemented
- Track/queue: AVTransport `SetAVTransportURI` + DIDL-Lite metadata
- Transcode stream: dedicated `GET /api/v1/sonos/transcode-stream` endpoint for Sonos-incompatible formats (e.g. FLAC → MP3 on the fly)

**HA decision:** Do not route Sonos through Velvet. HA's built-in Sonos integration already provides full Sonos control with push events. Exposing Sonos rooms as Velvet entities would duplicate functionality and lose push-event reliability.

### DLNA
Source file: `src/api/dlna.js`

- Velvet acts as a **DLNA MediaServer only** — it does NOT act as a MediaRenderer
- Exposes the full library hierarchy (artists / albums / genres / folders / playlists) via UPnP ContentDirectory Browse
- Serves tracks via authenticated-optional HTTP stream URLs on a separate port (default 10293)
- No authentication on the DLNA port — LAN-only by design
- SSDP/GENA events: fully implemented per subscriber
- TimeSeekRange: supported for seeking via ffmpeg offset

**HA decision:** DLNA renderers (AVRs, smart TVs) that are already on the LAN can play Velvet tracks through HA's existing DLNA/UPnP integration — no Velvet changes needed. Velvet's DLNA MediaServer makes tracks discoverable. Do not expose DLNA control through the Velvet HA integration.

---

## 2. Existing API — Relevant to HA

All endpoints require `x-access-token` JWT unless marked Public.

### Authentication
| Function | Endpoint | Notes |
|---|---|---|
| Login | `POST /api/v1/auth/login` | Returns JWT. No expiry. |
| Refresh | `GET /api/v1/auth/refresh` | Renew from existing session. |
| Ping/bootstrap | `GET /api/v1/ping` | Returns vpaths, config, vpath metadata. |

### Server Speaker (direct HA target)
| Function | Endpoint | Available to HA? | Notes |
|---|---|---|---|
| Get status | `GET /api/v1/server-playback/status` | ✅ Yes | Returns `{ running, playing, currentTime, duration, currentIndex, queueLength, volume, loopMode, queue[] }` |
| Play/pause toggle | `POST /api/v1/server-playback/pause` | ✅ Yes | Toggles |
| Set pause | `POST /api/v1/server-playback/set-pause` | ✅ Yes | `{ paused: bool }` |
| Seek | `POST /api/v1/server-playback/seek` | ✅ Yes | `{ position: seconds }` |
| Volume | `POST /api/v1/server-playback/volume` | ✅ Yes | `{ volume: 0–130 }` |
| Next | `POST /api/v1/server-playback/next` | ✅ Yes | |
| Previous | `POST /api/v1/server-playback/previous` | ✅ Yes | |
| Loop | `POST /api/v1/server-playback/loop` | ✅ Yes | Cycles none→one→all |
| Add to queue | `POST /api/v1/server-playback/queue/add` | ✅ Yes | `{ filepath }` — one track at a time |
| Clear queue | `POST /api/v1/server-playback/queue/clear` | ✅ Yes | |
| Play at index | `POST /api/v1/server-playback/queue/play-index` | ✅ Yes | `{ index }` |
| Remove from queue | `POST /api/v1/server-playback/queue/remove` | ✅ Yes | `{ index }` |
| Heartbeat | `POST /api/v1/server-playback/heartbeat` | ✅ Required | Must send every <300 s |
| Detect mpv | `GET /api/v1/server-playback/detect` | ✅ Yes | |

### Library (for browse / play)
| Function | Endpoint | Available to HA? | Notes |
|---|---|---|---|
| Search | `POST /api/v1/db/search` | ✅ Yes | Returns tracks/albums/artists |
| Albums | `POST /api/v1/db/albums` | ✅ Yes | |
| Album tracks | `POST /api/v1/db/album-songs` | ✅ Yes | `{ album, artist }` |
| Artists | `GET /api/v1/db/artists` | ✅ Yes | |
| Artist albums | `POST /api/v1/db/artists-albums` | ✅ Yes | |
| Playlists | `GET /api/v1/playlist/getall` | ✅ Yes | Returns names |
| Playlist tracks | `POST /api/v1/playlist/load` | ✅ Yes | `{ playlistname }` |
| Random songs | `POST /api/v1/db/random-songs` | ✅ Yes | Auto-DJ seed |
| Smart playlists | `GET /api/v1/smart-playlists` | ✅ Yes | |
| Run smart playlist | `POST /api/v1/smart-playlists/run` | ✅ Yes | |
| Stream file | `GET /media/<vpath>/<path>?token=` | ✅ Yes | Direct audio stream |
| Album art | `GET /album-art/<file>` | ✅ Yes | Public (no auth needed for art files) |
| Track art | `GET /api/v1/files/art?fp=` | ✅ Yes | Returns `{ aaFile }` |
| Metadata | `POST /api/v1/db/metadata` | ✅ Yes | `{ filepath }` |

### Jukebox (browser remote control — not suitable for HA)
| Function | Endpoint | Available to HA? | Notes |
|---|---|---|---|
| Push command | `POST /api/v1/jukebox/push-to-client` | ⚠️ Indirect | Only works while a browser tab is open and connected over WebSocket. Not reliable for automation. |
| Now playing | `GET /api/v1/jukebox/get-now-playing?code=` | ⚠️ Indirect | Cache from browser; stale if browser closed. |

### Not useful for HA
- `/api/v1/admin/*` — admin-only, not appropriate to expose through integration tokens
- `/api/v1/sonos/*` — HA has better native Sonos support
- `/api/v1/dlna/*` — HA has native DLNA

---

## 3. Playback Architecture Comparison

### Architecture A — HA → Velvet → Browser → Speakers
- **Can it work today?** Only if a browser is open, logged in, and in a jukebox session. The jukebox push mechanism (`push-to-client`) sends commands over WebSocket. The browser must already be running.
- **Reliability:** Poor. Browser tabs sleep, crash, get closed. Not headless.
- **HA use:** No. Not suitable for automation.

### Architecture B — HA → Velvet → Server Speaker (mpv) → Audio device ⭐ RECOMMENDED
- **Can it work today?** Yes, with the heartbeat caveat. All required endpoints exist.
- **What Velvet needs:** `serverAudio.enabled: true` in config + mpv installed.
- **What HA needs:** A custom component that polls `/status`, sends heartbeats, and can resolve library queries to filepaths for the queue.
- **Functionality retained:** Full queue, seek, volume, ReplayGain, gapless, crossfade (mpv's `--gapless-audio`), loop modes, ALSA output.
- **Functionality lost:** EQ (mpv equalizer not exposed through Velvet API), crossfade is gapless not true crossfade, no shuffle.
- **Reliability:** Good. mpv runs headlessly, survives browser close, auto-boots on first add.
- **Multi-room:** No native multi-room. Single output per Velvet instance.
- **Headless:** ✅ Yes.

### Architecture C — HA → Velvet → Sonos → Speakers
- **Can it work today?** Partially. Velvet can cast tracks to Sonos. But HA already controls Sonos natively with push events and grouping.
- **HA use:** Use HA's built-in Sonos integration instead. No Velvet middleman needed.
- **Functionality lost:** Nothing — HA Sonos integration is better than going through Velvet.

### Architecture D — HA → Velvet → DLNA Renderer → Speakers
- **Can it work today?** HA's DLNA integration can browse Velvet's DLNA MediaServer and play tracks on any DLNA renderer directly. No Velvet API changes needed.
- **HA use:** Use HA's built-in DLNA integration. The Velvet DLNA port (10293) is already a standard MediaServer. Set it up in HA as a media source.
- **Functionality lost:** No queue management from HA side (DLNA has no playlist management API).

### Architecture E — HA → Velvet → direct stream → HA media player
- HA's `media_player.play_media` service can play a Velvet stream URL on any HA media player (Chromecast, local browser TTS player, etc.) by constructing the stream URL manually: `GET /media/<vpath>/<path>?token=<jwt>`.
- **Functionality retained:** Streaming only — no queue, no seek, no volume via Velvet.
- **Use case:** One-shot automation ("play this specific track on the living room Chromecast").

### Ranking
1. **B (Server Speaker/mpv)** — fully Velvet-controlled, headless, REST-controllable, right tool
2. **E (direct stream)** — useful for one-shot automations on existing HA players
3. **D (DLNA)** — works with zero Velvet changes; HA native integration handles it
4. **C (Sonos via Velvet)** — redundant; use HA's Sonos integration
5. **A (Browser)** — not suitable for automation

---

## 4. Required Velvet Changes

### Mandatory (Phase 1 — without these HA integration is fragile)

#### 4.1 Suppress the heartbeat watchdog when playing (low-risk, 5-line change)
**Problem:** `server-playback.js` stops mpv after 300 s without a heartbeat. HA must therefore send heartbeats every ~60 s while playback is active.  
**Fix options:**
- A: HA sends heartbeats every 60 s (simpler, no Velvet change needed)
- B: Add a config flag `serverAudio.disableHeartbeat: true` that skips the watchdog (removes the need for HA to heartbeat)  
**Recommendation:** Option A requires no Velvet change; document it in the integration.

#### 4.2 Add `queue/add-many` endpoint
**Problem:** The `docs/API.md` documents `POST /api/v1/server-playback/queue/add-many` but it **does not exist** in `server-playback.js`. Loading an album (12–20 tracks) via single-add calls is fine but wastes roundtrips.  
**Fix:** Add the endpoint — trivial loop over `addToQueue()`.  
**Priority:** Medium — single-add works but is slow for albums.

#### 4.3 Add a "play-now" shortcut endpoint
**Problem:** To play an album, HA must: clear queue + call `queue/add` N times + call `queue/play-index 0`. Three types of calls for a simple action.  
**Fix:** `POST /api/v1/server-playback/play-now` with `{ filepaths: [] }` — clears queue, adds all, plays index 0.  
**Priority:** Medium — reduces HA automation complexity.

### Recommended (Phase 2 — improves reliability and HA UX)

#### 4.4 SSE push endpoint for playback state
**Problem:** HA polls every 2 s. This is wasteful and means 0–2 s lag in state display.  
**Fix:** `GET /api/v1/server-playback/events` — Server-Sent Events stream that pushes `{ event: 'state', data: <status_object> }` on every IPC event (`file-loaded`, `property-change:pause`, `property-change:playlist-pos`, mpv exit).  
**Priority:** Medium — polling works but SSE is cleaner.

#### 4.5 Expose mDNS / Zeroconf for HA auto-discovery
**Problem:** No self-advertisement. HA cannot auto-discover Velvet.  
**Fix:** Advertise `_velvet-music._tcp` on the local network using the `mdns-js` or `@homebridge/ciao` npm package (or the built-in node `dns-sd` if available). Broadcast hostname, port, instanceId.  
**Priority:** Low — manual IP entry works; Zeroconf is a quality-of-life addition.

#### 4.6 Normalise volume to 0–100 for HA
**Problem:** mpv volume goes 0–130 (>100 = amplification). HA `MediaPlayerEntity` expects 0–1 or 0–100.  
**Fix:** Map the API response `volume` (0–130) to `volumePercent` (0–100) in the status response, with a note that values above ~77 cause amplification.  
**Alternative:** The HA integration can do this mapping itself without a Velvet change.  
**Priority:** Low — HA can map.

### Optional (Phase 3)

#### 4.7 Expose shuffle
mpv itself supports `playlist-shuffle` command. Currently Velvet does not track or expose shuffle state (`shuffle: false` is hardcoded in `getStatus()`).

#### 4.8 Expose a `/api/v1/server-playback/play-playlist` endpoint
Resolves a playlist name → filepaths and loads it in one call. Reduces HA-side logic.

---

## 5. Home Assistant Integration Design

### Integration type
Custom component (`custom_components/velvet/`).

Registered as a `config_entry` with:
- `ConfigFlow` for setup (URL + username + password)
- `DataUpdateCoordinator` for polling
- One `MediaPlayerEntity` for the Server Speaker
- `MediaSource` for library browsing

### File structure
```
custom_components/velvet/
├── __init__.py          # config entry setup, coordinator init
├── manifest.json        # domain, version, requirements, iot_class
├── config_flow.py       # ConfigFlow: URL + credentials → token
├── const.py             # DOMAIN, UPDATE_INTERVAL, etc.
├── api.py               # Async HTTP wrapper around Velvet REST API
├── coordinator.py       # DataUpdateCoordinator — polls /server-playback/status
├── media_player.py      # VelvetServerSpeakerEntity (MediaPlayerEntity)
├── media_source.py      # VelvetMediaSource (browse library + return stream URLs)
├── services.yaml        # Extra HA services: play_playlist, play_album, auto_dj
├── strings.json         # UI strings
├── translations/
│   └── en.json
└── diagnostics.py       # Diagnostics dump for bug reports
```

### `manifest.json` (key fields)
```json
{
  "domain": "velvet",
  "name": "Velvet Music Server",
  "iot_class": "local_polling",
  "config_flow": true,
  "requirements": ["aiohttp>=3.9.0"],
  "documentation": "https://github.com/aroundmyroom/Velvet"
}
```

### Device registry
One device: **Velvet Server** (manufacturer: aroundmyroom, model: Velvet Music Server, sw_version from `/api/v1/ping`).  
One entity under it: **Server Speaker** (`media_player.velvet_server_speaker`).

### `MediaPlayerEntity` — `media_player.py`

#### Supported features (HA `MediaPlayerEntityFeature` flags)
```python
PLAY | PAUSE | STOP | NEXT_TRACK | PREVIOUS_TRACK | SEEK |
VOLUME_SET | VOLUME_STEP | QUEUE | BROWSE_MEDIA | SEARCH_MEDIA |
REPEAT_SET | TURN_ON | TURN_OFF
```

#### State mapping (from `GET /api/v1/server-playback/status`)
| Velvet status field | HA state |
|---|---|
| `running: false` | `MediaPlayerState.IDLE` |
| `running: true, playing: false` | `MediaPlayerState.PAUSED` |
| `running: true, playing: true` | `MediaPlayerState.PLAYING` |
| mpv not detected | `MediaPlayerState.OFF` |

#### `media_position` → `currentTime` (seconds float)
#### `media_duration` → `duration` (seconds float)
#### `volume_level` → `volume / 130` (mapped to 0.0–1.0)
#### `media_title`, `media_artist`, `media_album_name` → from `queue[currentIndex]`
#### `media_image_url` → construct `/album-art/<aaFile>` from queue entry `albumArt`

### `DataUpdateCoordinator` — `coordinator.py`
- Polls `GET /api/v1/server-playback/status` every **2 seconds** when playing, **10 seconds** when paused/idle.
- Sends `POST /api/v1/server-playback/heartbeat` every **60 seconds** when mpv is running (satisfies the watchdog's 300 s timeout).
- On coordinator update failure (network error / 401): marks entity as `unavailable`.

### `ConfigFlow` — `config_flow.py`
1. User enters: **Base URL** (e.g. `https://music.example.com:3000`), **Username**, **Password**
2. Flow calls `POST /api/v1/auth/login` → receives JWT
3. Stores: `{ url, username, token }` in config entry
4. Token has no expiry — store it long-term. Add a `GET /api/v1/auth/refresh` call on HA startup.

### `MediaSource` — `media_source.py`
Implements `async_browse_media()`:
- Root → vpaths (from `/api/v1/ping`)
- Vpath → albums
- Album → tracks  
- Search → `POST /api/v1/db/search`
- Playlists → `GET /api/v1/playlist/getall` → `POST /api/v1/playlist/load`

Stream URL returned per track: `GET /media/<vpath>/<filepath>?token=<jwt>`

### Custom services — `services.yaml`
```yaml
play_playlist:
  fields:
    playlist_name:
      required: true
      selector: { text: {} }
    
play_album:
  fields:
    album: { required: true, selector: { text: {} } }
    artist: { required: false, selector: { text: {} } }

auto_dj:
  fields:
    seed_track: { required: false, selector: { text: {} } }
    count: { default: 20, selector: { number: { min: 1, max: 200 } } }
```

---

## 6. Data Models

### Coordinator data (returned by `GET /api/v1/server-playback/status`)
```python
@dataclass
class VelvetStatus:
    running: bool
    playing: bool
    current_time: float        # seconds
    duration: float            # seconds
    current_index: int
    queue_length: int
    volume: float              # 0–130 (mpv)
    loop_mode: str             # "none" | "one" | "all"
    shuffle: bool
    queue: list[VelvetQueueEntry]

@dataclass
class VelvetQueueEntry:
    rel_path: str
    title: str
    artist: str
    album: str
    album_art: str             # relative path to art cache file
    bitrate: int | None
    sample_rate: int | None
```

### Config entry data
```python
{
    "url": "https://...",
    "username": "velvet-user",
    "token": "<jwt>",
}
```

---

## 7. Event Architecture

**Chosen: Local Polling** (`iot_class: local_polling`).

Justification: Velvet has no SSE/WebSocket push for Server Speaker state today.
Polling every 2 s is standard for HA local media player integrations (Plex, Kodi,
Squeezebox all poll). If SSE is added to Velvet (change 4.4), the integration can
be upgraded to `local_push` with an asyncio SSE consumer.

---

## 8. Authentication

### Recommended model
1. HA stores the JWT from login permanently (tokens do not expire unless the Velvet secret is rotated).
2. On HA startup / config entry load, call `GET /api/v1/auth/refresh` to renew the token and store the new one.
3. On 401 response, trigger a config entry re-auth flow that asks the user to re-enter their password.
4. Do **not** store the raw password in HA — store only the JWT token.
5. Consider creating a dedicated Velvet user for HA (with limited vpaths if needed).

### Credential storage in HA
Use HA's `config_entry.data` (stored in `.storage/core.config_entries`, encrypted on systems with HA OS secret storage). Never log the token.

---

## 9. Discovery

**Current status:** No automatic discovery supported — Velvet does not advertise itself.

**Short-term:** Manual entry in ConfigFlow (URL + credentials).

**Long-term:** If Velvet implements mDNS (change 4.5), the HA integration adds a `ZeroconfServiceInfo` entry in `manifest.json`:
```json
"zeroconf": [
  { "type": "_velvet-music._tcp.local." }
]
```
And a corresponding handler in `config_flow.py`'s `async_step_zeroconf()`.

---

## 10. Automation Examples

All examples assume the Server Speaker integration is set up.

### Example 1 — Play a playlist when arriving home
```yaml
trigger:
  - platform: state
    entity_id: person.owner
    to: home
action:
  - service: velvet.play_playlist
    target:
      entity_id: media_player.velvet_server_speaker
    data:
      playlist_name: "Evening Mix"
```
**Status:** Requires custom `play_playlist` service (fetches tracks, builds queue).

### Example 2 — Pause when leaving
```yaml
trigger:
  - platform: state
    entity_id: person.owner
    to: not_home
action:
  - service: media_player.media_pause
    target:
      entity_id: media_player.velvet_server_speaker
```
**Status:** Works today (calls `POST /api/v1/server-playback/set-pause`).

### Example 3 — Lower volume at 23:00
```yaml
trigger:
  - platform: time
    at: "23:00:00"
action:
  - service: media_player.volume_set
    target:
      entity_id: media_player.velvet_server_speaker
    data:
      volume_level: 0.3
```
**Status:** Works today.

### Example 4 — Auto-DJ on button press
```yaml
trigger:
  - platform: device
    type: turned_on
    device_id: <button_device_id>
action:
  - service: velvet.auto_dj
    target:
      entity_id: media_player.velvet_server_speaker
    data:
      count: 30
```
**Status:** Requires custom `auto_dj` service that calls `POST /api/v1/db/random-songs` 30 times and queues results.

### Example 5 — TTS announcement then resume Velvet
```yaml
action:
  - service: media_player.media_pause
    target: { entity_id: media_player.velvet_server_speaker }
  - delay: "00:00:01"
  - service: tts.speak
    target: { entity_id: media_player.living_room_speaker }
    data: { message: "Dinner is ready" }
  - delay: "00:00:05"
  - service: media_player.media_play
    target: { entity_id: media_player.velvet_server_speaker }
```
**Status:** Works today — pause/resume are both available.

---

## 11. Security

### Recommendations
1. **Create a dedicated HA user in Velvet** with access only to the needed vpaths. Do not use the admin account.
2. **Store only the JWT**, not the password.
3. **Use HTTPS** — Velvet supports TLS; the live server already uses it (`music.aroundtheworld.net:3000`). HA should connect over HTTPS only.
4. **JWT rotation:** If the Velvet secret is rotated, all tokens are invalidated. The HA integration handles this via the 401 re-auth flow.
5. **Token scope:** Standard user token (no `admin: true`, no `jukebox: true`) is sufficient for all Server Speaker and library endpoints. Admin endpoints (`/api/v1/admin/*`) should not be used by the integration.
6. The DLNA port (10293) has **no authentication** — never expose it externally.

---

## 12. Avoid Duplication with Existing HA Integrations

| Concern | Recommendation |
|---|---|
| **Sonos** | Use HA's built-in Sonos integration. Do not route through Velvet. |
| **DLNA renderers** | Use HA's built-in DLNA/UPnP integration. Point it at Velvet's DLNA port (10293) as a media source. |
| **Music Assistant** | Music Assistant can already use a Subsonic source. Velvet's full Subsonic API is functional. If the user runs Music Assistant, pointing MA at Velvet (via Subsonic) may be preferable to this custom integration. Velvet then becomes a library source for MA's own player entities. |
| **MPD** | Velvet's Server Speaker is not MPD-compatible. The mpv IPC is Unix socket JSON — not accessible externally. Use the Velvet REST API. |

---

## 13. Implementation Phases

### Phase 1 — Minimum Viable Integration
Goal: play/pause/stop, volume, seek, next/previous, current track display.

**Velvet changes:**
- None mandatory (heartbeat can be sent by HA)

**HA component files:**
- `__init__.py`, `manifest.json`, `config_flow.py`, `const.py`
- `api.py` — `login()`, `get_status()`, `set_pause()`, `seek()`, `volume()`, `next()`, `previous()`, `heartbeat()`
- `coordinator.py` — 2 s polling + 60 s heartbeat
- `media_player.py` — state, title/artist/album/art, play/pause/seek/volume/next/prev

**Result:** `media_player.velvet_server_speaker` appears in HA dashboard. Play/pause automations work.

### Phase 2 — Library Browse, Search, Queue
Goal: HA media browser shows Velvet library. `play_album`, `play_playlist` services.

**Velvet changes (recommended):**
- Add `queue/add-many` endpoint (trivial loop)
- Add `play-now` shortcut endpoint (clear + add-many + play index 0)

**HA component files:**
- `media_source.py` — browse albums/artists/playlists/search
- `services.yaml` + service handlers for `play_album`, `play_playlist`, `auto_dj`

### Phase 3 — Advanced Playback Control
Goal: repeat mode, shuffle (if Velvet adds it), smart playlists.

**Velvet changes:**
- Expose shuffle in `getStatus()` and add `shuffle` API endpoint
- Add `play-smart-playlist` shortcut

**HA component files:**
- Update `media_player.py` for repeat + shuffle
- Add smart playlist service

### Phase 4 — Push Events + Discovery (quality of life)
Goal: sub-second state updates, automatic HA discovery.

**Velvet changes:**
- `GET /api/v1/server-playback/events` — SSE push stream
- mDNS advertisement (`_velvet-music._tcp`)

**HA component files:**
- Update coordinator to use SSE instead of polling
- Add `zeroconf` handler in `config_flow.py`
- Change `iot_class` to `local_push`

---

## 14. Testing Plan

### Unit tests (HA side)
- `test_config_flow.py` — ConfigFlow with mocked HTTP (success, wrong password, unreachable host)
- `test_coordinator.py` — state parsing from `/status` JSON; 401 triggers unavailable; heartbeat timing
- `test_media_player.py` — feature flags, state mapping (OFF/IDLE/PAUSED/PLAYING), volume mapping (0–130 → 0.0–1.0), artwork URL construction

### API tests (Velvet side)
- Verify all Server Speaker endpoints return correct shapes (can be added to existing `test/regression-api-core.cjs`)
- Test `queue/add` → `status` round-trip (filepath appears in queue)
- Test volume 0, 65, 130 edge cases
- Test `set-pause: true` / `set-pause: false` both return `playing` correctly

### Integration / playback tests
- Manual: HA dashboard shows correct title/artist while Server Speaker plays
- Manual: seek in HA updates Velvet position within 2 s
- Manual: pressing next in HA advances the track

### Network failure tests
- Kill Velvet process → HA entity becomes `unavailable` within one poll cycle
- Restart Velvet → HA entity recovers within one poll cycle
- Rotate Velvet JWT secret → HA triggers re-auth flow (401 response)

### Multi-state tests
- Empty queue → `IDLE` state
- End of queue (mpv exits) → `IDLE` state (not `OFF`)
- mpv binary not found → `OFF` state or `unavailable` with a clear error message

---

## 15. Risks and Open Questions

| Risk | Severity | Notes |
|---|---|---|
| Heartbeat dependency | Medium | HA must send heartbeats or mpv stops. Document clearly in integration README. Consider adding `serverAudio.disableHeartbeat` config flag as safety valve. |
| `queue/add-many` missing | Low | Documented in API.md but not implemented. HA can work with single-add; it just makes 12 calls instead of 1 for an album. |
| Volume range 0–130 | Low | HA convention is 0–1. The integration maps it; no user confusion expected. |
| No shuffle | Low | mpv supports it; Velvet just doesn't expose it. Easily added. |
| No now-playing for browser player | Confirmed | By design. HA cannot track the browser player without jukebox mode. Not a risk — excluded from scope. |
| mpv not installed | Medium | `GET /server-playback/detect` returns `{ found: false }`. Integration should show a clear setup error and link to `docs/server-audio.md`. |
| Token invalidation on secret rotation | Medium | Admin action invalidates all tokens. HA will get 401 → re-auth flow. Documented. |
| Multi-user Velvet | Low | If multiple users have separate queues, each HA config entry would need its own user. One HA instance → one Velvet user is the simple case. |
| Music Assistant vs native integration | Open | If the user already runs Music Assistant with a Subsonic source pointing at Velvet, this custom integration is redundant. Needs to be evaluated per deployment. |
