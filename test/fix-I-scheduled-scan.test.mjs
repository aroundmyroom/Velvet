import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as config from '../src/state/config.js';

const PROD_DATE_FILE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../save/scan-state/scheduled-fired-date.txt');
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const statOrNull = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };

describe('scheduled scan fires once per calendar day (N053)', () => {
  let tmp, dateFile, tq, prodBefore;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-sched-'));
    dateFile = path.join(tmp, 'scan-state', 'scheduled-fired-date.txt');
    const cfgFile = path.join(tmp, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({
      storage: { dbDirectory: path.join(tmp, 'db'), albumArtDirectory: path.join(tmp, 'img'), logsDirectory: path.join(tmp, 'logs') },
      scanOptions: { scanInterval: 24, scanStartTime: '15:00' },
      folders: {},
    }));
    await config.setup(cfgFile);
    prodBefore = statOrNull(PROD_DATE_FILE);
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at(2026, 11, 15, 14, 0) });
    tq = await import('../src/db/task-queue.js');
  });

  after(() => {
    tq.reset();
    mock.timers.reset();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the daily timer fires at the start time and records the day in the test DB dir', () => {
    tq.resetScanInterval();
    assert.equal(tq.getNextScanMs(), at(2026, 11, 15, 15, 0));
    assert.equal(fs.existsSync(dateFile), false);
    mock.timers.tick(60 * 60 * 1000);
    assert.equal(fs.readFileSync(dateFile, 'utf8'), '2026-11-15');
    assert.equal(tq.getNextScanMs(), at(2026, 11, 16, 15, 0));
  });

  it('does not fire a second time the same day', () => {
    assert.equal(tq.fireScheduledScan(), false);
    tq.resetScanInterval();
    assert.equal(tq.fireScheduledScan(), false);
    assert.equal(fs.readFileSync(dateFile, 'utf8'), '2026-11-15');
  });

  it('a restart later the same day still skips (the date file survives)', async () => {
    const restarted = await import(`../src/db/task-queue.js?restart=${Date.now()}`);
    assert.equal(restarted.fireScheduledScan(), false);
  });

  it('fires again on the next day', () => {
    mock.timers.tick(24 * 60 * 60 * 1000);
    assert.equal(fs.readFileSync(dateFile, 'utf8'), '2026-11-16');
    assert.equal(tq.fireScheduledScan(), false);
  });

  it('never touches the production save/ directory', () => {
    assert.equal(statOrNull(PROD_DATE_FILE), prodBefore);
  });
});
