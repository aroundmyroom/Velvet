import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEBAPP = path.join(REPO, 'webapp');
const read = (rel) => fs.readFileSync(path.join(WEBAPP, rel), 'utf8');
const locale = (code) => JSON.parse(read(`locales/${code}.json`));
const EN = locale('en');
const NL = locale('nl');
const RAW_KEY = /\b(?:mobile|tizen|player|settings)\.[A-Za-z][\w-]*(?:\.[\w-]+)*/;

class FakeEl {
  constructor(id = '', attrs = {}, text = '') {
    this.id = id;
    this.attrs = { ...attrs };
    this.innerHTML = '';
    this.textContent = text;
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.title = '';
    this.hidden = 'hidden' in attrs;
    this.children = [];
    const cls = new Set();
    this.classList = {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
      toggle: (c, on = !cls.has(c)) => (on ? cls.add(c) : cls.delete(c)),
    };
  }
  addEventListener() {}
  setPointerCapture() {}
  focus() {}
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  hasAttribute(n) { return n in this.attrs; }
  querySelectorAll(sel) { return sel === '[data-i18n]' ? this.children : []; }
  replaceChildren(frag) { this.innerHTML = frag.nodes.map((n) => n.html).join(''); }
}

function baseContext({ origin, fetchFile, store = {} }) {
  const els = new Map();
  const requested = [];
  const g = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, URLSearchParams, AbortSignal,
    location: { origin, pathname: '/mobile/', hash: '' },
    navigator: { language: 'en-US' },
    history: { replaceState() {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    DOMParser: class {
      parseFromString(html) { return { querySelectorAll: () => [], body: { childNodes: [{ html }] } }; }
    },
    i18nNodes: [],
    document: {
      cookie: '',
      documentElement: { lang: 'en' },
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, new FakeEl(id));
        return els.get(id);
      },
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === '[data-i18n]' ? g.i18nNodes : []),
      addEventListener() {},
      createDocumentFragment: () => ({ nodes: [], append(...n) { this.nodes.push(...n); } }),
    },
    addEventListener() {},
    fetch: (url) => {
      requested.push(url);
      const body = fetchFile(String(url));
      if (body instanceof Error) return Promise.reject(body);
      const ok = body !== undefined;
      return Promise.resolve({
        ok, status: ok ? 200 : 404,
        text: () => Promise.resolve(ok ? body : ''),
        json: () => Promise.resolve(ok ? JSON.parse(body) : {}),
      });
    },
  };
  g.window = g;
  vm.createContext(g);
  return { g, els, requested, store };
}

const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

describe('mobile PWA renders through the player i18n engine', () => {
  let ctx;
  // eslint-disable-next-line sonarjs/code-eval
  const run = (code) => vm.runInContext(code, ctx.g);
  const screen = () => ctx.els.get('screen').innerHTML;

  before(async () => {
    ctx = baseContext({
      origin: 'https://velvet.test',
      fetchFile: (url) => {
        const m = url.match(/^https:\/\/velvet\.test\/locales\/(\w+)\.json$/);
        if (m) return read(`locales/${m[1]}.json`);
        if (url === '/api/v1/languages/enabled') return JSON.stringify({ enabled: ['en', 'nl'] });
        return new Error('offline');
      },
    });
    run(read('assets/js/i18n.js'));
    run(read('mobile/app.js'));
    await settle();
  });

  it('index.html loads the shared engine before the app', () => {
    const html = read('mobile/index.html');
    assert.ok(html.indexOf('/assets/js/i18n.js') > 0 && html.indexOf('/assets/js/i18n.js') < html.indexOf('/mobile/app.js'));
  });

  it('boots in English', () => {
    assert.match(screen(), new RegExp(EN['mobile.connect.tagline']));
    assert.doesNotMatch(screen(), RAW_KEY);
  });

  it('a language switch re-renders the open screen and the stable shell in Dutch', async () => {
    await run("I18N.loadLanguage('nl')");
    await settle();
    assert.match(screen(), new RegExp(NL['mobile.connect.tagline']));
    assert.match(screen(), new RegExp(NL['player.misc.connect']));
    assert.equal(ctx.els.get('np-top-label').textContent, NL['player.player.nowPlaying']);
  });

  it('every screen renders in Dutch without a raw key', () => {
    run(`
      S.username = 'ann';
      S.albums = [{ id: 'a1', displayName: 'Blue', artist: 'Joni' }];
      S.stations = []; S.recentPlayed = []; S.recentFolders = [];
      S.currentAlbum = { displayName: 'Blue', artist: 'Joni', year: 1971, discs: [
        { discIndex: 1, tracks: [{ filepath: 'M/a.flac', title: '', duration: 120 }] },
        { discIndex: 2, tracks: [{ filepath: 'M/b.flac', duration: 300, cuepoints: [{ t: 0, no: 1 }, { t: 100, no: 2 }] }] },
      ] };
      S.searchRes = { artists: [{ name: 'Joni' }], folders: [{ folder_name: 'Blue', dirpath: 'M/Blue' }],
        albums: [{ id: 'a1', displayName: 'Blue' }], tracks: [{ filepath: 'M/a.flac', title: 'A', artist: '' }] };
      S.browseDir = '/M'; S.browseDirData = { directories: [], files: [] };
      S.transcodeOk = true;
      S.queue = [{ filepath: 'x', title: 'X' }, { filepath: 'y', title: '' }, { filepath: 'z', title: 'Z' }];
      S.queueIdx = 1;
    `);
    const expected = {
      home: ['mobile.home.userMusic', 'mobile.home.jumpBackIn'],
      library: ['mobile.nav.library', 'mobile.library.emptyFolder', 'mobile.library.back'],
      album: ['mobile.album.trackCount', 'player.fe.btnPlay'],
      search: ['player.search.tabFolders', 'player.search.tabTracks'],
      radio: ['mobile.radio.none'],
      you: ['mobile.you.signOut', 'settings.language', 'mobile.you.qualityOriginal'],
    };
    for (const [name, keys] of Object.entries(expected)) {
      run(`S.screen = '${name}'; _rerender();`);
      const html = screen();
      assert.doesNotMatch(html, RAW_KEY, `${name} screen shows a raw key`);
      for (const key of keys) {
        const nl = typeof NL[key] === 'object' ? NL[key].other : NL[key];
        const re = new RegExp(nl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\\\{\w+\\\}\\\}/g, '.+?'));
        assert.match(html, re, `${name} screen misses ${key}`);
      }
    }
    assert.match(screen(), /<option value="nl" selected>Nederlands<\/option>/);
    const album = (run("S.screen = 'album'; _rerender();"), screen());
    assert.match(album, /Disc 2/);
    assert.match(album, new RegExp(NL['mobile.album.track'].replace('{{n}}', '2')));
    const queue = run('_renderQueueView()');
    assert.doesNotMatch(queue, RAW_KEY);
    assert.match(queue, new RegExp(NL['mobile.queue.played'].one.replace('{{count}}', '1')));
    assert.match(queue, new RegExp(NL['player.misc.unknown']));
  });

  it('a user language set in the player is applied after login', async () => {
    ctx.store['velvet-lang_bob'] = 'en';
    await run("_finishLogin('https://velvet.test', 'bob', 'tok', [])");
    await settle();
    assert.equal(run('I18N.getLanguage()'), 'en');
    assert.match(screen(), new RegExp(EN['mobile.home.userMusic'].replace('{{name}}', 'bob')));
  });
});

function tizenI18nNodes(html) {
  const nodes = [];
  for (const m of html.matchAll(/<\w+(\s[^>]*)>([^<]*)/g)) {
    if (!m[1].includes('data-i18n=')) continue;
    const attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? '';
    nodes.push(new FakeEl('', attrs, m[2]));
  }
  return nodes;
}

describe('Tizen TV app loads its strings from the configured server', () => {
  const html = read('tizen/index.html');
  let ctx;
  let serverUp = true;
  // eslint-disable-next-line sonarjs/code-eval
  const run = (code) => vm.runInContext(code, ctx.g);
  const node = (key) => ctx.g.i18nNodes.find((n) => n.getAttribute('data-i18n') === key);

  before(() => {
    ctx = baseContext({
      origin: 'file://',
      fetchFile: (url) => {
        if (!serverUp) return new Error('unreachable');
        const m = url.match(/^https:\/\/tv\.example:3000\/locales\/(\w+)\.json$/);
        return m && fs.existsSync(path.join(WEBAPP, `locales/${m[1]}.json`)) ? read(`locales/${m[1]}.json`) : undefined;
      },
    });
    ctx.g.i18nNodes = tizenI18nNodes(html);
    const box = html.slice(html.indexOf('id="login-error"'), html.indexOf('</div>', html.indexOf('id="login-error"')));
    ctx.g.document.getElementById('login-error').children = tizenI18nNodes(box);
    run(read('tizen/app.js'));
  });

  it('every data-i18n key and t() key in the TV app exists in English and Dutch', () => {
    const keys = new Set([
      ...[...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]),
      ...[...read('tizen/app.js').matchAll(/\bt\('([\w.-]+)'/g)].map((m) => m[1]),
      ...[...read('tizen/app.js').matchAll(/showMessage\('[\w-]+', '([\w.-]+)'\)/g)].map((m) => m[1]),
    ]);
    assert.ok(keys.size > 30);
    for (const k of keys) {
      assert.ok(k in EN, `en.json misses ${k}`);
      assert.ok(k in NL, `nl.json misses ${k}`);
    }
  });

  it("switches to the user's language: markup, titles and rendered lists", async () => {
    ctx.store['velvet-lang_ann'] = 'nl';
    run("S.baseUrl = 'https://tv.example:3000'; S.username = 'ann';");
    await run('loadLocales()');
    assert.ok(ctx.requested.every((u) => u.startsWith('https://tv.example:3000/locales/')), ctx.requested.join(', '));
    assert.equal(ctx.g.document.documentElement.lang, 'nl');
    assert.equal(node('tizen.login.subtitle').textContent, NL['tizen.login.subtitle']);
    const prev = ctx.g.i18nNodes.find((n) => n.getAttribute('data-i18n') === 'player.ctrl.previous');
    assert.equal(prev.getAttribute('title'), NL['player.ctrl.previous']);
    run('_renderPlaylists([])');
    assert.match(ctx.els.get('playlists-list').innerHTML, new RegExp(NL['tizen.playlists.none']));
    assert.equal(run("t('mobile.album.trackCount', { count: 1 })"), NL['mobile.album.trackCount'].one.replace('{{count}}', '1'));
    assert.equal(run("t('tizen.autodj.playing', { title: '$& A' })"), NL['tizen.autodj.playing'].replace('{{title}}', () => '$& A'));
  });

  it('falls back to English when the language file is missing', async () => {
    ctx.store['velvet-lang_ann'] = 'xx';
    await run('loadLocales()');
    assert.equal(ctx.g.document.documentElement.lang, 'en');
    assert.equal(node('tizen.login.subtitle').textContent, EN['tizen.login.subtitle']);
    assert.equal(run("t('tizen.autodj.picking')"), EN['tizen.autodj.picking']);
  });

  it('keeps working when the server cannot be reached', async () => {
    serverUp = false;
    await run('loadLocales()');
    serverUp = true;
    assert.equal(run("t('tizen.autodj.picking')"), EN['tizen.autodj.picking']);
  });

  it('a login message is shown from the markup, so it reads before any locale loaded', () => {
    run("showMessage('login-error', 'tizen.login.connectFailed')");
    const spans = ctx.g.document.getElementById('login-error').children;
    assert.deepEqual(spans.filter((s) => !s.hidden).map((s) => s.getAttribute('data-i18n')), ['tizen.login.connectFailed']);
    assert.equal(spans.length, 3);
  });
});
