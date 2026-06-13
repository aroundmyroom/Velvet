# Sonos Integration

Velvet can **actively cast** playback to any Sonos device on your local network. This is a controller-push pattern: Velvet sends SOAP commands that tell Sonos what URL to play, then Sonos pulls the audio directly from Velvet's HTTP server.

This is different from the passive DLNA media-server (which lets Sonos *browse* your library). Sonos cast is a live push — track changes in the Velvet player immediately command the Sonos device.

---

## Requirements

- Sonos device reachable on the same LAN as Velvet
- One known Sonos IP configured in **Admin → Sonos** (seed IP for device discovery)
- User must have the `allow-mpv-cast` permission (same permission gate as Server Speaker)
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

All communication with Sonos uses the public UPnP/SOAP protocol over plain HTTP on port 1400. No third-party library is used — Velvet speaks SOAP directly.

---

## Output picker

When at least one additional audio output is available (Server Speaker or Sonos), the **cast button** (screen + arc icon) appears in the player bar. Clicking it opens a picker:

| Option | Description |
|--------|-------------|
| **Browser** | Default — audio plays in the browser tab |
| **Server Speaker** | mpv on the server (requires Server Audio enabled + permission) |
| **Living Room** / **Kitchen** / … | Each discovered Sonos room (requires Sonos enabled + permission) |

Selecting a Sonos room immediately casts the current track at the current position. Crossfade is automatically disabled while casting to Sonos and restored when you switch back to Browser.

The output picker is also available in the **Server Remote** at `/server-remote/`.

### Device readiness indicator

Each Sonos room row shows a **coloured dot** at the left that reflects whether the device is ready to receive audio before you click it:

| Dot | Colour | Meaning |
|-----|--------|---------|
| ⚫ Pulsing grey | Checking | Transport-status fetch in progress |
| 🟡 Yellow | Warming up | Device found via SSDP but UPnP renderer not yet ready (typically 5–15 s after power-on). Casting now may fail or be retried automatically. |
| 🟢 Green | Ready | Device reachable and renderer responsive — safe to cast |
| 🔴 Red | Offline | Device unreachable (powered off, wrong IP, different network) |

The check runs **async** after the picker opens — the picker appears immediately and the dot updates in place, so you never wait before you can click.

> **Tip:** If the dot is yellow and you click anyway, Velvet will still attempt the cast and retry automatically once the renderer wakes up (built-in 2-second retry on timeout). The dot is purely informational.

---

## Sonos Radio favourite channels

Velvet can start Sonos Radio **favourite channels** directly on a detected Sonos device from the player sidebar view.

- Sidebar entry: **Sonos Radio** (nav label)
- View title: **Sonos Radio Favourite Channels**
- Channel sources: Sonos favourites returned by the local Sonos ContentDirectory / MusicServices bridge

### Playback behavior

- Pressing **Play on Sonos** for a favourite channel pauses active Velvet playback first.
- Starting a Sonos favourite channel interrupts any currently playing queue audio until playback is resumed manually.
- Channel start strategy prioritizes direct Sonos radio transport (`x-sonosapi-radio`) with retry variants, then falls back to MusicServices/legacy paths when needed.

### Menu visibility (auto, no reload required)

The Sonos Radio menu entry is now tied to live reachability:

- Hidden when Sonos is disabled or no reachable Sonos device is detected
- Shown automatically when a reachable Sonos device appears
- Updated in the running UI without a page refresh

---

## Admin panel

**Admin → Sonos**

| Control | Description |
|---------|-------------|
| **Enable / Disable toggle** | When disabled, Sonos output is hidden from all output pickers |
| **Auto-transcode for Sonos** | Automatically convert incompatible audio to MP3 before sending to Sonos. Covers Opus files (YouTube downloads, recordings), WAV files, and hi-res audio (88/96/176/192 kHz FLAC/WAV — most Sonos hardware caps at 48 kHz). Uses the built-in ffmpeg — no separate Transcode setup required. |
| **Sleep mode** | Toggle direct sleep control. When on and casting to Sonos, **pause** drops the speaker's status LED (direct sleep — a paused / zero-volume state, device stays reachable) and **play** turns it back on. A **Test sleep timer** panel exposes **Sleep now** / **Wake** with a live countdown + LED/transport readout to verify the device responds. Note: with the device's Battery Saver enabled it powers off (unreachable) after 30 min idle — disable Battery Saver in the Sonos app for a reachable low-power sleep. |
| **Probe by IP** | Enter any Sonos IP to test reachability and retrieve room name + UUID |
| **Scan** | Trigger discovery using the seed IP; populates the room list |
| **Default room** | The room pre-selected in the output picker; set by clicking a room in the list |
| **Test playback** | Plays a random song on a selected device — for verifying setup |

### Setting up from scratch

1. Enable Sonos in the toggle at the top of the panel
2. Enter your Sonos device's IP in the **Probe** field and click **Probe**
3. Confirm the room name shown, then click **Set as default**
4. Click **Scan** to discover any additional devices
5. The output picker will now show Sonos rooms for users with `allow-mpv-cast` permission

---

## User permissions

Sonos casting (and Server Speaker) is gated by the **`allow-mpv-cast`** permission.

- Users with `allow-mpv-cast: true` see Sonos rooms in the output picker
- Users without this permission only see **Browser** — the output button may not appear at all
- Set in **Admin → Users → Edit user → Allow cast**

---

## Queue behaviour

- **Track changes**: when Auto-DJ or the queue advances in Velvet, the next track is automatically cast to Sonos
- **Seek (Velvet → Sonos)**: seeking in the player bar is forwarded to the Sonos device
- **Seek (Sonos → Velvet)**: seeking in the Sonos S2 app, CLIC, or any other Sonos controller is detected within 3 seconds and reflected back in the Velvet progress bar (bi-directional sync)
- **Volume**: the volume slider controls Sonos volume (capped at 50 by default — `SONOS_MAX_VOL`)
- **Pause / Play**: transport controls in the player bar command Sonos directly
- **Page reload**: the cast session is saved in `localStorage` and restored on reload; Sonos resumes at the saved position

---

## IP tracking and stale-IP correction

Sonos devices may change IP address between sessions (DHCP lease renewal) or after a factory reset. Velvet corrects stale IPs automatically through several layers:

| Layer | Trigger | What happens |
|-------|---------|-------------|
| **Boot restore** | Page load while a cast session is saved in `localStorage` | UUID-based lookup in fresh device list → if same device found at a different IP, `localStorage` is updated before the reachability check runs. Falls back to admin default room if UUID not found. |
| **Output picker scan** | Every time the output picker is opened | `_snapSonosRoom()` compares saved room UUID/IP against fresh scan results; updates `S.sonosRoom.ip` and localStorage if changed |
| **Cast response** | Any `/cast` API call (track change, song start) | Server returns `actualIp` — the IP the SOAP call actually succeeded on after any SSDP re-discovery redirect. Client calls `_handleCastResponse()` to update `S.sonosRoom.ip`, localStorage, and restart position-sync on the new IP |
| **Server-side alias** | Any `/set-volume`, `/set-pause`, `/seek` call | `_resolveIp()` checks `_ipAliases` (set on redirect) and the discovered-rooms cache; uses the resolved IP even if the client sent a stale one |

This means a DHCP IP change is corrected **no later than the next track change** — and often before that if the output picker is opened.---

## Queue mirroring

While Sonos is the active output, Velvet mirrors a **window of the player queue** (the current track + up to ~30 upcoming) onto the Sonos queue, so the Sonos app shows what's playing and what's next. The web player remains the source of truth; the Sonos queue is re-synced on track changes and wiped (only if it's ours) when you switch away or close the tab.

**Bidirectional pause + cede control:**
- Pause/resume from the Sonos app or CLIC is reflected back to the web player (and the sleep LED follows).
- If you navigate on the Sonos app (next / previous / shuffle), the web player detects it's no longer on our current track and **cedes control** — it pauses and stops syncing until you press Play in the web again (which re-casts and takes control back).

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
Art is served via the main **HTTPS** endpoint (`https://host:port/album-art/...`) regardless of whether `localHttpPort` is configured. iOS apps enforce App Transport Security (ATS) which silently blocks plain `http://` image loads.

---

## API endpoints

All endpoints require a valid JWT (`x-access-token` header or `token` query param).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/sonos/devices` | User | Return cached room list + enabled flag; triggers discovery if cache is empty |
| `POST` | `/api/v1/sonos/scan` | User | Force re-discovery using the configured seed IP |
| `GET` | `/api/v1/sonos/probe?ip=X.X.X.X` | User | Probe a single IP — returns room name, UUID, reachability |
| `POST` | `/api/v1/sonos/save-default` | User | Save a room as the default cast target |
| `POST` | `/api/v1/sonos/cast` | User + `allow-mpv-cast` | Cast a track to a Sonos device |
| `POST` | `/api/v1/sonos/set-pause` | User + `allow-mpv-cast` | Pause or resume Sonos playback |
| `POST` | `/api/v1/sonos/seek` | User + `allow-mpv-cast` | Seek to a position (seconds) |
| `POST` | `/api/v1/sonos/set-volume` | User + `allow-mpv-cast` | Set volume (0–100; server caps at 50) |
| `GET` | `/api/v1/sonos/transport-status?ip=X` | User + `allow-mpv-cast` | Poll playback state (playing/paused/stopped, position, duration, current **track** number) |
| `POST` | `/api/v1/sonos/cast-queue` | User + `allow-mpv-cast` | Mirror a window of the player queue (current + upcoming) onto the Sonos queue; plays current immediately, appends the rest in the background |
| `POST` | `/api/v1/sonos/queue/clear` | User + `allow-mpv-cast` | Wipe the Sonos queue — only if every track belongs to Velvet (foreign queues untouched) |
| `POST` | `/api/v1/sonos/test-play` | Admin | Play a random song on a device (admin test) |
| `GET` | `/api/v1/sonos/sleep?ip=X` | User | Read the native sleep timer — `{ active, remaining, generation }` |
| `POST` | `/api/v1/sonos/sleep` | User | Set/clear the native sleep timer via `ConfigureSleepTimer`. `{ ip, seconds?, minutes?, play? }` — ≤ 0 clears it; `play: true` resumes on wake |
| `GET` | `/api/v1/sonos/led?ip=X` | User | Read the status-LED state (`GetLEDState`) — `{ state: 'On'｜'Off' }` |
| `POST` | `/api/v1/sonos/led` | User | Set the status-LED state (`SetLEDState`). `{ ip, state: 'On'｜'Off' }` — sleep-mode visual cue |
| `GET` | `/api/v1/sonos/transcode-stream?fp=&token=` | User | Stream a file as MP3 (192 k @ 48 kHz) via the built-in ffmpeg. Used automatically when Auto-transcode is enabled. |
| `POST` | `/api/v1/admin/sonos` | Admin | Save Sonos config (`enabled`, `transcodeOpus`, `sleepEnabled`) |

---

## Config file

`save/conf/default.json` — Sonos settings are stored under `sonos`:

```json
{
  "sonos": {
    "enabled": true,
    "transcodeOpus": true,
    "sleepEnabled": false,
    "defaultRoom": {
      "ip": "192.168.1.100",
      "name": "Living Room",
      "uuid": "RINCON_XXXXXXXXXXXX00"
    }
  }
}
```

`enabled` defaults to `true` if the key is absent.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| No Sonos rooms in output picker | Sonos disabled in admin, or user lacks `allow-mpv-cast` |
| Probe times out | Device IP wrong, or Sonos on a different VLAN/subnet |
| Cast succeeds but no audio | Velvet server IP not reachable from Sonos (check firewall); audio port (3000 by default) must be open |
| Volume/pause after cast does nothing (EHOSTUNREACH in log) | Sonos IP changed (DHCP lease renewed). Velvet auto-corrects this: the next `/cast` triggers SSDP re-discovery, resolves the new IP, and stores it. If the session was restored from a previous browser session, the IP is snapped on boot. No manual action needed. |
| Opus or hi-res FLAC file is silent on Sonos | Enable **Auto-transcode for Sonos** in Admin → Sonos. Opus is not supported by Sonos hardware. Most Sonos devices also cap FLAC/PCM at 48 kHz — 88/96/176/192 kHz files will be silent without transcoding. |
| WAV file is silent on Sonos | Enable **Auto-transcode for Sonos** in Admin → Sonos. Sonos DIDL metadata hardcodes `audio/mpeg`; WAV streams mismatch and are rejected. |
| Next random/Auto-DJ track starts late or first cast times out right after a hi-res/transcoded track | Velvet now applies an adaptive pre-cast settle delay for rapid back-to-back transcode-sensitive transitions and uses a longer Sonos SOAP timeout (9 s). If you still see this, keep `journalctl -fu music.service` open and look for `[sonos] rapid cast after ... waiting ... before SOAP` and timeout/retry lines. |
| Volume slider has no effect | Volume cap (`SONOS_MAX_VOL = 50`) is working as intended |
| Cast session lost after page reload | Clear localStorage key `ms2_sonos_room` and re-select room |

