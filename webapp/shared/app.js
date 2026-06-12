'use strict';
const sharedPlaylist = (function () { try { return JSON.parse(document.getElementById('sh-data')?.textContent || 'null'); } catch (e) { return null; } })();

/* ── Theme ──────────────────────────────────────────────────── */
function applyTheme(t) {
  document.documentElement.classList.toggle('light', t === 'light');
  localStorage.setItem('ms2_theme', t);
}
applyTheme(localStorage.getItem('ms2_theme') || 'dark');
document.getElementById('sh-theme-btn').addEventListener('click', function () {
  applyTheme(document.documentElement.classList.contains('light') ? 'dark' : 'light');
});

/* ── State ──────────────────────────────────────────────────── */
const audio = document.getElementById('audio');
const S = {
  queue:   [],   // [{ path, meta }]  meta = null until loaded
  idx:     -1,
  playing: false,
  muted:   false,
  shuffle: false,
  repeat:  false,
  vol:     0.8,
};

/* ── Helpers ────────────────────────────────────────────────── */
const _token = (typeof sharedPlaylist !== 'undefined') ? sharedPlaylist.token : '';

function _encPath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}
function _normFp(p) {
  return String(p || '').replace(/^\/+/, '');
}
function mediaUrl(path) {
  return '../media/' + _encPath(_normFp(path)) + '?token=' + encodeURIComponent(_token);
}
function artUrl(aaFile, size) {
  if (!aaFile) return '';
  return '/album-art/' + encodeURIComponent(aaFile) + '?compress=' + encodeURIComponent(size || 'l') + '&token=' + encodeURIComponent(_token);
}
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function noArtHtml(sm) {
  return '<div class="no-art' + (sm ? ' no-art-sm' : '') + '">' +
    '<div class="no-art-wave">' +
    '<span></span><span></span><span></span><span></span><span></span>' +
    '</div></div>';
}

/* ── Toast ──────────────────────────────────────────────────── */
let _toastTmr = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(_toastTmr);
  _toastTmr = setTimeout(function () { el.classList.add('hidden'); }, 3200);
}

/* ── Playlist rendering ─────────────────────────────────────── */
function renderPlaylist() {
  const list = document.getElementById('sh-pl-list');
  list.innerHTML = '';
  S.queue.forEach(function (song, i) {
    list.appendChild(_makeRow(song, i));
  });
  _updatePlCount();
}

function _makeRow(song, i) {
  const meta  = song.meta;
  const title = (meta && meta.title)  ? meta.title  : song.path.split('/').pop();
  const sub   = _rowSub(meta);

  const row = document.createElement('div');
  row.className = 'sh-row' + (i === S.idx ? ' playing' : '');
  row.dataset.idx = i;

  row.innerHTML =
    '<div class="row-num">' +
      '<span class="num-val">' + (i + 1) + '</span>' +
      '<span class="row-play-icon">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">' +
          '<path d="M6 4l14 8-14 8V4z"/>' +
        '</svg>' +
      '</span>' +
    '</div>' +
    '<div class="row-art">' +
      (meta && meta['album-art']
        ? '<img src="' + artUrl(meta['album-art'], 's') + '" alt="" loading="lazy"' +
            ' onerror="this.onerror=null;this.parentNode.innerHTML=noArtHtml(true)">'
        : noArtHtml(true)) +
    '</div>' +
    '<div class="song-info">' +
      '<div class="song-title">' + esc(title) + '</div>' +
      (sub ? '<div class="song-sub">' + esc(sub) + '</div>' : '') +
    '</div>' +
    '<a href="' + esc(mediaUrl(song.path)) + '" download="' + esc(title) + '"' +
      ' class="sh-row-dl" title="Download" onclick="event.stopPropagation()">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
        ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
        '<polyline points="7,10 12,15 17,10"/>' +
        '<line x1="12" y1="15" x2="12" y2="3"/>' +
      '</svg>' +
    '</a>';

  row.addEventListener('click', function () { playAt(i); });
  return row;
}

function _rowSub(meta) {
  if (!meta) return '';
  return [meta.artist || '', meta.album || ''].filter(Boolean).join(' · ');
}

function _updatePlCount() {
  const n = S.queue.length;
  document.getElementById('sh-pl-count').textContent = n + ' song' + (n !== 1 ? 's' : '');
}

function refreshRow(i) {
  const list = document.getElementById('sh-pl-list');
  const old  = list.children[i];
  if (!old) return;
  list.replaceChild(_makeRow(S.queue[i], i), old);
}

function _highlightRows() {
  const rows = document.getElementById('sh-pl-list').children;
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle('playing', i === S.idx);
  }
}

/* ── Now-playing display ────────────────────────────────────── */
function updateNowPlaying() {
  const song   = S.idx >= 0 ? S.queue[S.idx] : null;
  const meta   = song ? song.meta : null;
  const title  = (meta && meta.title)  ? meta.title  : (song ? song.path.split('/').pop() : '—');
  const artist = (meta && meta.artist) ? meta.artist : '';
  const album  = (meta && meta.album)  ? meta.album  : '';
  const year   = (meta && meta.year)   ? String(meta.year) : '';

  document.getElementById('sh-title').textContent  = title;
  document.getElementById('sh-artist').textContent = artist;
  document.getElementById('sh-album').textContent  = album;
  document.getElementById('sh-year').textContent   = year;
  document.getElementById('sh-count').textContent  =
    S.idx >= 0 ? 'Track ' + (S.idx + 1) + ' of ' + S.queue.length : '';
  document.title = title + (artist ? ' · ' + artist : '') + ' — Velvet';

  const artWrap = document.getElementById('sh-art-wrap');
  if (song && meta && meta['album-art']) {
    artWrap.innerHTML = noArtHtml(false);   // placeholder while loading
    const img  = new Image();
    const snap = song;
    const art  = meta['album-art'];
    img.onload = function () {
      if (S.idx >= 0 && S.queue[S.idx] === snap) {
        artWrap.innerHTML = '<img src="' + artUrl(art, 'l') + '" alt="">';
      }
    };
    img.src = artUrl(art, 'l');
  } else {
    artWrap.innerHTML = noArtHtml(false);
  }
}

/* ── Playback ────────────────────────────────────────────────── */
function playAt(idx) {
  if (idx < 0 || idx >= S.queue.length) return;
  S.idx      = idx;
  audio.src  = mediaUrl(S.queue[idx].path);
  audio.loop = S.repeat;
  audio.volume = S.muted ? 0 : S.vol;
  audio.play().catch(function () {});
  S.playing = true;
  _syncPlayIcon();
  updateNowPlaying();
  _highlightRows();
}

function _pickNext() {
  const n = S.queue.length;
  if (n === 0) return -1;
  if (S.shuffle) {
    if (n === 1) return 0;
    let r;
    do { r = Math.floor(Math.random() * n); } while (r === S.idx);
    return r;
  }
  const next = S.idx + 1;
  return next < n ? next : -1;
}

function _pickPrev() {
  const n = S.queue.length;
  if (n === 0) return -1;
  if (S.shuffle) {
    if (n === 1) return 0;
    let r;
    do { r = Math.floor(Math.random() * n); } while (r === S.idx);
    return r;
  }
  return Math.max(0, S.idx - 1);
}

function _syncPlayIcon() {
  document.getElementById('sh-icon-play').classList.toggle('hidden',  S.playing);
  document.getElementById('sh-icon-pause').classList.toggle('hidden', !S.playing);
}

/* ── Audio events ────────────────────────────────────────────── */
audio.addEventListener('play',  function () { S.playing = true;  _syncPlayIcon(); });
audio.addEventListener('pause', function () { S.playing = false; _syncPlayIcon(); });

audio.addEventListener('ended', function () {
  const next = _pickNext();
  if (next >= 0) {
    playAt(next);
  } else {
    S.playing = false;
    _syncPlayIcon();
  }
});

audio.addEventListener('timeupdate', function () {
  const cur = audio.currentTime;
  const dur = audio.duration;
  document.getElementById('sh-time-cur').textContent   = fmtTime(cur);
  document.getElementById('sh-time-total').textContent = fmtTime(isFinite(dur) ? dur : 0);
  const pct = (isFinite(dur) && dur > 0) ? (cur / dur * 100) : 0;
  document.getElementById('sh-prog-fill').style.width  = pct + '%';
});

/* ── Transport controls ─────────────────────────────────────── */
document.getElementById('sh-play').addEventListener('click', function () {
  if (S.idx < 0 && S.queue.length > 0) { playAt(0); return; }
  audio.paused ? audio.play().catch(function () {}) : audio.pause();
});

document.getElementById('sh-prev').addEventListener('click', function () {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const p = _pickPrev();
  if (p >= 0) playAt(p);
});

document.getElementById('sh-next').addEventListener('click', function () {
  const n = _pickNext();
  if (n >= 0) playAt(n);
});

document.getElementById('sh-shuffle').addEventListener('click', function () {
  S.shuffle = !S.shuffle;
  this.classList.toggle('active', S.shuffle);
});

document.getElementById('sh-repeat').addEventListener('click', function () {
  S.repeat   = !S.repeat;
  audio.loop = S.repeat;
  this.classList.toggle('active', S.repeat);
});

/* ── Progress-bar seek ───────────────────────────────────────── */
(function () {
  const track = document.getElementById('sh-prog-track');
  let dragging = false;

  function seekTo(clientX) {
    const rect  = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    if (isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = ratio * audio.duration;
    }
  }
  track.addEventListener('mousedown', function (e) { dragging = true; seekTo(e.clientX); });
  document.addEventListener('mousemove', function (e) { if (dragging) seekTo(e.clientX); });
  document.addEventListener('mouseup',   function ()  { dragging = false; });
  track.addEventListener('touchstart', function (e) { seekTo(e.touches[0].clientX); }, { passive: true });
  track.addEventListener('touchmove',  function (e) { seekTo(e.touches[0].clientX); }, { passive: true });
}());

/* ── Volume ──────────────────────────────────────────────────── */
(function () {
  const slider = document.getElementById('sh-vol');

  function syncVolIcon() {
    const v = S.muted ? 0 : S.vol;
    document.getElementById('sh-vol-high').classList.toggle('hidden',  v < 0.5);
    document.getElementById('sh-vol-low').classList.toggle('hidden',   v === 0 || v >= 0.5);
    document.getElementById('sh-vol-muted').classList.toggle('hidden', v !== 0);
  }

  slider.addEventListener('input', function () {
    S.vol   = this.value / 100;
    S.muted = (S.vol === 0);
    audio.volume = S.vol;
    syncVolIcon();
  });

  document.getElementById('sh-mute-btn').addEventListener('click', function () {
    S.muted      = !S.muted;
    audio.volume = S.muted ? 0 : S.vol;
    slider.value = S.muted ? 0 : S.vol * 100;
    syncVolIcon();
  });

  syncVolIcon();
}());

/* ── Download All ────────────────────────────────────────────── */
document.getElementById('sh-dl-all').addEventListener('click', function () {
  S.queue.forEach(function (song, i) {
    setTimeout(function () {
      const meta  = song.meta;
      const fname = (meta && meta.title) ? meta.title : song.path.split('/').pop();
      const a     = document.createElement('a');
      a.href     = mediaUrl(song.path);
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }, i * 350);
  });
  showToast('Downloading ' + S.queue.length + ' file' + (S.queue.length !== 1 ? 's' : '') + '…');
});

/* ── Metadata fetch ──────────────────────────────────────────── */
async function fetchMeta(filepath) {
  try {
    const r = await fetch('../api/v1/db/metadata', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ filepath: _normFp(filepath), token: _token }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.metadata || null;   // shape: { title, artist, album, year, … }
  } catch (e) {
    return null;
  }
}

/* ── Boot ────────────────────────────────────────────────────── */
async function boot() {
  if (typeof sharedPlaylist === 'undefined' || !sharedPlaylist || !Array.isArray(sharedPlaylist.playlist)) {
    document.getElementById('sh-main').innerHTML =
      '<div class="sh-error">' +
        '<strong>Playlist not found</strong>' +
        'This shared link may have expired or is invalid.' +
      '</div>';
    return;
  }

  sharedPlaylist.playlist.forEach(function (path) {
    S.queue.push({ path: path, meta: null });
  });

  renderPlaylist();

  if (S.queue.length > 0) {
    // Load the first track into the player without autoplaying.
    // Autoplay is blocked by browsers on page load anyway, and eagerly
    // setting S.playing = true would show the pause icon before any audio plays.
    S.idx = 0;
    audio.src    = mediaUrl(S.queue[0].path);
    audio.volume = S.vol;
    updateNowPlaying();
    _highlightRows();
  } else {
    document.getElementById('sh-count').textContent = 'Empty playlist';
  }

  // Load metadata in the background, refreshing each row as it arrives
  for (let i = 0; i < S.queue.length; i++) {
    const meta = await fetchMeta(S.queue[i].path);
    if (meta) {
      S.queue[i].meta = meta;
      refreshRow(i);
      if (i === S.idx) updateNowPlaying();
    }
  }
}

boot();
