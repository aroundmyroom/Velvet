import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
export const abs = (relPath) => path.join(ROOT, relPath);

const SKIP_DIRS = new Set(['node_modules', '.git']);

export function walk(dir, exts = /\.(js|mjs|cjs)$/, out = []) {
  const full = path.isAbsolute(dir) ? dir : abs(dir);
  if (!fs.existsSync(full)) return out;
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(full, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.test(e.name)) out.push(p);
  }
  return out.sort();
}

const srcCache = new Map();
export function read(file) {
  if (!srcCache.has(file)) srcCache.set(file, fs.readFileSync(file, 'utf8'));
  return srcCache.get(file);
}

const astCache = new Map();
const PARSE_OPTS = {
  ecmaVersion: 'latest', locations: true, allowHashBang: true,
  allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowImportExportEverywhere: true,
};

export function parse(file) {
  if (astCache.has(file)) return astCache.get(file);
  const src = read(file);
  let ast;
  try {
    ast = acorn.parse(src, { ...PARSE_OPTS, sourceType: 'module' });
  } catch {
    ast = acorn.parse(src, { ...PARSE_OPTS, sourceType: 'script' });
  }
  astCache.set(file, ast);
  return ast;
}

export function isNode(v) {
  return v && typeof v === 'object' && typeof v.type === 'string';
}

export function visit(node, fn, ancestors = []) {
  if (!isNode(node)) return;
  if (fn(node, ancestors) === false) return;
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) visit(c, fn, ancestors); }
    else if (isNode(v)) visit(v, fn, ancestors);
  }
  ancestors.pop();
}

// One block is off-limits to the guards: in webapp/app.js the top-level declarations whose name matches
// HIDDEN_NAME plus the anonymous IIFE right after them, and in webapp/index.html the lines of its markup.
// Nothing else is masked; test/arch-masking.test.mjs fails if the masked set grows.
export const HIDDEN_JS_FILE = 'webapp/app.js';
export const HIDDEN_HTML_FILE = 'webapp/index.html';
const HIDDEN_NAME = /^(EGG|_?egg[A-Z_])/;
const HIDDEN_HTML_LINE = /(^|[^a-z])egg(?![a-z])/i;

function declaredNames(stmt) {
  const d = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
  if (!d) return [];
  if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) return [d.id.name];
  if (d.type === 'VariableDeclaration') return d.declarations.filter((v) => v.id.type === 'Identifier').map((v) => v.id.name);
  const left = d.type === 'ExpressionStatement' && d.expression.type === 'AssignmentExpression' ? d.expression.left : null;
  if (left?.type === 'MemberExpression' && !left.computed) return [left.property.name];
  return [];
}

function isAnonymousIife(stmt) {
  const e = stmt?.type === 'ExpressionStatement' ? stmt.expression : null;
  return e?.type === 'CallExpression' && /^(Arrow)?FunctionExpression$/.test(e.callee.type) && !e.callee.id;
}

function withLeadingComments(src, pos) {
  let start = src.lastIndexOf('\n', pos - 1) + 1;
  while (start > 0) {
    const prevStart = src.lastIndexOf('\n', start - 2) + 1;
    if (!/^(\/\/|\/\*|\*)/.test(src.slice(prevStart, start - 1).trim())) break;
    start = prevStart;
  }
  return start;
}

const hiddenCache = new Map();
export function hiddenRanges(file) {
  if (hiddenCache.has(file)) return hiddenCache.get(file);
  const ranges = [];
  if (rel(file) === HIDDEN_JS_FILE) {
    const src = read(file);
    const body = parse(file).body;
    body.forEach((stmt, i) => {
      if (!declaredNames(stmt).some((n) => HIDDEN_NAME.test(n))) return;
      const end = isAnonymousIife(body[i + 1]) ? body[i + 1].end : stmt.end;
      ranges.push([withLeadingComments(src, stmt.start), end]);
    });
  }
  hiddenCache.set(file, ranges);
  return ranges;
}

export function hiddenHtmlLines(file) {
  if (rel(file) !== HIDDEN_HTML_FILE) return [];
  return read(file).split('\n').flatMap((l, i) => (HIDDEN_HTML_LINE.test(l) ? [i + 1] : []));
}

export function isHidden(file, pos) {
  return hiddenRanges(file).some(([s, e]) => pos >= s && pos < e);
}

export function maskedText(file) {
  const src = read(file);
  if (/\.html?$/.test(file)) {
    const hidden = new Set(hiddenHtmlLines(file));
    return src.split('\n').map((l, i) => (hidden.has(i + 1) ? '' : l)).join('\n');
  }
  let out = src;
  for (const [s, e] of hiddenRanges(file)) {
    out = out.slice(0, s) + out.slice(s, e).replace(/[^\n]/g, ' ') + out.slice(e);
  }
  return out;
}

export function lineOf(src, index) {
  let n = 1;
  for (let i = src.indexOf('\n'); i !== -1 && i < index; i = src.indexOf('\n', i + 1)) n++;
  return n;
}

export function where(file, node) {
  return `${rel(file)}:${node.loc.start.line}`;
}

export function report(title, items, howToFix) {
  if (!items.length) return '';
  return `${title} (${items.length}):\n${items.map((i) => `  - ${i}`).join('\n')}\n\nHow to fix: ${howToFix}`;
}

export function ownWebappJs() {
  return walk('webapp', /\.(js|mjs)$/).filter((f) => !rel(f).startsWith('webapp/assets/js/lib/'));
}

export function shape(node, renamed = new Map()) {
  let count = 0;
  const json = JSON.stringify(node, (key, value) => {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'raw') return undefined;
    if (isNode(value)) count++;
    if (renamed.has(value)) return { ...value, name: renamed.get(value) };
    if (typeof value === 'bigint') return `${value}n`;
    if (value instanceof RegExp) return String(value);
    return value;
  });
  return { json, count };
}

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'];
const ROUTE_OBJECTS = new Set(['velvet', 'app', 'router']);
const SENDSPIN_WRAPPERS = { admin: '/api/v1/admin/sendspin', player: '/api/v1/rooms', control: '/api/v1/rooms' };
const SENDSPIN_ACTIONS = new Set(['edit', 'simple']);

export function normRoute(p) {
  return p
    .replace(/\{\*[^}]+\}/g, ':p')
    .replace(/\{[^}]+\}/g, ':p')
    .replace(/:[A-Za-z_]\w*\??/g, ':p')
    .replace(/\/+$/, '') || '/';
}

let constCache = null;
function stringConstants() {
  if (constCache) return constCache;
  constCache = new Map();
  for (const file of walk('src')) {
    const local = new Map();
    for (const stmt of parse(file).body) {
      const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
      if (decl?.type !== 'VariableDeclaration' || decl.kind !== 'const') continue;
      for (const d of decl.declarations) {
        if (d.id.type === 'Identifier' && d.init?.type === 'Literal' && typeof d.init.value === 'string') {
          local.set(d.id.name, d.init.value);
          if (stmt.type === 'ExportNamedDeclaration') constCache.set(`*:${d.id.name}`, d.init.value);
        }
      }
    }
    constCache.set(file, local);
  }
  return constCache;
}

function staticString(node, file) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    const consts = stringConstants();
    let out = '';
    for (let i = 0; i < node.quasis.length; i++) {
      out += node.quasis[i].value.cooked;
      const expr = node.expressions[i];
      if (!expr) continue;
      if (expr.type !== 'Identifier') return null;
      const v = consts.get(file).get(expr.name) ?? consts.get(`*:${expr.name}`);
      if (v == null) return null;
      out += v;
    }
    return out;
  }
  return null;
}

function callsNext(fn) {
  if (!fn || !/Function/.test(fn.type) || fn.params.length < 3 || fn.params[2].type !== 'Identifier') return false;
  const name = fn.params[2].name;
  let found = false;
  visit(fn.body, (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === name) found = true;
    return !found;
  });
  return found;
}

let routeCache = null;
export function collectRoutes() {
  if (routeCache) return routeCache;
  const routes = [];
  const unresolved = [];
  let site = 0;
  for (const file of walk('src')) {
    const isSendspin = rel(file) === 'src/api/sendspin.js';
    visit(parse(file), (n) => {
      if (n.type !== 'CallExpression') return;
      const c = n.callee;
      const at = where(file, n);
      const passThrough = callsNext(n.arguments.at(-1));
      const add = (method, p) => routes.push({ method: method.toUpperCase(), path: p, key: `${method.toUpperCase()} ${normRoute(p)}`, at, site, passThrough });
      if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier'
        && ROUTE_OBJECTS.has(c.object.name) && HTTP_METHODS.includes(c.property.name) && n.arguments.length >= 2) {
        site++;
        const first = n.arguments[0];
        const paths = first.type === 'ArrayExpression' ? first.elements : [first];
        for (const el of paths) {
          const p = staticString(el, file);
          if (p != null) add(c.property.name, p);
          else if (!(el.type === 'TemplateLiteral' && el.quasis[0].value.cooked.startsWith('/rest/'))) unresolved.push(at);
        }
        return;
      }
      if (!isSendspin || c.type !== 'Identifier') return;
      const [a0, a1] = n.arguments;
      if (SENDSPIN_WRAPPERS[c.name] && a0?.type === 'Literal' && HTTP_METHODS.includes(a0.value) && a1) {
        const p = staticString(a1, file);
        if (p == null) return;
        site++;
        add(a0.value, SENDSPIN_WRAPPERS[c.name] + p);
      } else if (SENDSPIN_ACTIONS.has(c.name) && a0?.type === 'Literal' && typeof a0.value === 'string') {
        site++;
        add('post', `/api/v1/rooms/:id/${a0.value}`);
      }
    });
  }
  routeCache = { routes, unresolved };
  return routeCache;
}

export function docRows(docFile = 'docs/API.md') {
  const rows = [];
  read(abs(docFile)).split('\n').forEach((line, i) => {
    const m = line.match(/^\|\s*`([A-Z/ ,]+)`\s*\|\s*`([^`]+)`/);
    if (!m) return;
    const p = m[2].split('?')[0].trim().replace(/(:[A-Za-z]+)\.(mp3|jpg)$/, '$1');
    for (const method of m[1].split(/[/, ]+/).filter(Boolean)) {
      rows.push({ method, path: p, key: `${method} ${normRoute(p)}`, at: `${docFile}:${i + 1}` });
    }
  });
  return rows;
}
