/**
 * Flow the queue (POST /api/v1/queue/flow): the listener's own songs back in
 * an order where each flows into the next — a permutation of the input
 * indices, the playing song pinned, unresolvable paths kept at the end.
 *
 * Run with:
 *   node --test test/integration/queue-flow.test.cjs
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FFMPEG = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(p => fs.existsSync(p)) ?? 'ffmpeg';

function makeTrack(root, rel, tags) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', '0.3'];
  for (const [k, v] of Object.entries(tags)) args.push('-metadata', `${k}=${v}`);
  args.push('-c:a', 'libmp3lame', '-b:a', '32k', p);
  execFileSync(FFMPEG, args);
}

describe('flow the queue', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  let srv, root;
  const post = (p, body) => fetch(srv.baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-flow-'));
    for (let i = 1; i <= 8; i++) makeTrack(root, `Mix/${i} Song.mp3`, { artist: `Act ${i % 4}`, title: `Song ${i}`, genre: 'house' });
    srv = await startServer({ extraFolders: { lib: root }, waitForScan: true });
  });
  after(async () => {
    await srv.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('answers a permutation of the input indices, the first song pinned, unknown paths at the end', async () => {
    const songs = [1, 2, 3, 4, 5, 6].map(i => `lib/Mix/${i} Song.mp3`);
    songs.splice(2, 0, 'lib/Mix/Nope.mp3');
    songs.push('lib/Mix/3 Song.mp3');
    const r = await post('/api/v1/queue/flow', { songs });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.order.length, songs.length);
    assert.deepEqual([...out.order].sort((a, b) => a - b), songs.map((_, i) => i), 'every index once, duplicates included');
    assert.equal(out.order[0], 0, 'the playing song stays first');
    assert.deepEqual(out.unplaced, [2]);
    assert.equal(out.order.at(-1), 2, 'the unknown path comes last');
    assert.equal(out.stats.picked, songs.length - 1);
    for (let i = 1; i < out.order.length - 1; i++) {
      const a = songs[out.order[i]], b = songs[out.order[i + 1]];
      if (b === 'lib/Mix/Nope.mp3') continue;
      assert.notEqual(a.match(/(\d) Song/)[1] % 4, b.match(/(\d) Song/)[1] % 4, `no artist back to back: ${a} → ${b}`);
    }

    const free = await (await post('/api/v1/queue/flow', { songs: songs.slice(0, 2).concat(songs.slice(3)), pinFirst: false })).json();
    assert.equal(free.order.length, songs.length - 1);
    assert.deepEqual(free.unplaced, []);

    assert.equal((await post('/api/v1/queue/flow', { songs: ['lib/Mix/1 Song.mp3'] })).status, 400, 'two songs at least');
    assert.equal((await post('/api/v1/queue/flow', { songs, energy: 'explode' })).status, 400);
  });
});
