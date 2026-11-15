import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { computeFileHash, HASH_READ_LIMIT } from '../src/util/file-hash.js';

// Verbatim copy of the scanner's former calculateHash, to prove the shared helper is byte-identical.
function oldCalculateHash(filepath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5').setEncoding('hex');
    const fileStream = fs.createReadStream(filepath, { start: 0, end: 524288 - 1 });
    let bytesRead = 0;
    fileStream.on('error', reject);
    fileStream.on('data', (chunk) => { bytesRead += chunk.length; });
    fileStream.on('end', () => {
      hash.end();
      fileStream.close();
      if (bytesRead === 0) { reject(new Error('0 bytes')); return; }
      resolve(hash.read());
    });
    fileStream.pipe(hash);
  });
}

const BACKEND = new URL('../src/db/sqlite-backend.js', import.meta.url).href;
const SCANNER = new URL('../src/db/scanner.mjs', import.meta.url);

describe('computeFileHash matches the old scanner hash', () => {
  let dir;
  const files = {};
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-arthash-'));
    const sizes = { tiny: 1, small: 4000, exact: HASH_READ_LIMIT, over: HASH_READ_LIMIT + 1, big: 3 * HASH_READ_LIMIT + 17 };
    for (const [name, size] of Object.entries(sizes)) {
      files[name] = path.join(dir, name + '.bin');
      fs.writeFileSync(files[name], crypto.randomBytes(size));
    }
    files.empty = path.join(dir, 'empty.bin');
    fs.writeFileSync(files.empty, '');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('limit is 512 KB', () => assert.equal(HASH_READ_LIMIT, 524288));

  for (const name of ['tiny', 'small', 'exact', 'over', 'big']) {
    it(`${name} file`, async () => {
      const got = await computeFileHash(files[name]);
      assert.equal(got, await oldCalculateHash(files[name]));
      assert.match(got, /^[a-f0-9]{32}$/);
      const head = fs.readFileSync(files[name]).subarray(0, HASH_READ_LIMIT);
      assert.equal(got, crypto.createHash('md5').update(head).digest('hex'));
    });
  }

  it('rejects a 0-byte file like the old one did', async () => {
    await assert.rejects(computeFileHash(files.empty));
    await assert.rejects(oldCalculateHash(files.empty));
  });

  it('scanner no longer has its own hash function', () => {
    const src = fs.readFileSync(SCANNER, 'utf8');
    assert.ok(!src.includes('function calculateHash'));
    assert.ok(!/const HASH_READ_LIMIT/.test(src));
    assert.ok(src.includes('computeFileHash(thisSong)'));
  });
});

describe('repairLongHashes (user_version v4)', () => {
  let dir, musicDir, backend, dbPath;
  const OLD = 'a'.repeat(64);
  const GONE = 'b'.repeat(64);
  const KEEP = 'c'.repeat(32);
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-hashrepair-'));
    musicDir = path.join(dir, 'music');
    fs.mkdirSync(path.join(musicDir, 'Al'), { recursive: true });
    fs.writeFileSync(path.join(musicDir, 'Al', 'a.mp3'), crypto.randomBytes(9000));
    fs.writeFileSync(path.join(musicDir, 'Al', 'keep.mp3'), crypto.randomBytes(100));
    dbPath = path.join(dir, 'velvet.sqlite');
    execFileSync(process.execPath, ['--input-type=module', '-e', `import * as b from ${JSON.stringify(BACKEND)}; b.init(${JSON.stringify(dir)});`], { stdio: 'ignore' });
    const raw = new DatabaseSync(dbPath);
    const ins = raw.prepare('INSERT INTO files (vpath, filepath, hash) VALUES (?, ?, ?)');
    ins.run('Music', 'Al/a.mp3', OLD);
    ins.run('Music', 'Al/missing.mp3', GONE);
    ins.run('Music', 'Al/keep.mp3', KEEP);
    raw.prepare("INSERT INTO user_metadata (hash, user, pc, rating) VALUES (?, 'u', 7, 8)").run(OLD);
    raw.prepare("INSERT INTO play_events (user_id, file_hash, started_at) VALUES ('u', ?, 1)").run(OLD);
    raw.exec('PRAGMA user_version = 3');
    raw.close();
    backend = await import('../src/db/sqlite-backend.js');
    backend.init(dir);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('re-hashes existing files with MD5 and moves their stats', async () => {
    const res = await backend.repairLongHashes({ Music: { root: musicDir } });
    assert.deepEqual(res, { found: 2, fixed: 1 });
    const db = backend.getDB();
    const want = await computeFileHash(path.join(musicDir, 'Al', 'a.mp3'));
    assert.equal(db.prepare("SELECT hash FROM files WHERE filepath = 'Al/a.mp3'").get().hash, want);
    assert.equal(db.prepare('SELECT pc FROM user_metadata WHERE hash = ?').get(want).pc, 7);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM play_events WHERE file_hash = ?').get(want).c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM user_metadata WHERE hash = ?').get(OLD).c, 0);
  });

  it('skips files that no longer exist and leaves MD5 rows alone', () => {
    const db = backend.getDB();
    assert.equal(db.prepare("SELECT hash FROM files WHERE filepath = 'Al/missing.mp3'").get().hash, GONE);
    assert.equal(db.prepare("SELECT hash FROM files WHERE filepath = 'Al/keep.mp3'").get().hash, KEEP);
  });

  it('marks the DB as v4', () => {
    assert.equal(backend.getDB().prepare('PRAGMA user_version').get().user_version, 4);
  });
});
