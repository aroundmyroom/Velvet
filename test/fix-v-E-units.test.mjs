// Round 5, group E: worker restarts (N037/N114), safeFetch body budget (N039),
// Duplicate Workshop off the request thread (N040), Camelot in the ML vectors
// (N111), podcast durations (N112) and the genre enricher's Discogs switch (N126).
//
// Run with:
//   node --test test/fix-v-E-units.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import winston from 'winston';
import { createWorkerController } from '../src/util/worker-controller.js';
import { scanStarted, scanEnded, isScanRunning } from '../src/state/scan-lock.js';
import { safeFetch } from '../src/util/ssrf-check.js';
import * as broker from '../src/state/bg-task-broker.js';
import * as backend from '../src/db/sqlite-backend.js';
import * as db from '../src/db/manager.js';
import { setup as setupDupWorkshop } from '../src/api/duplicate-workshop.js';
import { setup as setupPodcasts } from '../src/api/podcasts.js';
import { discogsCredentials } from '../src/api/discogs.js';
import { extractVector } from '../src/smartplaylist/feature-extractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'fix-v-E-worker.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
winston.add(new winston.transports.Console({ silent: true }));

async function waitFor(fn, ms = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await sleep(10);
  }
}

function memFlag(initial) {
  const f = { value: initial, get: () => f.value, set: v => { f.value = v; } };
  return f;
}

function fakeApp() {
  const routes = {};
  const reg = method => (p, h) => { routes[`${method} ${p}`] = h; };
  const app = { routes };
  for (const m of ['all', 'get', 'post', 'put', 'patch', 'delete']) app[m] = reg(m.toUpperCase());
  app.call = async (key, { body = {}, query = {}, user = { admin: true, username: 'tester' } } = {}) => {
    let status = 200;
    let json;
    const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; } };
    await routes[key]({ user, body, query, params: {} }, res);
    return { status, json };
  };
  return app;
}

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Durations</title>
${['1:02:03', '45:30', '3600', '12.7', ' 05:07 ', 'abc', ''].map((d, i) => `<item><title>E${i}</title><guid>g${i}</guid>
<enclosure url="https://cdn.example/${i}.mp3" type="audio/mpeg"/><itunes:duration>${d}</itunes:duration></item>`).join('\n')}
</channel></rss>`;

// The SSRF guard refuses loopback, so a public-looking name is sent to this local server
let srv;
let realRequest;
let dbDir;
before(async () => {
  srv = http.createServer((req, res) => {
    if (req.url === '/small') return res.end('hello');
    if (req.url === '/feed.xml') return res.end(RSS);
    if (req.url === '/declared') {
      res.writeHead(200, { 'Content-Length': 1_000_000 });
      return res.write(Buffer.alloc(1000));
    }
    if (req.url === '/forever') {
      res.writeHead(200);
      const t = setInterval(() => res.write(Buffer.alloc(64 * 1024)), 2);
      return res.on('close', () => clearInterval(t));
    }
    res.writeHead(200);
    const t = setInterval(() => res.write('x'), 100);
    res.on('close', () => clearInterval(t));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  realRequest = http.request;
  const { port } = srv.address();
  http.request = (url, opts, cb) => realRequest(`http://127.0.0.1:${port}${url.pathname}`, { ...opts, lookup: undefined }, cb);
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-fix-v-E-'));
  backend.init(dbDir);
});

after(() => {
  while (isScanRunning()) scanEnded();
  http.request = realRequest;
  srv.closeAllConnections();
  srv.close();
  backend.close();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe('worker-controller restarts', () => {
  it('a fatal message stops the worker for good and clears auto-start (N037)', async () => {
    const flag = memFlag(true);
    let spawns = 0;
    const c = createWorkerController({
      name: 'fix-v-E-fatal', path: FIXTURE, autostartFlag: flag,
      workerData: () => ({ mode: 'fatal' }),
      onSpawn: () => { spawns++; },
      restartAfterCrash: () => flag.get(),
      crashRestartMs: 50,
    });
    assert.equal(await c.start(), 'started');
    await waitFor(() => !c.running);
    await sleep(300);
    assert.equal(spawns, 1, 'not restarted');
    assert.equal(flag.value, false);
    assert.equal(await c.autoStart('Boot', { bypassCap: true }), false);
  });

  it('a worker restarted after a crash during a scan starts paused (N114)', async () => {
    let spawns = 0;
    let writes = 0;
    const c = createWorkerController({
      name: 'fix-v-E-crash', path: FIXTURE, autostartFlag: memFlag(true),
      workerData: () => ({ mode: spawns === 0 ? 'error' : 'normal' }),
      onSpawn: () => { spawns++; },
      onMessage: m => { if (m.type === 'write') writes++; },
      restartAfterCrash: () => true,
      crashRestartMs: 50,
    });
    try {
      assert.equal(await c.start({ remember: false }), 'started');
      scanStarted();
      await waitFor(() => spawns === 2 && c.running);
      await sleep(300);
      assert.equal(writes, 0, 'no writes while the scan runs');
      scanEnded();
      await waitFor(() => writes > 2);
    } finally {
      while (isScanRunning()) scanEnded();
      c.stop();
      await waitFor(() => !c.running);
    }
  });
});

describe('safeFetch body budget (N039)', () => {
  it('reads a small body', async () => {
    const r = await safeFetch('http://budget.example/small');
    assert.equal(await r.text(), 'hello');
  });

  it('refuses a declared length above maxBytes', async () => {
    await assert.rejects(safeFetch('http://budget.example/declared', { maxBytes: 1000 }), /larger than 1000 bytes/);
  });

  it('stops an endless body at maxBytes', async () => {
    const r = await safeFetch('http://budget.example/forever', { maxBytes: 200_000 });
    await assert.rejects(r.arrayBuffer(), /larger than 200000 bytes/);
  });

  it('the timeout also covers the body', async () => {
    const t0 = Date.now();
    const r = await safeFetch('http://budget.example/slow', { timeoutMs: 300 });
    await assert.rejects(r.text());
    assert.ok(Date.now() - t0 < 2000);
  });
});

describe('Duplicate Workshop scan (N040)', () => {
  const app = fakeApp();
  setupDupWorkshop(app);
  const call = (key, body) => app.call(key, { body });

  it('answers 202 at once, runs on the broker and can be cancelled before it ends', async () => {
    let release;
    broker.submit('fix-v-E-blocker', 'blocker', () => new Promise(r => { release = r; }));
    assert.equal(broker.isBusy(), true);
    assert.equal((await call('POST /api/v1/admin/dup-workshop/scan', { threshold: 80 })).status, 202);
    assert.equal((await call('GET /api/v1/admin/dup-workshop/status')).json.state, 'scanning');
    assert.equal((await call('GET /api/v1/admin/dup-workshop/status')).json.threshold, 80);
    assert.equal((await call('POST /api/v1/admin/dup-workshop/scan')).status, 409);
    const cancel = await call('POST /api/v1/admin/dup-workshop/cancel');
    assert.equal(cancel.status, 200);
    assert.equal((await call('GET /api/v1/admin/dup-workshop/status')).json.state, 'idle');
    assert.equal((await call('POST /api/v1/admin/dup-workshop/cancel')).status, 400);
    release();
    await waitFor(() => !broker.isBusy() && broker.pendingCount() === 0);
    assert.equal((await call('GET /api/v1/admin/dup-workshop/status')).json.state, 'idle');
  });
});

describe('Smart Playlist ML', () => {
  it('places every enharmonic key spelling on the Camelot wheel (N111)', () => {
    const pos = key => extractVector({ musical_key: key })[3] * 12;
    assert.equal(pos('Bb minor'), 3);
    assert.equal(pos('A# minor'), 3);
    assert.equal(pos('A# major'), 6);
    assert.equal(pos('Ab minor'), 1);
    assert.equal(pos('Eb minor'), 2);
    assert.equal(pos('G# major'), 4);
    assert.equal(pos('D# major'), 5);
    assert.equal(pos('C major'), 8);
    assert.equal(pos('not a key'), 6);
    assert.equal(extractVector({})[3], 0.5);
  });

});

describe('podcast durations (N112)', () => {
  it('a subscribed feed stores seconds, MM:SS and HH:MM:SS durations', async () => {
    const app = fakeApp();
    setupPodcasts(app);
    const r = await app.call('POST /api/v1/podcast/feeds', { body: { url: 'http://feeds.example/feed.xml' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const byTitle = Object.fromEntries(db.getPodcastEpisodes(r.json.id).map(e => [e.title, e.duration_secs]));
    assert.deepEqual(byTitle, { E0: 3723, E1: 2730, E2: 3600, E3: 12, E4: 307, E5: 0, E6: 0 });
  });
});

describe('genre enricher Discogs switch (N126)', () => {
  it('passes no Discogs credentials when Discogs is switched off or has no key', () => {
    assert.equal(discogsCredentials({ apiKey: 'k', enabled: false }), null);
    assert.equal(discogsCredentials({ enabled: true }), null);
    assert.equal(discogsCredentials(undefined), null);
    assert.deepEqual(discogsCredentials({ apiKey: 'k', apiSecret: 's' }), { apiKey: 'k', apiSecret: 's', userAgentTag: '' });
  });
});
