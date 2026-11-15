// Round 4 (t-webapp): audiobook speed popup, Sonos gated on the cast permission, Tizen token check,
// admin CSP-safe genre input, and locale texts that match the code.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { appSrc, loadFns, makeApiStub, tick } from './helpers/fix-player-app.mjs';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const locale = lang => JSON.parse(read(`webapp/locales/${lang}.json`));

describe('audiobook speed popup', () => {
  function fakePop() {
    const opts = [];
    const classes = new Set(['hidden']);
    const pop = {
      style: {},
      classList: { contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c) },
      set innerHTML(html) {
        this._html = html;
        opts.length = 0;
        for (const m of html.matchAll(/data-rate="([^"]+)"/g)) {
          const listeners = {};
          opts.push({ dataset: { rate: m[1] }, addEventListener: (ev, fn) => { listeners[ev] = fn; }, click: () => listeners.click() });
        }
      },
      get innerHTML() { return this._html; },
      querySelectorAll: () => opts,
    };
    return { pop, opts, classes };
  }

  it('defines AB_SPEEDS and renders one option per speed with the current one active', () => {
    const { pop, opts, classes } = fakePop();
    const applied = [];
    const ctx = loadFns(['AB_SPEEDS', '_toggleSpeedPop'], {
      S: { bookSpeed: 1.25 },
      document: { getElementById: id => (id === 'ab-speed-pop' ? pop : null) },
      window: { innerHeight: 800 },
      _applyBookSpeed: r => applied.push(r),
    });
    const btn = { getBoundingClientRect: () => ({ top: 700, left: 100 }) };
    ctx._toggleSpeedPop(btn);
    assert.deepEqual([...ctx.$.AB_SPEEDS], [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
    assert.equal(opts.length, 7);
    assert.match(pop.innerHTML, /class="ab-speed-opt active" data-rate="1.25">1.25×</);
    assert.match(pop.innerHTML, /data-rate="1">1×</);
    assert.equal(classes.has('hidden'), false);
    assert.equal(pop.style.bottom, '106px');

    opts[5].click();
    assert.deepEqual(applied, [1.75]);
    assert.equal(classes.has('hidden'), true);
  });
});

describe('Sonos output follows the cast permission', () => {
  const sonosState = extra => ({
    canCast: false, sonosEnabled: true, sonosRooms: [{ ip: 'kitchen.local', name: 'Kitchen' }], sonosDefaultRoom: null,
    serverAudioRunning: false, allowMpvCast: false, roomsAvailable: false, rooms: [], ...extra,
  });

  it('hides Sonos in the output picker without permission', () => {
    const ctx = loadFns(['_hasAnyOutput'], { S: sonosState(), $vars: { _room: null } });
    assert.equal(ctx._hasAnyOutput(), false);
    ctx.S.canCast = true;
    assert.equal(ctx._hasAnyOutput(), true);
  });

  it('takes the flag from server-playback/available', async () => {
    const { api } = makeApiStub(() => ({ enabled: false, running: false, allowed: true }));
    const ctx = loadFns(['_refreshServerAudioState'], {
      S: sonosState(), api, localStorage: { getItem: () => null }, _uKey: k => k, _updateOutputBtn: () => {},
    });
    await ctx._refreshServerAudioState();
    assert.equal(ctx.S.canCast, true);
  });

  it('does not probe Sonos routes for a user without permission', async () => {
    const { api, calls } = makeApiStub(() => ({ enabled: true, rooms: [] }));
    const nav = { classList: { toggle: (c, on) => { nav.hidden = on; } } };
    const ctx = loadFns(['_hasDetectedSonos', '_updateSonosRadioNavVisibility', '_refreshSonosNavDetection'], {
      S: sonosState({ token: 'x' }), api,
      document: { getElementById: () => nav },
      $vars: { _sonosNavReachable: true },
    });
    await ctx._refreshSonosNavDetection();
    assert.equal(calls.length, 0);
    assert.equal(nav.hidden, true);
  });

  it('treats a refused Sonos device list as no Sonos', async () => {
    const api = () => Promise.reject(new Error('HTTP 403'));
    const nav = { classList: { toggle: (c, on) => { nav.hidden = on; } } };
    const ctx = loadFns(['_hasDetectedSonos', '_updateSonosRadioNavVisibility', '_refreshSonosNavDetection'], {
      S: sonosState({ token: 'x', canCast: true }), api,
      document: { getElementById: () => nav },
      $vars: { _sonosNavReachable: true },
    });
    await ctx._refreshSonosNavDetection();
    assert.equal(ctx.S.sonosEnabled, false);
    assert.equal(nav.hidden, true);
    const showApp = appSrc.slice(appSrc.indexOf('const _castStateReady'), appSrc.indexOf('// Register Media Session action handlers'));
    assert.match(showApp, /\}\)\.catch\(\(\) => \{\s*S\.sonosEnabled = false;/);
  });

  it('only fetches the Sonos device list after the permission is known', () => {
    const start = appSrc.indexOf('const _castStateReady = _refreshServerAudioState();');
    assert.ok(start > 0);
    const chain = appSrc.slice(appSrc.indexOf('_castStateReady.then(', start), appSrc.indexOf('}).then(d => {', start));
    assert.match(chain, /S\.canCast \? api\('GET', 'api\/v1\/sonos\/devices'\) : null/);
  });
});

describe('Tizen auto-login', () => {
  const src = read('webapp/tizen/app.js');
  const body = parse(src, { ecmaVersion: 'latest', sourceType: 'script' }).body;
  const fnSrc = body.find(n => n.type === 'FunctionDeclaration' && n.id.name === '_tryAutoLogin');

  it('rejects an invalid token through the authenticated ping', async () => {
    const paths = [];
    const screens = [];
    const ctx = vm.createContext({
      S: { token: 'stale' },
      api: (m, p) => { paths.push(p); return Promise.reject(new Error('HTTP 401')); },
      showLoading() {}, hideLoading() {}, enterMain: () => screens.push('main'),
      showScreen: s => screens.push(s), setTimeout() {}, focusFirst() {}, el() {},
    });
    // eslint-disable-next-line sonarjs/code-eval
    vm.runInContext(src.slice(fnSrc.start, fnSrc.end), ctx);
    ctx._tryAutoLogin();
    await tick();
    assert.deepEqual(paths, ['/api/v1/ping']);
    assert.deepEqual(screens, ['login']);
    assert.equal(ctx.S.token, '');
  });
});

describe('admin genre input has no inline handlers', () => {
  it('styles focus with CSS instead of onfocus/onblur', () => {
    const admin = read('webapp/admin/index.js');
    assert.doesNotMatch(admin, /\son(focus|blur)=/);
    assert.match(admin, /class="ge-genre-input"/);
    assert.match(read('webapp/admin/index.css'), /\.ge-genre-input:focus\{/);
  });
});

describe('locale texts match the code', () => {
  const en = locale('en');
  const nl = locale('nl');

  it('AcousticBrainz rate matches RATE_DELAY_MS', () => {
    const delay = Number(read('src/util/ab-bpm-worker.mjs').match(/RATE_DELAY_MS\s*=\s*(\d+)/)[1]);
    const stated = Number(en['admin.bpmAnalysis.abDesc'].match(/about ([\d.]+) req\/s/)[1]);
    assert.ok(stated <= 1000 / delay && stated > 1000 / delay - 0.2, `stated ${stated} req/s vs ${1000 / delay} from the code`);
    assert.match(nl['admin.bpmAnalysis.abDesc'], new RegExp(String(stated).replace('.', ',')));
  });

  it('shelving is described as final (there is no unshelve route)', () => {
    assert.doesNotMatch(read('src/api/rg-analysis.js'), /rg\/unshelve/);
    for (const lang of ['en', 'nl']) assert.doesNotMatch(locale(lang)['admin.rg.shelveHint'], /[Uu]nshelve|ongedaan/);
  });

  it('genre enricher does not claim to fill genres by itself', () => {
    assert.doesNotMatch(en['admin.genreEnricher.desc'], /automatically/);
    assert.match(en['admin.genreEnricher.desc'], /Last\.fm, MusicBrainz and Discogs/);
    assert.doesNotMatch(nl['admin.genreEnricher.desc'], /^Fetches/);
  });
});
