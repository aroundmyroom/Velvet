'use strict';
// ── State ──────────────────────────────────────────────────────────────────
var _token      = '';
var _pollTimer  = null;
var _volTimer   = null;
var _toastTimer = null;
var _lastStatus = null;
var _pathStack  = [];
var _tab        = 'queue';

var _djOn       = false;
var _djMode     = 'random';  // 'random' | 'similar'
var _djFetching = false;

var _searchTimer   = null;
var _searchResults = [];
var _metaCache     = {};   // filepath -> tech string from DB

// ── Output routing state ─────────────────────────────────────────────────
var _output        = localStorage.getItem('sr_output') || 'mpv'; // 'mpv'|'sonos'|'web'
var _sonosRoom     = JSON.parse(localStorage.getItem('sr_sonos_room') || 'null');
var _sonosRooms    = [];
var _sonosSt       = { playing:false, paused:false, stopped:true, position:0, duration:0 };
var _sonosPrevPlay    = false; // for end-of-track detection
var _sonosTimeoutCount = 0;    // consecutive SOAP-timeout responses (network down to Sonos)
var _webAudio      = null;
var _SONOS_MAX_VOL = 50;
var _allowCast     = false; // true when user has allow-mpv-cast (gates Server + Sonos buttons)

// ── Helpers ────────────────────────────────────────────────────────────────
function fmt(s){ s=Math.floor(s||0); return Math.floor(s/60)+':'+(s%60<10?'0':'')+(s%60); }
function currentEntry(s){ return s&&s.queue&&s.currentIndex>=0?s.queue[s.currentIndex]:null; }
function buildStreamUrl(relPath){ return '/media/'+relPath.split('/').map(encodeURIComponent).join('/')+'?token='+encodeURIComponent(_token); }

function toast(msg, ms){
  var el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function(){ el.classList.remove('show'); }, ms||2000);
}

function api(method, path, data){
  var opts = { method: method, headers: { 'Content-Type':'application/json', 'x-access-token': _token } };
  if (data) opts.body = JSON.stringify(data);
  return fetch('/' + path, opts).then(function(r){
    if (!r.ok) return r.json().then(function(j){ throw new Error(j.error||r.status); });
    return r.json();
  });
}

// ── Theme ──────────────────────────────────────────────────────────────────
function applyTheme(theme){
  document.documentElement.classList.remove('dark','light');
  if (theme==='dark')  document.documentElement.classList.add('dark');
  if (theme==='light') document.documentElement.classList.add('light');
  var labels = { velvet:'Velvet', dark:t('server-remote.theme.dark'), light:t('server-remote.theme.light') };
  document.getElementById('theme-label').textContent = labels[theme]||'Velvet';
  localStorage.setItem('ms2_theme', theme);
}
function cycleTheme(){
  var cur = localStorage.getItem('ms2_theme')||'velvet';
  applyTheme(cur==='velvet'?'dark':cur==='dark'?'light':'velvet');
}

// ── Auth ───────────────────────────────────────────────────────────────────
function doLogin(){
  var btn = document.getElementById('login-btn');
  var err = document.getElementById('login-err');
  var u   = document.getElementById('u-input').value.trim();
  var p   = document.getElementById('p-input').value;
  btn.disabled = true; btn.textContent = t('server-remote.login.signingIn'); err.textContent = '';
  fetch('/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ username: u, password: p })
  }).then(function(r){ if (!r.ok) throw new Error(); return r.json(); })
  .then(function(data){
    _token  = data.token || '';
    startApp();
  }).catch(function(){
    err.textContent = t('server-remote.login.failed');
    btn.disabled = false; btn.textContent = t('server-remote.login.signIn');
  });
}

function tryNoAuthLogin(){
  // If the server has no users, auth middleware auto-grants access
  // Probe with a protected endpoint using no token
  fetch('/api/v1/server-playback/status', { headers: { 'x-access-token': '' } })
    .then(function(r){
      if (r.ok) { _token = ''; startApp(); return; }
      // 401 = need login
      showLogin();
    }).catch(function(){ showLogin(); });
}

function showLogin(){
  document.getElementById('login-screen').style.display = 'flex';
}

['u-input','p-input'].forEach(function(id){
  document.getElementById(id).addEventListener('keydown', function(e){ if(e.key==='Enter') doLogin(); });
});

// ── App start ──────────────────────────────────────────────────────────────
function startApp(){
  // Check if this user has permission to use server-remote
  fetch('/api/v1/ping', { headers: { 'Content-Type':'application/json', 'x-access-token': _token } })
    .then(function(r){ return r.ok ? r.json() : {}; })
    .then(function(d){
      if (d.allowServerRemote === false) {
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('main-screen').style.display  = 'none';
        document.body.innerHTML = '<div style="font-family:system-ui,sans-serif;background:#1a1a2e;color:#e4e4e4;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0">'
          + '<div style="max-width:420px;padding:40px;text-align:center">'
          + '<h1 style="color:#a78bfa;margin-bottom:12px"></h1>'
          + '<p style="color:#8888b0;line-height:1.6;margin-bottom:24px"></p>'
          + '<a href="/" style="color:#a78bfa;text-decoration:none"></a></div></div>';
        document.querySelector('h1').textContent = t('server-remote.denied.title');
        document.querySelector('p').textContent  = t('server-remote.denied.body');
        document.querySelector('a').textContent  = t('server-remote.denied.back');
        return;
      }
      _allowCast = d.allowMpvCast === true;
      // If stored output mode requires cast permission but user lacks it, fall back to Web
      if (!_allowCast && (_output === 'mpv' || _output === 'sonos')) {
        _output = 'web';
    localStorage.setItem('sr_output', 'web');
      }
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('main-screen').style.display  = 'flex';
      renderQueue([]);
      loadBrowse();
      initOutput();
      startPolling();
    }).catch(function(){
      // Fallback: if ping fails just proceed (no-auth mode or network error)
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('main-screen').style.display  = 'flex';
      renderQueue([]);
      loadBrowse();
      initOutput();
      startPolling();
    });
}

// ── Output ─────────────────────────────────────────────────────────────────
function initOutput(){
  applyOutputUI(_output);
  api('GET','api/v1/sonos/devices').then(function(d){
    _sonosRooms = d.rooms||[];
    if (!_sonosRoom && d.defaultRoom) _sonosRoom = d.defaultRoom;
    // If Sonos has been disabled in admin, fall back to Web output silently
    if (d.enabled === false && _output === 'sonos') {
      _output = 'web';
      localStorage.setItem('sr_output', 'web');
      applyOutputUI('web');
      webInitAudio();
    }
    renderSonosRooms();
  }).catch(function(){});
  if (_output==='web') webInitAudio();
}

function setOutput(mode){
  if (mode===_output) return;
  if (!_allowCast && (mode==='mpv' || mode==='sonos')){ toast(t('server-remote.toast.noCast')); return; }
  if (_output==='sonos' && _sonosRoom)
    api('POST','api/v1/sonos/set-pause',{ip:_sonosRoom.ip,paused:true}).catch(function(){});
  else if (_output==='web' && _webAudio)
    _webAudio.pause();
  _output = mode;
  localStorage.setItem('sr_output', mode);
  applyOutputUI(mode);
  if (mode==='sonos'){
    if (!_sonosRoom && _sonosRooms.length){ _sonosRoom=_sonosRooms[0]; localStorage.setItem('sr_sonos_room',JSON.stringify(_sonosRoom)); renderSonosRooms(); }
    api('POST','api/v1/server-playback/set-pause',{paused:true}).catch(function(){});
    toast(_sonosRoom ? t('server-remote.toast.outputSonosRoom', { room: _sonosRoom.name }) : t('server-remote.toast.outputSonos'));
  } else if (mode==='web'){
    webInitAudio();
    api('POST','api/v1/server-playback/set-pause',{paused:true}).catch(function(){});
    toast(t('server-remote.toast.outputBrowser'));
  } else {
    toast(t('server-remote.toast.outputServer'));
  }
}

function applyOutputUI(mode){
  ['mpv','sonos','web'].forEach(function(m){
    var btn=document.getElementById('out-'+m);
    if (btn) btn.classList.toggle('active',m===mode);
  });
  var badge=document.getElementById('output-badge');
  if (badge) badge.textContent=mode==='mpv'?t('server-remote.output.server'):mode==='sonos'?'Sonos':t('server-remote.output.browser');
  var sr=document.getElementById('sonos-room-row');
  if (sr) sr.style.display=mode==='sonos'?'':'none';
  // Hide Server + Sonos buttons for users without cast permission
  var mpvBtn=document.getElementById('out-mpv');
  var sonosBtn=document.getElementById('out-sonos');
  if (mpvBtn)   mpvBtn.style.display   = _allowCast ? '' : 'none';
  if (sonosBtn) sonosBtn.style.display = _allowCast ? '' : 'none';
}

function loadSonosRooms(){
  api('POST','api/v1/sonos/scan').then(function(d){
    _sonosRooms=d.rooms||[];
    if (!_sonosRoom && _sonosRooms.length){ _sonosRoom=_sonosRooms[0]; localStorage.setItem('sr_sonos_room',JSON.stringify(_sonosRoom)); }
    renderSonosRooms();
    toast(t(_sonosRooms.length===1 ? 'server-remote.toast.roomFound' : 'server-remote.toast.roomsFound', { count: _sonosRooms.length }));
  }).catch(function(){ toast(t('server-remote.toast.scanFailed')); });
}

function selectSonosRoom(room){
  _sonosRoom=room;
  localStorage.setItem('sr_sonos_room',JSON.stringify(room));
  renderSonosRooms();
  toast(t('server-remote.toast.room', { room: room.name }));
}

function renderSonosRooms(){
  var el=document.getElementById('sonos-rooms-pills'); if (!el) return;
  el.textContent = '';
  if (!_sonosRooms.length){
    var wrap = document.createElement('span');
    wrap.style.fontSize = '12px';
    wrap.style.color = 'var(--t3)';
    wrap.appendChild(document.createTextNode(t('server-remote.rooms.none') + ' '));
    var scanBtn = document.createElement('button');
    scanBtn.className = 'sonos-scan-btn';
    scanBtn.textContent = t('server-remote.rooms.scan');
    scanBtn.onclick = function(){ loadSonosRooms(); };
    wrap.appendChild(scanBtn);
    el.appendChild(wrap);
    return;
  }
  _sonosRooms.forEach(function(r){
    var act=_sonosRoom&&_sonosRoom.ip===r.ip;
    var btn = document.createElement('button');
    btn.className = 'sonos-room-pill' + (act ? ' active' : '');
    btn.title = r.model || r.ip;
    btn.textContent = r.name;
    btn.onclick = function(){ selectSonosRoom(r); };
    el.appendChild(btn);
  });
  var rescan = document.createElement('button');
  rescan.className = 'sonos-scan-btn';
  rescan.title = t('server-remote.rooms.rescan');
  rescan.textContent = '↻';
  rescan.onclick = function(){ loadSonosRooms(); };
  el.appendChild(rescan);
}

// ── Polling ────────────────────────────────────────────────────────────────
function startPolling(){
  poll();
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(poll, 2000);
}

function poll(){
  api('GET','api/v1/server-playback/status').then(function(s){
    _lastStatus = s;
    renderQueue(s.queue||[], s.currentIndex);
    maybeAutoDJ(s);
    if (_tab === 'audio') renderAudioStatus(s);
    if (_output==='mpv')   updateUIMpv(s);
    else if (_output==='sonos') pollSonos(s);
    else if (_output==='web')  updateUIWeb();
  }).catch(function(){});
}

function pollSonos(srv){
  if (!_sonosRoom){ setDot(false,false,t('server-remote.status.noRoom')); return; }
  api('GET','api/v1/sonos/transport-status?ip='+encodeURIComponent(_sonosRoom.ip)).then(function(st){
    var wasPlaying = _sonosPrevPlay;
    // The /transport-status endpoint returns {stopped:true, position:0, duration:0}
    // when the SOAP call to Sonos times out (network outage). Distinguish this
    // from a real STOPPED state (track ended) which has duration > 0.
    var isNetTimeout = (st.stopped && st.duration === 0 && st.position === 0 && !st.playing && !st.paused);
    var prevTimeoutCount = _sonosTimeoutCount;
    _sonosTimeoutCount = isNetTimeout ? prevTimeoutCount + 1 : 0;
    _sonosSt=st; _sonosPrevPlay=st.playing;
    setDot(true,st.playing,stateText(st.playing,st.paused));
    document.getElementById('play-icon').style.display=st.playing?'none':'';
    document.getElementById('pause-icon').style.display=st.playing?'':'none';
    setNpInfo(currentEntry(srv));
    setProgress(st.position,st.duration);
    // Auto-advance when track finishes (PLAYING → STOPPED)
    // Guard: skip if this is a network-timeout response (duration=0) to avoid
    // spuriously advancing the queue during a switch firmware update / outage.
    if (wasPlaying && st.stopped && !isNetTimeout && srv && srv.queue && srv.queue.length > 1){
      var ni=(srv.currentIndex||0)+1;
      if (ni<srv.queue.length) sonosAdvanceTo(ni,srv.queue);
    }
    // Auto-recovery: after network comes back (≥3 consecutive timeouts followed
    // by a real response), Sonos has dropped the stream → re-cast current track.
    var cur = currentEntry(srv);
    if (prevTimeoutCount >= 3 && !isNetTimeout && st.stopped && cur){
      setTimeout(function(){ sonosCastCurrent(cur); }, 500);
    }
  }).catch(function(){ setDot(false,false,t('server-remote.status.sonosUnknown')); });
}

function sonosCastCurrent(cur){
  if (!_sonosRoom||!cur||!cur.relPath) return;
  var fp = cur.relPath.replace(/^\/+/,''); // defensive strip in case server returns leading slash
  api('POST','api/v1/sonos/cast',{ip:_sonosRoom.ip,filepath:fp,title:cur.title||'',artist:cur.artist||'',album:cur.album||'',aaFile:cur.albumArt||null}).catch(function(e){ toast(t('server-remote.toast.castError', { error: e.message||'' })); });
}

function sonosAdvanceTo(idx,queue){
  api('POST','api/v1/server-playback/queue/play-index',{index:idx}).then(function(){
    api('POST','api/v1/server-playback/set-pause',{paused:true}).catch(function(){});
    var cur=queue[idx]; if (cur) sonosCastCurrent(cur);
  }).catch(function(){});
}

function updateUIWeb(){
  if (!_webAudio) return;
  var srv=_lastStatus;
  var cur=currentEntry(srv);
  var playing=!_webAudio.paused&&!_webAudio.ended&&!!_webAudio.src&&_webAudio.src!==window.location.href;
  setDot(true,playing,stateText(playing,!!_webAudio.src&&_webAudio.src!==window.location.href));
  document.getElementById('play-icon').style.display=playing?'none':'';
  document.getElementById('pause-icon').style.display=playing?'':'none';
  setNpInfo(cur);
  setProgress(_webAudio.currentTime||0,_webAudio.duration||0);
}

function stateText(playing,paused){
  return t(playing ? 'server-remote.status.playing' : paused ? 'server-remote.status.paused' : 'server-remote.status.stopped');
}

function setDot(running,playing,text){
  document.getElementById('status-dot').className='dot '+(running?(playing?'dot-on':'dot-off'):'dot-off');
  document.getElementById('status-text').textContent=text||'—';
}

function setNpInfo(cur){
  document.getElementById('np-title').textContent=cur?(cur.title||(cur.relPath||'').split('/').pop()):t('server-remote.np.nothing');
  document.getElementById('np-artist').textContent=cur?(cur.artist||''):'';
  if (cur&&cur.relPath){
    var techEl=document.getElementById('np-tech');
    if (_metaCache[cur.relPath]){ techEl.textContent=_metaCache[cur.relPath]; }
    else {
      techEl.textContent='';
      api('POST','api/v1/db/metadata',{filepath:cur.relPath}).then(function(meta){
        var m=meta.metadata||{},parts=[],f=(meta.filepath||cur.relPath).split('.').pop().toUpperCase();
        if(f)parts.push(f);
        if(m.bitrate)parts.push(Math.round(m.bitrate>=20000?m.bitrate/1000:m.bitrate)+' kbps');
        if(m['sample-rate'])parts.push((m['sample-rate']/1000).toFixed(1).replace('.0','')+'kHz');
        if(m.channels)parts.push(m.channels===2?t('server-remote.np.stereo'):m.channels===1?t('server-remote.np.mono'):m.channels+'ch');
        var str=parts.join(' · '); _metaCache[cur.relPath]=str;
        var nc=currentEntry(_lastStatus);
        if(nc&&nc.relPath===cur.relPath) techEl.textContent=str;
      }).catch(function(){});
    }
  } else { document.getElementById('np-tech').textContent=''; }
  var art=document.getElementById('np-art');
  if (cur&&cur.albumArt){art.src='/album-art/'+cur.albumArt;art.style.opacity='1';}
  else{art.src='';art.style.opacity='0';}
}

function setProgress(pos,dur){
  var pct=dur>0?(pos/dur*100).toFixed(2):0;
  document.getElementById('prog-fill').style.width=pct+'%';
  document.getElementById('np-cur').textContent=fmt(pos);
  document.getElementById('np-dur').textContent=fmt(dur);
}

function updateUIMpv(s){
  setDot(s.running, s.playing, stateText(s.playing, s.running));
  document.getElementById('play-icon').style.display  = s.playing ? 'none' : '';
  document.getElementById('pause-icon').style.display = s.playing ? '' : 'none';
  var lb=document.getElementById('loop-btn'), ll=document.getElementById('loop-label');
  if (s.loopMode==='one'){lb.classList.add('active');ll.textContent=t('server-remote.loop.one');}
  else if (s.loopMode==='all'){lb.classList.add('active');ll.textContent=t('server-remote.loop.all');}
  else{lb.classList.remove('active');ll.textContent=t('server-remote.loop.off');}
  setNpInfo(currentEntry(s));
  setProgress(s.currentTime, s.duration);
}

// ── Seek click ─────────────────────────────────────────────────────────────
function seekClick(e){
  var rect = document.getElementById('prog-track').getBoundingClientRect();
  var pct  = (e.clientX - rect.left) / rect.width;
  if (_output==='mpv'){
    if (!_lastStatus||!_lastStatus.duration) return;
    api('POST','api/v1/server-playback/seek',{ position: Math.max(0,pct*_lastStatus.duration) });
  } else if (_output==='sonos'){
    if (!_sonosRoom||!_sonosSt.duration) return;
    api('POST','api/v1/sonos/seek',{ip:_sonosRoom.ip,position:Math.max(0,pct*_sonosSt.duration)}).catch(function(){});
  } else if (_output==='web'){
    if (_webAudio&&_webAudio.duration) _webAudio.currentTime=pct*_webAudio.duration;
  }
}

// ── Volume ─────────────────────────────────────────────────────────────────
function setVol(v){
  document.getElementById('vol-val').textContent = v;
  clearTimeout(_volTimer);
  _volTimer = setTimeout(function(){
    var n=Number(v);
    if (_output==='mpv'){
      api('POST','api/v1/server-playback/volume',{volume:n});
    } else if (_output==='sonos'){
      if (!_sonosRoom) return;
      api('POST','api/v1/sonos/set-volume',{ip:_sonosRoom.ip,volume:Math.round(Math.min(100,n)*_SONOS_MAX_VOL/100),muted:false}).catch(function(){});
    } else if (_output==='web'){
      if (_webAudio) _webAudio.volume=Math.max(0,Math.min(1,n/100));
    }
  }, 200);
}

// ── Playback controls (output-routed) ────────────────────────────────────
function doPausePlay(){
  var cur=currentEntry(_lastStatus);
  if (_output==='mpv'){
    api('POST','api/v1/server-playback/pause');
  } else if (_output==='sonos'){
    if (!_sonosRoom){ toast(t('server-remote.toast.noSonosRoom')); return; }
    if (_sonosSt.playing){
      api('POST','api/v1/sonos/set-pause',{ip:_sonosRoom.ip,paused:true}).catch(function(){});
    } else {
      if (cur&&!_sonosSt.paused){ sonosCastCurrent(cur); }
      else { api('POST','api/v1/sonos/set-pause',{ip:_sonosRoom.ip,paused:false}).catch(function(){}); }
    }
  } else if (_output==='web'){
    if (!_webAudio){ webInitAudio(); return; }
    if (_webAudio.paused||!_webAudio.src||_webAudio.src===window.location.href){
      if (cur){ var url=buildStreamUrl(cur.relPath||''); if (_webAudio.src!==url){ webLoadSong(cur); } else { _webAudio.play().catch(function(){}); } }
    } else { _webAudio.pause(); }
  }
}

function playOnOutput(cur){
  if (!cur) return;
  if (_output==='sonos') sonosCastCurrent(cur); else if (_output==='web') webLoadSong(cur);
}

// Sonos and web output play the song themselves: move the server queue, keep mpv paused, then hand over the new current song
function moveQueue(path, body){
  if (_output==='mpv'){ api('POST',path,body); return; }
  api('POST',path,body).then(function(){
    api('POST','api/v1/server-playback/set-pause',{paused:true}).catch(function(){});
    return api('GET','api/v1/server-playback/status');
  }).then(function(s){ _lastStatus=s; playOnOutput(currentEntry(s)); }).catch(function(){});
}

function doNext(){ moveQueue('api/v1/server-playback/next'); }
function doPrev(){ moveQueue('api/v1/server-playback/previous'); }

// ── Web audio ──────────────────────────────────────────────────────────────
var _webAudioCtx  = null;
var _webGainNode  = null;  // ReplayGain normalization node

function webInitAudio(){
  if (_webAudio) return;
  _webAudio=document.getElementById('sr-audio');
  if (!_webAudio){ _webAudio=document.createElement('audio'); document.body.appendChild(_webAudio); }
  // Wire through Web Audio for normalization
  try {
    _webAudioCtx = new (window.AudioContext||window.webkitAudioContext)();
    var src = _webAudioCtx.createMediaElementSource(_webAudio);
    _webGainNode = _webAudioCtx.createGain();
    _webGainNode.gain.value = 1.0;
    src.connect(_webGainNode);
    _webGainNode.connect(_webAudioCtx.destination);
  } catch(e) { _webGainNode = null; }
  _webAudio.addEventListener('ended', webAutoNext);
  _webAudio.addEventListener('timeupdate',function(){ if (_output==='web') updateUIWeb(); });
  _webAudio.addEventListener('error',function(){ toast(t('server-remote.toast.playbackError')); });
}

function _webApplyRGGain(rg, replaygain){
  if (!_webGainNode) return;
  // rg = { trackGain, albumGain, truePeak } from metadata; replaygain = legacy tag dB
  var db = null;
  if (rg && rg.trackGain != null) db = rg.trackGain;
  else if (replaygain != null)    db = Number(replaygain);
  if (db == null) { _webGainNode.gain.value = 1.0; return; }
  // Clip prevention: ensure true peak stays ≤ 0 dBTP
  var peakDbtp = (rg && rg.truePeak != null) ? rg.truePeak : null;
  if (peakDbtp != null){ var headroom = -peakDbtp; if (db > headroom) db = headroom; }
  _webGainNode.gain.value = Math.pow(10, db / 20);
}

function webLoadSong(cur){
  if (!_webAudio) webInitAudio();
  var url=buildStreamUrl(cur.relPath||cur.filepath||''); if (!url) return;
  // Resume AudioContext if suspended (browser autoplay policy)
  if (_webAudioCtx && _webAudioCtx.state==='suspended') _webAudioCtx.resume();
  // Fetch RG metadata then play
  var fp=cur.relPath||cur.filepath||'';
  api('POST','api/v1/db/metadata',{filepath:fp}).then(function(meta){
    var m=meta.metadata||{};
    var rg=meta.rg||null;
    var legacy=m['replaygain-track']!=null?m['replaygain-track']:(m['replaygain-track-db']!=null?m['replaygain-track-db']:null);
    _webApplyRGGain(rg, legacy);
  }).catch(function(){ if (_webGainNode) _webGainNode.gain.value=1.0; });
  _webAudio.src=url;
  _webAudio.play().catch(function(){ toast(t('server-remote.toast.playBlocked')); });
}

function webAutoNext(){
  var s=_lastStatus; if (!s||!s.queue||!s.queue.length) return;
  var ni=(s.currentIndex||0)+1; if (ni>=s.queue.length) return;
  api('POST','api/v1/server-playback/queue/play-index',{index:ni}).then(function(){
    api('POST','api/v1/server-playback/set-pause',{paused:true}).catch(function(){});
    return api('GET','api/v1/server-playback/status');
  }).then(function(s2){ _lastStatus=s2; var cur=currentEntry(s2); if (cur) webLoadSong(cur); }).catch(function(){});
}

// ── Loop ───────────────────────────────────────────────────────────────────
function doLoop(){
  api('POST','api/v1/server-playback/loop').then(function(d){
    toast(d.loop_mode === 'one' ? '🔂 ' + t('server-remote.toast.repeatOne') : '🔁 ' + t(d.loop_mode === 'all' ? 'server-remote.toast.repeatAll' : 'server-remote.toast.repeatOff'));
  });
}

// ── Queue ──────────────────────────────────────────────────────────────────
var _lastQueueJson = '';
function renderQueue(q, curIdx){
  var json = JSON.stringify(q) + '|' + curIdx;
  if (json === _lastQueueJson) return; // avoid flicker if unchanged
  _lastQueueJson = json;
  var list = document.getElementById('queue-list');
  if (!q || !q.length){
    list.textContent = '';
    var empty = document.createElement('div');
    empty.className = 'queue-empty';
    empty.textContent = t('server-remote.queue.empty');
    list.appendChild(empty);
    return;
  }

  list.textContent = '';
  q.forEach(function(item, i){
    var title = item.title || item.relPath.split('/').pop();
    var sub   = [item.artist, item.album].filter(Boolean).join(' · ');
    var act   = i === curIdx;

    var row = document.createElement('div');
    row.className = 'queue-item' + (act ? ' playing' : '');
    row.onclick = function(){ playIdx(i); };

    var num = document.createElement('div');
    num.className = 'queue-item-num';
    num.textContent = act ? '▶' : String(i + 1);

    var info = document.createElement('div');
    info.className = 'queue-item-info';
    var titleEl = document.createElement('div');
    titleEl.className = 'queue-item-title';
    titleEl.textContent = title;
    info.appendChild(titleEl);

    if (sub) {
      var subEl = document.createElement('div');
      subEl.className = 'queue-item-sub';
      subEl.textContent = sub;
      info.appendChild(subEl);
    }

    var del = document.createElement('button');
    del.className = 'queue-item-del';
    del.title = t('server-remote.queue.remove');
    del.textContent = '×';
    del.onclick = function(event){ event.stopPropagation(); removeIdx(i); };

    row.appendChild(num);
    row.appendChild(info);
    row.appendChild(del);
    list.appendChild(row);
  });
}

function playIdx(i){ moveQueue('api/v1/server-playback/queue/play-index',{index:i}); }
function removeIdx(i){ api('POST','api/v1/server-playback/queue/remove',{ index: i }).then(poll); }

function clearAndRefill(){
  if (!confirm(t('server-remote.queue.confirmClear'))) return;
  api('POST','api/v1/server-playback/queue/clear').then(function(){ poll(); toast(t('server-remote.toast.queueCleared')); });
}

function addToQueue(filepath,title,artist,album,albumArt){
  return api('POST','api/v1/server-playback/queue/add',{filepath:filepath,title:title||'',artist:artist||'',album:album||'',albumArt:albumArt||''}).then(function(){
    toast(t('server-remote.toast.added', { title: title||filepath.split('/').pop() })); poll();
    // If Sonos/Web is idle, auto-start the first song
    if (_output==='sonos'&&_sonosRoom&&!_sonosSt.playing&&!_sonosSt.paused){
      setTimeout(function(){ api('GET','api/v1/server-playback/status').then(function(s){ var cur=currentEntry(s); if(cur) sonosCastCurrent(cur); }).catch(function(){}); },300);
    } else if (_output==='web'&&_webAudio&&(_webAudio.paused||!_webAudio.src||_webAudio.src===window.location.href)){
      setTimeout(function(){ api('GET','api/v1/server-playback/status').then(function(s){ _lastStatus=s; var cur=currentEntry(s); if(cur) webLoadSong(cur); }).catch(function(){}); },300);
    }
  });
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function setTab(t){
  _tab = t;
  ['queue','search','dj','audio','browse'].forEach(function(n){
    document.getElementById('tab-'+n).classList.toggle('active', n===t);
    document.getElementById('panel-'+n).classList.toggle('active', n===t);
  });
  if (t==='browse' && !document.getElementById('browse-list').innerHTML) loadBrowse();
  if (t==='search') setTimeout(function(){ document.getElementById('search-input').focus(); }, 80);
  if (t==='audio') renderAudioStatus(_lastStatus);
}

// ── Auto-DJ ────────────────────────────────────────────────────────────────
function onDjToggle(on){
  _djOn = on;
  var btn = document.getElementById('dj-transport-btn');
  btn.classList.toggle('active', on);
  document.getElementById('dj-transport-label').textContent = t('server-remote.dj.label') + (on ? ' ●' : '');
  updateDjStatus(t(on ? 'server-remote.djStatus.ready' : 'server-remote.djStatus.off'));
  if (on) maybeAutoDJ(_lastStatus);
}

function setDjMode(m){
  _djMode = m;
  document.getElementById('mode-random').classList.toggle('active', m==='random');
  document.getElementById('mode-similar').classList.toggle('active', m==='similar');
}

function updateDjStatus(msg, isOn){
  var el = document.getElementById('dj-status-bar');
  el.textContent = msg;
  el.className   = 'dj-status-bar' + (isOn ? ' on' : '');
}

function maybeAutoDJ(s){
  if (!_djOn || _djFetching || !s) return;
  // Fetch next song when queue is running low (fewer than 2 songs ahead of current)
  var ahead = s.queueLength - (s.currentIndex + 1);
  var nearEnd = s.duration > 0 && s.currentTime > s.duration - 25;
  if (ahead < 2 || nearEnd) {
    fetchDjSong(s);
  }
}

function fetchDjSong(s){
  if (_djFetching) return;
  _djFetching = true;
  updateDjStatus(t('server-remote.djStatus.fetching'), true);

  var queued = (s && s.queue || []).map(function(q){ return q.relPath; });
  var body = { recent: queued.slice(-200) };
  if (_djMode === 'similar' && queued.length) body.seedFilepath = queued[queued.length - 1];

  api('POST','api/v1/autodj/next',body).then(function(data){
    if (!data.song) throw new Error(t('server-remote.djStatus.noSongs'));
    var song = data.song;
    var meta = song.metadata || {};
    return api('POST','api/v1/server-playback/queue/add',{
      filepath: song.filepath,
      title:    meta.title              || '',
      artist:   meta.artist             || '',
      album:    meta.album              || '',
      albumArt: meta['album-art']       || '',
    });
  }).then(function(){
    _djFetching = false;
    updateDjStatus(t('server-remote.djStatus.queued'), true);
  }).catch(function(e){
    _djFetching = false;
    updateDjStatus(t('server-remote.djStatus.failed', { reason: e.message || '?' }), false);
  });
}

// ── Search ────────────────────────────────────────────────────────────────
function onSearchInput(){
  clearTimeout(_searchTimer);
  var q = document.getElementById('search-input').value.trim();
  var cl = document.getElementById('search-clear');
  cl.style.display = q ? 'block' : 'none';
  if (!q || q.length < 2) { document.getElementById('search-results-list').innerHTML = ''; _searchResults = []; return; }
  var searching = document.createElement('div');
  searching.className = 'search-msg';
  searching.textContent = t('server-remote.search.searching');
  document.getElementById('search-results-list').replaceChildren(searching);
  _searchTimer = setTimeout(function(){ doSearch(q); }, 350);
}

function clearSearch(){
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').style.display = 'none';
  document.getElementById('search-results-list').innerHTML = '';
  _searchResults = [];
}

function doSearch(q){
  api('POST','api/v1/db/search',{ search: q, noArtists:true, noFolders:true, noAlbums:true, noFiles:true })
    .then(function(data){
      _searchResults = (data.title || []).slice(0, 25);
      var el = document.getElementById('search-results-list');
      el.textContent = '';
      if (!_searchResults.length){
        var msg = document.createElement('div');
        msg.className = 'search-msg';
        msg.textContent = t('server-remote.search.noResults', { query: q });
        el.appendChild(msg);
        return;
      }
      _searchResults.forEach(function(item, i){
        var raw    = item.name || '';
        var dash   = raw.indexOf(' - ');
        var artist = dash > -1 ? raw.slice(0, dash) : '';
        var title  = dash > -1 ? raw.slice(dash + 3) : raw;
        var row = document.createElement('div');
        row.className = 'search-item';
        var info = document.createElement('div');
        info.className = 'search-item-info';
        var titleEl = document.createElement('div');
        titleEl.className = 'search-item-title';
        titleEl.textContent = title;
        info.appendChild(titleEl);
        if (artist) {
          var artistEl = document.createElement('div');
          artistEl.className = 'search-item-artist';
          artistEl.textContent = artist;
          info.appendChild(artistEl);
        }
        var addBtn = document.createElement('button');
        addBtn.className = 'search-item-add';
        addBtn.title = t('server-remote.search.add');
        addBtn.textContent = '+';
        addBtn.onclick = function(){ addSearchResult(i); };
        row.appendChild(info);
        row.appendChild(addBtn);
        el.appendChild(row);
      });
    }).catch(function(){
      var el = document.getElementById('search-results-list');
      el.textContent = '';
      var msg = document.createElement('div');
      msg.className = 'search-msg';
      msg.textContent = t('server-remote.search.failed');
      el.appendChild(msg);
    });
}

function addSearchResult(i){
  var item = _searchResults[i]; if (!item) return;
  var raw=item.name||'', dash=raw.indexOf(' - ');
  var artist=dash>-1?raw.slice(0,dash):'', title=dash>-1?raw.slice(dash+3):raw;
  addToQueue(item.filepath,title,artist,'','').catch(function(){ toast(t('server-remote.toast.addFailed')); });
}

// ── Audio tab — Loudness Normalisation status ──────────────────────────────
function renderAudioStatus(st) {
  var el = document.getElementById('rg-status-rows');
  if (!el) return;
  if (!st || !st.running) {
    el.textContent = '';
    var stopped = document.createElement('div');
    stopped.className = 'dj-status-bar';
    stopped.textContent = t('server-remote.audio.notRunning');
    el.appendChild(stopped);
    return;
  }
  var gainDb = st.currentGainDb;
  var rows = [];

  // Normalisation enabled row
  rows.push(_rgRow(t('server-remote.audio.normalisation'), gainDb != null ? '✓ ' + t('server-remote.audio.active') : '✗ ' + t('server-remote.audio.off'),
    gainDb != null ? 'var(--green)' : 'var(--t3)'));

  // Current gain row
  if (gainDb != null) {
    var sign = gainDb >= 0 ? '+' : '';
    rows.push(_rgRow(t('server-remote.audio.currentGain'), t('server-remote.audio.gainValue', { gain: sign + gainDb.toFixed(1) }), 'var(--accent)'));
  }

  // Info row
  rows.push(_rgRow(t('server-remote.audio.modeSettings'), t('server-remote.audio.controlled'), 'var(--t3)'));

  el.textContent = '';
  rows.forEach(function(row){ el.appendChild(row); });
}

function _rgRow(label, value, color) {
  var row = document.createElement('div');
  row.className = 'dj-toggle-row';
  row.style.padding = '10px 0';

  var labelEl = document.createElement('div');
  labelEl.className = 'dj-toggle-label';
  labelEl.style.fontSize = '13px';
  labelEl.textContent = label;

  var valueEl = document.createElement('div');
  valueEl.style.fontSize = '12px';
  valueEl.style.color = color || 'var(--t2)';
  valueEl.style.fontWeight = '600';
  valueEl.style.textAlign = 'right';
  valueEl.style.maxWidth = '55%';
  valueEl.textContent = value;

  row.appendChild(labelEl);
  row.appendChild(valueEl);
  return row;
}

function createBrowserIcon(type) {
  var ns = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  if (type === 'dir') {
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z');
    svg.appendChild(p);
  } else {
    var p2 = document.createElementNS(ns, 'path');
    p2.setAttribute('d', 'M9 18V5l12-2v13');
    var c1 = document.createElementNS(ns, 'circle');
    c1.setAttribute('cx', '6');
    c1.setAttribute('cy', '18');
    c1.setAttribute('r', '3');
    var c2 = document.createElementNS(ns, 'circle');
    c2.setAttribute('cx', '18');
    c2.setAttribute('cy', '16');
    c2.setAttribute('r', '3');
    svg.appendChild(p2);
    svg.appendChild(c1);
    svg.appendChild(c2);
  }
  return svg;
}

// ── File browser ───────────────────────────────────────────────────────────
function loadBrowse(){
  var list = document.getElementById('browse-list');
  list.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  document.getElementById('breadcrumb').textContent = '/' + _pathStack.join('/');
  document.getElementById('bk-btn').disabled = _pathStack.length === 0;
  var dirStr = _pathStack.length ? _pathStack.join('/') + '/' : '';
  api('POST','api/v1/file-explorer',{ directory: dirStr })
    .then(function(data){
      var items = [];
      (data.directories||[]).forEach(function(d){ items.push({ type:'dir',  name: d.name }); });
      (data.files||[]).forEach(function(f){ items.push({ type:'file', name: f.name, path: data.path + f.name }); });
      if (!items.length){ list.replaceChildren(browserEmpty(t('server-remote.browse.empty'))); return; }
      list.innerHTML = '';
      items.forEach(function(item){
        var row  = document.createElement('div'); row.className = 'browser-item';
        var icon = document.createElement('span'); icon.className = 'browser-item-icon';
        icon.appendChild(createBrowserIcon(item.type));
        var name = document.createElement('span'); name.className = 'browser-item-name'; name.textContent = item.name;
        row.appendChild(icon); row.appendChild(name);
        if (item.type === 'file') {
          var addBtn = document.createElement('button'); addBtn.className = 'browser-item-add'; addBtn.textContent = '+ ' + t('server-remote.browse.add');
          (function(fp, nm){
            addBtn.onclick = function(e){
              e.stopPropagation();
              api('POST','api/v1/db/metadata',{ filepath: fp })
                .then(function(meta){
                  var m = meta.metadata || {};
                  return addToQueue(meta.filepath||fp, m.title||nm, m.artist||'', m.album||'', m['album-art']||'');
                }).catch(function(){
                  return addToQueue(fp, nm, '', '', '');
                });
            };
            row.onclick = addBtn.onclick;
          }(item.path, item.name));
          row.appendChild(addBtn);
        } else {
          (function(n){ row.onclick = function(){ _pathStack.push(n); loadBrowse(); }; }(item.name));
        }
        list.appendChild(row);
      });
    }).catch(function(){ list.replaceChildren(browserEmpty(t('server-remote.browse.failed'))); });
}

function browserEmpty(text){
  var el = document.createElement('div');
  el.className = 'browser-empty';
  el.textContent = text;
  return el;
}

function browseBack(){ if (_pathStack.length){ _pathStack.pop(); loadBrowse(); } }

// ── Boot ───────────────────────────────────────────────────────────────────
// Probe for no-auth mode first, then show login if needed
applyTheme(localStorage.getItem('ms2_theme')||'velvet');
function boot(){
  applyTheme(localStorage.getItem('ms2_theme')||'velvet');
  tryNoAuthLogin();
}
I18N.loadLanguage().then(boot, boot);

// ── Auto-pause on close/navigate-away ──────────────────────────────────────
var _pauseSent = false;
// synchronous on purpose: an async request is dropped while the page unloads
function syncPost(path, body){
  try{ var x=new XMLHttpRequest(); x.open('POST',path,false); x.setRequestHeader('Content-Type','application/json'); x.setRequestHeader('x-access-token',_token); x.send(JSON.stringify(body)); }catch(e){}
}
function sendPause(){
  if (_pauseSent) return;
  _pauseSent = true;
  if (_pollTimer) clearInterval(_pollTimer);
  if (_output==='mpv' && _token){
    syncPost('api/v1/server-playback/set-pause',{paused:true});
  } else if (_output==='sonos' && _sonosRoom && _token){
    syncPost('api/v1/sonos/set-pause',{ip:_sonosRoom.ip,paused:true});
  } else if (_output==='web' && _webAudio){
    _webAudio.pause();
  }
}
window.addEventListener('pagehide',     function(){ sendPause(); });
window.addEventListener('beforeunload', function(){ sendPause(); });

document.getElementById('theme-btn').addEventListener('click', function() { cycleTheme(); });
document.getElementById('login-btn').addEventListener('click', function() { doLogin(); });
document.getElementById('np-art').addEventListener('error', function() { if (this.getAttribute('src')) this.src = ''; });
document.getElementById('prog-track').addEventListener('click', function(event) { seekClick(event); });
document.getElementById('prev-btn').addEventListener('click', function() { doPrev(); });
document.getElementById('play-btn').addEventListener('click', function() { doPausePlay(); });
document.getElementById('next-btn').addEventListener('click', function() { doNext(); });
document.getElementById('loop-btn').addEventListener('click', function() { doLoop(); });
document.getElementById('dj-transport-btn').addEventListener('click', function() { setTab('dj'); });
document.getElementById('clear-btn').addEventListener('click', function() { clearAndRefill(); });
document.getElementById('vol-slider').addEventListener('input', function() { setVol(this.value); });
document.getElementById('out-web').addEventListener('click', function() { setOutput('web'); });
document.getElementById('out-mpv').addEventListener('click', function() { setOutput('mpv'); });
document.getElementById('out-sonos').addEventListener('click', function() { setOutput('sonos'); });
document.getElementById('tab-queue').addEventListener('click', function() { setTab('queue'); });
document.getElementById('tab-search').addEventListener('click', function() { setTab('search'); });
document.getElementById('tab-dj').addEventListener('click', function() { setTab('dj'); });
document.getElementById('tab-audio').addEventListener('click', function() { setTab('audio'); });
document.getElementById('tab-browse').addEventListener('click', function() { setTab('browse'); });
document.getElementById('search-input').addEventListener('input', function() { onSearchInput(); });
document.getElementById('search-clear').addEventListener('click', function() { clearSearch(); });
document.getElementById('dj-toggle').addEventListener('change', function() { onDjToggle(this.checked); });
document.getElementById('mode-random').addEventListener('click', function() { setDjMode('random'); });
document.getElementById('mode-similar').addEventListener('click', function() { setDjMode('similar'); });
document.getElementById('bk-btn').addEventListener('click', function() { browseBack(); });
