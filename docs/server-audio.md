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

1. Velvet spawns **mpv** in idle mode on server startup (or on demand via the Admin panel).
2. mpv listens for commands on a local Unix socket using the JSON IPC protocol.
3. Any browser that can reach the server opens `/server-remote` to control playback.
4. The remote page polls the server every 2 seconds for playback state.

```
Browser ──(HTTPS)──▶ Velvet API ──(Unix socket)──▶ mpv ──▶ server speakers
```

### What the Admin panel does for you

The **Admin → Server Audio** panel handles the full setup flow without touching the command line:

- **Enable/Disable toggle** — turns the feature on/off and controls whether mpv auto-starts when Velvet boots. Default is **off**.
- **Auto-Unmute toggle** — before starting mpv, Velvet runs a best-effort `amixer` command to unmute common ALSA channels (Master, Speaker, PCM, Headphone) and set a safe volume. Recommended to leave **on**.
- **Detect mpv** — checks that the configured mpv binary exists and reports its version.
- **Run sound check** — Linux-only: inspects ALSA tools (`amixer`/`aplay`), checks for muted mixer controls, and lists detected sound cards.
- **Apply backend audio fix** — admin-only: runs `amixer` to unmute and set 90% volume on common ALSA channels.
- **Run guided test** — orchestrates the full flow (detect → sound check → fix if needed → start) and prints a per-step OK / WARN / FAIL report.
- **Play test tone** — tells the running mpv to play a 3-second stereo tone (440 Hz left, 880 Hz right) through the server speaker so you can immediately hear whether audio output is working.
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
2. Flip the **Enable** toggle to the **On** position — Velvet will auto-start mpv on the next server boot (and starts it now if you also click **Start**).
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
| **Auto-Unmute toggle** | Before starting mpv, runs `amixer` to unmute common ALSA channels. Leave **on** for Linux. |
| **mpv Binary Path** | Path to the mpv binary. Default is `mpv` (assumes it is on PATH). |
| **Detect mpv** | Checks whether the configured mpv binary can be executed and reports its version. |
| **Start / Stop** | Starts or stops mpv now, without changing the Enabled toggle. |
| **Run sound check** | Linux-only: ALSA tools, muted mixer controls, detected sound cards. |
| **Apply backend audio fix** | Admin-only Linux: best-effort `amixer` unmute + 90% volume on common controls. |
| **Run guided test** | Full test workflow: detect → check → fix if needed → start, with per-step OK/WARN/FAIL. |
| **Play test tone** | Plays 440 Hz left / 880 Hz right for 3 seconds through the server speaker via mpv. |
| **Open Server Remote** | Opens `/server-remote` in a new browser tab. |

### Security note

The configured **mpv Binary Path** is treated as a direct executable path, not a shell command. The server validates the path before launching mpv and falls back to `mpv` if the configured value is missing, malformed, or not executable.

---

## The Server Remote page

Open `/server-remote` in any browser (phone, tablet, desktop). 

### Login

- If your Velvet instance has users configured, enter your credentials.
- If no users are configured (open/single-user install), the page authenticates automatically.

### Now Playing bar

Shows the current track's art, title, artist, and a progress bar you can tap/click to seek.

### Controls

| Control | Action |
|---------|--------|
| ◀◀ / ▶▶ | Previous / Next track |
| ▶ / ❚❚ | Play / Pause |
| Repeat | Cycles: **Off → One → All → Off** |
| Volume slider | 0–130 (mpv supports up to 130% software boost) |

### Tabs

#### Queue

Lists all songs in the current playback queue. Tap a song to jump to it; tap × to remove it. The currently playing song is highlighted.

#### Auto-DJ

Automatically queues new songs so the music never stops.

| Setting | Description |
|---------|-------------|
| **Enabled toggle** | Turns Auto-DJ on/off |
| **Random** | Picks a random song from your library, avoiding recently played tracks |
| **Similar Artists** | Uses the Last.fm similar-artists API to find musically related songs (requires Last.fm API key configured in Admin → Last.fm) |

Auto-DJ fires when there are fewer than 2 songs ahead of the current position, or when the current track is within 25 seconds of ending.

#### Browse

File browser for your vpaths. Navigate into folders and tap **+ Queue** to add a song to the server playback queue.

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

### Playback state

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/v1/server-playback/status` | Full playback state + queue |
| `GET`  | `/api/v1/server-playback/detect` | Detect mpv installation |
| `GET`  | `/api/v1/server-playback/audio-health` | Linux speaker diagnostics (ALSA tools, mute state, cards) |
| `POST` | `/api/v1/server-playback/audio-health/fix` | Admin-only best-effort ALSA unmute + volume fix |
| `POST` | `/api/v1/server-playback/test-tone` | Play a 3-second stereo test tone through mpv |

### Transport

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/server-playback/pause` | — | Toggle play/pause |
| `POST` | `/api/v1/server-playback/next` | — | Next track |
| `POST` | `/api/v1/server-playback/previous` | — | Previous track |
| `POST` | `/api/v1/server-playback/seek` | `{ position }` | Seek to absolute position (seconds) |
| `POST` | `/api/v1/server-playback/volume` | `{ volume }` | Set volume 0–130 |
| `POST` | `/api/v1/server-playback/loop` | — | Cycle loop mode (none→one→all→none) |

### Queue

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/server-playback/queue/add` | `{ filepath, title?, artist?, album?, albumArt? }` | Append song to queue |
| `POST` | `/api/v1/server-playback/queue/clear` | — | Clear queue and stop |
| `POST` | `/api/v1/server-playback/queue/remove` | `{ index }` | Remove song at index |
| `POST` | `/api/v1/server-playback/queue/play-index` | `{ index }` | Jump to index |

### Admin

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET`  | `/api/v1/admin/server-audio` | — | Get config + running state |
| `POST` | `/api/v1/admin/server-audio` | `{ enabled?, mpvBin?, autoUnmute? }` | Update config |
| `POST` | `/api/v1/admin/server-audio/start` | — | Start mpv now |
| `POST` | `/api/v1/admin/server-audio/stop` | — | Stop mpv now |

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
  "queue": [
    {
      "relPath":  "Music/Albums/Artist/Album/01 Track.flac",
      "title":    "Track Title",
      "artist":   "Artist Name",
      "album":    "Album Name",
      "albumArt": "abc123.jpg"
    }
  ]
}
```

`loopMode` values: `"none"` / `"one"` / `"all"`

---

## Troubleshooting

**mpv not found**
> Click *Detect mpv* in the admin panel. If it shows ✗, either install mpv or set the full path in *mpv Binary Path*.

**No audio output**
> First run **Run sound check** in Admin → Server Audio.
>
> If it reports missing ALSA tools, install `alsa-utils`.
>
> If it reports muted controls, click **Apply backend audio fix**. If needed, verify manually with `alsamixer` (toggle mute with `M`) and confirm the right output device is selected.

**Status shows "Enabled, mpv not started"**
> Restart the Velvet service (`systemctl restart music.service`) or click *Start* in the admin panel.

**Queue is empty after restart**
> The server-side queue is in-memory only — it resets on server restart. Auto-DJ will repopulate it automatically if enabled.
