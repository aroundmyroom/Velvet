// Round 5 player fixes (survey findings for webapp/app.js and the i18n engine).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { appSrc, indexHtml, loadFns, makeApiStub, tick, topLevelSource } from './helpers/fix-player-app.mjs';

const plain = v => JSON.parse(JSON.stringify(v));
const memStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
};

// Every name the code reads that the test does not provide resolves to an inert
// stub, so a test can drive a large browser block without listing all its globals.
function inert() {
  const fn = function () {};
  const stub = new Proxy(fn, {
    get(_t, k) {
      if (k === 'then' || k === Symbol.iterator) return undefined;
      if (k === Symbol.toPrimitive) return () => 0;
      return stub;
    },
    set: () => true,
    apply: () => stub,
    construct: () => stub,
  });
  return stub;
}
function fakeEl(extra = {}) {
  const classes = new Set(extra.classes || []);
  const el = {
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: c => classes.has(c),
      toggle: (c, on) => {
        const v = on ?? !classes.has(c);
        if (v) classes.add(c);
        else classes.delete(c);
        return v;
      },
    },
    style: {}, dataset: {}, options: [], clientWidth: 800, clientHeight: 600,
    ...extra,
  };
  const rest = inert();
  return new Proxy(el, { get: (t, k) => (k in t ? t[k] : rest[k]), set: (t, k, v) => { t[k] = v; return true; } });
}
function runInScope(names, provided) {
  const stub = inert();
  const env = new Proxy(provided, {
    has: (_t, k) => k !== 'out',
    get(t, k) {
      if (k === Symbol.unscopables) return undefined;
      if (k in t) return t[k];
      if (k in globalThis) return globalThis[k];
      return stub;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const ctx = vm.createContext({ env, out: {} });
  const code = names.map(topLevelSource).join('\n');
  // eslint-disable-next-line sonarjs/code-eval
  vm.runInContext(`with (env) {\n${code}\n${names.map(n => `out[${JSON.stringify(n)}] = ${n};`).join('\n')}\n}`, ctx);
  return ctx.out;
}

describe('audiobook songs are not music (N004/N005)', () => {
  const S = {
    vpaths: ['Music', 'Books', 'Audiobooks'],
    vpathMeta: {
      Music: { type: 'music', parentVpath: null },
      Books: { type: 'audio-books', parentVpath: null },
      Audiobooks: { type: 'audio-books', parentVpath: 'Music', filepathPrefix: 'Audiobooks/' },
    },
  };
  const ctx = loadFns(['_isMusicSong', '_isAudioBookSong', '_audioBookExclusions', '_djScopeBody'], {
    S: { ...S, djVpaths: [], djMinRating: 0 },
  });

  it('treats a chapter of a child audiobook vpath as an audiobook', () => {
    assert.equal(ctx._isMusicSong({ filepath: 'Music/Audiobooks/Book/01.mp3' }), false);
    assert.equal(ctx._isMusicSong({ filepath: 'Books/Novel/01.mp3' }), false);
    assert.equal(ctx._isMusicSong({ filepath: 'Music/Rock/song.mp3' }), true);
    assert.equal(ctx._isMusicSong({ filepath: 'Music/Rock/song.mp3', isRadio: true }), false);
  });

  it('keeps standalone audiobook roots out of the Auto-DJ scope', () => {
    const scope = ctx._djScopeBody();
    assert.deepEqual(plain(scope.ignoreVPaths), ['Books']);
    assert.deepEqual(plain(scope.excludeFilepathPrefixes), [{ vpath: 'Music', prefix: 'Audiobooks/' }]);
  });

  it('also when a child collection is selected', () => {
    const c2 = loadFns(['_isAudioBookSong', '_audioBookExclusions', '_djScopeBody'], {
      S: { vpaths: ['Music', 'Books', 'Albums'], djVpaths: ['Albums', 'Books'], djMinRating: 0,
        vpathMeta: { Music: {}, Books: { type: 'audio-books' }, Albums: { parentVpath: 'Music', filepathPrefix: 'Albums/' } } },
    });
    assert.deepEqual(plain(c2._djScopeBody().ignoreVPaths), ['Books']);
  });
});

describe('Butterchurn lifecycle (N006/N066)', () => {
  function vizEnv() {
    const els = {
      'viz-overlay': fakeEl({ classes: ['hidden'] }),
      'viz-canvas': fakeEl(), 'spec-canvas': fakeEl(),
    };
    const frames = new Set();
    let nextFrame = 1;
    const timers = new Set();
    let created = 0;
    const env = {
      window: { butterchurn: true, butterchurnPresets: {}, butterchurnPresetsExtra: {}, devicePixelRatio: 1, innerWidth: 800, innerHeight: 600 },
      butterchurn: { default: { createVisualizer: () => { created++; return { connectAudio() {}, render() {}, loadPreset() {}, setRendererSize() {} }; } } },
      butterchurnPresets: { getPresets: () => ({ a: {}, b: {} }) },
      butterchurnPresetsExtra: { getPresets: () => ({}) },
      document: { getElementById: id => els[id] || fakeEl(), createElement: () => fakeEl(), head: fakeEl() },
      requestAnimationFrame: () => { const id = nextFrame++; frames.add(id); return id; },
      cancelAnimationFrame: id => frames.delete(id),
      setTimeout: () => { const id = {}; timers.add(id); return id; },
      clearTimeout: id => timers.delete(id),
      setInterval: () => { const id = {}; timers.add(id); return id; },
      clearInterval: id => timers.delete(id),
      localStorage: memStorage(), _uKey: k => k, t: k => k, toast: () => {}, S: { queue: [], idx: -1 },
    };
    const { VIZ } = runInScope(['VIZ'], env);
    return { VIZ, frames, timers, created: () => created };
  }

  it('builds one visualizer with one render loop on the first open', async () => {
    const { VIZ, frames, created } = vizEnv();
    VIZ.open();
    await tick(); await tick();
    assert.equal(created(), 1);
    assert.equal(frames.size, 1);
  });

  it('stops the render loop and the preset cycle on close', async () => {
    const { VIZ, frames, timers } = vizEnv();
    VIZ.open();
    await tick(); await tick();
    assert.ok(timers.size >= 1);
    VIZ.close();
    assert.equal(frames.size, 0);
    assert.equal(timers.size, 0);
    VIZ.open();
    assert.equal(frames.size, 1);
  });
});

describe('unload beacon (N007)', () => {
  const setup = (extra = {}) => loadFns(['_QUEUE_COMPACT_FIELDS', '_compactQueueSong', '_compactQueueList', '_QUEUE_SYNC_MAX', '_buildQueueSyncPayload', '_BEACON_MAX_BYTES', '_queueBeaconBody'], {
    S: { queue: Array.from({ length: 10 }, (_, i) => ({ filepath: `m/${i}.mp3`, title: `t${i}` })), idx: 3 },
    audioEl: { currentTime: 7 }, _browserId: 'b', Blob, _bootRestoring: false, _queueLazyPending: false, ...extra,
  });

  it('sends the capped sync payload, paused', () => {
    const body = JSON.parse(setup()._queueBeaconBody());
    assert.equal(body.queue.queue.length, 10);
    assert.equal(body.queue.idx, 3);
    assert.equal(body.queue.playing, false);
    assert.equal(body.queue.currentFilepath, 'm/3.mp3');
  });

  it('writes nothing while only the local window is loaded or during boot', () => {
    assert.equal(setup({ _queueLazyPending: true })._queueBeaconBody(), null);
    assert.equal(setup({ _bootRestoring: true })._queueBeaconBody(), null);
  });

  it('leaves a payload over the beacon limit to the normal sync', () => {
    const ctx = setup();
    ctx.S.queue = Array.from({ length: 3000 }, (_, i) => ({ filepath: `Music/some/long/folder/name/${i}.flac`, title: 'x'.repeat(40) }));
    assert.equal(ctx._queueBeaconBody(), null);
  });

  it('marks the queue pending until the lazy DB load has run', () => {
    const r = topLevelSource('restoreQueue');
    assert.match(r, /_queueLazyPending = true;\s*\n\s*setTimeout\(_lazyLoadQueueFromDb, 3000\)/);
    assert.match(topLevelSource('_lazyLoadQueueFromDb'), /finally \{\s*_queueLazyPending = false;/);
  });
});

describe('queue multi-select follows the songs (N008)', () => {
  const songs = Array.from({ length: 6 }, (_, i) => ({ filepath: `s${i}` }));

  it('keeps the selected songs selected after the front of the queue is pruned', () => {
    const sel = loadFns(['_qvsSelected', '_pruneQueueSelection', '_queueSelectedIndices', '_toggleQueueSelection'], {
      S: { queue: [...songs] }, _updateQueueSelBar: () => {}, $vars: { _qvsLastClick: -1 },
    });
    sel._toggleQueueSelection(3);
    sel._toggleQueueSelection(5);
    assert.deepEqual(plain(sel._queueSelectedIndices()), [3, 5]);
    sel.S.queue.splice(0, 2);
    sel._pruneQueueSelection();
    assert.deepEqual(plain(sel._queueSelectedIndices()), [1, 3]);
    assert.deepEqual(plain(sel._queueSelectedIndices().map(i => sel.S.queue[i].filepath)), ['s3', 's5']);
  });

  it('drops a selected song that left the queue', () => {
    const sel = loadFns(['_qvsSelected', '_pruneQueueSelection', '_queueSelectedIndices', '_toggleQueueSelection'], {
      S: { queue: [...songs] }, _updateQueueSelBar: () => {}, $vars: { _qvsLastClick: -1 },
    });
    sel._toggleQueueSelection(2);
    sel.S.queue = songs.map(s => ({ ...s }));
    sel._pruneQueueSelection();
    assert.equal(sel.$._qvsSelected.size, 0);
  });

  it('removes and adds to a playlist by the selected songs', () => {
    assert.match(appSrc, /const toRemove = _queueSelectedIndices\(\)\.reverse\(\);/);
    assert.match(appSrc, /const songs = _queueSelectedIndices\(\)\.map\(qi => S\.queue\[qi\]\);/);
  });
});

describe('Shortcuts listeners end with the view (N010) and dead Home controller (N071)', () => {
  it('setBody aborts the Shortcuts listeners', () => {
    const ac = new AbortController();
    const b = fakeEl({ innerHTML: '', offsetWidth: 1 });
    const ctx = loadFns(['setBody'], {
      document: { getElementById: () => b }, $vars: { _shortcutsAC: null }, _pnowPanelClose() {},
    });
    ctx.$._shortcutsAC = ac;
    ctx.setBody('<p>x</p>');
    assert.equal(ac.signal.aborted, true);
    assert.equal(ctx.$._shortcutsAC, null);
  });

  it('viewShortcuts creates its controller after its own setBody', () => {
    const v = topLevelSource('viewShortcuts');
    assert.ok(v.indexOf('_shortcutsAC = (typeof AbortController') > v.indexOf('setBody(`<div class="home-view">'));
    assert.doesNotMatch(appSrc, /_homeAC/);
  });
});

describe('views set S.view (N011)', () => {
  it('Transcode sets its title, nav and view id', () => {
    const v = topLevelSource('viewTranscode');
    assert.match(v, /setNavActive\('transcode'\); S\.view = 'transcode';/);
  });
  it('album songs set their own view id so Playing Now does not redraw over them', () => {
    assert.match(topLevelSource('viewAlbumSongs'), /S\.view = 'album-songs';/);
  });
});

describe('Last.fm scrobble state (N012)', () => {
  it('maps the route outcome', () => {
    const { _scrobbleOutcome: f } = loadFns(['_scrobbleOutcome'], {});
    assert.equal(f({ scrobbled: true }), 'ok');
    assert.equal(f({ scrobbled: false }), 'err');
    assert.equal(f({ scrobbled: null }), 'off');
  });

  const run = async (S, answer) => {
    const { api, calls } = makeApiStub(() => answer);
    let fire;
    const ctx = loadFns(['_scrobbleState', '_initScrobbleState', '_scrobbleOutcome', '_scheduleScrobble'], {
      S: { customWebhooksEnabled: [], ...S }, api, _updateScrobbleUI: () => {},
      clearTimeout: () => {}, setTimeout: f => { fire = f; return 1; }, $vars: { scrobbleTimer: null },
    });
    ctx._scheduleScrobble({ filepath: 'Music/a.mp3' });
    await fire?.();
    return { calls, state: ctx.$._scrobbleState };
  };

  it('does not scrobble or show a tick for a user without a linked account', async () => {
    const { calls, state } = await run({ lastfmEnabled: true, lastfmHasApiKey: true, lastfmLinked: false }, {});
    assert.equal(calls.filter(c => c.path.includes('lastfm')).length, 0);
    assert.equal(state.lastfm, 'off');
  });

  it('shows a failed scrobble as failed', async () => {
    const { calls, state } = await run({ lastfmEnabled: true, lastfmHasApiKey: true, lastfmLinked: true }, { scrobbled: false });
    assert.equal(calls[0].path, 'api/v1/lastfm/scrobble-by-filepath');
    assert.equal(state.lastfm, 'err');
  });
});

describe('Listening History is reachable (N013)', () => {
  it('has a sidebar button', () => {
    assert.match(indexHtml, /data-view="history" data-i18n="player.nav.listeningHistory"/);
    assert.match(appSrc, /history:\s+\{ open: \(\) => viewHistory\(\) \}/);
  });
});

describe('radio recording ownership (N014/N020/N073/N074)', () => {
  const list = [{ id: 'other', stationName: 'A', vpath: 'R', startedAt: Date.now() }, { id: 'mine', stationName: 'B', vpath: 'R', startedAt: Date.now() }];
  const restore = async owned => {
    const { api } = makeApiStub(() => list);
    const ctx = loadFns(['_setActiveRecording', '_restoreActiveRecording'], {
      S: { allowRadioRecording: true, recordingActive: false }, api,
      sessionStorage: memStorage(owned ? { ms2_rec_owned: owned } : {}),
      setInterval: () => 1, clearInterval() {}, document: { getElementById: () => null }, fmt: String, _updateRecordBtn() {},
    });
    await ctx._restoreActiveRecording();
    return ctx.S;
  };

  it('a reloaded tab takes back its own recording and may stop it', async () => {
    const S = await restore('mine');
    assert.equal(S.recordingId, 'mine');
    assert.equal(S.recordingMeta.startedHere, true);
  });

  it('another tab shows a recording but does not own it', async () => {
    const S = await restore(null);
    assert.equal(S.recordingId, 'other');
    assert.equal(S.recordingMeta.startedHere, false);
  });

  it('auto-stops only a recording this tab started', () => {
    assert.match(appSrc, /if \(S\.recordingActive && S\.recordingMeta\?\.startedHere\) \{ _stopRecording\(\); \}/);
    assert.doesNotMatch(appSrc, /if \(S\.recordingActive\) \{ _stopRecording\(\); \}\n\s+\}\n\s+\/\/ sync NP modal/);
  });

  it('sends the art only when it is a cached file name', () => {
    const { _recArtFile } = loadFns(['_recArtFile'], {});
    assert.equal(_recArtFile({ 'album-art': 'abc.jpg' }), 'abc.jpg');
    assert.equal(_recArtFile({ 'album-art': 'https://x/y.png' }), null);
    assert.equal(_recArtFile({}), null);
  });

  it('the scheduled pill loads the schedule list without a playing station', () => {
    const block = appSrc.slice(appSrc.indexOf('(function _initSchedRecPoll()'), appSrc.indexOf('async function _pollSched()'));
    assert.match(block, /_loadScheduleList\(\);/);
    assert.match(appSrc, /t\('player\.rec\.needStation'\)/);
  });
});

describe('passkey sign-in completes like a password sign-in (N015/N083)', () => {
  const run = async () => {
    const order = [];
    const ctx = loadFns(['_storeToken', '_completeLogin', 'tryPasskeyLogin'], {
      S: {}, window: {
        SimpleWebAuthnBrowser: { browserSupportsWebAuthn: () => true, startAuthentication: async () => ({ id: 'c' }) },
        I18N: { setUser: async u => order.push('lang:' + u) },
      },
      fetch: async url => ({ ok: true, json: async () => (url.endsWith('/options') ? { challenge: 'ch' } : { token: 'tok', username: 'ann', vpaths: ['Music'] }) }),
      localStorage: memStorage(), _djKey: k => k, t: k => k,
      _loadFeatureFlags: async () => order.push('flags'), _loadServerSettings: async () => order.push('settings'),
    });
    await ctx.tryPasskeyLogin();
    return { ctx, order };
  };

  it('loads flags, server settings and the user language', async () => {
    const { ctx, order } = await run();
    assert.deepEqual(order, ['flags', 'settings', 'lang:ann']);
    assert.equal(ctx.S.token, 'tok');
    assert.deepEqual(plain(ctx.S.djVpaths), ['Music']);
    assert.equal(ctx.localStorage.getItem('token'), 'tok');
  });

  it('tryLogin uses the same helper', () => {
    assert.match(topLevelSource('tryLogin'), /await _completeLogin\(d\.token, username, d\.vpaths\);/);
  });

  it('refuses without WebAuthn using a translated message', async () => {
    const ctx = loadFns(['tryPasskeyLogin'], { window: {}, t: k => k });
    await assert.rejects(ctx.tryPasskeyLogin(), /player\.login\.passkeyUnsupported/);
  });
});

describe('password change keeps the session (v-B contract)', () => {
  it('stores the new token the server returns', () => {
    const ls = memStorage();
    const ctx = loadFns(['_storeToken'], { S: {}, localStorage: ls });
    ctx._storeToken('new');
    assert.equal(ctx.S.token, 'new');
    assert.equal(ls.getItem('ms2_token'), 'new');
    assert.equal(ls.getItem('token'), 'new');
    assert.match(appSrc, /const r = await api\('POST', 'api\/v1\/auth\/change-password', \{ currentPassword: cur, newPassword: nw \}\);\s*\n\s*if \(r\?\.token\) _storeToken\(r\.token\);/);
  });
});

describe('genre sections come from the server groups (N092)', () => {
  it('adds an Other section for genres in no group and has no client classifier', () => {
    const { _genreSectionsWithOther: f } = loadFns(['_genreSectionsWithOther'], { t: k => k });
    const out = f([{ name: 'Rock', genres: [{ genre: 'Punk', cnt: 2 }] }], [{ genre: 'Punk', cnt: 2 }, { genre: 'Polka', cnt: 1 }], g => g.genre);
    assert.deepEqual(plain(out), [{ name: 'Rock', genres: [{ genre: 'Punk', cnt: 2 }] }, { name: 'player.smart.genreOther', genres: [{ genre: 'Polka', cnt: 1 }] }]);
    assert.deepEqual(plain(f(null, ['a'], g => g)), [{ name: 'player.smart.genreOther', genres: ['a'] }]);
    assert.doesNotMatch(appSrc, /GENRE_BUCKETS|classifyGenre/);
  });
});

describe('logout clears the admin token mirror (N016)', () => {
  it('removes "token" and tells the other tabs', () => {
    const block = appSrc.slice(appSrc.indexOf("getElementById('logout-btn').addEventListener"), appSrc.indexOf('// Scan button (admin)'));
    assert.match(block, /localStorage\.removeItem\('token'\);/);
    assert.match(block, /new BroadcastChannel\('velvet'\)\.postMessage\(\{ type: 'logout' \}\)/);
  });
});

describe('crossfade / gapless handoff (N017/N019)', () => {
  function handoff(extra = {}) {
    const removed = [];
    const timers = [];
    const oldEl = { volume: 1, pause() { this.paused = true; }, removeAttribute(a) { this[a] = undefined; }, load() { this.loaded = true; }, remove() { removed.push(this); }, src: 'old', duration: 200 };
    const newEl = { paused: false, play: () => Promise.resolve() };
    const oldGain = { disconnect() { this.disconnected = true; } };
    const newGain = { gain: {} };
    const { api, calls } = makeApiStub();
    const env = {
      S: { queue: [{ filepath: 'a' }, { filepath: 'b' }], idx: 0, gapless: false, castingToMpv: false, castingToSonos: false, autoDJ: false },
      audioEl: oldEl, _xfadeEl: newEl, _curElGain: oldGain, _nextElGain: newGain,
      _xfadeStartVol: 0.7, _wrappedEventId: 5, _wrappedTrackStartOffset: 0, _wrappedPodcastEventId: null,
      api, setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: () => {},
      clearInterval: () => {}, ...extra,
    };
    const out = runInScope(['_retireAudioEl', '_doXfadeHandoff'], env);
    out._doXfadeHandoff(1);
    return { env, oldEl, newEl, oldGain, newGain, removed, timers, calls };
  }

  it('promotes the incoming element and its gain node', () => {
    const { env, newEl, oldGain, newGain } = handoff();
    assert.equal(env.audioEl, newEl);
    assert.equal(newEl.volume, 0.7);
    assert.equal(env._curElGain, newGain);
    assert.equal(env._nextElGain, null);
    assert.equal(oldGain.disconnected, true);
    assert.equal(env.S.idx, 1);
    assert.equal(env._xfadeEl, null);
  });

  it('sends play-end for the outgoing track', () => {
    const { calls } = handoff();
    const end = calls.find(c => c.path === 'api/v1/wrapped/play-end');
    assert.deepEqual(plain(end.body), { eventId: 5, playedMs: 200000 });
  });

  it('takes the retired element out of the document after the ramp', () => {
    const { oldEl, removed, timers } = handoff();
    assert.equal(oldEl.paused, true);
    assert.equal(removed.length, 0);
    timers.find(t => t.ms === 1000).f();
    assert.deepEqual(removed, [oldEl]);
    assert.equal(oldEl.src, undefined);
    assert.equal(oldEl.loaded, true);
  });
});

describe('radio and podcast fields survive the saved queue (N018)', () => {
  const ctx = loadFns(['_QUEUE_COMPACT_FIELDS', '_compactQueueSong', '_radioLinksOf'], {});
  it('keeps the stream links and ids', () => {
    const c = ctx._compactQueueSong({ filepath: 'http://a', isRadio: true, _radioLinks: ['http://a', 'http://b'], _radioLinkIdx: 1, _radioStationId: 4 });
    assert.deepEqual(plain(c._radioLinks), ['http://a', 'http://b']);
    assert.equal(c._radioLinkIdx, 1);
    assert.equal(c._radioStationId, 4);
    const p = ctx._compactQueueSong({ filepath: 'http://e', isPodcast: true, _episodeId: 9, _feedId: 2 });
    assert.equal(p._episodeId, 9);
    assert.equal(p._feedId, 2);
  });
  it('falls back to the filepath as the only link', () => {
    assert.deepEqual(plain(ctx._radioLinksOf({ filepath: 'http://a' })), ['http://a']);
  });
});

describe('scan progress without the removed counting phase (N036/N104)', () => {
  it('renders the file count and no Counting state', () => {
    const wrap = { innerHTML: '' };
    const ctx = loadFns(['esc', '_renderScanProgress'], { document: { getElementById: () => wrap }, t: (k, p) => `${k}${p ? JSON.stringify(p) : ''}` });
    ctx._renderScanProgress([{ vpath: 'Music', pct: null, scanned: 0, countingFound: 10, expected: 0 }]);
    assert.doesNotMatch(wrap.innerHTML, /counting|filesFound/);
    assert.match(wrap.innerHTML, /player\.scan\.files/);
    const en = JSON.parse(fs.readFileSync(new URL('../webapp/locales/en.json', import.meta.url), 'utf8'));
    assert.equal(en['player.scan.counting'], undefined);
    assert.equal(en['player.scan.filesFound'], undefined);
  });
});

describe('no hard-coded English in the touched player strings (N009/N055/N082)', () => {
  it('uses keys for the upload, copy, DJ tag, channels, spectrum and passkey texts', () => {
    for (const s of ['`Not allowed: ', '</svg> Copied!`', "'Stereo'", "'L+R Spectrogram'", "'Bar Spectrum'", "_bootMsg('Ready!')",
      "'WebAuthn not supported'", "'Passkey verification failed'", "row2('Firmware'", '`Track ${cp.no}`', "return 'Daily'", '} min &bull;']) {
      assert.ok(!appSrc.includes(s), s);
    }
  });
  it('labels a schedule with translated day names', () => {
    const { _recurLabel } = loadFns(['_recurLabel'], { t: k => k.split('.').pop() });
    assert.equal(_recurLabel('daily'), 'recEveryDay');
    assert.equal(_recurLabel('custom', [0, 6]), 'recSun, recSat');
  });
});

describe('i18n engine (N056/N057/N065)', () => {
  const src = fs.readFileSync(new URL('../webapp/assets/js/i18n.js', import.meta.url), 'utf8');
  const load = (files = {}) => {
    const window = { addEventListener() {}, location: { origin: 'https://v' } };
    const ctx = vm.createContext({
      window, localStorage: memStorage(), navigator: { language: 'nl-NL' },
      document: { querySelectorAll: () => [], getElementById: () => null, body: null },
      fetch: async url => {
        const code = url.split('/').pop().replace('.json', '');
        if (!(code in files)) throw new Error('offline');
        return { ok: true, text: async () => files[code] };
      },
      console: { error() {} },
    });
    // eslint-disable-next-line sonarjs/code-eval
    vm.runInContext(src, ctx);
    return window.I18N;
  };

  it('inserts $-sequences in a value literally', async () => {
    const I18N = load({ en: JSON.stringify({ 'a.b': 'Added {{title}} to {{list}}' }) });
    await I18N.loadLanguage('en');
    assert.equal(I18N.t('a.b', { title: 'Ca$$h $& Co', list: "$`x$'" }), "Added Ca$$h $& Co to $`x$'");
    assert.equal(I18N.t('a.b', { title: 'T' }), 'Added T to {{list}}');
  });

  it('picks plural forms and falls back to English and then the key', async () => {
    const I18N = load({
      en: JSON.stringify({ n: { one: '{{count}} song', other: '{{count}} songs' }, only: 'English' }),
      nl: JSON.stringify({ n: { one: '{{count}} nummer', other: '{{count}} nummers' } }),
    });
    await I18N.loadLanguage('nl');
    assert.equal(I18N.t('n', { count: 1 }), '1 nummer');
    assert.equal(I18N.t('n', { count: 3 }), '3 nummers');
    assert.equal(I18N.t('only'), 'English');
    assert.equal(I18N.t('missing.key'), 'missing.key');
  });

  it('settles ready when the first language cannot be loaded', async () => {
    const I18N = load({ en: JSON.stringify({ x: 'y' }) });
    assert.equal(await I18N.loadLanguage('nl'), false);
    const r = await Promise.race([I18N.ready.then(() => 'ready'), new Promise(res => setTimeout(() => res('pending'), 50))]);
    assert.equal(r, 'ready');
  });
});

describe('Auto-DJ year anchor and empty-queue start (N058/N059)', () => {
  it('restores the year history next to the BPM history', () => {
    const ls = memStorage({ 'dj:year_history': '[1980,1990]', 'dj:bpm_history': '[120]' });
    const ctx = loadFns(['_restoreDjAnchors'], {
      localStorage: ls, _djKey: k => 'dj:' + k, _bpmAvg: a => a.reduce((x, y) => x + y, 0) / a.length,
      camelotNeighbours: () => null, _djGenreCat: g => g,
      $vars: { _bpmHistory: [], _bpmAnchor: null, _yearHistory: [], _yearAnchor: null, _camelotAnchor: null, _camelotAnchorNeighbours: null, _djGenreHistory: [], _djFamilyHistory: [] },
    });
    ctx._restoreDjAnchors();
    assert.deepEqual(plain(ctx.$._yearHistory), [1980, 1990]);
    assert.equal(ctx.$._yearAnchor, 1985);
    assert.equal(ctx.$._bpmAnchor, 120);
  });

  it('starts Auto-DJ on an empty queue and fetches a song', () => {
    let fetched = 0; const toasts = [];
    const env = {
      S: { queue: [], idx: -1, vpaths: [], vpathMeta: {} }, _room: null, audioEl: { src: '' },
      toast: m => toasts.push(m), t: k => k, autoDJFetch: () => { fetched++; },
      localStorage: memStorage(), _uKey: k => k, document: { getElementById: () => fakeEl(), querySelector: () => null },
    };
    const { setAutoDJ } = runInScope(['_isAudioBookSong', '_isMusicSong', 'setAutoDJ'], env);
    setAutoDJ(true);
    assert.deepEqual(toasts, []);
    assert.equal(env.S.autoDJ, true);
    assert.equal(fetched, 1);
  });

  it('still refuses while a radio station plays', () => {
    const toasts = [];
    const env = { S: { queue: [{ isRadio: true }], idx: 0, vpaths: [] }, toast: m => toasts.push(m), t: k => k };
    const { setAutoDJ } = runInScope(['_isAudioBookSong', '_isMusicSong', 'setAutoDJ'], env);
    setAutoDJ(true);
    assert.deepEqual(toasts, ['player.toast.djMusicOnly']);
  });
});

describe('textContent and toasts get unescaped values (N060/N078)', () => {
  it('no esc() inside parameters written with textContent or a toast', () => {
    assert.doesNotMatch(appSrc, /textContent = t\([^;]*esc\(/);
    assert.doesNotMatch(appSrc, /toast(?:Error)?\(t\([^;]*\{[^}]*esc\(/);
    assert.match(appSrc, /saveFolderCoverFailed', \{ msg: fcErr\?\.message \|\| t\('player\.misc\.failed'\) \}\)/);
  });
});

describe('recording delete permission is one helper (N061/N072)', () => {
  const ctx = loadFns(['canDeleteFp'], {
    S: { vpathMeta: {
      Music: { type: 'music' },
      Recordings: { type: 'recordings', allowRecordDelete: true, parentVpath: 'Music', filepathPrefix: 'Recordings/' },
      YT: { type: 'youtube', allowRecordDelete: true },
      Locked: { type: 'recordings', allowRecordDelete: false },
    } },
  });
  it('matches a child recordings vpath through its parent path', () => {
    assert.equal(ctx.canDeleteFp('Music/Recordings/show.opus'), true);
    assert.equal(ctx.canDeleteFp('Music/Rock/song.mp3'), false);
  });
  it('matches the file explorer path of the child and a root vpath', () => {
    assert.equal(ctx.canDeleteFp('Recordings/show.opus'), true);
    assert.equal(ctx.canDeleteFp('YT/clip.mp3'), true);
    assert.equal(ctx.canDeleteFp('Locked/x.opus'), false);
    assert.equal(ctx.canDeleteFp(undefined), false);
  });
  it('is used by the context menu and the file explorer', () => {
    assert.match(topLevelSource('showCtxMenu'), /const canDelete = canDeleteFp\(song\?\.filepath\);/);
    assert.equal((appSrc.match(/function canDeleteFp\(/g) || []).length, 1);
  });
});

describe('radio and Sonos parsing helpers (N072)', () => {
  it('builds radio search candidates in both orders', () => {
    const { _buildRadioSearchCandidates: f } = loadFns(['_buildRadioSearchCandidates'], {});
    assert.deepEqual(plain(f('JAMES HYPE & TITA LAU - DISCONNECTED (Remix)')), ['JAMES HYPE DISCONNECTED', 'DISCONNECTED Remix JAMES HYPE TITA LAU', 'DISCONNECTED', 'JAMES HYPE TITA LAU']);
    assert.deepEqual(plain(f('Blue Monday (New Order)')), ['Blue Monday', 'New Order']);
  });

  it('parses Sonos DIDL metadata', () => {
    const ctx = loadFns(['_sonosDecodeXml', '_sonosParseResMD', '_sonosNormalizeBrowseItems'], {});
    const resMD = '&lt;DIDL-Lite&gt;&lt;item id="10092020spotify%3aplaylist%3a1"&gt;&lt;dc:title&gt;Mix &amp;amp; Match&lt;/dc:title&gt;&lt;upnp:class&gt;object.container.playlistContainer&lt;/upnp:class&gt;&lt;desc id="cdudn"&gt;SA_RINCON3079_X&lt;/desc&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;';
    const p = ctx._sonosParseResMD({ resMD });
    assert.equal(p.cloudObjectId, '10092020spotify:playlist:1');
    assert.equal(p.contentTitle, 'Mix & Match');
    assert.equal(p.authToken, 'SA_RINCON3079_X');
    const [n] = ctx._sonosNormalizeBrowseItems([{ id: 'FV:2/3', title: 'raw', resMD, parentID: 'FV:2' }]);
    assert.equal(n.title, 'Mix & Match');
    assert.equal(n.isContainer, true);
    assert.equal(n.parentId, 'FV:2');
  });
});

describe('meters reuse their buffers (N062)', () => {
  it('returns the same time-domain buffer per analyser', () => {
    const ctx = loadFns(['_timeDomainBufs', '_timeDomainData'], {});
    let filled = 0;
    const an = { fftSize: 2048, getFloatTimeDomainData: () => { filled++; } };
    const a = ctx._timeDomainData(an);
    assert.equal(ctx._timeDomainData(an), a);
    assert.equal(a.length, 2048);
    assert.equal(filled, 2);
    assert.doesNotMatch(appSrc, /new Float32Array\(analyser\.fftSize\);\n\s+analyser\.getFloatTimeDomainData/);
  });
});

describe('shared artist album card and Last.fm extras (N069)', () => {
  it('builds one album card used by both pages', () => {
    const ctx = loadFns(['esc', '_artistAlbumCardHtml'], { _albArtUrl: () => null, noArtHtml: () => '<i></i>' });
    const html = ctx._artistAlbumCardHtml({ displayName: 'A & B', year: 1999, album_version: 'Deluxe' }, 4);
    assert.match(html, /data-alb-idx="4"/);
    assert.match(html, /A &amp; B/);
    assert.match(html, /1999<span class="alb-version-badge" title="Deluxe">Deluxe<\/span>/);
    assert.equal((appSrc.match(/class="alb-version-badge" title="\$\{esc\(alb\.album_version\)\}"/g) || []).length, 1);
    assert.equal((appSrc.match(/_deduplicateSimArtists\(simData/g) || []).length, 1);
  });
});

describe('jukebox pushes (N070)', () => {
  it('answers getPlaylist and getNowPlaying with the shared pushes', () => {
    const urls = [];
    const ctx = loadFns(['_pushJukeboxNowPlaying', '_pushJukeboxPlaylist', '_pushJukeboxState'], {
      S: { jukeCode: 'J', queue: [{ filepath: 'a', title: 'T' }], idx: 0 }, audioEl: { currentTime: 1, duration: 2, paused: false },
      fetch: (u, o) => { urls.push([u, JSON.parse(o.body)]); return Promise.resolve(); },
    });
    ctx._pushJukeboxState();
    assert.deepEqual(urls.map(u => u[0]), ['/api/v1/jukebox/update-now-playing', '/api/v1/jukebox/update-playlist']);
    assert.equal(urls[1][1].tracks[0].title, 'T');
    assert.match(appSrc, /msg\.command === 'getPlaylist'\)\s+_pushJukeboxPlaylist\(\);/);
    assert.match(appSrc, /msg\.command === 'getNowPlaying'\) _pushJukeboxNowPlaying\(\);/);
  });
});

describe('ReplayGain settings sync across devices (N075) and one gain formula (N079)', () => {
  it('collects and applies mode, preamp, clip and the YouTube format', () => {
    const ls = memStorage({ ms2_rg_mode_u: 'album', ms2_rg_preamp_u: '2', ms2_rg_clip_u: '0', ms2_ytdl_format_u: 'mp3' });
    const { _collectPrefs } = loadFns(['_collectPrefs'], { S: { username: 'u' }, localStorage: ls });
    const p = _collectPrefs();
    assert.deepEqual([p.rg_mode, p.rg_preamp, p.rg_clip, p.ytdl_format], ['album', '2', '0', 'mp3']);

    const env = { S: { username: 'u', vpaths: [], djVpaths: [] }, localStorage: memStorage(), document: { getElementById: () => null } };
    const { _applyServerSettings } = runInScope(['_applyServerSettings'], env);
    _applyServerSettings({ prefs: { rg_mode: 'album', rg_preamp: '1.5', rg_clip: '0', ytdl_format: 'mp3' } });
    assert.equal(env.S.rgMode, 'album');
    assert.equal(env.S.rgPreamp, 1.5);
    assert.equal(env.S.rgClip, false);
    assert.equal(env.localStorage.getItem('ms2_ytdl_format_u'), 'mp3');
  });

  const gain = S => loadFns(['_rgGain'], { S })._rgGain;
  it('picks album or track gain, falls back to the tag and caps to the peak', () => {
    const s = { rg: { trackGain: -6, truePeak: -1, albumGain: -4, albumPeak: -3, src: 'measured' } };
    assert.deepEqual(plain(gain({ rgEnabled: true, rgMode: 'track', rgPreamp: 0 })(s)), { db: -6, src: 'measured' });
    assert.deepEqual(plain(gain({ rgEnabled: true, rgMode: 'album', rgPreamp: 0 })(s)), { db: -4, src: 'measured' });
    assert.deepEqual(plain(gain({ rgEnabled: true, rgMode: 'album', rgPreamp: 8, rgClip: true })(s)), { db: 3, src: 'measured' });
    assert.deepEqual(plain(gain({ rgEnabled: true, rgPreamp: 1 })({ replaygain: -2 })), { db: -1, src: 'tag' });
    assert.equal(gain({ rgEnabled: false })(s), null);
    assert.equal(gain({ rgEnabled: true })({}), null);
  });
  it('is the only copy of the formula', () => {
    assert.match(topLevelSource('_mpvApplyAudioState'), /_rgGain\(s\)\?\.db \?\? null/);
    assert.match(topLevelSource('_applyRGGain'), /const rg = _rgGain\(s\);/);
    assert.equal((appSrc.match(/S\.rgMode === 'album' && s\.rg\.albumGain != null/g) || []).length, 1);
  });
});

describe('end-of-song sleep timer (N076)', () => {
  it('shows the end-of-song timer as active with a cancel button', () => {
    const v = topLevelSource('viewPlayback');
    assert.match(v, /const sleepActive = S\.sleepMins !== 0;/);
    assert.match(v, /S\.sleepMins === -1\s*\n?\s*\? t\('player\.sleep\.afterSong'\)/);
    assert.match(appSrc, /getElementById\('sleep-light'\)\.addEventListener\('click', \(\) => viewPlayback\(\)\);/);
  });
});

describe('command palette offers views in collapsed sections (N077)', () => {
  it('skips only feature-flagged (hidden) buttons', () => {
    const btn = (view, hidden) => ({ dataset: { view }, offsetParent: null, textContent: view, querySelector: () => null, closest: () => (hidden ? {} : null) });
    const ctx = loadFns(['_cmdkBuildItems'], {
      document: { querySelectorAll: () => [btn('transcode', false), btn('radio', true)], getElementById: () => null },
      t: k => k, _toggleShortcutsHelp: () => {},
    });
    const views = ctx._cmdkBuildItems().filter(i => i.group === 'views').map(i => i.label);
    assert.deepEqual(plain(views), ['transcode']);
  });
});

describe('removed shims and dead code (N080/N081)', () => {
  it('has no _syncQueue, _updateCastBtn or _mpvReapplyGain', () => {
    assert.doesNotMatch(appSrc, /function _syncQueue\(|_updateCastBtn|_mpvReapplyGain/);
  });
});

describe('MPV cast (N083)', () => {
  it('refuses an empty queue or a radio station', async () => {
    const toasts = [];
    const env = { S: { castingToMpv: false, queue: [{ isRadio: true }], idx: 0 }, toast: m => toasts.push(m), t: k => k };
    const { toggleMpvCast } = runInScope(['toggleMpvCast'], env);
    await toggleMpvCast();
    assert.deepEqual(toasts, ['player.toast.castQueueEmpty']);
    assert.equal(env.S.castingToMpv, false);
  });

  it('casts the current song at the current position', async () => {
    const loaded = [];
    const env = {
      S: { castingToMpv: false, castingToSonos: false, crossfade: 0, queue: [{ filepath: 'Music/a.mp3' }], idx: 0 },
      audioEl: { currentTime: 42, paused: false }, localStorage: memStorage(), _uKey: k => k, t: k => k, toast: () => {},
      _mpvLoadSong: async (fp, at) => { loaded.push([fp, at]); },
    };
    const { toggleMpvCast } = runInScope(['toggleMpvCast'], env);
    await toggleMpvCast();
    assert.equal(env.S.castingToMpv, true);
    assert.deepEqual(loaded, [['Music/a.mp3', 42]]);
  });

  it('builds the Sonos cast request from the current song', async () => {
    const { api, calls } = makeApiStub(() => ({}));
    const env = {
      S: { castingToSonos: true, sonosRoom: { ip: '10.0.0.5' }, queue: [{ filepath: 'Music/a.mp3', title: 'A', duration: 100 }], idx: 0 },
      api, setTimeout: () => 1, _sonosTakeCastReason: () => 'play', _handleCastResponse: () => {},
    };
    const { _sonosCastCurrent } = runInScope(['_sonosCastCurrent'], env);
    await _sonosCastCurrent(12.7, true);
    assert.equal(calls[0].path, 'api/v1/sonos/cast-queue');
    assert.deepEqual(plain(calls[0].body), { ip: '10.0.0.5', tracks: [{ filepath: 'Music/a.mp3', title: 'A', artist: '', album: '', aaFile: null, duration: 100 }], index: 0, seekTo: 12, paused: true, reason: 'play' });
  });
});
