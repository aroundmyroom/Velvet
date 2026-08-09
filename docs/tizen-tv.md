# Velvet TV — Samsung Tizen App

**Velvet TV** is a native-feeling, 10-foot “big screen” client for your Velvet
music server, built for **Samsung Smart TVs** running **Tizen 5.5+** (2020
models and newer). It is a self-contained `.wgt` widget that you side-load onto
the TV — no Samsung Store submission required — and drive entirely with the
standard TV remote.

- Full D-pad navigation, no mouse or keyboard needed
- Albums (incl. **CUE-sheet** albums and multi-disc sets), Artists, Playlists and
  Auto-DJ, streamed straight from your own Velvet server
- Gapless-friendly playback, waveform seek bar, VU meter and a built-in
  MilkDrop-style visualizer
- Ships **without any server URL or credentials baked in** — every user signs in
  to their own server on the TV

---

## 1. Download

Grab the ready-to-install widget from the project’s **GitHub Releases** page:

- **`velvet-tv-<version>.wgt`** — the public build. It contains no server
  address and no login details; you enter those on the TV the first time you
  open the app.

You do **not** need Node.js, Tizen Studio or a developer certificate just to
install it — see the Apps2Samsung method below.

> The `.wgt` is a plain widget package (a renamed ZIP). It only talks to the
> Velvet server address that *you* type in on the TV.

---

## 2. Install with Apps2Samsung (recommended, no PC toolchain)

The easiest way to side-load the widget is with **Apps2Samsung**, a community
tool that lets you push a “custom WGT file” to a Samsung TV over the network.

- Project: <https://github.com/Apps2Samsung/Apps2Samsung>

### Steps

1. **Enable Developer Mode on the TV**
   - Open **Apps**, then type `12345` on the remote to bring up the Developer
     Mode dialog.
   - Turn **Developer mode** *On*, enter the **IP address of the PC** running
     Apps2Samsung, and restart the TV when prompted.
2. **Find the TV’s IP address**
   - **Settings → General → Network → Network Status → IP Settings** (write it
     down; you’ll need it below).
3. **Run Apps2Samsung** on your PC (follow the instructions in its repository).
4. **Point it at your TV** using the TV’s IP address.
5. **Choose “Custom WGT file”** and select the downloaded
   `velvet-tv-<version>.wgt`.
6. **Install / Upload.** Apps2Samsung transfers the widget and installs it.
7. **Velvet TV** now appears on the TV’s Apps row. Launch it and sign in.

> **Tip:** the TV and the PC running Apps2Samsung must be on the **same local
> network**. If installation fails, re-check Developer Mode and that the IP you
> entered on the TV matches the PC actually running the tool.

### Alternative: Tizen Studio CLI

If you already have Tizen Studio installed you can install the same package with:

```bash
tizen install -n velvet-tv-<version>.wgt -t <your-tv-target>
```

This requires a connected TV target and a developer certificate profile; the
Apps2Samsung route above avoids both.

---

## 3. First run — connecting to your server

On first launch you’ll see the **sign-in screen**:

1. **Server URL** — the full address of your Velvet server, e.g.
   `https://music.example.com:3000`. Use `https://` if your server has TLS.
2. **Username** and **Password** — your normal Velvet login.
3. Select **Sign In**.

Navigate the fields with **Up/Down**, press **OK/Enter** to move to the next
field, and select **Sign In** when done. Your session token is kept for the
app session so you don’t have to sign in every time you open a view.

> **Self-signed certificates:** the widget declares `access origin="*"`, so it
> can reach any server you enter. If your Velvet server uses a self-signed
> certificate the TV may refuse the connection — use a certificate trusted by
> the TV (e.g. Let’s Encrypt) for a smooth experience.

---

## 4. Using the app with the remote

### Navigation

| Button | Action |
| --- | --- |
| **D-pad ← ↑ → ↓** | Move focus between the side menu, content grid, A–Z strip and player bar |
| **OK / Enter** | Open the focused item / activate a button |
| **Back / Return** | Go up one level (detail → list, or close an overlay) |

The left **side menu** gives you: **Home**, **Albums**, **Artists**,
**Playlists** and **Auto-DJ**.

### Media keys

The TV’s dedicated media keys are wired directly to playback:

| Remote key | Action |
| --- | --- |
| **Play / Pause** | Toggle playback |
| **Fast-Forward / ⏭** | Next track |
| **Rewind / ⏮** | Previous track |
| **Stop** | Pause |

### Albums

- **A–Z quick-jump strip** — a vertical alphabet on the right edge of the Albums
  view. Press **Right** from the grid to focus it, move **Up/Down** to a letter
  and press **OK** to jump straight to the first album starting with that letter.
  Only letters that actually have albums are shown (digits/symbols group under
  `#`).
- **CUE-sheet albums** — single-file (FLAC+CUE) albums are automatically split
  into their individual tracks. Selecting a track seeks to its start and the
  player stops cleanly at the track boundary, auto-advancing to the next one.
- **Multi-disc sets** — tracks are grouped under **disc headers** (“CD 1”,
  “Disc 2”, …).
- Each album shows **year • track count • total duration**, and the currently
  playing track is highlighted in the list.
- **Play All** queues the whole album; selecting any track starts from there.

### Now Playing & visualizer

- Focus the **player bar** (bottom) and press **OK** on the track info to open
  the **Now Playing** overlay with a large VU meter and a **waveform seek bar**.
  Use **Left/Right** to scrub within the current track.
- From the overlay, activate the **◉ visualizer** button to launch the built-in
  MilkDrop-style visualizer. Press any button to exit. The screen is kept awake
  while music plays.

---

## 5. Building the widget yourself

You only need this if you want to customise the app or bake in a server address
for your own household.

### Public (shareable) build — no credentials

```bash
npm run build:tizen:dist
# → dist/velvet-tv-<version>.wgt   (empty server URL / login — safe to share)
```

This is the exact build attached to GitHub Releases. It never reads
`velvet-tv.config.json`, so nothing private can leak into it.

### Local build — pre-filled for your own TV

Create `webapp/tizen/velvet-tv.config.json` (this file is **git-ignored** and
must never be committed or shared):

```json
{
  "serverUrl": "https://music.example.com:3000",
  "username": "yourname",
  "password": "yourpassword",
  "autoLogin": false
}
```

Then:

```bash
npm run build:tizen
# → dist/velvet-tv.wgt   (server URL + login baked in; auto-login optional)
```

The build prints a clear warning when credentials are baked in — **do not
distribute that build**.

| Command | Output | Credentials | Use for |
| --- | --- | --- | --- |
| `npm run build:tizen` | `dist/velvet-tv.wgt` | Baked in from `velvet-tv.config.json` if present | Your own TV / quick testing |
| `npm run build:tizen:dist` | `dist/velvet-tv-<version>.wgt` | **None** — empty fields | Public GitHub release |

### Validating a code change

```bash
node -c webapp/tizen/app.js   # syntax check
npm run build:tizen:dist      # rebuild the clean package
```

---

## 6. Platform notes & compatibility

The app targets **Tizen 5.5 / Chromium 69**, so the code deliberately avoids
newer web features that Samsung TVs don’t support:

- No `Web Audio API` (the `AnalyserNode` silences audio on Samsung TVs) — the
  VU meter and visualizer are driven by the server’s pre-computed waveform
  envelope, rendered with Canvas 2D + `requestAnimationFrame`.
- No CSS `inset`, flex `gap`, or `aspect-ratio`; no JS optional chaining (`?.`)
  or nullish coalescing (`??`).
- `HTMLMediaElement.play()` may return `undefined`, so its result is never
  assumed to be a Promise.

Privileges requested in `config.xml`:

- `internet` — reach the Velvet server
- `power` — keep the screen awake during playback / visualizer
- `mediakey` — respond to the remote’s Play/Pause/FF/Rewind keys

---

## 7. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Install fails in Apps2Samsung | Re-check **Developer Mode** is On and the PC IP entered on the TV matches the machine running the tool; both must be on the same LAN. |
| “Can’t reach server” after sign-in | Verify the **Server URL** (scheme + port) and that the TV can reach it on the network. Self-signed TLS certificates are often rejected by the TV. |
| A–Z strip not reachable | Press **Right** from the album grid; the strip is on the far right edge. |
| No sound but the visualizer moves | Expected on some panels only if a real analyser were used — Velvet TV avoids Web Audio precisely to prevent this. If you still get silence, check the TV’s audio output settings. |
| Widget won’t appear after install | Restart the TV; the Apps row refreshes on reboot. |

---

## See also

- [`youtube-download.md`](youtube-download.md), [`albums.md`](albums.md),
  [`smart-playlists.md`](smart-playlists.md) — server-side features surfaced in
  the TV app.
- **Apps2Samsung** side-loader: <https://github.com/Apps2Samsung/Apps2Samsung>
