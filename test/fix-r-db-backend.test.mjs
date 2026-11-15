import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let dir, backend, raw;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-rdb-'));
  backend = await import('../src/db/sqlite-backend.js');
  backend.init(dir);
  raw = new DatabaseSync(path.join(dir, 'velvet.sqlite'));
});
after(() => { raw.close(); backend.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('updateFileAlbumVersion keeps search in sync', () => {
  it('the new version word matches and the old one no longer does', () => {
    backend.insertFile({ vpath: 'v', filepath: 'A/Album/1.mp3', title: 'Song', artist: 'Art', album: 'Alb', format: 'mp3', hash: 'h-av' });
    const hits = (word) => raw.prepare('SELECT rowid FROM fts_files WHERE fts_files MATCH ?').all(word).length;
    assert.equal(hits('Remastered'), 0);
    backend.updateFileAlbumVersion('A/Album/1.mp3', 'v', 'Remastered', 'tag');
    assert.equal(hits('Remastered'), 1);
    backend.updateFileAlbumVersion('A/Album/1.mp3', 'v', 'Deluxe', 'tag');
    assert.equal(hits('Remastered'), 0);
    assert.equal(hits('Deluxe'), 1);
    assert.equal(hits('Song'), 1);
  });
});

describe('dead exports are gone', () => {
  it('sqlite-backend drops the no-op save functions and unused helpers', () => {
    for (const name of ['saveFilesDB', 'saveUserDB', 'saveShareDB', 'getRandomSongsForAutoDj', 'deleteAllPasskeysByUsername']) {
      assert.equal(name in backend, false, name);
    }
    const src = fs.readFileSync(path.join(repo, 'src/db/sqlite-backend.js'), 'utf8');
    assert.doesNotMatch(src, /_cleanArtist|_normalizeArtist/);
  });

  it('task-queue and media-access drop their unused exports', () => {
    const tq = fs.readFileSync(path.join(repo, 'src/db/task-queue.js'), 'utf8');
    assert.doesNotMatch(tq, /export function (getScanStatePath|getAdminStats)\b/);
    const ma = fs.readFileSync(path.join(repo, 'src/util/media-access.js'), 'utf8');
    assert.doesNotMatch(ma, /export function getMediaVpathFromPath\b/);
  });

  it('a resumed scan clears progress under the id it registered', () => {
    const tq = fs.readFileSync(path.join(repo, 'src/db/task-queue.js'), 'utf8');
    assert.match(tq, /scanProgress\.finish\(scanId\)/);
    assert.doesNotMatch(tq, /scanProgress\.finish\(scanObj\.id\)/);
  });
});

describe('manager wraps passkey and smart-playlist functions', () => {
  it('exports them and no save*DB', async () => {
    const manager = await import('../src/db/manager.js');
    const keys = Object.keys(manager);
    for (const name of ['getPasskeyByCredentialId', 'getPasskeysByUsername', 'insertPasskey', 'updatePasskeyCounter', 'deletePasskeyById',
      'spGetAllTracksWithFeatures', 'spGetProfile', 'spUpsertProfile', 'spGetNewEvents', 'spGetTrackFeatures',
      'spGetGeneratedPlaylist', 'spUpsertGeneratedPlaylist', 'spGetAllUserIds', 'spGetStats', 'spResetProfiles']) {
      assert.ok(keys.includes(name), name);
    }
    for (const name of ['saveFilesDB', 'saveUserDB', 'saveShareDB']) assert.equal(keys.includes(name), false, name);
  });
});

describe('readPlaylistSongs checks the library root', () => {
  it('accepts a symlink inside the root and rejects one that leaves it', async () => {
    const { readPlaylistSongs } = await import('../src/util/m3u.js');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-rdb-m3u-'));
    const root = path.join(base, 'root');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.m3u'), 'one.mp3\ntwo.mp3\n');
    fs.writeFileSync(path.join(base, 'outside.m3u'), 'x.mp3\n');
    fs.symlinkSync('../a.m3u', path.join(root, 'sub', 'link.m3u'));
    fs.symlinkSync(path.join(base, 'outside.m3u'), path.join(root, 'sub', 'out.m3u'));
    try {
      assert.deepEqual(await readPlaylistSongs(path.join(root, 'sub', 'link.m3u'), root), ['one.mp3', 'two.mp3']);
      await assert.rejects(readPlaylistSongs(path.join(root, 'sub', 'out.m3u'), root), /outside allowed roots/i);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('rootVpathOf with three levels', () => {
  it('resolves the innermost folder to the root in any config order', async () => {
    const { rootVpathOf } = await import('../src/util/vpath.js');
    const entries = [['A', { root: '/m' }], ['B', { root: '/m/x' }], ['C', { root: '/m/x/y' }]];
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]]) {
      const folders = Object.fromEntries(order.map(i => entries[i]));
      assert.deepEqual(rootVpathOf('C', folders), { vpath: 'A', prefix: 'x/y/' });
    }
  });
});

describe('image-compress-script skips non-image files quietly', () => {
  it('exits 0 with nothing on stderr', () => {
    const artDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-rdb-art-'));
    const png = execFileSync(process.execPath, ['-e',
      "require('sharp')({create:{width:400,height:400,channels:3,background:'#f00'}}).png({compressionLevel:0}).toBuffer().then(b=>process.stdout.write(b))"],
    { cwd: repo });
    fs.writeFileSync(path.join(artDir, 'a.png'), png);
    fs.writeFileSync(path.join(artDir, 'README'), 'x');
    fs.writeFileSync(path.join(artDir, 'x.part'), 'x');
    try {
      const r = spawnSync(process.execPath, [path.join(repo, 'src/db/image-compress-script.js'), JSON.stringify({ albumArtDirectory: artDir })], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, '');
      assert.doesNotMatch(r.stdout, /error on file/);
      const files = fs.readdirSync(artDir);
      assert.ok(files.some(f => f.startsWith('zs-') && f.includes('a')), files.join(','));
      assert.equal(files.some(f => /^z[slm]-(README|x\.part)/.test(f)), false);
    } finally {
      fs.rmSync(artDir, { recursive: true, force: true });
    }
  });
});
