// Shared worker plumbing (P040/P041/P042/P099), the radio redirect guard (P039)
// and the DB path of recordings / YouTube downloads (P022).
//
// Run with:
//   node --test test/fix-m-workers-controller.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import winston from 'winston';
import { createWorkerController } from '../src/util/worker-controller.js';
import { createRateLimiter, MB_INTERVAL_MS } from '../src/util/mb-client.mjs';
import { scanStarted, scanEnded, isScanRunning } from '../src/state/scan-lock.js';
import { startStreamRecording } from '../src/api/radio-recorder.js';
import { resolveStreamUrl } from '../src/util/ssrf-check.js';
import { dbFilepath } from '../src/util/db-filepath.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'fix-m-workers-fixture-worker.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
winston.add(new winston.transports.Console({ silent: true }));

async function waitFor(fn, ms = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await sleep(10);
  }
}

function memFlag(initial = true) {
  const f = { value: initial, get: () => f.value, set: v => { f.value = v; } };
  return f;
}

const controllers = [];
function make(opts) {
  const c = createWorkerController({ name: 'fixture', path: FIXTURE, autostartFlag: memFlag(), ...opts });
  controllers.push(c);
  return c;
}

after(() => {
  for (const c of controllers) if (c.running) c.stop();
  while (isScanRunning()) scanEnded();
});

describe('worker-controller', () => {
  it('start → running, stop → stopped message → not running, and remembers the stop', async () => {
    const flag = memFlag(false);
    const msgs = [];
    const c = make({ autostartFlag: flag, onMessage: m => msgs.push(m.type) });
    assert.equal(await c.start(), 'started');
    assert.equal(flag.value, true);
    assert.equal(c.running, true);
    assert.equal(await c.start(), 'already_running');
    await waitFor(() => msgs.includes('write'));
    assert.equal(c.stop(), 'stopping');
    assert.equal(c.stop(), 'already_stopping');
    await waitFor(() => !c.running);
    assert.ok(msgs.includes('stopped'));
    assert.equal(flag.value, false);
    assert.equal(c.stop(), 'not_running');
  });

  it('force-terminates a worker that ignores stop', async () => {
    const c = make({ workerData: () => ({ mode: 'hung' }), stopTimeoutMs: 200 });
    await c.start();
    assert.equal(c.stop(), 'stopping');
    await sleep(100);
    assert.equal(c.running, true);
    await waitFor(() => !c.running, 2000);
  });

  it('auto-start respects the queue cap and an admin stop (P099)', async () => {
    let n = 600;
    const flag = memFlag(true);
    const c = make({ queued: () => n, autostartFlag: flag });
    assert.equal(await c.autoStart(), false, 'above cap');
    assert.equal(c.running, false);
    assert.equal(await c.autoStart('Boot', { bypassCap: true }), true, 'cap bypass');
    c.stop();
    await waitFor(() => !c.running);
    n = 3;
    assert.equal(flag.value, false);
    assert.equal(await c.autoStart(), false, 'stopped by admin stays stopped');
    scanStarted();
    await sleep(20);
    scanEnded();
    await sleep(50);
    assert.equal(c.running, false);
    flag.value = true;
    n = 0;
    assert.equal(await c.autoStart(), false, 'nothing queued');
    n = 3;
    assert.equal(await c.autoStart(), true);
    c.stop();
    await waitFor(() => !c.running);
  });

  it('defers a start requested during a scan, and cancels it on stop', async () => {
    const c = make({});
    scanStarted();
    assert.equal(await c.start(), 'pending');
    assert.equal(c.pendingStart, true);
    assert.equal(c.stop(), 'pending_cancelled');
    assert.equal(await c.start(), 'pending');
    scanEnded();
    await waitFor(() => c.running);
    c.stop();
    await waitFor(() => !c.running);
  });

  it('pauses DB writes while a scan runs and resumes after (P041)', async () => {
    let last = 0;
    const c = make({ onMessage: m => { if (m.type === 'write') last = m.n; } });
    await c.start();
    await waitFor(() => last > 3);
    scanStarted();
    await sleep(100);
    const frozen = last;
    await sleep(200);
    assert.ok(last - frozen <= 1, `no writes while paused (${frozen} → ${last})`);
    scanEnded();
    await waitFor(() => last > frozen + 3);
    c.stop();
    await waitFor(() => !c.running);
  });
});

describe('MusicBrainz limiter (P042)', () => {
  it('spaces grants from many clients by at least the interval', async () => {
    const lim = createRateLimiter(40);
    const times = [];
    await Promise.all([0, 1, 2].map(async () => {
      for (let i = 0; i < 10; i++) times.push(await lim.acquire());
    }));
    times.sort((a, b) => a - b);
    assert.equal(times.length, 30);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 40, `gap ${i}: ${times[i] - times[i - 1]}`);
  });

  it('worker threads share one main-thread budget', { timeout: 20_000 }, async () => {
    const times = [];
    const onMessage = m => { if (m.type === 'granted') times.push(m.at); };
    const a = make({ workerData: () => ({ mode: 'mb', tokens: 2 }), onMessage });
    const b = make({ workerData: () => ({ mode: 'mb', tokens: 2 }), onMessage });
    await Promise.all([a.start(), b.start()]);
    await waitFor(() => times.length === 4, 15_000);
    times.sort((x, y) => x - y);
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i] - times[i - 1] >= MB_INTERVAL_MS - 50, `gap ${i}: ${times[i] - times[i - 1]}`);
    }
  });
});

describe('radio recorder stream URL guard (P039)', () => {
  it('resolves relative redirects against the current URL', () => {
    assert.equal(resolveStreamUrl('/stream', new URL('http://radio.example.com/live')).href, 'http://radio.example.com/stream');
  });

  it('rejects private redirect targets, IP literals included, other schemes and garbage', () => {
    for (const bad of ['http://127.0.0.1/', 'http://169.254.169.254/latest', 'http://[::1]:8000/', 'http://192.168.1.5/x', 'ftp://radio.example.com/', 'http://[bad']) {
      assert.throws(() => resolveStreamUrl(bad, new URL('http://radio.example.com/live')), undefined, bad);
    }
  });

  it('a redirect to a loopback IP literal rejects the start instead of crashing', async () => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/bad') { res.writeHead(302, { Location: 'http://[bad' }); return res.end(); }
      res.writeHead(302, { Location: 'http://127.0.0.1:9/next' });
      res.end();
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const opts = { username: 'u', vpath: 'Rec', recordDir: '/nonexistent' };
    try {
      await assert.rejects(startStreamRecording({ ...opts, url: `${base}/stream` }), /SSRF/);
      await assert.rejects(startStreamRecording({ ...opts, url: `${base}/bad` }), /Bad stream URL/);
    } finally {
      srv.close();
    }
  });
});

describe('DB filepath of recordings and downloads (P022)', () => {
  const folders = { Music: { root: '/m' }, Recordings: { root: '/m/Recordings' }, Deep: { root: '/m/Recordings/Deep/' }, Other: { root: '/o' } };
  it('maps a child vpath onto its root vpath', () => {
    assert.equal(dbFilepath('Recordings', 'x.opus', folders), 'Music/Recordings/x.opus');
    assert.equal(dbFilepath('Deep', 'x.opus', folders), 'Music/Recordings/Deep/x.opus');
  });
  it('keeps a root vpath as is', () => {
    assert.equal(dbFilepath('Other', 'x.opus', folders), 'Other/x.opus');
    assert.equal(dbFilepath('Music', 'a/x.opus', folders), 'Music/a/x.opus');
  });
});
