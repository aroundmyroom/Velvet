import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { RoomManager, RoomError } from '../src/sendspin/rooms.js';
import { serverNow } from '../src/sendspin/scheduler.js';
import {
  PcmTap, RoomSonos, createSonosSoap, rawEncoder, radioDidl, transportUri, icyBlock, streamUrlFor, artUrlFor,
  SONOS_RATE, STREAM_PATH, DEFAULT_SONOS_DELAY_MS, sonosStreamPeerAllowed,
} from '../src/sendspin/sonos.js';
import { RoomsService } from '../src/sendspin/service.js';
import { FakeMember, FFMPEG, PCM48, tone, until, sleep } from './helpers/sendspin-fake-member.mjs';

const UUID = 'RINCON_000E58AABBCC01400';
const UUID2 = 'RINCON_000E58DDEEFF01400';

// A fake Sonos: the few UPnP actions Velvet calls, recorded. Nothing here ever reaches a real speaker.
class FakeSonos {
  calls = [];
  volume = 20;
  muted = false;
  uri = '';

  async start() {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const action = /#(\w+)"/.exec(req.headers.soapaction)?.[1];
        const tag = (t) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(body)?.[1];
        this.calls.push({ action, path: req.url, body });
        let out = '';
        if (action === 'SetAVTransportURI') this.uri = tag('CurrentURI').replaceAll('&amp;', '&');
        if (action === 'SetVolume') this.volume = Number(tag('DesiredVolume'));
        if (action === 'SetMute') this.muted = tag('DesiredMute') === '1';
        if (action === 'Stop') this.uri = '';
        if (action === 'GetVolume') out = `<CurrentVolume>${this.volume}</CurrentVolume>`;
        if (action === 'GetMute') out = `<CurrentMute>${this.muted ? 1 : 0}</CurrentMute>`;
        if (action === 'GetMediaInfo') out = `<CurrentURI>${this.uri}</CurrentURI>`;
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(`<s:Envelope><s:Body><u:${action}Response>${out}</u:${action}Response></s:Body></s:Envelope>`);
      });
    });
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = this.server.address().port;
    return this;
  }

  actions() {
    return this.calls.map((c) => c.action);
  }

  token() {
    return new RegExp(`${STREAM_PATH}([A-Za-z0-9_-]+)\\.mp3`).exec(this.uri)?.[1] ?? null;
  }

  close() {
    this.server.close();
  }
}

let dir;
let sonos;
let streamSrv;
let base;
const rms = [];
const F = {};

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-sonos-'));
  F.a = await tone(path.join(dir, 'a.wav'), { freq: 440, seconds: 0.6 });
  F.b = await tone(path.join(dir, 'b.wav'), { freq: 660, seconds: 0.6 });
  F.long = await tone(path.join(dir, 'long.wav'), { freq: 220, seconds: 6 });
  sonos = await new FakeSonos().start();
  streamSrv = http.createServer((req, res) => {
    const token = new RegExp(`^${STREAM_PATH}([A-Za-z0-9_-]+)\\.mp3$`).exec(req.url)?.[1];
    for (const rm of rms) {
      const s = token && rm.sonosStream(token);
      if (s) return s.serve(req, res);
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => streamSrv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${streamSrv.address().port}`;
});

after(async () => {
  sonos.close();
  streamSrv.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

const bridge = () => ({
  soap: createSonosSoap({ port: sonos.port, allowHost: (ip) => ip === '127.0.0.1' }),
  resolve: (uuid) => (uuid === UUID || uuid === UUID2 ? { ip: '127.0.0.1', name: uuid === UUID ? 'Kitchen Sonos' : 'Den' } : null),
  streamUrl: streamUrlFor,
  artUrl: artUrlFor,
});

let n = 0;
async function manager(opts = {}) {
  const rm = await RoomManager.open(opts.dir ?? path.join(dir, `rm${++n}`), {
    ffmpeg: FFMPEG, idleGraceMs: 150, sonos: bridge(), sonosOptions: { encoder: rawEncoder, idleMs: 300 }, ...opts,
  });
  rms.push(rm);
  return rm;
}

const item = (file, title, durationMs) => ({ filepath: `Music/${title}.wav`, file, meta: { title, artist: 'Tester', durationMs } });

function fetchStream(token, { ms = 600, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${STREAM_PATH}${token}.mp3`, { headers }, (res) => {
      const chunks = [];
      const at = [];
      res.on('data', (c) => {
        chunks.push(c);
        at.push(Date.now());
      });
      const done = () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), at, ended: res.complete });
      res.on('end', done);
      res.on('close', done);
      setTimeout(() => req.destroy(), ms);
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? resolve({ status: 0, body: Buffer.alloc(0) }) : reject(err)));
  });
}

const loud = (buf) => {
  let k = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) if (Math.abs(buf.readInt16LE(i)) > 1000) k++;
  return k;
};

test('helpers: transport URI, radio DIDL, ICY block, URLs', () => {
  assert.equal(transportUri('http://10.0.0.2:3001/x.mp3'), 'x-rincon-mp3radio://10.0.0.2:3001/x.mp3');
  assert.equal(transportUri('https://h/x.mp3'), 'https://h/x.mp3');
  const d = radioDidl({ title: 'A & <B>', artUrl: 'https://h/a.jpg' });
  assert.match(d, /<dc:title>A &amp; &lt;B&gt;<\/dc:title>/);
  assert.match(d, /audioBroadcast/);
  const b = icyBlock("It's");
  assert.equal(b.length, 1 + b[0] * 16);
  assert.match(b.toString('utf8', 1), /^StreamTitle='It’s';/);
  assert.equal(streamUrlFor('http://h:1/', 'tok'), `http://h:1${STREAM_PATH}tok.mp3`);
  assert.equal(artUrlFor('https://h', 'a b.jpg'), 'https://h/album-art/a%20b.jpg');
});

test('soap refuses hosts outside the private LAN by default', async () => {
  await assert.rejects(createSonosSoap()('8.8.8.8', 'AVTransport', 'Play'), /not a private LAN/);
  await assert.rejects(createSonosSoap()('127.0.0.1', 'AVTransport', 'Play'), /not a private LAN/);
});

class FakeStream extends EventEmitter {
  t0 = null;
  playing = false;
  masterRate = null;
  tapLeadUs = 0;
  pcmHistory = [];
}

const ramp = (start, frames) => {
  const b = Buffer.alloc(frames * 8);
  for (let i = 0; i < frames; i++) {
    b.writeInt32LE((start + i) * 65536, i * 8);
    b.writeInt32LE(-(start + i) * 65536, i * 8 + 4);
  }
  return b;
};

test('PcmTap maps audible time to samples, silence around them, cuts and resamples', () => {
  const now = 10_000_000;
  const s = new FakeStream();
  const tap = new PcmTap({ now: () => now });
  tap.attach(s);
  s.emit('epoch', { rate: SONOS_RATE });
  s.emit('pcm', { sample: 0, pcm: ramp(0, 4800) });
  s.emit('pcm', { sample: 4800, pcm: ramp(4800, 4800) });
  assert.equal(tap.read(0, 10).readInt16LE(0), 0, 'no t0 yet: silence');
  s.t0 = 20_000_000;
  const at = tap.read(s.t0 + 100 * 1_000_000 / SONOS_RATE, 3);
  assert.deepEqual([at.readInt16LE(0), at.readInt16LE(2), at.readInt16LE(4)], [100, -100, 101]);
  const before = tap.read(s.t0 - 1000, 96);
  assert.equal(before.readInt16LE(0), 0);
  assert.equal(before.readInt16LE(95 * 4), 47);
  s.emit('cut', 6000);
  assert.equal(tap.read(s.t0 + 125_000, 1).readInt16LE(0), 0, 'past the cut: silence until the new decode');
  s.emit('pcm', { sample: 6000, pcm: ramp(9000, 100) });
  assert.equal(tap.read(s.t0 + 125_000, 1).readInt16LE(0), 9000);
  s.emit('epoch', { rate: 24_000 });
  s.emit('pcm', { sample: 0, pcm: ramp(0, 100) });
  const half = tap.read(s.t0, 4);
  assert.deepEqual([0, 1, 2, 3].map((k) => half.readInt16LE(k * 4)), [0, 1, 1, 2], '24 kHz -> 48 kHz, linear');
  s.emit('stop');
  assert.equal(tap.read(s.t0 + 20_000, 1).readInt16LE(0), 0);
  tap.detach();
  assert.equal(s.listenerCount('pcm'), 0);
});

let lastToken = null;

class FakeRes extends Writable {
  chunks = [];
  _write(c, _e, cb) {
    this.chunks.push(c);
    cb();
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  get body() {
    return Buffer.concat(this.chunks);
  }
}

test('a feed carries the room audio delayMs ahead; a delay change shifts it on the fly', async () => {
  let now = 50_000_000;
  const s = new FakeStream();
  const changes = [];
  const g = new RoomSonos({
    bridge: { ...bridge(), soap: async (ip, svc, action, inner) => {
      if (action === 'SetAVTransportURI') lastToken = /sonos-stream\/([A-Za-z0-9_-]+)\.mp3/.exec(inner)[1];
      return '';
    } }, now: () => now, encoder: rawEncoder,
    info: () => ({ roomName: 'R' }), onChange: () => changes.push(1),
  });
  g.setStream(s);
  g.add({ uuid: UUID, name: 'K', ip: '127.0.0.1', base, delayMs: 1000 });
  assert.equal(s.tapLeadUs, 1_000_000, 'the room keeps t0 a delay ahead');
  s.emit('epoch', { rate: SONOS_RATE });
  s.t0 = now + 1_000_000;
  s.emit('pcm', { sample: 0, pcm: ramp(0, 30_000) });
  await until(() => g.view()[0].state === 'waiting');
  const f = g.sessionFor(lastToken);
  assert.ok(f);
  const res = new FakeRes();
  g.serve(f, { headers: {}, method: 'GET' }, res);
  assert.equal(g.view()[0].state, 'streaming');
  now += 100_000;
  await sleep(60);
  const first = res.body;
  assert.equal(first.length, 4800 * 4);
  assert.equal(first.readInt16LE(0), 0, 'frame 0 is what the room plays at connect + delay: sample 0');
  assert.equal(first.readInt16LE(4799 * 4), 4799);
  g.setDelay(UUID, 1250);
  assert.equal(s.tapLeadUs, 1_250_000);
  now += 100_000;
  await sleep(60);
  const next = res.body.subarray(first.length);
  assert.equal(next.length, 4800 * 4);
  assert.equal(next.readInt16LE(0), 4800 + 12_000, '+250 ms delay skips 250 ms of audio');
  g.setDelay(UUID, 1000);
  now += 10_000;
  await sleep(60);
  const back = res.body.subarray(first.length + next.length);
  assert.equal(back.readInt16LE(0), 9600, '-250 ms falls back (already pruned audio would be silence)');
  g.close({ stop: false });
  assert.ok(res.destroyed);
  assert.equal(g.sessionFor(lastToken), null);
});

test('a Sonos follows a room: SOAP start on play, token stream, continuous across a track change, polite stop', async () => {
  sonos.calls = [];
  const rm = await manager();
  const a = new FakeMember({ name: 'A', formats: [PCM48], player: { volume: 80 } });
  rm.attach(a);
  const id = rm.roomOf(a.clientId);
  rm.addSonos(id, { uuid: UUID, name: 'Kitchen Sonos', ip: '127.0.0.1', base, delayMs: 400 });
  // The volume lands once both GetVolume and GetMute have answered, not when GetMute is sent.
  await until(() => rm.getRoom(id).sonos[0]?.volume !== null);
  assert.ok(!sonos.actions().includes('SetAVTransportURI'), 'nothing plays on the Sonos while the room is stopped');
  let view = rm.getRoom(id);
  assert.equal(view.sonos.length, 1);
  assert.equal(view.sonos[0].id, `sonos:${UUID}`);
  assert.equal(view.sonos[0].volume, 20);
  assert.equal(view.volume, 50, 'group volume averages Sendspin and Sonos');
  const startedAt = serverNow();
  rm.play(id, { items: [item(F.a, 'A', 600), item(F.b, 'B', 600)] });
  await until(() => sonos.actions().includes('Play'));
  const set = sonos.calls.find((c) => c.action === 'SetAVTransportURI');
  assert.match(set.body, /x-rincon-mp3radio:\/\/127\.0\.0\.1/);
  assert.match(set.body, /A · Velvet Rooms|A · Velvet Rooms/);
  const token = sonos.token();
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  await until(() => a.chunks.length > 0);
  assert.ok(a.chunks[0].ts - startedAt >= 400_000, 'the Sendspin speakers start a Sonos delay later');
  assert.equal((await fetchStream('A'.repeat(32), { ms: 100 })).status, 404);
  const got = await fetchStream(token, { ms: 1600, headers: { 'Icy-MetaData': '0' } });
  assert.equal(got.status, 200);
  assert.equal(got.headers['content-type'], 'audio/mpeg');
  const secs = got.body.length / (SONOS_RATE * 4);
  assert.ok(secs > 1.2 && secs < 1.8, `real-time paced (${secs.toFixed(2)} s in 1.6 s)`);
  const quarter = got.body.length / 4;
  for (let q = 0; q < 2; q++) assert.ok(loud(got.body.subarray(q * quarter, (q + 1) * quarter)) > 1000, `audio in quarter ${q}`);
  assert.equal(sonos.calls.filter((c) => c.action === 'SetAVTransportURI').length, 1, 'one stream across the track change');
  view = rm.getRoom(id);
  assert.equal(view.sonos[0].state, 'waiting');
  rm.removeSonos(id, UUID);
  await until(() => sonos.actions().includes('Stop'));
  assert.equal(rm.sonosStream(token), null, 'the token dies with the membership');
  assert.equal((await fetchStream(token, { ms: 100 })).status, 404);
  await rm.close();
});

test('seek and skip keep the stream; halt keeps it idle for a while, then stops the Sonos', async () => {
  sonos.calls = [];
  const rm = await manager();
  const a = new FakeMember({ name: 'A', formats: [PCM48] });
  rm.attach(a);
  const id = rm.roomOf(a.clientId);
  rm.addSonos(id, { uuid: UUID, name: 'K', ip: '127.0.0.1', base, delayMs: 200 });
  rm.play(id, { items: [item(F.long, 'L', 6000), item(F.a, 'A', 600)] });
  await until(() => sonos.actions().includes('Play'));
  const token = sonos.token();
  const pending = fetchStream(token, { ms: 900 });
  await sleep(200);
  rm.seek(id, 3000);
  rm.next(id);
  const got = await pending;
  assert.equal(got.status, 200);
  assert.ok(got.body.length > SONOS_RATE * 4 * 0.6);
  assert.equal(sonos.calls.filter((c) => c.action === 'SetAVTransportURI').length, 1);
  rm.pause(id);
  assert.ok(rm.sonosStream(token), 'a pause keeps the session');
  rm.resume(id);
  assert.equal(sonos.calls.filter((c) => c.action === 'SetAVTransportURI').length, 1);
  rm.stop(id);
  await until(() => sonos.actions().includes('Stop'), { timeoutMs: 3000 });
  assert.equal(rm.sonosStream(token), null);
  await rm.close();
});

test('the Sonos is left alone when it plays something else by then', async () => {
  sonos.calls = [];
  const rm = await manager();
  const a = new FakeMember({ name: 'A', formats: [PCM48] });
  rm.attach(a);
  const id = rm.roomOf(a.clientId);
  rm.addSonos(id, { uuid: UUID, name: 'K', ip: '127.0.0.1', base, delayMs: 200 });
  rm.play(id, { items: [item(F.long, 'L', 6000)] });
  await until(() => sonos.actions().includes('Play'));
  sonos.uri = 'x-sonos-spotify:something';
  rm.removeSonos(id, UUID);
  await until(() => sonos.actions().includes('GetMediaInfo'));
  await sleep(100);
  assert.ok(!sonos.actions().includes('Stop'));
  await rm.close();
});

test('group volume and mute include the Sonos; per-Sonos volume; validation', async () => {
  sonos.calls = [];
  sonos.volume = 20;
  const rm = await manager();
  const a = new FakeMember({ name: 'A', player: { volume: 80 } });
  rm.attach(a);
  const id = rm.roomOf(a.clientId);
  rm.addSonos(id, { uuid: UUID, name: 'K', ip: '127.0.0.1', base });
  await until(() => rm.getRoom(id).sonos[0].volume === 20);
  assert.equal(rm.getRoom(id).sonos[0].delayMs, DEFAULT_SONOS_DELAY_MS);
  assert.deepEqual(rm.setVolume(id, 60), { [a.clientId]: 90, [`sonos:${UUID}`]: 30 });
  await until(() => sonos.volume === 30);
  rm.mute(id, true);
  await until(() => sonos.muted === true);
  assert.equal(rm.getRoom(id).muted, false, 'the Sendspin speaker only mutes when it reports it');
  rm.setMemberVolume(id, `sonos:${UUID}`, 75);
  await until(() => sonos.volume === 75);
  rm.setMemberMute(id, `sonos:${UUID}`, false);
  await until(() => sonos.muted === false);
  assert.throws(() => rm.setMemberVolume(id, `sonos:${UUID2}`, 5), RoomError);
  assert.throws(() => rm.addSonos(id, { uuid: 'nope', name: 'x' }), RoomError);
  assert.throws(() => rm.addSonos(id, { uuid: UUID2, name: 'x', delayMs: 5001 }), RoomError);
  assert.throws(() => rm.setSonosDelay(id, UUID, -1), RoomError);
  assert.throws(() => rm.setSonosDelay(id, UUID2, 100), RoomError);
  assert.throws(() => rm.removeSonos(id, UUID2), RoomError);
  await rm.close();
  const off = await manager({ sonos: null });
  const b = new FakeMember({ name: 'B' });
  off.attach(b);
  assert.throws(() => off.addSonos(off.roomOf(b.clientId), { uuid: UUID, name: 'x' }), /not enabled/);
  await off.close();
});

test('a Sonos is in one room at most and persists in rooms.json with its delay', async () => {
  const d = path.join(dir, 'persist');
  const rm = await manager({ dir: d });
  const a = new FakeMember({ name: 'A' });
  const b = new FakeMember({ name: 'B' });
  rm.attach(a);
  rm.attach(b);
  const ra = rm.roomOf(a.clientId);
  const rb = rm.roomOf(b.clientId);
  rm.addSonos(ra, { uuid: UUID, name: 'K', ip: '127.0.0.1', base, delayMs: 1234 });
  rm.addSonos(rb, { uuid: UUID, name: 'K' });
  assert.equal(rm.getRoom(ra).sonos.length, 0);
  assert.equal(rm.getRoom(rb).sonos[0].delayMs, 1234, 'a move keeps the delay');
  assert.equal(rm.sonosRoomOf(UUID), rb);
  await rm.close();
  const saved = JSON.parse(await fsp.readFile(path.join(d, 'rooms.json'), 'utf8'));
  assert.deepEqual(saved.rooms.find((r) => r.id === rb).sonos, [{ uuid: UUID, name: 'K', ip: '127.0.0.1', base, delayMs: 1234 }]);
  assert.equal(saved.rooms.find((r) => r.id === ra).sonos, undefined);
  const again = await manager({ dir: d, sonos: null });
  assert.equal(again.getRoom(rb).sonos[0].uuid, UUID, 'kept even while Sonos is off');
  await again.close();
  const kept = JSON.parse(await fsp.readFile(path.join(d, 'rooms.json'), 'utf8'));
  assert.equal(kept.rooms.find((r) => r.id === rb).sonos.length, 1);
});

test('the real stream is MP3 (ffmpeg libmp3lame) with ICY titles when the Sonos asks for them', async () => {
  sonos.calls = [];
  const rm = await manager({ sonosOptions: { encoder: null, idleMs: 300 } });
  const a = new FakeMember({ name: 'A', formats: [PCM48] });
  rm.attach(a);
  const id = rm.roomOf(a.clientId);
  rm.addSonos(id, { uuid: UUID, name: 'K', ip: '127.0.0.1', base, delayMs: 200 });
  rm.play(id, { items: [item(F.long, 'Long tone', 6000)] });
  await until(() => sonos.actions().includes('Play'));
  const got = await fetchStream(sonos.token(), { ms: 1500, headers: { 'Icy-MetaData': '1' } });
  assert.equal(got.status, 200);
  assert.equal(got.headers['icy-metaint'], '16000');
  assert.ok(got.body.length > 16_001, `got ${got.body.length} bytes`);
  assert.equal(got.body[0], 0xff, 'MP3 frame sync, no ID3 header');
  assert.equal(got.body[1] & 0xe0, 0xe0);
  const len = got.body[16_000] * 16;
  assert.match(got.body.toString('utf8', 16_001, 16_001 + len), /^StreamTitle='Tester - Long tone';/);
  await rm.close();
});

test('Sonos switched off: followers stay persisted but dormant (no lead, no tap, not playable) and wake when it is on', async () => {
  sonos.calls = [];
  let enabled = false;
  const rm = await manager({ sonos: { ...bridge(), enabled: () => enabled } });
  const a = new FakeMember({ name: 'A', formats: [PCM48] });
  rm.attach(a);
  const id = rm.roomOf(a.clientId);
  rm.addSonos(id, { uuid: UUID, name: 'K', ip: '127.0.0.1', base, delayMs: 2000 });
  let view = rm.getRoom(id);
  assert.equal(view.sonos.length, 1, 'kept in the room');
  assert.equal(view.sonos[0].dormant, true);
  const playable = (v) => RoomsService.prototype.playable.call({}, { ...v, members: [] });
  assert.equal(playable(view), false, 'a dormant Sonos does not make the room playable');
  let startedAt = serverNow();
  rm.play(id, { items: [item(F.long, 'L', 6000)] });
  await until(() => a.chunks.length > 0);
  assert.ok(a.chunks[0].ts - startedAt < 1_000_000, `no Sonos lead while off (${a.chunks[0].ts - startedAt} µs)`);
  await sleep(150);
  assert.ok(!sonos.actions().includes('SetAVTransportURI'), 'no SOAP while off');
  rm.stop(id);

  enabled = true;
  a.chunks.length = 0;
  startedAt = serverNow();
  rm.play(id, { items: [item(F.long, 'L', 6000)] });
  await until(() => sonos.actions().includes('Play'));
  await until(() => a.chunks.length > 0);
  assert.ok(a.chunks[0].ts - startedAt >= 2_000_000, 'the lead is back once Sonos is on');
  view = rm.getRoom(id);
  assert.equal(view.sonos[0].dormant, false);
  assert.equal(playable(view), true);
  rm.stop(id);
  await rm.close();
});

test('the public Sonos stream accepts private LAN peers; loopback only when asked (tests)', () => {
  assert.equal(sonosStreamPeerAllowed('192.168.1.20'), true);
  assert.equal(sonosStreamPeerAllowed('::ffff:10.0.0.7'), true);
  assert.equal(sonosStreamPeerAllowed('127.0.0.1'), false, 'a local process or reverse proxy is not a Sonos');
  assert.equal(sonosStreamPeerAllowed('::1'), false);
  assert.equal(sonosStreamPeerAllowed('::ffff:127.0.0.1'), false);
  assert.equal(sonosStreamPeerAllowed('8.8.8.8'), false);
  assert.equal(sonosStreamPeerAllowed(undefined), false);
  assert.equal(sonosStreamPeerAllowed('127.0.0.1', { loopback: true }), true);
});
