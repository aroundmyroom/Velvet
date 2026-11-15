import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { walk, parse, visit, rel, where, report } from './helpers/arch.mjs';

const insideDb = (file) => rel(file).startsWith('src/db/');

function importSource(n) {
  if (/^(ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration|ImportExpression)$/.test(n.type)) return n.source;
  if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require') return n.arguments[0];
  return null;
}

describe('architecture: database boundary', () => {
  it('only src/db/ imports src/db/sqlite-backend.js', () => {
    const hits = [];
    for (const file of walk('src')) {
      if (insideDb(file)) continue;
      visit(parse(file), (n) => {
        const spec = importSource(n);
        if (spec?.type !== 'Literal' || typeof spec.value !== 'string' || !spec.value.startsWith('.')) return;
        if (rel(path.resolve(path.dirname(file), spec.value)) === 'src/db/sqlite-backend.js') hits.push(where(file, n));
      });
    }
    assert.equal(hits.length, 0, report('Direct imports of src/db/sqlite-backend.js outside src/db/', hits,
      'import from src/db/manager.js (the public DB facade) instead; add the function there if it is missing.'));
  });

  it('no `getDB()` call in src/ outside src/db/', () => {
    const hits = [];
    for (const file of walk('src')) {
      if (insideDb(file)) continue;
      visit(parse(file), (n) => {
        if (n.type !== 'CallExpression') return;
        const c = n.callee;
        const name = c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' && !c.computed ? c.property.name : null);
        if (name === 'getDB') hits.push(where(file, n));
      });
    }
    assert.equal(hits.length, 0, report('Raw database handles used outside src/db/', hits,
      'write the SQL as a named function in src/db/sqlite-backend.js and call it through a src/db/manager.js wrapper.'));
  });

  it('no `new DatabaseSync(` in src/ outside src/db/', () => {
    const hits = [];
    for (const file of walk('src')) {
      if (insideDb(file)) continue;
      visit(parse(file), (n) => {
        if (n.type === 'NewExpression' && n.callee.type === 'Identifier' && n.callee.name === 'DatabaseSync') hits.push(where(file, n));
      });
    }
    assert.equal(hits.length, 0, report('SQLite connections opened outside src/db/', hits,
      'move the query into src/db/ (sqlite-backend.js + a manager.js wrapper). A worker thread that needs its own connection '
      + 'opens it through a shared opener in src/db/ so every connection gets the same WAL/busy_timeout pragmas.'));
  });
});
