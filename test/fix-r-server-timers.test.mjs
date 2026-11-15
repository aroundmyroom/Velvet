import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as config from '../src/state/config.js';

function countTimers(fn) {
  const t = mock.method(globalThis, 'setTimeout', () => 0);
  const i = mock.method(globalThis, 'setInterval', () => 0);
  try {
    fn();
    return { timeouts: t.mock.callCount(), intervals: i.mock.callCount() };
  } finally {
    t.mock.restore();
    i.mock.restore();
  }
}

describe('P079/P097: boot timers start once per process', () => {
  let tmp;
  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'velvet-timers-'));
    const cfgFile = path.join(tmp, 'config.json');
    await fs.writeFile(cfgFile, JSON.stringify({
      telemetry: true,
      storage: { dbDirectory: path.join(tmp, 'db'), albumArtDirectory: path.join(tmp, 'img'), logsDirectory: path.join(tmp, 'logs') },
    }));
    await config.setup(cfgFile);
  });
  after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('telemetry setup twice registers one boot timeout', async () => {
    const telemetry = await import('../src/api/telemetry.js');
    const n = countTimers(() => { telemetry.setup('0.0.0'); telemetry.setup('0.0.0'); });
    assert.equal(n.timeouts, 1);
  });

  it('backup setup twice registers one weekly-check timeout', async () => {
    const backup = await import('../src/api/backup.js');
    const app = new Proxy({}, { get: () => () => {} });
    const n = countTimers(() => { backup.setup(app); backup.setup(app); });
    assert.equal(n.timeouts, 1);
  });

  it('smart-playlist startCron twice registers one timeout and one interval', async () => {
    const gen = await import('../src/smartplaylist/playlist-generator.js');
    const n = countTimers(() => { gen.startCron(); gen.startCron(); });
    assert.deepEqual(n, { timeouts: 1, intervals: 1 });
  });
});

describe('P080/P139: dead exports are gone', () => {
  it('config no longer exports getDefaults/testValidation and has no rpn section', () => {
    assert.equal(config.getDefaults, undefined);
    assert.equal(config.testValidation, undefined);
    assert.equal(config.program.rpn, undefined);
  });

  it('logRetention uses the logger list', async () => {
    const { VALID_RETENTIONS, DEFAULT_RETENTION } = await import('../src/logger.js');
    assert.ok(VALID_RETENTIONS.includes(config.program.logRetention));
    assert.equal(config.program.logRetention, DEFAULT_RETENTION);
  });

  it('self-update keeps parseVersion/AUTO_STAMPED_FILES private', async () => {
    const su = await import('../src/util/self-update.js');
    assert.equal(su.parseVersion, undefined);
    assert.equal(su.AUTO_STAMPED_FILES, undefined);
    assert.equal(su.compareVersions('1.2.3', '1.2.4'), -1);
  });
});
