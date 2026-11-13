/**
 * VoltViz mode in the player (webapp/app.js): style choice, remembered style and failure handling.
 * The VoltViz block is evaluated from the app source against a stubbed renderer module.
 *
 * Run with:
 *   node --test test/voltviz-player.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../webapp/app.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('// ── VOLTVIZ RENDERER'), src.indexOf('// ── Lyric helpers'));

const STYLES = [
  { id: 'bars', name: 'Bars', group: 'canvas', webgpu: false },
  { id: 'tunnel', name: 'Tunnel', group: 'webgl', webgpu: false },
  { id: 'kaleidoscope', name: 'Kaleidoscope', group: 'webgl', webgpu: false },
  { id: 'pulsar', name: 'Pulsar', group: 'webgpu', webgpu: true },
];

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function makeRenderer({ failing = [], pending = {}, createGate = null } = {}) {
  const created = [];
  const mod = {
    listVisualizers: () => STYLES,
    async createVoltViz(opts) {
      if (createGate) await createGate.promise;
      if (failing.includes(opts.visualizer)) throw new Error(`cannot start ${opts.visualizer}`);
      const inst = {
        visualizer: opts.visualizer,
        destroyed: false,
        seq: 0,
        // Like the adapter: a request overtaken by a newer one neither mounts nor throws.
        async setVisualizer(id) {
          const mine = ++inst.seq;
          if (pending[id]) await pending[id].promise;
          if (mine !== inst.seq) return;
          if (failing.includes(id)) throw new Error(`cannot start ${id}`);
          inst.visualizer = id;
        },
        resize() {},
        setBpm() {},
        destroy() { inst.destroyed = true; },
      };
      created.push(inst);
      return inst;
    },
  };
  return { mod, created };
}

function makePlayer(renderer, stored = null) {
  const els = {
    'viz-preset-name': { textContent: '' },
    'vv-status': { textContent: '', classList: { toggle() {} } },
    'viz-vv-select': { value: '', options: [], classList: { remove() {} }, appendChild() {} },
  };
  const storage = new Map(stored ? [['qa:voltviz_style', stored]] : []);
  const ctx = {
    VELVET_VERSION: 'test',
    S: { queue: [{ bpm: 120 }], idx: 0 },
    navigator: {},
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    _uKey: k => `qa:${k}`,
    document: { getElementById: id => els[id] ?? null, createElement: () => ({ appendChild() {} }) },
    Option: function Option(text, value) { this.text = text; this.value = value; },
    t: k => k,
    toasts: [],
    console: { warn() {} },
    audioCtx: {},
    analyserNode: {},
    vizTopMode: 4,
    modes: [],
  };
  ctx.toast = m => ctx.toasts.push(m);
  ctx.applyMode = () => ctx.modes.push(ctx.vizTopMode);
  vm.createContext(ctx);
  // app.js is a classic script, not a module: evaluate the VoltViz block from our own source
  // eslint-disable-next-line sonarjs/code-eval
  vm.runInContext(`${block}
    _vvModPromise = Promise.resolve(__mod);
    this.api = { start: startVoltViz, stop: stopVoltViz, setStyle: _vvSetStyle, step: _vvStep,
      styleId: () => _vvStyleId, inst: () => _vvInst, setFallback: m => { _vvFallbackMode = m; } };`,
  Object.assign(ctx, { __mod: renderer.mod }));
  return { ctx, els, storage, api: ctx.api };
}

describe('VoltViz player mode', () => {
  it('offers only non-WebGPU styles without an adapter and starts the first one', async () => {
    const r = makeRenderer();
    const p = makePlayer(r);
    await p.api.start({});
    assert.equal(p.api.styleId(), 'bars');
    assert.equal(r.created.length, 1);
    p.api.step(-1);
    assert.equal(p.api.styleId(), 'kaleidoscope', 'previous wraps to the last non-WebGPU style');
  });

  it('falls back to the default style when the remembered one cannot start', async () => {
    const r = makeRenderer({ failing: ['tunnel'] });
    const p = makePlayer(r, 'tunnel');
    await p.api.start({});
    assert.equal(p.api.styleId(), 'bars');
    assert.equal(p.api.inst()?.visualizer, 'bars');
    assert.deepEqual(p.ctx.toasts, []);
  });

  it('returns to the previous mode when even the default style cannot start', async () => {
    const r = makeRenderer({ failing: ['bars'] });
    const p = makePlayer(r);
    p.api.setFallback(2);
    await p.api.start({});
    assert.equal(p.api.inst(), null);
    assert.deepEqual(p.ctx.toasts, ['player.toast.voltvizFailed']);
    assert.equal(p.ctx.vizTopMode, 2);
    assert.deepEqual(p.ctx.modes, [2]);
  });

  it('keeps the style on screen and says so when a chosen style fails', async () => {
    const r = makeRenderer({ failing: ['kaleidoscope'] });
    const p = makePlayer(r);
    await p.api.start({});
    await p.api.setStyle('kaleidoscope');
    assert.deepEqual(p.ctx.toasts, ['player.toast.voltvizStyleFailed']);
    assert.equal(p.api.styleId(), 'bars');
    assert.equal(p.els['viz-preset-name'].textContent, 'Bars');
    assert.equal(p.storage.get('qa:voltviz_style'), undefined);
  });

  it('after a superseded step fails, the label shows what the renderer really runs', async () => {
    const pending = { tunnel: deferred() };
    const r = makeRenderer({ failing: ['kaleidoscope'], pending });
    const p = makePlayer(r);
    await p.api.start({});
    const slow = p.api.setStyle('tunnel');
    await p.api.setStyle('kaleidoscope');
    assert.equal(p.api.styleId(), 'bars', 'tunnel never mounted, so the label must not claim it');
    pending.tunnel.resolve();
    await slow;
  });

  it('remembers the last chosen style, not a slower earlier one', async () => {
    const pending = { tunnel: deferred() };
    const r = makeRenderer({ pending });
    const p = makePlayer(r);
    await p.api.start({});
    const slow = p.api.setStyle('tunnel');
    await p.api.setStyle('kaleidoscope');
    pending.tunnel.resolve();
    await slow;
    assert.equal(p.api.styleId(), 'kaleidoscope');
    assert.equal(p.storage.get('qa:voltviz_style'), 'kaleidoscope');
  });

  it('destroys an instance that finishes starting after the mode was left', async () => {
    const createGate = deferred();
    const r = makeRenderer({ createGate });
    const p = makePlayer(r);
    const starting = p.api.start({});
    await new Promise(res => setImmediate(res));
    p.api.stop();
    createGate.resolve();
    await starting;
    assert.equal(r.created.length, 1);
    assert.equal(r.created[0].destroyed, true);
    assert.equal(p.api.inst(), null);
  });
});
