import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  METHODS, FORMATS, ROUND_LIMIT, TIMEOUTS, CPace, Cooldown, PairingProtocolError, PairingInputError,
  cpaceGenerator, cpaceGeneratorString, elligator2, createPairingAttempt, decodePskToken, encodePskToken,
  decodeCodeToken, encodeCodeToken, assertTokenForClient, parseSupportedPairMethods, chooseCodeMethod,
  pairingActivation, wrap, unwrap, formatCode, parseDigitsCode, PENDING_MESSAGE_MAX_BYTES,
} from '../src/sendspin/pairing.js';
import { TrustStore, STAGED_PSK_LIFETIME_MS } from '../src/sendspin/trust-store.js';
import { SENTINEL_PSK, SENTINEL_PSK_ID, pskId } from '../src/sendspin/keys.js';
import { FakePairClient, recordedClientRandom, recordedServerRandom } from './helpers/sendspin-pair-client.mjs';

const V = JSON.parse(fs.readFileSync(new URL('./fixtures/sendspin/pairing-vectors.json', import.meta.url), 'utf8'));
const hex = (s) => Buffer.from(s, 'hex');
const SUITES = ['25519_ChaChaPoly_SHA256', '25519_AESGCM_SHA256'];
const CLIENT_ID = V.clientId;
const PAIRING_PSK = hex(V.pairingPsk);
const noCooldown = () => new Cooldown({ initialMs: 0 });

// ---- tokens ----

test('pairing token: spec reference vectors encode and decode', () => {
  const s = V.tokens.specPsk;
  assert.equal(encodePskToken(hex(s.clientKey), hex(s.pairingPsk)), s.token);
  const d = decodePskToken(s.token);
  assert.equal(d.clientId, s.clientId);
  assert.equal(d.pairingPsk.toString('hex'), s.pairingPsk);
  assert.equal(encodeCodeToken(hex(V.tokens.specCode.code)), V.tokens.specCode.token);
  assert.equal(decodeCodeToken(V.tokens.specCode.token).toString('hex'), V.tokens.specCode.code);
  assert.equal(encodePskToken(V.tokens.client.clientId, PAIRING_PSK), V.tokens.client.token);
  assert.equal(decodePskToken(V.tokens.client.token).pskId, V.tokens.client.pairingPskId);
});

test('pairing token: lenient decoding matches aiosendspin', () => {
  for (const c of V.tokens.lenient) {
    const d = decodePskToken(c.input);
    assert.equal(d.clientId, c.clientId, c.input);
    assert.equal(d.pairingPsk.toString('hex'), c.pairingPsk);
  }
});

test('pairing token: malformed input is rejected like aiosendspin', () => {
  for (const c of V.tokens.rejected) {
    if (c.rejected) {
      assert.throws(() => decodePskToken(c.input), (e) => e instanceof PairingInputError, JSON.stringify(c.input));
    } else {
      decodePskToken(c.input);
    }
  }
  assert.throws(() => decodePskToken('x'.repeat(600)), { code: 'malformed_token' });
  assert.throws(() => decodePskToken(V.tokens.specCode.token), { code: 'unsupported_token_version' });
  assert.throws(() => decodePskToken(V.tokens.client.token.slice(0, -1) + '1'), { code: 'malformed_token' });
  assert.throws(() => decodePskToken(null), { code: 'malformed_token' });
});

test('pairing token: client key must match the connection', () => {
  const t = decodePskToken(V.tokens.client.token);
  assertTokenForClient(t, CLIENT_ID);
  assert.throws(() => assertTokenForClient(t, V.serverId), { code: 'wrong_client' });
  assert.throws(() => assertTokenForClient(t, 'nope'), { code: 'wrong_client' });
});

test('pairing codes: separators stripped, grouping, length checked', () => {
  assert.equal(parseDigitsCode(' 123-456 ', 6), '123456');
  assert.equal(parseDigitsCode('1234 5678', 8), '12345678');
  assert.equal(formatCode('123456'), '123-456');
  assert.equal(formatCode('12345678'), '1234-5678');
  for (const bad of ['12345', '1234567', '12a456', '١٢٣٤٥٦']) assert.throws(() => parseDigitsCode(bad, 6), { code: 'invalid_code' });
});

// ---- CPace ----

test('CPace: generator, shares, ISK and tags match cpace-py', () => {
  const c = V.cpace;
  const prs = hex(c.prs);
  const sid = hex(c.sid);
  assert.equal(cpaceGeneratorString(prs, Buffer.alloc(0), sid).toString('hex'), c.generatorString);
  assert.equal(cpaceGenerator(prs, Buffer.alloc(0), sid).toString('hex'), c.generator);
  for (const e of c.elligator) assert.equal(elligator2(BigInt(e.r)).toString('hex'), e.u);
  const a = new CPace({ role: 'A', prs, sid, ad: Buffer.from('server'), scalar: hex(c.scalarA) });
  const b = new CPace({ role: 'B', prs, sid, ad: Buffer.from('client'), scalar: hex(c.scalarB) });
  assert.equal(a.publicShare.toString('hex'), c.Ya);
  assert.equal(b.publicShare.toString('hex'), c.Yb);
  a.derive(b.publicShare, Buffer.from('client'));
  b.derive(a.publicShare, Buffer.from('server'));
  assert.equal(a.isk.toString('hex'), c.isk);
  assert.equal(b.isk.toString('hex'), c.isk);
  assert.equal(a.tag().toString('hex'), c.Ta);
  assert.equal(b.tag().toString('hex'), c.Tb);
  assert.ok(a.verify(b.tag()) && b.verify(a.tag()));
  assert.ok(!a.verify(a.tag()));
  assert.throws(() => a.derive(b.publicShare), /once/);
});

test('CPace: low-order and wrong-length shares are rejected, wrong code fails confirmation', () => {
  assert.ok(V.cpace.lowOrderShareRejected);
  const sid = crypto.randomBytes(40);
  const a = new CPace({ role: 'A', prs: Buffer.from('123456'), sid, ad: Buffer.from('server') });
  assert.throws(() => a.derive(Buffer.alloc(32), Buffer.from('client')), /low-order/);
  const a2 = new CPace({ role: 'A', prs: Buffer.from('123456'), sid, ad: Buffer.from('server') });
  assert.throws(() => a2.derive(Buffer.alloc(31)), /32 bytes/);
  const x = new CPace({ role: 'A', prs: Buffer.from('123456'), sid, ad: Buffer.from('server') });
  const y = new CPace({ role: 'B', prs: Buffer.from('123457'), sid, ad: Buffer.from('client') });
  x.derive(y.publicShare, Buffer.from('client'));
  y.derive(x.publicShare, Buffer.from('server'));
  assert.ok(!x.verify(y.tag()) && !y.verify(x.tag()));
});

test('wrapping round trip under both suites; tampering fails', () => {
  for (const suite of SUITES) {
    const key = crypto.randomBytes(32);
    const value = crypto.randomBytes(32);
    const w = wrap(suite, key, value);
    assert.equal(w.length, 48);
    assert.deepEqual(unwrap(suite, key, w), value);
    w[3] ^= 1;
    assert.equal(unwrap(suite, key, w), null);
  }
});

// ---- cross-implementation transcripts ----

function replayServer(flow) {
  const attempt = createPairingAttempt({
    method: flow.method, format: flow.format ?? null, suite: flow.suite,
    handshakeHash: flow.handshakeHash ? hex(flow.handshakeHash) : null, pairingIndex: flow.pairingIndex,
    clientId: CLIENT_ID, pairingPsk: flow.method === METHODS.PAIRING_PSK ? PAIRING_PSK : null,
    random: recordedServerRandom(flow.draws), cooldown: noCooldown(),
  });
  const entered = [...(flow.entered ?? [])];
  const out = [];
  let record = null;
  let ended = null;
  const take = (s) => {
    out.push(...s.send);
    if (s.event?.kind === 'persist') {
      record = s.event.record;
      take(attempt.persisted());
    }
    if (s.event?.kind === 'aborted') ended = s.event;
  };
  for (const m of flow.messages) {
    if (m.from === 'client') {
      take(attempt.onMessage(m.message.type, m.message.payload));
      continue;
    }
    if (!out.length && attempt.state === 'awaiting_code') take(attempt.submitCode(entered.shift()));
    assert.deepEqual(out.shift(), m.message, `server message ${m.message.type}`);
  }
  assert.equal(out.length, 0);
  return { record, ended, attempt };
}

function replayClient(flow) {
  const client = new FakePairClient({
    method: flow.method, format: flow.format ?? null, suite: flow.suite,
    handshakeHash: flow.handshakeHash ? hex(flow.handshakeHash) : null, pairingIndex: flow.pairingIndex,
    staticCode: flow.staticCode ?? null, random: recordedClientRandom(flow.draws),
  });
  const out = client.start();
  for (const m of flow.messages) {
    if (m.from === 'server') {
      out.push(...client.onMessage(m.message));
      continue;
    }
    assert.deepEqual(out.shift(), m.message, `client message ${m.message.type}`);
  }
  assert.equal(out.length, 0);
  return client;
}

for (const flow of V.flows) {
  const name = flow.label ?? flow.method;
  test(`vectors: Velvet server reproduces aiosendspin's ${name} transcript`, () => {
    const { record, ended } = replayServer(flow);
    if (flow.serverRecord) {
      assert.equal(record.psk.toString('hex'), flow.serverRecord.psk);
      assert.equal(record.pskId, flow.serverRecord.pskId);
      assert.equal(record.clientId, flow.serverRecord.clientId);
      assert.deepEqual([record.method], flow.serverRecord.pairMethods);
      assert.equal(record.psk.toString('hex'), flow.clientRecordPsk);
    } else {
      assert.equal(record, null);
      assert.deepEqual({ reason: ended.reason, by: ended.by }, { reason: flow.server.abort, by: 'client' });
    }
  });
  test(`vectors: test client reproduces aiosendspin's ${name} client transcript`, () => {
    const client = replayClient(flow);
    if (flow.emitted) assert.deepEqual(client.emitted, flow.emitted);
    if (flow.clientRecordPsk) assert.ok(client.persisted);
    else assert.equal(client.abortReason, flow.client.abort);
  });
}

// ---- end to end against the in-process client ----

function link({ method, format = null, suite = SUITES[0], pairingIndex = 1, staticCode = '24681357', holdBack = null, cooldown = noCooldown(), now } = {}) {
  const h = crypto.randomBytes(32);
  const attempt = createPairingAttempt({
    method, format, suite, handshakeHash: h, pairingIndex, clientId: CLIENT_ID,
    pairingPsk: method === METHODS.PAIRING_PSK ? PAIRING_PSK : null, cooldown, now,
  });
  const client = new FakePairClient({ method, format, suite, handshakeHash: h, pairingIndex, staticCode, holdBack });
  const events = [];
  const state = { record: null };
  const pump = (fromClient) => {
    let queue = fromClient;
    while (queue.length) {
      const next = [];
      for (const m of queue) {
        const s = attempt.onMessage(m.type, m.payload);
        if (s.event) events.push(s.event);
        let send = s.send;
        if (s.event?.kind === 'persist') {
          state.record = s.event.record;
          const p = attempt.persisted();
          events.push(p.event);
          send = [...send, ...p.send];
        }
        for (const out of send) next.push(...client.onMessage(out));
      }
      queue = next;
    }
  };
  const deliver = (s) => {
    if (s.event) events.push(s.event);
    const replies = [];
    for (const out of s.send) replies.push(...client.onMessage(out));
    pump(replies);
  };
  return { attempt, client, events, state, pump, deliver, start: () => pump(client.start()) };
}

for (const suite of SUITES) {
  test(`e2e ${suite}: Pairing PSK flow`, () => {
    const l = link({ method: METHODS.PAIRING_PSK, suite });
    assert.deepEqual(l.attempt.activation(), { activities: ['pairing'], pairing: { method: 'pairing_psk' }, active_roles: [] });
    l.start();
    assert.equal(l.attempt.state, 'paired');
    assert.ok(l.client.persisted);
    assert.deepEqual(l.state.record.psk, l.client.longTermPsk);
    assert.equal(l.state.record.pskId, pskId(l.client.longTermPsk));
  });

  for (const format of Object.values(FORMATS)) {
    test(`e2e ${suite}: dynamic ${format}, wrong code then the right one`, () => {
      const l = link({ method: METHODS.DYNAMIC, format, suite });
      l.start();
      assert.deepEqual(l.events.at(-1), { kind: 'need_code', round: 1 });
      const code = l.client.emitted[0];
      const wrong = format === FORMATS.DIGITS ? String((Number(code) + 1) % 1e6).padStart(6, '0') : encodeCodeToken(crypto.randomBytes(24));
      l.deliver(l.attempt.submitCode(wrong));
      assert.equal(l.events.at(-1).kind, 'wrong_code');
      assert.equal(l.attempt.round, 2);
      l.deliver(l.attempt.submitCode(format === FORMATS.DIGITS ? formatCode(code) : code.toLowerCase()));
      assert.equal(l.attempt.state, 'paired');
      assert.deepEqual(l.state.record.psk, l.client.longTermPsk);
      assert.deepEqual(l.client.emitted, [code, code]);
    });
  }

  test(`e2e ${suite}: static code, entered before and after client/pair-init`, () => {
    const l = link({ method: METHODS.STATIC, suite, holdBack: 'Press the button' });
    l.start();
    assert.deepEqual(l.events.at(-1), { kind: 'pending', message: 'Press the button' });
    assert.equal(l.attempt.deadline - Date.now() > TIMEOUTS.firstMessageMs, true);
    assert.equal(l.attempt.submitCode('2468-1357').event.kind, 'code_queued');
    l.pump(l.client.release());
    assert.equal(l.attempt.state, 'paired');
    assert.deepEqual(l.state.record.psk, l.client.longTermPsk);
    const l2 = link({ method: METHODS.STATIC, suite });
    l2.start();
    assert.deepEqual(l2.events.at(-1), { kind: 'need_code', round: 1 });
    l2.deliver(l2.attempt.submitCode('24681357'));
    assert.equal(l2.attempt.state, 'paired');
  });
}

test('static: a wrong code aborts with pairing_code_mismatch from the client and starts the cooldown', () => {
  let t = 1_000_000;
  const cooldown = new Cooldown({ now: () => t });
  for (let i = 0; i < 5; i++) {
    const l = link({ method: METHODS.STATIC, cooldown, now: () => t });
    l.start();
    l.deliver(l.attempt.submitCode('11112222'));
    assert.deepEqual(l.events.at(-1), { kind: 'aborted', reason: 'pairing_code_mismatch', by: 'client' });
    assert.equal(l.client.abortReason, 'pairing_code_mismatch');
    assert.equal(cooldown.failures, i + 1);
    const l2 = link({ method: METHODS.STATIC, cooldown, now: () => t });
    l2.start();
    assert.throws(() => l2.attempt.submitCode('24681357'), { code: 'cooldown' });
    t += 2_000 * 2 ** i;
  }
  const l = link({ method: METHODS.STATIC, cooldown, now: () => t });
  l.start();
  l.deliver(l.attempt.submitCode('24681357'));
  assert.equal(l.attempt.state, 'paired');
  assert.equal(cooldown.failures, 0);
});

test('dynamic: cooldown doubles between rounds and the round limit ends the attempt', () => {
  let t = 0;
  const cooldown = new Cooldown({ now: () => t });
  const l = link({ method: METHODS.DYNAMIC, format: FORMATS.DIGITS, cooldown, now: () => t });
  l.start();
  const wrong = String((Number(l.client.emitted[0]) + 1) % 1e6).padStart(6, '0');
  const waits = [];
  for (let round = 1; round <= ROUND_LIMIT; round++) {
    l.deliver(l.attempt.submitCode(wrong));
    if (round < ROUND_LIMIT) {
      const ev = l.events.at(-1);
      assert.equal(ev.kind, 'wrong_code');
      waits.push(ev.retryAfterMs);
      assert.throws(() => l.attempt.submitCode(wrong), (e) => e.code === 'cooldown' && e.retryAfterMs === ev.retryAfterMs);
      t += ev.retryAfterMs;
    }
  }
  assert.deepEqual(waits.slice(0, 4), [2000, 4000, 8000, 16000]);
  assert.equal(Math.max(...waits), 120000);
  assert.equal(l.attempt.state, 'aborted');
  assert.equal(l.client.state, 'aborted');
});

test('server enforces the round limit even when the client keeps retrying', () => {
  const l = link({ method: METHODS.DYNAMIC, format: FORMATS.DIGITS });
  l.client.rounds = -100;
  l.start();
  const wrong = String((Number(l.client.emitted[0]) + 1) % 1e6).padStart(6, '0');
  for (let i = 0; i < ROUND_LIMIT; i++) l.deliver(l.attempt.submitCode(wrong));
  assert.deepEqual(l.events.at(-1), { kind: 'aborted', reason: 'pairing_code_mismatch', by: 'server' });
  assert.equal(l.client.abortReason, 'pairing_code_mismatch');
});

test('pending message is plain text truncated to 200 UTF-8 bytes; second pending is a protocol error', () => {
  const a = createPairingAttempt({ method: METHODS.STATIC, suite: SUITES[0], handshakeHash: crypto.randomBytes(32), pairingIndex: 1, clientId: CLIENT_ID });
  const s = a.onMessage('client/pair-pending', { pairing_index: 1, message: '€'.repeat(100) });
  assert.equal(Buffer.byteLength(s.event.message), 198);
  assert.ok(Buffer.byteLength(s.event.message) <= PENDING_MESSAGE_MAX_BYTES);
  assert.throws(() => a.onMessage('client/pair-pending', { pairing_index: 1 }), PairingProtocolError);
});

test('timeouts: deadlines per phase and expire()', () => {
  let t = 0;
  const a = createPairingAttempt({ method: METHODS.STATIC, suite: SUITES[0], handshakeHash: crypto.randomBytes(32), pairingIndex: 1, clientId: CLIENT_ID, now: () => t });
  assert.equal(a.deadline, TIMEOUTS.firstMessageMs);
  assert.equal(a.expire(TIMEOUTS.firstMessageMs - 1), null);
  a.onMessage('client/pair-pending', { pairing_index: 1 });
  assert.equal(a.deadline, TIMEOUTS.gestureMs);
  t = 1000;
  a.onMessage('client/pair-init', { pairing_index: 1 });
  assert.equal(a.deadline, 1000 + TIMEOUTS.attemptMs);
  const s = a.expire(1000 + TIMEOUTS.attemptMs);
  assert.deepEqual(s, { send: [], event: { kind: 'aborted', reason: 'timeout', by: 'server' } });
  assert.equal(a.onMessage('client/pair-auth', {}).event.kind, 'ignored');
});

test('cancel sends pair/abort user_cancelled; after the end, frames are discarded', () => {
  const l = link({ method: METHODS.DYNAMIC, format: FORMATS.DIGITS });
  l.start();
  const s = l.attempt.cancel();
  assert.deepEqual(s.send, [{ type: 'pair/abort', payload: { reason: 'user_cancelled' } }]);
  assert.equal(l.attempt.cancel(), null);
  assert.equal(l.attempt.onMessage('client/pair-retry', {}).event.kind, 'ignored');
  assert.throws(() => l.attempt.submitCode('123456'), { code: 'not_ready' });
});

test('client pair/abort ends the attempt; leftovers before client/pair-init are discarded', () => {
  const mk = (pairingIndex) => createPairingAttempt({ method: METHODS.DYNAMIC, format: FORMATS.DIGITS, suite: SUITES[0], handshakeHash: crypto.randomBytes(32), pairingIndex, clientId: CLIENT_ID });
  const a = mk(2);
  for (const [type, payload] of [
    ['client/pair-auth', { pake_msg_2: 'x' }], ['client/pair-confirm', {}], ['client/pair-retry', {}],
    ['client/pair-finalize', { wrapped_psk: 'x' }], ['client/pair-init', { pairing_index: 1, commit_B: 'x' }],
    ['client/pair-pending', { pairing_index: 1 }], ['pair/abort', { reason: 'attempt_timeout' }],
  ]) assert.equal(a.onMessage(type, payload).event.kind, 'ignored', type);
  assert.deepEqual(a.onMessage('pair/abort', { reason: 'concurrent_attempt' }).event, { kind: 'aborted', reason: 'concurrent_attempt', by: 'client' });
  assert.deepEqual(mk(1).onMessage('pair/abort', { reason: 'attempt_timeout' }).event.kind, 'aborted');
  assert.throws(() => mk(1).onMessage('client/pair-init', { pairing_index: 2, commit_B: 'x' }), /ahead/);
  assert.throws(() => mk(1).onMessage('client/pair-init', { pairing_index: 1 }), /commit_B/);
  assert.throws(() => mk(1).onMessage('client/pair-init', { pairing_index: 1, commit_B: 'short' }), /commit_B/);
  assert.throws(() => mk(1).onMessage('client/pair-init', null), PairingProtocolError);
  assert.throws(() => mk(1).onMessage('client/hello', {}), TypeError);
});

test('protocol errors: sequence violation, bad shares, tampered wrap, reused PSKs', () => {
  const l = link({ method: METHODS.DYNAMIC, format: FORMATS.DIGITS });
  l.start();
  assert.throws(() => l.attempt.onMessage('client/pair-auth', { pake_msg_2: 'A'.repeat(43) }), /out of sequence/);
  l.attempt.submitCode(l.client.emitted[0]);
  assert.throws(() => l.attempt.onMessage('client/pair-auth', { pake_msg_2: 'A'.repeat(43) }), /low-order/);

  const tamper = (field) => {
    const k = link({ method: METHODS.DYNAMIC, format: FORMATS.DIGITS });
    k.start();
    const pakeAuth = k.attempt.submitCode(k.client.emitted[0]).send;
    const [auth] = k.client.onMessage(pakeAuth[0]);
    const confirmReq = k.attempt.onMessage(auth.type, auth.payload).send[0];
    const [confirm, finalize] = k.client.onMessage(confirmReq);
    const target = field === 'wrapped_psk' ? finalize : confirm;
    const raw = Buffer.from(target.payload[field], 'base64url');
    raw[0] ^= 1;
    target.payload[field] = raw.toString('base64url');
    if (field === 'wrapped_psk') {
      k.attempt.onMessage(confirm.type, confirm.payload);
      return () => k.attempt.onMessage(finalize.type, finalize.payload);
    }
    return () => k.attempt.onMessage(confirm.type, confirm.payload);
  };
  assert.throws(tamper('wrapped_nonce_B'), /AEAD/);
  assert.throws(tamper('wrapped_psk'), /AEAD/);
  const kc = tamper('client_kc');
  assert.deepEqual(kc().event, { kind: 'aborted', reason: 'pairing_code_mismatch', by: 'server' });

  const psk = (value) => {
    const a = createPairingAttempt({ method: METHODS.PAIRING_PSK, suite: SUITES[0], pairingIndex: 1, clientId: CLIENT_ID, pairingPsk: PAIRING_PSK });
    a.onMessage('client/pair-init', { pairing_index: 1 });
    return () => a.onMessage('client/pair-finalize', { long_term_psk: value.toString('base64url') });
  };
  assert.throws(psk(SENTINEL_PSK), /reused/);
  assert.throws(psk(PAIRING_PSK), /reused/);
  assert.throws(psk(Buffer.alloc(31)), /long_term_psk/);
  const both = createPairingAttempt({ method: METHODS.PAIRING_PSK, suite: SUITES[0], pairingIndex: 1, clientId: CLIENT_ID, pairingPsk: PAIRING_PSK });
  both.onMessage('client/pair-init', { pairing_index: 1 });
  assert.throws(() => both.onMessage('client/pair-finalize', { long_term_psk: 'a', wrapped_psk: 'b' }), /exactly one/);
  const pend = createPairingAttempt({ method: METHODS.PAIRING_PSK, suite: SUITES[0], pairingIndex: 1, clientId: CLIENT_ID, pairingPsk: PAIRING_PSK });
  assert.throws(() => pend.onMessage('client/pair-pending', { pairing_index: 1 }), /not part of/);
});

test('commit_B binding: a client that changes nonce_B after committing is a protocol error', () => {
  const l = link({ method: METHODS.DYNAMIC, format: FORMATS.DIGITS });
  l.start();
  const auth = l.attempt.submitCode(l.client.emitted[0]).send[0];
  const [pake2] = l.client.onMessage(auth);
  const confirmReq = l.attempt.onMessage(pake2.type, pake2.payload).send[0];
  l.client.nonceB = crypto.randomBytes(32);
  const [confirm] = l.client.onMessage(confirmReq);
  assert.throws(() => l.attempt.onMessage(confirm.type, confirm.payload), /commit_B/);
});

test('legacy Pairing PSK client that starts with client/pair-finalize is accepted on the first activation', () => {
  const a = createPairingAttempt({ method: METHODS.PAIRING_PSK, suite: SUITES[0], pairingIndex: 1, clientId: CLIENT_ID, pairingPsk: PAIRING_PSK });
  const lt = crypto.randomBytes(32);
  const s = a.onMessage('client/pair-finalize', { long_term_psk: lt.toString('base64url') });
  assert.equal(s.event.kind, 'persist');
  assert.deepEqual(s.event.record.psk, lt);
  const b = createPairingAttempt({ method: METHODS.PAIRING_PSK, suite: SUITES[0], pairingIndex: 2, clientId: CLIENT_ID, pairingPsk: PAIRING_PSK });
  assert.equal(b.onMessage('client/pair-finalize', { long_term_psk: lt.toString('base64url') }).event.kind, 'ignored');
});

test('submitCode input errors send nothing', () => {
  const l = link({ method: METHODS.DYNAMIC, format: FORMATS.QR_CODE });
  l.start();
  assert.throws(() => l.attempt.submitCode('SP:0AAAA'), { code: 'unsupported_token_version' });
  assert.throws(() => l.attempt.submitCode('SP:1AAAA'), { code: 'malformed_token' });
  assert.equal(l.attempt.state, 'awaiting_code');
  const p = link({ method: METHODS.PAIRING_PSK });
  assert.throws(() => p.attempt.submitCode('123456'), { code: 'not_ready' });
  const d = link({ method: METHODS.DYNAMIC, format: FORMATS.DIGITS });
  assert.throws(() => d.attempt.submitCode('123456'), { code: 'not_ready' });
});

test('client/hello supported_pair_methods parsing, method choice and activation', () => {
  const { methods, ignored } = parseSupportedPairMethods({
    pairing_psk: { locations: ['device', 'moon'] },
    static_pairing_code: {},
    dynamic_pairing_code: { out_channels: ['display', 'smell'], formats: ['digits', 'qr_code', 'braille'] },
    future_method: {},
  });
  assert.deepEqual(methods, {
    pairing_psk: { locations: ['device'] }, static_pairing_code: { locations: [] },
    dynamic_pairing_code: { formats: ['digits', 'qr_code'], outChannels: ['display'] },
  });
  assert.deepEqual(ignored.sort(), ['dynamic_pairing_code:braille', 'dynamic_pairing_code:smell', 'future_method', 'pairing_psk:moon']);
  assert.deepEqual(chooseCodeMethod(methods), { method: 'dynamic_pairing_code', format: 'digits' });
  assert.deepEqual(chooseCodeMethod(methods, { canScanQr: true }), { method: 'dynamic_pairing_code', format: 'qr_code' });
  assert.deepEqual(chooseCodeMethod(parseSupportedPairMethods({ dynamic_pairing_code: { out_channels: [], formats: ['digits'] }, static_pairing_code: {} }).methods), { method: 'static_pairing_code' });
  assert.equal(chooseCodeMethod(parseSupportedPairMethods({ pairing_psk: {} }).methods), null);
  assert.deepEqual(pairingActivation({ method: 'dynamic_pairing_code', format: 'digits', playback: true, activeRoles: ['player@v1'] }), {
    activities: ['playback', 'pairing'], pairing: { method: 'dynamic_pairing_code', format: 'digits' }, active_roles: ['player@v1'],
  });
});

// ---- trust store ----

function tmpdir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'velvet-trust-'));
}

test('trust store: pairing record persists with 0600, approvals are dropped by pairing', async () => {
  const dir = path.join(await tmpdir(), 'sendspin');
  let t = Date.parse('2026-11-12T10:00:00Z');
  const store = await TrustStore.open(dir, { now: () => t });
  assert.equal(store.trustState(CLIENT_ID), 'unknown');
  assert.deepEqual(store.pskForClient(CLIENT_ID).pskId, SENTINEL_PSK_ID);
  assert.equal(await store.approve(CLIENT_ID, { name: 'Kitchen', roles: ['player'] }), true);
  assert.equal(store.trustState(CLIENT_ID), 'approved');
  await store.stagePairingPsk(CLIENT_ID, PAIRING_PSK);
  assert.deepEqual(store.pskForClient(CLIENT_ID), { psk: PAIRING_PSK, pskId: pskId(PAIRING_PSK), category: 'pr' });
  const lt = crypto.randomBytes(32);
  const rec = await store.storePairing({ clientId: CLIENT_ID, psk: lt, method: 'pairing_psk' });
  assert.equal(rec.name, 'Kitchen');
  assert.equal(store.isApproved(CLIENT_ID), false);
  assert.equal(store.stagedPairingPsk(CLIENT_ID), null);
  assert.deepEqual(store.pskForClient(CLIENT_ID), { psk: lt, pskId: pskId(lt), category: 'lt' });
  assert.equal(store.recordByPskId(pskId(lt)).clientId, CLIENT_ID);
  assert.equal((await fsp.stat(store.file)).mode & 0o777, 0o600);
  assert.equal((await fsp.stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual((await fsp.readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
  t += 1000;
  const lt2 = crypto.randomBytes(32);
  await store.storePairing({ clientId: CLIENT_ID, psk: lt2, method: 'dynamic_pairing_code' });
  const again = await TrustStore.open(dir);
  const r = again.record(CLIENT_ID);
  assert.deepEqual(r.psk, lt2);
  assert.deepEqual(r.pairMethods, ['pairing_psk', 'dynamic_pairing_code']);
  assert.equal(r.createdAt, '2026-11-12T10:00:00.000Z');
  assert.equal(r.updatedAt, '2026-11-12T10:00:01.000Z');
  assert.equal(again.listRecords()[0].psk, undefined);
  await assert.rejects(store.storePairing({ clientId: CLIENT_ID, psk: SENTINEL_PSK, method: 'pairing_psk' }), /Sentinel/);
  await assert.rejects(store.approve('bad'), TypeError);
});

test('trust store: credential mismatch, unpair, revoke, staged expiry, concurrent writes', async () => {
  const dir = await tmpdir();
  let t = 0;
  const store = await TrustStore.open(dir, { now: () => t });
  await store.storePairing({ clientId: CLIENT_ID, psk: crypto.randomBytes(32), method: 'static_pairing_code' });
  assert.equal(await store.approve(CLIENT_ID), false);
  assert.equal(await store.markCredentialMismatch(CLIENT_ID), true);
  assert.equal(await store.markCredentialMismatch(CLIENT_ID), false);
  assert.equal(store.trustState(CLIENT_ID), 'mismatch');
  assert.equal((await TrustStore.open(dir)).hasCredentialMismatch(CLIENT_ID), true);
  assert.equal(await store.clearCredentialMismatch(CLIENT_ID), true);
  await store.markCredentialMismatch(CLIENT_ID);
  await store.storePairing({ clientId: CLIENT_ID, psk: crypto.randomBytes(32), method: 'static_pairing_code' });
  assert.equal(store.trustState(CLIENT_ID), 'paired');
  assert.equal(await store.unpair(CLIENT_ID), true);
  assert.equal(await store.unpair(CLIENT_ID), false);
  assert.equal(store.trustState(CLIENT_ID), 'unknown');
  await store.approve(CLIENT_ID);
  assert.equal(await store.revokeApproval(CLIENT_ID), true);
  assert.equal(await store.revokeApproval(CLIENT_ID), false);
  await store.stagePairingPsk(CLIENT_ID, PAIRING_PSK);
  t += STAGED_PSK_LIFETIME_MS + 1;
  assert.equal(store.stagedPairingPsk(CLIENT_ID), null);
  assert.equal(store.pskForClient(CLIENT_ID).category, 'sn');
  const ids = Array.from({ length: 20 }, () => crypto.randomBytes(32).toString('base64url'));
  await Promise.all(ids.map((id, i) => (i % 2 ? store.approve(id, { name: `n${i}` }) : store.storePairing({ clientId: id, psk: crypto.randomBytes(32), method: 'pairing_psk' }))));
  const reread = await TrustStore.open(dir);
  assert.equal(reread.listRecords().length, 10);
  assert.equal(reread.listApprovals().length, 10);
  assert.equal(await reread.rename(ids[1], 'x'.repeat(500)), true);
  assert.equal(reread.approval(ids[1]).name.length, 200);
  assert.equal(JSON.parse(await fsp.readFile(reread.file, 'utf8')).staged[CLIENT_ID], undefined);
});
