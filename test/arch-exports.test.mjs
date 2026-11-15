import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, walk, parse, visit, rel, report } from './helpers/arch.mjs';

// Exports nobody imports by name, kept on purpose. One line of reason each.
// An import from test/ counts as use: an export a unit test imports is a legitimate test seam.
// Key: 'src/path/file.js#exportName'.
const ALLOWED_UNUSED = new Map([
]);

const CONSUMERS = [
  ...walk('src'), ...walk('test'), ...walk('scripts'),
  ...fs.readdirSync(ROOT).filter((f) => /\.(js|mjs|cjs)$/.test(f)).map((f) => path.join(ROOT, f)),
];

const SRC_BY_BASENAME = new Map();
for (const f of walk('src')) {
  const b = path.basename(f);
  SRC_BY_BASENAME.set(b, [...(SRC_BY_BASENAME.get(b) ?? []), f]);
}

function resolveImport(from, spec) {
  if (typeof spec !== 'string' || !spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function exportsOf(file) {
  const names = new Map();
  const addPattern = (p) => {
    if (p.type === 'Identifier') names.set(p.name, p.loc.start.line);
    else if (p.type === 'ObjectPattern') p.properties.forEach((x) => addPattern(x.value ?? x.argument));
    else if (p.type === 'ArrayPattern') p.elements.filter(Boolean).forEach(addPattern);
    else if (p.type === 'AssignmentPattern') addPattern(p.left);
    else if (p.type === 'RestElement') addPattern(p.argument);
  };
  for (const s of parse(file).body) {
    if (s.type === 'ExportDefaultDeclaration') names.set('default', s.loc.start.line);
    if (s.type !== 'ExportNamedDeclaration') continue;
    const d = s.declaration;
    if (d?.id) names.set(d.id.name, d.loc.start.line);
    if (d?.type === 'VariableDeclaration') d.declarations.forEach((v) => addPattern(v.id));
    for (const sp of s.specifiers) names.set(sp.exported.name ?? sp.exported.value, sp.loc.start.line);
  }
  return names;
}

function namesMentioned(ast) {
  const out = new Set();
  visit(ast, (n) => {
    if (n.type === 'Identifier') out.add(n.name);
    if (n.type === 'Literal' && typeof n.value === 'string') out.add(n.value);
  });
  return out;
}

function usedNames() {
  const used = new Map();
  const mark = (file, name) => {
    if (!used.has(file)) used.set(file, new Set());
    used.get(file).add(name);
  };
  const markAll = (target, from) => {
    for (const name of namesMentioned(parse(from))) mark(target, name);
    mark(target, 'default');
  };
  for (const file of CONSUMERS) {
    const ast = parse(file);
    const namespaces = new Map();
    let computedImport = false;
    visit(ast, (n) => {
      if (n.type === 'ImportDeclaration' || ((n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source)) {
        const target = resolveImport(file, n.source.value);
        if (!target) return;
        if (n.type === 'ExportAllDeclaration') { markAll(target, target); return; }
        for (const sp of n.specifiers) {
          if (sp.type === 'ImportDefaultSpecifier') mark(target, 'default');
          else if (sp.type === 'ImportNamespaceSpecifier') namespaces.set(sp.local.name, target);
          else mark(target, (sp.imported ?? sp.local).name ?? (sp.imported ?? sp.local).value);
        }
        return;
      }
      const dynamic = n.type === 'ImportExpression' ? n.source
        : n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require' ? n.arguments[0] : null;
      if (dynamic?.type === 'Literal') {
        const target = resolveImport(file, dynamic.value);
        if (target) markAll(target, file);
      } else if (dynamic) {
        computedImport = true;
      }
    });
    if (computedImport) {
      // import(path.join(dir, 'x.js')): any src file named by a string literal here may be the target.
      for (const lit of namesMentioned(ast)) {
        if (!/\.[mc]?js$/.test(lit)) continue;
        for (const f of SRC_BY_BASENAME.get(path.basename(lit)) ?? []) markAll(f, file);
      }
    }
    if (!namespaces.size) continue;
    visit(ast, (n) => {
      if (n.type === 'MemberExpression' && n.object.type === 'Identifier' && namespaces.has(n.object.name)) {
        mark(namespaces.get(n.object.name), n.computed ? n.property.value : n.property.name);
      }
    });
  }
  return used;
}

describe('architecture: exports', () => {
  it('every export in src/ is imported somewhere (src/, test/, scripts/, root scripts)', () => {
    const used = usedNames();
    const unused = [];
    const stale = [];
    for (const file of walk('src')) {
      for (const [name, line] of exportsOf(file)) {
        const key = `${rel(file)}#${name}`;
        const isUsed = used.get(file)?.has(name);
        if (ALLOWED_UNUSED.has(key)) {
          if (isUsed) stale.push(key);
        } else if (!isUsed) {
          unused.push(`${rel(file)}:${line} ${name}`);
        }
      }
    }
    for (const key of ALLOWED_UNUSED.keys()) {
      const [f, name] = key.split('#');
      if (!fs.existsSync(path.join(ROOT, f)) || !exportsOf(path.join(ROOT, f)).has(name)) stale.push(key);
    }
    assert.equal(unused.length, 0, report('Exports in src/ that nothing imports', unused,
      'drop the `export` keyword (or the whole function if it is dead). If an outside loader really needs it, add '
      + "`['src/file.js#name', 'reason']` to ALLOWED_UNUSED in test/arch-exports.test.mjs."));
    assert.equal(stale.length, 0, report('Stale ALLOWED_UNUSED entries (now imported, or gone)', stale,
      'remove them from ALLOWED_UNUSED in test/arch-exports.test.mjs.'));
  });
});
