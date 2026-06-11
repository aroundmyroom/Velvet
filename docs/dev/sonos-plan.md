# Sonos Integration — Implementation Plan

> **Phase 1 DONE** (`14b41c25`): Admin panel, SSDP discovery, device probe, test playback via raw SOAP
> **This plan covers Phase 2+**: connecting Sonos to the main player

---

## Current state (what exists)

| What | Status |
|------|--------|
| `src/api/sonos.js` — probe, scan, devices, test-play | ✅ Done |
| `src/server.js` — secondary HTTP on `localHttpPort` (3001) | ✅ Done |
| Admin panel — probe card, discover card, test card | ✅ Done |
| `save/conf/default.json` — `"localHttpPort": 3001` | ✅ Done |
| Player cast button (`#mpv-cast-btn`) — binary MPV toggle | ✅ Existing (v6.11.0) |
| Sonos rooms wired into player output selector | ✅ Done |
| Admin: Sonos "default room" save | ❌ Not yet |
| `POST /api/v1/sonos/cast` — play a track from player | ✅ Done |

---

## The Output Button — unified UX (MPV + Sonos)

### The naming problem

The current button is called **"Cast to server speaker"** (`#mpv-cast-btn`, `player.ctrl.castToMpv`).
With Sonos added as a third option, it is no longer just MPV.

**Rename strategy:**

| Current | New |
|---------|-----|
| `#mpv-cast-btn` | `#output-btn` |
| `player.ctrl.castToMpv` | `player.output.castTo` |
| `player.ctrl.castToBrowser` | (removed — "Browser" becomes a selectable option) |
| `toggleMpvCast()` | `_openOutputPicker()` → populates a dropdown |
| `_updateCastBtn()` | `_updateOutputBtn()` |
| `S.castingToMpv` | keep as-is (internal MPV state) |

The button shows an icon + the **name of the current output** (or nothing if Browser).
A dropdown appears on click listing all available outputs:

```
┌──────────────────────────┐
│ ● Browser       (active) │
│ ○ Server Speaker         │  ← only shown if MPV enabled + user has permission
│ ─────────────────────    │
│ ○ Roam 2                 │  ← Sonos rooms (only if discovered)
│ ○ Living Room            │
└──────────────────────────┘
```

Selecting "Browser" while casting: stops cast → browser audio resumes.
Selecting "Server Speaker": existing `toggleMpvCast()` logic.
Selecting a Sonos room: calls new `/api/v1/sonos/cast`, stops MPV if active.

The button is **hidden** when no alternative outputs are available (same as today).

---

## Step-by-step implementation plan

### Step 1 — Admin: save Sonos default room

**Why first:** The player needs to know which Sonos device to use. Option A = admin picks one room as default; the player uses it automatically without a picker UI.

**What to build:**

1. **Config** (`src/state/config.js`): add `sonos.defaultRoom: Joi.object({ ip, name, uuid }).optional().allow(null).default(null)`
2. **Save endpoint** (`src/api/sonos.js`): `POST /api/v1/sonos/save-default` — body `{ ip, name, uuid }` — writes to `config.program.sonos.defaultRoom` + persists to `default.json`
3. **Admin UI** (`webapp/admin/index.js`): in the Discover Rooms card, add a **"Set as Default"** button per room. Once set, show the current default with a ★ indicator. Also show "Default room: Roam 2 (10.1.1.207)" in the Sonos section header.
4. **Player ping endpoint** (`src/api/sonos.js`): include `defaultRoom` in the existing `/api/v1/sonos/devices` response so the player can read it on boot.

**Files touched:** `src/api/sonos.js`, `src/state/config.js`, `webapp/admin/index.js`, locale files (1–2 keys).

---

### Step 2 — Backend: `/api/v1/sonos/cast` endpoint

The core "play this track on Sonos" endpoint, used by the player.

**Endpoint:** `POST /api/v1/sonos/cast`
```json
{
  "ip":      "10.1.1.207",
  "filepath": "Music/Albums/Ring My Bell.flac",
  "title":   "Ring My Bell",
  "artist":  "Anita Ward",
  "album":   "Songs of Love"
}
```

**Server-side logic (same pattern as test-play, already working):**

```
1. Validate ip is RFC-1918 (security: no SSRF to external hosts)
2. Build stream URL using URL selection logic (see "Revised audio URL approach" below)
   NOTE: filepath already contains vpath prefix — split on first '/'
3. Mint 8h JWT (longer than a listening session)
4. SOAP raw HTTP: SetAVTransportURI (DIDL-Lite metadata) + Play
5. Return { ok, nowPlaying: { title, artist, ip, streamUrl } }
```

**Audio URL:** Uses the configured server address directly (see "Revised audio URL approach").
No DLNA dependency needed — DLNA is off on this installation.

**SSRF protection:** Reject `ip` that doesn't match `/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/`.

---

### Step 3 — Player: output picker dropdown

Upgrade `#mpv-cast-btn` → `#output-btn` in `webapp/index.html` and `webapp/app.js`.

**State to add to `S` (player state object):**
```js
castingToSonos:    false,      // true when Sonos cast is active
sonosRoom:         null,       // { ip, name } of active Sonos room
sonosDefaultRoom:  null,       // { ip, name } from server config
sonosRooms:        [],         // all discovered rooms (for dropdown)
```

**Boot sequence (`showApp()`):**
```js
// fetch default room + room list from /api/v1/sonos/devices
const sonosData = await api('GET', 'api/v1/sonos/devices').catch(() => null);
if (sonosData) {
  S.sonosRooms        = sonosData.rooms || [];
  S.sonosDefaultRoom  = sonosData.defaultRoom || null;
}
_updateOutputBtn(); // re-render button
```

**`_openOutputPicker()`:**
- Builds a dropdown `<div>` anchored to `#output-btn`
- Browser row (always)
- Server Speaker row (if `S.serverAudioRunning && S.allowMpvCast`)
- Divider (if both MPV and Sonos rooms are present)
- One row per discovered Sonos room
- Click-outside listener closes dropdown

**`_selectOutput(type, opts)`:**
- `type = 'browser'`: calls existing `_deactivateCast(true)` (MPV stop) or new `_deactivateSonosCast()` 
- `type = 'mpv'`: calls existing `toggleMpvCast()` logic
- `type = 'sonos'`: calls `_activateSonosCast(opts.room)`

**`_activateSonosCast(room)`:**
```js
// 1. If MPV casting, stop it first
if (S.castingToMpv) _deactivateCast(false);
// 2. Mute browser audio (same as MPV cast)
VIZ.setCastMute(true);
// 3. Get current track
const s = S.queue[S.idx];
if (!s || s.isRadio) { toast(t('player.output.cantCastRadio')); return; }
// 4. Call /api/v1/sonos/cast
await api('POST', 'api/v1/sonos/cast', {
  ip: room.ip,
  filepath: s.filepath,
  title: s.title, artist: s.artist, album: s.album
});
// 5. Update state
S.castingToSonos = true;
S.sonosRoom = room;
localStorage.setItem(_uKey('casting_sonos'), JSON.stringify(room));
_updateOutputBtn();
toast(t('player.output.castSuccess', { room: room.name }));
```

**Track changes while Sonos casting:**  
Hook into the existing `_onTrackLoad()` / song-change flow. When `S.castingToSonos`:
```js
// same place _mpvLoadSong() is called for MPV
await api('POST', 'api/v1/sonos/cast', { ip: S.sonosRoom.ip, filepath: s.filepath, ... });
```

**`_updateOutputBtn()`:**
```js
const btn = document.getElementById('output-btn');
if (!hasAnyOutput()) { btn.classList.add('hidden'); return; }
btn.classList.remove('hidden');
if (S.castingToSonos) {
  btn.classList.add('output-active');
  btn.title = S.sonosRoom.name;
} else if (S.castingToMpv) {
  btn.classList.add('output-active');
  btn.title = t('player.output.serverSpeaker');
} else {
  btn.classList.remove('output-active');
  btn.title = t('player.output.castTo');
}
```

---

### Step 4 — i18n keys

Add to all 12 locale files:

| Key | EN | NL |
|-----|----|----|
| `player.output.castTo` | "Cast to…" | "Afspelen via…" |
| `player.output.browser` | "Browser" | "Browser" |
| `player.output.serverSpeaker` | "Server Speaker" | "Serverluidspreker" |
| `player.output.castSuccess` | "Now playing on {{room}}" | "Speelt nu op {{room}}" |
| `player.output.castStop` | "Stopped casting" | "Casten gestopt" |
| `player.output.cantCastRadio` | "Can't cast radio to Sonos" | "Radio casten naar Sonos niet mogelijk" |
| `player.output.noSonos` | "No Sonos rooms found" | "Geen Sonos-kamers gevonden" |

Old keys `player.ctrl.castToMpv` / `player.ctrl.castToBrowser` — **keep for backwards
compat** but they become internal implementation details rather than button labels.

---

### Step 5 — Admin: rename "Server Audio" → "Audio Output"

The sidebar entry "Server Audio" and the admin section heading become **"Audio Output"**
(or just leave it as "Server Audio" if you prefer — the Sonos panel is already a separate
sidebar entry). User decision needed.

**Option A (clean):** Merge Sonos admin card into the Server Audio section, rename to "Audio Output". One sidebar entry for all outputs.

**Option B (current):** Keep "Server Audio" and "Sonos" as separate sidebar entries. Simpler — no admin restructuring needed.

> **Recommendation: Option B for now.** Less disruption to the admin. Can merge later as polish.

---

## What we are NOT doing yet

| Feature | Reason |
|---------|--------|
| Cast full queue | Phase 2 — needs `AddMultipleURIsToQueue` SOAP + more player state |
| Sonos transport controls from Velvet (pause/skip on Sonos) | Phase 3 — needs SOAP polling + mini control bar |
| Auto-DJ for Sonos | After queue casting is solid |
| Multiple simultaneous Sonos outputs | Not needed for Option A |
| Sonos volume control from player | Phase 3 |

---

## Revised audio URL approach

**No DLNA dependency.** The old plan in `docs/sonos.md` assumed DLNA port 10293 — that's outdated.

### Key insight: domain = LAN IP → HTTPS works directly

On this installation `music.aroundtheworld.net` resolves to `10.1.1.101` — the same machine Velvet runs on:

```
$ ping music.aroundtheworld.net
PING music.aroundtheworld.net (10.1.1.101) time=0.049 ms
```

This means the Sonos device (also on the LAN) can reach `https://music.aroundtheworld.net:3000` **directly** — valid cert, no hairpin NAT, no proxy. Port 3001 is NOT required for this setup.

### URL selection logic (server-side, in `/api/v1/sonos/cast`)

```js
// Prefer localHttpPort if explicitly configured (admin override for edge cases).
// Otherwise use the main server's configured address + port + protocol.
const proto  = config.program.ssl?.cert ? 'https' : 'http';
const host   = config.program.address;   // e.g. "music.aroundtheworld.net"
const port   = config.program.port;      // e.g. 3000

const baseUrl = config.program.localHttpPort
  ? `http://${lanIp}:${config.program.localHttpPort}`
  : `${proto}://${host}:${port}`;
```

This covers all installation types:

| Setup | `localHttpPort` | Sonos stream URL |
|-------|----------------|------------------|
| HTTPS, domain = LAN IP (this install) | not set | `https://music.aroundtheworld.net:3000` ✅ |
| HTTPS, public domain (hairpin risk) | 3001 set | `http://10.1.1.101:3001` ✅ |
| Plain HTTP | not set | `http://10.1.1.101:3000` ✅ |
| Any, explicit override | 3001 set | `http://10.1.1.101:3001` ✅ |

**Rule:** `localHttpPort` is an optional safety override for routers that can't do hairpin NAT. When the configured hostname resolves to the server's own LAN IP (as here), leave it unset.

Token is minted server-side with a long expiry (8h). Same as test-play.

---

## Implementation order

1. **Step 1** — Admin default room save (small backend + small UI change)
2. **Step 2** — `/api/v1/sonos/cast` endpoint (backend only, test with curl first)
3. **Step 3** — Player output picker (largest change, `webapp/app.js` + `index.html`)
4. **Step 4** — i18n keys (mechanical, all 12 locales)
5. **Step 5** — Admin rename decision

Estimated scope: Steps 1+2 are small (1–2h). Step 3 is the main work (player code).

---

## Open questions for user feedback

1. **Admin "Set as Default" UX**: in the rooms table, or a separate dropdown in the Sonos card header?
2. **Sidebar rename**: keep "Server Audio" + "Sonos" separate, or merge into "Audio Output"?
3. **MPV button label**: rename "Cast to server speaker" tooltip to "Audio Output" / "Cast to…" or leave it?
4. **Sonos cast + browser playback**: when casting to Sonos, should browser audio mute completely (same as MPV mode) or keep playing?
5. **Per-user Sonos permission**: should there be an `allow-sonos-cast` flag per user (same as `allow-mpv-cast`), or is Sonos available to all users?
