/**
 * DLNA SQL Safety — Unit Tests
 * Verifies the DLNA search SQL builder keeps user-controlled values in
 * bound parameters and only allows whitelisted ORDER BY clauses.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

async function loadDlnaHelpers() {
  return import('../../src/api/dlna.js');
}

describe('DLNA SQL safety', () => {
  it('keeps search values in bound parameters', async () => {
    const { searchNodeToSql } = await loadDlnaHelpers();
    const params = [];
    const payload = `x' OR 1=1 --`;
    const sql = searchNodeToSql({
      op: 'rel',
      property: 'dc:title',
      relOp: 'contains',
      value: payload,
    }, params);

    assert.equal(sql, String.raw`COALESCE(f.title, '') LIKE ? ESCAPE '\'`);
    assert.deepEqual(params, [`%x' OR 1=1 --%`]);
    assert.ok(!sql.includes(payload), 'payload must not be interpolated into SQL text');
  });

  it('ignores unknown search properties', async () => {
    const { searchNodeToSql } = await loadDlnaHelpers();
    const params = [];
    const sql = searchNodeToSql({
      op: 'rel',
      property: 'title; DROP TABLE files; --',
      relOp: '=',
      value: 'anything',
    }, params);

    assert.equal(sql, '1=1');
    assert.deepEqual(params, []);
  });

  it('whitelists ORDER BY columns and directions', async () => {
    const { buildOrderBy } = await loadDlnaHelpers();
    const defaultOrder = 'f.title COLLATE NOCASE';
    const result = buildOrderBy([
      { prop: 'dc:title', dir: '+' },
      { prop: 'res@duration', dir: '-' },
      { prop: 'f.title; DROP TABLE files; --', dir: '-' },
    ], defaultOrder);

    assert.equal(result, 'f.title COLLATE NOCASE ASC, f.duration DESC');
    assert.ok(!result.includes('DROP TABLE'), 'malicious sort text must be ignored');
  });
});
