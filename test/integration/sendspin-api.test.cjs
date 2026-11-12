/**
 * Velvet Rooms REST (docs/API/rooms.md) against a real Velvet instance and a
 * scripted Sendspin speaker: availability, permissions, settings, approval,
 * queue resolution (incl. traversal / foreign vpaths) and transport controls.
 *
 * Run with:
 *   node --test test/integration/sendspin-api.test.cjs
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

describe('Velvet Rooms REST', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  const { RoomClient } = await import('../helpers/sendspin-room-client.mjs');
  let srv, lib, secret, ssPort, speaker;
  const tokens = {};
  const PW = Object.fromEntries(['admin', 'plain', 'caster'].map(u => [u, crypto.randomBytes(9).toString('hex')]));

  const roomsFile = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(srv.tmpDir, 'sendspin', 'rooms.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  const waitFile = async (pred, ms = 5000) => {
    const t0 = Date.now();
    for (;;) {
      const f = roomsFile();
      if (f && pred(f)) return f;
      if (Date.now() - t0 > ms) throw new Error('rooms.json did not reach the expected state');
      await new Promise(r => setTimeout(r, 50));
    }
  };
  const inboxCount = (type, pred = () => true) => speaker.inbox.filter(m => m.type === type && pred(m.payload)).length;

  const call = async (who, method, p, body) => {
    const headers = { 'x-access-token': tokens[who] };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(srv.baseUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };

  before(async () => {
    lib = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-rooms-lib-'));
    secret = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-rooms-secret-'));
    makeTone(lib, 'Tones/a.flac', 440, 12, 'Tone A');
    makeTone(lib, 'Tones/b.flac', 660, 12, 'Tone B');
    makeTone(lib, 'Tones/c.flac', 770, 12, 'Tone C');
    makeTone(secret, 'Hidden/x.flac', 550, 2, 'Hidden');
    ssPort = await freePort();
    srv = await startServer({
      extraFolders: { lib, secret },
      extraConfig: { sendspin: { enabled: false, port: ssPort, bind: '127.0.0.1', discovery: false, name: 'Velvet Rooms Test' } },
      users: [
        { username: 'admin', password: PW.admin, vpaths: ['testlib', 'lib', 'secret'] },
        { username: 'plain', password: PW.plain, vpaths: ['lib'] },
        { username: 'caster', password: PW.caster, vpaths: ['lib'] },
      ],
    });
    for (const [u, pw] of Object.entries(PW)) {
      const r = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: pw }),
      });
      tokens[u] = (await r.json()).token;
    }
    const r = await call('admin', 'POST', '/api/v1/admin/users/allow-mpv-cast', { username: 'caster', allow: true });
    assert.equal(r.status, 200);
    for (let i = 0; i < 100; i++) {
      const s = await call('admin', 'GET', '/api/v1/db/status');
      if (s.body && !s.body.locked && s.body.totalFileCount >= 8) break;
      await new Promise(res => setTimeout(res, 200));
    }
  });

  after(async () => {
    speaker?.close();
    await srv?.stop();
    fs.rmSync(lib, { recursive: true, force: true });
    fs.rmSync(secret, { recursive: true, force: true });
  });

  it('is hidden while disabled', async () => {
    const r = await call('caster', 'GET', '/api/v1/rooms');
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'rooms_disabled');
    const st = await call('admin', 'GET', '/api/v1/admin/sendspin/status');
    assert.equal(st.status, 200);
    assert.equal(st.body.enabled, false);
    assert.equal(st.body.running, false);
    assert.deepEqual(st.body.devices, []);
    assert.equal((await call('caster', 'GET', '/api/v1/admin/sendspin/status')).status, 403);
  });

  it('starts the listener from the settings endpoint', async () => {
    assert.equal((await call('admin', 'POST', '/api/v1/admin/sendspin/settings', { name: 'bad\u0001name' })).status, 400);
    assert.equal((await call('admin', 'POST', '/api/v1/admin/sendspin/settings', { port: 80 })).body.code, 'invalid_body');
    const r = await call('admin', 'POST', '/api/v1/admin/sendspin/settings', { enabled: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    assert.equal(r.body.running, true, r.body.error);
    assert.equal(r.body.port, ssPort);
    assert.equal(r.body.name, 'Velvet Rooms Test');
    assert.match(r.body.serverId, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(r.body.serverIdShort, r.body.serverId.slice(0, 8));
    assert.equal(r.body.error, null);
  });

  it('checks the player permission', async () => {
    const plain = await call('plain', 'GET', '/api/v1/rooms');
    assert.equal(plain.status, 403);
    assert.equal(plain.body.code, 'forbidden');
    const caster = await call('caster', 'GET', '/api/v1/rooms');
    assert.equal(caster.status, 200);
    assert.deepEqual(caster.body, { enabled: true, rooms: [] });
  });

  it('lists a connecting speaker, approves it and shows its solo room', async () => {
    speaker = new RoomClient({ name: 'Kitchen' });
    await speaker.dial(`ws://127.0.0.1:${ssPort}/sendspin`);
    await speaker.connect();
    let dev;
    for (let i = 0; i < 50 && !dev; i++) {
      dev = (await call('admin', 'GET', '/api/v1/admin/sendspin/status')).body.devices.find(d => d.clientId === speaker.clientId);
      if (!dev) await new Promise(res => setTimeout(res, 100));
    }
    assert.ok(dev, 'device listed');
    assert.equal(dev.trust, 'unknown');
    assert.equal(dev.connection, 'online');
    assert.equal(dev.unpairedAccess, true);
    assert.equal(dev.name, 'Kitchen');
    assert.equal(dev.url, undefined);

    assert.equal((await call('admin', 'POST', '/api/v1/admin/sendspin/devices/approve', { clientId: 'nope' })).status, 404);
    const ap = await call('admin', 'POST', '/api/v1/admin/sendspin/devices/approve', { clientId: speaker.clientId });
    assert.equal(ap.status, 200);
    assert.equal(ap.body.ok, true);
    assert.equal(ap.body.device.trust, 'approved');
    assert.ok(ap.body.device.roomId);

    const rooms = (await call('caster', 'GET', '/api/v1/rooms')).body.rooms;
    assert.equal(rooms.length, 1);
    assert.equal(rooms[0].name, 'Kitchen');
    assert.equal(rooms[0].id, ap.body.device.roomId);
    assert.equal(rooms[0].state, 'idle');
    assert.equal(rooms[0].index, -1);
    assert.equal(rooms[0].members[0].clientId, speaker.clientId);
  });

  it('refuses traversal, foreign vpaths and bad bodies', async () => {
    const id = (await call('caster', 'GET', '/api/v1/rooms')).body.rooms[0].id;
    const bad = ['lib/../secret/Hidden/x.flac', 'secret/Hidden/x.flac', 'lib/Tones/../../etc/passwd', '/lib/Tones/a.flac', 'lib/Tones/missing.flac', 'nope/x.flac'];
    const r = await call('caster', 'POST', `/api/v1/rooms/${id}/play`, { songs: bad });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'invalid_body');
    assert.equal(r.body.skipped, bad.length);
    assert.equal((await call('caster', 'POST', `/api/v1/rooms/${id}/play`, { songs: [42] })).status, 400);
    assert.equal((await call('caster', 'POST', `/api/v1/rooms/${id}/play`, { songs: [] })).status, 400);
    assert.equal((await call('caster', 'POST', `/api/v1/rooms/${id}/volume`, { volume: 101 })).status, 400);
    assert.equal((await call('caster', 'POST', '/api/v1/rooms/r_none/pause')).status, 404);
    assert.equal((await call('caster', 'POST', `/api/v1/rooms/${id}/next`)).body.code, 'empty_queue');
  });

  it('plays a resolved queue on the speaker and drives it', async () => {
    const id = (await call('caster', 'GET', '/api/v1/rooms')).body.rooms[0].id;
    const songs = ['lib/Tones/a.flac', 'secret/Hidden/x.flac', 'lib/Tones/b.flac'];
    const r = await call('caster', 'POST', `/api/v1/rooms/${id}/play`, { songs, index: 0, positionMs: 1000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.skipped, 1);
    assert.equal(r.body.state, 'playing');
    assert.equal(r.body.queueLength, 2);
    assert.equal(r.body.current.filepath, 'lib/Tones/a.flac');
    assert.equal(r.body.current.title, 'Tone A');
    assert.ok(r.body.current.durationMs > 11000);
    assert.equal(r.body.canSeek, true);
    assert.equal(r.body.playable, true);
    const startVersion = r.body.queueVersion;

    await speaker.waitFor('stream/start', p => Boolean(p.player));
    await speaker.until(() => speaker.audio > 5);

    const q = await call('caster', 'GET', `/api/v1/rooms/${id}/queue`);
    assert.equal(q.body.queueVersion, startVersion);
    assert.deepEqual(q.body.songs.map(s => s.filepath), ['lib/Tones/a.flac', 'lib/Tones/b.flac']);
    assert.equal(q.body.songs[1].title, 'Tone B');

    const paused = await call('caster', 'POST', `/api/v1/rooms/${id}/pause`);
    assert.equal(paused.body.state, 'paused');
    assert.ok(paused.body.positionMs >= 1000);
    const resumed = await call('caster', 'POST', `/api/v1/rooms/${id}/resume`);
    assert.equal(resumed.body.state, 'playing');

    const next = await call('caster', 'POST', `/api/v1/rooms/${id}/next`);
    assert.equal(next.body.index, 1);
    assert.equal(next.body.current.filepath, 'lib/Tones/b.flac');

    const seek = await call('caster', 'POST', `/api/v1/rooms/${id}/seek`, { positionMs: 5000 });
    assert.equal(seek.status, 200);
    assert.ok(seek.body.positionMs >= 4900, `position ${seek.body.positionMs}`);

    const jump = await call('caster', 'POST', `/api/v1/rooms/${id}/jump`, { index: 0 });
    assert.equal(jump.body.current.filepath, 'lib/Tones/a.flac');

    const vol = await call('caster', 'POST', `/api/v1/rooms/${id}/volume`, { volume: 70 });
    assert.equal(vol.status, 200);
    await speaker.waitFor('server/command', p => p.player?.command === 'volume' && p.player.volume === 70);

    const rep = await call('caster', 'POST', `/api/v1/rooms/${id}/repeat`, { repeat: 'all' });
    assert.equal(rep.body.repeat, 'all');
    const shuf = await call('caster', 'POST', `/api/v1/rooms/${id}/shuffle`, { shuffle: true });
    assert.equal(shuf.body.shuffle, true);

    const add = await call('caster', 'POST', `/api/v1/rooms/${id}/add`, { songs: ['lib/Tones/b.flac'] });
    assert.equal(add.body.ok, true);
    assert.equal(add.body.queueLength, 3);
    assert.ok(add.body.queueVersion > startVersion);

    const stop = await call('caster', 'POST', `/api/v1/rooms/${id}/stop`);
    assert.equal(stop.body.state, 'stopped');
    assert.equal(typeof stop.body.stoppedAt.index, 'number');
    assert.equal(typeof stop.body.stoppedAt.positionMs, 'number');
    assert.ok(stop.body.current, 'current names the stopped track');
    await speaker.waitFor('stream/end');

    const state = await call('caster', 'GET', `/api/v1/rooms/${id}/state`);
    assert.equal(state.body.state, 'stopped');
    assert.equal(typeof state.body.positionAt, 'number');
  });

  it('jumps, plays next and loads paused without resending the queue', async () => {
    const id = (await call('caster', 'GET', '/api/v1/rooms')).body.rooms[0].id;
    const T = ['lib/Tones/a.flac', 'lib/Tones/b.flac', 'lib/Tones/c.flac'];
    await call('caster', 'POST', `/api/v1/rooms/${id}/shuffle`, { shuffle: false });
    const played = await call('caster', 'POST', `/api/v1/rooms/${id}/play`, { songs: T });
    assert.equal(played.body.state, 'playing');
    const shuf = await call('caster', 'POST', `/api/v1/rooms/${id}/shuffle`, { shuffle: true });
    assert.ok(shuf.body.queueVersion > played.body.queueVersion, 'shuffle changes the play order');
    const saved = await waitFile(f => f.rooms.find(r => r.id === id)?.shuffle === true);
    const order = saved.rooms.find(r => r.id === id).order;
    const target = order[2];
    const jump = await call('caster', 'POST', `/api/v1/rooms/${id}/jump`, { index: target });
    assert.equal(jump.status, 200);
    assert.equal(jump.body.index, target);
    assert.equal(jump.body.current.filepath, T[target]);
    assert.equal(jump.body.queueVersion, shuf.body.queueVersion, 'jump is not a queue change');
    const after = await waitFile(f => f.rooms.find(r => r.id === id)?.index === target);
    assert.deepEqual(after.rooms.find(r => r.id === id).order, order, 'jump keeps the shuffle order');
    assert.equal((await call('caster', 'POST', `/api/v1/rooms/${id}/jump`, { index: 3 })).body.code, 'invalid_body');

    await call('caster', 'POST', `/api/v1/rooms/${id}/shuffle`, { shuffle: false });
    const jumpClears = inboxCount('stream/clear', p => p.from_timestamp === undefined);
    await call('caster', 'POST', `/api/v1/rooms/${id}/jump`, { index: 0 });
    await speaker.until(() => inboxCount('stream/clear', p => p.from_timestamp === undefined) > jumpClears);
    const audio = speaker.audio;
    await speaker.until(() => speaker.audio > audio + 50);
    const starts = inboxCount('stream/start');
    const plainClears = inboxCount('stream/clear', p => p.from_timestamp === undefined);
    const next = await call('caster', 'POST', `/api/v1/rooms/${id}/add`, { songs: ['lib/Tones/c.flac'], next: true });
    assert.equal(next.status, 200);
    assert.equal(next.body.queueLength, 4);
    const q = await call('caster', 'GET', `/api/v1/rooms/${id}/queue`);
    assert.deepEqual(q.body.songs.map(x => x.filepath), [T[0], T[2], T[1], T[2]]);
    assert.equal(q.body.index, 0);
    assert.equal(q.body.queueVersion, next.body.queueVersion);
    await speaker.waitFor('stream/clear', p => p.from_timestamp !== undefined);
    const st = await call('caster', 'GET', `/api/v1/rooms/${id}/state`);
    assert.equal(st.body.state, 'playing');
    assert.equal(st.body.current.filepath, T[0]);
    assert.equal(inboxCount('stream/start'), starts, 'play next does not restart the stream');
    assert.equal(inboxCount('stream/clear', p => p.from_timestamp === undefined), plainClears, 'the current track is not cleared');

    const ends = inboxCount('stream/end');
    const paused = await call('caster', 'POST', `/api/v1/rooms/${id}/play`, { songs: [T[1], T[0]], index: 1, positionMs: 2000, paused: true });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.state, 'paused');
    assert.equal(paused.body.index, 1);
    assert.equal(paused.body.positionMs, 2000);
    assert.equal(paused.body.current.filepath, T[0]);
    assert.equal(paused.body.queueLength, 2);
    await speaker.until(() => inboxCount('stream/end') > ends);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(inboxCount('stream/start'), starts, 'a paused load streams nothing');
    const resumed = await call('caster', 'POST', `/api/v1/rooms/${id}/resume`);
    assert.equal(resumed.body.state, 'playing');
    await speaker.until(() => inboxCount('stream/start') > starts);
    await call('caster', 'POST', `/api/v1/rooms/${id}/stop`);
  });

  it('manages rooms', async () => {
    const solo = (await call('caster', 'GET', '/api/v1/rooms')).body.rooms[0];
    assert.equal((await call('caster', 'DELETE', `/api/v1/rooms/${solo.id}`)).body.code, 'solo_room');
    assert.equal((await call('caster', 'POST', '/api/v1/rooms', { name: 'Living', members: ['unknown-speaker'] })).status, 404);
    const created = await call('caster', 'POST', '/api/v1/rooms', { name: 'Living', members: [speaker.clientId] });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Living');
    const renamed = await call('caster', 'PATCH', `/api/v1/rooms/${created.body.id}`, { name: 'Lounge' });
    assert.equal(renamed.body.name, 'Lounge');
    assert.equal((await call('caster', 'PATCH', `/api/v1/rooms/${created.body.id}`, { members: [] })).status, 400);
  });

  it('rejects malformed pairing input without echoing it', async () => {
    const r = await call('admin', 'POST', '/api/v1/admin/sendspin/devices/pair-token', { pairingToken: 'SP:not-a-token' });
    assert.equal(r.status, 422);
    assert.match(r.body.code, /^(malformed_token|unsupported_token_version)$/);
    assert.ok(!JSON.stringify(r.body).includes('not-a-token'));

    const { encodePskToken } = await import('../../src/sendspin/pairing.js');
    const { generateStaticKeyPair } = await import('../../src/sendspin/noise.js');
    const { encodeKeyId } = await import('../../src/sendspin/keys.js');
    const other = generateStaticKeyPair().publicKey;
    const token = encodePskToken(other, crypto.randomBytes(32));
    const wrong = await call('admin', 'POST', '/api/v1/admin/sendspin/devices/pair-token', { pairingToken: token, clientId: speaker.clientId });
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.code, 'wrong_client');
    assert.equal(wrong.body.tokenClientId, encodeKeyId(other));
    assert.ok(!JSON.stringify(wrong.body).includes(token));
    const staged = await call('admin', 'POST', '/api/v1/admin/sendspin/devices/pair-token', { pairingToken: token });
    assert.equal(staged.status, 200);
    assert.deepEqual(staged.body, { ok: true, result: 'staged', clientId: encodeKeyId(other), device: staged.body.device });
    assert.equal((await call('admin', 'POST', '/api/v1/admin/sendspin/devices/pair-code/submit', { clientId: speaker.clientId, code: '123456' })).body.code, 'no_pairing');

    const st = await call('admin', 'GET', `/api/v1/admin/sendspin/devices/pair-code/status?clientId=${encodeURIComponent(speaker.clientId)}`);
    assert.equal(st.status, 409);
    assert.equal(st.body.code, 'no_pairing');
  });

  it('renames and revokes a device', async () => {
    const rn = await call('admin', 'POST', '/api/v1/admin/sendspin/devices/rename', { clientId: speaker.clientId, name: 'Kitchen left' });
    assert.equal(rn.body.device.name, 'Kitchen left');
    const rv = await call('admin', 'POST', '/api/v1/admin/sendspin/devices/revoke', { clientId: speaker.clientId });
    assert.equal(rv.body.device.trust, 'unknown');
  });

  it('forgets a device together with its solo room', async () => {
    const id = speaker.clientId;
    await waitFile(f => f.rooms.some(r => r.solo === id && r.name === null));
    speaker.close();
    for (let i = 0; i < 50; i++) {
      const d = (await call('admin', 'GET', '/api/v1/admin/sendspin/status')).body.devices.find(x => x.clientId === id);
      if (d?.connection === 'offline') break;
      await new Promise(r => setTimeout(r, 100));
    }
    const r = await call('admin', 'POST', '/api/v1/admin/sendspin/devices/forget', { clientId: id });
    assert.equal(r.status, 200);
    const f = await waitFile(x => !x.clients[id]);
    assert.ok(!f.rooms.some(x => x.solo === id), 'no solo room left');
    assert.ok(f.rooms.every(x => !x.members.includes(id)), 'no seat in a named room');
    assert.deepEqual(f.rooms.find(x => x.name === 'Lounge').members, []);
    const st = await call('admin', 'GET', '/api/v1/admin/sendspin/status');
    assert.ok(!st.body.devices.some(d => d.clientId === id));
    assert.equal((await call('admin', 'POST', '/api/v1/admin/sendspin/devices/forget', { clientId: id })).status, 404);
  });

  it('backs up the server key and the trust store together', async () => {
    const t0 = Date.now();
    while (!fs.existsSync(path.join(srv.tmpDir, 'sendspin', 'rooms.json')) && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 50));
    const b = await call('admin', 'POST', '/api/v1/admin/backup');
    assert.equal(b.status, 200);
    const zip = fs.readFileSync(path.join(srv.tmpDir, 'backups', b.body.filename));
    for (const name of ['sendspin/server-key.json', 'sendspin/trust-store.json', 'sendspin/rooms.json']) {
      assert.ok(zip.includes(Buffer.from(name)), `${name} in the backup`);
    }
  });

  it('stops the listener when disabled', async () => {
    const r = await call('admin', 'POST', '/api/v1/admin/sendspin/settings', { enabled: false });
    assert.equal(r.body.running, false);
    assert.equal((await call('caster', 'GET', '/api/v1/rooms')).body.code, 'rooms_disabled');
  });
});
