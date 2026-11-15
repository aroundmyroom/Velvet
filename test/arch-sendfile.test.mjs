import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as acorn from 'acorn';
import { walk, parse, visit, read, rel, where, report } from './helpers/arch.mjs';

const RESOLVERS = new Set(['resolvePathWithinRoot', 'resolveChildPath', 'resolveMediaPath']);
const PURE_CALLS = new Set(['path.join', 'path.resolve', 'path.basename', 'os.tmpdir', 'fsp.mkdtemp', 'fs.mkdtempSync','process.cwd', 'crypto.randomUUID', 'Date.now', 'String']);

// res.sendFile(<arg>) calls the checker cannot prove safe, reviewed by hand.
// Key: 'src/file.js#<source text of the path argument>'.
const ALLOWED = new Map([
  ['src/api/subsonic.js#servePath', 'getCoverArt: _resolveThumb() only returns resolveChildPath(artDir, …) or a thumb inside artDir'],
]);

const isFn = (n) => /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);

function patternNames(p, out = new Set()) {
  if (!p) return out;
  if (p.type === 'Identifier') out.add(p.name);
  else if (p.type === 'ObjectPattern') p.properties.forEach((x) => patternNames(x.value ?? x.argument, out));
  else if (p.type === 'ArrayPattern') p.elements.forEach((x) => patternNames(x, out));
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  else if (p.type === 'RestElement') patternNames(p.argument, out);
  return out;
}

function calleeName(c) {
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier') return `${c.object.name}.${c.property.name}`;
  return null;
}

function bindingSources(name, fns) {
  for (const fn of [...fns].reverse()) {
    if (fn.params.some((p) => patternNames(p).has(name))) return { param: true };
    const values = [];
    let declared = false;
    visit(fn.body, (n) => {
      if (n.type === 'VariableDeclarator' && patternNames(n.id).has(name)) {
        declared = true;
        if (n.id.type !== 'Identifier') values.push(null);
        else if (n.init) values.push(n.init);
      }
      if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && n.left.name === name) values.push(n.right);
    });
    if (declared) return { values };
  }
  return null;
}

// A module-level `const` is traced through its initialiser; anything else at module level (an import,
// a `let` some handler may reassign) cannot be proven and fails.
function moduleConst(name, program) {
  for (const s of program.body) {
    const d = s.type === 'ExportNamedDeclaration' ? s.declaration : s;
    if (d?.type !== 'VariableDeclaration') continue;
    for (const v of d.declarations) {
      if (v.id.type === 'Identifier' && v.id.name === name) return d.kind === 'const' ? v.init : null;
    }
  }
  return null;
}

function safe(expr, scope, depth = 0) {
  if (!expr || depth > 8) return false;
  const sub = (e) => safe(e, scope, depth + 1);
  switch (expr.type) {
    case 'Literal': return true;
    case 'ChainExpression': return sub(expr.expression);
    case 'AwaitExpression': return sub(expr.argument);
    case 'TemplateLiteral': return expr.expressions.every(sub);
    case 'LogicalExpression':
    case 'BinaryExpression': return sub(expr.left) && sub(expr.right);
    case 'ConditionalExpression': return sub(expr.consequent) && sub(expr.alternate);
    case 'MemberExpression': {
      let root = expr;
      while (root.type === 'MemberExpression') root = root.object;
      if (root.type === 'Identifier' && root.name === 'config') return true;
      return sub(root);
    }
    case 'CallExpression': {
      const name = calleeName(expr.callee);
      if (RESOLVERS.has(name)) return true;
      if (PURE_CALLS.has(name)) return expr.arguments.every(sub);
      return false;
    }
    case 'Identifier': {
      const b = bindingSources(expr.name, scope.fns);
      if (!b) return safe(moduleConst(expr.name, scope.program), { fns: [], program: scope.program }, depth + 1);
      if (b.param) return false;
      return b.values.length > 0 && b.values.every(sub);
    }
    default: return false;
  }
}

describe('architecture: sendFile path safety', () => {
  it('traces module-level consts and rejects names it cannot trace', () => {
    const check = (code) => {
      const program = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
      let verdict;
      visit(program, (n, ancestors) => {
        if (n.type === 'CallExpression' && n.callee.property?.name === 'sendFile') verdict = safe(n.arguments[0], { fns: ancestors.filter(isFn), program });
      });
      return verdict;
    };
    assert.equal(check("const DIR = path.join(os.tmpdir(), 'x'); export function h(req, res) { res.sendFile(DIR); }"), true);
    assert.equal(check("let last = ''; export function h(req, res) { res.sendFile(last); }"), false);
    assert.equal(check("import { p } from './x.js'; export function h(req, res) { res.sendFile(p); }"), false);
    assert.equal(check('export function h(req, res) { res.sendFile(req.query.f); }'), false);
  });

  it('every res.sendFile() uses a root option or a path from a path-security resolver', () => {
    const hits = [];
    const used = new Set();
    for (const file of walk('src')) {
      const src = read(file);
      const program = parse(file);
      visit(program, (n, ancestors) => {
        if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.property.name !== 'sendFile') return;
        const [target, opts] = n.arguments;
        if (opts?.type === 'ObjectExpression' && opts.properties.some((p) => p.key?.name === 'root')) return;
        if (safe(target, { fns: ancestors.filter(isFn), program })) return;
        const key = `${rel(file)}#${src.slice(target.start, target.end)}`;
        if (ALLOWED.has(key)) { used.add(key); return; }
        hits.push(`${where(file, n)} res.sendFile(${src.slice(target.start, target.end)})`);
      });
    }
    const stale = [...ALLOWED.keys()].filter((k) => !used.has(k));
    assert.equal(hits.length, 0, report('res.sendFile() with a path that is not proven to stay inside its root', hits,
      "pass `{ root: <dir> }` with a relative name, or build the path with resolvePathWithinRoot()/resolveChildPath()/resolveMediaPath() "
      + "in the same function. If it is safe for another reason, add `['file#arg', 'reason']` to ALLOWED in test/arch-sendfile.test.mjs."));
    assert.equal(stale.length, 0, report('Stale ALLOWED entries in test/arch-sendfile.test.mjs', stale, 'remove them.'));
  });
});
