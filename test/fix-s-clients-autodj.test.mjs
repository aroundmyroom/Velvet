// P054: Tizen and Server Remote take Auto-DJ picks from the server, Tizen scrobbles like the web player,
// mobile sends ListenBrainz playing-now; plus the client sweep (no inline handlers, no dead helpers).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const tizenSrc = read('webapp/tizen/app.js');
const remoteSrc = read('webapp/server-remote/app.js');
const mobileSrc = read('webapp/mobile/app.js');
const tick = () => new Promise(r => setImmediate(r));
const plain = v => JSON.parse(JSON.stringify(v));

function declNames(n) {
  if (n.type === 'FunctionDeclaration') return [n.id.name];
  if (n.type === 'VariableDeclaration') return n.declarations.map(d => d.id.name);
  return [];
}

// Runs the named top-level declarations of a client file in ctx (let/const become var so tests can read them).
function slicer(src, sourceType) {
  const body = parse(src, { ecmaVersion: 'latest', sourceType }).body;
  return (list, ctx) => {
    const code = list.map(name => {
      const node = body.find(n => declNames(n).includes(name));
      if (!node) throw new Error(`not found: ${name}`);
      return src.slice(node.start, node.end).replace(/^(const|let) /, 'var ');
    }).join('\n');
    // eslint-disable-next-line sonarjs/code-eval
    vm.runInContext(code, ctx);
  };
}
const tizenFns = slicer(tizenSrc, 'script');
const remoteFns = slicer(remoteSrc, 'script');
const mobileFns = slicer(mobileSrc, 'module');

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].live = false; },
    fire() { for (const t of timers.filter(x => x.live)) { t.live = false; t.fn(); } },
  };
}

function apiStub(handler = () => ({})) {
  const calls = [];
  const api = (method, path, body) => {
    calls.push({ method, path: path.replace(/^\//, ''), body: body === undefined ? undefined : plain(body) });
    try { return Promise.resolve(handler(method, path.replace(/^\//, ''), body)); } catch (e) { return Promise.reject(e); }
  };
  return { api, calls };
}

describe('Tizen Auto-DJ asks the server (P054)', () => {
  it('has no client-side scoring left', () => {
    assert.doesNotMatch(tizenSrc, /_CAMELOT|camelotNeighbours|_djScoreSong|_djSongBlocked|_bpmAnchor|db\/random-songs|similar-artists|autoDjIgnoreList/);
  });

  const load = (handler) => {
    const { api, calls } = apiStub(handler);
    const timers = fakeTimers();
    const status = { textContent: '' };
    const played = [];
    const ctx = vm.createContext({
      api, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, t: (k) => k,
      S: { autoDj: true, queue: [], queueIdx: -1 },
      el: () => status,
      _loadAndPlay: t => played.push(t.filepath),
    });
    tizenFns(['DJ_RECENT_MAX', '_djRecent', '_djResetSession', '_djTrackFromSong', '_djAcceptPick', '_autoDjPick'], ctx);
    return { ctx, calls, played, status, timers };
  };
  const song = fp => ({ filepath: fp, metadata: { title: fp.toUpperCase(), artist: 'A', album: 'B', 'album-art': 'x.jpg' } });

  it('starts without a seed, then seeds on the last queued song and sends what it played', async () => {
    let n = 0;
    const { ctx, calls, played } = load(() => ({ song: song(`Music/s${++n}.mp3`) }));
    ctx._autoDjPick();
    await tick();
    assert.deepEqual(calls[0], { method: 'POST', path: 'api/v1/autodj/next', body: { recent: [] } });
    assert.deepEqual(played, ['Music/s1.mp3']);
    assert.deepEqual(plain(ctx.S.queue[0]), { filepath: 'Music/s1.mp3', title: 'MUSIC/S1.MP3', artist: 'A', album: 'B', artFile: 'x.jpg' });

    ctx._autoDjPick();
    await tick();
    assert.deepEqual(calls[1].body, { recent: ['Music/s1.mp3'], seedFilepath: 'Music/s1.mp3' });
    assert.equal(ctx.S.queue.length, 2);
    assert.equal(played.length, 1, 'a later pick is queued, not played');

    ctx._autoDjPick();
    await tick();
    assert.deepEqual(calls[2].body, { recent: ['Music/s1.mp3', 'Music/s2.mp3'], seedFilepath: 'Music/s2.mp3' });
  });

  it('keeps at most 200 recent songs', () => {
    const { ctx } = load();
    ctx.S.queueIdx = 0;
    for (let i = 0; i < 205; i++) ctx._djAcceptPick(song(`Music/${i}.mp3`));
    assert.equal(ctx._djRecent.length, 200);
    assert.equal(ctx._djRecent[0], 'Music/5.mp3');
  });

  it('reports an empty library and retries after an error', async () => {
    const empty = load(() => ({ song: null }));
    empty.ctx._autoDjPick();
    await tick();
    assert.equal(empty.status.textContent, 'tizen.autodj.noSongs');
    assert.equal(empty.ctx.S.queue.length, 0);

    const failing = load(() => { throw new Error('HTTP 500'); });
    failing.ctx._autoDjPick();
    await tick();
    assert.equal(failing.timers.timers[0].ms, 5000);
  });

  it('drops a pick that arrives after Auto-DJ was switched off', async () => {
    const { ctx, played } = load(() => ({ song: song('Music/late.mp3') }));
    ctx._autoDjPick();
    ctx.S.autoDj = false;
    await tick();
    assert.equal(played.length, 0);
  });
});

describe('Tizen scrobbles like the web player (P054)', () => {
  const load = (status) => {
    const { api, calls } = apiStub((m, p) => status[p] || {});
    const timers = fakeTimers();
    const ctx = vm.createContext({ api, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, S: {} });
    tizenFns(['_scrobbleTimer', '_loadScrobbleStatus', '_scheduleScrobble'], ctx);
    return { ctx, calls, timers };
  };

  it('reads the same status routes as the web player', async () => {
    const { ctx } = load({ 'api/v1/lastfm/status': { serverEnabled: true }, 'api/v1/listenbrainz/status': { serverEnabled: true, linked: true }, 'api/v1/multi-scrobbler/status': { serverEnabled: true, enabled: false } });
    ctx._loadScrobbleStatus();
    await tick();
    assert.deepEqual(plain(ctx.S), { lastfmEnabled: true, listenbrainzEnabled: true, listenbrainzLinked: true, multiScrobblerEnabled: false });
  });

  it('sends multi-scrobbler playing-now at once and its scrobble after 30 s when active', () => {
    const { ctx, calls, timers } = load({});
    Object.assign(ctx.S, { lastfmEnabled: false, listenbrainzEnabled: false, listenbrainzLinked: false, multiScrobblerEnabled: true });
    ctx._scheduleScrobble('Music/a.mp3');
    assert.deepEqual(calls.map(c => c.path), ['api/v1/multi-scrobbler/playing-now']);
    assert.equal(timers.timers[0].ms, 30000);
    timers.fire();
    assert.deepEqual(calls.slice(1), [
      { method: 'POST', path: 'api/v1/multi-scrobbler/scrobble-by-filepath', body: { filePath: 'Music/a.mp3' } },
    ]);
  });

  it('sends ListenBrainz playing-now at once and both scrobbles after 30 s', () => {
    const { ctx, calls, timers } = load({});
    Object.assign(ctx.S, { lastfmEnabled: true, listenbrainzEnabled: true, listenbrainzLinked: true });
    ctx._scheduleScrobble('Music/a.mp3');
    assert.deepEqual(calls.map(c => c.path), ['api/v1/listenbrainz/playing-now']);
    assert.equal(timers.timers[0].ms, 30000);
    timers.fire();
    assert.deepEqual(calls.slice(1), [
      { method: 'POST', path: 'api/v1/lastfm/scrobble-by-filepath', body: { filePath: 'Music/a.mp3' } },
      { method: 'POST', path: 'api/v1/listenbrainz/scrobble-by-filepath', body: { filePath: 'Music/a.mp3' } },
    ]);
  });

  it('skips ListenBrainz when the user is not linked and cancels the old timer on a new song', () => {
    const { ctx, calls, timers } = load({});
    Object.assign(ctx.S, { lastfmEnabled: true, listenbrainzEnabled: true, listenbrainzLinked: false });
    ctx._scheduleScrobble('Music/a.mp3');
    ctx._scheduleScrobble('Music/b.mp3');
    timers.fire();
    assert.deepEqual(calls, [{ method: 'POST', path: 'api/v1/lastfm/scrobble-by-filepath', body: { filePath: 'Music/b.mp3' } }]);
  });

  it('does nothing when both are off', () => {
    const { ctx, calls, timers } = load({});
    Object.assign(ctx.S, { lastfmEnabled: false, listenbrainzEnabled: false, listenbrainzLinked: false });
    ctx._scheduleScrobble('Music/a.mp3');
    assert.equal(timers.timers.length, 0);
    assert.equal(calls.length, 0);
  });

  it('schedules from the play-statistics start and on login', () => {
    assert.match(tizenSrc, /function _statsStart\(track\) \{[\s\S]*?_scheduleScrobble\(fp\);\n\}/);
    assert.match(tizenSrc, /function enterMain\(\) \{\n\s+_loadScrobbleStatus\(\);/);
  });
});

describe('Server Remote Auto-DJ asks the server (P054)', () => {
  it('has no random-songs or Last.fm lookup left', () => {
    assert.doesNotMatch(remoteSrc, /db\/random-songs|similar-artists|_djIgnore/);
  });

  const run = async (mode, status) => {
    const { api, calls } = apiStub((m, p) => (p === 'api/v1/autodj/next'
      ? { song: { filepath: 'Music/n.mp3', metadata: { title: 'N', artist: 'A', 'album-art': 'n.jpg' } } } : {}));
    const ctx = vm.createContext({ api, t: (k) => k, updateDjStatus() {}, _djMode: mode, _djFetching: false });
    remoteFns(['fetchDjSong'], ctx);
    ctx.fetchDjSong(status);
    await tick(); await tick();
    return calls.map(({ path, body }) => ({ path, body }));
  };
  const status = { currentIndex: 0, queue: [{ relPath: 'Music/a.mp3' }, { relPath: 'Music/b.mp3' }] };

  it('random mode sends the queue as recent, without a seed', async () => {
    const calls = await run('random', status);
    assert.deepEqual(calls[0], { path: 'api/v1/autodj/next', body: { recent: ['Music/a.mp3', 'Music/b.mp3'] } });
    assert.deepEqual(calls[1], { path: 'api/v1/server-playback/queue/add', body: { filepath: 'Music/n.mp3', title: 'N', artist: 'A', album: '', albumArt: 'n.jpg' } });
  });

  it('similar mode seeds on the last queued song', async () => {
    const calls = await run('similar', status);
    assert.deepEqual(calls[0].body, { recent: ['Music/a.mp3', 'Music/b.mp3'], seedFilepath: 'Music/b.mp3' });
  });
});

describe('Server Remote queue moves share one path', () => {
  const load = output => {
    const calls = [];
    const handed = [];
    const ctx = vm.createContext({
      _output: output, _lastStatus: null,
      api: (m, p) => { calls.push(p); return Promise.resolve(p.endsWith('/status') ? { currentIndex: 1, queue: [{ relPath: 'x' }, { relPath: 'y' }] } : {}); },
      sonosCastCurrent: c => handed.push(['sonos', c.relPath]),
      webLoadSong: c => handed.push(['web', c.relPath]),
    });
    remoteFns(['currentEntry', 'playOnOutput', 'moveQueue', 'doNext', 'doPrev', 'playIdx'], ctx);
    return { ctx, calls, handed };
  };

  it('mpv only moves the server queue', async () => {
    const { ctx, calls, handed } = load('mpv');
    ctx.doNext();
    await tick();
    assert.deepEqual(calls, ['api/v1/server-playback/next']);
    assert.equal(handed.length, 0);
  });

  it('sonos and web pause mpv and hand over the new current song', async () => {
    for (const out of ['sonos', 'web']) {
      const { ctx, calls, handed } = load(out);
      ctx.playIdx(1);
      await tick(); await tick(); await tick();
      assert.deepEqual(calls, ['api/v1/server-playback/queue/play-index', 'api/v1/server-playback/set-pause', 'api/v1/server-playback/status']);
      assert.deepEqual(handed, [[out, 'y']]);
    }
  });
});

describe('mobile ListenBrainz like the web player (P054)', () => {
  it('stores the switch and the link separately', async () => {
    const S = {};
    const API = { get: p => Promise.resolve(p.includes('listenbrainz') ? { serverEnabled: true, linked: false } : p.includes('multi-scrobbler') ? { serverEnabled: true, enabled: true } : { serverEnabled: true }) };
    const ctx = vm.createContext({ S, API });
    mobileFns(['_loadScrobbleStatus'], ctx);
    await ctx._loadScrobbleStatus();
    assert.deepEqual(plain(S), { lastfmEnabled: true, listenbrainzEnabled: true, listenbrainzLinked: false, multiScrobblerEnabled: true });
  });

  it('sends playing-now and scrobbles ListenBrainz only when linked', () => {
    const block = mobileSrc.slice(mobileSrc.indexOf('clearTimeout(this._scrobbleTimer);'), mobileSrc.indexOf('}, 30000);'));
    assert.match(block, /const lb = S\.listenbrainzEnabled && S\.listenbrainzLinked;/);
    assert.match(block, /if \(lb\) API\.post\('\/api\/v1\/listenbrainz\/playing-now', \{ filePath: fp \}\)/);
    assert.match(block, /if \(lb\)\s+API\.post\('\/api\/v1\/listenbrainz\/scrobble-by-filepath'/);
  });

  it('sends multi-scrobbler playing-now and scrobble only when active', () => {
    const block = mobileSrc.slice(mobileSrc.indexOf('clearTimeout(this._scrobbleTimer);'), mobileSrc.indexOf('}, 30000);'));
    assert.match(block, /const ms = S\.multiScrobblerEnabled;/);
    assert.match(block, /if \(S\.lastfmEnabled \|\| lb \|\| ms\)/);
    assert.match(block, /if \(ms\) API\.post\('\/api\/v1\/multi-scrobbler\/playing-now', \{ filePath: fp \}\)/);
    assert.match(block, /if \(ms\)\s+API\.post\('\/api\/v1\/multi-scrobbler\/scrobble-by-filepath'/);
  });
});

describe('client sweep', () => {
  it('Tizen builds no inline onerror handlers and has one escape helper', () => {
    assert.doesNotMatch(tizenSrc, /\son[a-z]+=["\\']/);
    assert.doesNotMatch(tizenSrc, /_escAttr|_viewHistory/);
    assert.match(tizenSrc, /document\.addEventListener\('error', function\(e\) \{\n\s+if \(e\.target\.classList && e\.target\.classList\.contains\('album-card-art'\)\) e\.target\.style\.display = 'none';\n\}, true\);/);
  });

  it('Server Remote has no dead state and one unload POST helper', () => {
    assert.doesNotMatch(remoteSrc, /_vpaths|_noAuth|_webCurPath|function esc\(/);
    assert.equal((remoteSrc.match(/new XMLHttpRequest\(\)/g) || []).length, 1);
    assert.equal((remoteSrc.match(/currentIndex>=0\?/g) || []).length, 1);
  });

  it('mobile navigate has no unused locals', () => {
    assert.doesNotMatch(mobileSrc, /isMain|mainScreens/);
  });
});
