import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { encodeKeyId, SENTINEL_PSK, PSK_CATEGORY } from '../src/sendspin/keys.js';
import { generateStaticKeyPair, SUITES } from '../src/sendspin/noise.js';
import { encodePskToken } from '../src/sendspin/pairing.js';
import { MSG, frame, fragment } from '../src/sendspin/wire.js';
import {
  SendspinConnection, cleanText, parseArtworkState, parseVisualizerState, parseSourceState, parseControllerCommand,
} from '../src/sendspin/connection.js';
import { SendspinServer } from '../src/sendspin/server.js';
import { RoomsService } from '../src/sendspin/service.js';
import { RoomManager, ROOMS_FILE } from '../src/sendspin/rooms.js';
import { TestClient, helloPayload, PLAYER_STATE } from './helpers/sendspin-test-client.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const LOCAL = '127.0.0.1';
const DEEP = 100_000;
const deepJson = (leaf = '1') => '{"a":'.repeat(DEEP) + leaf + '}'.repeat(DEEP);

// Any error escaping a socket handler or promise chain would end Velvet; fail the test instead.
function processGuard(t) {
  const errors = [];
  const onErr = (err) => errors.push(err);
  process.on('uncaughtException', onErr);
  process.on('unhandledRejection', onErr);
  t.after(() => {
    process.off('uncaughtException', onErr);
    process.off('unhandledRejection', onErr);
  });
  return async () => {
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(errors.map((e) => String(e?.stack ?? e)), [], 'no uncaught exception or unhandled rejection');
  };
}

function tmpDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeServer(t, opts = {}) {
  const dataDir = await tmpDir('sendspin-hostile-');
  const server = new SendspinServer({ dataDir, host: LOCAL, port: 0, logger: quiet, ...opts });
  await server.start();
  t.after(async () => {
    await server.stop();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  return server;
}

async function makeService(t, dataDir, serverOptions = {}) {
  const service = new RoomsService({ dataDir, logger: quiet, serverOptions: { host: LOCAL, port: 0, ...serverOptions } });
  await service.apply({ enabled: true, name: 'Hostile', port: 0, bind: LOCAL, path: '/sendspin', discovery: false, languages: ['en'] });
  t.after(async () => {
    await service.stop();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  assert.ok(service.running, service.error);
  return service;
}

async function client(t, port, opts = {}) {
  const c = new TestClient(opts);
  await c.dial(`ws://${LOCAL}:${port}/sendspin`);
  t.after(() => c.close());
  return c;
}

function rawSocket(t, port) {
  const ws = new WebSocket(`ws://${LOCAL}:${port}/sendspin`);
  t.after(() => ws.terminate());
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, closed }));
    ws.once('error', reject);
  });
}

function initText(keyPair = generateStaticKeyPair()) {
  return Buffer.from(JSON.stringify({ payload: { client_id: encodeKeyId(keyPair.publicKey), suite: SUITES[0], version: 1 }, type: 'client/init' }));
}

function sendRawJson(c, text) {
  for (const part of fragment(frame(MSG.JSON, Buffer.from(text)))) c.ws.send(c.tx.encrypt(part), { binary: true });
}

// A standalone connection whose PSK lookup stays pending, to hit the 'resolving' phase deterministically.
async function slowResolver(t, delayMs = 300) {
  const wss = new WebSocketServer({ host: LOCAL, port: 0 });
  await new Promise((r) => wss.once('listening', r));
  t.after(() => new Promise((r) => {
    for (const ws of wss.clients) ws.terminate();
    wss.close(() => r());
  }));
  const kp = generateStaticKeyPair();
  const identity = { serverId: encodeKeyId(kp.publicKey), publicKey: kp.publicKey, privateKey: kp.privateKey };
  const conns = [];
  wss.on('connection', (ws) => {
    conns.push(new SendspinConnection({
      ws, identity, logger: quiet,
      resolvePsk: () => new Promise((r) => setTimeout(() => r({ psk: SENTINEL_PSK, category: PSK_CATEGORY.SENTINEL }), delayMs)),
    }));
  });
  return { port: wss.address().port, conns };
}

test('cleanText never coerces objects', () => {
  assert.equal(cleanText({ toString: 1 }), '[object]');
  assert.equal(cleanText(Object.create(null)), '[object]');
  assert.equal(cleanText([1]), '[array]');
  assert.equal(cleanText(Symbol('x')), '[symbol]');
  assert.equal(cleanText(12), '12');
  assert.equal(cleanText('a\u0000b'), 'a?b');
});

test('binary and text frames while the PSK lookup is pending close the socket; the process stays up', async (t) => {
  const done = processGuard(t);
  const { port, conns } = await slowResolver(t);
  for (const [payload, binary] of [[Buffer.from([1, 2, 3]), true], [Buffer.from('{"type":"x","payload":{}}'), false]]) {
    const { ws, closed } = await rawSocket(t, port);
    ws.send(initText(), { binary: false });
    ws.send(payload, { binary });
    assert.equal(await closed, 1002);
  }
  assert.ok(conns.every((c) => c.phase === 'resolving'));
  await new Promise((r) => setTimeout(r, 400));
  await done();
});

test('init and binary in one burst against the real server (the original crash)', async (t) => {
  const done = processGuard(t);
  const server = await makeServer(t);
  for (let i = 0; i < 5; i++) {
    const { ws, closed } = await rawSocket(t, server.port);
    ws.send(initText(), { binary: false });
    ws.send(Buffer.alloc(64, 7), { binary: true });
    assert.ok([1002, 1006].includes(await closed));
  }
  await done();
});

test('hostile frames in every phase: before init, during msg2, transport cleartext, after close', async (t) => {
  const done = processGuard(t);
  const server = await makeServer(t);
  const pre = await rawSocket(t, server.port);
  pre.ws.send(Buffer.alloc(10), { binary: true });
  await pre.closed;

  const m2 = await rawSocket(t, server.port);
  const texts = [];
  m2.ws.on('message', (d) => texts.push(d));
  m2.ws.send(initText(), { binary: false });
  for (let i = 0; i < 100 && texts.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  m2.ws.send(Buffer.alloc(80, 1), { binary: true });
  assert.equal(await m2.closed, 1002);

  const m2text = await rawSocket(t, server.port);
  m2text.ws.send(initText(), { binary: false });
  m2text.ws.send('{"type":"noise/handshake","payload":{"data":{"toString":1}}}', { binary: false });
  await m2text.closed;

  const c = await client(t, server.port);
  await c.connect();
  c.ws.send('cleartext', { binary: false });
  assert.equal(await c.closed, 1002);

  const late = await client(t, server.port);
  await late.connect();
  const conn = server.getClient(late.clientId);
  conn.close(1000, { toString: 1 });
  try {
    late.ws.send(Buffer.alloc(40, 2), { binary: true });
    late.send('client/state', { available: true });
  } catch {
    // the socket may already be closing on our side
  }
  await late.closed;
  await done();
});

test('hostile JSON: goodbye reason and pair-method locations with a non-callable toString', async (t) => {
  const done = processGuard(t);
  const server = await makeServer(t);
  const a = await client(t, server.port);
  await a.connect();
  const goodbye = new Promise((r) => server.once('goodbye', (conn, reason) => r(reason)));
  sendRawJson(a, '{"type":"client/goodbye","payload":{"reason":{"toString":1}}}');
  assert.equal(await goodbye, 'unknown');
  await a.closed;

  const b = await client(t, server.port);
  const hello = helloPayload({ supported_pair_methods: { static_pairing_code: { locations: [{ toString: 1 }, ['x'], null, 7] }, x: { toString: 1 } } });
  const act = await b.connect(hello);
  assert.deepEqual(act.payload.activities, []);
  assert.ok(server.getClient(b.clientId).isOpen);
  const dev = server.device(b.clientId);
  assert.deepEqual(dev.pairMethods, ['static_pairing_code']);

  const c = await client(t, server.port);
  c.connect(helloPayload({ name: { toString: 1 } })).catch(() => {});
  assert.equal(await c.closed, 1002);
  await done();
});

test('client/state sub-objects are reduced to strict shapes; deep nesting and wrong types are dropped', async (t) => {
  const done = processGuard(t);
  const dataDir = await tmpDir('sendspin-hostile-state-');
  const service = await makeService(t, dataDir);
  const kp = generateStaticKeyPair();
  await service.server.approve(encodeKeyId(kp.publicKey));
  const c = await client(t, service.server.port, { keyPair: kp });
  await c.connect(helloPayload({ supported_roles: ['player@v1', 'controller@v1', 'artwork@v1'] }));
  const conn = service.server.getClient(c.clientId);
  assert.ok(conn.hasRole('artwork'));
  const states = [];
  conn.on('state', (s) => states.push(s));

  sendRawJson(c, `{"type":"client/state","payload":{"available":true,"artwork":${deepJson()}}}`);
  sendRawJson(c, `{"type":"client/state","payload":{"available":true,"artwork":{"channels":[${deepJson()}]}}}`);
  sendRawJson(c, `{"type":"client/state","payload":{"available":true,"player":${JSON.stringify(PLAYER_STATE)},"artwork":{"channels":[{"source":"album","format":"jpeg","width":300,"height":300,"x":${deepJson()}},{"source":"artist","format":"gif","width":1,"height":1},{"source":"album","format":"png","width":99999,"height":2}]}}}`);
  sendRawJson(c, `{"type":"client/command","payload":{"controller":{"command":"seek_relative","offset_ms":1e300,"x":${deepJson()}}}}`);
  sendRawJson(c, `{"type":"client/command","payload":{"controller":{"command":{"toString":1}}}}`);
  await c.until(() => states.length >= 3);
  assert.equal(states[0].roles.artwork, undefined);
  assert.equal(states[1].roles.artwork.channels[0].source, 'none');
  assert.deepEqual(states[2].roles.artwork, {
    channels: [{ source: 'album', format: 'jpeg', width: 300, height: 300 }, { source: 'none' }, { source: 'none' }],
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(conn.isOpen, 'the connection survives');
  assert.ok(service.rooms.isAttached(c.clientId));
  await service.rooms.flush();
  JSON.parse(await fsp.readFile(path.join(dataDir, ROOMS_FILE), 'utf8'));
  await done();
});

test('role-state parsers accept only the spec shapes', () => {
  assert.equal(parseArtworkState({ channels: [] }), null);
  assert.equal(parseArtworkState({ channels: Array(5).fill({ source: 'none' }) }), null);
  assert.equal(parseArtworkState('x'), null);
  assert.deepEqual(parseArtworkState({ channels: [{ source: 'none', junk: { a: 1 } }] }), { channels: [{ source: 'none' }] });
  assert.deepEqual(parseVisualizerState({ types: ['beat', 'evil', 7], rate_max: 30, extra: {} }), { types: ['beat'], rate_max: 30 });
  assert.equal(parseVisualizerState({ types: ['beat'], rate_max: 0 }), null);
  assert.throws(() => parseVisualizerState({ types: ['spectrum'], rate_max: 30 }));
  assert.deepEqual(parseVisualizerState({ types: ['spectrum'], rate_max: 30, spectrum: { n_disp_bins: 16, scale: 'mel', f_min: 20, f_max: 16000, z: 1 } }),
    { types: ['spectrum'], rate_max: 30, spectrum: { n_disp_bins: 16, scale: 'mel', f_min: 20, f_max: 16000 } });
  assert.deepEqual(parseSourceState({ signal: 'present', x: 1 }), { signal: 'present' });
  assert.equal(parseSourceState({ signal: { toString: 1 } }), null);
  assert.equal(parseControllerCommand({ command: { toString: 1 } }), null);
  assert.deepEqual(parseControllerCommand({ command: 'seek_relative', offset_ms: 1e300, volume: '5' }), { command: 'seek_relative' });
  assert.deepEqual(parseControllerCommand({ command: 'volume', volume: 30, mute: true }), { command: 'volume', volume: 30, mute: true });
});

test('untrusted flood: no rooms, no lockout of an approved speaker, known devices capped', async (t) => {
  const done = processGuard(t);
  const service = await makeService(t, await tmpDir('sendspin-hostile-flood-'), { maxClients: 4, maxKnown: 40 });
  const { server } = service;
  const approvedKey = generateStaticKeyPair();
  await server.approve(encodeKeyId(approvedKey.publicKey));

  const flood = [];
  for (let batch = 0; batch < 10; batch++) {
    const cs = await Promise.all(Array.from({ length: 10 }, () => client(t, server.port)));
    await Promise.all(cs.map((c) => {
      const connected = c.connect();
      connected.catch(() => {});
      return Promise.race([connected, c.closed]);
    }));
    flood.push(...cs);
  }
  const live = [...server.clients.values()].filter((c) => !server.isTrusted(c.clientId));
  assert.ok(live.length <= 16, `untrusted live clients capped (${live.length})`);
  assert.ok(server.knownCount <= 40, `known devices capped (${server.knownCount})`);
  assert.deepEqual(service.listRooms(), []);
  assert.equal(service.rooms.listRooms().length, 0, 'no room state for untrusted keys');

  const good = await client(t, server.port, { keyPair: approvedKey });
  const act = await good.connect();
  assert.ok(act.payload.active_roles.includes('player@v1'), 'approved speaker still admitted with roles');
  const rooms = service.listRooms();
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].members[0].clientId, good.clientId);
  for (const c of flood) c.close();
  await done();
});

test('rooms appear on approval and go on revoke; stale untrusted solo rooms are pruned at start', async (t) => {
  const dataDir = await tmpDir('sendspin-hostile-trust-');
  const stale = encodeKeyId(generateStaticKeyPair().publicKey);
  const seed = await RoomManager.open(dataDir, { logger: quiet });
  seed.attach({ clientId: stale, info: { name: 'Ghost' }, activeRoles: [], on() {}, off() {}, hasRole: () => false, isOpen: false, state: null });
  seed.detach(stale);
  await seed.close();
  assert.ok(JSON.parse(await fsp.readFile(path.join(dataDir, ROOMS_FILE), 'utf8')).clients[stale]);

  const service = await makeService(t, dataDir);
  assert.equal(service.rooms.roomOf(stale), null, 'untrusted client dropped from rooms.json');

  const c = await client(t, service.server.port);
  await c.connect();
  assert.equal(service.rooms.isAttached(c.clientId), false);
  assert.deepEqual(service.listRooms(), []);
  await service.server.approve(c.clientId);
  assert.equal(service.rooms.isAttached(c.clientId), true);
  assert.equal(service.listRooms().length, 1);
  await service.server.revoke(c.clientId);
  assert.equal(service.rooms.isAttached(c.clientId), false);
  assert.deepEqual(service.listRooms(), []);
  const act = await c.expect('server/activate', (p) => p.active_roles?.length === 0);
  assert.deepEqual(act.payload.activities, []);
});

async function paired(t, server, keyPair = generateStaticKeyPair()) {
  const c = await client(t, server.port, { keyPair });
  await c.connect();
  await server.pairWithToken(encodePskToken(c.clientId, c.pairingPsk));
  const conn = server.getClient(c.clientId);
  await c.until(() => conn.pskCategory === 'lt' && !conn.rehandshaking && conn.activities.length === 0 && server.isTrusted(c.clientId));
  return { c, conn };
}

// Holds the client's answer to its nth re-handshake until release() is called.
function holdRehandshake(c, nth) {
  const orig = c.ws.send.bind(c.ws);
  const held = [];
  c.ws.send = (...args) => (c.rehandshakes === nth && !held.released ? held.push(args) : orig(...args));
  return {
    reached: () => c.until(() => held.length > 0),
    release() {
      held.released = true;
      c.ws.send = orig;
      for (const args of held.splice(0)) orig(...args);
    },
  };
}

test('unpair idles the lt session and closes it even if the device ignores server/unpair', async (t) => {
  const done = processGuard(t);
  const server = await makeServer(t);
  const { c, conn } = await paired(t, server);
  c.send('client/state', { available: true, player: PLAYER_STATE });
  await c.until(() => conn.playerStateReceived);
  assert.equal(server.setPlayback(c.clientId, true), true);
  await c.expect('server/activate', (p) => p.activities.includes('playback'));
  c.matched = 'ignores-unpair';
  assert.equal(await server.unpair(c.clientId), true);
  assert.equal(server.canPlay(c.clientId), false);
  assert.deepEqual(conn.activities, []);
  assert.deepEqual(conn.activeRoles, []);
  assert.equal(server.setPlayback(c.clientId, true), false);
  await c.expect('server/activate', (p) => p.activities.length === 0 && p.active_roles?.length === 0);
  await c.expect('server/unpair');
  assert.equal(c.records.size, 1, 'the device ignored server/unpair');
  await conn.closed;
  await c.closed;
  await done();
});

test('unpair during the final lt re-handshake is sent once it completes', async (t) => {
  const done = processGuard(t);
  const server = await makeServer(t);
  const c = await client(t, server.port);
  await c.connect();
  const hold = holdRehandshake(c, 2);
  await server.pairWithToken(encodePskToken(c.clientId, c.pairingPsk));
  await hold.reached();
  const conn = server.getClient(c.clientId);
  assert.ok(conn.rehandshaking);
  assert.equal(await server.unpair(c.clientId), true);
  assert.equal(c.inbox.some((m) => m.type === 'server/unpair'), false);
  hold.release();
  await c.expect('server/unpair');
  await c.closed;
  assert.equal(c.records.size, 0);
  assert.equal(server.isTrusted(c.clientId), false);
  await done();
});

test('revoke during a re-handshake succeeds and is applied when it ends', async (t) => {
  const done = processGuard(t);
  const server = await makeServer(t);
  const kp = generateStaticKeyPair();
  await server.approve(encodeKeyId(kp.publicKey));
  const c = await client(t, server.port, { keyPair: kp });
  const act = await c.connect();
  assert.ok(act.payload.active_roles.length > 0);
  const conn = server.getClient(c.clientId);
  const hold = holdRehandshake(c, 1);
  await server.pairWithToken(encodePskToken(c.clientId, c.pairingPsk));
  await hold.reached();
  assert.ok(conn.rehandshaking);
  await server.revoke(c.clientId);
  server.cancelPairing(c.clientId);
  hold.release();
  await c.until(() => !conn.rehandshaking && !conn.activities.includes('pairing') && server.getPairingStatus(c.clientId)?.status === 'aborted');
  await c.until(() => conn.activeRoles.length === 0);
  assert.deepEqual(conn.activities, []);
  assert.equal(server.isTrusted(c.clientId), false);
  assert.ok(conn.isOpen);
  await done();
});
