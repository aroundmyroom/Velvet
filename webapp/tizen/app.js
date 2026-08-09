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

function artUrl(artFile, size) {
  if (!artFile) return '';
  return S.baseUrl + '/api/v1/files/art?fp=' + encodeURIComponent(artFile) + '&size=' + (size || 'm');
}

function albumArtUrl(artFile) {
  if (!artFile) return '';
  if (artFile.indexOf('http') === 0) return artFile;
  return S.baseUrl + '/api/v1/albums/art-file?p=' + encodeURIComponent(artFile);
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

  // Allow normal typing in text fields
  var tag = document.activeElement && document.activeElement.tagName;
  var isInput = (tag === 'INPUT' || tag === 'TEXTAREA');
  if (isInput && key !== KEY.BACK && key !== 27) return;

  // Overlay active
  if (!el('player-overlay').classList.contains('hidden')) {
    if (key === KEY.LEFT)  { _moveFocus('left'); e.preventDefault(); return; }
    if (key === KEY.RIGHT) { _moveFocus('right'); e.preventDefault(); return; }
    if (key === KEY.UP)    { _moveFocus('up'); e.preventDefault(); return; }
    if (key === KEY.DOWN)  { _moveFocus('down'); e.preventDefault(); return; }
    if (key === KEY.ENTER) { _activateFocused(e); return; }
    if (key === KEY.BACK || key === 27) { closeOverlay(); return; }
    if (key === KEY.PLAY)  { togglePlay(); return; }
    if (key === KEY.PAUSE) { togglePlay(); return; }
    return;
  }

  // Login screen
  if (!el('screen-login').classList.contains('hidden')) {
    if (key === KEY.UP)    { _moveFocus('up'); e.preventDefault(); return; }
    if (key === KEY.DOWN)  { _moveFocus('down'); e.preventDefault(); return; }
    if (key === KEY.ENTER && !isInput) { _activateFocused(e); return; }
    return;
  }

  // Main screen
  if (key === KEY.LEFT)  { _moveFocus('left'); e.preventDefault(); }
  else if (key === KEY.RIGHT) { _moveFocus('right'); e.preventDefault(); }
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
    var artSrc = a.artFile ? albumArtUrl(a.artFile) : '';
    html += '<div class="album-card focusable" tabindex="0" data-id="' + _escAttr(a.id) + '">' +
      (artSrc
        ? '<img class="album-card-art" src="' + _escAttr(artSrc) + '" alt="" loading="lazy" onerror="this.parentNode.innerHTML=\'<div class=album-card-art-placeholder>&#127925;</div>\'+ this.parentNode.innerHTML.replace(/<img[^>]*>/,\'\');">'
        : '<div class="album-card-art-placeholder">&#127925;</div>') +
      '<div class="album-card-info">' +
        '<div class="album-card-title">' + _esc(a.name) + '</div>' +
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
  var artSrc = album.artFile ? albumArtUrl(album.artFile) : '';
  var artEl = el('album-detail-art');
  if (artSrc) { artEl.src = artSrc; artEl.style.display = ''; }
  else { artEl.style.display = 'none'; }

  el('album-detail-title').textContent  = album.name || '';
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
        artist:   album.artist || '',
        album:    album.name || '',
        artFile:  album.artFile || null
      };
    });
    playQueue(queue, 0);
    showView('albums');
  };

  // Track list
  var html = '';
  for (var i = 0; i < tracks.length; i++) {
    var tr = tracks[i];
    html += '<div class="track-row focusable" tabindex="0" data-idx="' + i + '">' +
      '<div class="track-num">' + _esc(tr.track ? String(tr.track) : String(i + 1)) + '</div>' +
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
            artist:   albumRef.artist || '',
            album:    albumRef.name || '',
            artFile:  albumRef.artFile || null
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
    S.artistCache = data.artists || [];
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
    html += '<div class="artist-row focusable" tabindex="0" data-key="' + _escAttr(a.key || a.name) + '" data-name="' + _escAttr(a.name) + '">' +
      (imgSrc ? '<img class="artist-img" src="' + _escAttr(imgSrc) + '" alt="" loading="lazy">' : '<div class="artist-img" style="background:var(--bg3)"></div>') +
      '<div class="artist-name">' + _esc(a.name) + '</div>' +
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
    // Show albums in album grid
    var albums = (data.albums || []);
    var grid = el('artist-albums');
    var html = '';
    for (var i = 0; i < albums.length; i++) {
      var a = albums[i];
      var artSrc = a.artFile ? albumArtUrl(a.artFile) : '';
      html += '<div class="album-card focusable" tabindex="0" data-id="' + _escAttr(a.id) + '">' +
        (artSrc ? '<img class="album-card-art" src="' + _escAttr(artSrc) + '" alt="" loading="lazy">' : '<div class="album-card-art-placeholder">&#127925;</div>') +
        '<div class="album-card-info">' +
          '<div class="album-card-title">' + _esc(a.name) + '</div>' +
          '<div class="album-card-artist">' + _esc(a.year ? String(a.year) : '') + '</div>' +
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
    hideLoading();
    el('playlist-detail-title').textContent = name;

    var tracks = data.songs || [];
    var html = '';
    for (var i = 0; i < tracks.length; i++) {
      var tr = tracks[i];
      var title  = (tr.metadata && tr.metadata.title) ? tr.metadata.title : tr.filepath.split('/').pop();
      var artist = (tr.metadata && tr.metadata.artist) ? tr.metadata.artist : '';
      html += '<div class="track-row focusable" tabindex="0" data-idx="' + i + '">' +
        '<div class="track-num">' + (i + 1) + '</div>' +
        '<div class="track-title">' + _esc(title) + (artist ? '<br><span style="font-size:22px;color:var(--text2)">' + _esc(artist) + '</span>' : '') + '</div>' +
      '</div>';
    }
    el('playlist-track-list').innerHTML = html || '<div style="color:var(--text2);padding:20px">Empty playlist.</div>';

    var allTracks = tracks;
    var rows = el('playlist-track-list').querySelectorAll('.track-row');
    for (var j = 0; j < rows.length; j++) {
      (function(row, idx) {
        row.addEventListener('click', function() {
          var queue = allTracks.map(function(t) {
            return {
              filepath: t.filepath,
              title:   (t.metadata && t.metadata.title) ? t.metadata.title : t.filepath.split('/').pop(),
              artist:  (t.metadata && t.metadata.artist) ? t.metadata.artist : '',
              album:   (t.metadata && t.metadata.album) ? t.metadata.album : '',
              artFile: (t.metadata && t.metadata['album-art']) ? t.metadata['album-art'] : null
            };
          });
          playQueue(queue, idx);
        });
      })(rows[j], j);
    }

    showView('playlist-detail');
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
    S.autoDjIgnoreList = data.ignoreList || [];
    var track = {
      filepath: s.filepath,
      title:    s.title || s.filepath.split('/').pop(),
      artist:   s.artist || '',
      album:    s.album  || '',
      artFile:  s['album-art'] || null
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
  return S.baseUrl + '/media/' + filepath.split('/').slice(1).join('/');
}

function _loadAndPlay(track) {
  _audio.src = _trackUrl(track.filepath);
  _audio.load();
  _audio.play().then(function() {
    S.playing = true;
    _updatePlayerBar(track);
    _updatePlayBtn();
    showPlayerBar();
    // Preload next in Auto-DJ
    if (S.autoDj) _autoDjPick();
  }).catch(function(err) {
    // Autoplay may be blocked on first interaction; that's OK
    S.playing = false;
    _updatePlayBtn();
  });
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
  var pct = (cur / dur * 100).toFixed(1) + '%';
  el('pb-fill').style.width  = pct;
  el('ov-fill').style.width  = pct;
  el('pb-pos').textContent   = fmtTime(cur);
  el('ov-pos').textContent   = fmtTime(cur);
  el('pb-dur').textContent   = fmtTime(dur);
  el('ov-dur').textContent   = fmtTime(dur);
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
  // Click anywhere on the bar area (except buttons) opens overlay
  el('pb-info').addEventListener('click', openOverlay);
  el('pb-art-wrap').addEventListener('click', openOverlay);

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
  if (artSrc) {
    el('pb-art').src      = artSrc;
    el('overlay-art').src = artSrc;
  } else {
    el('pb-art').src      = '';
    el('overlay-art').src = '';
  }

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
  setTimeout(function() { setFocus(el('ov-play')); }, 50);
}

function closeOverlay() {
  el('player-overlay').classList.add('hidden');
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
