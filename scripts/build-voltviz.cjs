#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = 'https://github.com/sanderdw/voltviz';
// v0.35.1 (upstream publishes no git tags; this is the "0.35.1 (#37)" commit on main)
const DEFAULT_REF = 'bff5e16c20b22bb631aa348254e63c74b01236f9';

const DROPPED = {
  mossball: 'shaders are CC BY-NC 4.0 (non-commercial), incompatible with Velvet\'s GPLv3',
  flame: 'shader is CC BY-NC-SA 3.0 (non-commercial), incompatible with Velvet\'s GPLv3',
  yourlogo: 'draws nothing until the user uploads an SVG logo',
};

const ROOT = path.resolve(__dirname, '..');
const TEMPLATES = path.join(__dirname, 'voltviz');
const OUT = path.join(ROOT, 'webapp/assets/js/lib/voltviz');

function parseArgs(argv) {
  const args = { ref: DEFAULT_REF, keep: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ref') args.ref = argv[++i];
    else if (argv[i] === '--keep') args.keep = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.ref) throw new Error('--ref needs a value');
  return args;
}

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim();
}

function replaceOnce(file, from, to) {
  const src = fs.readFileSync(file, 'utf8');
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`patch target found ${n}x in ${file}: ${from}`);
  fs.writeFileSync(file, src.replace(from, to));
}

function patch(dir) {
  fs.copyFileSync(path.join(TEMPLATES, 'neural-stub.ts'), path.join(dir, 'src/audio/neural/NeuralClient.ts'));

  const engine = path.join(dir, 'src/audio/AudioEngine.ts');
  replaceOnce(engine,
    '  /** Create an engine for a source. Call from a user gesture where possible (autoplay policy). */',
    `  ownsContext = true;

  static async fromNode(ctx: AudioContext, node: AudioNode, options: EngineOptions): Promise<AudioEngine> {
    const engine = new AudioEngine(ctx, node, false, options);
    engine.ownsContext = false;
    await engine.startHost();
    return engine;
  }

  /** Create an engine for a source. Call from a user gesture where possible (autoplay policy). */`);
  replaceOnce(engine,
    "if (this.context.state !== 'closed') this.context.close()",
    "if (this.ownsContext && this.context.state !== 'closed') this.context.close()");

  // The worklet returned true forever; in a shared AudioContext that leaks a running processor per teardown.
  const worklet = path.join(dir, 'src/audio/host/analysis.worklet.ts');
  replaceOnce(worklet, '  private readonly core: AnalysisCore;', '  private readonly core: AnalysisCore;\n  private alive = true;');
  replaceOnce(worklet,
    'this.port.onmessage = (e: MessageEvent<EngineToHost>) => this.core.onMessage(e.data);',
    "this.port.onmessage = (e: MessageEvent<EngineToHost | { type: 'dispose' }>) => {\n      if (e.data.type === 'dispose') this.alive = false;\n      else this.core.onMessage(e.data);\n    };");
  replaceOnce(worklet, '    return true;', '    return this.alive;');
  replaceOnce(path.join(dir, 'src/audio/host/scriptProcessorHost.ts'),
    '      node.port.onmessage = null;',
    "      node.port.postMessage({ type: 'dispose' });\n      node.port.onmessage = null;");

  // Overlays are React upload/settings UIs that Velvet never renders; unexported they tree-shake away with React.
  const implDir = path.join(dir, 'src/visualizers/impl');
  let overlays = 0;
  for (const f of fs.readdirSync(implDir)) {
    const file = path.join(implDir, f);
    const src = fs.readFileSync(file, 'utf8');
    const out = src
      .replace(/^export function Overlay\b/m, 'function Overlay')
      .replace(/^export const Overlay = /m, 'const Overlay = /* @__PURE__ */ ');
    if (out !== src) { overlays++; fs.writeFileSync(file, out); }
  }
  if (!overlays) throw new Error('no visualizer Overlay exports found to strip');
}

function writeMeta(dir, version) {
  const registry = fs.readFileSync(path.join(dir, 'src/visualizers/registry.ts'), 'utf8');
  const entries = [...registry.matchAll(/\{ id: '([^']+)', name: '([^']+)', module: '([^']+)' \}/g)]
    .map(([, id, name, module]) => ({ id, name, module }));
  const implDir = path.join(dir, 'src/visualizers/impl');
  if (entries.length !== fs.readdirSync(implDir).length) {
    throw new Error(`registry parse found ${entries.length} entries for ${fs.readdirSync(implDir).length} modules`);
  }
  for (const id of Object.keys(DROPPED)) {
    if (!entries.some(e => e.id === id)) throw new Error(`dropped visualizer ${id} no longer exists upstream`);
  }
  const kept = entries.filter(e => !DROPPED[e.id]).map(e => {
    const file = ['.ts', '.tsx'].map(x => e.module + x).find(f => fs.existsSync(path.join(implDir, f)));
    const src = fs.readFileSync(path.join(implDir, file), 'utf8');
    let group = 'canvas';
    if (/from 'three'|lib\/three'|getContext\(\s*['"]webgl/.test(src)) group = 'webgl';
    if (/lib\/webgpu'/.test(src)) group = 'webgpu';
    return { ...e, file, group };
  });
  const rows = kept.map(e =>
    `  { id: ${JSON.stringify(e.id)}, name: ${JSON.stringify(e.name)}, group: ${JSON.stringify(e.group)}, ` +
    `webgpu: ${e.group === 'webgpu'}, load: () => import('../src/visualizers/impl/${e.file}').then(m => m.default) },`);
  fs.writeFileSync(path.join(dir, 'velvet/meta.ts'),
    "import type { VisualizerFactory } from '../src/visualizers/runtime/types';\n\n" +
    `export const UPSTREAM_VERSION = ${JSON.stringify(version)};\n\n` +
    'export const META: { id: string; name: string; group: string; webgpu: boolean; load: () => Promise<VisualizerFactory> }[] = [\n' +
    rows.join('\n') + '\n];\n');
  return kept;
}

const FORBIDDEN = [
  [/\beval\s*\(/, 'eval('],
  [/new\s+Function\s*\(/, 'new Function('],
  [/\bFunction\s*\(\s*["'`]/, 'Function("...")'],
  [/WebAssembly/, 'WebAssembly'],
  [/onnx/i, 'onnx'],
  [/\.wasm\b/, '.wasm'],
  [/https?:\/\/(?!www\.w3\.org\/)[a-z0-9.-]+\.[a-z]{2,}\/[^\s"'`]*\.(?:js|json|png|jpe?g|webp|mp3|wasm|onnx)\b/i, 'remote asset URL'],
];

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? listFiles(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}

function audit(dist) {
  const problems = [];
  for (const file of listFiles(dist).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [re, label] of FORBIDDEN) if (re.test(src)) problems.push(`${path.relative(dist, file)}: ${label}`);
  }
  if (problems.length) throw new Error(`bundle audit failed:\n  ${problems.join('\n  ')}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voltviz-build-'));
  const dir = path.join(tmp, 'voltviz');
  try {
    fs.mkdirSync(dir);
    run('git', ['init', '-q'], dir);
    run('git', ['fetch', '-q', '--depth', '1', REPO, args.ref], dir);
    run('git', ['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], dir);
    const commit = run('git', ['rev-parse', 'HEAD'], dir);
    const upstreamVersion = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    const version = `${upstreamVersion}+${commit.slice(0, 7)}`;
    console.log(`voltviz ${version} (${commit})`);

    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], dir);

    fs.mkdirSync(path.join(dir, 'velvet'));
    for (const f of ['voltviz.ts', 'voltviz.css', 'vite.config.ts']) {
      fs.copyFileSync(path.join(TEMPLATES, f), path.join(dir, 'velvet', f));
    }
    patch(dir);
    const kept = writeMeta(dir, version);

    execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'velvet/vite.config.ts'],
      { cwd: dir, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });

    const dist = path.join(dir, 'velvet/dist');
    audit(dist);
    fs.copyFileSync(path.join(dir, 'LICENSE'), path.join(dist, 'LICENSE'));
    fs.copyFileSync(path.join(dir, 'THIRD_PARTY_NOTICES.md'), path.join(dist, 'THIRD_PARTY_NOTICES.md'));
    fs.writeFileSync(path.join(dist, 'VERSION'),
      `${version}\n${REPO}/tree/${commit}\n\nincluded: ${kept.length}\n` +
      Object.entries(DROPPED).map(([id, why]) => `dropped: ${id} (${why})\n`).join(''));

    fs.rmSync(OUT, { recursive: true, force: true });
    fs.cpSync(dist, OUT, { recursive: true });

    let total = 0;
    for (const f of listFiles(OUT)) total += fs.statSync(f).size;
    console.log(`wrote ${path.relative(ROOT, OUT)}: ${kept.length} visualizers, ${(total / 1024).toFixed(0)} KiB`);
  } finally {
    if (args.keep) console.log(`kept ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
