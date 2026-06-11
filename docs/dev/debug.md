# Velvet Debug Options

This file documents the active debug options currently implemented in code.

## 1) Server: Auto-DJ fallback chain tracing (`DEBUG_AUTODJ`)

### What it does
Enables detailed server-side Auto-DJ fallback logging in `src/api/db.js`.

When enabled, the server logs:
- Initial result count from step 1
- Per-step fallback counts (similar/no-similar, cooldown/no-cooldown, BPM/key flags)
- Final candidate count before tier filtering

### Enable (systemd)
```bash
sudo systemctl edit music.service
```
Add:
```ini
[Service]
Environment=DEBUG_AUTODJ=1
```
Then:
```bash
sudo systemctl daemon-reload
sudo systemctl restart music.service
```

### Watch logs
```bash
journalctl -fu music.service
```
Look for lines such as:
- `[autodj] initial result (step1) = ...`
- `[autodj] stepN ... -> ... rows`
- `[autodj] FINAL pre-tier-filter = ...`

### Disable
Remove the `Environment=DEBUG_AUTODJ=1` override and restart the service.

## 2) Browser: boot/play restore tracing (`localStorage.ms2_dbg_boot`)

### What it does
Enables verbose `[BOOT]` console warnings in `webapp/app.js` for:
- restoreQueue lifecycle
- AudioContext state/resume behavior
- play/pause guard paths
- stalled/reload recovery path

### Enable (DevTools console)
```js
localStorage.ms2_dbg_boot = '1';
location.reload();
```

### Disable
```js
localStorage.removeItem('ms2_dbg_boot');
location.reload();
```

## 3) Browser: Auto-DJ candidate rejection reasons (`window.DJDEBUG`)

### What it does
Enables `[DJ-BLOCK]` reason logs in `webapp/app.js` for each client-side candidate rejection in `_djSongBlocked`.

The log includes:
- rejection reason (for example `no-bpm-tag`, `bpm-out-of-range`, `key-not-neighbour`, `keyword-filter`)
- song fields (`title`, `artist`, `genre`, `bpm`, `key`)
- reference fields (`refBpm`, active tolerance)

### Enable (DevTools console)
```js
window.DJDEBUG = true;
```

### Disable
```js
window.DJDEBUG = false;
```

## 4) Fast troubleshooting flow for Auto-DJ

1. Enable server trace: `DEBUG_AUTODJ=1`
2. Open `journalctl -fu music.service`
3. In browser console: `window.DJDEBUG = true`
4. Reproduce with Auto-DJ and inspect:
   - server counts (`[autodj] ...`)
   - client rejections (`[DJ-BLOCK] ...`)

Interpretation:
- Server rows > 0 and many client `[DJ-BLOCK]` lines: client constraints are rejecting candidates
- Server rows = 0 across fallback steps: no server-side candidates for active constraints

## 5) Scope note

At this moment, these are the explicit debug toggles present in the codebase:
- `DEBUG_AUTODJ`
- `localStorage.ms2_dbg_boot`
- `window.DJDEBUG`

Other `console.debug('[velvet]', ...)` occurrences are regular diagnostic logs, not runtime debug toggles.
