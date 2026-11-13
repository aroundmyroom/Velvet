#!/usr/bin/env node
'use strict';
/* global window, document */

// Browser smoke test for the vendored VoltViz bundle, served with Velvet's CSP.
// Needs playwright + pngjs installed outside the repo: node run.cjs --qa-dir <dir with node_modules>
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');

const qaArg = process.argv.indexOf('--qa-dir');
if (qaArg < 0) throw new Error('usage: node run.cjs --qa-dir <dir with playwright + pngjs>');
const qaRequire = createRequire(path.join(path.resolve(process.argv[qaArg + 1]), 'package.json'));
const { chromium } = qaRequire('playwright');
const { PNG } = qaRequire('pngjs');

// What src/server.js (helmet defaults + Velvet overrides) sends for static assets.
const CSP = "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';"
  + "img-src 'self' data: https://flagcdn.com;object-src 'none';script-src 'self';script-src-attr 'none';"
  + "style-src 'self' https: 'unsafe-inline';worker-src 'self' blob:";

const SMOKE = __dirname;
const BUNDLE = path.resolve(__dirname, '../../webapp/assets/js/lib/voltviz');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png' };

function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const [root, rel] = url.startsWith('/voltviz/') ? [BUNDLE, url.slice(9)] : [SMOKE, url === '/' ? 'index.html' : url.slice(1)];
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': CSP });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

function analyse(buf) {
  const png = PNG.sync.read(buf);
  const n = png.width * png.height;
  const lum = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = png.data;
    lum[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    sum += lum[i];
  }
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (lum[i] - mean) ** 2;
  return { lum, mean, std: Math.sqrt(v / n) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Cyber Matrix draws point sprites of a fixed pixel size: at 640x360 they overlap into solid white (upstream too).
const FULL_SIZE = new Set(['cybermatrix']);

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu'] });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const setStage = async (width, height) => {
    await page.setViewportSize({ width, height });
    await page.evaluate(([w, h]) => Object.assign(document.getElementById('stage').style, { width: `${w}px`, height: `${h}px` }), [width, height]);
  };
  let current = 'boot';
  const errors = {};
  const requests = {};
  const note = (bucket, msg) => {
    if (!bucket[current]) bucket[current] = [];
    bucket[current].push(msg);
  };
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') note(errors, `${m.type()}: ${m.text()}`); });
  page.on('pageerror', e => note(errors, `pageerror: ${e.message}`));
  page.on('request', r => { if (r.url().includes('/voltviz/')) note(requests, r.url().split('/voltviz/')[1]); });

  await page.goto(base + '/');
  const info = await page.evaluate(() => window.__smoke());
  console.log(`VoltViz ${info.version}: ${info.list.length} visualizers, WebGPU adapter: ${info.gpu}`);
  console.log(`initial load: ${(requests.boot || []).join(', ')}`);

  const rows = [];
  const only = process.env.VOLTVIZ_SMOKE_ONLY?.split(',');
  const shots = process.env.VOLTVIZ_SMOKE_SHOTS;
  for (const v of info.list.filter(x => !only || only.includes(x.id))) {
    current = v.id;
    const before = await page.evaluate(() => window.__probe.csp.length);
    const large = FULL_SIZE.has(v.id);
    if (large) await setStage(1920, 1080);
    await page.evaluate(id => window.__viz.setVisualizer(id), v.id);
    await sleep(1500);
    const shot = () => page.screenshot({ clip: { x: 0, y: 0, width: 640, height: 360 }, timeout: 120000 });
    const first = await shot();
    if (shots) fs.writeFileSync(path.join(shots, `${v.id}.png`), first);
    const a = analyse(first);
    await sleep(300);
    const b = analyse(await shot());
    let motion = 0;
    for (let i = 0; i < a.lum.length; i++) motion += Math.abs(a.lum[i] - b.lum[i]);
    motion /= a.lum.length;
    const state = await page.evaluate(n => ({ active: window.__viz.visualizer, csp: window.__probe.csp.slice(n), layers: document.querySelectorAll('.voltviz-layer').length }), before);
    if (large) await setStage(640, 360);
    const rendered = a.std > 1.5 || motion > 0.2;
    const msgs = (errors[v.id] || []).filter(e => !/GPU stall|GL Driver Message|Automatic fallback to software WebGL|WebGL-/.test(e));
    const errs = msgs.filter(e => !e.startsWith('warning:'));
    const warns = msgs.filter(e => e.startsWith('warning:'));
    // Headless Chromium exposes a SwiftShader WebGPU adapter but never composites WebGPU canvases into screenshots.
    let status = v.webgpu ? 'webgpu-unavailable' : 'blank';
    if (rendered) status = 'ok';
    if (state.active !== v.id || errs.length || state.csp.length) status = 'error';
    rows.push({ id: v.id, group: v.group, status, mean: a.mean.toFixed(1), std: a.std.toFixed(1), motion: motion.toFixed(2),
      layers: state.layers, csp: state.csp.join(' | '), errors: errs.join(' | ').slice(0, 300), warnings: warns.join(' | ').slice(0, 300),
      chunks: (requests[v.id] || []).map(u => u.replace(/^chunks\//, '').replace(/-[\w-]{8}\.js$/, '')).join(' ') });
    console.log(`${status.padEnd(18)} ${v.id.padEnd(26)} mean=${a.mean.toFixed(1)} std=${a.std.toFixed(1)} motion=${motion.toFixed(2)}${errs.length ? ' ERR ' + errs[0].slice(0, 160) : ''}${warns.length ? ' WARN ' + warns[0].slice(0, 120) : ''}${state.csp.length ? ' CSP ' + state.csp[0] : ''}`);
  }

  // The engine evicts analysers no style has read for 600 frames; evicted ones must leave the graph.
  current = 'evict';
  const evict = await page.evaluate(async () => {
    await window.__viz.setVisualizer('bars');
    const before = window.__analyserEdges();
    const raf0 = window.__probe.raf;
    const t0 = performance.now();
    while (window.__probe.raf - raf0 < 1300 && performance.now() - t0 < 120000) await new Promise(r => setTimeout(r, 500));
    return { before, after: window.__analyserEdges(), frames: window.__probe.raf - raf0 };
  });

  current = 'fallback';
  const fallback = await page.evaluate(async () => { await window.__viz.setVisualizer('no-such-visualizer'); return window.__viz.visualizer; });

  current = 'destroy';
  const teardown = await page.evaluate(async () => {
    const p = window.__probe;
    window.__viz.destroy();
    await new Promise(r => setTimeout(r, 300));
    const raf0 = p.raf;
    await new Promise(r => setTimeout(r, 1000));
    const edges = window.__inputEdges();
    const stageEmpty = document.getElementById('stage').childElementCount === 0;
    const out = { rafCallsAfter: p.raf - raf0, intervals: p.intervals.size, timeouts: p.timeouts.size, inputEdges: edges, stageEmpty };
    const viz = await window.__vv.createVoltViz({ container: document.getElementById('stage'), audioContext: window.__ctx, input: window.__input, visualizer: 'bars' });
    await new Promise(r => setTimeout(r, 800));
    out.recreated = viz.visualizer;
    viz.destroy();
    await new Promise(r => setTimeout(r, 300));
    const raf1 = p.raf;
    await new Promise(r => setTimeout(r, 1000));
    out.secondRafCallsAfter = p.raf - raf1;
    out.secondInputEdges = window.__inputEdges();
    out.cspTotal = p.csp;
    out.ctxState = window.__ctx.state;
    return out;
  });

  current = 'mountfail';
  const webglId = info.list.find(v => v.group === 'webgl').id;
  const mountFail = await page.evaluate(id => window.__failMount(id), webglId);

  await browser.close();
  server.close();

  const count = s => rows.filter(r => r.status === s).length;
  const summary = { ok: count('ok'), blank: count('blank'), error: count('error'), 'webgpu-unavailable': count('webgpu-unavailable') };
  console.log('\nsummary', JSON.stringify(summary));
  console.log('unknown id ->', fallback);
  console.log('idle analysers', JSON.stringify(evict));
  console.log('teardown', JSON.stringify(teardown));
  console.log(`mount failure (${webglId} without WebGL)`, JSON.stringify(mountFail));
  const leftovers = Object.entries(errors).filter(([k]) => ['boot', 'fallback', 'destroy'].includes(k));
  if (leftovers.length) console.log('other console output', JSON.stringify(leftovers).slice(0, 2000));
  const outFile = process.env.VOLTVIZ_SMOKE_OUT;
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ info, rows, summary, fallback, evict, teardown, mountFail, requests }, null, 2));
  const failed = summary.error || summary.blank || teardown.rafCallsAfter || teardown.secondRafCallsAfter
    || teardown.inputEdges.join() !== 'destination' || !teardown.stageEmpty || teardown.cspTotal.length
    || (rows.length > 1 && evict.after >= evict.before)
    || !mountFail.createRejected || mountFail.rafCallsAfter || mountFail.inputEdges.join() !== 'destination' || !mountFail.stageEmpty
    || !mountFail.switchRejected || mountFail.keptStyle !== 'bars' || mountFail.layersAfterSwitch !== 1
    || mountFail.finalInputEdges.join() !== 'destination' || !mountFail.finalStageEmpty;
  process.exitCode = failed ? 1 : 0;
}

main().catch(err => { console.error(err); process.exit(1); });
