import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { includePrefixClauses, excludePrefixClauses } from '../src/db/sql-clauses.js';

const ROWS = [
  ['A', 'One/x.mp3', 'Alpha'],
  ['A', 'Two/y.mp3', 'Beta'],
  ['B', 'Kids/z.mp3', 'Gamma'],
  ['B', 'Grown/w.mp3', 'Delta'],
];

describe('prefix clauses narrow only the named root', () => {
  it('include keeps every other root and only the whitelisted prefix', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE files (vpath TEXT, filepath TEXT)');
    const ins = db.prepare('INSERT INTO files VALUES (?, ?)');
    for (const [v, f] of ROWS) ins.run(v, f);
    const ip = includePrefixClauses([{ vpath: 'B', prefix: 'Kids/' }]);
    const got = db.prepare(`SELECT vpath || '/' || filepath AS p FROM files WHERE 1=1${ip.sql} ORDER BY p`).all(...ip.params).map(r => r.p);
    assert.deepEqual(got, ['A/One/x.mp3', 'A/Two/y.mp3', 'B/Kids/z.mp3']);
    const ep = excludePrefixClauses([{ vpath: 'A', prefix: 'Two/' }]);
    const got2 = db.prepare(`SELECT vpath || '/' || filepath AS p FROM files WHERE 1=1${ep.sql} ORDER BY p`).all(...ep.params).map(r => r.p);
    assert.deepEqual(got2, ['A/One/x.mp3', 'B/Grown/w.mp3', 'B/Kids/z.mp3']);
  });
});

describe('artist rebuild worker with a children-only root', () => {
  let dir;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-artist-rebuild-'));
    const backend = await import('../src/db/sqlite-backend.js');
    backend.init(dir);
    const db = new DatabaseSync(path.join(dir, 'velvet.sqlite'));
    const ins = db.prepare('INSERT INTO files (vpath, filepath, artist) VALUES (?, ?, ?)');
    for (const [v, f, a] of ROWS) ins.run(v, f, a);
    db.close();
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('keeps artists from the fully enabled root', async () => {
    const worker = new Worker(new URL('../src/util/artist-rebuild-worker.mjs', import.meta.url), {
      workerData: {
        dbPath: path.join(dir, 'velvet.sqlite'),
        vpaths: ['A', 'B'],
        includeFilepathPrefixes: [{ vpath: 'B', prefix: 'Kids/' }],
        excludeFilepathPrefixes: [],
      },
    });
    const msg = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    assert.equal(msg.error, undefined);
    await new Promise(r => worker.once('exit', r));
    const db = new DatabaseSync(path.join(dir, 'velvet.sqlite'));
    const names = db.prepare('SELECT artist_clean FROM artists_normalized ORDER BY artist_clean').all().map(r => r.artist_clean);
    db.close();
    assert.deepEqual(names, ['Alpha', 'Beta', 'Gamma']);
  });
});
