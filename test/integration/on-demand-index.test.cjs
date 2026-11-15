'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

describe('indexFileOnDemand (src/util/on-demand-index.js)', () => {
  let workDir, libDir, config, manager, indexFileOnDemand, computeFileHash, fixtureTrack;

  const pathInfo = (vpath, basePath, relativePath) => ({
    vpath, basePath, relativePath, fullPath: path.join(basePath, relativePath),
  });

  before(async () => {
    const { ensureFixtures } = await import('../helpers/fixtures.mjs');
    fixtureTrack = path.join(await ensureFixtures(), 'Artist A', 'Album X', '01 - Track One.mp3');

    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ondemand-'));
    libDir = path.join(workDir, 'lib');
    await fs.mkdir(path.join(libDir, 'sub'), { recursive: true });
    const configPath = path.join(workDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({
      folders: { Lib: { root: libDir }, Child: { root: path.join(libDir, 'sub') } },
      db: { clearSharedInterval: 0 },
      storage: {
        dbDirectory: path.join(workDir, 'db'),
        albumArtDirectory: path.join(workDir, 'art'),
        logsDirectory: path.join(workDir, 'logs'),
      },
    }));

    config = await import('../../src/state/config.js');
    await config.setup(configPath);
    manager = await import('../../src/db/manager.js');
    await manager.initDB();
    ({ indexFileOnDemand } = await import('../../src/util/on-demand-index.js'));
    ({ computeFileHash } = await import('../../src/util/file-hash.js'));
  });

  after(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('indexes an unscanned file under its own ROOT vpath with the scanner hash and tags', async () => {
    const dest = path.join(libDir, 'root-track.mp3');
    await fs.copyFile(fixtureTrack, dest);

    const row = await indexFileOnDemand(pathInfo('Lib', libDir, 'root-track.mp3'));
    assert.ok(row);
    assert.equal(row.vpath, 'Lib');
    assert.equal(row.filepath, 'root-track.mp3');
    assert.equal(row.hash, await computeFileHash(dest));
    assert.equal(row.title, 'Track One');
    assert.equal(row.artist, 'Artist A');
    assert.equal(row.album, 'Album X');

    const stored = manager.findFileByPath('root-track.mp3', 'Lib');
    assert.ok(stored, 'row must be in the files table');
    assert.match(stored.hash, /^[a-f0-9]{32}$/);
  });

  it('stores a file played through a child vpath under the parent ROOT with the child prefix', async () => {
    await fs.copyFile(fixtureTrack, path.join(libDir, 'sub', 'child-track.mp3'));

    const row = await indexFileOnDemand(pathInfo('Child', path.join(libDir, 'sub'), 'child-track.mp3'));
    assert.equal(row.vpath, 'Lib');
    assert.equal(row.filepath, 'sub/child-track.mp3');
    assert.ok(manager.findFileByPath('sub/child-track.mp3', 'Lib'));
    assert.equal(manager.findFileByPath('child-track.mp3', 'Child'), null, 'no row under the child vpath name');
  });

  it('returns the existing row instead of inserting a duplicate on a second play', async () => {
    const info = pathInfo('Lib', libDir, 'root-track.mp3');
    const before = manager.countFilesByVpath('Lib');
    const again = await indexFileOnDemand(info);
    assert.equal(again.filepath, 'root-track.mp3');
    assert.equal(manager.countFilesByVpath('Lib'), before);
  });

  it('inserts one row when the same new file is played twice at once', async () => {
    await fs.copyFile(fixtureTrack, path.join(libDir, 'race-track.mp3'));
    const info = pathInfo('Lib', libDir, 'race-track.mp3');
    const before = manager.countFilesByVpath('Lib');
    const [a, b] = await Promise.all([indexFileOnDemand(info), indexFileOnDemand(info)]);
    assert.equal(a.filepath, 'race-track.mp3');
    assert.equal(b.filepath, 'race-track.mp3');
    assert.equal(manager.countFilesByVpath('Lib'), before + 1);
  });

  it('returns null for a missing file', async () => {
    assert.equal(await indexFileOnDemand(pathInfo('Lib', libDir, 'does-not-exist.mp3')), null);
  });

  it('returns null for a path that escapes the vpath root', async () => {
    const outside = path.join(workDir, 'outside.mp3');
    await fs.copyFile(fixtureTrack, outside);
    assert.equal(await indexFileOnDemand(pathInfo('Lib', libDir, '../outside.mp3')), null);
    assert.equal(manager.findFileByPath('../outside.mp3', 'Lib'), null);
  });
});
