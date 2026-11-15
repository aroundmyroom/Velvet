import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as acorn from 'acorn';
import { walk, parse, visit, isHidden, ownWebappJs, shape, rel, report } from './helpers/arch.mjs';

// Below this many AST nodes a match is usually a one-liner like `(ms) => new Promise(...)`, not a copy.
const MIN_BODY_NODES = 12;

function scopeDeclarations(body) {
  const out = [];
  for (const s of body) {
    const d = s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' ? s.declaration : s;
    if (!d) continue;
    if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) out.push({ name: d.id.name, node: d });
    if (d.type === 'VariableDeclaration' && d.kind === 'var') {
      for (const v of d.declarations) if (v.id.type === 'Identifier') out.push({ name: v.id.name, node: v });
    }
  }
  return out;
}

function topLevelFunctions(file) {
  const ast = parse(file);
  const exported = new Set();
  const fns = [];
  for (const s of ast.body) {
    if (s.type === 'ExportNamedDeclaration' && !s.declaration && !s.source) {
      for (const sp of s.specifiers) exported.add(sp.local.name);
    }
    const isExport = s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration';
    const d = isExport ? s.declaration : s;
    if (!d) continue;
    if (d.type === 'FunctionDeclaration' && d.id) fns.push({ name: d.id.name, fn: d, exported: isExport });
    if (d.type === 'VariableDeclaration') {
      for (const v of d.declarations) {
        if (v.id.type === 'Identifier' && v.init && /^(Arrow)?FunctionExpression$/.test(v.init.type)) {
          fns.push({ name: v.id.name, fn: v.init, exported: isExport });
        }
      }
    }
  }
  for (const f of fns) if (exported.has(f.name)) f.exported = true;
  return fns;
}

function bindingNames(p, out) {
  if (!p) return;
  if (p.type === 'Identifier') out.add(p.name);
  else if (p.type === 'ObjectPattern') p.properties.forEach((x) => bindingNames(x.value ?? x.argument, out));
  else if (p.type === 'ArrayPattern') p.elements.forEach((x) => bindingNames(x, out));
  else if (p.type === 'AssignmentPattern') bindingNames(p.left, out);
  else if (p.type === 'RestElement') bindingNames(p.argument, out);
}

// Local names become $0, $1, … in order of appearance, so a copy with renamed variables has the same shape.
function localRenames(fn) {
  const locals = new Set();
  fn.params.forEach((p) => bindingNames(p, locals));
  visit(fn.body, (n) => {
    if (n.type === 'VariableDeclarator') bindingNames(n.id, locals);
    if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id) locals.add(n.id.name);
    if (/Function/.test(n.type)) n.params.forEach((p) => bindingNames(p, locals));
    if (n.type === 'CatchClause') bindingNames(n.param, locals);
  });
  const order = new Map();
  const renamed = new Map();
  const rename = (n, ancestors) => {
    if (n.type !== 'Identifier' || !locals.has(n.name)) return;
    const parent = ancestors.at(-1);
    if (parent?.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
    if (parent?.type === 'Property' && parent.key === n && !parent.computed && !parent.shorthand) return;
    if (!order.has(n.name)) order.set(n.name, `$${order.size}`);
    renamed.set(n, order.get(n.name));
  };
  fn.params.forEach((p) => visit(p, rename));
  visit(fn.body, rename);
  return renamed;
}

describe('architecture: duplicates', () => {
  it('a copy with renamed local variables has the same shape; a different callee does not', () => {
    const fnShape = (code) => {
      const fn = acorn.parse(code, { ecmaVersion: 'latest' }).body[0];
      return shape({ params: fn.params, body: fn.body }, localRenames(fn)).json;
    };
    const a = fnShape('function a(root, list) { const out = []; for (const x of list) out.push(path.join(root, x.name)); return out; }');
    const b = fnShape('function b(base, items) { const res = []; for (const it of items) res.push(path.join(base, it.name)); return res; }');
    const c = fnShape('function c(base, items) { const res = []; for (const it of items) res.push(path.resolve(base, it.name)); return res; }');
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it('no function scope declares the same function/class/var name twice', () => {
    const files = [...walk('src'), ...ownWebappJs()];
    const dupes = [];
    for (const file of files) {
      const scopes = [parse(file).body];
      visit(parse(file), (n) => {
        if (/Function/.test(n.type) && n.body?.type === 'BlockStatement') scopes.push(n.body.body);
      });
      for (const body of scopes) {
        const seen = new Map();
        for (const { name, node } of scopeDeclarations(body)) {
          if (isHidden(file, node.start)) continue;
          if (seen.has(name)) dupes.push(`${rel(file)}:${node.loc.start.line} \`${name}\` already declared at line ${seen.get(name)}`);
          else seen.set(name, node.loc.start.line);
        }
      }
    }
    assert.equal(dupes.length, 0, report('Duplicate declarations in one scope (the later one silently replaces the earlier)', dupes,
      'delete the stale copy, or rename one of them if both are needed.'));
  });

  it('no top-level src/ function has a body identical to a function in another src/ file (local names ignored)', () => {
    const byShape = new Map();
    for (const file of walk('src')) {
      for (const f of topLevelFunctions(file)) {
        const { json, count } = shape({ params: f.fn.params, body: f.fn.body, async: f.fn.async }, localRenames(f.fn));
        if (count < MIN_BODY_NODES) continue;
        if (!byShape.has(json)) byShape.set(json, []);
        byShape.get(json).push({ ...f, file, line: f.fn.loc.start.line });
      }
    }
    const dupes = [];
    for (const group of byShape.values()) {
      if (new Set(group.map((g) => g.file)).size < 2) continue;
      dupes.push(group.map((g) => `${rel(g.file)}:${g.line} ${g.name}${g.exported ? ' (exported)' : ''}`).join('  ==  '));
    }
    assert.equal(dupes.length, 0, report('Copy-pasted functions (identical bodies in different src/ files)', dupes,
      'keep one exported copy (src/util/ for shared helpers) and import it everywhere else.'));
  });
});
