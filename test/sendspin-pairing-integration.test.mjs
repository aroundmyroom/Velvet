import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeKeyId, generatePsk, SENTINEL_PSK_ID } from '../src/sendspin/keys.js';
import { generateStaticKeyPair } from '../src/sendspin/noise.js';
import { encodePskToken, PairingInputError } from '../src/sendspin/pairing.js';
import { nowUs } from '../src/sendspin/connection.js';
import { SendspinServer, KNOWN_DEVICES_FILE } from '../src/sendspin/server.js';
import { TestClient, helloPayload, PCM, PLAYER_STATE } from './helpers/sendspin-test-client.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function makeServer(t, opts = {}) {
  const dataDir = opts.dataDir ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-pair-it-'));
  const server = new SendspinServer({ dataDir, host: '127.0.0.1', port: 0, logger: quiet, cooldown: { initialMs: 50, maxMs: 200 }, ...opts });
  await server.start();
  server.testDir = dataDir;
  t.after(async () => {
    await server.stop();
    if (!opts.keepDir) await fsp.rm(dataDir, { recursive: true, force: true });
  });
  return server;
}

async function client(t, server, opts = {}) {
  const c = new TestClient(opts);
  await c.dial(`ws://127.0.0.1:${server.port}/sendspin`);
  t.after(() => c.close());
  return c;
}

function status(server, id, want, ms = 4000) {
  return new Promise((resolve, reject) => {
    const now = server.getPairingStatus(id);
    if (now?.status === want) return resolve(now);
    const timer = setTimeout(() => {
      server.off('pairing', on);
      reject(new Error(`timeout waiting for pairing status ${want} (last ${JSON.stringify(server.getPairingStatus(id))})`));
    }, ms);
    function on(cid, s) {
      if (cid !== id || s?.status !== want) return;
      clearTimeout(timer);
      server.off('pairing', on);
      resolve(s);
    }
    server.on('pairing', on);
  });
}

async function settle(c, server) {
  await c.expect('server/activate', (p) => !p.activities.includes('pairing'));
  const conn = server.getClient(c.clientId);
  await c.until(() => !conn.rehandshaking && conn.pskCategory === 'lt');
  return conn;
}

async function playing(t, server) {
  const keyPair = generateStaticKeyPair();
  await server.approve(encodeKeyId(keyPair.publicKey));
  const c = await client(t, server, { keyPair });
  await c.connect();
  c.send('client/state', { available: true, player: PLAYER_STATE });
  const conn = server.getClient(c.clientId);
  await c.until(() => conn.playerStateReceived);
  assert.equal(server.setPlayback(c.clientId, true), true);
  conn.streamStart({ player: PCM });
  await c.expect('stream/start');
  return { c, conn };
}

test('token pairing on a live, playing connection keeps the stream and ends paired under lt', async (t) => {
  const server = await makeServer(t);
  const { c, conn } = await playing(t, server);
  const events = [];
  server.on('paired', (id, info) => events.push(['paired', id, info.method]));
  const res = await server.pairWithToken(encodePskToken(c.clientId, c.pairingPsk).toLowerCase().replaceAll('2', '9'));
  assert.equal(res.result, 'pairing');
  assert.equal(res.status.method, 'pairing_psk');
  const act = await c.expect('server/activate', (p) => p.activities.includes('pairing'));
  assert.deepEqual(act.payload, { activities: ['playback', 'pairing'], pairing: { method: 'pairing_psk' }, active_roles: ['player@v1'] });
  assert.equal(c.matched, 'pr');
  await status(server, c.clientId, 'paired');
  const after = await settle(c, server);
  assert.equal(after, conn, 'same connection, no reconnect');
  assert.deepEqual(c.lastActivate, { activities: ['playback'], active_roles: ['player@v1'] });
  assert.equal(c.rehandshakes, 2, 'Sentinel -> pairing PSK -> long-term PSK');
  assert.equal(c.inbox.some((m) => m.type === 'stream/end'), false, 'the stream survives');
  assert.deepEqual(conn.activeStreams, ['player']);
  assert.equal(server.trustStore.trustState(c.clientId), 'paired');
  assert.equal(server.isApproved(c.clientId), false, 'approval is discarded on pairing');
  assert.ok(server.trustStore.record(c.clientId).psk.equals(c.records.get(server.serverId)));
  assert.deepEqual(events, [['paired', c.clientId, 'pairing_psk']]);
  conn.sendAudioChunk(nowUs() + 300_000n, Buffer.alloc(400, 3));
  await c.until(() => c.binary.length);
  assert.equal(c.binary[0].type, 4);
  c.send('client/time', { client_transmitted: 9 });
  assert.equal((await c.expect('server/time')).payload.client_transmitted, 9);
});

test('a staged token is used on the next connection; reconnecting afterwards is paired (lt)', async (t) => {
  const server = await makeServer(t);
  const c = new TestClient();
  const res = await server.pairWithToken(encodePskToken(c.clientId, c.pairingPsk));
  assert.deepEqual(res, { result: 'staged', clientId: c.clientId, status: null });
  assert.equal(server.trustStore.pskForClient(c.clientId).category, 'pr');
  await c.dial(`ws://127.0.0.1:${server.port}/sendspin`);
  t.after(() => c.close());
  const act = await c.connect(helloPayload({ unpaired_access: { enabled: false } }));
  assert.equal(c.msg1.pskCategory, 'pr');
  assert.deepEqual(act.payload, { activities: ['pairing'], pairing: { method: 'pairing_psk' }, active_roles: [] });
  await status(server, c.clientId, 'paired');
  await settle(c, server);
  assert.deepEqual(c.lastActivate, { activities: [], active_roles: ['player@v1'] });
  await server.trustStore.flush();
  assert.equal(server.trustStore.stagedPairingPsk(c.clientId), null, 'staged PSK consumed');
  c.close();
  await c.closed;
  await new Promise((r) => setTimeout(r, 50));
  const again = new TestClient({ keyPair: c.keyPair, pairingPsk: c.pairingPsk, records: c.records });
  await again.dial(`ws://127.0.0.1:${server.port}/sendspin`);
  t.after(() => again.close());
  const a2 = await again.connect(helloPayload({ unpaired_access: { enabled: false } }));
  assert.equal(again.msg1.pskCategory, 'lt');
  assert.equal(again.matched, 'lt');
  assert.deepEqual(a2.payload, { activities: [], active_roles: ['player@v1'] });
  assert.equal(server.getClient(c.clientId).isPaired, true);
  assert.equal(server.canPlay(c.clientId), true);
});

test('a staged token the device does not know is dropped (no reconnect loop)', async (t) => {
  const server = await makeServer(t);
  const c = await client(t, server);
  await server.pairWithToken(encodePskToken(c.clientId, generatePsk()));
  await c.connect();
  assert.equal(c.matched, 'sn');
  const s = await status(server, c.clientId, 'aborted');
  assert.equal(s.reason, 'token_rejected');
  await server.trustStore.flush();
  assert.equal(server.trustStore.stagedPairingPsk(c.clientId), null);
});

test('token input errors: wrong client, malformed, method not offered', async (t) => {
  const server = await makeServer(t);
  const c = await client(t, server);
  await c.connect(helloPayload({ supported_pair_methods: { static_pairing_code: {} } }));
  const other = encodeKeyId(generateStaticKeyPair().publicKey);
  await assert.rejects(server.pairWithToken(encodePskToken(c.clientId, c.pairingPsk), other), (e) => e instanceof PairingInputError && e.code === 'wrong_client');
  await assert.rejects(server.pairWithToken('SP:0ABC'), (e) => e.code === 'malformed_token');
  await assert.rejects(server.pairWithToken('SP:1AAAA'), (e) => e.code === 'unsupported_token_version');
  await assert.rejects(server.pairWithToken(encodePskToken(c.clientId, c.pairingPsk)), (e) => e.code === 'method_not_supported');
  assert.equal(server.getPairingStatus(c.clientId), null);
  assert.equal(server.trustStore.stagedPairingPsk(c.clientId), null);
});

test('dynamic code: wrong code, then the right one; reconnect is paired', async (t) => {
  const server = await makeServer(t);
  const c = await client(t, server);
  await c.connect();
  const st = server.startCodePairing(c.clientId);
  assert.equal(st.status, 'waiting');
  assert.equal(st.method, 'dynamic_pairing_code');
  assert.equal(st.format, 'digits');
  assert.equal(st.digits, 6);
  assert.ok(st.deadline > Date.now());
  assert.throws(() => server.startCodePairing(c.clientId), (e) => e.code === 'pairing_in_progress');
  const act = await c.expect('server/activate', (p) => p.activities.includes('pairing'));
  assert.deepEqual(act.payload.pairing, { method: 'dynamic_pairing_code', format: 'digits' });
  await status(server, c.clientId, 'need_code');
  const code = await c.until(() => c.pair?.code);
  assert.match(code, /^\d{6}$/);
  assert.throws(() => server.submitPairingCode(c.clientId, '12'), (e) => e.code === 'invalid_code');
  const wrong = code === '000000' ? '111111' : '000000';
  server.submitPairingCode(c.clientId, wrong);
  const w = await status(server, c.clientId, 'wrong_code');
  assert.equal(w.round, 2);
  assert.ok(w.retryAfterMs > 0);
  assert.throws(() => server.submitPairingCode(c.clientId, code), (e) => e.code === 'cooldown' && e.retryAfterMs > 0);
  await new Promise((r) => setTimeout(r, w.retryAfterMs + 10));
  server.submitPairingCode(c.clientId, `${code.slice(0, 3)}-${code.slice(3)}`);
  await status(server, c.clientId, 'paired');
  await settle(c, server);
  assert.equal(server.trustStore.record(c.clientId).pairMethods[0], 'dynamic_pairing_code');
  assert.equal(server.devices().find((d) => d.clientId === c.clientId).trust, 'paired');
});

test('static code with a pending gesture, cancel, cooldown across attempts', async (t) => {
  const server = await makeServer(t);
  const c = await client(t, server, { holdBack: 'Press the pairing button', staticCode: '24681357' });
  await c.connect(helloPayload({ supported_pair_methods: { pairing_psk: {}, static_pairing_code: {} } }));
  const st = server.startCodePairing(c.clientId);
  assert.equal(st.method, 'static_pairing_code');
  assert.equal(st.digits, 8);
  const p = await status(server, c.clientId, 'pending');
  assert.equal(p.message, 'Press the pairing button');
  assert.equal(server.devices()[0].connection, 'pairing');
  const cancelled = server.cancelPairing(c.clientId);
  assert.equal(cancelled.status, 'aborted');
  assert.equal(cancelled.reason, 'user_cancelled');
  assert.deepEqual((await c.expect('pair/abort')).payload, { reason: 'user_cancelled' });
  assert.deepEqual((await c.expect('server/activate', (x) => !x.activities.includes('pairing'))).payload, { activities: [], active_roles: [] });
  assert.equal(server.cancelPairing(c.clientId).status, 'aborted', 'idempotent once terminal');
  assert.equal(server.devices()[0].connection, 'online');

  c.holdBack = null;
  server.startCodePairing(c.clientId);
  await c.expect('server/activate', (x) => x.activities.includes('pairing'));
  server.submitPairingCode(c.clientId, '1111-2222');
  const ab = await status(server, c.clientId, 'aborted');
  assert.equal(ab.reason, 'pairing_code_mismatch');
  await c.expect('server/activate', (x) => !x.activities.includes('pairing'));

  server.startCodePairing(c.clientId);
  await c.expect('server/activate', (x) => x.activities.includes('pairing'));
  assert.throws(() => server.submitPairingCode(c.clientId, '2468-1357'), (e) => e.code === 'cooldown', 'cooldown kept per client across attempts');
  await new Promise((r) => setTimeout(r, server.getPairingStatus(c.clientId).retryAfterMs + 10));
  server.submitPairingCode(c.clientId, '2468 1357');
  await status(server, c.clientId, 'paired');
  await settle(c, server);
  assert.equal(server.canPlay(c.clientId), true);
});

test('code pairing on a paired (lt) connection re-handshakes to the Sentinel first; abort returns to lt', async (t) => {
  const server = await makeServer(t);
  const c = await client(t, server);
  await c.connect();
  await server.pairWithToken(encodePskToken(c.clientId, c.pairingPsk));
  await status(server, c.clientId, 'paired');
  const conn = await settle(c, server);
  c.rehandshakes = 0;
  c.inbox.length = 0;
  server.startCodePairing(c.clientId, { format: 'qr_code' });
  const act = await c.expect('server/activate', (p) => p.activities.includes('pairing'));
  assert.equal(c.matched, 'sn');
  assert.deepEqual(act.payload.pairing, { method: 'dynamic_pairing_code', format: 'qr_code' });
  assert.equal(server.getPairingStatus(c.clientId).digits, null);
  await status(server, c.clientId, 'need_code');
  server.cancelPairing(c.clientId);
  await c.until(() => conn.pskCategory === 'lt' && !conn.rehandshaking && c.lastActivate && !c.lastActivate.activities.includes('pairing'));
  assert.equal(c.rehandshakes, 2);
  assert.equal(c.matched, 'lt');
  assert.deepEqual(c.lastActivate, { activities: [], active_roles: ['player@v1'] });
});

test('a client abort of a held-back attempt leaves pairing without a pair/abort from us', async (t) => {
  const server = await makeServer(t);
  const c = await client(t, server, { holdBack: '' });
  await c.connect();
  server.startCodePairing(c.clientId);
  await status(server, c.clientId, 'pending');
  const entryDeadline = server.getPairingStatus(c.clientId).deadline;
  assert.ok(entryDeadline > Date.now() + 300_000, 'gesture timeout');
  c.inbox.length = 0;
  c.send('pair/abort', { reason: 'attempt_timeout' });
  const s = await status(server, c.clientId, 'aborted');
  assert.equal(s.reason, 'attempt_timeout');
  await c.expect('server/activate', (x) => !x.activities.includes('pairing'));
  assert.equal(c.inbox.some((m) => m.type === 'pair/abort'), false);
});

test('a pairing protocol error closes the connection silently', async (t) => {
  const server = await makeServer(t);
  const c = await client(t, server, { holdBack: 'wait' });
  await c.connect();
  server.startCodePairing(c.clientId);
  await status(server, c.clientId, 'pending');
  c.send('client/pair-confirm', { client_kc: 'x' });
  assert.equal(await c.closed, 1002);
  assert.equal(server.getPairingStatus(c.clientId).reason, 'protocol_error');
});

test('pairing messages without an attempt are dropped', async (t) => {
  const server = await makeServer(t);
  const c = await client(t, server);
  await c.connect();
  c.send('client/pair-init', { pairing_index: 1 });
  c.send('client/time', { client_transmitted: 1 });
  await c.expect('server/time');
  assert.equal(server.getPairingStatus(c.clientId), null);
  assert.ok(server.getClient(c.clientId).isOpen);
});

test('unpair sends server/unpair; the device returns to unknown', async (t) => {
  const server = await makeServer(t);
  const c = await client(t, server);
  await c.connect();
  await server.pairWithToken(encodePskToken(c.clientId, c.pairingPsk));
  await status(server, c.clientId, 'paired');
  await settle(c, server);
  const ev = new Promise((r) => server.once('unpaired', r));
  assert.equal(await server.unpair(c.clientId), true);
  assert.equal(await ev, c.clientId);
  await c.expect('server/unpair');
  await c.closed;
  assert.equal(c.records.size, 0);
  assert.equal(server.trustStore.trustState(c.clientId), 'unknown');
  await c.until(() => !server.getClient(c.clientId));
  const d = server.devices().find((x) => x.clientId === c.clientId);
  assert.equal(d.trust, 'unknown');
  assert.equal(d.connection, 'offline');
});

test('credential mismatch: no playback, surfaced, re-pair fixes it', async (t) => {
  const server = await makeServer(t);
  const c = await client(t, server);
  await c.connect();
  await server.pairWithToken(encodePskToken(c.clientId, c.pairingPsk));
  await status(server, c.clientId, 'paired');
  await settle(c, server);
  c.close();
  await c.closed;

  const reset = await client(t, server, { keyPair: c.keyPair, pairingPsk: c.pairingPsk });
  const mismatch = new Promise((r) => server.once('credential-mismatch', r));
  const act = await reset.connect();
  assert.equal(reset.msg1.pskCategory, 'lt');
  assert.equal(reset.matched, 'sn', 'Sentinel fallback');
  assert.deepEqual(act.payload, { activities: [], active_roles: [] });
  const conn = await mismatch;
  await server.trustStore.flush();
  assert.equal(server.trustStore.trustState(c.clientId), 'mismatch');
  assert.equal(server.devices().find((d) => d.clientId === c.clientId).trust, 'mismatch');
  assert.equal(server.canPlay(c.clientId), false);
  assert.equal(server.setPlayback(c.clientId, true), false);
  assert.equal(conn.pskId, SENTINEL_PSK_ID);

  server.startCodePairing(c.clientId);
  await status(server, c.clientId, 'need_code');
  server.submitPairingCode(c.clientId, await reset.until(() => reset.pair?.code));
  await status(server, c.clientId, 'paired');
  await settle(reset, server);
  assert.equal(server.trustStore.trustState(c.clientId), 'paired');
  assert.ok(server.trustStore.record(c.clientId).psk.equals(reset.records.get(server.serverId)), 're-pair replaced the record');
  assert.equal(server.canPlay(c.clientId), true);
});

test('devices(): live, other-server, in-use-elsewhere and persisted known devices', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-pair-it-'));
  const server = await makeServer(t, { dataDir, keepDir: true });
  const a = await client(t, server);
  await a.connect();
  const b = await client(t, server);
  await b.connect(helloPayload({ name: 'Other', unpaired_access: { enabled: false }, supported_pair_methods: { pairing_psk: {} } }));
  let d = server.devices().find((x) => x.clientId === a.clientId);
  assert.deepEqual(d.deviceInfo, { productName: 'Fake', manufacturer: 'Velvet tests', softwareVersion: null });
  assert.equal(d.trust, 'unknown');
  assert.equal(d.connection, 'online');
  assert.equal(d.unpairedAccess, true);
  assert.deepEqual(d.pairMethods.sort(), ['dynamic_pairing_code', 'pairing_psk', 'static_pairing_code']);
  assert.deepEqual(d.roles, []);
  assert.equal(d.address, '127.0.0.1');
  assert.equal(d.pairing, null);
  a.send('client/state', { available: false });
  await a.until(() => server.device(a.clientId).connection === 'in-use-elsewhere');
  b.send('client/goodbye', { reason: 'another_server' });
  await b.closed;
  await b.until(() => server.device(b.clientId).connection === 'other-server');
  d = server.device(b.clientId);
  assert.equal(d.name, 'Other');
  assert.equal(d.unpairedAccess, false);
  assert.deepEqual(d.pairMethods, ['pairing_psk']);
  await server.stop();
  const saved = JSON.parse(await fsp.readFile(path.join(dataDir, KNOWN_DEVICES_FILE), 'utf8'));
  assert.equal(saved.devices.length, 2);
  const again = new SendspinServer({ dataDir, host: '127.0.0.1', port: 0, logger: quiet });
  await again.start();
  t.after(() => again.stop());
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));
  const list = again.devices();
  assert.equal(list.length, 2);
  assert.equal(list.find((x) => x.clientId === b.clientId).connection, 'other-server');
  assert.equal(list.find((x) => x.clientId === a.clientId).connection, 'offline');
  await again.forget(a.clientId);
  assert.equal(again.devices().length, 1);
});
