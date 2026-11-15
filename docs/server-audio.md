# Server Audio

**Server Audio** lets Velvet play music directly through the server's speakers. Your browser becomes a remote control — no app installation required on any device.

Through the remote (`/server-remote`) you can play audio directly to the speakers connected to your PC, NUC, or any other machine Velvet is running on.

> **Real-world setup note:** Velvet is actively running Server Audio under **Proxmox LXC** with a passthrough sound card from an Intel NUC. The setup has been validated end-to-end: the configuration survives an LXC reboot *and* a full Proxmox node reboot — including all Server Audio settings.

---

## Proxmox LXC — sound card passthrough

If you run Velvet inside a Proxmox LXC container and want to pass through the host sound card, add these two lines to your **LXC configuration file** (`/etc/pve/lxc/<VMID>.conf`):

```
lxc.cgroup2.devices.allow: c 116:* rwm
lxc.mount.entry: /dev/snd dev/snd none bind,optional,create=dir
```

After adding these lines and restarting the container, **mpv** and **ALSA** can detect and use the sound card normally.

Inside the container, install the required packages:

```bash
sudo apt install mpv alsa-utils
```

The `alsa-utils` package provides `amixer`, `aplay`, and `alsamixer` — all used by Velvet's built-in sound diagnostics and auto-unmute feature.

> **Docker:** Velvet does not offer mpv or ALSA support in Docker images. Docker audio passthrough is highly environment-specific and not something we can test or support. You will need to figure out your own Docker audio setup — it is entirely outside the scope of the admin tools described here.

---

## How it works

1. Velvet spawns **mpv** in idle mode on server startup when Server Audio is enabled (or on demand via the Admin panel). If mpv is not running when a song is queued and Server Audio is enabled, it is started then.
2. mpv listens for commands on a local Unix socket using the JSON IPC protocol.
3. Any browser that can reach the server opens `/server-remote` to control playback. The web player can also send its playback to the server speaker ("cast").
4. The remote page polls the server every 2 seconds for playback state.
5. While a client casts, it sends a heartbeat every 8 seconds. If no heartbeat arrives for 5 minutes and mpv is not playing, mpv is stopped.

Server Speaker playback is also included in the user's play history. An event
starts when mpv confirms that a file has loaded, then closes with the observed
played position when the track ends, is interrupted, or the queue is cleared.
This keeps server-output history aligned with browser playback without relying
on the remote page staying open.

```
Browser ──(HTTPS)──▶ Velvet API ──(Unix socket)──▶ mpv ──▶ server speakers
```

### What the Admin panel does for you

The **Admin → Server Audio** panel handles the full setup flow without touching the command line:

- **Enable/Disable toggle** — turns the feature on/off (after a confirmation) and controls whether mpv auto-starts when Velvet boots. Enabling starts mpv right away; disabling stops it. Default is **off**.
- **Auto-prepare ALSA output toggle** — before starting mpv, Velvet runs a best-effort `amixer` command to unmute common ALSA channels (Master, Speaker, PCM, Headphone) and set a safe volume. Recommended to leave **on**.
- **Detect mpv** — checks that the configured mpv binary exists and reports its version.
- **Run sound check** — Linux-only: inspects ALSA tools (`amixer`/`aplay`), checks for muted mixer controls, and lists detected sound cards.
- **Apply backend audio fix** — runs `amixer` to unmute and set 90% volume on common ALSA channels.
- **Run guided test** — orchestrates the full flow (detect → sound check → fix if needed → start) and prints a per-step OK / WARN / FAIL report.
- **Play test tone** — generates a 3-second stereo tone (440 Hz left, 880 Hz right) with the bundled ffmpeg and plays it through the running mpv, so you can immediately hear whether audio output is working. It replaces whatever mpv was playing.
- **Start / Stop** — start or stop the mpv process independently of the Enabled toggle.
- **Open Server Remote** — opens `/server-remote` in a new tab.

After each button click you see an in-progress label (`Detecting...`, `Checking...`, etc.) while the request runs, and a **Last action** status line when it completes.

---

## Requirements

**mpv** must be installed on the server machine. Velvet does **not** bundle mpv (unlike ffmpeg).

For Linux speaker output checks and automatic unmute support, install **alsa-utils** as well (`amixer`, `aplay`, `alsamixer`).

### Install mpv

**Linux (Debian / Ubuntu)**
```bash
sudo apt install mpv alsa-utils
```

**Linux (Fedora / RHEL)**
```bash
sudo dnf install mpv alsa-utils
```

**Linux (Arch)**
```bash
sudo pacman -S mpv alsa-utils
```

**macOS (Homebrew)**
```bash
brew install mpv
```

> **macOS / Windows note:** ALSA diagnostics and auto-unmute are Linux-only. On other platforms the sound check and audio fix buttons are skipped gracefully.

**Verify the install:**
```bash
mpv --version
# Expected: mpv 0.35+ (any modern version works)
amixer --version
```

---

## Enable in the Admin Panel

1. Go to **Admin → Server Audio** in the left sidebar.
2. Flip the **Enable** toggle to the **On** position and confirm — Velvet starts mpv now and on every server boot.
3. If mpv is not on your system PATH, click **edit** next to *mpv Binary Path* and enter the absolute path (e.g. `/usr/bin/mpv`).
4. Click **Detect mpv** to verify the binary is reachable and see its version.
5. Click **Run sound check** to inspect ALSA tools, mute state, and detected sound cards.
6. If channels are muted, click **Apply backend audio fix** to unmute key mixer controls and set a safe volume.
7. Click **Play test tone** — you should hear a 3-second stereo tone (440 Hz left, 880 Hz right) from the server speakers.
8. If anything is unclear, use **Run guided test** for a full end-to-end flow with per-step results.

### What each control does

| Control | Purpose |
|---------|---------|
| **Enable toggle** | Turns Server Audio on/off and controls autostart on service boot. Default is **off**. |
| **Auto-prepare ALSA output toggle** | Before starting mpv, runs `amixer` to unmute common ALSA channels. Leave **on** for Linux. |
| **mpv Binary Path** | Path to the mpv binary. Default is `mpv` (assumes it is on PATH). |
| **Detect mpv** | Checks whether the configured mpv binary can be executed and reports its version. |
| **Start / Stop** | Starts or stops mpv now, without changing the Enabled toggle. |
| **Run sound check** | Linux-only: ALSA tools, muted mixer controls, detected sound cards. |
| **Apply backend audio fix** | Linux-only: best-effort `amixer` unmute + 90% volume on common controls. |
| **Run guided test** | Full test workflow: detect → check → fix if needed → start, with per-step OK/WARN/FAIL. |
| **Play test tone** | Plays 440 Hz left / 880 Hz right for 3 seconds through the server speaker via mpv. |
| **Open Server Remote** | Opens `/server-remote` in a new browser tab. |

### Security note

The configured **mpv Binary Path** is treated as a direct executable path, not a shell command. Before launching mpv, the server accepts only a bare command name (letters, digits, `.`, `_`, `-`) or an absolute path to an executable file, and falls back to `mpv` otherwise.

---

## The Server Remote page

Open `/server-remote` in any browser (phone, tablet, desktop). The page is translated into the same 12 languages as the player (`server-remote.*` keys, see [i18n.md](i18n.md)). While Server Audio is disabled, the page only shows a short "not enabled" notice with a link to the Admin panel.

### Login and access

- If your Velvet instance has users configured, enter your credentials.
- If no users are configured (open/single-user install), the page authenticates automatically.
- Admins can always use the remote. Other users can use it while Server Audio is enabled, unless an admin has turned off their Server Remote access (`allow-server-remote: false`). Users without access see an "Access Denied" page.
- Sending sound to the **Server** or **Sonos** output also needs the cast permission: admins may always cast, other users need `allow-mpv-cast`. Without it the remote falls back to the **Browser** output. `/api/v1/ping` reports this as `allowMpvCast` (true for admins and for users with the permission, while Server Audio is on).
### Output

The output row picks where the remote plays: **Browser** (this device), **Server** (mpv on the server speaker) or **Sonos** (pick a room). The choice is remembered in this browser. Closing or leaving the page pauses playback on the chosen output.

### Now Playing bar

Shows the current track's art, title, artist, and a progress bar you can tap/click to seek.

### Controls

| Control | Action |
|---------|--------|
| ◀◀ / ▶▶ | Previous / Next track |
| ▶ / ❚❚ | Play / Pause |
| Repeat | Cycles: **Off → One → All → Off** |
| DJ | Turns Auto-DJ on/off |
| Clear | Clears the queue |
| Volume slider | 0–130 (mpv supports up to 130% software boost) |

### Tabs

The remote has five tabs: **Queue**, **Search**, **Auto-DJ**, **Audio** and **Browse**.

#### Queue

Lists all songs in the current playback queue. Tap a song to jump to it; tap × to remove it. The currently playing song is highlighted.

#### Search

Searches the library (from 2 characters) and shows up to 25 songs; **+** adds one to the queue.

#### Auto-DJ

Automatically queues new songs so the music never stops. The remote asks the server for the next song (`POST /api/v1/autodj/next`, the same Auto-DJ engine as Velvet Rooms), sending the last 200 queued songs so they are not repeated.

| Setting | Description |
|---------|-------------|
| **Random** | No seed song: the server picks a random song from your library |
| **Similar Artists** | The last queued song is sent as the seed, so the server picks a related song. Whether Last.fm similar artists are used follows your own Auto-DJ settings in the player |

Auto-DJ fires when there are fewer than 2 songs ahead of the current position, or when the current track is within 25 seconds of ending.

#### Audio

Shows whether loudness normalisation (ReplayGain) is active for the current track and the gain applied.

#### Browse

File browser for your vpaths. Navigate into folders and tap **+ Queue** to add a song to the queue.

---

## Configuration reference

These keys are stored in `save/conf/default.json` under `serverAudio`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Whether mpv is started on server boot |
| `mpvBin` | string | `"mpv"` | Path to the mpv binary |
| `autoUnmute` | boolean | `true` | Linux-only: run best-effort ALSA unmute/volume prep before starting mpv |

Example `default.json` fragment:
```json
{
  "serverAudio": {
    "enabled": true,
    "mpvBin": "/usr/bin/mpv",
    "autoUnmute": true
  }
}
```

---

## API reference

All endpoints require a valid JWT token (`x-access-token` header) except `/server-remote`.

`/api/v1/server-playback/available` is open to any logged-in user. `detect`, `audio-health`, `audio-health/fix` and `test-tone` are admin-only. Every other `/api/v1/server-playback/*` route needs admin, the `allow-mpv-cast` permission or Server Remote access; otherwise 403. Transport and queue routes answer `{}` unless noted.

### Playback state

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/v1/server-playback/available` | `{ enabled, running, allowed }` — whether the player may offer the Server Speaker output |
| `GET`  | `/api/v1/server-playback/status` | Full playback state + queue |
| `GET`  | `/api/v1/server-playback/detect` | Detect mpv installation — `{ found, version, path }` |
| `GET`  | `/api/v1/server-playback/audio-health` | Linux speaker diagnostics (ALSA tools, mute state, cards) |
| `POST` | `/api/v1/server-playback/audio-health/fix` | Best-effort ALSA unmute + volume fix (400 on non-Linux) |
| `POST` | `/api/v1/server-playback/test-tone` | Play a 3-second stereo test tone through mpv — `{ ok: true }`, or 409 when mpv is not running |

### Transport

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/server-playback/pause` | — | Toggle play/pause |
| `POST` | `/api/v1/server-playback/set-pause` | `{ paused }` | Pause (`true`) or resume |
| `POST` | `/api/v1/server-playback/next` | — | Next track |
| `POST` | `/api/v1/server-playback/previous` | — | Previous track |
| `POST` | `/api/v1/server-playback/seek` | `{ position }` | Seek to absolute position (seconds) |
| `POST` | `/api/v1/server-playback/volume` | `{ volume }` | Set volume 0–130 (400 when not a number) |
| `POST` | `/api/v1/server-playback/loop` | — | Cycle loop mode (none→one→all→none); returns `{ loop_mode }` |
| `POST` | `/api/v1/server-playback/reapply-gain` | `{ gainDb?, volumePct?, balance? }` | Re-apply ReplayGain, volume and balance (-1…1) while casting. 400 when a value is not a number; `gainDb` is clamped to −30…+20 dB |
| `POST` | `/api/v1/server-playback/heartbeat` | — | Keep-alive sent by a casting client |

### Queue

Song entries take `{ filepath, title?, artist?, album?, albumArt?, seekTo?, rgEnabled?, rgMode?, rgPreamp?, rgClip? }`. A file the user cannot read answers 404 `{ error: 'File not available' }`.

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/server-playback/queue/add` | song entry | Append song to queue; returns `{ index }` |
| `POST` | `/api/v1/server-playback/queue/add-many` | `{ files: [song entry, …] }` | Append several songs, all or nothing (one unreadable file and nothing is queued); returns `{ indices }` |
| `POST` | `/api/v1/server-playback/play` | `{ file: song entry }` | Clear the queue, add one song and play it |
| `POST` | `/api/v1/server-playback/queue/clear` | — | Clear queue and stop |
| `POST` | `/api/v1/server-playback/queue/remove` | `{ index }` | Remove song at index |
| `POST` | `/api/v1/server-playback/queue/play-index` | `{ index }` | Jump to index |

### Admin

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET`  | `/api/v1/admin/server-audio` | — | `{ enabled, mpvBin, autoUnmute, running }` |
| `POST` | `/api/v1/admin/server-audio` | `{ enabled?, mpvBin?, autoUnmute? }` (at least one) | Update config; `enabled: true` starts mpv, `false` stops it |
| `POST` | `/api/v1/admin/server-audio/start` | — | Start mpv now — `{ running }` |
| `POST` | `/api/v1/admin/server-audio/stop` | — | Stop mpv now and clear the queue — `{ running: false }` |

### Status response shape

```json
{
  "running":      true,
  "playing":      true,
  "currentTime":  42.1,
  "duration":     213.4,
  "currentIndex": 0,
  "queueLength":  5,
  "volume":       100,
  "loopMode":     "none",
  "shuffle":      false,
  "currentGainDb": -6.2,
  "queue": [
    {
      "relPath":  "Music/Albums/Artist/Album/01 Track.flac",
      "title":    "Track Title",
      "artist":   "Artist Name",
      "album":    "Album Name",
      "albumArt": "abc123.jpg",
      "bitrate":  1411,
      "sample-rate": 44100,
      "channels": 2,
      "gainDb":   -6.2
    }
  ]
}
```

`loopMode` values: `"none"` / `"one"` / `"all"`. `shuffle` is always `false`. `currentGainDb` is `null` when no ReplayGain is applied; it is missing while mpv is not running. Queue entries also carry internal history fields.

---

## Troubleshooting

**mpv not found**
> Click *Detect mpv* in the admin panel. If the status line reports that detection failed, either install mpv or set the full path in *mpv Binary Path*.

**No audio output**
> First run **Run sound check** in Admin → Server Audio.
>
> If it reports missing ALSA tools, install `alsa-utils`.
>
> If it reports muted controls, click **Apply backend audio fix**. If needed, verify manually with `alsamixer` (toggle mute with `M`) and confirm the right output device is selected.

**Status shows "Enabled, mpv not started"**
> Restart the Velvet service (`systemctl restart music.service`) or click *Start* in the admin panel.

**Queue is empty after restart**
> The server-side queue is in-memory only — it resets on server restart (and when mpv is stopped). If Auto-DJ is on in an open remote page, it refills the queue.
