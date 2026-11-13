/**
 * Velvet Rooms: a Sonos follows a room (docs/API/rooms.md, Sonos followers) against a real Velvet instance, a
 * scripted Sendspin speaker and a fake Sonos on loopback (VELVET_TEST_SONOS, honoured only with NODE_ENV=test).
 * No real Sonos is ever contacted.
 *
 * Run with:
 *   node --test test/integration/sendspin-sonos-api.test.cjs
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FFMPEG = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(p => fs.existsSync(p)) ?? 'ffmpeg';
const UUID = 'RINCON_000E58AABBCC01400';

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

function fakeSonos() {
  const calls = [];
  const state = { uri: '', volume: 35, muted: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const action = /#(\w+)"/.exec(req.headers.soapaction || '')?.[1];
      const tag = t => new RegExp(`<${t}>([^<]*)</${t}>`).exec(body)?.[1];
      calls.push(action);
      let out = '';
      if (action === 'SetAVTransportURI') {
        state.uri = tag('CurrentURI');
        state.meta = tag('CurrentURIMetaData');
      }
      if (action === 'SetVolume') state.volume = Number(tag('DesiredVolume'));
      if (action === 'Stop') state.uri = '';
      if (action === 'GetVolume') out = `<CurrentVolume>${state.volume}</CurrentVolume>`;
      if (action === 'GetMute') out = `<CurrentMute>${state.muted ? 1 : 0}</CurrentMute>`;
      if (action === 'GetMediaInfo') out = `<CurrentURI>${state.uri}</CurrentURI>`;
      res.end(`<s:Envelope><s:Body><u:${action}Response>${out}</u:${action}Response></s:Body></s:Envelope>`);
    });
  });
  return { server, calls, state };
}

function get(url, ms) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let bytes = 0;
      res.on('data', c => { bytes += c.length; });
      const done = () => resolve({ status: res.statusCode, type: res.headers['content-type'], bytes });
      res.on('end', done);
      res.on('close', done);
      setTimeout(() => req.destroy(), ms);
    });
    req.on('error', () => resolve({ status: 0, bytes: 0 }));
  });
}

describe('Velvet Rooms REST: Sonos followers', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  const { RoomClient } = await import('../helpers/sendspin-room-client.mjs');
  let srv, lib, ssPort, speaker, roomId;
  const sonos = fakeSonos();
  const tokens = {};
  const PW = Object.fromEntries(['admin', 'plain', 'caster'].map(u => [u, crypto.randomBytes(9).toString('hex')]));

  const call = async (who, method, p, body) => {
    const headers = { 'x-access-token': tokens[who] };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(srv.baseUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const until = async (cond, ms = 5000) => {
    for (const t0 = Date.now(); !(await cond());) {
      if (Date.now() - t0 > ms) throw new Error('timed out');
      await new Promise(r => setTimeout(r, 50));
    }
  };

  before(async () => {
    await new Promise(r => sonos.server.listen(0, '127.0.0.1', r));
    process.env.VELVET_TEST_SONOS = JSON.stringify({
      port: sonos.server.address().port,
      devices: [{ uuid: UUID, name: 'Living Sonos', ip: '127.0.0.1', model: 'Era 100' }],
    });
    lib = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-sonos-lib-'));
    fs.mkdirSync(path.join(lib, 'Tones'));
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:r=44100:d=20', '-ac', '2',
      '-metadata', 'title=Tone A', path.join(lib, 'Tones/a.flac')]);
    ssPort = await freePort();
    srv = await startServer({
      extraFolders: { lib },
      extraConfig: { sendspin: { enabled: true, port: ssPort, bind: '127.0.0.1', discovery: false, name: 'Velvet Rooms Test' } },
      users: [
        { username: 'admin', password: PW.admin, vpaths: ['testlib', 'lib'] },
        { username: 'plain', password: PW.plain, vpaths: ['lib'] },
        { username: 'caster', password: PW.caster, vpaths: ['lib'] },
      ],
    });
    delete process.env.VELVET_TEST_SONOS;
    for (const [u, pw] of Object.entries(PW)) {
      const r = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }),
      });
      tokens[u] = (await r.json()).token;
    }
    assert.equal((await call('admin', 'POST', '/api/v1/admin/users/allow-mpv-cast', { username: 'caster', allow: true })).status, 200);
    await until(async () => {
      const s = (await call('admin', 'GET', '/api/v1/db/status')).body;
      return s && !s.locked && s.totalFileCount >= 1;
    }, 60000);
    await until(async () => (await call('admin', 'GET', '/api/v1/admin/sendspin/status')).body?.running === true, 15000);
    speaker = new RoomClient({ name: 'Kitchen' });
    await speaker.dial(`ws://127.0.0.1:${ssPort}/sendspin`);
    await speaker.connect();
    await until(async () => (await call('admin', 'GET', '/api/v1/admin/sendspin/status')).body.devices.some(d => d.clientId === speaker.clientId));
    const ap = await call('admin', 'POST', '/api/v1/admin/sendspin/devices/approve', { clientId: speaker.clientId });
    roomId = ap.body.device.roomId;
  });

  after(async () => {
    speaker?.close();
    await srv?.stop();
    sonos.server.close();
    fs.rmSync(lib, { recursive: true, force: true });
  });

  it('lists the Sonos speakers for rooms users only', async () => {
    assert.equal((await call('plain', 'GET', '/api/v1/rooms/sonos')).status, 403);
    const r = await call('caster', 'GET', '/api/v1/rooms/sonos');
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    assert.equal(r.body.maxTrimMs, 1000);
    assert.deepEqual(r.body.devices, [{ uuid: UUID, name: 'Living Sonos', model: 'Era 100', roomId: null }]);
  });

  it('validates add, fine-tune and remove', async () => {
    assert.equal((await call('plain', 'POST', `/api/v1/rooms/${roomId}/sonos`, { uuid: UUID })).status, 403);
    assert.equal((await call('caster', 'POST', `/api/v1/rooms/${roomId}/sonos`, {})).status, 400);
    assert.equal((await call('caster', 'POST', `/api/v1/rooms/${roomId}/sonos`, { uuid: UUID, trimMs: 1001 })).status, 400);
    assert.equal((await call('caster', 'POST', `/api/v1/rooms/${roomId}/sonos`, { uuid: 'RINCON_FFFFFFFFFFFF01400' })).status, 404);
    assert.equal((await call('caster', 'POST', '/api/v1/rooms/nope/sonos', { uuid: UUID })).status, 404);
    assert.equal((await call('caster', 'PATCH', `/api/v1/rooms/${roomId}/sonos/${UUID}`, { trimMs: 100 })).status, 404);
    assert.equal((await call('caster', 'DELETE', `/api/v1/rooms/${roomId}/sonos/${UUID}`)).status, 404);
  });

  it('a Sonos follows the room: stream with token only, fine-tune, volume, removal stops it', async () => {
    const add = await call('caster', 'POST', `/api/v1/rooms/${roomId}/sonos`, { uuid: UUID, trimMs: -300 });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    assert.equal(add.body.sonos.length, 1);
    assert.equal(add.body.sonos[0].id, `sonos:${UUID}`);
    assert.equal(add.body.sonos[0].trimMs, -300);
    assert.equal(add.body.sonos[0].leadMs, null, 'not measured before it plays');
    assert.ok(!sonos.calls.includes('SetAVTransportURI'), 'nothing plays while the room is idle');
    assert.equal((await call('caster', 'GET', '/api/v1/rooms/sonos')).body.devices[0].roomId, roomId);

    const play = await call('caster', 'POST', `/api/v1/rooms/${roomId}/play`, { songs: ['lib/Tones/a.flac'] });
    assert.equal(play.status, 200, JSON.stringify(play.body));
    await until(() => sonos.calls.includes('Play'));
    const uri = sonos.state.uri.replaceAll('&amp;', '&');
    assert.match(uri, /^x-rincon-mp3radio:\/\/127\.0\.0\.1:\d+\/api\/v1\/rooms\/sonos-stream\/[A-Za-z0-9_-]{32}\.mp3$/);
    assert.ok(!uri.includes(tokens.caster), 'no user token in the stream URL');
    const url = uri.replace('x-rincon-mp3radio://', 'http://');
    const ok = await get(url, 1200);
    assert.equal(ok.status, 200);
    assert.equal(ok.type, 'audio/mpeg');
    assert.ok(ok.bytes > 10_000, `mp3 bytes flowed (${ok.bytes})`);
    assert.equal((await get(url.replace(/[A-Za-z0-9_-]{32}\.mp3$/, `${'x'.repeat(32)}.mp3`), 300)).status, 404);
    const meta = sonos.state.meta.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    const art = url.replace(/\.mp3$/, '.jpg');
    assert.ok(meta.includes(`<upnp:albumArtURI>${art}</upnp:albumArtURI>`), 'the cover follows the session, not one song');
    assert.equal((await get(art, 300)).status, 404, 'no cover for the test tones: nothing rather than a wrong one');
    assert.equal((await get(art.replace(/[A-Za-z0-9_-]{32}\.jpg$/, `${'x'.repeat(32)}.jpg`), 300)).status, 404);
    assert.equal((await get(url.replace(/\.mp3$/, ''), 300)).status, 404);

    const patch = await call('caster', 'PATCH', `/api/v1/rooms/${roomId}/sonos/${UUID}`, { trimMs: 150 });
    assert.equal(patch.body.sonos[0].trimMs, 150);
    assert.equal((await call('caster', 'PATCH', `/api/v1/rooms/${roomId}/sonos/${UUID}`, { trimMs: -1001 })).status, 400);

    await until(async () => (await call('caster', 'GET', `/api/v1/rooms/${roomId}/state`)).body.sonos[0].volume === 35);
    const vol = await call('caster', 'POST', `/api/v1/rooms/${roomId}/volume`, { volume: 40, clientId: `sonos:${UUID}` });
    assert.equal(vol.status, 200);
    await until(() => sonos.state.volume === 40);

    const del = await call('caster', 'DELETE', `/api/v1/rooms/${roomId}/sonos/${UUID}`);
    assert.equal(del.status, 200);
    assert.deepEqual(del.body.sonos, []);
    await until(() => sonos.calls.includes('Stop'));
    assert.equal((await get(url, 300)).status, 404, 'the token died with the membership');
    await call('caster', 'POST', `/api/v1/rooms/${roomId}/stop`);
  });
});
