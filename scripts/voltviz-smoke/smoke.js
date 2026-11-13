/* global window, document, AudioNode, AudioContext, AnalyserNode, HTMLCanvasElement */
const probe = { raf: 0, intervals: new Set(), timeouts: new Set(), csp: [], edges: new Map() };
window.__probe = probe;

document.addEventListener('securitypolicyviolation', e => {
  probe.csp.push(`${e.violatedDirective} ${e.blockedURI}`);
});

const raf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = cb => { probe.raf++; return raf(cb); };
const si = window.setInterval.bind(window);
const ci = window.clearInterval.bind(window);
window.setInterval = (...a) => { const id = si(...a); probe.intervals.add(id); return id; };
window.clearInterval = id => { probe.intervals.delete(id); ci(id); };
const st = window.setTimeout.bind(window);
const ct = window.clearTimeout.bind(window);
window.setTimeout = (fn, ms, ...a) => {
  const id = st((...b) => { probe.timeouts.delete(id); if (typeof fn === 'function') fn(...b); }, ms, ...a);
  probe.timeouts.add(id);
  return id;
};
window.clearTimeout = id => { probe.timeouts.delete(id); ct(id); };

const connect = AudioNode.prototype.connect;
const disconnect = AudioNode.prototype.disconnect;
AudioNode.prototype.connect = function (dst, ...rest) {
  if (!probe.edges.has(this)) probe.edges.set(this, new Set());
  probe.edges.get(this).add(dst);
  return connect.call(this, dst, ...rest);
};
AudioNode.prototype.disconnect = function (...args) {
  const dst = args[0];
  if (dst === undefined || typeof dst === 'number') probe.edges.delete(this);
  else probe.edges.get(this)?.delete(dst);
  return disconnect.apply(this, args);
};

function makeSource(ctx) {
  const input = ctx.createGain();
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate;
      const beat = t % 0.5;
      const kick = beat < 0.12 ? Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-beat * 30)) * beat) * Math.exp(-beat * 18) : 0;
      d[i] = 0.7 * kick + 0.08 * (Math.random() * 2 - 1) + 0.15 * Math.sin(2 * Math.PI * 440 * t) * (0.5 + 0.5 * Math.sin(t * 3));
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(input);
  src.start();
  input.connect(ctx.destination);
  return input;
}

window.__smoke = async () => {
  const ctx = new AudioContext();
  await ctx.resume();
  const input = makeSource(ctx);
  const vv = await import('/voltviz/voltviz.js');
  const list = vv.listVisualizers();
  window.__vv = vv;
  window.__ctx = ctx;
  window.__input = input;
  window.__viz = await vv.createVoltViz({ container: document.getElementById('stage'), audioContext: ctx, input, visualizer: list[0].id, bpm: 120 });
  let gpu;
  try { gpu = !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch { gpu = false; }
  return { version: vv.VERSION, list, gpu, current: window.__viz.visualizer };
};

window.__inputEdges = () => [...(probe.edges.get(window.__input) ?? [])].map(n => n === window.__ctx.destination ? 'destination' : n.constructor.name);

// Makes WebGL unavailable so a WebGL style's factory throws, then checks that nothing is left behind.
window.__failMount = async id => {
  const probe = window.__probe;
  const stage = document.getElementById('stage');
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    return /webgl/.test(type) ? null : getContext.call(this, type, ...rest);
  };
  const out = {};
  try {
    try {
      await window.__vv.createVoltViz({ container: stage, audioContext: window.__ctx, input: window.__input, visualizer: id });
      out.createRejected = false;
    } catch {
      out.createRejected = true;
    }
    await new Promise(r => setTimeout(r, 300));
    const raf0 = probe.raf;
    await new Promise(r => setTimeout(r, 1000));
    out.rafCallsAfter = probe.raf - raf0;
    out.inputEdges = window.__inputEdges();
    out.stageEmpty = stage.childElementCount === 0;

    HTMLCanvasElement.prototype.getContext = getContext;
    const viz = await window.__vv.createVoltViz({ container: stage, audioContext: window.__ctx, input: window.__input, visualizer: 'bars' });
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return /webgl/.test(type) ? null : getContext.call(this, type, ...rest);
    };
    try {
      await viz.setVisualizer(id);
      out.switchRejected = false;
    } catch {
      out.switchRejected = true;
    }
    out.keptStyle = viz.visualizer;
    out.layersAfterSwitch = stage.querySelectorAll('.voltviz-layer').length;
    viz.destroy();
    await new Promise(r => setTimeout(r, 300));
    out.finalInputEdges = window.__inputEdges();
    out.finalStageEmpty = stage.childElementCount === 0;
  } finally {
    HTMLCanvasElement.prototype.getContext = getContext;
  }
  return out;
};

window.__analyserEdges = () => {
  let n = 0;
  for (const dsts of window.__probe.edges.values()) for (const d of dsts) if (d instanceof AnalyserNode) n++;
  return n;
};
