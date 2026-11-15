import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { albumFolderPath, isDiscFolder } from '../src/util/album-dir.js';

const md5_16 = s => crypto.createHash('md5').update(s).digest('hex').slice(0, 16);
const folderId = (vpath, dir) => md5_16(`dir|||${vpath}|||${dir}`);
const BACKEND = new URL('../src/db/sqlite-backend.js', import.meta.url).href;

describe('albumFolderPath', () => {
  const CASES = [
    ['A/CD1/x.mp3', 'A'],
    ['A/Disc 2/x.mp3', 'A'],
    ['A/1/x.mp3', 'A'],
    ['A/02/x.mp3', 'A'],
    ['A/Album CD - 1/x.mp3', 'A'],
    ['A/Disk 1/x.mp3', 'A/Disk 1'],
    ['A/Disconet/x.mp3', 'A/Disconet'],
    ['A/x.mp3', 'A'],
    ['CD1/x.mp3', 'CD1'],
    ['x.mp3', null],
  ];
  for (const [fp, want] of CASES) it(fp, () => assert.equal(albumFolderPath(fp), want));
  it('disc folder detection', () => {
    assert.ok(isDiscFolder('CD 3'));
    assert.ok(!isDiscFolder('CD Edition'));
    assert.ok(!isDiscFolder('123'));
  });
});

describe('album ids and folder-metadata backfill', () => {
  let dir, backend, dbPath;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-albumdir-'));
    dbPath = path.join(dir, 'velvet.sqlite');
    execFileSync(process.execPath, ['--input-type=module', '-e', `import * as b from ${JSON.stringify(BACKEND)}; b.init(${JSON.stringify(dir)});`], { stdio: 'ignore' });
    const raw = new DatabaseSync(dbPath);
    raw.prepare("INSERT INTO files (vpath, filepath, artist, album, album_id, mb_release_id, mb_album_dir) VALUES ('v', 'Old/Disk 1/a.mp3', 'X', 'Y', 'tagbasedbadid000', 'rel', 'Old')").run();
    raw.prepare("INSERT INTO files (vpath, filepath, artist, album, album_id, mb_release_id, mb_album_dir) VALUES ('v', 'Multi/2/b.mp3', 'X', 'Y', 'tagbasedbadid001', 'rel2', 'Multi/2')").run();
    raw.exec('PRAGMA user_version = 2');
    raw.close();
    backend = await import('../src/db/sqlite-backend.js');
    backend.init(dir);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('init repairs album ids and regroups mb_album_dir once', () => {
    const raw = new DatabaseSync(dbPath);
    const rows = raw.prepare('SELECT filepath, album_id, mb_album_dir FROM files ORDER BY filepath').all();
    assert.ok(raw.prepare('PRAGMA user_version').get().user_version >= 3);
    raw.close();
    assert.deepEqual(rows.map(r => ({ ...r })), [
      { filepath: 'Multi/2/b.mp3', album_id: folderId('v', 'Multi'), mb_album_dir: 'Multi' },
      { filepath: 'Old/Disk 1/a.mp3', album_id: folderId('v', 'Old/Disk 1'), mb_album_dir: 'Old/Disk 1' },
    ]);
  });

  it('insertFile computes both ids itself', () => {
    backend.insertFile({ vpath: 'v', filepath: 'A/B/1.mp3', artist: 'X', album: 'Y', artist_id: 'ignored', album_id: 'ignored', format: 'mp3', hash: 'h-insert' });
    const raw = new DatabaseSync(dbPath);
    const row = raw.prepare("SELECT artist_id, album_id FROM files WHERE hash = 'h-insert'").get();
    raw.close();
    assert.equal(row.artist_id, md5_16('x'));
    assert.equal(row.album_id, folderId('v', 'A/B'));
  });

  it('backfillFolderMetadata writes folder album ids and refreshes search', () => {
    for (const n of ['01', '02']) {
      backend.insertFile({ vpath: 'v', filepath: `Zappa Band - Hot Album/${n} Song ${n}.mp3`, format: 'mp3', hash: `h-bf-${n}` });
    }
    const updated = backend.backfillFolderMetadata();
    assert.equal(updated, 2);
    const raw = new DatabaseSync(dbPath);
    const rows = raw.prepare("SELECT artist, album_id, artist_id FROM files WHERE hash LIKE 'h-bf-%'").all();
    const fts = raw.prepare("SELECT rowid FROM fts_files WHERE fts_files MATCH 'artist:Zappa'").all();
    raw.close();
    for (const r of rows) {
      assert.equal(r.artist, 'Zappa Band');
      assert.equal(r.album_id, folderId('v', 'Zappa Band - Hot Album'));
      assert.equal(r.artist_id, md5_16('zappa band'));
    }
    assert.equal(fts.length, 2);
  });
});
