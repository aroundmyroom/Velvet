/*
 * Velvet TV — Tizen 6.0 client
 * Targets Chromium 76 (Samsung TV 2021).
 * No optional chaining, no nullish coalescing, no ES2020+.
 */

/* ── State ──────────────────────────────────────────────────────────────────── */
var S = {
  baseUrl:     '',
  token:       '',
  username:    '',
  queue:       [],    // [{filepath, title, artist, album, artFile}]
  queueIdx:    -1,
  playing:     false,
  autoDj:      false,
  autoDjIgnoreList: [],
  currentView: 'home',
  albumCache:  null,
  artistCache: null,
  waveform:    null,   // decoded waveform array [0..255] for current track
  waveformFp:  null,   // filepath matching S.waveform (avoids double-fetch)
  // Focus management
  focusArea:   'nav',   // 'login' | 'nav' | 'content' | 'player' | 'overlay'
};

/* ── Saved settings ──────────────────────────────────────────────────────────── */
function _saveSettings() {
  try {
    localStorage.setItem('velvet_tv_url',   S.baseUrl);
    localStorage.setItem('velvet_tv_user',  S.username);
    localStorage.setItem('velvet_tv_token', S.token);
  } catch (e) {}
}

function _loadSettings() {
  try {
    S.baseUrl  = localStorage.getItem('velvet_tv_url')   || '';
    S.username = localStorage.getItem('velvet_tv_user')  || '';
    S.token    = localStorage.getItem('velvet_tv_token') || '';
  } catch (e) {}
}

function _clearSettings() {
  try {
    localStorage.removeItem('velvet_tv_url');
    localStorage.removeItem('velvet_tv_user');
    localStorage.removeItem('velvet_tv_token');
  } catch (e) {}
}

/* ── API helpers ─────────────────────────────────────────────────────────────── */
function api(method, path, body) {
  var url = S.baseUrl + '/' + path.replace(/^\//, '');
  var opts = {
    method: method,
    headers: {
      'x-access-token': S.token,
      'Content-Type': 'application/json'
    }
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(url, opts).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

// aaFile is a hash like "abc123.jpg" served from /album-art/
function artUrl(aaFile, size) {
  if (!aaFile) return '';
  return S.baseUrl + '/album-art/' + encodeURIComponent(aaFile) + '?compress=' + (size || 'm') + '&token=' + encodeURIComponent(S.token);
}

// Prefer aaFile (cached hash); fall back to raw artFile path
function albumArtUrl(aaFile, artFile) {
  if (aaFile) return artUrl(aaFile, 'm');
  if (!artFile) return '';
  if (artFile.indexOf('http') === 0) return artFile;
  return S.baseUrl + '/api/v1/albums/art-file?p=' + encodeURIComponent(artFile) + '&token=' + encodeURIComponent(S.token);
}

/* ── DOM shortcuts ────────────────────────────────────────────────────────────── */
function el(id) { return document.getElementById(id); }
function show(id) { el(id).classList.remove('hidden'); }
function hide(id) { el(id).classList.add('hidden'); }

/* ── Loading overlay ─────────────────────────────────────────────────────────── */
function showLoading() { show('loading-overlay'); }
function hideLoading() { hide('loading-overlay'); }

/* ── Time format ─────────────────────────────────────────────────────────────── */
function fmtTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  var m = Math.floor(sec / 60);
  var s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/* ─────────────────────────────────────────────────────────────────────────────
   FOCUS MANAGER — D-pad navigation
   ────────────────────────────────────────────────────────────────────────── */
var _currentFocusEl = null;

function _allFocusable(container) {
  return Array.prototype.slice.call(
    (container || document).querySelectorAll('.focusable:not([disabled])')
  );
}

// Visible check that also works for position:fixed elements (offsetParent is null for those)
function _isVisible(e) {
  return !!e && e.getClientRects().length > 0;
}

function setFocus(el) {
  if (!el) return;
  if (_currentFocusEl) _currentFocusEl.classList.remove('focused');
  _currentFocusEl = el;
  el.classList.add('focused');
  el.focus();
  // Scroll into view if needed
  if (el.scrollIntoViewIfNeeded) {
    el.scrollIntoViewIfNeeded(false);
  } else if (el.scrollIntoView) {
    el.scrollIntoView({ block: 'nearest' });
  }
}

function focusFirst(container) {
  var items = _allFocusable(container);
  if (items.length) setFocus(items[0]);
}

// Which UI zone an element belongs to: 'nav' | 'content' | 'player' | 'overlay'
function _zoneOf(elm) {
  if (!elm) return 'content';
  var ov = el('player-overlay');
  if (ov && ov.contains(elm) && !ov.classList.contains('hidden')) return 'overlay';
  var nav = el('nav-bar');
  if (nav && nav.contains(elm)) return 'nav';
  var pb = el('player-bar');
  if (pb && pb.contains(elm)) return 'player';
  return 'content';
}

var _lastContentFocus = null;  // remember content focus so we can return from the player bar

function _playerBarVisible() {
  var pb = el('player-bar');
  return pb && !pb.classList.contains('hidden');
}

function _focusZone(zone) {
  var container = zone === 'nav' ? el('nav-bar')
    : zone === 'player' ? el('player-bar')
    : null;
  if (zone === 'content') {
    // Restore previous content focus if still visible, else first item in active view
    if (_lastContentFocus && _isVisible(_lastContentFocus)) { setFocus(_lastContentFocus); return true; }
    var view = document.querySelector('.view.active');
    if (view) { var items = _allFocusable(view); if (items.length) { setFocus(items[0]); return true; } }
    return false;
  }
  if (!container) return false;
  var list = _allFocusable(container).filter(function(e) { return _isVisible(e); });
  if (!list.length) return false;
  setFocus(list[0]);
  return true;
}

// Pure spatial focus move within a single container (no zone jumping).
function _spatialMove(cur, dir, container) {
  var all = _allFocusable(container).filter(function(e) {
    return _isVisible(e);  // visible (works for fixed-position too)
  });
  var curRect = cur.getBoundingClientRect();
  var curCX = curRect.left + curRect.width / 2;
  var curCY = curRect.top + curRect.height / 2;
  var best = null;
  var bestScore = Infinity;
  for (var i = 0; i < all.length; i++) {
    var candidate = all[i];
    if (candidate === cur) continue;
    var r = candidate.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    var dx = cx - curCX;
    var dy = cy - curCY;
    var inRange = false, primary = 0, secondary = 0;
    if (dir === 'right' && dx > 0) { inRange = true; primary = dx; secondary = Math.abs(dy); }
    else if (dir === 'left' && dx < 0) { inRange = true; primary = -dx; secondary = Math.abs(dy); }
    else if (dir === 'down' && dy > 0) { inRange = true; primary = dy; secondary = Math.abs(dx); }
    else if (dir === 'up' && dy < 0) { inRange = true; primary = -dy; secondary = Math.abs(dx); }
    if (!inRange) continue;
    var score = primary + secondary * 3;
    if (score < bestScore) { bestScore = score; best = candidate; }
  }
  if (best) { setFocus(best); return true; }
  return false;
}

function _moveFocus(dir) {
  var cur = _currentFocusEl;
  if (!cur) {
    focusFirst();
    return;
  }

  // Login screen: scope the spatial search to the login fields only (no zones here)
  var loginScreen = el('screen-login');
  if (loginScreen && !loginScreen.classList.contains('hidden')) {
    _spatialMove(cur, dir, loginScreen);
    return;
  }

  var zone = _zoneOf(cur);
  if (zone === 'content') _lastContentFocus = cur;

  // Same-zone spatial search
  var container = zone === 'nav' ? el('nav-bar')
    : zone === 'player' ? el('player-bar')
    : zone === 'overlay' ? el('player-overlay')
    : document.querySelector('.view.active') || document;

  var all = _allFocusable(container).filter(function(e) {
    return _isVisible(e);  // visible (works for fixed-position too)
  });

  var curRect = cur.getBoundingClientRect();
  var curCX = curRect.left + curRect.width / 2;
  var curCY = curRect.top + curRect.height / 2;

  var best = null;
  var bestScore = Infinity;

  for (var i = 0; i < all.length; i++) {
    var candidate = all[i];
    if (candidate === cur) continue;
    var r = candidate.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;

    var dx = cx - curCX;
    var dy = cy - curCY;

    var inRange = false;
    var primary = 0;
    var secondary = 0;

    if (dir === 'right' && dx > 0) { inRange = true; primary = dx; secondary = Math.abs(dy); }
    else if (dir === 'left' && dx < 0) { inRange = true; primary = -dx; secondary = Math.abs(dy); }
    else if (dir === 'down' && dy > 0) { inRange = true; primary = dy; secondary = Math.abs(dx); }
    else if (dir === 'up' && dy < 0) { inRange = true; primary = -dy; secondary = Math.abs(dx); }

    if (!inRange) continue;

    // Weighted score: primary distance + 3× secondary to prefer alignment
    var score = primary + secondary * 3;
    if (score < bestScore) { bestScore = score; best = candidate; }
  }

  if (best) { setFocus(best); if (zone === 'content') _lastContentFocus = best; return; }

  // No same-zone candidate in this direction — jump between zones
  if (dir === 'down') {
    if (zone === 'nav') { if (_focusZone('content')) return; if (_playerBarVisible()) _focusZone('player'); return; }
    if (zone === 'content') { if (_playerBarVisible()) _focusZone('player'); return; }
  } else if (dir === 'up') {
    if (zone === 'player') { if (_focusZone('content')) return; _focusZone('nav'); return; }
    if (zone === 'content') { _focusZone('nav'); return; }
  } else if (dir === 'right') {
    // Vertical lists have no horizontal neighbours — RIGHT jumps to the player bar
    if (zone === 'content' && _playerBarVisible()) { _focusZone('player'); return; }
  } else if (dir === 'left') {
    // LEFT from the leftmost player control returns to the content list
    if (zone === 'player') { _focusZone('content'); return; }
  }
}

/* ── Key handler ─────────────────────────────────────────────────────────────── */
document.addEventListener('keydown', function(e) {
  var key = e.keyCode;

  // Tizen remote key codes
  var KEY = {
    LEFT:   37, RIGHT: 39, UP: 38, DOWN: 40,
    ENTER:  13, BACK:  10009,
    PLAY:   415, PAUSE: 19, STOP: 413,
    REWIND: 412, FF:    417,
    RED:    403, GREEN: 404, YELLOW: 405, BLUE: 406,
    RETURN: 10009  // same as BACK on Tizen
  };

  var tag = document.activeElement && document.activeElement.tagName;
  var isInput = (tag === 'INPUT' || tag === 'TEXTAREA');

  // Any remote activity resets the idle timer for the visualizer screensaver
  _noteActivity();

  // Visualizer active — any key exits and is consumed (media keys still control playback)
  if (_vizActive()) {
    stopViz();
    if (key === KEY.PLAY || key === KEY.PAUSE) { togglePlay(); }
    else if (key === KEY.FF) { skipNext(); }
    else if (key === KEY.REWIND) { skipPrev(); }
    e.preventDefault();
    return;
  }

  // Overlay active — no inputs there, block typing early
  if (!el('player-overlay').classList.contains('hidden')) {
    if (key === KEY.LEFT)  { if (_seekIfWave(-10)) { e.preventDefault(); return; } _moveFocus('left'); e.preventDefault(); return; }
    if (key === KEY.RIGHT) { if (_seekIfWave(10))  { e.preventDefault(); return; } _moveFocus('right'); e.preventDefault(); return; }
    if (key === KEY.UP)    { _moveFocus('up'); e.preventDefault(); return; }
    if (key === KEY.DOWN)  { _moveFocus('down'); e.preventDefault(); return; }
    if (key === KEY.ENTER) { _activateFocused(e); return; }
    if (key === KEY.BACK || key === 27) { closeOverlay(); return; }
    if (key === KEY.PLAY)  { togglePlay(); return; }
    if (key === KEY.PAUSE) { togglePlay(); return; }
    return;
  }

  // Login screen — intercept UP/DOWN for field navigation even while typing
  if (!el('screen-login').classList.contains('hidden')) {
    if (key === KEY.UP)   { _moveFocus('up');   e.preventDefault(); return; }
    if (key === KEY.DOWN) { _moveFocus('down'); e.preventDefault(); return; }
    if (key === KEY.ENTER && !isInput) { _activateFocused(e); return; }
    // ENTER on an input: move focus to next field (or button)
    if (key === KEY.ENTER && isInput) {
      var fields = [el('login-url'), el('login-user'), el('login-pass'), el('login-btn')];
      var idx = fields.indexOf(document.activeElement);
      if (idx >= 0 && idx < fields.length - 1) { setFocus(fields[idx + 1]); e.preventDefault(); }
      return;
    }
    if (isInput) return;  // let all other keys through for typing
    return;
  }

  // Main screen — block typing keys (no free-text inputs outside login)
  if (isInput && key !== KEY.BACK && key !== 27) return;

  // Main screen
  if (key === KEY.LEFT)  { if (_seekIfWave(-10)) { e.preventDefault(); return; } _moveFocus('left'); e.preventDefault(); }
  else if (key === KEY.RIGHT) { if (_seekIfWave(10)) { e.preventDefault(); return; } _moveFocus('right'); e.preventDefault(); }
  else if (key === KEY.UP)    { _moveFocus('up'); e.preventDefault(); }
  else if (key === KEY.DOWN)  { _moveFocus('down'); e.preventDefault(); }
  else if (key === KEY.ENTER) { _activateFocused(e); }
  else if (key === KEY.BACK || key === 27) { _handleBack(); }
  else if (key === KEY.PLAY || key === KEY.PAUSE) { togglePlay(); }
  else if (key === KEY.FF)    { skipNext(); }
  else if (key === KEY.REWIND){ skipPrev(); }
  // Long-press player bar shortcut: OK on player bar opens overlay
});

function _activateFocused(e) {
  if (!_currentFocusEl) return;
  e.preventDefault();
  _currentFocusEl.click();
}

var _viewHistory = ['home'];
function _handleBack() {
  // If viewing an album or artist detail, pop back
  if (S.currentView === 'album-detail') { showView('albums'); return; }
  if (S.currentView === 'artist-profile') { showView('artists'); return; }
  if (S.currentView === 'playlist-detail') { showView('playlists'); return; }
  if (S.currentView === 'home') {
    // On home, Back exits if Tizen
    if (window.tizen) { try { tizen.application.getCurrentApplication().exit(); } catch(ex) {} }
    return;
  }
  showView('home');
}

/* ─────────────────────────────────────────────────────────────────────────────
   SCREENS
   ────────────────────────────────────────────────────────────────────────── */
function showScreen(id) {
  var screens = document.querySelectorAll('.screen');
  for (var i = 0; i < screens.length; i++) {
    screens[i].classList.remove('active');
    screens[i].classList.add('hidden');
  }
  var s = el('screen-' + id);
  s.classList.remove('hidden');
  s.classList.add('active');
}

/* ─────────────────────────────────────────────────────────────────────────────
   VIEWS (inside main screen)
   ────────────────────────────────────────────────────────────────────────── */
function showView(name) {
  S.currentView = name;
  var views = document.querySelectorAll('.view');
  for (var i = 0; i < views.length; i++) {
    views[i].classList.remove('active');
    views[i].classList.add('hidden');
  }

  var viewId = 'view-' + (
    name === 'album-detail'    ? 'album-detail' :
    name === 'artist-profile'  ? 'artist-profile' :
    name === 'playlist-detail' ? 'playlist-detail' :
    name
  );
  var v = el(viewId);
  if (v) {
    v.classList.remove('hidden');
    v.classList.add('active');
    v.scrollTop = 0;
  }

  // Update nav highlight
  var navItems = document.querySelectorAll('.nav-item');
  for (var j = 0; j < navItems.length; j++) {
    var ds = navItems[j].getAttribute('data-screen');
    navItems[j].classList.toggle('active', ds === name);
  }

  // Focus first item in view or fallback to nav
  setTimeout(function() {
    var viewEl = el(viewId);
    if (viewEl) {
      var items = _allFocusable(viewEl);
      if (items.length) { setFocus(items[0]); return; }
    }
    focusFirst(el('nav-bar'));
  }, 50);
}

/* ─────────────────────────────────────────────────────────────────────────────
   LOGIN
   ────────────────────────────────────────────────────────────────────────── */
function _metaVal(name) {
  var m = document.querySelector('meta[name="' + name + '"]');
  if (!m) return '';
  var v = m.content || '';
  // Unreplaced build placeholder → treat as empty
  if (v.indexOf('__VELVET_') === 0) return '';
  return v;
}

function initLogin() {
  _loadSettings();
  // Pre-fill URL from build-time config if nothing stored yet
  if (!S.baseUrl) {
    var cfgUrl = _metaVal('velvet-server-url');
    if (cfgUrl) S.baseUrl = cfgUrl;
  }
  var cfgUser = _metaVal('velvet-username');
  var cfgPass = _metaVal('velvet-password');
  var cfgAuto = _metaVal('velvet-autologin') === '1';

  if (S.baseUrl)  el('login-url').value  = S.baseUrl;
  if (S.username) el('login-user').value = S.username;
  // Pre-fill credentials baked into the build config (testing convenience)
  if (cfgUser && !el('login-user').value) el('login-user').value = cfgUser;
  if (cfgPass) el('login-pass').value = cfgPass;

  el('login-btn').addEventListener('click', doLogin);
  el('login-pass').addEventListener('keydown', function(e) {
    if (e.keyCode === 13) doLogin();
  });

  // If we have a stored token, try it silently
  if (S.token && S.baseUrl) {
    _tryAutoLogin();
  } else if (cfgAuto && S.baseUrl && el('login-user').value && el('login-pass').value) {
    // Auto-login from baked-in config credentials (local testing builds only)
    doLogin();
  } else {
    showScreen('login');
    setTimeout(function() { focusFirst(el('screen-login')); }, 100);
  }
}

function _tryAutoLogin() {
  showLoading();
  api('GET', '/api/v1/ping/public').then(function() {
    // token valid
    hideLoading();
    enterMain();
  }).catch(function() {
    hideLoading();
    S.token = '';
    showScreen('login');
    setTimeout(function() { focusFirst(el('screen-login')); }, 100);
  });
}

function doLogin() {
  var url  = el('login-url').value.trim().replace(/\/$/, '');
  var user = el('login-user').value.trim();
  var pass = el('login-pass').value;
  var errEl = el('login-error');

  if (!url || !user || !pass) {
    errEl.textContent = 'Please fill in all fields.';
    errEl.classList.remove('hidden');
    return;
  }

  errEl.classList.add('hidden');
  S.baseUrl = url;
  showLoading();

  fetch(url + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass })
  }).then(function(r) {
    if (!r.ok) throw new Error('Login failed');
    return r.json();
  }).then(function(data) {
    S.token    = data.token;
    S.username = user;
    _saveSettings();
    hideLoading();
    enterMain();
  }).catch(function(err) {
    hideLoading();
    errEl.textContent = 'Connection failed. Check URL and credentials.';
    errEl.classList.remove('hidden');
    focusFirst(el('screen-login'));
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   MAIN
   ────────────────────────────────────────────────────────────────────────── */
function enterMain() {
  showScreen('main');
  initPlayerBar();
  initNav();
  showView('home');
}

function initNav() {
  var navItems = document.querySelectorAll('.nav-item');
  for (var i = 0; i < navItems.length; i++) {
    (function(item) {
      item.addEventListener('click', function() {
        var screen = item.getAttribute('data-screen');
        navigateTo(screen);
      });
    })(navItems[i]);
  }
  el('nav-logout').addEventListener('click', doLogout);
}

function navigateTo(name) {
  if (name === 'albums')    { showView('albums'); loadAlbums(); }
  else if (name === 'artists')   { showView('artists'); loadArtists(); }
  else if (name === 'playlists') { showView('playlists'); loadPlaylists(); }
  else if (name === 'autodj')    { showView('autodj'); }
  else                           { showView('home'); }
}

function doLogout() {
  _clearSettings();
  S.token = ''; S.baseUrl = ''; S.username = '';
  pauseAudio();
  S.queue = []; S.queueIdx = -1; S.autoDj = false;
  hidePlayerBar();
  showScreen('login');
  el('login-pass').value = '';
  el('login-url').value  = S.baseUrl;
  setTimeout(function() { focusFirst(el('screen-login')); }, 100);
}

/* ─────────────────────────────────────────────────────────────────────────────
   ALBUMS
   ────────────────────────────────────────────────────────────────────────── */
function loadAlbums() {
  if (S.albumCache) { renderAlbumGrid(S.albumCache); return; }
  showLoading();
  api('GET', '/api/v1/albums/browse').then(function(data) {
    S.albumCache = data.albums || [];
    hideLoading();
    renderAlbumGrid(S.albumCache);
  }).catch(function(err) {
    hideLoading();
    el('albums-grid').innerHTML = '<div style="color:#f05050;padding:30px">Failed to load albums.</div>';
  });
}

function renderAlbumGrid(albums) {
  var grid = el('albums-grid');
  if (!albums || !albums.length) {
    grid.innerHTML = '<div style="color:var(--text2);padding:30px">No albums found. Make sure an albumsOnly vpath is configured.</div>';
    el('albums-az').innerHTML = '';
    return;
  }

  var html = '';
  var present = {};
  for (var i = 0; i < albums.length; i++) {
    var a = albums[i];
    var artSrc = albumArtUrl(a.aaFile, a.artFile);
    var letter = _albumLetter(a);
    present[letter] = true;
    html += '<div class="album-card focusable" tabindex="0" data-id="' + _escAttr(a.id) + '" data-letter="' + _escAttr(letter) + '">' +
      (artSrc
        ? '<img class="album-card-art" src="' + _escAttr(artSrc) + '" alt="" loading="lazy" onerror="this.style.display=\'none\';">'
        : '<div class="album-card-art-placeholder">&#127925;</div>') +
      '<div class="album-card-info">' +
        '<div class="album-card-title">' + _esc(a.displayName || a.name || '') + '</div>' +
        '<div class="album-card-artist">' + _esc(a.artist || '') + '</div>' +
      '</div>' +
    '</div>';
  }
  grid.innerHTML = html;

  var cards = grid.querySelectorAll('.album-card');
  for (var j = 0; j < cards.length; j++) {
    (function(card) {
      card.addEventListener('click', function() {
        openAlbumDetail(card.getAttribute('data-id'));
      });
    })(cards[j]);
  }

  _renderAzStrip(present);

  // Restore focus to first card
  setTimeout(function() {
    var items = _allFocusable(grid);
    if (items.length) setFocus(items[0]);
  }, 50);
}

// First-letter bucket for an album: A-Z, or '#' for digits/symbols
function _albumLetter(a) {
  var name = (a.displayName || a.name || '').replace(/^\s+/, '');
  var ch = name.charAt(0).toUpperCase();
  return (ch >= 'A' && ch <= 'Z') ? ch : '#';
}

// Build the A-Z quick-jump sidebar (only letters that exist)
function _renderAzStrip(present) {
  var strip = el('albums-az');
  if (!strip) return;
  var letters = ['#','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z'];
  var html = '';
  for (var i = 0; i < letters.length; i++) {
    var l = letters[i];
    if (!present[l]) continue;
    html += '<button class="az-btn focusable" tabindex="0" data-letter="' + _escAttr(l) + '">' + _esc(l) + '</button>';
  }
  strip.innerHTML = html;
  var btns = strip.querySelectorAll('.az-btn');
  for (var j = 0; j < btns.length; j++) {
    (function(btn) {
      btn.addEventListener('click', function() { _jumpToLetter(btn.getAttribute('data-letter')); });
    })(btns[j]);
  }
}

function _jumpToLetter(letter) {
  var grid = el('albums-grid');
  var cards = grid.querySelectorAll('.album-card');
  for (var i = 0; i < cards.length; i++) {
    if (cards[i].getAttribute('data-letter') === letter) {
      try { cards[i].scrollIntoView(true); } catch (e) { /* older Chromium */ }
      setFocus(cards[i]);
      return;
    }
  }
}

function openAlbumDetail(albumId) {
  showLoading();
  api('GET', '/api/v1/albums/detail?id=' + encodeURIComponent(albumId)).then(function(album) {
    hideLoading();
    _renderAlbumDetail(album);
    showView('album-detail');
  }).catch(function() {
    hideLoading();
  });
}

// A disc is a CUE sheet when it holds a single audio file split by >=2 cuepoints
function _discIsCue(disc) {
  var tr = (disc.tracks || [])[0];
  return (disc.tracks || []).length === 1 && tr && tr.cuepoints && tr.cuepoints.length >= 2;
}

// Turn a disc into an array of playable queue entries (expands CUE sheets)
function _expandDisc(disc, album, discLabel) {
  var out = [];
  var tracks = disc.tracks || [];
  if (_discIsCue(disc)) {
    var base = tracks[0];
    var cps = base.cuepoints;
    for (var i = 0; i < cps.length; i++) {
      var cp = cps[i];
      var next = cps[i + 1];
      var dur = next ? Math.max(0, next.t - cp.t)
        : (base.duration ? Math.max(0, base.duration - cp.t) : null);
      out.push({
        filepath: base.filepath,
        title:    cp.title || base.title || base.filepath.split('/').pop(),
        artist:   base.artist || album.artist || '',
        album:    album.displayName || album.name || '',
        year:     album.year || null,
        track:    cp.no || (i + 1),
        artFile:  base.aaFile || disc.aaFile || album.aaFile || null,
        duration: dur,
        cueOffset:    cp.t,
        cueEndOffset: next ? next.t : null,
        _discLabel:   discLabel
      });
    }
    return out;
  }
  for (var t = 0; t < tracks.length; t++) {
    var tr = tracks[t];
    out.push({
      filepath: tr.filepath,
      title:    tr.title || tr.filepath.split('/').pop(),
      artist:   tr.artist || album.artist || '',
      album:    album.displayName || album.name || '',
      year:     album.year || null,
      track:    tr.number || (t + 1),
      artFile:  tr.aaFile || disc.aaFile || album.aaFile || null,
      duration: tr.duration,
      _discLabel: discLabel
    });
  }
  return out;
}

function _renderAlbumDetail(album) {
  var artSrc = albumArtUrl(album.aaFile, album.artFile);
  var artEl = el('album-detail-art');
  if (artSrc) { artEl.src = artSrc; artEl.style.display = ''; }
  else { artEl.style.display = 'none'; }

  el('album-detail-title').textContent  = album.displayName || album.name || '';
  el('album-detail-artist').textContent = album.artist || '';
  el('album-detail-year').textContent   = album.year ? String(album.year) : '';

  var discs = album.discs || [];
  var multiDisc = discs.length > 1;
  var anyCue = false;

  // Build the ordered playable queue and remember where each disc starts
  var playables = [];
  var discBlocks = [];  // {label, startIdx, count}
  for (var d = 0; d < discs.length; d++) {
    var disc = discs[d];
    if (_discIsCue(disc)) anyCue = true;
    var label = multiDisc ? (disc.label || ('Disc ' + (disc.discIndex || (d + 1)))) : null;
    var expanded = _expandDisc(disc, album, label);
    discBlocks.push({ label: label, startIdx: playables.length, count: expanded.length });
    for (var e = 0; e < expanded.length; e++) playables.push(expanded[e]);
  }

  // Badges (CUE indicator)
  el('album-detail-badges').innerHTML = anyCue
    ? '<span class="alb-badge alb-badge-cue">CUE</span>' : '';

  // Total count + duration line reuses the year element's sibling styling
  var totalDur = 0;
  for (var p = 0; p < playables.length; p++) totalDur += (playables[p].duration || 0);
  var yearTxt = album.year ? String(album.year) : '';
  var metaBits = [];
  if (yearTxt) metaBits.push(yearTxt);
  metaBits.push(playables.length + (playables.length === 1 ? ' track' : ' tracks'));
  if (totalDur > 0) metaBits.push(fmtTime(totalDur));
  el('album-detail-year').textContent = metaBits.join('  •  ');

  // Play all
  el('album-play-all').onclick = function() {
    playQueue(playables.slice(), 0);
  };

  // Track rows grouped by disc
  var html = '';
  for (var b = 0; b < discBlocks.length; b++) {
    var block = discBlocks[b];
    if (block.label) {
      html += '<div class="disc-header">' + _esc(block.label) + '</div>';
    }
    for (var r = 0; r < block.count; r++) {
      var gi = block.startIdx + r;
      var tr2 = playables[gi];
      var cueAttr = tr2.cueOffset != null ? String(tr2.cueOffset) : '';
      html += '<div class="track-row focusable" tabindex="0" data-idx="' + gi + '"' +
        ' data-fp="' + _escAttr(tr2.filepath) + '" data-cue="' + _escAttr(cueAttr) + '">' +
        '<div class="track-num">' + _esc(String(tr2.track || (gi + 1))) + '</div>' +
        '<div class="track-title">' + _esc(tr2.title) +
          (tr2.artist && tr2.artist !== (album.artist || '')
            ? '<span class="track-feat"> — ' + _esc(tr2.artist) + '</span>' : '') +
        '</div>' +
        '<div class="track-dur">' + (tr2.duration ? fmtTime(tr2.duration) : '') + '</div>' +
      '</div>';
    }
  }
  el('album-track-list').innerHTML = html;

  var rows = el('album-track-list').querySelectorAll('.track-row');
  for (var k = 0; k < rows.length; k++) {
    (function(row) {
      row.addEventListener('click', function() {
        playQueue(playables.slice(), parseInt(row.getAttribute('data-idx'), 10));
      });
    })(rows[k]);
  }

  _markPlayingRows();
}

// Highlight the album-detail row matching the currently playing track
function _markPlayingRows() {
  var list = el('album-track-list');
  if (!list) return;
  var rows = list.querySelectorAll('.track-row');
  if (!rows.length) return;
  var cur = S.queue[S.queueIdx] || {};
  var curCue = cur.cueOffset != null ? String(cur.cueOffset) : '';
  for (var i = 0; i < rows.length; i++) {
    var match = S.queueIdx >= 0 &&
      rows[i].getAttribute('data-fp') === cur.filepath &&
      (rows[i].getAttribute('data-cue') || '') === curCue;
    if (match) rows[i].classList.add('playing');
    else rows[i].classList.remove('playing');
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   ARTISTS
   ────────────────────────────────────────────────────────────────────────── */
function loadArtists() {
  showLoading();
  api('GET', '/api/v1/artists/home').then(function(data) {
    hideLoading();
    // API returns topArtists/recentArtists — use topArtists as the list
    S.artistCache = data.topArtists || data.recentArtists || [];
    _renderArtistList(S.artistCache);
  }).catch(function() {
    hideLoading();
    el('artists-list').innerHTML = '<div style="color:#f05050;padding:30px">Failed to load artists.</div>';
  });
}

function _renderArtistList(artists) {
  var list = el('artists-list');
  if (!artists || !artists.length) {
    list.innerHTML = '<div style="color:var(--text2);padding:30px">No artists found.</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < artists.length; i++) {
    var a = artists[i];
    var imgSrc = (a.imageFile)
      ? S.baseUrl + '/api/v1/artists/images/' + encodeURIComponent(a.imageFile)
      : '';
    var displayName = a.canonicalName || a.name || a.artistKey || '';
    var key = a.artistKey || a.key || displayName;
    html += '<div class="artist-row focusable" tabindex="0" data-key="' + _escAttr(key) + '" data-name="' + _escAttr(displayName) + '">' +
      (imgSrc ? '<img class="artist-img" src="' + _escAttr(imgSrc) + '" alt="" loading="lazy">' : '<div class="artist-img" style="background:var(--bg3)"></div>') +
      '<div class="artist-name">' + _esc(displayName) + '</div>' +
    '</div>';
  }
  list.innerHTML = html;

  var rows = list.querySelectorAll('.artist-row');
  for (var j = 0; j < rows.length; j++) {
    (function(row) {
      row.addEventListener('click', function() {
        openArtistProfile(row.getAttribute('data-key'), row.getAttribute('data-name'));
      });
    })(rows[j]);
  }

  setTimeout(function() {
    var items = _allFocusable(list);
    if (items.length) setFocus(items[0]);
  }, 50);
}

function openArtistProfile(key, name) {
  showLoading();
  api('GET', '/api/v1/artists/profile?key=' + encodeURIComponent(key)).then(function(data) {
    hideLoading();
    el('artist-profile-name').textContent = name;
    var img = el('artist-profile-img');
    if (data.imageFile) {
      img.src = S.baseUrl + '/api/v1/artists/images/' + encodeURIComponent(data.imageFile);
      img.style.display = '';
    } else {
      img.style.display = 'none';
    }

    // releaseCategories is an object of {category, releases[]}
    // Flatten all releases into a list of albums
    var grid = el('artist-albums');
    var html = '';
    var releaseCategories = data.releaseCategories || {};
    var catKeys = Object.keys(releaseCategories);
    for (var c = 0; c < catKeys.length; c++) {
      var cat = releaseCategories[catKeys[c]];
      var releases = cat.releases || [];
      for (var r = 0; r < releases.length; r++) {
        var rel = releases[r];
        var artSrc = rel.aaFile ? artUrl(rel.aaFile, 'm') : '';
        var folderName = rel.folder || '';
        var catName = cat.category || '';
        // Use folder as display name, category as subtitle
        html += '<div class="album-card focusable" tabindex="0"' +
          ' data-cat="' + _escAttr(catName) + '"' +
          ' data-folder="' + _escAttr(folderName) + '">' +
          (artSrc ? '<img class="album-card-art" src="' + _escAttr(artSrc) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '<div class="album-card-art-placeholder">&#127925;</div>') +
          '<div class="album-card-info">' +
            '<div class="album-card-title">' + _esc(folderName) + '</div>' +
            '<div class="album-card-artist">' + _esc(rel.year ? String(rel.year) : '') + '</div>' +
          '</div>' +
        '</div>';
      }
    }
    grid.innerHTML = html || '<div style="color:var(--text2);padding:20px">No releases found.</div>';

    // Clicking an artist release plays its tracks directly (no album detail API needed)
    var cards = grid.querySelectorAll('.album-card');
    for (var j = 0; j < cards.length; j++) {
      (function(card, catName2) {
        var cat2 = releaseCategories[catKeys.filter(function(k){ return (releaseCategories[k].category || '') === catName2; })[0]] || {};
        var rel2 = (cat2.releases || []).filter(function(rr){ return rr.folder === card.getAttribute('data-folder'); })[0] || {};
        card.addEventListener('click', function() {
          var tracks = rel2.tracks || [];
          if (!tracks.length) return;
          var queue = tracks.map(function(tr) {
            return {
              filepath: tr.filepath,
              title:    tr.title || tr.filepath.split('/').pop(),
              artist:   tr.artist || name,
              album:    rel2.folder || '',
              artFile:  rel2.aaFile || null
            };
          });
          playQueue(queue, 0);
        });
      })(cards[j], cards[j].getAttribute('data-cat'));
    }

    setTimeout(function() {
      var items = _allFocusable(grid);
      if (items.length) setFocus(items[0]);
    }, 50);
    showView('artist-profile');
  }).catch(function() {
    hideLoading();
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   PLAYLISTS
   ────────────────────────────────────────────────────────────────────────── */
function loadPlaylists() {
  showLoading();
  api('GET', '/api/v1/playlist/getall').then(function(data) {
    hideLoading();
    _renderPlaylists(data || []);
  }).catch(function() {
    hideLoading();
    el('playlists-list').innerHTML = '<div style="color:#f05050;padding:30px">Failed to load playlists.</div>';
  });
}

function _renderPlaylists(playlists) {
  var list = el('playlists-list');
  if (!playlists.length) {
    list.innerHTML = '<div style="color:var(--text2);padding:30px">No playlists yet.</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < playlists.length; i++) {
    var p = playlists[i];
    html += '<div class="playlist-row focusable" tabindex="0" data-name="' + _escAttr(p.name) + '">' +
      '<div class="playlist-name">' + _esc(p.name) + '</div>' +
    '</div>';
  }
  list.innerHTML = html;

  var rows = list.querySelectorAll('.playlist-row');
  for (var j = 0; j < rows.length; j++) {
    (function(row) {
      row.addEventListener('click', function() {
        openPlaylistDetail(row.getAttribute('data-name'));
      });
    })(rows[j]);
  }

  setTimeout(function() {
    var items = _allFocusable(list);
    if (items.length) setFocus(items[0]);
  }, 50);
}

function openPlaylistDetail(name) {
  showLoading();
  api('POST', '/api/v1/playlist/load', { playlistname: name }).then(function(data) {
    // Response is an array
    var tracks = Array.isArray(data) ? data : (data.songs || []);

    // Resolve filepaths via batch metadata API so child-vpath paths
    // (e.g. "12-inches/B/...") get corrected to root-vpath paths ("Music/12-inches/B/...")
    var filepaths = tracks.map(function(t) { return t.filepath; });
    return api('POST', '/api/v1/db/metadata/batch', filepaths).then(function(resolved) {
      hideLoading();
      el('playlist-detail-title').textContent = name;

      var html = '';
      for (var i = 0; i < tracks.length; i++) {
        var tr = tracks[i];
        var meta = tr.metadata || {};
        var title  = meta.title  || tr.filepath.split('/').pop();
        var artist = meta.artist || '';
        html += '<div class="track-row focusable" tabindex="0" data-idx="' + i + '">' +
          '<div class="track-num">' + (i + 1) + '</div>' +
          '<div class="track-title">' + _esc(title) + (artist ? '<br><span style="font-size:22px;color:var(--text2)">' + _esc(artist) + '</span>' : '') + '</div>' +
        '</div>';
      }
      el('playlist-track-list').innerHTML = html || '<div style="color:var(--text2);padding:20px">Empty playlist.</div>';

      var rows = el('playlist-track-list').querySelectorAll('.track-row');
      for (var j = 0; j < rows.length; j++) {
        (function(row, idx) {
          row.addEventListener('click', function() {
            var queue = tracks.map(function(t) {
              var m = t.metadata || {};
              // Use resolved (root-vpath) filepath if available
              var fp = (resolved[t.filepath] && resolved[t.filepath].filepath) || t.filepath;
              return {
                filepath: fp,
                title:   m.title  || t.filepath.split('/').pop(),
                artist:  m.artist || '',
                album:   m.album  || '',
                artFile: m['album-art'] || null
              };
            });
            playQueue(queue, idx);
          });
        })(rows[j], j);
      }

      showView('playlist-detail');
    });
  }).catch(function() {
    hideLoading();
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   AUTO-DJ
   ────────────────────────────────────────────────────────────────────────── */
el('autodj-start-btn').addEventListener('click', function() {
  S.autoDj = true;
  S.autoDjIgnoreList = [];
  S.queue = [];
  S.queueIdx = -1;
  el('autodj-status').textContent = 'Picking a track…';
  show('autodj-status');
  _autoDjPick();
});

function _autoDjPick() {
  if (!S.autoDj) return;
  api('POST', '/api/v1/db/random-songs', { ignoreList: S.autoDjIgnoreList }).then(function(data) {
    var songs = data.songs || [];
    if (!songs.length) { el('autodj-status').textContent = 'No songs found.'; return; }
    var s = songs[0];
    var m = s.metadata || {};
    S.autoDjIgnoreList = data.ignoreList || [];
    var track = {
      filepath: s.filepath,
      title:    m.title  || s.filepath.split('/').pop(),
      artist:   m.artist || '',
      album:    m.album  || '',
      artFile:  m['album-art'] || null
    };
    if (S.queueIdx < 0) {
      // First track: start playing immediately
      S.queue = [track];
      S.queueIdx = 0;
      _loadAndPlay(track);
    } else {
      // Queue it up so _onTrackEnd will pick it
      S.queue.push(track);
    }
    el('autodj-status').textContent = 'Playing: ' + track.title;
  }).catch(function() {
    el('autodj-status').textContent = 'Error fetching track. Retrying…';
    setTimeout(_autoDjPick, 5000);
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
   AUDIO ENGINE
   ────────────────────────────────────────────────────────────────────────── */
var _audio = el('audio');

_audio.addEventListener('ended', _onTrackEnd);
_audio.addEventListener('timeupdate', _onTimeUpdate);
_audio.addEventListener('error', function() {
  skipNext();
});
// Apply a pending CUE seek once the media is ready
var _pendingSeek = 0;
_audio.addEventListener('loadedmetadata', function() {
  if (_pendingSeek > 0) {
    try { _audio.currentTime = _pendingSeek; } catch (e) { /* seek not ready yet */ }
    _pendingSeek = 0;
  }
});

function playQueue(queue, startIdx) {
  S.autoDj = false;
  S.queue = queue;
  S.queueIdx = startIdx;
  var track = queue[startIdx];
  if (track) _loadAndPlay(track);
}

function _trackUrl(filepath) {
  // filepath is always "VpathName/relative/path.mp3"
  // Server mounts at /media/VpathName/ so keep the full filepath as-is
  var parts = filepath.split('/');
  var encoded = parts.map(function(p) { return encodeURIComponent(p); }).join('/');
  return S.baseUrl + '/media/' + encoded + '?token=' + encodeURIComponent(S.token);
}

function _loadAndPlay(track) {
  // Update UI immediately — don't wait for play() promise
  _updatePlayerBar(track);
  showPlayerBar();
  _fetchWaveform(track.filepath);
  var url = _trackUrl(track.filepath);
  // Same file as a previous CUE track? Just seek instead of reloading
  if (track.cueOffset != null && _audio.src === url && !isNaN(_audio.duration)) {
    _pendingSeek = 0;
    try { _audio.currentTime = track.cueOffset; } catch (e) { /* ignore */ }
  } else {
    _pendingSeek = track.cueOffset != null ? track.cueOffset : 0;
    _audio.src = url;
    _audio.load();
  }
  var playResult = _audio.play();
  if (playResult && typeof playResult.then === 'function') {
    playResult.then(function() {
      S.playing = true;
      _updatePlayBtn();
      _screenWake(true);
      if (S.autoDj) _autoDjPick();
    }).catch(function() {
      // Autoplay blocked — show as paused, user presses play
      S.playing = false;
      _updatePlayBtn();
    });
  } else {
    // Older Chromium: play() returns undefined, just assume it works
    S.playing = true;
    _updatePlayBtn();
    _screenWake(true);
    if (S.autoDj) _autoDjPick();
  }
  _markPlayingRows();
}

function _onTrackEnd() {
  if (S.queueIdx < S.queue.length - 1) {
    S.queueIdx++;
    _loadAndPlay(S.queue[S.queueIdx]);
  } else if (S.autoDj) {
    // Auto-DJ should have pre-queued the next track
    if (S.queue.length > S.queueIdx + 1) {
      S.queueIdx++;
      _loadAndPlay(S.queue[S.queueIdx]);
    } else {
      // Fallback if preload missed
      _autoDjPick();
    }
  } else {
    S.playing = false;
    _updatePlayBtn();
  }
}

function _onTimeUpdate() {
  var track = S.queue[S.queueIdx] || {};
  var cur = _audio.currentTime;
  var dur = _audio.duration;

  // CUE segment: report position/duration relative to the segment and auto-advance
  if (track.cueOffset != null) {
    var segStart = track.cueOffset;
    var segEnd = track.cueEndOffset != null ? track.cueEndOffset : dur;
    if (segEnd && !isNaN(segEnd) && cur >= segEnd - 0.15) { _onTrackEnd(); return; }
    var segCur = Math.max(0, cur - segStart);
    var segDur = (segEnd && !isNaN(segEnd)) ? Math.max(0, segEnd - segStart) : 0;
    el('pb-pos').textContent = fmtTime(segCur);
    el('ov-pos').textContent = fmtTime(segCur);
    el('pb-dur').textContent = fmtTime(segDur);
    el('ov-dur').textContent = fmtTime(segDur);
    _drawWaveforms();
    return;
  }

  if (!dur || isNaN(dur)) return;
  el('pb-pos').textContent   = fmtTime(cur);
  el('ov-pos').textContent   = fmtTime(cur);
  el('pb-dur').textContent   = fmtTime(dur);
  el('ov-dur').textContent   = fmtTime(dur);
  _drawWaveforms();
}

/* ─────────────────────────────────────────────────────────────────────────────
   WAVEFORM  (real data from /api/v1/db/waveform) + amplitude VU meter
   ────────────────────────────────────────────────────────────────────────── */
var VU_ACCENT  = '#7b5cf5';
var VU_ACCENT2 = '#a07af7';

function _fetchWaveform(filepath) {
  // Consecutive CUE tracks share the same file — keep the waveform, don't reload/flicker
  if (filepath && S.waveformFp === filepath && S.waveform) { _drawWaveforms(); return; }
  S.waveform = null;
  _drawWaveforms();
  if (!filepath) { S.waveformFp = null; return; }
  S.waveformFp = filepath;
  api('GET', '/api/v1/db/waveform?filepath=' + encodeURIComponent(filepath)).then(function(data) {
    if (S.waveformFp !== filepath) return;  // track changed while loading
    S.waveform = (data && data.waveform) || null;
    _drawWaveforms();
  }).catch(function() {
    // waveform unavailable (ffmpeg off / not cached) — leave bars empty
  });
}

function _playPct() {
  var dur = _audio.duration;
  if (!dur || isNaN(dur)) return 0;
  var track = S.queue[S.queueIdx] || {};
  if (track.cueOffset != null) {
    var segStart = track.cueOffset;
    var segEnd = track.cueEndOffset != null ? track.cueEndOffset : dur;
    var segDur = segEnd - segStart;
    if (segDur <= 0) return 0;
    var p = (_audio.currentTime - segStart) / segDur;
    return p < 0 ? 0 : (p > 1 ? 1 : p);
  }
  return _audio.currentTime / dur;
}

function _drawWaveBars(canvas, data, pct) {
  if (!canvas) return;
  var dpr = window.devicePixelRatio || 1;
  var W = Math.floor(canvas.clientWidth * dpr);
  var H = Math.floor(canvas.clientHeight * dpr);
  if (!W || !H) return;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (!data || !data.length) return;

  var midY = H / 2;
  var n = data.length;
  var barW = W / n;
  var drawW = Math.max(1, barW > 2 ? barW - 1 : barW);
  var splitX = pct * W;

  var grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, VU_ACCENT);
  grad.addColorStop(1, VU_ACCENT2);
  ctx.fillStyle = grad;

  for (var i = 0; i < n; i++) {
    var x = (i / n) * W;
    var barH = Math.max(2 * dpr, (data[i] / 255) * midY * 1.8);
    ctx.globalAlpha = (x < splitX) ? 1 : 0.28;
    ctx.fillRect(x, midY - barH / 2, drawW, barH);
  }
  ctx.globalAlpha = 1;
}

function _drawWaveforms() {
  var pct = _playPct();
  _drawWaveBars(el('pb-wave'), S.waveform, pct);
  if (!el('player-overlay').classList.contains('hidden')) {
    _drawWaveBars(el('ov-wave'), S.waveform, pct);
  }
}

/* Amplitude-driven VU / spectrum meter (no Web Audio — 100% Tizen-safe).
   Bars react to the real waveform envelope at the current playback position. */
var _vuRaf  = null;
var _vuBars = [];
var _vuNoise = [];
var _vuAmp  = 0;
var VU_BAR_COUNT = 40;

function _startVU() {
  if (_vuRaf) return;
  if (!_vuBars.length) {
    for (var i = 0; i < VU_BAR_COUNT; i++) { _vuBars.push(0); _vuNoise.push(0.5 + Math.random() * 0.5); }
  }
  var loop = function() {
    _vuRaf = requestAnimationFrame(loop);
    _drawVU();
  };
  _vuRaf = requestAnimationFrame(loop);
}

function _stopVU() {
  if (_vuRaf) { cancelAnimationFrame(_vuRaf); _vuRaf = null; }
}

function _drawVU() {
  var canvas = el('ov-vu');
  if (!canvas) return;
  var dpr = window.devicePixelRatio || 1;
  var W = Math.floor(canvas.clientWidth * dpr);
  var H = Math.floor(canvas.clientHeight * dpr);
  if (!W || !H) return;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  var amp = 0;
  if (S.waveform && S.waveform.length && _audio.duration && !isNaN(_audio.duration)) {
    var idx = Math.floor((_audio.currentTime / _audio.duration) * S.waveform.length);
    if (idx < 0) idx = 0;
    if (idx >= S.waveform.length) idx = S.waveform.length - 1;
    amp = S.waveform[idx] / 255;
  }
  var playing = S.playing && !_audio.paused;

  // Smooth the driving amplitude — fast attack so it tracks the waveform, gentle release
  _vuAmp += (amp - _vuAmp) * (amp > _vuAmp ? 0.6 : 0.12);

  var n = VU_BAR_COUNT;
  var gap = 4 * dpr;
  var barW = (W - gap * (n - 1)) / n;
  var center = (n - 1) / 2;

  for (var i = 0; i < n; i++) {
    var dist = Math.abs(i - center) / center;   // 0 centre .. 1 edges
    var shape = 1 - dist * 0.5;
    // Slowly drifting per-bar noise (not re-rolled every frame) keeps motion organic
    _vuNoise[i] += ((0.55 + Math.random() * 0.55) - _vuNoise[i]) * 0.1;
    var target = playing ? _vuAmp * shape * _vuNoise[i] : 0;
    if (target > 1) target = 1;
    // Ballistics: snappy attack to match the waveform, slow analog release
    if (target > _vuBars[i]) _vuBars[i] += (target - _vuBars[i]) * 0.7;
    else _vuBars[i] += (target - _vuBars[i]) * 0.12;
    if (_vuBars[i] < 0.002) _vuBars[i] = 0;

    var barH = Math.max(2 * dpr, _vuBars[i] * H);
    var x = i * (barW + gap);
    var grad = ctx.createLinearGradient(0, H, 0, H - barH);
    grad.addColorStop(0, VU_ACCENT);
    grad.addColorStop(1, VU_ACCENT2);
    ctx.fillStyle = grad;
    ctx.fillRect(x, H - barH, barW, barH);
  }
}

// Seek ±delta seconds when the waveform bar is focused; returns true if handled
function _seekIfWave(delta) {
  if (!_currentFocusEl) return false;
  var id = _currentFocusEl.id;
  if (id !== 'pb-wave' && id !== 'ov-wave') return false;
  if (!_audio.duration || isNaN(_audio.duration)) return false;
  var track = S.queue[S.queueIdx] || {};
  var t = _audio.currentTime + delta;
  if (track.cueOffset != null) {
    // Clamp seeking within the CUE segment
    var segStart = track.cueOffset;
    var segEnd = track.cueEndOffset != null ? track.cueEndOffset : _audio.duration;
    if (t < segStart) t = segStart;
    if (t > segEnd) t = segEnd;
  } else {
    if (t < 0) t = 0;
    if (t > _audio.duration) t = _audio.duration;
  }
  _audio.currentTime = t;
  _drawWaveforms();
  return true;
}

/* ─────────────────────────────────────────────────────────────────────────────
   MILKDROP-STYLE VISUALIZER (Canvas 2D feedback — 100% Tizen-safe, no Web Audio)
   Manual only: launched from the Now Playing overlay. Any key exits.
   ────────────────────────────────────────────────────────────────────────── */
var _vizRaf = null;
var _vizA = null, _vizAc = null;   // accumulator (feedback) buffer
var _vizB = null, _vizBc = null;   // ping-pong buffer
var _vizW = 0, _vizH = 0;
var _vizHue = 0;
var _vizPhase = 0;
var _vizBeat = 0;
var _vizAmpS = 0;

function _vizActive() {
  return !el('viz-overlay').classList.contains('hidden');
}

function _noteActivity() { /* no-op: retained for media-key callbacks */ }

function startViz() {
  if (_vizActive()) return;
  var track = S.queue[S.queueIdx];
  el('viz-title').textContent  = track ? (track.title || '') : '';
  el('viz-artist').textContent = track ? (track.artist || '') : '';
  el('viz-overlay').classList.remove('hidden');

  var canvas = el('viz-canvas');
  // Render at half resolution for TV performance, upscaled by CSS
  _vizW = 960; _vizH = 540;
  canvas.width = _vizW; canvas.height = _vizH;
  if (!_vizA) {
    _vizA = document.createElement('canvas'); _vizAc = _vizA.getContext('2d');
    _vizB = document.createElement('canvas'); _vizBc = _vizB.getContext('2d');
  }
  _vizA.width = _vizW; _vizA.height = _vizH;
  _vizB.width = _vizW; _vizB.height = _vizH;
  _vizAc.fillStyle = '#000'; _vizAc.fillRect(0, 0, _vizW, _vizH);
  _vizBc.fillStyle = '#000'; _vizBc.fillRect(0, 0, _vizW, _vizH);

  if (_vizRaf) cancelAnimationFrame(_vizRaf);
  var loop = function() {
    _vizRaf = requestAnimationFrame(loop);
    _drawViz(canvas);
  };
  _vizRaf = requestAnimationFrame(loop);
}

function stopViz() {
  if (!_vizActive()) return;
  el('viz-overlay').classList.add('hidden');
  if (_vizRaf) { cancelAnimationFrame(_vizRaf); _vizRaf = null; }
  _noteActivity();
}

function _drawViz(displayCanvas) {
  var W = _vizW, H = _vizH;
  var cx = W / 2, cy = H / 2;

  // Current amplitude from the waveform envelope at the playback position
  var amp = 0;
  if (S.waveform && S.waveform.length && _audio.duration && !isNaN(_audio.duration)) {
    var idx = Math.floor((_audio.currentTime / _audio.duration) * S.waveform.length);
    if (idx < 0) idx = 0;
    if (idx >= S.waveform.length) idx = S.waveform.length - 1;
    amp = S.waveform[idx] / 255;
  }
  // Beat detection: rising amplitude edge
  var prevAmp = _vizAmpS;
  _vizAmpS += (amp - _vizAmpS) * (amp > _vizAmpS ? 0.5 : 0.1);
  var rise = _vizAmpS - prevAmp;
  if (rise > 0.03) _vizBeat = Math.min(1, _vizBeat + rise * 4);
  _vizBeat *= 0.92;

  _vizPhase += 0.012 + _vizAmpS * 0.03;
  _vizHue = (_vizHue + 0.6 + _vizBeat * 3) % 360;

  // ── Feedback warp: draw previous frame (B) into accumulator (A), zoomed+rotated
  var ac = _vizAc;
  var zoom = 1.012 + _vizBeat * 0.05 + _vizAmpS * 0.02;
  var rot = 0.004 + Math.sin(_vizPhase * 0.5) * 0.006;
  ac.save();
  ac.globalAlpha = 1;
  ac.translate(cx, cy);
  ac.rotate(rot);
  ac.scale(zoom, zoom);
  ac.translate(-cx, -cy);
  ac.drawImage(_vizB, 0, 0);
  ac.restore();
  // Fade slightly toward black so trails don't saturate
  ac.fillStyle = 'rgba(0,0,0,0.10)';
  ac.fillRect(0, 0, W, H);

  // ── New bright layer: radial oscilloscope curves driven by the waveform
  var wave = S.waveform || [];
  var n = wave.length || 64;
  var baseR = 60 + _vizAmpS * 90 + _vizBeat * 60;
  ac.lineWidth = 2 + _vizBeat * 3;
  ac.globalCompositeOperation = 'lighter';

  for (var layer = 0; layer < 3; layer++) {
    var hue = (_vizHue + layer * 60) % 360;
    ac.strokeStyle = 'hsl(' + hue.toFixed(0) + ',90%,' + (55 + layer * 8) + '%)';
    ac.beginPath();
    var lobes = 3 + layer;
    var spin = _vizPhase * (layer % 2 === 0 ? 1 : -1) + layer;
    var steps = 96;
    for (var s = 0; s <= steps; s++) {
      var a = (s / steps) * Math.PI * 2;
      var wi = Math.floor((s / steps) * (n - 1));
      var wv = (wave.length ? wave[wi] / 255 : 0.4);
      var r = baseR + Math.sin(a * lobes + spin) * (40 + wv * 120) * (0.6 + _vizAmpS);
      var px = cx + Math.cos(a) * r * 1.6;
      var py = cy + Math.sin(a) * r;
      if (s === 0) ac.moveTo(px, py); else ac.lineTo(px, py);
    }
    ac.closePath();
    ac.stroke();
  }

  // Central pulse
  var pr = 8 + _vizBeat * 60 + _vizAmpS * 30;
  var grd = ac.createRadialGradient(cx, cy, 0, cx, cy, pr);
  grd.addColorStop(0, 'hsla(' + _vizHue.toFixed(0) + ',95%,70%,0.9)');
  grd.addColorStop(1, 'hsla(' + _vizHue.toFixed(0) + ',95%,50%,0)');
  ac.fillStyle = grd;
  ac.beginPath();
  ac.arc(cx, cy, pr, 0, Math.PI * 2);
  ac.fill();
  ac.globalCompositeOperation = 'source-over';

  // Blit accumulator → visible canvas, then ping-pong (A becomes next B)
  var dctx = displayCanvas.getContext('2d');
  dctx.drawImage(_vizA, 0, 0);
  var tmpCanvas = _vizB, tmpCtx = _vizBc;
  _vizB = _vizA; _vizBc = _vizAc;
  _vizA = tmpCanvas; _vizAc = tmpCtx;
}

function togglePlay() {
  if (S.playing) {
    pauseAudio();
  } else {
    _audio.play().then(function() {
      S.playing = true;
      _updatePlayBtn();
      _screenWake(true);
    }).catch(function() {});
  }
}

function pauseAudio() {
  _audio.pause();
  S.playing = false;
  _updatePlayBtn();
  _screenWake(false);
}

function skipNext() {
  if (S.queueIdx < S.queue.length - 1) {
    S.queueIdx++;
    _loadAndPlay(S.queue[S.queueIdx]);
  } else if (S.autoDj) {
    _autoDjPick();
  }
}

function skipPrev() {
  if (_audio.currentTime > 4) {
    _audio.currentTime = 0;
    return;
  }
  if (S.queueIdx > 0) {
    S.queueIdx--;
    _loadAndPlay(S.queue[S.queueIdx]);
  }
}

function _updatePlayBtn() {
  var icon = S.playing ? '&#9646;&#9646;' : '&#9654;';
  el('pb-play').innerHTML  = icon;
  el('ov-play').innerHTML  = icon;
}

/* ─────────────────────────────────────────────────────────────────────────────
   PLAYER BAR
   ────────────────────────────────────────────────────────────────────────── */
function initPlayerBar() {
  el('pb-prev').addEventListener('click', skipPrev);
  el('pb-play').addEventListener('click', togglePlay);
  el('pb-next').addEventListener('click', skipNext);
  if (el('pb-info'))    el('pb-info').addEventListener('click', openOverlay);
  if (el('pb-art-wrap')) el('pb-art-wrap').addEventListener('click', openOverlay);

  el('ov-prev').addEventListener('click', skipPrev);
  el('ov-play').addEventListener('click', togglePlay);
  el('ov-next').addEventListener('click', skipNext);
  if (el('ov-viz')) el('ov-viz').addEventListener('click', startViz);
  el('overlay-close').addEventListener('click', closeOverlay);
}

function _updatePlayerBar(track) {
  el('pb-title').textContent  = track.title || '';
  el('pb-artist').textContent = track.artist || '';
  el('overlay-title').textContent  = track.title || '';
  el('overlay-artist').textContent = track.artist || '';
  el('overlay-album').textContent  = track.album || '';

  var artSrc = track.artFile ? artUrl(track.artFile, 'm') : '';
  el('pb-art').src      = artSrc || '';
  el('overlay-art').src = artSrc || '';

  // Auto-DJ badge
  if (S.autoDj) show('ov-autodj-badge');
  else hide('ov-autodj-badge');
}

function showPlayerBar() {
  el('player-bar').classList.remove('hidden');
  // Shrink content area
  el('content-area').style.paddingBottom = '110px';
}

function hidePlayerBar() {
  el('player-bar').classList.add('hidden');
  el('content-area').style.paddingBottom = '0';
}

/* ─────────────────────────────────────────────────────────────────────────────
   FULL-SCREEN PLAYER OVERLAY
   ────────────────────────────────────────────────────────────────────────── */
function openOverlay() {
  el('player-overlay').classList.remove('hidden');
  _startVU();
  setTimeout(function() { _drawWaveforms(); setFocus(el('ov-play')); }, 50);
}

function closeOverlay() {
  el('player-overlay').classList.add('hidden');
  _stopVU();
  setTimeout(function() {
    if (_currentFocusEl) setFocus(_currentFocusEl);
    else focusFirst(el('nav-bar'));
  }, 50);
}

/* ─────────────────────────────────────────────────────────────────────────────
   HOME TILES
   ────────────────────────────────────────────────────────────────────────── */
(function initHomeTiles() {
  var tiles = document.querySelectorAll('.home-tile');
  for (var i = 0; i < tiles.length; i++) {
    (function(tile) {
      tile.addEventListener('click', function() {
        navigateTo(tile.getAttribute('data-screen'));
      });
    })(tiles[i]);
  }
})();

/* ─────────────────────────────────────────────────────────────────────────────
   ESCAPING
   ────────────────────────────────────────────────────────────────────────── */
function _esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _escAttr(str) {
  return _esc(str);
}

/* ─────────────────────────────────────────────────────────────────────────────
   TIZEN PLATFORM INTEGRATION (all feature-detected — safe on non-Tizen too)
   ────────────────────────────────────────────────────────────────────────── */
var _screenLockOn = false;

// Keep the TV screen awake while audio plays / visualizer runs
function _screenWake(on) {
  try {
    if (!window.tizen || !tizen.power) return;
    if (on && !_screenLockOn) {
      tizen.power.request('SCREEN', 'SCREEN_NORMAL');
      _screenLockOn = true;
    } else if (!on && _screenLockOn) {
      tizen.power.release('SCREEN');
      _screenLockOn = false;
    }
  } catch (ex) { /* power privilege unavailable — ignore */ }
}

// Register the remote's dedicated media keys via the Media Key API
function _initMediaKeys() {
  try {
    if (!window.tizen || !tizen.mediakey) return;
    tizen.mediakey.setMediaKeyEventListener({
      onpressed: function(key) {
        if (key === 'MEDIA_PLAY_PAUSE' || key === 'MEDIA_PLAY' || key === 'MEDIA_PAUSE') {
          _noteActivity(); togglePlay();
        } else if (key === 'MEDIA_NEXT' || key === 'MEDIA_FAST_FORWARD') {
          _noteActivity(); skipNext();
        } else if (key === 'MEDIA_PREVIOUS' || key === 'MEDIA_REWIND') {
          _noteActivity(); skipPrev();
        } else if (key === 'MEDIA_STOP') {
          _noteActivity(); pauseAudio();
        }
      },
      onreleased: function() { /* no-op: press handles actions */ }
    });
  } catch (ex) { /* mediakey privilege unavailable — ignore */ }
}

// Register the extra TV remote colour/arrow keys so keydown receives them
function _initTvKeys() {
  try {
    if (!window.tizen || !tizen.tvinputdevice) return;
    var keys = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
                'MediaFastForward', 'MediaRewind', 'MediaTrackNext', 'MediaTrackPrevious'];
    for (var i = 0; i < keys.length; i++) {
      try { tizen.tvinputdevice.registerKey(keys[i]); } catch (e) { /* key not supported */ }
    }
  } catch (ex) { /* tvinputdevice unavailable — ignore */ }
}

function _initTizen() {
  _initMediaKeys();
  _initTvKeys();
  // Clean shutdown on app exit
  try {
    if (window.tizen && tizen.application) {
      document.addEventListener('visibilitychange', function() {
        if (document.hidden) _screenWake(false);
        else if (S.playing) _screenWake(true);
      });
    }
  } catch (ex) { /* ignore */ }
}

/* ─────────────────────────────────────────────────────────────────────────────
   BOOT
   ────────────────────────────────────────────────────────────────────────── */
window.addEventListener('load', function() {
  _initTizen();
  initLogin();
});
