/* ─────────────────────────────────────────────────────────────────────────────
   velvet-mobile — app.js  v0.2
   Architecture: Stable shell — audio element never recreated. Navigation only
   replaces #screen content. Mini-player, nav, Now Playing overlay are stable.
   ───────────────────────────────────────────────────────────────────────────── */

// Sticky UI preference — mirror desktop behavior without inline script.
document.cookie = 'ms2_ui=mobile; Path=/; Max-Age=31536000; SameSite=Lax';

/* ── PWA service worker registration ──────────────────────────────────────── */
// The page is served from `/` on phones (root-scoped PWA) and from `/mobile/`
// otherwise. Register the matching SW URL so its scope covers the active path.
if ('serviceWorker' in navigator) {
  const _swUrl = location.pathname.startsWith('/mobile/') ? '/mobile/sw.js' : '/sw.js';
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(_swUrl).catch(err =>
      console.debug('[velvet-mobile] SW registration failed:', err?.message ?? err)
    );
  });
}

/* ── SVG ICON SYSTEM ───────────────────────────────────────────────────────── */
const I = {
  home: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  search: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  library: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
  radio: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/></svg>`,
  you: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  play: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  pause: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
  prev: `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="19 20 9 12 19 4 19 20"/><rect x="5" y="4" width="2" height="16" fill="currentColor" rx="1"/></svg>`,
  next: `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20 5 4"/><rect x="17" y="4" width="2" height="16" fill="currentColor" rx="1"/></svg>`,
  shuffle: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>`,
  repeat: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
  down: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
  right: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
  back: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`,
  note: `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  settings: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  logout: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
  play_sm: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  music: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  queue: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  plus:  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  close: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
};

/* ── STATE ─────────────────────────────────────────────────────────────────── */
const S = {
  serverUrl: '',
  token: '',
  username: '',
  screen: 'connect',      // connect|home|library|album|search|radio|you
  prevScreen: null,       // for back button
  npOpen: false,          // Now Playing overlay open
  npTab:  'player',       // 'player' | 'queue'
  albums: null,           // null = not loaded, [] = loaded
  currentAlbum: null,     // { album, tracks } for album detail
  queue: [],              // [{filepath, title, artist, album, aaFile}]
  queueIdx: -1,
  playing: false,
  shuffle: false,
  repeat: false,          // 'off'|'all'|'one'
  position: 0,            // seconds
  duration: 0,            // seconds
  quality: 'original',
  searchQ: '',
  searchRes: null,        // { artists:[], folders:[], albums:[], tracks:[] }
  searchVpath: 'All',     // current search vpath filter
  vpathMeta: {},          // vpathMetaData from /api/v1/ping
  // Browse
  browseDir: '',          // current file-explorer directory path ('' = root)
  browseDirData: null,    // null = not loaded, {path, directories, files}
  libTab: 'browse',       // 'browse' | 'albums'
  recentFolders: null,    // null = not loaded, [{label, artist, art, songs}]
  // Radio
  stations: null,         // null = not loaded, [{id, name, genre, country, img, link_a}]
  radioStation: null,     // currently playing station or null
  radioNowPlaying: null,  // ICY StreamTitle currently airing
  radioBitrate: null,     // kbps from ICY icy-br header
  // Albums filter pill
  albumsFilter: 'All',    // 'All' | sourceVpath name
  // Recently played
  recentPlayed: null,     // null = not loaded, [{filepath, metadata}]
  // Scrobbling
  lastfmEnabled:       false,
  listenbrainzEnabled: false,
};

/* ── SCROBBLE STATUS ─────────────────────────────────────────────────────── */
async function _loadScrobbleStatus() {
  try {
    const ls = await API.get('/api/v1/lastfm/status');
    S.lastfmEnabled = ls?.serverEnabled === true;
  } catch { S.lastfmEnabled = false; }
  try {
    const lb = await API.get('/api/v1/listenbrainz/status');
    S.listenbrainzEnabled = lb?.serverEnabled === true && lb?.linked === true;
  } catch { S.listenbrainzEnabled = false; }
}

/* ── WAVEFORM ─────────────────────────────────────────────────────────────── */
let _wfData  = null;   // decoded waveform array [0..255] for current track
let _wfFp    = null;   // filepath matching _wfData
let _wfRaf   = null;   // requestAnimationFrame id
let _wfAbort = null;   // AbortController for live fetch

const _WF_LS = 'wf:';
function _wfLsGet(fp) {
  try { const r = localStorage.getItem(_WF_LS + fp); if (!r) return null; const a = JSON.parse(r); return Array.isArray(a) && a.length ? a : null; } catch { return null; }
}
function _wfLsSet(fp, data) {
  try { localStorage.setItem(_WF_LS + fp, JSON.stringify(data)); } catch { /* storage full */ }
}

function _drawWaveformBars(ctx, W, H, data, pct) {
  ctx.clearRect(0, 0, W, H);
  const splitX = pct * W;
  const midY   = H / 2;
  const barW   = W / data.length;
  const drawW  = Math.max(1, barW > 2 ? barW - 1 : barW);
  const cs = getComputedStyle(document.documentElement);
  const played   = cs.getPropertyValue('--accent').trim() || '#C9A84C';
  const unplayed = 'rgba(255,255,255,0.18)';
  if (splitX > 0) {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, splitX, H); ctx.clip();
    ctx.fillStyle = played;
    for (let i = 0; i < data.length; i++) {
      const x = (i / data.length) * W;
      const barH = Math.max(2, (data[i] / 255) * midY * 1.8);
      ctx.fillRect(x, midY - barH / 2, drawW, barH);
    }
    ctx.restore();
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(splitX, 0, W - splitX, H); ctx.clip();
  ctx.fillStyle = unplayed;
  for (let i = 0; i < data.length; i++) {
    const x = (i / data.length) * W;
    const barH = Math.max(2, (data[i] / 255) * midY * 1.8);
    ctx.fillRect(x, midY - barH / 2, drawW, barH);
  }
  ctx.restore();
}

function _drawWaveform() {
  const canvas = document.getElementById('np-waveform');
  if (!canvas) return;
  const W = canvas.offsetWidth; const H = canvas.offsetHeight;
  if (W <= 0 || H <= 0) return;
  if (canvas.width !== W)  canvas.width  = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!_wfData?.length) { ctx.clearRect(0, 0, W, H); return; }
  const el = PLAYER.el;
  const pct = el.duration > 0 ? el.currentTime / el.duration : 0;
  _drawWaveformBars(ctx, W, H, _wfData, Math.max(0, Math.min(1, pct)));
}

function _startWaveformRaf() {
  if (_wfRaf) return;
  const tick = () => { _drawWaveform(); _wfRaf = requestAnimationFrame(tick); };
  _wfRaf = requestAnimationFrame(tick);
}
function _stopWaveformRaf() {
  if (_wfRaf) { cancelAnimationFrame(_wfRaf); _wfRaf = null; }
}

async function _fetchWaveform(fp) {
  if (!fp || /^https?:\/\//i.test(fp)) { _wfData = null; _wfFp = null; _drawWaveform(); return; }
  if (_wfFp === fp) { _drawWaveform(); return; }
  if (_wfAbort) { _wfAbort.abort(); _wfAbort = null; }
  const cached = _wfLsGet(fp);
  if (cached) {
    _wfData = cached; _wfFp = fp; _drawWaveform();
    if (!PLAYER.el.paused) _startWaveformRaf();
    return;
  }
  _wfData = null; _wfFp = null; _drawWaveform();
  const ac = new AbortController();
  _wfAbort = ac;
  try {
    const r = await fetch(`${S.serverUrl}/api/v1/db/waveform?filepath=${encodeURIComponent(fp)}`, {
      headers: { 'x-access-token': S.token },
      signal: ac.signal,
    });
    if (ac.signal.aborted) return;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (ac.signal.aborted) return;
    if (d.waveform?.length) {
      _wfData = d.waveform; _wfFp = fp;
      _wfLsSet(fp, d.waveform);
      _drawWaveform();
      if (!PLAYER.el.paused) _startWaveformRaf();
    }
  } catch (e) { if (e?.name !== 'AbortError') { /* waveform unavailable */ } }
  finally { if (_wfAbort === ac) _wfAbort = null; }
}

/* ── STORAGE ───────────────────────────────────────────────────────────────── */
const LS = {
  get: k => { try { return JSON.parse(localStorage.getItem('vm_' + k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem('vm_' + k, JSON.stringify(v)); } catch { /* no-op */ } },
  del: k => { try { localStorage.removeItem('vm_' + k); } catch { /* no-op */ } },
};

/* ── UTILITIES ─────────────────────────────────────────────────────────────── */
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function artUrl(obj) {
  if (!obj) return '';
  if (obj.aaFile)  return `${S.serverUrl}/album-art/${obj.aaFile}`;
  if (obj.artFile) return `${S.serverUrl}/api/v1/albums/art-file?p=${encodeURIComponent(obj.artFile)}`;
  return '';
}

function artImg(obj) {
  const url = artUrl(obj);
  if (!url) return `<div class="art-ph">${I.note}</div>`;
  // ph sits below; art-over img floats on top; if img errors it removes itself to reveal ph
  return `<div class="art-ph">${I.note}</div><img src="${url}" alt="" class="art-over" loading="lazy" onerror="this.remove()">`;
}

function streamUrl(filepath) {
  return `${S.serverUrl}/media/${filepath.split('/').map(encodeURIComponent).join('/')}`;
}

function radioStreamUrl(station) {
  const url = station?.link_a;
  if (!url) return '';
  return `${S.serverUrl}/api/v1/radio/stream?url=${encodeURIComponent(url)}&token=${encodeURIComponent(S.token)}`;
}

function stationArtUrl(station) {
  if (!station?.img) return '';
  if (/^https?:\/\//i.test(station.img))
    return `${S.serverUrl}/api/v1/radio/art?url=${encodeURIComponent(station.img)}&token=${encodeURIComponent(S.token)}`;
  return `${S.serverUrl}/album-art/${station.img}`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── API ───────────────────────────────────────────────────────────────────── */
const API = {
  async get(path) {
    const r = await fetch(S.serverUrl + path, {
      headers: { 'x-access-token': S.token },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(S.serverUrl + path, {
      method: 'POST',
      headers: { 'x-access-token': S.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },
};

/* ── PLAYER ────────────────────────────────────────────────────────────────── */
const PLAYER = {
  el: null,

  init() {
    this.el = document.getElementById('v-audio');
    this.el.addEventListener('timeupdate',  () => this._onTime());
    this.el.addEventListener('ended',       () => this._onEnded());
    this.el.addEventListener('play',        () => { S.playing = true;  this._refreshUI(); _startWaveformRaf(); });
    this.el.addEventListener('pause',       () => { S.playing = false; this._refreshUI(); _stopWaveformRaf();  _drawWaveform(); });
    this.el.addEventListener('error',       () => this._onError());
    this.el.addEventListener('loadedmetadata', () => { S.duration = this.el.duration; this._refreshUI(); });
  },

  loadTrack(idx, autoPlay = true) {
    if (idx < 0 || idx >= S.queue.length) return;
    // Starting a real track — clear any active radio station so the banner,
    // album art and metadata switch from radio info to the track info.
    if (S.radioStation) {
      clearTimeout(_radioMetaTimer);
      S.radioStation = null;
      S.radioNowPlaying = null;
      S.radioBitrate = null;
    }
    S.queueIdx = idx;
    const t = S.queue[idx];
    this.el.src = streamUrl(t.filepath);
    this.el.load();
    S.position = t.cueOffset ?? 0;
    if (t.cueOffset > 0) {
      const seekOnce = () => {
        this.el.currentTime = t.cueOffset;
        this.el.removeEventListener('loadedmetadata', seekOnce);
        if (autoPlay) this.el.play().catch(() => { /* autoplay policy */ });
      };
      this.el.addEventListener('loadedmetadata', seekOnce);
    } else if (autoPlay) {
      this.el.play().catch(() => { /* browser autoplay policy */ });
    }
    this._refreshNav();
    this._refreshMeta();
    _fetchWaveform(t.filepath);
    // Log play + scrobble (same as desktop)
    API.post('/api/v1/db/stats/log-play', { filePath: t.filepath }).catch(() => {});
    clearTimeout(this._scrobbleTimer);
    if (S.lastfmEnabled || S.listenbrainzEnabled) {
      const fp = t.filepath;
      this._scrobbleTimer = setTimeout(() => {
        if (S.lastfmEnabled)       API.post('/api/v1/lastfm/scrobble-by-filepath',      { filePath: fp }).catch(() => {});
        if (S.listenbrainzEnabled) API.post('/api/v1/listenbrainz/scrobble-by-filepath', { filePath: fp }).catch(() => {});
      }, 30000);
    }
  },

  togglePlay() {
    if (!this.el.src && !S.radioStation) return;
    if (S.playing) {
      this.el.pause();
    } else {
      // Live radio: iOS Safari stalls after pause — reconnect to get a fresh stream
      if (S.radioStation) {
        this.el.src = radioStreamUrl(S.radioStation);
        this.el.load();
      }
      this.el.play().catch(() => { /* no-op */ });
    }
  },

  skipPrev() {
    const cur = S.queue[S.queueIdx];
    const trackStart = cur?.cueOffset ?? 0;
    if (S.position > trackStart + 3) { this.el.currentTime = trackStart; return; }
    const next = S.shuffle ? this._randIdx() : S.queueIdx - 1;
    if (next >= 0) this.loadTrack(next);
    else if (S.repeat === 'all') this.loadTrack(S.queue.length - 1);
  },

  skipNext() {
    if (S.repeat === 'one') { this.el.currentTime = 0; this.el.play().catch(() => { /* no-op */ }); return; }
    const next = S.shuffle ? this._randIdx() : S.queueIdx + 1;
    if (next < S.queue.length) this.loadTrack(next);
    else if (S.repeat === 'all') this.loadTrack(0);
    else { S.playing = false; this._refreshUI(); }
  },

  seek(frac) {
    if (!this.el.duration) return;
    const cur = S.queue[S.queueIdx];
    const start = cur?.cueOffset ?? 0;
    const end   = cur?.cueEndOffset ?? this.el.duration;
    this.el.currentTime = start + frac * (end - start);
  },

  _randIdx() {
    const r = Math.floor(Math.random() * S.queue.length);
    return r === S.queueIdx ? (r + 1) % S.queue.length : r;
  },

  _onTime() {
    S.position = this.el.currentTime;
    S.duration = this.el.duration || 0;
    // CUE sub-track: advance when end boundary reached
    const cur = S.queue[S.queueIdx];
    if (cur?.cueEndOffset != null && S.position >= cur.cueEndOffset - 0.1) {
      this.skipNext();
      return;
    }
    this._refreshProgress();
  },

  _onEnded() { this.skipNext(); },
  _onError() {
    if (S.queue.length > 0 && S.queueIdx < S.queue.length - 1) {
      setTimeout(() => this.skipNext(), 1000);
    }
  },

  _refreshProgress() {
    const cur      = S.queue[S.queueIdx];
    const cuStart  = cur?.cueOffset   ?? 0;
    const cuEnd    = cur?.cueEndOffset ?? S.duration;
    const winDur   = cuEnd > cuStart ? cuEnd - cuStart : S.duration;
    const winPos   = Math.max(0, S.position - cuStart);
    const pct      = winDur > 0 ? (winPos / winDur) * 100 : 0;
    const pctStr   = pct.toFixed(2) + '%';
    const mf = document.querySelector('.mini-prog-fill');
    if (mf) mf.style.width = pctStr;
    const bf = document.querySelector('.np-bar-fill');
    if (bf) bf.style.width = pctStr;
    const bt = document.querySelector('.np-bar-thumb');
    if (bt) bt.style.left = pctStr;
    const te = document.getElementById('np-elapsed');
    if (te) te.textContent = fmtTime(winPos);
    const tr = document.getElementById('np-remain');
    if (tr) tr.textContent = '-' + fmtTime(Math.max(0, winDur - winPos));
  },

  _refreshNav() {
    const tl = document.querySelector('.track-row.playing');
    if (tl) tl.classList.remove('playing');
    const rows = document.querySelectorAll('.track-row');
    rows.forEach(r => {
      if (r.dataset.trackIdx !== undefined) {
        const idx = parseInt(r.dataset.trackIdx);
        r.classList.toggle('playing', idx === S.queueIdx);
      }
    });
  },

  _refreshMeta() {
    if (S.radioStation) { this._refreshRadioMeta(); return; }
    if (S.queueIdx < 0 || S.queueIdx >= S.queue.length) return;
    const t = S.queue[S.queueIdx];
    // Mini player
    const mt = document.querySelector('.mini-title');
    const ma = document.querySelector('.mini-artist');
    const mArt = document.querySelector('.mini-art');
    if (mt) mt.textContent = t.title || 'Unknown';
    if (ma) ma.textContent = t.artist || '';
    if (mArt) mArt.innerHTML = artImg(t);
    // Now Playing
    const nt = document.getElementById('np-title');
    const na = document.getElementById('np-artist');
    const nArt = document.querySelector('.np-art');
    const nbg = document.querySelector('.np-bg');
    if (nt) nt.textContent = t.title || 'Unknown';
    if (na) na.textContent = t.artist || '';
    if (nArt) nArt.innerHTML = artImg(t);
    if (nbg) nbg.innerHTML = artImg(t);
    // MediaSession
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title || 'Unknown',
        artist: t.artist || '',
        album: t.album || '',
        artwork: artUrl(t) ? [{ src: artUrl(t), sizes: '512x512', type: 'image/jpeg' }] : [],
      });
    }
    // Refresh queue view if it's open
    const qv = document.getElementById('np-queue-view');
    if (qv?.classList.contains('active')) qv.innerHTML = _renderQueueView();
  },

  _refreshUI() {
    const mini = document.getElementById('mini-player');
    if (mini) mini.classList.toggle('hidden', S.queue.length === 0 && !S.radioStation);
    // Update play/pause icon in mini
    const mb = document.getElementById('mini-play-btn');
    if (mb) mb.innerHTML = S.playing ? I.pause : I.play;
    // Update play/pause in Now Playing
    const nb = document.getElementById('np-play-btn');
    if (nb) nb.innerHTML = S.playing ? I.pause : I.play;
    this._refreshMeta();
    this._refreshNav();
  },

  _refreshRadioMeta() {
    const st = S.radioStation;
    if (!st) return;
    const imgUrl = stationArtUrl(st);
    const artHtml = imgUrl
      ? `<div class="art-ph">${I.radio}</div><img src="${imgUrl}" alt="" class="art-over" loading="lazy" onerror="this.remove()">`
      : `<div class="art-ph">${I.radio}</div>`;
    // Subtitle: ICY now-playing title takes priority over genre/country
    const subtitle = S.radioNowPlaying || [st.genre, st.country].filter(Boolean).join(' · ') || '';
    // Mini player
    const mt = document.querySelector('.mini-title');
    const ma = document.querySelector('.mini-artist');
    const mArt = document.querySelector('.mini-art');
    if (mt) mt.textContent = st.name || 'Radio';
    if (ma) ma.textContent = subtitle;
    if (mArt) mArt.innerHTML = artHtml;
    // Now Playing
    const nt = document.getElementById('np-title');
    const na = document.getElementById('np-artist');
    const nArt = document.querySelector('.np-art');
    const nbg = document.querySelector('.np-bg');
    if (nt) nt.textContent = st.name || 'Radio';
    if (na) na.textContent = subtitle;
    if (nArt) nArt.innerHTML = artHtml;
    if (nbg) nbg.innerHTML = artHtml;
    // NP times — show "LIVE" + bitrate instead of position/duration
    const te = document.getElementById('np-elapsed');
    const tr = document.getElementById('np-remain');
    if (te) te.textContent = 'LIVE';
    if (tr) tr.textContent = S.radioBitrate ? `${S.radioBitrate} kbps` : '';
    // MediaSession
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: st.name || 'Radio',
        artist: subtitle,
        album: '',
        artwork: imgUrl ? [{ src: imgUrl, sizes: '256x256', type: 'image/jpeg' }] : [],
      });
    }
  },
};

/* ── SHELL INIT (one-time, stable elements) ────────────────────────────────── */
function initShell() {
  document.getElementById('app').innerHTML = `
    <div id="screen" class="screen connect-mode no-player"></div>
    <div id="mini-player" class="mini-player hidden">
      <div class="mini-prog-rail"><div class="mini-prog-fill" style="width:0%"></div></div>
      <div class="mini-art">${I.note}</div>
      <div class="mini-info">
        <div class="mini-title">—</div>
        <div class="mini-artist"></div>
      </div>
      <div class="mini-btns">
        <button id="mini-prev-btn" data-action="prev" aria-label="Previous">${I.prev}</button>
        <button id="mini-play-btn" data-action="play-pause" aria-label="Play/Pause">${I.play}</button>
        <button id="mini-next-btn" data-action="next" aria-label="Next">${I.next}</button>
      </div>
    </div>
    <nav id="nav-bar" class="hidden">
      ${['home','search','library','radio','you'].map(id => `
        <button class="nav-item" data-nav="${id}" aria-label="${id}">
          ${I[id] ?? ''}
          <span>${id.charAt(0).toUpperCase() + id.slice(1)}</span>
        </button>`).join('')}
    </nav>
    <div id="now-playing">
      <div class="np-bg"></div>
      <div class="np-body">
        <div class="np-drag-wrap"><div class="np-drag-handle"></div></div>
        <div class="np-top">
          <span class="np-top-label" id="np-top-label">Now Playing</span>
          <div class="np-top-btns">
            <button class="np-mode" id="np-queue-btn" data-action="np-tab" aria-label="Queue">${I.queue}</button>
            <button class="np-close-btn" data-action="np-close" aria-label="Close">${I.down}</button>
          </div>
        </div>
        <div id="np-player-view">
          <div class="np-art-wrap">
            <div class="np-art">${I.note}</div>
          </div>
          <div class="np-meta">
            <div class="np-title" id="np-title">—</div>
            <div class="np-artist" id="np-artist"></div>
          </div>
          <div class="np-prog-wrap">
            <div class="np-bar" id="np-bar">
              <canvas id="np-waveform"></canvas>
            </div>
            <div class="np-times">
              <span id="np-elapsed">0:00</span>
              <span id="np-remain">-0:00</span>
            </div>
          </div>
          <div class="np-controls">
            <button class="np-btn np-btn-sm" data-action="prev" aria-label="Previous">${I.prev}</button>
            <button class="np-btn np-btn-main" id="np-play-btn" data-action="play-pause" aria-label="Play/Pause">${I.play}</button>
            <button class="np-btn np-btn-sm" data-action="next" aria-label="Next">${I.next}</button>
          </div>
          <div class="np-modes">
            <button class="np-mode" id="np-shuffle" data-action="shuffle" aria-label="Shuffle">${I.shuffle}</button>
            <button class="np-mode" id="np-repeat"  data-action="repeat"  aria-label="Repeat">${I.repeat}</button>
          </div>
        </div>
        <div id="np-queue-view" class="np-queue-view"></div>
      </div>
    </div>
    <audio id="v-audio" preload="auto"></audio>
  `;

  PLAYER.init();

  // Now Playing bar drag to seek
  let dragging = false;
  const npBar = document.getElementById('np-bar');
  npBar.addEventListener('pointerdown', e => {
    dragging = true;
    npBar.setPointerCapture(e.pointerId);
    PLAYER.seek(e.offsetX / npBar.clientWidth);
  });
  npBar.addEventListener('pointermove', e => {
    if (!dragging) return;
    PLAYER.seek(Math.max(0, Math.min(1, e.offsetX / npBar.clientWidth)));
  });
  npBar.addEventListener('pointerup', () => { dragging = false; });

  // MediaSession action handlers
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('previoustrack', () => PLAYER.skipPrev());
    navigator.mediaSession.setActionHandler('nexttrack',     () => PLAYER.skipNext());
    navigator.mediaSession.setActionHandler('play',          () => PLAYER.el.play().catch(() => { /* no-op */ }));
    navigator.mediaSession.setActionHandler('pause',         () => PLAYER.el.pause());
  }
}

/* ── NAVIGATION ────────────────────────────────────────────────────────────── */
function navigate(screen, opts = {}) {
  S.prevScreen = S.screen;
  S.screen = screen;

  const scr = document.getElementById('screen');
  const nav = document.getElementById('nav-bar');
  const mini = document.getElementById('mini-player');
  const mainScreens = ['home', 'search', 'library', 'radio', 'you'];
  const isMain = mainScreens.includes(screen);

  scr.classList.toggle('connect-mode', screen === 'connect');
  scr.classList.toggle('no-player', screen === 'connect' || S.queue.length === 0);
  nav.classList.toggle('hidden', screen === 'connect');
  if (S.queue.length === 0) mini.classList.add('hidden');

  // Active nav indicator
  document.querySelectorAll('.nav-item').forEach(b => {
    const isActive = b.dataset.nav === screen || (screen === 'album' && b.dataset.nav === 'library');
    b.classList.toggle('active', isActive);
  });

  switch (screen) {
    case 'connect': scr.innerHTML = _screenConnect(); break;
    case 'home':    scr.innerHTML = _screenHome(); _loadAlbums(); _loadRecentFolders(); _loadStations(); _loadRecentPlayed(); break;
    case 'library':
      scr.innerHTML = _screenLibrary();
      _loadAlbums();
      if (S.libTab === 'browse' && !S.browseDirData) _loadBrowseDir(S.browseDir);
      break;
    case 'album':   scr.innerHTML = _screenAlbumLoading(); _loadAlbumDetail(opts.albumId ?? ''); break;
    case 'search':  scr.innerHTML = _screenSearch(); break;
    case 'radio':   scr.innerHTML = _screenRadio(); _loadStations(); break;
    case 'you':     scr.innerHTML = _screenYou(); break;
    default:        scr.innerHTML = '<div class="state-empty">Not found</div>';
  }
}

function openNowPlaying() {
  S.npOpen = true;
  document.getElementById('now-playing').classList.add('open');
  const pv  = document.getElementById('np-player-view');
  const qv  = document.getElementById('np-queue-view');
  const qb  = document.getElementById('np-queue-btn');
  const lbl = document.getElementById('np-top-label');
  if (S.npTab === 'queue') {
    if (pv) pv.style.display = 'none';
    if (qv) { qv.classList.add('active'); qv.innerHTML = _renderQueueView(); }
    if (qb) qb.classList.add('on');
    if (lbl) lbl.textContent = 'Queue';
  } else {
    if (pv) pv.style.display = '';
    if (qv) qv.classList.remove('active');
    if (qb) qb.classList.remove('on');
    if (lbl) lbl.textContent = 'Now Playing';
  }
}
function closeNowPlaying() {
  S.npOpen = false;
  document.getElementById('now-playing').classList.remove('open');
}

function _renderQueueView() {
  const q   = S.queue;
  const cur = S.queueIdx;
  if (!q.length) {
    return `<div class="np-q-empty">Queue is empty</div>`;
  }
  let html = '';
  // Now playing
  if (cur >= 0 && cur < q.length) {
    const t = q[cur];
    html += `<div class="np-q-sec">Now playing</div>
    <div class="np-q-track playing" data-action="queue-jump" data-idx="${cur}">
      <div class="np-q-art">${artImg(t)}</div>
      <div class="np-q-info">
        <div class="np-q-title">${esc(t.title || 'Unknown')}</div>
        <div class="np-q-artist">${esc(t.artist || '')}</div>
      </div>
    </div>`;
  }
  // Up next
  const upNext = q.slice(cur + 1);
  if (upNext.length) {
    html += `<div class="np-q-sec np-q-sec-next">
      <span>Next up (${upNext.length})</span>
      <button class="np-q-clear" data-action="queue-clear">Clear</button>
    </div>`;
    html += upNext.map((t, i) => {
      const idx = cur + 1 + i;
      return `<div class="np-q-track" data-action="queue-jump" data-idx="${idx}">
        <div class="np-q-art">${artImg(t)}</div>
        <div class="np-q-info">
          <div class="np-q-title">${esc(t.title || 'Unknown')}</div>
          <div class="np-q-artist">${esc(t.artist || '')}</div>
        </div>
        <button class="np-q-remove" data-action="queue-remove" data-idx="${idx}" aria-label="Remove">${I.close}</button>
      </div>`;
    }).join('');
  }
  // Previously played count
  const played = cur > 0 ? cur : 0;
  if (played) {
    html += `<div class="np-q-sec" style="opacity:.4;margin-top:16px">${played} track${played !== 1 ? 's' : ''} played</div>`;
  }
  return html;
}

/* ── ALBUM DATA LOADING ────────────────────────────────────────────────────── */
async function _loadAlbums() {
  if (S.albums !== null) {
    _refreshAlbumScreens();
    return;
  }
  try {
    const data = await API.get('/api/v1/albums/browse');
    S.albums = Array.isArray(data?.albums) ? data.albums : [];
  } catch {
    S.albums = [];
  }
  _refreshAlbumScreens();
}

function _refreshAlbumScreens() {
  if (S.screen === 'home')    _patchScreen(_screenHome());
  if (S.screen === 'library') _patchScreen(_screenLibrary());
}

function _sanitizeHtmlFragment(html) {
  const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  doc.querySelectorAll('script,iframe,object,embed').forEach(el => el.remove());
  doc.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(attr => {
      const name = String(attr.name || '').toLowerCase();
      const value = String(attr.value || '').trim().toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        return;
      }
      if ((name === 'href' || name === 'src' || name === 'xlink:href') && value.startsWith('javascript:')) {
        el.removeAttribute(attr.name);
      }
    });
  });
  const frag = document.createDocumentFragment();
  frag.append(...Array.from(doc.body.childNodes));
  return frag;
}

function _patchScreen(html) {
  const scr = document.getElementById('screen');
  if (scr) scr.replaceChildren(_sanitizeHtmlFragment(html));
}

/* ── RECENT FOLDERS LOADING ────────────────────────────────────────────────── */
async function _loadRecentFolders() {
  if (S.recentFolders !== null) {
    if (S.screen === 'home') _patchScreen(_screenHome());
    return;
  }
  try {
    const days = await API.post('/api/v1/db/recent/added/by-day', { maxDays: 14, maxFolders: 30 });
    S.recentFolders = (days ?? []).flatMap(d => d.folders ?? []).slice(0, 20);
  } catch {
    S.recentFolders = [];
  }
  if (S.screen === 'home') _patchScreen(_screenHome());
}

/* ── STATIONS LOADING ──────────────────────────────────────────────────────── */
async function _loadStations() {
  if (S.stations !== null) {
    if (S.screen === 'home' || S.screen === 'radio') _patchScreen(S.screen === 'home' ? _screenHome() : _screenRadio());
    return;
  }
  try {
    const data = await API.get('/api/v1/radio/stations');
    S.stations = Array.isArray(data) ? data : [];
  } catch {
    S.stations = [];
  }
  if (S.screen === 'home')  _patchScreen(_screenHome());
  if (S.screen === 'radio') _patchScreen(_screenRadio());
}

/* ── RECENTLY PLAYED LOADING ────────────────────────────────────────────────── */
async function _loadRecentPlayed() {
  if (S.recentPlayed !== null) {
    if (S.screen === 'home') _patchScreen(_screenHome());
    return;
  }
  try {
    const data = await API.post('/api/v1/db/stats/recently-played', { limit: 10 });
    S.recentPlayed = Array.isArray(data) ? data : [];
  } catch {
    S.recentPlayed = [];
  }
  if (S.screen === 'home') _patchScreen(_screenHome());
}

/* ── BROWSE DIR LOADING ────────────────────────────────────────────────────── */
async function _loadBrowseDir(dir = '') {
  S.browseDirData = null;
  if (S.screen === 'library' && S.libTab === 'browse') _patchScreen(_screenLibrary());
  try {
    const data = await API.post('/api/v1/file-explorer', { directory: dir, sort: true, pullMetadata: true });
    S.browseDirData = data;
  } catch {
    S.browseDirData = { directories: [], files: [], path: dir };
  }
  if (S.screen === 'library' && S.libTab === 'browse') _patchScreen(_screenLibrary());
}

async function _loadAlbumDetail(albumId) {
  try {
    const data = await API.get(`/api/v1/albums/detail?id=${encodeURIComponent(albumId)}`);
    S.currentAlbum = data;
    if (S.screen === 'album') _patchScreen(_screenAlbumDetail());
  } catch {
    if (S.screen === 'album') _patchScreen('<div class="state-empty">Could not load album</div>');
  }
}

/* ── SEARCH ────────────────────────────────────────────────────────────────── */
let _searchTimer = null;
function doSearch(q) {
  S.searchQ = q;
  clearTimeout(_searchTimer);
  if (!q.trim()) { S.searchRes = null; _patchSearchResults(); return; }
  _searchTimer = setTimeout(async () => {
    try {
      const vpaths = S.vpaths ?? [];
      const meta   = S.vpathMeta ?? {};
      const sel    = S.searchVpath;

      let ignoreVPaths, filepathPrefix;
      if (sel === 'All') {
        ignoreVPaths   = [];
        filepathPrefix = null;
      } else {
        const selMeta = meta[sel] ?? {};
        if (selMeta.parentVpath) {
          // Child vpath: keep its parent root, exclude other root vpaths
          ignoreVPaths   = vpaths.filter(v => v !== selMeta.parentVpath && !meta[v]?.parentVpath);
          filepathPrefix = selMeta.filepathPrefix ?? null;
        } else {
          // Root vpath: exclude all others
          ignoreVPaths   = vpaths.filter(v => v !== sel);
          filepathPrefix = null;
        }
      }

      const body = { search: q };
      if (ignoreVPaths?.length) body.ignoreVPaths  = ignoreVPaths;
      if (filepathPrefix)        body.filepathPrefix = filepathPrefix;

      const d = await API.post('/api/v1/db/search', body);

      // Ensure album cache is loaded so we can resolve IDs and art
      if (S.albums === null) await _loadAlbums();

      // Albums: match server results to local cache — by MBID first, then by name
      const albumByName    = new Map((S.albums ?? []).map(a => [(a.displayName || '').toLowerCase(), a]));
      const albumByVersion = new Map((S.albums ?? []).filter(a => a.album_version).map(a => [a.album_version, a]));
      const albums = (d.albums ?? []).slice(0, 8).map(a => {
        const local = (a.album_version ? albumByVersion.get(a.album_version) : null)
                   ?? albumByName.get((a.name || '').toLowerCase());
        return local ?? { displayName: a.name, artist: '', aaFile: a.album_art_file, id: null };
      });

      // Tracks: merge d.title (ID3 match) + d.files (filename match), dedup by filepath
      const seenPaths = new Set();
      const tracks = [];
      for (const t of (d.title ?? [])) {
        seenPaths.add(t.filepath);
        tracks.push({
          filepath: t.filepath,
          title:    t.name.includes(' - ') ? t.name.split(' - ').slice(1).join(' - ') : (t.filepath?.split('/').at(-1) ?? 'Unknown'),
          artist:   t.name.includes(' - ') ? t.name.split(' - ')[0] : '',
          aaFile:   t.album_art_file || null,
        });
      }
      for (const f of (d.files ?? [])) {
        if (seenPaths.has(f.filepath)) continue;
        tracks.push({
          filepath: f.filepath,
          title:    f.filepath.split('/').pop().replace(/\.[^.]+$/, ''),
          artist:   '',
          aaFile:   f.album_art_file || null,
        });
      }

      S.searchRes = {
        artists: d.artists ?? [],
        folders: d.folders ?? [],
        albums,
        tracks: tracks.slice(0, 50),
      };
    } catch {
      S.searchRes = { artists: [], folders: [], albums: [], tracks: [] };
    }
    _patchSearchResults();
  }, 300);
}

function _patchSearchResults() {
  const body = document.getElementById('search-results');
  if (!body) return;
  body.innerHTML = _searchResults();
}

/* ── QUEUE HELPERS ─────────────────────────────────────────────────────────── */
/** Flatten album discs into a track list, expanding CUE-sheet files into virtual sub-tracks. */
function _expandTracks(albumData) {
  const out = [];
  for (const disc of albumData.discs ?? []) {
    const dt = disc.tracks ?? [];
    if (dt.length === 1 && dt[0].cuepoints?.length >= 2) {
      const base = dt[0];
      const cps  = base.cuepoints;
      for (let i = 0; i < cps.length; i++) {
        const cp   = cps[i];
        const next = cps[i + 1] ?? null;
        out.push({
          filepath    : base.filepath,
          title       : cp.title || `Track ${cp.no || i + 1}`,
          artist      : base.artist || albumData.artist || '',
          album       : albumData.displayName || '',
          aaFile      : base.aaFile || albumData.aaFile || null,
          duration    : next ? Math.max(0, next.t - cp.t) : (base.duration ? Math.max(0, base.duration - cp.t) : null),
          number      : cp.no || (i + 1),
          cueOffset   : cp.t,
          cueEndOffset: next ? next.t : null,
        });
      }
    } else {
      for (const t of dt) {
        out.push({ filepath: t.filepath, title: t.title || 'Unknown', artist: t.artist || albumData.artist || '', album: albumData.displayName || '', aaFile: t.aaFile || albumData.aaFile || null, duration: t.duration || null, number: t.number || null });
      }
    }
  }
  return out;
}

function playAlbum(albumData, startIdx = 0, shuffle = false) {
  // Detail response: flat object with discs[].tracks[]
  const allTracks = _expandTracks(albumData);
  if (!allTracks.length) return;
  S.queue = allTracks.map(t => ({
    filepath    : t.filepath,
    title       : t.title || 'Unknown',
    artist      : t.artist || albumData.artist || '',
    album       : albumData.displayName || '',
    aaFile      : t.aaFile || albumData.aaFile || null,
    artFile     : albumData.artFile || null,
    duration    : t.duration ?? null,
    cueOffset   : t.cueOffset   ?? null,
    cueEndOffset: t.cueEndOffset ?? null,
  }));
  if (shuffle) {
    S.queue.sort(() => Math.random() - .5);
    S.shuffle = true;
  }
  S.queueIdx = -1;
  document.getElementById('screen').classList.remove('no-player');
  PLAYER.loadTrack(startIdx);
  openNowPlaying();
}

function playTrack(fp, title, artist, album, aaFile) {
  // Try to find the track in the current album tracks
  const existing = S.queue.findIndex(q => q.filepath === fp);
  if (existing >= 0) { PLAYER.loadTrack(existing); openNowPlaying(); return; }
  S.queue = [{ filepath: fp, title, artist, album, aaFile }];
  S.queueIdx = -1;
  document.getElementById('screen').classList.remove('no-player');
  PLAYER.loadTrack(0);
  openNowPlaying();
}

/* ── RADIO NOW-PLAYING METADATA POLLING ────────────────────────────────────── */
let _radioMetaTimer = null;

async function _pollRadioMeta() {
  const st = S.radioStation;
  if (!st?.link_a) return;
  try {
    const url = `${S.serverUrl}/api/v1/radio/nowplaying?url=${encodeURIComponent(st.link_a)}&token=${encodeURIComponent(S.token)}`;
    const r = await fetch(url);
    if (r.ok && S.radioStation?.id === st.id) {
      const d = await r.json();
      S.radioNowPlaying = d.title || null;
      S.radioBitrate    = d.bitrate || null;
      PLAYER._refreshRadioMeta();
    }
  } catch { /* silently ignore network errors */ }
  if (S.radioStation?.id === st.id) {
    _radioMetaTimer = setTimeout(_pollRadioMeta, 20000);
  }
}

function playRadio(station) {
  if (!station?.link_a) return;
  S.radioStation = station;
  S.radioNowPlaying = null;
  S.radioBitrate    = null;
  S.queue = [];   // clear music queue — radio replaces it
  S.queueIdx = -1;
  // Clear any waveform from a previous library track — radio has no waveform
  _wfData = null; _wfFp = null;
  _stopWaveformRaf();
  _drawWaveform();
  const url = radioStreamUrl(station);
  PLAYER.el.src = url;
  PLAYER.el.load();
  PLAYER.el.play().catch(() => { /* autoplay policy */ });
  // Show mini player
  document.getElementById('screen').classList.remove('no-player');
  document.getElementById('mini-player').classList.remove('hidden');
  PLAYER._refreshRadioMeta();
  openNowPlaying();
  // Start ICY metadata polling
  clearTimeout(_radioMetaTimer);
  _pollRadioMeta();
}

function stopRadio() {
  if (!S.radioStation) return;
  clearTimeout(_radioMetaTimer);
  S.radioStation = null;
  S.radioNowPlaying = null;
  S.radioBitrate    = null;
  PLAYER.el.pause();
  PLAYER.el.src = '';
  document.getElementById('mini-player').classList.add('hidden');
  if (S.screen === 'radio') _patchScreen(_screenRadio());
}

/* ── SCREEN RENDERERS ────────────────────────────────────────────────────────── */
function _screenConnect() {
  const savedUrl  = LS.get('serverUrl')  ?? window.location.origin;
  const savedUser = LS.get('username')   ?? '';
  return `
  <div class="connect-wrap">
    <div class="connect-logo">
      <div class="logo-icon">
        <img src="/assets/img/velvet-logo.svg" alt="Velvet" width="76" height="76" style="">
      </div>
      <h1>Velvet</h1>
      <p>Your music, your way</p>
    </div>
    <div class="connect-card">
      <label class="form-label" for="inp-url">Server URL</label>
      <input class="form-input" id="inp-url" type="url" placeholder="https://your-server:3000" value="${esc(savedUrl)}" autocapitalize="off" autocorrect="off" spellcheck="false">
      <label class="form-label" for="inp-user">Username</label>
      <input class="form-input" id="inp-user" type="text" placeholder="admin" value="${esc(savedUser)}" autocapitalize="off">
      <label class="form-label" for="inp-pass">Password</label>
      <input class="form-input" id="inp-pass" type="password" placeholder="••••••••">
      <button class="btn-cta" id="connect-btn">Connect</button>
      <div class="connect-err" id="connect-err" style="display:none"></div>
    </div>
  </div>`;
}

function _screenHome() {
  const stations     = S.stations;
  const recentPlayed = S.recentPlayed;
  const recentFolders = S.recentFolders;
  const albums       = S.albums;

  const greetHtml = `
  <div class="home-hero">
    <div class="home-greeting">
      <h2>Good ${_greeting()}</h2>
      <p>${esc(S.username)}'s music</p>
    </div>
    <button class="home-settings-btn" data-nav="you" aria-label="Settings">${I.settings}</button>
  </div>`;

  // Radio Stations shelf
  let radioHtml = '';
  if (stations === null) {
    radioHtml = `<div class="section-head"><span class="section-label">Radio Stations</span></div>
    <div class="state-loading" style="height:50px;padding:8px"><div class="spinner" style="width:24px;height:24px"></div></div>`;
  } else if (stations.length > 0) {
    radioHtml = `
    <div class="section-head">
      <span class="section-label">Radio Stations</span>
      <button class="section-see-all" data-nav="radio">See all</button>
    </div>
    <div class="shelf" id="shelf-radio">
      ${stations.slice(0, 10).map(st => {
        const imgUrl = stationArtUrl(st);
        const artHtml = imgUrl
          ? `<div class="art-ph">${I.radio}</div><img src="${imgUrl}" alt="" class="art-over" loading="lazy" onerror="this.remove()">`
          : `<div class="art-ph">${I.radio}</div>`;
        const isPlaying = S.radioStation?.id === st.id;
        return `
        <div class="shelf-item${isPlaying ? ' playing' : ''}" data-action="play-station" data-station-id="${st.id}">
          <div class="shelf-art">${artHtml}</div>
          <div class="shelf-name">${esc(st.name)}</div>
          <div class="shelf-sub">${esc(st.genre || st.country || '')}</div>
        </div>`;
      }).join('')}
    </div>`;
  }

  // Recently Played shelf
  let recentPlayedHtml = '';
  if (recentPlayed === null) {
    recentPlayedHtml = `<div class="section-head"><span class="section-label">Recently Played</span></div>
    <div class="state-loading" style="height:50px;padding:8px"><div class="spinner" style="width:24px;height:24px"></div></div>`;
  } else if (recentPlayed.length > 0) {
    recentPlayedHtml = `
    <div class="section-head"><span class="section-label">Recently Played</span></div>
    <div class="shelf" id="shelf-played">
      ${recentPlayed.map(t => {
        const meta = t.metadata ?? {};
        const aaFile = meta['album-art'] || null;
        return `
        <div class="shelf-item"
             data-action="play-track"
             data-filepath="${esc(t.filepath)}"
             data-title="${esc(meta.title || t.filepath?.split('/').at(-1) || 'Unknown')}"
             data-artist="${esc(meta.artist || '')}"
             data-album="${esc(meta.album || '')}"
             data-aa-file="${esc(aaFile || '')}">
          <div class="shelf-art">${artImg({aaFile})}</div>
          <div class="shelf-name">${esc(meta.title || t.filepath?.split('/').at(-1) || 'Unknown')}</div>
          <div class="shelf-sub">${esc(meta.artist || '')}</div>
        </div>`;
      }).join('')}
    </div>`;
  }

  // Recently Added shelf
  let recentAddedHtml = '';
  if (recentFolders === null) {
    recentAddedHtml = `<div class="section-head"><span class="section-label">Recently Added</span></div>
    <div class="state-loading" style="height:50px;padding:8px"><div class="spinner" style="width:24px;height:24px"></div></div>`;
  } else if (recentFolders.length > 0) {
    recentAddedHtml = `
    <div class="section-head"><span class="section-label">Recently Added</span></div>
    <div class="shelf" id="shelf-recent">
      ${recentFolders.slice(0, 12).map((folder, i) => `
        <div class="shelf-item" data-action="play-recent-folder" data-folder-global-idx="${i}">
          <div class="shelf-art">${artImg({aaFile: folder.art})}</div>
          <div class="shelf-name">${esc(folder.label || 'Unknown')}</div>
          <div class="shelf-sub">${esc(folder.artist || '')}</div>
        </div>`).join('')}
    </div>`;
  }

  // Jump Back In — albums (at the bottom)
  let jumpHtml = '';
  if (albums !== null && albums.length > 0) {
    jumpHtml = `
    <div class="section-head">
      <span class="section-label">Jump Back In</span>
      <button class="section-see-all" data-nav="library">See all</button>
    </div>
    <div class="shelf" id="shelf-jump">
      ${albums.slice(0, 10).map(a => `
        <div class="shelf-item" data-action="open-album" data-album-id="${esc(a.id)}">
          <div class="shelf-art">${artImg(a)}</div>
          <div class="shelf-name">${esc(a.displayName || 'Unknown')}</div>
          <div class="shelf-sub">${esc(a.artist || '')}</div>
        </div>`).join('')}
    </div>`;
  }

  return greetHtml + recentPlayedHtml + recentAddedHtml + jumpHtml + radioHtml;
}

function _greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

function _screenLibrary() {
  const tab = S.libTab || 'browse';
  const tabsHtml = `
  <div class="lib-tabs">
    <button class="lib-tab${tab==='browse'?' active':''}" data-action="lib-tab" data-tab="browse">Browse</button>
    <button class="lib-tab${tab==='albums'?' active':''}" data-action="lib-tab" data-tab="albums">Albums</button>
  </div>`;

  return `
  <div class="page-top">
    <h1 class="page-title">Library</h1>
  </div>
  ${tabsHtml}
  ${tab === 'albums' ? _screenAlbumsGrid() : _screenBrowseContent()}`;
}

function _screenAlbumsGrid() {
  const albums = S.albums;
  if (!albums) return `<div class="state-loading"><div class="spinner"></div></div>`;
  if (!albums.length) return `<div class="state-empty">No albums found</div>`;

  // Vpath filter pills
  const vpaths = [...new Set(albums.map(a => a.sourceVpath).filter(Boolean))];
  const filter = S.albumsFilter || 'All';
  const filtered = filter === 'All' ? albums : albums.filter(a => a.sourceVpath === filter);

  const pillsHtml = vpaths.length > 1 ? `
  <div class="vpath-pills">
    <button class="vpath-pill${filter === 'All' ? ' active' : ''}" data-action="albums-filter" data-vpath="All">All</button>
    ${vpaths.map(v => `<button class="vpath-pill${filter === v ? ' active' : ''}" data-action="albums-filter" data-vpath="${esc(v)}">${esc(v)}</button>`).join('')}
  </div>` : '';

  return pillsHtml + `<div class="lib-grid">
    ${filtered.map(a => `
      <div class="grid-card" data-action="open-album" data-album-id="${esc(a.id)}">
        <div class="grid-art">${artImg(a)}</div>
        <div class="grid-name">${esc(a.displayName || 'Unknown')}</div>
        <div class="grid-sub">${esc(a.artist || '')}</div>
      </div>`).join('')}
  </div>`;
}

function _screenBrowseContent() {
  const data = S.browseDirData;
  if (!data) return `<div class="state-loading" style="padding-top:40px"><div class="spinner"></div></div>`;

  const isRoot = S.browseDir === '' || S.browseDir === '/';
  const dirs = data.directories ?? [];
  const files = data.files ?? [];

  let html = '';

  if (!isRoot) {
    const label = S.browseDir.replace(/\/$/, '').split('/').filter(p => p).at(-1) ?? '';
    html += `
    <div class="browse-nav">
      <button class="back-btn" data-action="browse-back">${I.back} Back</button>
      <span class="browse-path">${esc(label)}</span>
    </div>`;
    if (files.length > 0) {
      html += `
      <div class="browse-actions">
        <button class="btn-play" data-action="play-browse-folder">${I.play_sm} Play All (${files.length})</button>
      </div>`;
    }
  }

  if (dirs.length > 0) {
    html += `<div class="browse-list">`;
    for (const dir of dirs) {
      const newPath = (S.browseDir.replace(/\/$/, '') || '') + '/' + dir.name;
      html += `
      <div class="browse-dir-row" data-action="browse-dir" data-dir="${esc(newPath)}">
        <span class="browse-dir-icon">${I.library}</span>
        <span class="browse-dir-name">${esc(dir.name)}</span>
        <span class="browse-dir-arrow">${I.right}</span>
      </div>`;
    }
    html += `</div>`;
  }

  if (files.length > 0) {
    html += `<div class="browse-track-list">`;
    files.forEach((file, idx) => {
      const fp = file.metadata?.filepath ?? '';
      const meta = file.metadata?.metadata ?? {};
      html += `
      <div class="track-row"
           data-action="browse-file"
           data-filepath="${esc(fp)}"
           data-title="${esc(meta.title || file.name || '')}"
           data-artist="${esc(meta.artist || '')}"
           data-aa-file="${esc(meta['album-art'] || '')}">
        <span class="track-n">${idx + 1}</span>
        <div class="track-info">
          <div class="track-t">${esc(meta.title || file.name || 'Unknown')}</div>
          ${meta.artist ? `<div class="track-a">${esc(meta.artist)}</div>` : ''}
        </div>
        <span class="track-d">${fmtTime(meta.duration || 0)}</span>
      </div>`;
    });
    html += `</div>`;
  }

  if (!dirs.length && !files.length) {
    html += `<div class="state-empty">Empty folder</div>`;
  }

  return html;
}

function _screenAlbumLoading() {
  return `<div class="state-loading" style="padding-top:80px"><div class="spinner"></div></div>`;
}

function _screenAlbumDetail() {
  const data = S.currentAlbum;
  if (!data) return `<div class="state-empty">Album not found</div>`;

  const discs = data.discs ?? [];
  const multiDisc = discs.length > 1;
  // Build expanded flat track list (same as playAlbum uses) so data-track-idx aligns with queue
  const expanded = _expandTracks(data);
  let globalIdx = 0;

  const tracksHtml = discs.map(disc => {
    const dt = disc.tracks ?? [];
    let rows;

    if (dt.length === 1 && dt[0].cuepoints?.length >= 2) {
      // CUE-sheet disc: render individual cuepoints as track rows
      const base = dt[0];
      const cps  = base.cuepoints;
      rows = cps.map((cp, ci) => {
        const idx    = globalIdx++;
        const nextCp = cps[ci + 1] ?? null;
        const dur    = nextCp ? Math.max(0, nextCp.t - cp.t) : (base.duration ? Math.max(0, base.duration - cp.t) : 0);
        const isPlay = S.queueIdx === idx && S.queue[idx]?.filepath === base.filepath;
        return `
      <div class="track-row${isPlay ? ' playing' : ''}"
           data-action="play-track"
           data-track-idx="${idx}"
           data-filepath="${esc(base.filepath)}"
           data-title="${esc(cp.title || `Track ${cp.no || ci + 1}`)}"
           data-artist="${esc(base.artist || data.artist || '')}"
           data-album="${esc(data.displayName || '')}"
           data-aa-file="${esc(base.aaFile || data.aaFile || '')}"
           data-cue-offset="${cp.t}"
           data-cue-end="${nextCp ? nextCp.t : ''}">
        <span class="track-n">${cp.no || ci + 1}</span>
        <div class="track-info">
          <div class="track-t">${esc(cp.title || `Track ${cp.no || ci + 1}`)}</div>
        </div>
        <span class="track-d">${fmtTime(dur)}</span>
        <button class="track-add-btn" data-action="queue-add"
                data-filepath="${esc(base.filepath)}"
                data-title="${esc(cp.title || `Track ${cp.no || ci + 1}`)}"
                data-artist="${esc(base.artist || data.artist || '')}"
                data-album="${esc(data.displayName || '')}"
                data-aa-file="${esc(base.aaFile || data.aaFile || '')}"
                aria-label="Add to queue">${I.plus}</button>
      </div>`;
      }).join('');
    } else {
      rows = dt.map(t => {
        const idx    = globalIdx++;
        const isPlay = S.queueIdx === idx && S.queue[idx]?.filepath === t.filepath;
        return `
      <div class="track-row${isPlay ? ' playing' : ''}"
           data-action="play-track"
           data-track-idx="${idx}"
           data-filepath="${esc(t.filepath)}"
           data-title="${esc(t.title || '')}"
           data-artist="${esc(t.artist || data.artist || '')}"
           data-album="${esc(data.displayName || '')}"
           data-aa-file="${esc(data.aaFile || '')}">
        <span class="track-n">${t.number || idx + 1}</span>
        <div class="track-info">
          <div class="track-t">${esc(t.title || 'Unknown')}</div>
          ${t.artist && t.artist !== data.artist ? `<div class="track-a">${esc(t.artist)}</div>` : ''}
        </div>
        <span class="track-d">${fmtTime(t.duration || 0)}</span>
        <button class="track-add-btn" data-action="queue-add"
                data-filepath="${esc(t.filepath)}"
                data-title="${esc(t.title || '')}"
                data-artist="${esc(t.artist || data.artist || '')}"
                data-album="${esc(data.displayName || '')}"
                data-aa-file="${esc(data.aaFile || '')}"
                aria-label="Add to queue">${I.plus}</button>
      </div>`;
      }).join('');
    }

    return `${multiDisc ? `<div class="disc-lbl">Disc ${disc.discIndex}</div>` : ''}${rows}`;
  }).join('');

  const trackCount = expanded.length;
  const totalMin   = Math.round(expanded.reduce((s, t) => s + (t.duration || 0), 0) / 60);

  return `
  <button class="back-btn" data-action="back">${I.back} Library</button>
  <div class="album-hero">
    <div class="album-hero-art">${artImg(data)}</div>
    <div class="album-hero-meta">
      <div class="album-title">${esc(data.displayName || 'Unknown')}</div>
      <div class="album-artist">${esc(data.artist || '')}</div>
      <div class="album-info">${data.year ? esc(data.year) + ' · ' : ''}${trackCount} track${trackCount !== 1 ? 's' : ''} · ${totalMin} min</div>
    </div>
    <div class="album-actions">
      <button class="btn-play" data-action="play-album">${I.play_sm} Play</button>
      <button class="btn-shuffle" data-action="shuffle-album">${I.shuffle} Shuffle</button>
    </div>
  </div>
  ${tracksHtml}`;
}

function _screenSearch() {
  const vpaths = S.vpaths ?? [];
  const pillsHtml = vpaths.length > 1 ? `
  <div class="vpath-pills">
    <button class="vpath-pill${S.searchVpath === 'All' ? ' active' : ''}" data-action="set-search-vpath" data-vpath="All">All</button>
    ${vpaths.map(v => `<button class="vpath-pill${S.searchVpath === v ? ' active' : ''}" data-action="set-search-vpath" data-vpath="${esc(v)}">${esc(v)}</button>`).join('')}
  </div>` : '';
  return `
  <div class="search-bar">
    <div class="search-field">
      <span class="s-icon">${I.search}</span>
      <input class="search-input" id="search-inp" type="search" placeholder="Albums, artists, tracks…" value="${esc(S.searchQ)}" autocomplete="off">
    </div>
    ${pillsHtml}
  </div>
  <div class="search-body" id="search-results">
    ${S.searchRes ? _searchResults() : '<div class="state-empty">Search your library</div>'}
  </div>`;
}

function _searchResults() {
  const res = S.searchRes;
  if (!res) return '<div class="state-empty">Search your library</div>';
  const total = res.artists.length + res.folders.length + res.albums.length + res.tracks.length;
  if (!total) return '<div class="state-empty">No results found</div>';

  let html = '';

  // Order matches desktop: Folders → Artists → Albums → Tracks
  if (res.folders.length) {
    html += `<div class="s-sec-head">Folders</div>`;
    html += res.folders.slice(0, 8).map(f => `
      <div class="s-simple-row" data-action="open-browse" data-dir="${esc(f.browse_path || '')}">
        <div class="s-art"><div class="art-ph">${I.library}</div></div>
        <div style="flex:1;min-width:0">
          <div class="s-name">${esc(f.folder_name || '')}</div>
          <div class="s-sub">${esc(f.dirpath || '')}</div>
        </div>
      </div>`).join('');
  }

  if (res.artists.length) {
    if (html) html += `<div class="s-sec-head" style="margin-top:14px">Artists</div>`;
    else html += `<div class="s-sec-head">Artists</div>`;
    html += res.artists.slice(0, 6).map(a => `
      <div class="s-simple-row" data-action="search-artist" data-name="${esc(a.name)}">
        <div class="s-art"><div class="art-ph">${I.you}</div></div>
        <div style="flex:1;min-width:0">
          <div class="s-name">${esc(a.name)}</div>
          <div class="s-sub">${a.variants?.length ? esc(a.variants.slice(0,3).join(', ')) : 'Artist'}</div>
        </div>
      </div>`).join('');
  }

  if (res.albums.length) {
    if (html) html += `<div class="s-sec-head" style="margin-top:14px">Albums</div>`;
    else html += `<div class="s-sec-head">Albums</div>`;
    html += res.albums.map(a => {
      const action = a.id ? `data-action="open-album" data-album-id="${esc(a.id)}"` : '';
      return `
      <div class="s-album-row" ${action}>
        <div class="s-art">${artImg(a)}</div>
        <div>
          <div class="s-name">${esc(a.displayName || 'Unknown')}</div>
          <div class="s-sub">${esc(a.artist || '')}</div>
        </div>
      </div>`;
    }).join('');
  }

  if (res.tracks.length) {
    if (html) html += `<div class="s-sec-head" style="margin-top:14px">Tracks</div>`;
    else html += `<div class="s-sec-head">Tracks</div>`;
    html += res.tracks.map(t => `
      <div class="s-track-row"
           data-action="play-track"
           data-filepath="${esc(t.filepath)}"
           data-title="${esc(t.title || '')}"
           data-artist="${esc(t.artist || '')}"
           data-album=""
           data-aa-file="${esc(t.aaFile || '')}">
        <div class="s-art"><div class="art-ph">${I.music}</div></div>
        <div style="flex:1;min-width:0">
          <div class="s-name">${esc(t.title || 'Unknown')}</div>
          <div class="s-sub">${esc(t.artist || '')}</div>
        </div>
        <button class="track-add-btn" data-action="queue-add"
                data-filepath="${esc(t.filepath)}"
                data-title="${esc(t.title || '')}"
                data-artist="${esc(t.artist || '')}"
                data-album=""
                data-aa-file="${esc(t.aaFile || '')}"
                aria-label="Add to queue">${I.plus}</button>
      </div>`).join('');
  }

  return html;
}

function _screenRadio() {
  const stations = S.stations;
  const current  = S.radioStation;

  let listHtml = '';
  if (stations === null) {
    listHtml = `<div class="state-loading" style="padding-top:60px"><div class="spinner"></div></div>`;
  } else if (stations.length === 0) {
    listHtml = `<div class="state-empty">No radio stations configured.<br>Add stations in the Admin panel.</div>`;
  } else {
    listHtml = `<div class="radio-list">` + stations.map(st => {
      const imgUrl = stationArtUrl(st);
      const artHtml = imgUrl
        ? `<div class="art-ph">${I.radio}</div><img src="${imgUrl}" alt="" class="art-over" loading="lazy" onerror="this.remove()">`
        : `<div class="art-ph">${I.radio}</div>`;
      const isPlaying = current?.id === st.id && S.playing;
      const isCurrent = current?.id === st.id;
      return `
      <div class="radio-row${isCurrent ? ' radio-current' : ''}" data-action="${isCurrent ? 'stop-radio' : 'play-station'}" data-station-id="${st.id}">
        <div class="radio-art">${artHtml}</div>
        <div class="radio-info">
          <div class="radio-name">${esc(st.name)}</div>
          <div class="radio-sub">${esc([st.genre, st.country].filter(Boolean).join(' · '))}</div>
        </div>
        <div class="radio-play-btn">${isPlaying ? I.pause : I.play_sm}</div>
      </div>`;
    }).join('') + `</div>`;
  }

  return `
  <div class="page-top"><h1 class="page-title">Radio</h1></div>
  ` + listHtml;
}

function _screenYou() {
  const qualOpts = ['original','mp3-320','mp3-192','mp3-128','opus-128','opus-64'].map(q =>
    `<option value="${q}"${S.quality === q ? ' selected' : ''}>${q}</option>`).join('');

  return `
  <div class="page-top"><h1 class="page-title">You</h1></div>
  <div class="settings-group">
    <div class="settings-group-title">Server</div>
    <div class="settings-card">
      <div class="settings-row settings-row-stack">
        <span class="settings-row-label">Connected to</span>
        <span class="settings-row-val">${esc(S.serverUrl)}</span>
      </div>
      <div class="settings-row">
        <span class="settings-row-label">User</span>
        <span class="settings-row-val">${esc(S.username)}</span>
      </div>
    </div>
  </div>
  <div class="settings-group">
    <div class="settings-group-title">Playback</div>
    <div class="settings-card">
      <div class="settings-row">
        <span class="settings-row-label">Quality</span>
        <select class="settings-select" data-action="set-quality">${qualOpts}</select>
      </div>
    </div>
  </div>
  <div class="settings-group" style="margin-top:8px">
    <div class="settings-btn-row">
      <button class="settings-action danger" data-action="logout">
        ${I.logout} Sign out
      </button>
    </div>
  </div>
  <div class="you-credit">
    <div class="you-credit-label">Design</div>
    <div class="you-credit-body">
      UI inspired by
      <a class="you-credit-link" href="https://www.figma.com/community/file/1227220980074899885" target="_blank" rel="noopener">Music App Design – App UI</a>
      by <strong>Sarwar Jahan</strong> — CC BY 4.0
    </div>
  </div>`;
}

/* ── CONNECT FLOW ──────────────────────────────────────────────────────────── */
async function handleConnect() {
  const urlEl  = document.getElementById('inp-url');
  const userEl = document.getElementById('inp-user');
  const passEl = document.getElementById('inp-pass');
  const errEl  = document.getElementById('connect-err');
  const btn    = document.getElementById('connect-btn');

  const url  = (urlEl?.value ?? '').trim().replace(/\/$/, '');
  const user = (userEl?.value ?? '').trim();
  const pass = passEl?.value ?? '';

  if (!url || !user || !pass) {
    _showErr('Please fill in all fields'); return;
  }
  if (!url.startsWith('http')) {
    _showErr('URL must start with http:// or https://'); return;
  }

  btn.disabled = true;
  btn.textContent = 'Connecting…';
  errEl.style.display = 'none';

  try {
    // 1 — ping public
    const ping = await fetch(`${url}/api/v1/ping/public`, { signal: AbortSignal.timeout(6000) });
    if (!ping.ok) throw new Error(`Server error ${ping.status}`);

    // 2 — authenticate
    const auth = await fetch(`${url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
      signal: AbortSignal.timeout(6000),
    });
    const authData = await auth.json();
    if (!auth.ok || !authData.token) throw new Error(authData.message || 'Login failed');

    // 3 — store
    S.serverUrl = url;
    S.token     = authData.token;
    S.username  = user;
    S.vpaths    = authData.vpaths ?? [];
    S.vpathMeta = {}; // vpathMetaData comes from /api/v1/ping, fetched on session restore
    LS.set('serverUrl', url);
    LS.set('username',  user);
    LS.set('token',     authData.token);

    // Fetch vpathMetaData from ping (login endpoint doesn't return it)
    fetch(`${url}/api/v1/ping`, {
      headers: { 'x-access-token': authData.token },
      signal: AbortSignal.timeout(5000),
    }).then(async r => {
      if (r.ok) { try { const pd = await r.json(); S.vpathMeta = pd.vpathMetaData ?? {}; } catch { /* non-critical */ } }
    }).catch(() => { /* non-critical */ });

    _loadScrobbleStatus();
    navigate('home');
  } catch (err) {
    _showErr(err.message || 'Connection failed');
    btn.disabled = false;
    btn.textContent = 'Connect';
  }

  function _showErr(msg) {
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
    if (btn)   { btn.disabled = false; btn.textContent = 'Connect'; }
  }
}

/* ── EVENT DELEGATION ──────────────────────────────────────────────────────── */
document.addEventListener('click', e => {
  // Tap mini-player body → open Now Playing
  const miniBody = e.target.closest('#mini-player');
  if (miniBody && !e.target.closest('.mini-btns')) {
    openNowPlaying(); return;
  }

  const target = e.target.closest('[data-action],[data-nav]');
  if (!target) return;

  const { action, nav } = target.dataset;

  if (nav) { navigate(nav); return; }

  switch (action) {
    case 'connect-submit': handleConnect(); break;
    case 'back':           navigate(S.prevScreen === 'album' ? 'library' : (S.prevScreen ?? 'library')); break;
    case 'play-pause':     PLAYER.togglePlay(); break;
    case 'prev':           PLAYER.skipPrev(); break;
    case 'next':           PLAYER.skipNext(); break;
    case 'np-close':       closeNowPlaying(); break;
    case 'np-tab': {
      const pv  = document.getElementById('np-player-view');
      const qv  = document.getElementById('np-queue-view');
      const qb  = document.getElementById('np-queue-btn');
      const lbl = document.getElementById('np-top-label');
      if (S.npTab === 'player') {
        S.npTab = 'queue';
        if (pv) pv.style.display = 'none';
        if (qv) { qv.classList.add('active'); qv.innerHTML = _renderQueueView(); }
        if (qb) qb.classList.add('on');
        if (lbl) lbl.textContent = 'Queue';
      } else {
        S.npTab = 'player';
        if (pv) pv.style.display = '';
        if (qv) qv.classList.remove('active');
        if (qb) qb.classList.remove('on');
        if (lbl) lbl.textContent = 'Now Playing';
      }
      break;
    }
    case 'queue-jump': {
      const idx = parseInt(target.dataset.idx ?? '-1');
      if (idx >= 0 && idx < S.queue.length) PLAYER.loadTrack(idx);
      break;
    }
    case 'queue-remove': {
      const idx = parseInt(target.dataset.idx ?? '-1');
      if (idx < 0 || idx >= S.queue.length || idx === S.queueIdx) break;
      S.queue.splice(idx, 1);
      if (idx < S.queueIdx) S.queueIdx--;
      const qv = document.getElementById('np-queue-view');
      if (qv?.classList.contains('active')) qv.innerHTML = _renderQueueView();
      break;
    }
    case 'queue-clear': {
      if (S.queueIdx >= 0 && S.queueIdx < S.queue.length) {
        S.queue = [S.queue[S.queueIdx]];
        S.queueIdx = 0;
      } else {
        S.queue = [];
        S.queueIdx = -1;
      }
      const qv = document.getElementById('np-queue-view');
      if (qv?.classList.contains('active')) qv.innerHTML = _renderQueueView();
      break;
    }
    case 'queue-add': {
      const { filepath, title, artist, album } = target.dataset;
      const aaFile = target.dataset.aaFile || null;
      if (!filepath) break;
      const track = { filepath, title: title || 'Unknown', artist: artist || '', album: album || '', aaFile };
      const insertAt = S.queueIdx >= 0 ? S.queueIdx + 1 : S.queue.length;
      S.queue.splice(insertAt, 0, track);
      document.getElementById('screen').classList.remove('no-player');
      document.getElementById('mini-player').classList.remove('hidden');
      if (S.queue.length === 1) { S.queueIdx = -1; PLAYER.loadTrack(0); }
      const qv = document.getElementById('np-queue-view');
      if (qv?.classList.contains('active')) qv.innerHTML = _renderQueueView();
      break;
    }
    case 'shuffle': {
      S.shuffle = !S.shuffle;
      const btn = document.getElementById('np-shuffle');
      if (btn) btn.classList.toggle('on', S.shuffle);
      break;
    }
    case 'repeat': {
      S.repeat = S.repeat === 'off' || !S.repeat ? 'all' : S.repeat === 'all' ? 'one' : 'off';
      const btn = document.getElementById('np-repeat');
      if (btn) { btn.classList.toggle('on', S.repeat !== 'off'); btn.title = `Repeat: ${S.repeat}`; }
      break;
    }
    case 'open-album': {
      const id = target.dataset.albumId;
      navigate('album', { albumId: id });
      break;
    }
    case 'play-album': {
      if (S.currentAlbum) playAlbum(S.currentAlbum, 0, false);
      break;
    }
    case 'shuffle-album': {
      if (S.currentAlbum) playAlbum(S.currentAlbum, 0, true);
      break;
    }
    case 'play-track': {
      // If we're in an album view, play from that album's queue
      if (S.screen === 'album' && S.currentAlbum) {
        const idx = parseInt(target.dataset.trackIdx ?? '0');
        // Build queue from current album if not already the same album
        if (S.queue.length === 0 || S.queue[0]?.album !== (S.currentAlbum.displayName || '')) {
          playAlbum(S.currentAlbum, idx, false);
        } else {
          PLAYER.loadTrack(idx);
          openNowPlaying();
        }
      } else {
        // Single track play (search results)
        const { filepath, title, artist, album } = target.dataset;
        const aaFile = target.dataset.aaFile || null;
        playTrack(filepath, title, artist, album, aaFile);
      }
      break;
    }
    case 'logout': {
      S.serverUrl = ''; S.token = ''; S.username = '';
      S.albums = null; S.queue = []; S.queueIdx = -1;
      S.playing = false;
      S.browseDir = ''; S.browseDirData = null; S.recentFolders = null;
      clearTimeout(_radioMetaTimer);
      S.stations = null; S.radioStation = null; S.radioNowPlaying = null; S.radioBitrate = null; S.recentPlayed = null; S.albumsFilter = 'All'; S.searchVpath = 'All'; S.searchRes = null; S.searchQ = '';
      PLAYER.el.pause(); PLAYER.el.src = '';
      LS.del('serverUrl'); LS.del('username'); LS.del('token');
      document.getElementById('mini-player').classList.add('hidden');
      closeNowPlaying();
      navigate('connect');
      break;
    }
    case 'play-station': {
      const stId = parseInt(target.dataset.stationId ?? '-1');
      const st = (S.stations ?? []).find(s => s.id === stId);
      if (st) playRadio(st);
      break;
    }
    case 'stop-radio': {
      stopRadio();
      break;
    }
    case 'albums-filter': {
      S.albumsFilter = target.dataset.vpath || 'All';
      _patchScreen(_screenLibrary());
      break;
    }
    case 'set-search-vpath': {
      S.searchVpath = target.dataset.vpath || 'All';
      _patchScreen(_screenSearch());
      if (S.searchQ.trim()) doSearch(S.searchQ);
      break;
    }
    case 'search-artist': {
      const name = target.dataset.name || '';
      if (!name) break;
      S.searchQ = name;
      _patchScreen(_screenSearch());
      const inp = document.getElementById('search-inp');
      if (inp) inp.value = name;
      doSearch(name);
      break;
    }
    case 'open-browse': {
      S.libTab     = 'browse';
      S.browseDir  = target.dataset.dir || '';
      S.browseDirData = null;
      navigate('library');
      _loadBrowseDir(S.browseDir);
      break;
    }
    case 'lib-tab': {
      S.libTab = target.dataset.tab || 'browse';
      if (S.libTab === 'browse' && !S.browseDirData) {
        _loadBrowseDir(S.browseDir);
      } else {
        _patchScreen(_screenLibrary());
      }
      break;
    }
    case 'browse-dir': {
      S.browseDir = target.dataset.dir || '';
      S.browseDirData = null;
      _loadBrowseDir(S.browseDir);
      break;
    }
    case 'browse-back': {
      const parts = S.browseDir.replace(/\/$/, '').split('/').filter(p => p);
      parts.pop();
      S.browseDir = parts.length ? '/' + parts.join('/') : '';
      S.browseDirData = null;
      _loadBrowseDir(S.browseDir);
      break;
    }
    case 'browse-file': {
      const fp = (target.dataset.filepath ?? '').replace(/^\//, '');
      const files = S.browseDirData?.files ?? [];
      if (files.length > 1) {
        S.queue = files.map(f => ({
          filepath: (f.metadata?.filepath ?? '').replace(/^\//, ''),
          title:    f.metadata?.metadata?.title || f.name || 'Unknown',
          artist:   f.metadata?.metadata?.artist || '',
          album:    f.metadata?.metadata?.album || '',
          aaFile:   f.metadata?.metadata?.['album-art'] || null,
        }));
        const clickedFp = target.dataset.filepath ?? '';
        const clickedIdx = files.findIndex(f => (f.metadata?.filepath ?? '') === clickedFp);
        S.queueIdx = -1;
        document.getElementById('screen').classList.remove('no-player');
        PLAYER.loadTrack(clickedIdx >= 0 ? clickedIdx : 0);
      } else {
        playTrack(fp, target.dataset.title, target.dataset.artist, '', target.dataset.aaFile || null);
      }
      openNowPlaying();
      break;
    }
    case 'play-browse-folder': {
      const files = S.browseDirData?.files ?? [];
      if (!files.length) break;
      S.queue = files.map(f => ({
        filepath: (f.metadata?.filepath ?? '').replace(/^\//, ''),
        title:    f.metadata?.metadata?.title || f.name || 'Unknown',
        artist:   f.metadata?.metadata?.artist || '',
        album:    f.metadata?.metadata?.album || '',
        aaFile:   f.metadata?.metadata?.['album-art'] || null,
      }));
      S.queueIdx = -1;
      document.getElementById('screen').classList.remove('no-player');
      PLAYER.loadTrack(0);
      openNowPlaying();
      break;
    }
    case 'play-recent-folder': {
      const idx = parseInt(target.dataset.folderGlobalIdx ?? '0');
      const folder = S.recentFolders?.[idx];
      if (!folder?.songs?.length) break;
      S.queue = folder.songs.map(s => ({
        filepath: s.filepath,
        title:    s.metadata?.title || s.filepath?.split('/').at(-1) || 'Unknown',
        artist:   s.metadata?.artist || '',
        album:    s.metadata?.album || folder.label,
        aaFile:   s.metadata?.['album-art'] || null,
      }));
      S.queueIdx = -1;
      document.getElementById('screen').classList.remove('no-player');
      PLAYER.loadTrack(0);
      openNowPlaying();
      break;
    }
    case 'set-quality': {
      S.quality = target.value; LS.set('quality', S.quality);
      break;
    }
  }
});

// Connect button via event delegation on form
document.addEventListener('click', e => {
  if (e.target.id === 'connect-btn') { handleConnect(); }
});

// Search input
document.addEventListener('input', e => {
  if (e.target.id === 'search-inp') doSearch(e.target.value);
});

// Swipe down on Now Playing to close
(function setupSwipe() {
  let startY = 0;
  const np = document.getElementById('now-playing');
  if (!np) return; // will be created in initShell
  document.addEventListener('DOMContentLoaded', () => {
    const np2 = document.getElementById('now-playing');
    if (!np2) return;
    np2.addEventListener('touchstart', e => { startY = e.touches[0].clientY; }, { passive: true });
    np2.addEventListener('touchend', e => {
      const dy = e.changedTouches[0].clientY - startY;
      if (dy > 70) closeNowPlaying();
    }, { passive: true });
  });
})();

/* ── BOOT ──────────────────────────────────────────────────────────────────── */
(function boot() {
  initShell();

  // Swipe-to-close on now playing (after shell init)
  let swipeStartY = 0;
  const npEl = document.getElementById('now-playing');
  npEl.addEventListener('touchstart', e => { swipeStartY = e.touches[0].clientY; }, { passive: true });
  npEl.addEventListener('touchend', e => {
    if (e.changedTouches[0].clientY - swipeStartY > 70) closeNowPlaying();
  }, { passive: true });

  // Handle QR deep-link: /mobile/#qr=%7Curl%7Cuser%7Cpass
  const hash = window.location.hash;
  if (hash.startsWith('#qr=')) {
    try {
      const raw = decodeURIComponent(hash.slice(4)); // |url|user|pass
      const parts = raw.split('|');
      if (parts.length === 4) {
        const [, qrUrl, qrUser, qrPass] = parts;
        // Clear the hash to avoid re-triggering on reload
        history.replaceState(null, '', window.location.pathname);
        // Pre-fill connect form and attempt auto-login
        navigate('connect');
        // Use a short delay to allow the DOM to render
        setTimeout(() => {
          const urlEl  = document.getElementById('inp-url');
          const userEl = document.getElementById('inp-user');
          const passEl = document.getElementById('inp-pass');
          if (urlEl)  urlEl.value  = qrUrl;
          if (userEl) userEl.value = qrUser;
          if (passEl) passEl.value = qrPass;
          handleConnect();
        }, 50);
        return;
      }
    } catch { /* malformed QR hash — fall through to normal boot */ }
  }

  // Try to restore session
  const savedToken  = LS.get('token');
  const savedUrl    = LS.get('serverUrl');
  const savedUser   = LS.get('username');
  const savedQuality = LS.get('quality');

  if (savedQuality) S.quality = savedQuality;

  if (savedToken && savedUrl) {
    S.token     = savedToken;
    S.serverUrl = savedUrl;
    S.username  = savedUser ?? '';
    // Validate token with a quick ping
    fetch(`${savedUrl}/api/v1/ping`, {
      headers: { 'x-access-token': savedToken },
      signal: AbortSignal.timeout(5000),
    }).then(async r => {
      if (r.ok) {
        try { const pd = await r.json(); S.vpaths = pd.vpaths ?? []; S.vpathMeta = pd.vpathMetaData ?? {}; } catch { S.vpaths = []; S.vpathMeta = {}; }
        _loadScrobbleStatus(); navigate('home');
      } else { navigate('connect'); }
    }).catch(() => navigate('connect'));
  } else {
    navigate('connect');
  }
})();
