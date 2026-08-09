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

function _moveFocus(dir) {
  var cur = _currentFocusEl;
  if (!cur) {
    focusFirst();
    return;
  }

  // Gather all visible focusable elements
  var all = _allFocusable().filter(function(e) {
    return e.offsetParent !== null;  // visible
  });

  if (!all.length) return;

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

  if (best) setFocus(best);
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
function initLogin() {
  _loadSettings();
  // Pre-fill URL from build-time config if nothing stored yet
  if (!S.baseUrl) {
    var meta = document.querySelector('meta[name="velvet-server-url"]');
    if (meta && meta.content && meta.content !== '__VELVET_SERVER_URL__') {
      S.baseUrl = meta.content;
    }
  }
  if (S.baseUrl)  el('login-url').value  = S.baseUrl;
  if (S.username) el('login-user').value = S.username;

  el('login-btn').addEventListener('click', doLogin);
  el('login-pass').addEventListener('keydown', function(e) {
    if (e.keyCode === 13) doLogin();
  });

  // If we have a stored token, try it silently
  if (S.token && S.baseUrl) {
    _tryAutoLogin();
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
    return;
  }

  var html = '';
  for (var i = 0; i < albums.length; i++) {
    var a = albums[i];
    var artSrc = albumArtUrl(a.aaFile, a.artFile);
    html += '<div class="album-card focusable" tabindex="0" data-id="' + _escAttr(a.id) + '">' +
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

  // Restore focus to first card
  setTimeout(function() {
    var items = _allFocusable(grid);
    if (items.length) setFocus(items[0]);
  }, 50);
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

function _renderAlbumDetail(album) {
  var artSrc = albumArtUrl(album.aaFile, album.artFile);
  var artEl = el('album-detail-art');
  if (artSrc) { artEl.src = artSrc; artEl.style.display = ''; }
  else { artEl.style.display = 'none'; }

  el('album-detail-title').textContent  = album.displayName || album.name || '';
  el('album-detail-artist').textContent = album.artist || '';
  el('album-detail-year').textContent   = album.year ? String(album.year) : '';

  // Build flat track list from discs
  var tracks = [];
  var discs = album.discs || [];
  for (var d = 0; d < discs.length; d++) {
    var disc = discs[d];
    var discTracks = disc.tracks || [];
    for (var t = 0; t < discTracks.length; t++) {
      tracks.push(discTracks[t]);
    }
  }

  // Play all
  el('album-play-all').onclick = function() {
    var queue = tracks.map(function(tr) {
      return {
        filepath: tr.filepath,
        title:    tr.title || tr.filepath.split('/').pop(),
        artist:   tr.artist || album.artist || '',
        album:    album.displayName || album.name || '',
        artFile:  tr.aaFile || album.aaFile || null
      };
    });
    playQueue(queue, 0);
    // Stay on album-detail so user can see the track list
  };

  // Track list
  var html = '';
  for (var i = 0; i < tracks.length; i++) {
    var tr = tracks[i];
    html += '<div class="track-row focusable" tabindex="0" data-idx="' + i + '">' +
      '<div class="track-num">' + _esc(tr.number ? String(tr.number) : String(i + 1)) + '</div>' +
      '<div class="track-title">' + _esc(tr.title || tr.filepath.split('/').pop()) + '</div>' +
      '<div class="track-dur">' + fmtTime(tr.duration) + '</div>' +
    '</div>';
  }
  el('album-track-list').innerHTML = html;

  var rows = el('album-track-list').querySelectorAll('.track-row');
  var albumTracks = tracks;
  var albumRef = album;
  for (var k = 0; k < rows.length; k++) {
    (function(row, idx) {
      row.addEventListener('click', function() {
        var queue = albumTracks.map(function(tr) {
          return {
            filepath: tr.filepath,
            title:    tr.title || tr.filepath.split('/').pop(),
            artist:   tr.artist || albumRef.artist || '',
            album:    albumRef.displayName || albumRef.name || '',
            artFile:  tr.aaFile || albumRef.aaFile || null
          };
        });
        playQueue(queue, idx);
      });
    })(rows[k], k);
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
  _audio.src = _trackUrl(track.filepath);
  _audio.load();
  var playResult = _audio.play();
  if (playResult && typeof playResult.then === 'function') {
    playResult.then(function() {
      S.playing = true;
      _updatePlayBtn();
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
    if (S.autoDj) _autoDjPick();
  }
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
  var dur = _audio.duration;
  var cur = _audio.currentTime;
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
var VU_BAR_COUNT = 40;

function _startVU() {
  if (_vuRaf) return;
  if (!_vuBars.length) { for (var i = 0; i < VU_BAR_COUNT; i++) _vuBars.push(0); }
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

  var n = VU_BAR_COUNT;
  var gap = 4 * dpr;
  var barW = (W - gap * (n - 1)) / n;
  var center = (n - 1) / 2;

  for (var i = 0; i < n; i++) {
    var dist = Math.abs(i - center) / center;   // 0 centre .. 1 edges
    var shape = 1 - dist * 0.5;
    var target = playing ? amp * shape * (0.55 + Math.random() * 0.75) : 0;
    if (target > 1) target = 1;
    // ballistics: instant attack, exponential release
    if (target > _vuBars[i]) _vuBars[i] = target;
    else _vuBars[i] = _vuBars[i] * 0.86 + target * 0.14;
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
  var t = _audio.currentTime + delta;
  if (t < 0) t = 0;
  if (t > _audio.duration) t = _audio.duration;
  _audio.currentTime = t;
  _drawWaveforms();
  return true;
}

function togglePlay() {
  if (S.playing) {
    pauseAudio();
  } else {
    _audio.play().then(function() {
      S.playing = true;
      _updatePlayBtn();
    }).catch(function() {});
  }
}

function pauseAudio() {
  _audio.pause();
  S.playing = false;
  _updatePlayBtn();
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
   BOOT
   ────────────────────────────────────────────────────────────────────────── */
window.addEventListener('load', function() {
  initLogin();
});
