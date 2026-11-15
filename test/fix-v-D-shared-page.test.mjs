// N141: the shared page script loads and shows "not found" when the server sends no playlist; strings are translated.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../webapp/shared/app.js', import.meta.url), 'utf8');

function element(id) {
  const el = {
    id, textContent: '', innerHTML: '', value: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, appendChild() {}, querySelectorAll: () => [],
    querySelector: () => element(''), play: async () => {}, pause() {}, children: [],
  };
  return el;
}

function page(shData) {
  const els = new Map();
  const get = (id) => {
    if (!els.has(id)) els.set(id, element(id));
    return els.get(id);
  };
  get('sh-data').textContent = shData;
  const ctx = {
    document: {
      title: '',
      getElementById: get,
      addEventListener() {},
      documentElement: { classList: { toggle() {}, contains: () => false } },
      createElement: () => element(''),
      body: element('body'),
    },
    localStorage: { getItem: () => null, setItem() {} },
    I18N: { loadLanguage: async () => true },
    t: (key, p) => (p ? `${key}:${JSON.stringify(p)}` : key),
    setTimeout, clearTimeout, console, fetch: async () => ({ ok: false }),
  };
  vm.createContext(ctx);
  return { ctx, get };
}

describe('shared page boot (N141)', () => {
  it('an expired or unknown link loads without a TypeError and renders the translated not-found message', async () => {
    const { ctx, get } = page('');
    // eslint-disable-next-line sonarjs/code-eval
    assert.doesNotThrow(() => vm.runInContext(src, ctx));
    await new Promise((r) => setImmediate(r));
    assert.match(get('sh-main').innerHTML, /shared-page\.notFound/);
    assert.match(get('sh-main').innerHTML, /shared-page\.notFoundHint/);
    assert.equal(ctx.document.title, 'Velvet – shared-page.title');
  });

  it('a valid link counts its songs through t()', async () => {
    const { ctx, get } = page(JSON.stringify({ token: 'tok', playlist: ['Music/a.mp3', 'Music/b.mp3'] }));
    // eslint-disable-next-line sonarjs/code-eval
    vm.runInContext(src, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(get('sh-pl-count').textContent, 'shared-page.songCount:{"count":2}');
    assert.equal(get('sh-count').textContent, 'shared-page.trackOf:{"n":1,"total":2}');
    assert.match(get('audio').src, /\?token=tok$/);
  });
});
