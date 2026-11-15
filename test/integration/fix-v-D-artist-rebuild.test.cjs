'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('artist index rebuild reports the worker result to its callbacks (N090)', () => {
  let backend, workDir;

  before(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artist-rebuild-'));
    backend = await import('../../src/db/sqlite-backend.js');
    backend.init(workDir);
  });

  after(() => { fs.rmSync(workDir, { recursive: true, force: true }); });

  const rebuild = () => new Promise(resolve => backend.rebuildArtistIndex(resolve));

  it('passes no error after a successful rebuild', async () => {
    assert.equal(await rebuild(), null);
  });

  it('passes the worker error to every queued callback', async () => {
    backend.getDB().exec('DROP TABLE artists_normalized');
    const [a, b] = await Promise.all([rebuild(), rebuild()]);
    assert.ok(a instanceof Error);
    assert.match(a.message, /artists_normalized/);
    assert.equal(b, a);
  });
});
