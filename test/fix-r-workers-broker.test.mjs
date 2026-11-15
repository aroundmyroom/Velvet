// Long background passes run as chunks so other broker tasks get a turn (P102),
// and worker log lines reach the server log (P103).
//
// Run with:
//   node --test test/fix-r-workers-broker.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import winston from 'winston';
import * as broker from '../src/state/bg-task-broker.js';
import { createWorkerController } from '../src/util/worker-controller.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('bg-task-broker chunks', () => {
  it('a task submitted during a chunked pass starts before the pass ends', async () => {
    const order = [];
    let left = 5;
    broker.submitChunks('fix-r-long', 'long pass', async () => {
      order.push(`chunk${5 - left}`);
      await sleep(20);
      left--;
      return left > 0;
    });
    await sleep(5);
    broker.submit('fix-r-other', 'other task', async () => { order.push('other'); });
    while (left > 0 || broker.isBusy() || broker.pendingCount()) await sleep(10);
    assert.equal(order.length, 6);
    assert.ok(order.indexOf('other') < order.indexOf('chunk4'), order.join(','));
    assert.equal(order.indexOf('other'), 1, 'runs right after the chunk that was running');
  });

  it('stops chaining when a chunk says it is done', async () => {
    let runs = 0;
    broker.submitChunks('fix-r-once', 'one chunk', async () => { runs++; return false; });
    while (broker.isBusy() || broker.pendingCount()) await sleep(10);
    assert.equal(runs, 1);
  });
});

describe('worker log forwarding', () => {
  it('a { type: "log" } message from a worker reaches winston', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-fix-r-log-'));
    const file = path.join(dir, 'worker.mjs');
    fs.writeFileSync(file, `import { parentPort } from 'node:worker_threads';
parentPort.postMessage({ type: 'log', message: '[bpm-octave] Halved 172.0 → 86.0 BPM' });
parentPort.postMessage({ type: 'stopped' });
`);
    const lines = [];
    const sink = new (class extends winston.Transport {
      log(info, cb) { lines.push(info.message); cb(); }
    })();
    winston.add(sink);
    const flag = { get: () => true, set: () => {} };
    const c = createWorkerController({ name: 'fix-r-log', path: file, autostartFlag: flag });
    try {
      assert.equal(await c.start(), 'started');
      for (let i = 0; i < 200 && c.running; i++) await sleep(10);
      assert.ok(lines.some(l => l.includes('[bpm-octave] Halved')), lines.join('\n'));
    } finally {
      winston.remove(sink);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
