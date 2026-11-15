'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

describe('rows indexed on demand are marked for a full parse by the next scan', () => {
  let workDir, libDir, manager, indexFileOnDemand;

  before(async () => {
    const { ensureFixtures } = await import('../helpers/fixtures.mjs');
    const track = path.join(await ensureFixtures(), 'Artist A', 'Album X', '01 - Track One.mp3');
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ondemand-mark-'));
    libDir = path.join(workDir, 'lib');
    await fs.mkdir(libDir, { recursive: true });
    await fs.copyFile(track, path.join(libDir, 'played.mp3'));
    const configPath = path.join(workDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({
      folders: { Lib: { root: libDir } },
      db: { clearSharedInterval: 0 },
      storage: {
        dbDirectory: path.join(workDir, 'db'),
        albumArtDirectory: path.join(workDir, 'art'),
        logsDirectory: path.join(workDir, 'logs'),
      },
    }));
    const config = await import('../../src/state/config.js');
    await config.setup(configPath);
    manager = await import('../../src/db/manager.js');
    await manager.initDB();
    ({ indexFileOnDemand } = await import('../../src/util/on-demand-index.js'));
  });

  after(async () => { await fs.rm(workDir, { recursive: true, force: true }); });

  it('stores the on-demand scan id and keeps it through a fresh scan reset', async () => {
    await indexFileOnDemand({ vpath: 'Lib', basePath: libDir, relativePath: 'played.mp3', fullPath: path.join(libDir, 'played.mp3') });
    assert.equal(manager.findFileByPath('played.mp3', 'Lib').sID, manager.ON_DEMAND_SCAN_ID);

    manager.clearScanIds('Lib');
    assert.equal(manager.findFileByPath('played.mp3', 'Lib').sID, manager.ON_DEMAND_SCAN_ID);
  });

  it('a scanner insert carries its own scan id', () => {
    manager.insertFile({ filepath: 'scanned.mp3', vpath: 'Lib', sID: 'scan-1', hash: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' });
    assert.equal(manager.findFileByPath('scanned.mp3', 'Lib').sID, 'scan-1');
    manager.clearScanIds('Lib');
    assert.equal(manager.findFileByPath('scanned.mp3', 'Lib').sID, null);
  });
});
