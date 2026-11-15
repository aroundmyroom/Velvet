/**
 * Rooms, Sonos, Server Audio and transcode fixes (P117, P121, P130, P145):
 * a rejected room command keeps the room's listener, Sonos test-play is admin only,
 * /server-remote explains a disabled Server Audio, and /transcode serves the codec the phone app asks for.
 *
 * Run with:
 *   node --test test/integration/fix-r-rooms-api.test.cjs
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
const BUNDLED_FFMPEG = fs.existsSync(path.join(__dirname, '../../bin/ffmpeg/ffmpeg'));

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

const sleep = ms => new Promise(res => setTimeout(res, ms));

describe('rooms / sonos / server-remote / transcode fixes', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  const { RoomClient } = await import('../helpers/sendspin-room-client.mjs');
  let srv, lib, ssPort, speaker, roomId;
  const tokens = {};
  const PW = Object.fromEntries(['admin', 'caster'].map(u => [u, crypto.randomBytes(9).toString('hex')]));

  const call = async (who, method, p, body) => {
    const headers = { 'x-access-token': tokens[who] };
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
      await sleep(100);
    }
  };
  const listener = () => {
    try {
      const f = JSON.parse(fs.readFileSync(path.join(srv.tmpDir, 'sendspin', 'rooms.json'), 'utf8'));
      return f.rooms.find(r => r.id === roomId)?.listener ?? null;
    } catch {
      return null;
    }
  };

  before(async () => {
    lib = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-fix-r-rooms-'));
    makeTone(lib, 'Tones/a.flac', 440, 12, 'Tone A');
    makeTone(lib, 'Tones/b.mp3', 660, 3, 'Tone B');
    ssPort = await freePort();
    srv = await startServer({
      extraFolders: { lib },
      extraConfig: {
        sendspin: { enabled: true, port: ssPort, bind: '127.0.0.1', discovery: false, name: 'Velvet Fix Rooms' },
        serverAudio: { enabled: false },
        ...(BUNDLED_FFMPEG ? { transcode: { enabled: true } } : {}),
      },
      users: [
        { username: 'admin', password: PW.admin, vpaths: ['lib'] },
        { username: 'caster', password: PW.caster, vpaths: ['lib'] },
      ],
    });
    for (const [u, pw] of Object.entries(PW)) {
      const r = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }),
      });
      tokens[u] = (await r.json()).token;
    }
    assert.equal((await call('admin', 'POST', '/api/v1/admin/users/allow-mpv-cast', { username: 'caster', allow: true })).status, 200);
    await poll(() => call('admin', 'GET', '/api/v1/db/status'), s => s.body && !s.body.locked && s.body.totalFileCount >= 2, 'the scan', 60000);
    const settings = await call('admin', 'POST', '/api/v1/admin/sendspin/settings', { enabled: true });
    assert.equal(settings.body.running, true, settings.body.error);
    speaker = new RoomClient({ name: 'Den' });
    await speaker.dial(`ws://127.0.0.1:${ssPort}/sendspin`);
    await speaker.connect();
    await poll(() => call('admin', 'GET', '/api/v1/admin/sendspin/status'), s => s.body.devices.some(d => d.clientId === speaker.clientId), 'the speaker');
    const ap = await call('admin', 'POST', '/api/v1/admin/sendspin/devices/approve', { clientId: speaker.clientId });
    assert.equal(ap.status, 200);
    roomId = ap.body.device.roomId;
  });

  after(async () => {
    speaker?.close();
    await srv?.stop();
    fs.rmSync(lib, { recursive: true, force: true });
  });

  it('a rejected room command does not take the room\'s listener; an accepted one does', async () => {
    assert.equal((await call('admin', 'POST', `/api/v1/rooms/${roomId}/play`, { songs: ['lib/Tones/a.flac'] })).status, 200);
    await poll(listener, l => l === 'admin', 'the listener');
    assert.equal((await call('caster', 'POST', `/api/v1/rooms/${roomId}/seek`, { positionMs: -5 })).status, 400);
    const lineIn = await call('caster', 'POST', `/api/v1/rooms/${roomId}/line-in`, { clientId: speaker.clientId });
    assert.ok(lineIn.status >= 400, `line-in from a non-source: ${lineIn.status}`);
    await sleep(600);
    assert.equal(listener(), 'admin', 'the rejected requests left the listener alone');
    assert.equal((await call('caster', 'POST', `/api/v1/rooms/${roomId}/repeat`, { repeat: 'bogus' })).status, 400);
    assert.equal((await call('caster', 'POST', `/api/v1/rooms/${roomId}/repeat`, { repeat: 'off' })).status, 200);
    await poll(listener, l => l === 'caster', 'the new listener');
    await call('caster', 'POST', `/api/v1/rooms/${roomId}/stop`);
  });

  it('Sonos test-play is admin only', async () => {
    const r = await call('caster', 'POST', '/api/v1/sonos/test-play', { ip: '127.0.0.1' });
    assert.equal(r.status, 403);
    assert.equal((await call('admin', 'POST', '/api/v1/sonos/test-play', {})).status, 400, 'admins pass the check');
  });

  it('/server-remote explains that Server Audio is off', async () => {
    for (const p of ['/server-remote', '/server-remote/', '/server-remote/index.html']) {
      const r = await fetch(srv.baseUrl + p);
      assert.equal(r.status, 200, p);
      assert.match(await r.text(), /not enabled/, p);
    }
  });

  it('/transcode serves the codec and bitrate the phone app asks for', { skip: !BUNDLED_FFMPEG && 'no bundled ffmpeg' }, async () => {
    const url = `/transcode/lib/Tones/a.flac?codec=mp3&bitrate=128k&token=${tokens.caster}`;
    const r = await poll(() => fetch(srv.baseUrl + url), x => x.status === 200, 'the transcoder', 30000);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.length > 1000, `${buf.length} bytes`);
    const mp3 = buf.subarray(0, 3).toString('latin1') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
    assert.ok(mp3, `an MP3 stream, starts with ${buf.subarray(0, 4).toString('hex')}`);
  });
});
