# Velvet Mobile — Velvet PWA Plan

**Revision:** May 2026 (updated from Flutter → PWA for cost reasons)
**Platforms:** iOS Safari 16.4+, Android Chrome 90+, desktop Chrome/Edge
**Approach:** Progressive Web App — installable, offline-ready, home-screen icon

---

## Vision

A premium mobile music player using Velvet as its backend — Spotify-level polish meets Apple Music library depth, for music you own. Adaptive layout for phone and tablet. Every screen is built around the native REST API. No App Store submission. No build pipeline. Ships as a URL.

---

## Why PWA Instead of Flutter

| Criteria | Flutter | PWA |
|---|---|---|
| Cost | Dart dev, App Store fees | Zero — extends existing webapp |
| Deployment | App Store review cycle | Instant — edit a file, done |
| Background audio | `just_audio_background` | MediaSession API (Chrome/Safari 16.4) |
| Lock screen / BT buttons | `audio_service` | MediaSession API |
| Offline / caching | Isar + cached_network_image | Service Worker + Cache API |
| Local persistence | Isar DB | IndexedDB |
| Auth storage | flutter_secure_storage | Web Crypto + localStorage |
| Custom painting | CustomPainter (Skia) | Canvas 2D API (already used in webapp) |
| iOS home screen | TestFlight → App Store | "Add to Home Screen" — works today |
| Codebase size | Separate Dart project | ~2–3 new files on top of existing webapp |

**Key limitation — iOS background audio:** Safari suspends audio when the screen locks unless the page holds the Audio Session. The `MediaSession` API + a persistent `<audio>` element keeps playback alive on iOS 16.4+ (same constraint as every other web player, including the current desktop one). The existing `webapp/app.js` audio element can be reused directly.

---

## Implementation Strategy

The existing `webapp/` single-page app already handles auth, playback, queue, and scrobbling. The PWA layer adds:

1. **`webapp/manifest.json`** — makes the site installable (`standalone` display mode, icons, theme colour)
2. **`webapp/sw.js`** — Service Worker for album art pre-caching and offline metadata
3. **`webapp/mobile.js`** — Mobile-first UI shell (separate from the desktop `app.js`), loaded when viewport width < 768 px or `?mobile=1`
4. **`webapp/mobile.css`** — Mobile stylesheet (touch targets, safe-area insets, bottom tab bar)

The mobile shell calls the same REST endpoints as the desktop player and reuses the same JWT session.

---

## Web App Manifest (`webapp/manifest.json`)

```json
{
  "name": "Velvet",
  "short_name": "Velvet",
  "display": "standalone",
  "start_url": "/?mobile=1",
  "background_color": "#0D0D0D",
  "theme_color": "#C9A84C",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

Add to `webapp/index.html` `<head>`:
```html
<link rel="manifest" href="/manifest.json">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0D0D0D">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
```

---

## Service Worker (`webapp/sw.js`)

```
Cache strategy:
  GET /album-art/*         →  Cache-first  (art-v1, 500 entries max, LRU eviction)
  GET /api/v1/db/waveform  →  Cache-first  (waveform-v1, permanent)
  POST /api/v1/db/metadata →  Network-first, fallback to cache
  Everything else          →  Network-only
```

Register in `webapp/index.html`:
```html
<script>
  if ('serviceWorker' in navigator)
    navigator.serviceWorker.register('/sw.js');
</script>
```

---

## API Integration

All calls add `x-access-token: <jwt>` header. Token stored in `localStorage` (encrypted with Web Crypto AES-GCM if available).

### Auth bootstrap
```
1. GET  /api/v1/ping/public        →  {instanceId, hasUsers}
2. POST /api/v1/auth/login         →  {token}   (if hasUsers)
3. Store token in localStorage (Web Crypto AES-GCM encrypted)
4. GET  /api/v1/ping               →  {vpaths, vpathMetaData, permissions}
```

### Stream URL construction
```
Direct:    https://<server>/media/<vpath>/<filepath>?token=<jwt>
Transcode: https://<server>/transcode/<fp>?codec=opus&bitrate=128k&token=<jwt>
```
Wi-Fi (detected via `navigator.connection.type`) = direct FLAC. Cellular = Opus 128k (user-configurable).

### Album art
```
POST /api/v1/db/metadata {filepath}  →  {hash}
GET  /album-art/<hash>.jpg?compress=zs    (thumbnail ~200px)
GET  /album-art/<hash>.jpg?compress=zl    (full ~600px)
```
Art responses go into the Service Worker cache under `art-v1` so they survive offline.

### Scrobbling lifecycle
```
Track start:  POST /api/v1/wrapped/play-start {filePath}  →  {eventId}
              POST /api/v1/lastfm/scrobble-by-filepath        (now-playing)
Track end:    POST /api/v1/wrapped/play-end {eventId, playedMs}
              POST /api/v1/lastfm/scrobble-by-filepath        (if > 50% played)
Skip:         POST /api/v1/wrapped/play-skip {eventId, playedMs}
```

### MediaSession API (lock screen / Bluetooth)
```js
navigator.mediaSession.metadata = new MediaMetadata({
  title, artist, album,
  artwork: [{ src: artUrl, sizes: '512x512', type: 'image/jpeg' }]
});
navigator.mediaSession.setActionHandler('play',          () => audioEl.play());
navigator.mediaSession.setActionHandler('pause',         () => audioEl.pause());
navigator.mediaSession.setActionHandler('nexttrack',     skipNext);
navigator.mediaSession.setActionHandler('previoustrack', skipPrev);
navigator.mediaSession.setActionHandler('seekto', ({ seekTime }) => { audioEl.currentTime = seekTime; });
```

---

## Information Architecture

```
VELVET MOBILE
├── Home           /api/v1/db/home-summary
├── Search         /api/v1/db/search
├── Library
│   ├── Artists    /api/v1/artists/home -> letter index -> profile
│   ├── Albums     /api/v1/albums/browse -> detail
│   ├── Playlists  static + smart
│   ├── Genres     /api/v1/db/genre-groups
│   └── Decades    /api/v1/db/decades
├── Radio          /api/v1/radio/stations
├── You
│   ├── Stats      /api/v1/user/wrapped
│   └── Settings
└── [Overlay]  Mini Player (always visible) + Full Now Playing sheet
```

---

## Navigation Structure

### Phone
```
+------------------------------------------+
|  Content Area (scroll view)              |
+------------------------------------------+
|  Mini Player  84 px                      |  tap = full screen sheet
+------------------------------------------+
|  Home  Search  Library  Radio  You       |  Bottom Tab Bar  (safe-area-inset-bottom)
+------------------------------------------+
```

### Tablet / landscape (≥ 768px)
```
+----------+------------------------------+
|  Home    |                              |
|  Search  |   Main content panel         |
|  Library |                              |
|  Radio   +------------------------------+
|  You     |  Mini Player strip           |
+----------+------------------------------+
CSS sidebar nav (72px)
```

---

## Screen Designs

### S1 — Server Connect
```
+========================================+
|          VELVET                        |
|       Velvet Client            |
|  +---------------------------------+   |
|  |  https://music.example.com:3000 |   |
|  +---------------------------------+   |
|  [ Connect ]                           |
|  Recent: music.home.arpa:3000          |
+========================================+
```
- Auto-calls GET /api/v1/ping/public on URL entry
- hasUsers=true: slide in username + password fields
- On success: fade to Home

### S2 — Home
```
+========================================+
|  Good evening                   [Cog]  |
|  JUMP BACK IN                          |
|  [Art][Art][Art][Art]                  |  4-wide fast-resume grid
|  RECENTLY PLAYED                       |
|  <- [Art]Artist  [Art]Artist  ->       |  horizontal shelf
|  ON THIS DAY  •  May 24                |
|  <- [Art]Album  [Art]Album   ->        |
|  MOST PLAYED THIS MONTH                |
|  <- [Art]Artist  [Art]Artist  ->       |
+========================================+
```
API: GET /api/v1/db/home-summary

### S3 — Search
```
+========================================+
|  [ Search music... ]                   |
|  BROWSE CATEGORIES (empty state)       |
|  [Rock] [Jazz] [1980s] [Electronic]    |
|  -- results --                         |
|  ARTISTS (3)                           |
|  [Art] Madonna                      >  |
|  ALBUMS (5)                            |
|  [Art] Like a Virgin   Madonna      >  |
|  SONGS (12)                            |
|  [Art] Material Girl          3:14  >  |
+========================================+
```
API: POST /api/v1/db/search {search}. Debounce 500ms. Min 2 chars.

### S4a — Artist Index
```
+========================================+
|  Artists                      [A-Z #]  |  letter strip right edge
|  A                                     |
|  [Art] ABBA                    847  >  |
|  [Art] AC/DC                   312  >  |
|  B                                     |
|  [Art] The Beatles            2.1k  >  |
+========================================+
```
API: GET /api/v1/artists/home (top+recent), POST /api/v1/artists/letter {letter}

### S4b — Artist Profile
```
+========================================+
|  [Fanart hero 240px gradient fade]     |
|  MADONNA                               |
|  847 songs  42 albums                  |
|  [Play]  [Shuffle]  [Bio]              |
|  ALBUMS  <- [Art][Art][Art][Art]  ->   |
|  POPULAR TRACKS                        |
|  1.  Material Girl           3:14  >   |
|  SIMILAR ARTISTS                       |
|  <- [Art]Artist  [Art]Artist  ->       |
+========================================+
```
API: POST /api/v1/artists/profile, GET /api/v1/lastfm/similar-artists?artist=

### S5a — Album Browser
```
+========================================+
|  Albums                        [grid]  |
|  [A-Z v]  [Year v]  [Genre v]          |
|  [Art]    [Art]    [Art]               |  3-column grid
|  Title    Title    Title               |
+========================================+
```
API: GET /api/v1/albums/browse

### S5b — Album Detail
```
+========================================+
|  [Album Art 300x300]                   |
|  Like a Virgin                         |
|  Madonna  1984  9 tracks  24-bit FLAC  |
|  [Play]              [Shuffle]         |
|  1   Material Girl              3:14   |
|  2   Angel                      3:55   |
|  MORE FROM MADONNA  <- [Art][Art]  ->  |
+========================================+
```
API: GET /api/v1/albums/detail?vpath=&album=&artist=
CUE cuepoints[] rendered as waveform markers on Canvas 2D.

### S6 — Now Playing (Full Screen)
Blurred album art fills screen. Dynamic colour from dominant-colour extraction.
```
+========================================+
|  \ swipe down                          |
|         [Album Art 300x300]            |
|  Material Girl                  [Fav] |
|  Madonna  •  Like a Virgin             |
|  ————————[o]——————————————————         |  800-bar waveform scrubber
|  1:22                           3:14   |
|  [|<] [<<15] [||] [>>15] [>|]          |
|  [Shuffle]  <—vol—>  [Repeat]          |
|  Opus 128k  •  8/10                    |
+========================================+
```
Waveform: GET /api/v1/db/waveform?filepath= → 800 bars, drawn with Canvas 2D (same approach as desktop player).
Swipe left=skip, right=prev, down=collapse, up=queue sheet.

### S6b — Queue Sheet
```
+========================================+
|  PLAYING FROM: Like a Virgin           |
|                  [Shuffle]  [Clear]    |
|  > [Art]  Material Girl       3:14     |  current (highlighted)
|  = [Art]  Like a Virgin       3:39     |  = = drag-to-reorder
|  ADD: [Auto-DJ]  [+ Song]  [+ Album]   |
+========================================+
```
Swipe row left = remove. Drag reorder via Pointer Events API. Auto-DJ: POST /api/v1/db/random-songs.

### S7 — Playlists
```
+========================================+
|  Playlists                         [+] |
|  SMART PLAYLISTS                       |
|  * Top Rated               284 songs   |
|  ~ Recently Added           47 songs   |
|  MY PLAYLISTS                          |
|  [Art]  Summer Mix           22 songs  |
+========================================+
```
Smart: POST /api/v1/smart-playlists/run. Static: POST /api/v1/playlist/load.

### S8 — Radio
```
+========================================+
|  NOW PLAYING                           |
|  [Logo]  Radio Nova                    |
|          Dua Lipa — Levitating         |
|          <—vol—>  [Stop]               |
|  MY STATIONS                           |
|  [Logo]  Radio Nova          [>]  [.]  |
|  [+ Add Station]                       |
+========================================+
```
API: GET /api/v1/radio/stations, polled every 10s: GET /api/v1/radio/nowplaying?id=

### S9 — Your Stats
```
+========================================+
|  MAY 2026  [<]  [>]  Period: Month v   |
|  342 plays  57h 12m  127 unique songs  |
|  PERSONALITY: Deep Diver               |
|  "You obsess over complete albums"     |
|  TOP ARTISTS                           |
|  1. [Art] Madonna              87      |
|  LISTENING BY HOUR                     |
|  [24-bar histogram 0-23h]              |
+========================================+
```
API: GET /api/v1/user/wrapped?period=monthly&offset=0

### S10 — Settings
```
+========================================+
|  SERVER                                |
|  music.example.com:3000                |
|  [Change Server]   [Log Out]           |
|  PLAYBACK                              |
|  Quality (Wi-Fi)   Direct FLAC    v    |
|  Quality (Mobile)  Opus 128k      v    |
|  Crossfade         3s          [ON]    |
|  ReplayGain        Track          v    |
|  SCROBBLING                            |
|  Last.fm: Linked   ListenBrainz: [+]  |
|  APPEARANCE                            |
|  Theme: Dark v   Accent: Dynamic [ON]  |
+========================================+
```

---

## Mini Player
84px, always above tab bar. Thin progress bar. `position: fixed; bottom: calc(56px + env(safe-area-inset-bottom))`.
- Tap: CSS `transform: translateY` sheet animation to full Now Playing
- Swipe left = skip / right = previous (Pointer Events with velocity threshold)

---

## PWA Project Structure
```
webapp/
├── index.html               (add <link rel="manifest">, <meta> tags)
├── manifest.json            (NEW — installability)
├── sw.js                    (NEW — Service Worker, art + waveform caching)
├── mobile.css               (NEW — mobile stylesheet, safe-area, tab bar)
├── mobile.js                (NEW — mobile UI shell, reuses API calls from app.js)
├── icons/
│   ├── icon-192.png         (NEW)
│   └── icon-512.png         (NEW, maskable)
├── app.js                   (existing desktop player — unchanged)
├── style.css                (existing — unchanged)
└── locales/                 (existing — mobile.js uses same i18n keys)
```

`mobile.js` imports no external framework — vanilla JS with the same reactive pattern used in `app.js`. Shared utilities (API calls, JWT, scrobbling) are extracted to a `lib/api.js` module so both `app.js` and `mobile.js` can import them without duplication.

---

## State Management

```
<audio> element (shared singleton)
     |
     v
window.MSTATE  (plain reactive object, Object.defineProperty setters trigger UI)
  currentTrack, queue[], playbackState, position, isPlaying, volume
     +-- MiniPlayer (fixed overlay, re-renders on MSTATE change)
     +-- NowPlayingSheet (full screen, slide-up)
     +-- QueueSheet

LibraryState: albums[], artists{}, playlists[], loaded lazily per screen
SettingsState: serverUrl, token, quality, replayGain, crossfade
  → persisted to localStorage (token encrypted with Web Crypto AES-GCM)
```

Queue and last-playing position are saved to **IndexedDB** (`idb-velvet` database, `queue` store) on every change so resumption survives page reload — same behaviour as the existing desktop player's `_saveQueue()`.

---

## Cache Strategy

| Data | Store | TTL |
|---|---|---|
| Album art thumbnails | Service Worker Cache API (`art-v1`) | 30 days (Cache-Control) |
| Waveform data | Service Worker Cache API (`waveform-v1`) | Permanent |
| Album metadata | IndexedDB | 30 min |
| Queue + position | IndexedDB (`queue` store) | Persistent |
| JWT + server URL | localStorage (AES-GCM encrypted) | Persistent |
| API responses (metadata) | Network-first, 5 min IndexedDB fallback | 5 min |

---

## iOS Limitations & Mitigations

| Limitation | Mitigation |
|---|---|
| Background audio suspends on screen lock | Keep `<audio>` element playing (not Web Audio); MediaSession API keeps lock screen controls active on iOS 16.4+ |
| No push notifications for PWA on iOS < 16.4 | Out of scope for v1; Apple added Web Push for PWAs in iOS 16.4 |
| No persistent storage without user grant | Call `navigator.storage.persist()` on first install; show prompt if denied |
| IndexedDB quota varies | Limit queue cache to 2,000 items; artwork stays in SW cache with LRU eviction |

---

## Design Tokens
```
Background  #0D0D0D  Surface  #1A1A1A  Surface+  #252525
Accent      #C9A84C (gold, fallback) / dynamic from album art via Canvas getImageData
Muted text  #888888  Border  #333333

Typography: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto (system fonts only)
Touch targets: min 44×44px (iOS HIG)
Radius: 8px tiles, 12px cards, 999px pills
Spacing: 4/8/12/16/24/32 px
Safe-area: env(safe-area-inset-*) for notches and home bar
```

---

## Release Phasing

| Phase | Scope |
|---|---|
| v0.1 | manifest.json + sw.js (installability + art caching), mobile.css responsive layout, Connect screen |
| v0.2 | Home, Album browse, Album detail, Now Playing sheet, Mini Player, MediaSession lock screen |
| v0.3 | Artist index + profile, Search, Playlists |
| v0.4 | Scrobbling, Your Stats, Radio |
| v0.5 | Drag-to-reorder queue, Smart Playlists, Waveform scrubber, Auto-DJ, offline fallback |
| v1.0 | Tablet layout, performance pass, accessibility audit, Web Push (Android) |

No App Store submission required. PWA updates deploy instantly with a server restart.

---

## Critical Notes

1. No WebSocket — REST polling only
2. Child vpath in URLs: use parentVpath + '/' + filepath (from vpathMetaData in /ping)
3. CUE albums: cuepoints[] from album/detail as waveform markers on Canvas 2D
4. Token refresh: 401 → GET /auth/refresh; null = force re-login
5. No-auth servers: hasUsers=false skips login entirely
6. ReplayGain: r128_track_gain from metadata/batch → Web Audio GainNode, cap +12 dB
7. `<audio>` element must remain in the DOM (not Web Audio source) to keep iOS background audio alive
