import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFns, makeApiStub } from './helpers/fix-player-app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('ListenBrainz scrobble state follows the route answer', () => {
  const run = async (answer) => {
    const { api, calls } = makeApiStub(() => answer);
    let fire;
    const ctx = loadFns(['_scrobbleState', '_initScrobbleState', '_scrobbleOutcome', '_scheduleScrobble'], {
      S: { customWebhooksEnabled: [], listenbrainzEnabled: true, listenbrainzLinked: true }, api, _updateScrobbleUI: () => {},
      clearTimeout: () => {}, setTimeout: f => { fire = f; return 1; }, $vars: { scrobbleTimer: null },
    });
    ctx._scheduleScrobble({ filepath: 'Music/a.mp3' });
    await fire();
    assert.ok(calls.some(c => c.path === 'api/v1/listenbrainz/scrobble-by-filepath'));
    return ctx.$._scrobbleState.listenbrainz;
  };

  it('shows a refused scrobble as failed', async () => {
    assert.equal(await run({ scrobbled: false }), 'err');
  });
  it('shows an unlinked account as off', async () => {
    assert.equal(await run({ scrobbled: null }), 'off');
  });
  it('shows a sent scrobble as sent', async () => {
    assert.equal(await run({ scrobbled: true }), 'ok');
  });
});

describe('shared page error states', () => {
  const src = fs.readFileSync(path.join(ROOT, 'webapp/shared/app.js'), 'utf8');

  function el() {
    const classes = new Set();
    return {
      innerHTML: '', textContent: '', style: {}, children: [],
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: () => {}, contains: c => classes.has(c) },
      addEventListener: () => {}, appendChild: () => {}, querySelector: () => null, getBoundingClientRect: () => ({}),
    };
  }

  async function render(data) {
    const els = new Map();
    const get = id => {
      if (!els.has(id)) els.set(id, el());
      return els.get(id);
    };
    get('sh-data').textContent = JSON.stringify(data);
    const ctx = vm.createContext({
      document: { getElementById: get, documentElement: el(), addEventListener: () => {}, createElement: el, title: '' },
      localStorage: { getItem: () => null, setItem: () => {} },
      I18N: { loadLanguage: async () => {} },
      t: key => `[${key}]`,
      setTimeout, clearTimeout,
    });
    // eslint-disable-next-line sonarjs/code-eval
    vm.runInContext(src, ctx);
    await new Promise(r => setImmediate(r));
    return get('sh-main').innerHTML;
  }

  it('an expired link says so', async () => {
    const html = await render({ error: 'expired' });
    assert.match(html, /\[shared-page\.expired\]/);
    assert.match(html, /\[shared-page\.expiredHint\]/);
    assert.doesNotMatch(html, /notFound/);
  });

  it('an unknown link says it was not found', async () => {
    const html = await render({ error: 'not-found' });
    assert.match(html, /\[shared-page\.notFound\]/);
    assert.match(html, /\[shared-page\.notFoundHint\]/);
  });

  it('every message has a key in all 12 locales', () => {
    for (const lang of ['en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'ru', 'zh', 'ja', 'ko']) {
      const d = JSON.parse(fs.readFileSync(path.join(ROOT, `webapp/locales/${lang}.json`), 'utf8'));
      for (const k of ['shared-page.expired', 'shared-page.expiredHint', 'shared-page.notFound', 'shared-page.notFoundHint']) {
        assert.equal(typeof d[k], 'string', `${lang}: ${k}`);
      }
    }
  });
});

describe('room Auto-DJ with stored settings', () => {
  it('drops an inverted duration window instead of throwing', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-vp-units-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'default.json');
    fs.mkdirSync(path.join(dir, 'music'));
    fs.writeFileSync(file, JSON.stringify({
      secret: 'x'.repeat(20),
      folders: { Music: { root: path.join(dir, 'music') } },
      storage: { dbDirectory: path.join(dir, 'db'), albumArtDirectory: path.join(dir, 'art'), logsDirectory: path.join(dir, 'logs') },
    }));
    await (await import('../src/state/config.js')).setup(file);
    const { enforcedScope } = await import('../src/api/autodj.js');
    const scope = enforcedScope({ vpaths: [], username: 'u' }, { minDuration: 600, maxDuration: 120, minRating: 3 });
    assert.equal(scope.minDuration, undefined);
    assert.equal(scope.maxDuration, undefined);
    assert.equal(scope.minRating, 3);
    const ok = enforcedScope({ vpaths: [], username: 'u' }, { minDuration: 120, maxDuration: 600 });
    assert.equal(ok.minDuration, 120);
    assert.equal(ok.maxDuration, 600);
  });
});
