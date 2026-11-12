import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  NoiseResponder, SUITES, generateStaticKeyPair, MSG2_PAYLOAD, packHandshake, unpackHandshake, parseMsg1Payload,
} from '../src/sendspin/noise.js';
import { encodeKeyId, decodeKeyId, SENTINEL_PSK, SENTINEL_PSK_ID, generatePsk, pskId } from '../src/sendspin/keys.js';
import { MSG, Reassembler, fragment, frame, decodeJson, decodeAudioChunk } from '../src/sendspin/wire.js';
import {
  negotiateRoles, unimplementedRoles, parseClientHello, parsePlayerState, nowUs, SendspinError,
} from '../src/sendspin/connection.js';
import { SendspinServer, reconnectDecision } from '../src/sendspin/server.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const LOCAL = '127.0.0.1';
const FORMATS = [{ codec: 'pcm', sample_rate: 48000, channels: 2, bit_depth: 16 }, { codec: 'flac', sample_rate: 44100, channels: 2, bit_depth: 16 }];

function helloPayload(over = {}) {
  return {
    name: 'Test Speaker',
    supported_roles: ['player@v1', 'controller@v1', 'visualizer@v1', 'player@v9', '_vendor@v1'],
    'player@v1_support': { supported_formats: FORMATS, buffer_capacity: 1_000_000 },
    device_info: { product_name: 'Fake', manufacturer: 'Velvet tests' },
    supported_pair_methods: { pairing_psk: {} },
    unpaired_access: { enabled: true },
    ...over,
  };
}

function waitFor(emitter, event, pred = () => true, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { emitter.off(event, on); reject(new Error(`timeout waiting for ${event}`)); }, ms);
    function on(...args) {
      if (!pred(...args)) return;
      clearTimeout(t);
      emitter.off(event, on);
      resolve(args.length > 1 ? args : args[0]);
    }
    emitter.on(event, on);
  });
}

class FakeClient {
  constructor(ws, { suite = SUITES[0], keyPair = generateStaticKeyPair(), psk = SENTINEL_PSK } = {}) {
    this.ws = ws;
    this.suite = suite;
    this.keyPair = keyPair;
    this.clientId = encodeKeyId(keyPair.publicKey);
    this.psk = psk;
    this.inbox = [];
    this.binary = [];
    this.waiters = [];
    this.reassembler = new Reassembler();
    this.closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
    this.texts = [];
    ws.on('message', (data, isBinary) => this.#onMessage(Buffer.from(data), isBinary));
  }

  #onMessage(buf, isBinary) {
    if (!isBinary) {
      this.texts.push(buf);
      this.#wake();
      return;
    }
    if (this.rehandshake) {
      const pt = this.rx.decrypt(buf);
      const m = decodeJson(pt.subarray(1));
      if (m.type === 'noise/handshake') return this.rehandshake(m);
      this.inbox.push(m);
      this.#wake();
      return;
    }
    const msg = this.reassembler.push(this.rx.decrypt(buf));
    if (!msg) return;
    if (msg.type === MSG.JSON) this.inbox.push({ ...decodeJson(msg.payload), at: nowUs() });
    else this.binary.push({ type: msg.type, payload: msg.payload, at: nowUs() });
    this.#wake();
  }

  #wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  async until(pred, ms = 3000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = pred();
      if (v) return v;
      if (Date.now() > deadline) throw new Error('FakeClient: timed out');
      await Promise.race([new Promise((r) => this.waiters.push(r)), new Promise((r) => setTimeout(r, 50))]);
    }
  }

  async nextText() {
    await this.until(() => this.texts.length);
    return this.texts.shift();
  }

  expect(type) {
    return this.until(() => {
      const i = this.inbox.findIndex((m) => m.type === type);
      return i >= 0 ? this.inbox.splice(i, 1)[0] : null;
    });
  }

  sendInit(over = {}) {
    this.initText = Buffer.from(JSON.stringify({ payload: { client_id: this.clientId, suite: this.suite, version: 1, ...over }, type: 'client/init' }));
    this.ws.send(this.initText, { binary: false });
  }

  async handshake({ psk = this.psk } = {}) {
    this.sendInit();
    const serverInit = await this.nextText();
    const init = JSON.parse(serverInit);
    assert.equal(init.type, 'server/init');
    this.serverId = init.payload.server_id;
    const hs1 = await this.nextText();
    this.responder = new NoiseResponder({
      suite: this.suite, staticKeyPair: this.keyPair, remoteStaticPublicKey: decodeKeyId(this.serverId),
      prologue: Buffer.concat([this.initText, serverInit]),
    });
    this.msg1 = parseMsg1Payload(this.responder.readMessage1(unpackHandshake(hs1.toString())));
    this.ws.send(packHandshake(this.responder.writeMessage2(MSG2_PAYLOAD, psk)), { binary: false });
    const { send, recv } = this.responder.split();
    this.tx = send;
    this.rx = recv;
  }

  sendPlain(plaintext) {
    for (const part of fragment(plaintext)) this.ws.send(this.tx.encrypt(part), { binary: true });
  }

  send(type, payload) {
    this.sendPlain(frame(MSG.JSON, Buffer.from(JSON.stringify({ type, payload }))));
  }

  async connect(hello = helloPayload()) {
    await this.handshake();
    const sh = await this.expect('server/hello');
    this.send('client/hello', hello);
    this.activate = await this.expect('server/activate');
    return sh;
  }
}

async function makeServer(t, opts = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-test-'));
  const server = new SendspinServer({ dataDir, host: LOCAL, port: 0, logger: quiet, name: 'Velvet Test', languages: ['nl', 'en'], ...opts });
  await server.start();
  server.testDir = dataDir;
  t.after(async () => {
    await server.stop();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  return server;
}

function dialServer(server) {
  const ws = new WebSocket(`ws://${LOCAL}:${server.port}/sendspin`);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function connectedClient(t, server, opts = {}) {
  const client = new FakeClient(await dialServer(server), opts);
  t.after(() => client.ws.terminate());
  return client;
}

async function approvedClient(t, server, hello) {
  const keyPair = generateStaticKeyPair();
  await server.approve(encodeKeyId(keyPair.publicKey), 'pre-approved');
  const c = await connectedClient(t, server, { keyPair });
  await c.connect(hello);
  return c;
}

const PLAYER_STATE = { output_delay_ms: 20, min_buffer_ms: 150, required_lead_time_ms: 300, supported_commands: ['volume', 'mute', 'bogus'], volume: 40, muted: false };

for (const suite of SUITES) {
  test(`client-initiated handshake, hello and activation (${suite})`, async (t) => {
    const server = await makeServer(t);
    const client = await connectedClient(t, server, { suite });
    const sh = await client.connect();
    assert.equal(client.serverId, server.serverId);
    assert.equal(client.msg1.pskId, SENTINEL_PSK_ID);
    assert.equal(client.msg1.pskCategory, 'sn');
    assert.deepEqual(sh.payload, { name: 'Velvet Test', languages: ['nl', 'en'] });
    assert.deepEqual(client.activate.payload, { activities: [], active_roles: [] });
    const conn = server.getClient(client.clientId);
    assert.equal(conn.suite, suite);
    assert.deepEqual(conn.negotiatedRoles, ['player@v1', 'controller@v1']);
    assert.deepEqual(conn.unimplementedRoles, ['player@v9']);
    assert.equal(conn.info.unpairedAccess, true);
    assert.equal(conn.info.deviceInfo.manufacturer, 'Velvet tests');
  });
}

test('init failures answer server/error and close', async (t) => {
  const server = await makeServer(t);
  const cases = [
    [{ version: 2 }, 'unsupported_version'],
    [{ version: 2, suite: 42 }, 'unsupported_version'],
    [{ suite: 'Noise_NN' }, 'unsupported_suite'],
    [{ client_id: 'short' }, 'malformed'],
    [{ version: '1' }, 'malformed'],
  ];
  for (const [over, reason] of cases) {
    const c = await connectedClient(t, server);
    c.sendInit(over);
    const err = JSON.parse(await c.nextText());
    assert.deepEqual(err, { payload: { reason }, type: 'server/error' }, JSON.stringify(over));
    await c.closed;
  }
  for (const raw of ['not json', '{"type":"client/hello","payload":{}}', '[]']) {
    const c = await connectedClient(t, server);
    c.ws.send(raw, { binary: false });
    assert.equal(JSON.parse(await c.nextText()).payload.reason, 'malformed');
    await c.closed;
  }
  const c = await connectedClient(t, server);
  c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
  assert.equal(JSON.parse(await c.nextText()).payload.reason, 'malformed');
  await c.closed;
});

test('prologue binds the raw client/init bytes', async (t) => {
  const server = await makeServer(t);
  const c = await connectedClient(t, server);
  c.initText = Buffer.from(`{ "type":"client/init", "payload":{"version":1,"suite":"${SUITES[1]}","client_id":"${c.clientId}"} }`);
  c.suite = SUITES[1];
  c.sendInit = () => c.ws.send(c.initText, { binary: false });
  await c.connect();
  assert.ok(server.getClient(c.clientId));
});

test('a wrong PSK fails the handshake silently', async (t) => {
  const server = await makeServer(t);
  const c = await connectedClient(t, server);
  await c.handshake({ psk: generatePsk() });
  assert.equal(await c.closed, 1002);
  assert.equal(c.inbox.length, 0);
});

test('long-term PSK from the trust store; Sentinel fallback marks a credential mismatch', async (t) => {
  const server = await makeServer(t);
  const psk = generatePsk();
  const pairedKey = generateStaticKeyPair();
  const lostKey = generateStaticKeyPair();
  for (const kp of [pairedKey, lostKey]) {
    await server.trustStore.storePairing({ clientId: encodeKeyId(kp.publicKey), psk, method: 'pairing_psk' });
  }
  await server.trustStore.markCredentialMismatch(encodeKeyId(pairedKey.publicKey));
  const paired = await connectedClient(t, server, { psk, keyPair: pairedKey });
  await paired.connect(helloPayload({ unpaired_access: { enabled: false } }));
  assert.equal(paired.msg1.pskId, pskId(psk));
  assert.equal(paired.msg1.pskCategory, 'lt');
  assert.deepEqual(paired.activate.payload.active_roles, ['player@v1']);
  const pconn = server.getClient(paired.clientId);
  assert.throws(() => pconn.activate({ activities: ['pairing'], pairing: { method: 'pairing_psk' } }), SendspinError, 'no pairing under lt');
  await server.trustStore.flush();
  assert.equal(server.trustStore.hasCredentialMismatch(paired.clientId), false, 'a successful lt handshake clears the mismatch');

  const lost = await connectedClient(t, server, { keyPair: lostKey });
  const ev = waitFor(server, 'credential-mismatch');
  await lost.connect(helloPayload({ supported_pair_methods: { static_pairing_code: {} } }));
  const conn = await ev;
  assert.equal(conn.credentialMismatch, true);
  assert.equal(conn.pskCategory, 'sn');
  assert.deepEqual(lost.activate.payload, { activities: [], active_roles: [] });
  assert.throws(() => conn.activate({ activities: ['playback'] }), SendspinError);
  assert.equal(server.setPlayback(lost.clientId, true), false);
  await server.trustStore.flush();
  assert.equal(server.trustStore.hasCredentialMismatch(lost.clientId), true);
  assert.equal(server.trustStore.isPaired(lost.clientId), true, 'the signal never deletes the record');
  conn.activate({ activities: ['pairing'], pairing: { method: 'static_pairing_code' } });
  assert.deepEqual((await lost.expect('server/activate')).payload, { activities: ['pairing'], pairing: { method: 'static_pairing_code' } });
});

test('pairing activation is validated against the session and the offered methods', async (t) => {
  const server = await makeServer(t);
  const c = await connectedClient(t, server);
  await c.connect(helloPayload({ supported_pair_methods: { pairing_psk: {}, dynamic_pairing_code: { formats: ['digits'] } } }));
  const conn = server.getClient(c.clientId);
  assert.throws(() => conn.activate({ activities: ['pairing'] }), SendspinError, 'pairing object required');
  assert.throws(() => conn.activate({ activities: [], pairing: { method: 'pairing_psk' } }), SendspinError);
  assert.throws(() => conn.activate({ activities: ['pairing'], pairing: { method: 'static_pairing_code' } }), SendspinError, 'not offered');
  assert.throws(() => conn.activate({ activities: ['pairing'], pairing: { method: 'pairing_psk' } }), SendspinError, 'pairing_psk needs the pairing PSK');
  assert.throws(() => conn.activate({ activities: ['pairing'], pairing: { method: 'dynamic_pairing_code' } }), SendspinError, 'format required');
  conn.activate({ activities: ['pairing'], pairing: { method: 'dynamic_pairing_code', format: 'digits' } });
  assert.deepEqual((await c.expect('server/activate')).payload, { activities: ['pairing'], pairing: { method: 'dynamic_pairing_code', format: 'digits' } });
});

test('tampered transport frame closes the connection', async (t) => {
  const server = await makeServer(t);
  const c = await connectedClient(t, server);
  await c.connect();
  const ct = c.tx.encrypt(frame(MSG.JSON, Buffer.from(JSON.stringify({ type: 'client/time', payload: { client_transmitted: 1 } }))));
  ct[ct.length - 1] ^= 1;
  c.ws.send(ct, { binary: true });
  assert.equal(await c.closed, 1002);
});

test('cleartext after transport mode closes; replayed frame closes', async (t) => {
  const server = await makeServer(t);
  const a = await connectedClient(t, server);
  await a.connect();
  a.ws.send('{"type":"client/time","payload":{}}', { binary: false });
  assert.equal(await a.closed, 1002);
  const b = await connectedClient(t, server);
  await b.connect();
  const ct = b.tx.encrypt(frame(MSG.JSON, Buffer.from(JSON.stringify({ type: 'client/leave', payload: {} }))));
  b.ws.send(ct, { binary: true });
  b.ws.send(ct, { binary: true });
  assert.equal(await b.closed, 1002);
});

test('approval gates roles; approve activates, playback toggles activities', async (t) => {
  const server = await makeServer(t);
  const c = await connectedClient(t, server);
  await c.connect();
  assert.deepEqual(c.activate.payload.active_roles, []);
  assert.equal(server.setPlayback(c.clientId, true), false);
  await server.approve(c.clientId);
  const act = await c.expect('server/activate');
  assert.deepEqual(act.payload, { activities: [], active_roles: ['player@v1'] });
  assert.ok(server.approvals.some((a) => a.clientId === c.clientId && a.name === 'Test Speaker'));
  await server.trustStore.flush();
  const saved = await fsp.readFile(path.join(server.testDir, 'trust-store.json'), 'utf8');
  assert.ok(saved.includes(c.clientId));
  assert.equal(server.setPlayback(c.clientId, true), true);
  assert.deepEqual((await c.expect('server/activate')).payload, { activities: ['playback'] });
  await server.revoke(c.clientId);
  assert.deepEqual((await c.expect('server/activate')).payload, { activities: [], active_roles: [] });
});

test('a client without unpaired access is never given roles', async (t) => {
  const server = await makeServer(t);
  const keyPair = generateStaticKeyPair();
  await server.approve(encodeKeyId(keyPair.publicKey));
  const c = await connectedClient(t, server, { keyPair });
  await c.connect(helloPayload({ unpaired_access: { enabled: false } }));
  assert.deepEqual(c.activate.payload.active_roles, []);
});

test('time exchange echoes and stamps monotonically', async (t) => {
  const server = await makeServer(t);
  const c = await approvedClient(t, server);
  let prev = 0;
  for (let i = 0; i < 8; i++) {
    const sent = Number(nowUs());
    c.send('client/time', { client_transmitted: 1000 + i });
    const r = (await c.expect('server/time')).payload;
    assert.equal(r.client_transmitted, 1000 + i);
    assert.ok(Number.isSafeInteger(r.server_received) && Number.isSafeInteger(r.server_transmitted));
    assert.ok(r.server_received >= sent, 'receive stamp after send');
    assert.ok(r.server_transmitted >= r.server_received);
    assert.ok(r.server_received >= prev);
    prev = r.server_transmitted;
  }
});

test('client/state tracking, validation and server commands', async (t) => {
  const server = await makeServer(t);
  const c = await approvedClient(t, server);
  const conn = server.getClient(c.clientId);
  assert.throws(() => conn.serverCommand({ player: { command: 'volume', volume: 10 } }), SendspinError);
  const states = waitFor(server, 'state');
  c.send('client/state', { available: true, player: { ...PLAYER_STATE, format: FORMATS[1] }, artwork: { ignored: true } });
  const [, state] = await states;
  assert.equal(state.available, true);
  assert.deepEqual(state.player, {
    outputDelayMs: 20, minBufferMs: 150, requiredLeadTimeMs: 300, supportedCommands: ['volume', 'mute'], volume: 40, muted: false, format: FORMATS[1],
  });
  assert.equal(state.roles.artwork, undefined);
  c.send('client/state', { available: false });
  await waitFor(server, 'state', (_c, s) => s.available === false);
  assert.equal(conn.state.player.volume, 40, 'omitted role object keeps its state');
  conn.serverCommand({ player: { command: 'volume', volume: 10 } });
  assert.deepEqual((await c.expect('server/command')).payload, { player: { command: 'volume', volume: 10 } });
  assert.throws(() => conn.serverCommand({ player: { command: 'set_output_delay', output_delay_ms: 5 } }), SendspinError);
  c.send('client/state', { available: true, player: { ...PLAYER_STATE, volume: 101 } });
  assert.equal(await c.closed, 1002);
});

test('unknown messages, binary IDs and fields are ignored', async (t) => {
  const server = await makeServer(t);
  const c = await approvedClient(t, server);
  c.send('client/future_thing', { x: 1 });
  c.sendPlain(Buffer.from([200, 1, 2, 3]));
  c.sendPlain(Buffer.from([MSG.SOURCE_AUDIO, 0, 0, 0, 0, 0, 0, 0, 0]));
  c.send('client/time', { client_transmitted: 5, extra: { deep: true } });
  assert.equal((await c.expect('server/time')).payload.client_transmitted, 5);
  assert.ok(server.getClient(c.clientId).isOpen);
});

test('fragmented JSON is reassembled in both directions', async (t) => {
  const server = await makeServer(t);
  const big = 'x'.repeat(150_000);
  const c = await approvedClient(t, server);
  const conn = server.getClient(c.clientId);
  const got = waitFor(server, 'message');
  c.send('client/x_big', { big });
  const [, type, payload] = await got;
  assert.equal(type, 'client/x_big');
  assert.equal(payload.big.length, big.length);
  conn.serverState({ _velvet: { big } });
  const st = await c.expect('server/state');
  assert.equal(st.payload._velvet.big, big);
});

test('oversized client/hello closes', async (t) => {
  const server = await makeServer(t);
  const c = await connectedClient(t, server);
  await c.handshake();
  await c.expect('server/hello');
  c.send('client/hello', helloPayload({ padding: 'p'.repeat(17000) }));
  assert.equal(await c.closed, 1002);
});

test('player stream: stream/start, audio chunk with send_ahead stamped at send, clear, end', async (t) => {
  const server = await makeServer(t);
  const c = await approvedClient(t, server);
  const conn = server.getClient(c.clientId);
  c.send('client/state', { available: true, player: PLAYER_STATE });
  await waitFor(server, 'state');
  assert.throws(() => conn.streamStart({ player: FORMATS[0] }), SendspinError, 'no playback activity yet');
  server.setPlayback(c.clientId, true);
  await c.expect('server/activate');
  assert.throws(() => conn.streamStart({ player: { ...FORMATS[0], sample_rate: 96000 } }), SendspinError);
  assert.throws(() => conn.sendAudioChunk(nowUs(), Buffer.alloc(4)), SendspinError);
  const before = Number(nowUs());
  conn.streamStart({ player: FORMATS[0] });
  const ss = await c.expect('stream/start');
  assert.deepEqual(ss.payload.player, FORMATS[0]);
  assert.ok(ss.payload.server_transmitted >= before);
  const ts = nowUs() + 500_000n;
  const pcm = Buffer.alloc(48 * 4 * 25, 7);
  const sentAt = nowUs();
  const n = conn.sendAudioChunk(ts, pcm);
  assert.equal(n, 13 + pcm.length);
  await c.until(() => c.binary.length);
  const chunk = decodeAudioChunk(Buffer.concat([Buffer.from([c.binary[0].type]), c.binary[0].payload]));
  assert.equal(chunk.timestampUs, ts);
  assert.deepEqual(chunk.frame, pcm);
  const expected = Number(ts - sentAt);
  assert.ok(chunk.sendAheadUs <= expected && chunk.sendAheadUs > expected - 50_000, `send_ahead ${chunk.sendAheadUs} vs ${expected}`);
  conn.sendAudioChunk(nowUs() - 10_000n, pcm);
  await c.until(() => c.binary.length === 2);
  assert.equal(c.binary[1].payload.readUInt32BE(8), 0, 'late chunk saturates to 0');
  const huge = Buffer.alloc(100_000, 1);
  conn.sendAudioChunk(nowUs() + 1_000_000n, huge);
  await c.until(() => c.binary.length === 3);
  assert.equal(c.binary[2].payload.length, 12 + huge.length, 'fragmented audio chunk reassembled');
  conn.streamClear();
  assert.deepEqual(Object.keys((await c.expect('stream/clear')).payload), ['server_transmitted']);
  conn.streamClear({ roles: ['player'], fromTimestamp: 123 });
  assert.equal((await c.expect('stream/clear')).payload.from_timestamp, 123);
  server.setPlayback(c.clientId, false);
  assert.deepEqual((await c.expect('stream/end')).payload, { roles: ['player'] });
  assert.deepEqual((await c.expect('server/activate')).payload, { activities: [] });
  assert.deepEqual(conn.activeStreams, []);
  assert.throws(() => conn.streamEnd(), SendspinError);
});

test('goodbye closes the connection and is reported', async (t) => {
  const server = await makeServer(t);
  const c = await approvedClient(t, server);
  const bye = waitFor(server, 'goodbye');
  const removed = waitFor(server, 'client-removed');
  c.send('client/goodbye', { reason: 'user_request' });
  const [, reason] = await bye;
  assert.equal(reason, 'user_request');
  const [, info] = await removed;
  assert.equal(info.goodbye, 'user_request');
  await c.closed;
  assert.equal(server.getClient(c.clientId), null);
});

test('goodbye before client/hello is honoured', async (t) => {
  const server = await makeServer(t);
  const c = await connectedClient(t, server);
  await c.handshake();
  await c.expect('server/hello');
  const bye = waitFor(server, 'goodbye');
  c.send('client/goodbye', { reason: 'pairing_required' });
  assert.equal((await bye)[1], 'pairing_required');
  assert.equal(await c.closed, 1000);
});

test('a second connection for the same client replaces the first', async (t) => {
  const server = await makeServer(t);
  const keyPair = generateStaticKeyPair();
  const a = await connectedClient(t, server, { keyPair });
  await a.connect();
  const b = await connectedClient(t, server, { keyPair });
  await b.connect();
  await a.closed;
  assert.equal(server.getClient(b.clientId).isOpen, true);
  assert.equal(server.clients.size, 1);
});

test('handshake timeout closes an idle socket', async (t) => {
  const server = await makeServer(t, { timeouts: { handshakeMs: 150 } });
  const c = await connectedClient(t, server);
  assert.equal(await c.closed, 1002);
});

test('re-handshake swaps keys and re-activates', async (t) => {
  const server = await makeServer(t);
  const c = await approvedClient(t, server);
  const conn = server.getClient(c.clientId);
  const newPsk = generatePsk();
  c.rehandshake = (m) => {
    const r = new NoiseResponder({ suite: c.suite, staticKeyPair: c.keyPair, remoteStaticPublicKey: decodeKeyId(c.serverId), prologue: c.responder.handshakeHash });
    const p = parseMsg1Payload(r.readMessage1(Buffer.from(m.payload.data, 'base64url')));
    assert.equal(p.pskId, pskId(newPsk));
    const m2 = r.writeMessage2(MSG2_PAYLOAD, newPsk);
    c.send('client/time', { client_transmitted: 1 });
    c.send('noise/handshake', { data: m2.toString('base64url') });
    const { send, recv } = r.split();
    c.tx = send;
    c.rx = recv;
    c.responder = r;
    c.rehandshake = null;
  };
  const done = conn.rehandshake({ psk: newPsk, category: 'lt' });
  assert.equal(conn.sendJson('server/state', {}), false, 'no app messages during a re-handshake');
  await done;
  const act = await c.expect('server/activate');
  assert.deepEqual(act.payload, { activities: [] });
  assert.equal(conn.pskCategory, 'lt');
  c.send('client/time', { client_transmitted: 77 });
  assert.equal((await c.expect('server/time')).payload.client_transmitted, 77);
  assert.equal(c.inbox.some((m) => m.type === 'server/time' && m.payload.client_transmitted === 1), false);
});

test('server-initiated connection and reconnect policy', async (t) => {
  const server = await makeServer(t, { reconnect: { minMs: 50, maxMs: 200 } });
  const wss = new WebSocketServer({ host: LOCAL, port: 0, path: '/sendspin' });
  await new Promise((r) => wss.once('listening', r));
  t.after(() => new Promise((r) => {
    for (const ws of wss.clients) ws.terminate();
    wss.close(r);
  }));
  const keyPair = generateStaticKeyPair();
  const origins = [];
  const clients = [];
  wss.on('connection', (ws, req) => {
    origins.push(req.headers.origin);
    clients.push(new FakeClient(ws, { keyPair, suite: SUITES[1] }));
  });
  const url = `ws://${LOCAL}:${wss.address().port}/sendspin`;
  assert.throws(() => server.connectTo('http://example.com/x'));
  assert.throws(() => server.connectTo(`ws://user:pw@${LOCAL}:1/sendspin`));
  assert.throws(() => server.connectTo(`wss://${LOCAL}:1/sendspin`));
  server.connectTo(url);
  await waitFor({ on: (e, f) => wss.on(e, f), off: (e, f) => wss.off(e, f) }, 'connection');
  const first = clients[0];
  await first.connect();
  assert.equal(server.getClient(first.clientId).direction, 'outbound');
  assert.equal(origins[0], undefined, 'no Origin header on dial');
  first.ws.terminate();
  await first.until(() => clients.length === 2, 3000);
  const second = clients[1];
  await second.connect();
  second.send('client/goodbye', { reason: 'another_server' });
  await second.closed;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(clients.length, 2, 'no redial after another_server');
});

test('reconnect decisions follow the goodbye reason', () => {
  assert.equal(reconnectDecision({ goodbye: 'restart', handshakeCompleted: true }), 'now');
  assert.equal(reconnectDecision({ goodbye: 'concurrent_attempt', handshakeCompleted: true }), 'later');
  for (const r of ['another_server', 'user_request', 'shutdown', 'unpaired', 'pairing_required', 'unauthorized']) {
    assert.equal(reconnectDecision({ goodbye: r, handshakeCompleted: true }), 'never', r);
  }
  assert.equal(reconnectDecision({ goodbye: null, handshakeCompleted: true, activities: [] }), 'now');
  assert.equal(reconnectDecision({ goodbye: null, handshakeCompleted: true, activities: ['playback'] }), 'now');
  assert.equal(reconnectDecision({ goodbye: null, handshakeCompleted: true, activities: ['pairing'] }), 'never');
  assert.equal(reconnectDecision({ goodbye: null, handshakeCompleted: false }), 'backoff');
});

test('role negotiation picks the first implemented version per family', () => {
  const hello = { 'player@v1_support': {} };
  assert.deepEqual(negotiateRoles(['metadata@v1', 'player@v2', 'player@v1', 'controller@v1', 'controller@v2'], hello), ['player@v1', 'controller@v1', 'metadata@v1']);
  assert.deepEqual(negotiateRoles(['player@v1', 'artwork@v1'], {}), ['artwork@v1'], 'player without support object is not activated');
  assert.deepEqual(unimplementedRoles(['player@v2', '_x@v1', 'player@_exp', 'plain', 'color@v1']), ['player@v2']);
});

test('client/hello and player state parsing', () => {
  assert.throws(() => parseClientHello(helloPayload({ name: 'é'.repeat(33) })));
  assert.throws(() => parseClientHello(helloPayload({ supported_roles: 'player@v1' })));
  assert.throws(() => parseClientHello(helloPayload({ unpaired_access: { enabled: 'yes' } })));
  const info = parseClientHello(helloPayload({ 'player@v1_support': { supported_formats: [...FORMATS, { codec: 'mp3' }], buffer_capacity: 5 } }));
  assert.equal(info.player.supportedFormats.length, 2);
  assert.throws(() => parsePlayerState({ ...PLAYER_STATE, output_delay_ms: 5001 }, info.player));
  assert.throws(() => parsePlayerState({ ...PLAYER_STATE, volume: undefined }, info.player), 'volume required with the volume command');
  assert.equal(parsePlayerState({ ...PLAYER_STATE, format: { codec: 'pcm', sample_rate: 8000, channels: 1, bit_depth: 8 } }, info.player).format, null);
});
