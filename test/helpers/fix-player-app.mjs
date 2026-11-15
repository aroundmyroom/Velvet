// Pulls top-level declarations out of webapp/app.js (a classic browser script) so
// tests can run them in a vm context against stubs.
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

export const appSrc = fs.readFileSync(new URL('../../webapp/app.js', import.meta.url), 'utf8');
export const indexHtml = fs.readFileSync(new URL('../../webapp/index.html', import.meta.url), 'utf8');

const ast = parse(appSrc, { ecmaVersion: 'latest', sourceType: 'script' });

function declName(node) {
  if (node.type === 'FunctionDeclaration') return [node.id.name];
  if (node.type === 'VariableDeclaration') return node.declarations.map(d => d.id.name).filter(Boolean);
  return [];
}

export function topLevelSource(name) {
  const node = ast.body.find(n => declName(n).includes(name));
  if (!node) throw new Error(`top-level declaration not found in app.js: ${name}`);
  return appSrc.slice(node.start, node.end);
}

// Evaluates the named declarations in a fresh context seeded with `globals`.
// `let`/`const` names are exposed through getters/setters on ctx.$ so tests can read and set them.
export function loadFns(names, globals = {}) {
  const ctx = vm.createContext({ ...globals });
  const code = names.map(topLevelSource).join('\n');
  const vars = names.filter(n => ast.body.find(b => declName(b).includes(n))?.type === 'VariableDeclaration');
  const extraVars = globals.$vars || {};
  const letLines = Object.entries(extraVars).map(([k, v]) => `let ${k} = ${JSON.stringify(v)};`).join('\n');
  const accessors = [...vars, ...Object.keys(extraVars)]
    .map(n => `Object.defineProperty(this.$, ${JSON.stringify(n)}, { get: () => ${n}, set: v => { ${n} = v; }, enumerable: true });`)
    .join('\n');
  const fnExports = names.filter(n => !vars.includes(n)).map(n => `this.${n} = ${n};`).join('\n');
  // eslint-disable-next-line sonarjs/code-eval
  vm.runInContext(`this.$ = {};\n${letLines}\n${code}\n${fnExports}\n${accessors}`, ctx);
  return ctx;
}

export function makeApiStub(handler = () => ({})) {
  const calls = [];
  const api = (method, path, body) => {
    calls.push({ method, path, body });
    try { return Promise.resolve(handler(method, path, body)); } catch (e) { return Promise.reject(e); }
  };
  return { api, calls };
}

export const tick = () => new Promise(r => setImmediate(r));
