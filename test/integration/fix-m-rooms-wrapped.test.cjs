/**
 * Rooms and Wrapped (P044 / P127): a song a room plays twice in a row is two plays, and a song the web player
 * already started, handed to a room at 0:00, stays one play.
 *
 * Run with:
 *   node --test test/integration/fix-m-rooms-wrapped.test.cjs
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FFMPEG = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(p => fs.existsSync(p)) ?? 'ffmpeg';

function makeTone(root, rel, freq, seconds, title) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=f=${freq}:r=44100:d=${seconds}`, '-ac', '2',
    '-metadata', `title=${title}`, '-metadata', 'artist=Velvet Tones', '-metadata', 'album=Rooms', p]);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

describe('rooms: Wrapped plays and play counts', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  const { RoomClient } = await import('../helpers/sendspin-room-client.mjs');
  let srv, lib, ssPort, speaker, roomId;
  let token;
  const PW = crypto.randomBytes(9).toString('hex');

  const call = async (method, p, body) => {
    const headers = { 'x-access-token': token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(srv.baseUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const poll = async (get, ok, what, ms = 15000) => {
    for (const t0 = Date.now(); ;) {
      const v = await get();
      if (ok(v)) return v;
      if (Date.now() - t0 > ms) throw new Error(`${what} did not show up: ${JSON.stringify(v)}`);
      await new Promise(res => setTimeout(res, 100));
    }
  };
  const events = fp => call('GET', '/api/v1/history').then(h => h.body.events.filter(e => e.filepath === fp));
  const playCount = fp => call('POST', '/api/v1/db/stats/most-played', { limit: 50 })
    .then(m => m.body.find(x => x.filepath === fp)?.metadata['play-count'] ?? 0);

  before(async () => {
    lib = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-rooms-wrapped-'));
    makeTone(lib, 'Tones/short.flac', 440, 2, 'Short Tone');
    makeTone(lib, 'Tones/long.flac', 660, 12, 'Long Tone');
    ssPort = await freePort();
    srv = await startServer({
      extraFolders: { lib },
      extraConfig: { sendspin: { enabled: true, port: ssPort, bind: '127.0.0.1', discovery: false, name: 'Velvet Rooms Wrapped' } },
      users: [{ username: 'caster', password: PW, vpaths: ['lib'], admin: true }],
    });
    const r = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'caster', password: PW }),
    });
    token = (await r.json()).token;
    await poll(() => call('GET', '/api/v1/db/status'), s => s.body && !s.body.locked && s.body.totalFileCount >= 2, 'the scan', 60000);
    const settings = await call('POST', '/api/v1/admin/sendspin/settings', { enabled: true });
    assert.equal(settings.body.running, true, settings.body.error);
    speaker = new RoomClient({ name: 'Den' });
    await speaker.dial(`ws://127.0.0.1:${ssPort}/sendspin`);
    await speaker.connect();
    await poll(() => call('GET', '/api/v1/admin/sendspin/status'), s => s.body.devices.some(d => d.clientId === speaker.clientId), 'the speaker');
    const ap = await call('POST', '/api/v1/admin/sendspin/devices/approve', { clientId: speaker.clientId });
    assert.equal(ap.status, 200);
    roomId = ap.body.device.roomId;
  });

  after(async () => {
    speaker?.close();
    await srv?.stop();
    fs.rmSync(lib, { recursive: true, force: true });
  });

  it('repeat-one: the same song played twice is two Wrapped plays and two play counts', async () => {
    const FP = 'lib/Tones/short.flac';
    assert.equal((await call('POST', `/api/v1/rooms/${roomId}/repeat`, { repeat: 'one' })).status, 200);
    assert.equal((await call('POST', `/api/v1/rooms/${roomId}/play`, { songs: [FP] })).status, 200);
    const evs = await poll(() => events(FP), e => e.length >= 2 && e.some(x => x.completed), 'two plays', 20000);
    assert.equal(new Set(evs.map(e => e.id)).size, evs.length);
    assert.equal(evs.find(e => e.id === Math.min(...evs.map(x => x.id))).completed, true, 'the first play ended played to the end');
    await call('POST', `/api/v1/rooms/${roomId}/stop`);
    await call('POST', `/api/v1/rooms/${roomId}/repeat`, { repeat: 'off' });
    const n = (await events(FP)).length;
    assert.equal(await poll(() => playCount(FP), c => c >= n, 'the play count'), n, 'play count matches the Wrapped plays');
  });

  it('a song the web player started, handed to a room at 0:00, stays one play', async () => {
    const FP = 'lib/Tones/long.flac';
    const start = await call('POST', '/api/v1/wrapped/play-start', { filePath: FP, sessionId: 'browser-handoff', source: 'manual' });
    assert.equal(start.body.ok, true);
    assert.equal((await call('POST', '/api/v1/db/stats/log-play', { filePath: FP })).body.ok, true);
    assert.equal(await playCount(FP), 1);
    assert.equal((await call('POST', `/api/v1/rooms/${roomId}/play`, { songs: [FP], positionMs: 0 })).status, 200);
    await poll(() => call('GET', `/api/v1/rooms/${roomId}/state`), s => s.body.positionMs > 300, 'playback');
    await call('POST', `/api/v1/rooms/${roomId}/stop`);
    const evs = await poll(() => events(FP), e => e[0]?.played_ms > 0, 'the stopped play');
    assert.deepEqual(evs.map(e => e.id), [start.body.eventId], 'the room resumed the web player\'s play');
    assert.equal(await playCount(FP), 1, 'counted once, by the web player');
  });
});
