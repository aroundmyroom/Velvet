# Sonos Integration

Velvet can **actively cast** playback to any Sonos device on your local network. This is a controller-push pattern: Velvet sends SOAP commands that tell Sonos what URL to play, then Sonos pulls the audio directly from Velvet's HTTP server.

This is different from the passive DLNA media-server (which lets Sonos *browse* your library). Sonos cast is a live push — track changes in the Velvet player immediately command the Sonos device.

---

A Sonos can also **follow a Velvet Room** (play along with Sendspin speakers,
with an adjustable delay): see [Velvet Rooms — Sonos speakers in a room](rooms.md#sonos-speakers-in-a-room).

## Requirements

- Sonos device reachable on the same LAN as Velvet (private IP addresses only)
- Sonos enabled in **Admin → Sonos** (it is on unless switched off). Discovery uses SSDP first; a seed IP (entered at **Scan Now**, or the saved default room) is only needed when multicast does not reach the speakers, e.g. across VLANs
- DLNA does **not** need to be enabled — Sonos pulls audio from Velvet's main HTTP port, not port 10293

---

## How it works

```
Velvet player (browser)
  │
  │  POST /api/v1/sonos/cast
  ▼
Velvet server (src/api/sonos.js)
  │  SOAP: SetAVTransportURI + Play
  ▼
Sonos device port 1400
  │  GET /media/<vpath>/<filepath>?token=…
  ▼
Velvet HTTP server → audio stream → 🔊 Sonos speaker
```

The `token` in the URLs Velvet hands to the speaker is a stream token minted for that one file (valid 8 hours): it opens only `/media/<that file>` and `/api/v1/sonos/transcode-stream?fp=<that file>`, nothing else, and it stops working when the user's tokens are revoked (password change, "Log out everywhere").

All communication with Sonos uses the public UPnP/SOAP protocol over plain HTTP on port 1400. No third-party library is used — Velvet speaks SOAP directly.

---

## Output picker

When at least one additional audio output is available (Server Speaker, Sonos or a Velvet Room), the **cast button** (screen + arc icon) appears in the player bar. Clicking it opens a picker:

| Option | Description |
|--------|-------------|
| **Browser** | Default — audio plays in the browser tab |
| **Server Speaker** | mpv on the server (requires Server Audio running + the `allow-mpv-cast` permission) |
| **Living Room** / **Kitchen** / … | Each discovered Sonos room, or the saved default room (requires Sonos enabled) |
| Velvet Rooms | See [rooms.md](rooms.md) |

Selecting a Sonos room immediately casts the current track at the current position. Crossfade is automatically disabled while casting to Sonos and restored when you switch back to Browser.

### Sonos is a speaker, not a second source of truth

**The web player's own queue (`S.idx`/`S.queue`) is the single source of truth for what should be playing.** Sonos is treated as a plain output device: whenever the web UI decides a new track should play — the user picks a song, Auto-DJ advances the queue, or the local (muted, while casting) player reaches the natural end of a track — Velvet tells the speaker to play exactly that track. Nothing reads the speaker's own reported state back to *decide* what should play; the player never asks "what does Sonos think it's doing" and reconciles against that.

This is a deliberate design choice, not an oversight. An earlier version tried to keep a multi-track window mirrored on the device and have the device "own" advancing through it on its own, with the browser polling and reconciling to follow along — window mapping, track-identity matching, external-takeover detection, incremental top-up and trim, multi-tier stall recovery. Real, working code at each step, and each one closed one gap while opening another: a two-way relationship between the player and the speaker's own state is inherently more places for the two to drift apart than a one-way one. Casting to Sonos now works the same way casting to the Server Speaker or playing in the Browser does — the player decides, the output plays it.

One track is cast at a time (no lookahead window), so there is nothing left for the device's own idea of "what's queued" to drift away from the player's. This means a short gap between tracks while the new one starts streaming — the trade-off for a design with a single source of truth. The progress bar shown for a Sonos-cast track is the local player's own clock (`audioEl.currentTime`/`duration`), the same as for Browser or Server Speaker output — it is never read back from the device.

**The one thing the speaker *is* believed about: that it finished.** The local mirror is a browser `<audio>` element, and a browser does not always run in real time — a suspended or throttled tab (laptop lid, background window, battery saver) or a buffering stall leaves the mirror's clock behind while the speaker, streaming the same file directly from the server, plays on at full speed and reaches the end. Before v0.5.29 that combination was silent: the speaker sat STOPPED, the mirror never reached `ended`, nothing advanced — and when the tab woke up, the "device idled" self-heal re-cast the *same* track from the mirror's stale position, so a song that had already finished played its tail again (seen live for a whole morning: Sonos done at 11:01, the web player still at 2:55 at 11:46). The 10-second heartbeat now checks the wall clock: if the speaker reports STOPPED and, counting from the cast time plus the cast's seek offset, it has had the whole track's worth of real time, it finished — the web player advances exactly as its own `ended` would have, and the next cast's log line says so (`cast-queue ▶ … (speaker finished the previous track; web player clock was at 2:55/4:54)`). A STOPPED speaker *before* that point is still treated as a dropped stream and re-cast at the mirror's position, as before. The decision uses only Velvet's own cast timestamp and the device's play/stop state — never the device's position or track — so there is still a single source of truth for *what* plays; the speaker only gets a vote on *when it is done*.

**Why the mirror fell behind in the first place — and the cure.** Casting silences the browser through the Web Audio graph (`_castMuteGain` at 0, so the VU meters and visualizer stay fed), not by muting the element. A graph that outputs exact zeros lets Chromium close the real audio device after ~30 s and keep the context alive on a timer-driven "fake" sink — and a media element connected to the graph advances only as fast as that sink pulls. In a foreground tab the fake sink keeps up; in a background tab it lags or stalls, which is exactly the "browser is active, tab is not" situation. Since v0.5.29 a keep-alive (`_setCastKeepAlive`) sits on the graph output whenever cast-mute is on, so the real device stays open. The 10-second heartbeat also measures the mirror against the wall clock and reports `local mirror lagging: advanced Xs in Ys of wall clock` (browser console, and in the next `cast-queue ▶` log line) if it ever falls behind again; the wall-clock "speaker finished → advance" rule above remains the safety net regardless.

**That keep-alive alone was not enough — the tab itself can still freeze, not just lag.** Seen live (2026-09-30): the reconciliation heartbeat kept working through a fully backgrounded session — every server auto-advance was picked up within seconds — but Auto-DJ's own pick chain (two Last.fm calls, a DB query, growing and saving the queue) is several consecutive event-loop turns long, and did not always finish; the saved queue simply stopped growing, silently, with no error. Chromium exempts a tab from background *freezing* (not just the throttling above) while it is playing audible media, and a v0.5.29 DC offset almost certainly does not qualify for that — a constant, non-oscillating value produces no sound at any level, so it is very unlikely to register on an audibility check even though it kept the audio device open. Since v0.5.30 the keep-alive is a genuinely oscillating tone instead (17.4 kHz, −45 dBFS — near the top of adult hearing, so essentially nobody hears it at normal listening levels, while still carrying real signal power for the browser's own audibility check to register). This is local-playback-device output only, never anything that reaches Sonos. It is a best-effort aim at the one documented lever a web page has for this — no page can force a browser to never freeze a hidden tab, and this is not guaranteed to work on every browser or every version.

**So the room must not depend on it working.** When the speaker finishes a track and the saved queue has nothing after it — the browser never got around to picking a next song — the server picks one itself: a plain track from the user's own library (their vpath scope only, no rating/BPM/genre/similar-artist scoring — the same tier a third-party client's shuffle gets), appends it to that user's saved queue, and casts it, logged as `cast-queue ▶ … (server fallback pick: …)` to make clear it wasn't an Auto-DJ decision. The next time the browser is actually alive, its own Auto-DJ prefetch takes back over exactly as normal — this only ever fills a gap the browser could not fill itself, never picks in place of a browser that is working.

**When the player cannot act at all: server-side auto-advance.** All of the above needs the browser to be running JavaScript. Chrome *freezes* a hidden tab after about five minutes unless it is audibly playing — and a cast-muted tab never is, keep-alive or not (the keep-alive is below Chrome's audibility threshold by design). A frozen tab runs nothing: no heartbeat, no `ended`, no cast. Seen live (2026-09-30): the speaker finished El Coco at 14:20:04, the player's state was last saved at 14:20:08 at 3:51, and the room stayed silent. So the server keeps the one piece of state it needs to carry on by itself: for every cast it records what it put on the speaker, when, and from which offset (`_lastCastByIp`). When the speaker then reports STOPPED for that same track and the wall clock says it finished (`_speakerFinishedVerdict`: elapsed since the cast, plus the seek offset, ≥ duration − 3 s), the server waits 12 s for the player to cast something — the normal path when it is awake — and if nothing comes, and the device is still stopped, it casts the **next track from the player's own saved queue** (`user_settings.queue`, the same snapshot a reload restores from), updates that snapshot to point at it, and records the auto-advance for that user. It logs it as `cast-queue ▶ … (server auto-advance: …)`. If the saved queue has nothing after the finished track, the server uses the plain fallback pick described above; only if that finds nothing does it log that and stay silent. This path is driven by the speaker's own UPnP event notifications (`/api/v1/sonos/event`), so it only works when the speaker can reach Velvet's callback URL.

When the player wakes up it reconciles from that record and nothing else: `transport-status` carries `serverAdvanced: { fp, position }` for the caller until it has caught up, and the heartbeat jumps to that queue entry; and a `cast-queue` for the very track the server started answers `alreadyPlaying` with the position, so the player positions its mirror instead of restarting the speaker — whether the jump came from the heartbeat or from the mirror's own late `ended`. The record is one-shot, so a later deliberate replay is a real cast. What the device itself reports is still never used to decide what plays.

Play, pause and seek on the web player mirror to the speaker immediately (`POST /api/v1/sonos/set-pause`, `POST /api/v1/sonos/seek`) — these are commands, not something the player waits to see reflected back. Controlling playback from the Sonos app itself, or another controller, is not something the web player watches for or reacts to; the next time the web UI has something to tell the speaker (a track change, a seek, a pause), that command simply takes effect.

A lightweight background poll (`GET /api/v1/sonos/transport-status`, every 10s while casting) exists for these purposes only: falling back to Browser output automatically after 3 unreachable polls in a row (~30s), catching up with a server auto-advance, and re-casting the current track if the speaker is reachable but has stopped playing something the local player still believes should be playing (a dropped stream, a device that idled) — a single, unconditional re-cast, not a graduated series of recovery strategies.

Sonos playback uses the same wrapped history event as the controlling browser
session. Track changes, pauses, skips, and natural completion therefore remain
one consistent history lifecycle, with no duplicate event created by the cast
transport request itself.

The output picker is also available in the **Server Remote** at `/server-remote/`.

### Device readiness indicator

Each Sonos room row shows a **coloured dot** at the left that reflects whether the device is ready to receive audio before you click it:

| Dot | Colour | Meaning |
|-----|--------|---------|
| Checking | Checking | Transport-status fetch in progress |
| 🟢 Green | Ready | Device answered — safe to cast |
| 🔴 Red | Offline | Device unreachable (powered off, wrong IP, different network). The row cannot be selected. |

The check runs **async** after the picker opens — the picker appears immediately and the dot updates in place.

> **Tip:** A device that is still waking up can time out on the first cast. On `POST /api/v1/sonos/cast` (used by the Server Remote) the server then waits 2 seconds, re-runs discovery and retries once. The web player's `cast-queue` does not retry; its 10-second heartbeat re-casts if the speaker stays stopped.

---

## Sonos Favourites

Velvet can start **Sonos favourites** — from any service (Sonos Radio, Spotify, Apple Music, …) — directly on a detected Sonos device from the player sidebar view.

- Sidebar entry and view title: **Sonos Favourites**
- Sources: all "My Favorites" (FV:2) on the speaker, from any service

### Menu visibility (auto, no reload required)

The Sonos Favourites menu entry is tied to live reachability:

- Hidden when Sonos is disabled or no reachable Sonos device is detected
- Shown automatically when a reachable Sonos device appears
- Updated in the running UI without a page refresh

### API

- `GET /api/v1/sonos/favorites?ip=` returns **every** favourite (FV:2), each
  tagged with its originating `service`/`serviceKey` and carrying the playable
  `res`/`resMD` plus an `isContainer` flag.
- `GET /api/v1/sonos/radio-favorites?ip=` returns only the Sonos Radio subset.
- `POST /api/v1/sonos/play-favorite` with `{ ip, favoriteId }` plays any
  favourite regardless of service. It replays the favourite's own stored
  `res`/`resMD`, which already carries the device's service auth token, so
  Spotify/Apple Music playlists play without Velvet needing those credentials.
  Container favourites (playlists) are enqueued and started from track 1; single
  streams are set directly on the transport. An unknown id answers 404, a
  favourite without a playable resource 422.

#### Favourite playback mode (web player behaviour)

A favourite plays content that is **not** in Velvet's own queue (Spotify, radio,
…), so it can't use the queue-mirroring cast path. Starting one puts the web
player into a dedicated **Sonos-Favourite mode**:

- The browser is paused and muted (the favourite is the audible output).
- The player bar shows the device's **live now-playing** — track title, artist,
  cover and progress — refreshed every 3 s from `GET /api/v1/sonos/transport-status`
  (which now also returns `trackTitle`/`trackArtist`/`trackAlbum`/`trackArt`/`trackUri`).
  The cover prefers the favourite's own HTTPS art (the device's per-track `/getaa`
  proxy is HTTP and would be blocked as mixed content).
- The output button shows the room as the active output.
- Pressing **Play**, picking any local track, or selecting **Browser** in the
  output picker takes control back to the browser and pauses the favourite on the
  device.
- If the favourite stops on the device (ends, or stopped from the Sonos app),
  the web player leaves favourite mode automatically.

> Known limitation: the full-screen **Playing Now** view is built around library
> songs (bio, similar artists, audio pills) and still reflects the queue, not an
> external favourite. The always-visible player bar is the live indicator.

### Hiding favourites

Two layers keep the list clean:

- **Auto-hidden (non-playable).** Favourites with no playable `res` — the
  art-less Sonos shortcut folders (e.g. "Nu trendy", "Sonos presenteert",
  "Sonos Radio ontdekken") that can't be started via the local API — are
  concealed by default.
- **Admin hide/show.** Each favourite row shows a **Hide**/**Show** toggle for
  curating services you don't want surfaced.

Both are recalled via a **Show hidden (N)** control at the top (available to all
users — it's a view toggle). Admin hide preferences are keyed by the favourite's
stable content id and persisted in `sonos.hiddenFavorites` in the config, so they
apply to all users and survive restarts (favourite reordering on the device does
not lose the setting).

---

## Admin panel

**Admin → Sonos**

| Control | Description |
|---------|-------------|
| **Enable / Disable toggle** | When disabled, Sonos output is hidden from all output pickers |
| **Auto-transcode for Sonos** | Automatically convert incompatible audio to MP3 before sending to Sonos. Covers Opus files (YouTube downloads, recordings), WAV files, and hi-res audio (88/96/176/192 kHz FLAC/WAV — most Sonos hardware caps at 48 kHz). Uses the built-in ffmpeg — no separate Transcode setup required. |
| **Sleep mode** | Toggle direct sleep control. When on and casting to Sonos, **pause** turns the speaker's status LED off (the device stays paused and reachable) and **play** turns it back on. A **Test sleep timer** panel exposes **Sleep now** / **Wake** with a live countdown + LED/transport readout to verify the device responds. |
| **Probe a Device** | Enter any Sonos IP to test reachability and retrieve room name, model + UUID |
| **Discover Rooms → Scan Now** | Runs discovery (SSDP, then the optional seed IP); populates the room list |
| **Set as Default** | Saves a room as the default room, used when no room is given and pre-selected in the output picker |
| **Test Playback** | Plays a random song on a selected device — for verifying setup |

### Setting up from scratch

1. Enable Sonos in the toggle at the top of the panel
2. Click **Scan Now** (enter a seed IP first if your speakers are on another subnet), or enter one device's IP under **Probe a Device** and click **Probe**
3. Click **Set as Default** on the room you want as the default
4. The output picker now shows the Sonos rooms

---

## User permissions

- Casting to Sonos needs an admin account or the `allow-mpv-cast` permission (**Admin → Users → Cast**). Every `/api/v1/sonos/*` route except the speaker's own `/event` callback checks this and answers `403 { error: 'Not allowed' }` otherwise.
- The web player and the **Server Remote** only show Sonos rooms to those users.
- The Server Speaker output in the web player needs the same permission.
- Saving the default room, changing Sonos settings, test playback and hiding favourites are admin-only.

---

## Queue behaviour

- **Track changes**: when Auto-DJ or the queue advances in Velvet, the next track is automatically cast to Sonos
- **Seek (Velvet → Sonos)**: seeking in the player bar is forwarded to the Sonos device
- **Seek / skip in a Sonos app**: not read back; the web player keeps its own position
- **Volume**: the player's volume slider is scaled so that 100% sets Sonos volume 50 (`SONOS_MAX_VOL` in `webapp/app.js`); the server itself accepts 0–100
- **Pause / Play**: transport controls in the player bar command Sonos directly
- **Page reload**: the cast session is saved per user in `localStorage` (`ms2_casting_sonos_<username>`) and restored on reload; the stored room's IP is re-checked against a fresh scan, and pressing Play re-casts the current track at the saved position

---

## IP tracking and stale-IP correction

Sonos devices may change IP address between sessions (DHCP lease renewal) or after a factory reset. Velvet corrects stale IPs automatically through several layers:

| Layer | Trigger | What happens |
|-------|---------|-------------|
| **Boot restore** | Page load while a cast session is saved in `localStorage` | UUID-based lookup in fresh device list → if same device found at a different IP, `localStorage` is updated before the reachability check runs. Falls back to admin default room if UUID not found. |
| **Output picker scan** | Every time the output picker is opened | `_snapSonosRoom()` compares saved room UUID/IP against fresh scan results; updates `S.sonosRoom.ip` and localStorage if changed |
| **Cast response** | Any `/cast` or `/cast-queue` call (track change, song start) | Server returns `actualIp`. `/cast` re-runs SSDP discovery when the device is unreachable and returns the IP it succeeded on; `/cast-queue` returns the IP resolved from the alias table and room cache. Client calls `_handleCastResponse()` to update `S.sonosRoom.ip` and localStorage |
| **Server-side alias** | `/cast-queue`, `/set-volume`, `/set-pause`, `/seek` and the queue routes | `_resolveIp()` checks the discovered-rooms cache and `_ipAliases` (set on a `/cast` redirect); with exactly one known room it uses that room's IP |
| **Persisted default-room heal** | A `/cast` redirect where the device matches the saved default room (by UUID or old IP) | `_healDefaultRoomIp()` writes the rediscovered IP back to `sonos.defaultRoom.ip` in the config file, so server-side callers that read the default room (favourites, default-room casts) stop hitting the dead address after a restart |

---

## Casting through the Sonos queue

The web player casts **one track at a time** with `POST /api/v1/sonos/cast-queue`: the speaker's queue is replaced by the current track, which then plays. When you switch away from Sonos or close the tab, the queue is wiped with `POST /api/v1/sonos/queue/clear` — only if every track in it points at Velvet. A queue built by another app is left alone.

The routes `cast-queue` (with several tracks), `queue/append`, `queue/trim`, `queue/jump` and `events/stream` can still keep a longer window of tracks on the speaker, but the web player does not use them.

### Metadata in controller apps

| App | Now-playing | Queue rows |
|-----|-------------|-----------|
| CLIC (iOS) | ✅ art + title | ✅ title + duration + **per-row art** |
| Sonos S2 (iOS/Android) | ✅ art + title | ⚠️ rows visible, **metadata blank** |
| Any UPnP controller | ✅ | varies |

### Why per-row art works in CLIC but not S2
Per-row album art is served via the speaker's own `/getaa` proxy (`albumArtURI=/getaa?u=<stream>`), which extracts the embedded cover from the stream — controllers only render queue-row art the speaker serves. Transcoded streams (which drop the cover) fall back to the cached `/album-art/` URL.

The **S2 app resolves queue-row metadata by *source*** (a registered music service or indexed library), not from the stored DIDL — so HTTP-streamed content shows blank rows in the S2 *list* view (now-playing still reads the DIDL directly and renders fully). This is a structural S2 limitation, not missing data; CLIC reads the stored DIDL and renders everything.

### Why queue-based?
Direct `SetAVTransportURI` with a plain HTTP stream URL causes S2 to switch into "radio stream" display mode (album art only, no text). Casting through the Sonos queue tells S2 this is a proper track — the full Now Playing view with all metadata fields is rendered.

### Album art URL
For transcoded streams, art is served from Velvet's main port (`/album-art/...`), over `https://` when Velvet has an SSL certificate configured, otherwise `http://`. iOS apps enforce App Transport Security (ATS), which silently blocks plain `http://` image loads. Other tracks use the speaker's own `/getaa` proxy.

---

## API endpoints

All endpoints except `/api/v1/sonos/event` require a valid JWT (`x-access-token` header or `token` query param). "User" means an admin or a user with the `allow-mpv-cast` permission; anyone else gets `403`. Where a route takes `ip`, it falls back to the saved default room, and only private IP addresses are accepted.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `NOTIFY` | `/api/v1/sonos/event` | None (private-LAN peers with a known subscription ID) | UPnP event callback from the speaker; body capped at 256 KB |
| `GET` | `/api/v1/sonos/devices` | User | Return cached room list, default room and settings (`enabled`, `transcodeOpus`, `sleepEnabled`); re-scans when the cache is older than 5 minutes |
| `POST` | `/api/v1/sonos/scan` | User | Force re-discovery. Body `{ seedIp? }`; falls back to `knownIps[0]`, then the default room's IP |
| `GET` | `/api/v1/sonos/probe?ip=X.X.X.X` | User | Probe a single IP — `{ ok, name, model, uuid, ip }` |
| `POST` | `/api/v1/sonos/save-default` | Admin | Save a room as the default cast target. `{ ip, name, uuid? }` |
| `POST` | `/api/v1/sonos/cast` | User | Cast one track. `{ ip?, filepath, title?, artist?, album?, aaFile?, seekTo?, paused? }`; returns `actualIp`, `streamUrl`, `streamStartOffset`, `isTranscodeStream` |
| `POST` | `/api/v1/sonos/set-pause` | User | Pause or resume Sonos playback. `{ ip, paused }` |
| `POST` | `/api/v1/sonos/seek` | User | Seek to a position. `{ ip, position }` (seconds) |
| `POST` | `/api/v1/sonos/set-volume` | User | Set volume. `{ ip, volume: 0–100, muted? }` |
| `GET` | `/api/v1/sonos/transport-status?ip=X` | User | Poll playback state (playing/paused/stopped, position, duration, `track`, `nrTracks`, `trackFp`, plus `trackUri`/`trackTitle`/`trackArtist`/`trackAlbum`/`trackArt` for now-playing, and `serverAdvanced`). An unreachable device answers a stopped state with `unreachable: true` |
| `POST` | `/api/v1/sonos/cast-queue` | User | Replace the Sonos queue with `tracks` and play `index`; extra tracks are appended in the background. `{ ip, tracks, index?, seekTo?, paused?, reason? }` |
| `POST` | `/api/v1/sonos/queue/append` | User | Append tracks without touching the current one. `{ ip, tracks }` |
| `POST` | `/api/v1/sonos/queue/trim` | User | Remove already-played tracks from the front of the queue. `{ ip, currentTrack, keep? = 2 }` |
| `POST` | `/api/v1/sonos/queue/jump` | User | Play a track already in the queue. `{ ip, track }` (1-based; 409 if beyond the queue) |
| `GET` | `/api/v1/sonos/events/stream` | User | Server-sent events with the speaker's transport changes |
| `POST` | `/api/v1/sonos/queue/clear` | User | Wipe the Sonos queue — only if every track belongs to Velvet (foreign queues untouched) |
| `GET` | `/api/v1/sonos/battery?ip=X` | User | Battery info for portable speakers; `{ supported: false }` otherwise |
| `GET` | `/api/v1/sonos/device-info?ip=X` | User | Device details for the output picker's info panel |
| `POST` | `/api/v1/sonos/test-play` | Admin | Play a random song on a device (admin test) |
| `GET` | `/api/v1/sonos/favorites?ip=X` | User | List **all** "My Favorites" (FV:2) — Sonos Radio, Spotify, Apple Music, TuneIn, etc. Each entry tagged with `service`/`serviceKey`, plus `res`/`resMD`/`isContainer` |
| `GET` | `/api/v1/sonos/radio-favorites?ip=X` | User | The Sonos Radio subset of favourites. Integration API: the web player does not call it (its pickers use `/sonos/favorites`) |
| `POST` | `/api/v1/sonos/play-favorite` | User | Play any favourite by FV:2 id via its own `res`/`resMD` (works for Spotify/Apple Music). `{ ip, favoriteId }` |
| `POST` | `/api/v1/sonos/favorite-visibility` | Admin | Hide/show a favourite in Velvet's view. `{ key, hidden }` — persisted in `sonos.hiddenFavorites` (all users) |
| `GET` | `/api/v1/sonos/sleep?ip=X` | User | Read the native sleep timer — `{ active, remaining, generation }` |
| `POST` | `/api/v1/sonos/sleep` | User | Set/clear the native sleep timer via `ConfigureSleepTimer`. `{ ip, seconds?, minutes?, play? }` — ≤ 0 clears it; `play: true` resumes on wake |
| `GET` | `/api/v1/sonos/led?ip=X` | User | Read the status-LED state (`GetLEDState`) — `{ state: 'On'｜'Off' }` |
| `POST` | `/api/v1/sonos/led` | User | Set the status-LED state (`SetLEDState`). `{ ip, state: 'On'｜'Off' }` — sleep-mode visual cue |
| `GET` | `/api/v1/sonos/browse-content?ip=X&objectId=Y` | User | Browse a Sonos ContentDirectory object (`browseFlag`, `startingIndex`, `requestedCount` optional) |
| `POST` | `/api/v1/sonos/play-cloud-object` | User | Play a Sonos Radio cloud object. `{ ip, cloudObjectId, title?, authToken? }` |
| `GET` | `/api/v1/sonos/transcode-stream?fp=&token=&start=` | User | Stream a file as MP3 (192 k @ 48 kHz) via the built-in ffmpeg; `start` seeks in seconds. Used automatically for Opus, WAV and >48 kHz files when Auto-transcode is enabled. |
| `POST` | `/api/v1/admin/sonos` | Admin | Save Sonos config (`enabled`, `transcodeOpus`, `sleepEnabled`, all booleans); at least one is required |

---

## Config file

`save/conf/default.json` — Sonos settings are stored under `sonos`:

```json
{
  "sonos": {
    "enabled": true,
    "transcodeOpus": true,
    "sleepEnabled": false,
    "knownIps": [],
    "hiddenFavorites": [],
    "defaultRoom": {
      "ip": "192.168.1.100",
      "name": "Living Room",
      "uuid": "RINCON_XXXXXXXXXXXX00"
    }
  }
}
```

`enabled` defaults to `true` if the key is absent; `transcodeOpus` and `sleepEnabled` default to `false`. An old `pauseSleepMinutes` key is ignored. `knownIps[0]` is used as a seed IP for discovery.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| No Sonos rooms in output picker | Sonos disabled in admin, or no room discovered and no default room saved |
| Probe times out | Device IP wrong, or Sonos on a different VLAN/subnet |
| Cast succeeds but no audio | Velvet server IP not reachable from Sonos (check firewall); audio port (3000 by default) must be open |
| Volume/pause after cast does nothing (EHOSTUNREACH in log) | Sonos IP changed (DHCP lease renewed). Velvet auto-corrects this: the next `/cast` triggers SSDP re-discovery, resolves the new IP, and stores it. If the session was restored from a previous browser session, the IP is snapped on boot. No manual action needed. |
| Opus or hi-res FLAC file is silent on Sonos | Enable **Auto-transcode for Sonos** in Admin → Sonos. Opus is not supported by Sonos hardware. Most Sonos devices also cap FLAC/PCM at 48 kHz — 88/96/176/192 kHz files will be silent without transcoding. |
| WAV file is silent on Sonos | Enable **Auto-transcode for Sonos** in Admin → Sonos; WAV files are then sent as MP3. |
| One specific track can never be cast — log shows `AddURIToQueue failed: … code=402` on every attempt, other tracks fine | UPnP 402 = "invalid args": the speaker rejected the metadata itself. The usual cause is a tag (title/artist/album) containing bytes that are illegal in XML — control characters left behind by a mangled tag encoding. Velvet strips those (and lone surrogate halves) before building the DIDL; emoji and other valid characters are kept, and `'` is sent as `&apos;`. If you still see it, fix the offending tag in the Tag Workshop. |
| Next random/Auto-DJ track starts late or first cast times out right after a hi-res/transcoded track | On `/cast`, Velvet waits up to 3.5 s before a cast that comes within 12 s of the previous one when either involves a transcoded stream, and Sonos SOAP calls time out after 9 s. If you still see this, keep `journalctl -fu music.service` open and look for `[sonos] rapid cast after ... waiting ... before SOAP` and timeout/retry lines. |
| Sonos never gets louder than about half volume | The player maps 100% on its slider to Sonos volume 50 (`SONOS_MAX_VOL = 50` in `webapp/app.js`) |
| Cast session lost after page reload | Clear localStorage key `ms2_casting_sonos_<username>` and re-select room |

