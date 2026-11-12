import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SUITES, NoiseInitiator, NoiseResponder, NoiseError, CipherState, generateStaticKeyPair, publicKeyFromPrivate,
  encodeMsg1Payload, parseMsg1Payload, parseMsg2Payload, MSG2_PAYLOAD, packHandshake, unpackHandshake,
} from '../src/sendspin/noise.js';
import {
  encodeKeyId, decodeKeyId, isKeyId, pskId, SENTINEL_PSK, SENTINEL_PSK_ID, loadOrCreateServerKey, SERVER_KEY_FILE,
} from '../src/sendspin/keys.js';
import { fragment, frame, MSG } from '../src/sendspin/wire.js';

const V = JSON.parse(fs.readFileSync(new URL('./fixtures/sendspin/noise-vectors.json', import.meta.url), 'utf8'));
const hex = (s) => Buffer.from(s, 'hex');
const b64 = (s) => Buffer.from(s, 'base64');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const kp = (j) => ({ privateKey: hex(j.privateKey), publicKey: hex(j.publicKey) });
const SERVER = kp(V.server);
const CLIENT = kp(V.client);

function pair(suite, { prologue = Buffer.from('p'), psk = SENTINEL_PSK, responderPsk = psk } = {}) {
  const init = new NoiseInitiator({ suite, staticKeyPair: SERVER, remoteStaticPublicKey: CLIENT.publicKey, prologue, psk });
  const resp = new NoiseResponder({ suite, staticKeyPair: CLIENT, remoteStaticPublicKey: SERVER.publicKey, prologue });
  const m1 = init.writeMessage1(encodeMsg1Payload(pskId(psk), 'sn'));
  resp.readMessage1(m1);
  const m2 = resp.writeMessage2(MSG2_PAYLOAD, responderPsk);
  return { init, resp, m2 };
}

test('sentinel constants match the spec', () => {
  assert.equal(SENTINEL_PSK.toString('hex'), '1b5e24dbc1aed95fc2a5a338a90c05df44bd10f5ec1f4cd66cbf86272767b9d3');
  assert.equal(SENTINEL_PSK_ID, 'GFsV9tLaSQm9HcFWpKsgYQOr7wFTvNUtkmFwuVz3zoo');
  assert.equal(V.sentinelPskId, SENTINEL_PSK_ID);
});

test('static keys derive the public key and id the reference uses', () => {
  for (const k of [V.server, V.client]) {
    assert.equal(publicKeyFromPrivate(hex(k.privateKey)).toString('hex'), k.publicKey);
    assert.equal(encodeKeyId(hex(k.publicKey)), k.id);
  }
});

for (const sv of V.suites) {
  for (const c of sv.cases) {
    test(`vectors ${sv.suite} / ${c.tag}`, () => {
      const prologue = b64(c.prologue);
      if (c.tag !== 'rehandshake') {
        assert.deepEqual(prologue, Buffer.concat([Buffer.from(sv.clientInit), Buffer.from(sv.serverInit)]));
      }
      const psk = hex(c.psk);
      const init = new NoiseInitiator({
        suite: sv.suite, staticKeyPair: SERVER, remoteStaticPublicKey: CLIENT.publicKey, prologue, psk,
        ephemeralKeyPair: kp(c.initiatorEphemeral),
      });
      const resp = new NoiseResponder({
        suite: sv.suite, staticKeyPair: CLIENT, remoteStaticPublicKey: SERVER.publicKey, prologue,
        ephemeralKeyPair: kp(c.responderEphemeral),
      });
      const msg1Payload = encodeMsg1Payload(pskId(psk), c.pskCategory);
      assert.equal(msg1Payload.toString(), c.msg1Payload);
      const m1 = init.writeMessage1(msg1Payload);
      assert.equal(m1.toString('base64'), c.msg1);
      assert.equal(packHandshake(m1), c.msg1Handshake);
      assert.deepEqual(unpackHandshake(c.msg1Handshake), m1);
      assert.deepEqual(parseMsg1Payload(resp.readMessage1(m1)), { pskId: pskId(psk), pskCategory: c.pskCategory });
      const m2 = resp.writeMessage2(MSG2_PAYLOAD, hex(c.responderPsk));
      assert.equal(m2.toString('base64'), c.msg2);
      if (c.sentinelFallback) {
        assert.throws(() => init.readMessage2(m2), NoiseError);
        assert.equal(init.readMessage2(m2, SENTINEL_PSK).toString(), c.msg2Payload);
        assert.deepEqual(init.psk, SENTINEL_PSK);
      } else {
        assert.equal(init.readMessage2(m2).toString(), c.msg2Payload);
      }
      assert.equal(init.handshakeHash.toString('hex'), c.handshakeHash);
      assert.equal(resp.handshakeHash.toString('hex'), c.handshakeHash);

      const a = init.split();
      const b = resp.split();
      for (let i = 0; i < c.toResponder.length; i++) {
        const toR = c.toResponder[i];
        const toI = c.toInitiator[i];
        assert.equal(a.send.encrypt(b64(toR.plaintext)).toString('base64'), toR.ciphertext);
        assert.deepEqual(b.recv.decrypt(b64(toR.ciphertext)), b64(toR.plaintext));
        assert.equal(b.send.encrypt(b64(toI.plaintext)).toString('base64'), toI.ciphertext);
        assert.deepEqual(a.recv.decrypt(b64(toI.ciphertext)), b64(toI.plaintext));
      }

      if (c.fragmented) {
        const f = c.fragmented;
        const obj = structuredClone(f.json);
        obj.payload.blob = 'x'.repeat(f.blobLength);
        const plaintext = frame(MSG.JSON, Buffer.from(JSON.stringify(obj)));
        assert.equal(sha(plaintext), f.plaintextSha256);
        const frames = fragment(plaintext);
        assert.equal(frames.length, f.frames.length);
        frames.forEach((fr, i) => {
          assert.equal(fr.length, f.frames[i].length);
          assert.equal(fr.subarray(0, 8).toString('base64'), f.frames[i].head);
          assert.equal(sha(fr), f.frames[i].plaintextSha256);
          assert.equal(sha(a.send.encrypt(fr)), f.frames[i].ciphertextSha256);
        });
      }
    });
  }
}

test('rehandshake vector chains on the prior handshake hash', () => {
  for (const sv of V.suites) {
    const lt = sv.cases.find((c) => c.tag === 'long_term');
    const rh = sv.cases.find((c) => c.tag === 'rehandshake');
    assert.equal(b64(rh.prologue).toString('hex'), lt.handshakeHash);
  }
});

for (const suite of SUITES) {
  test(`in-process round trip ${suite}`, () => {
    const { init, resp, m2 } = pair(suite);
    assert.deepEqual(parseMsg2Payload(init.readMessage2(m2)), { canonical: true });
    assert.deepEqual(init.handshakeHash, resp.handshakeHash);
    const a = init.split();
    const b = resp.split();
    for (let i = 0; i < 5; i++) {
      const msg = crypto.randomBytes(100 + i);
      assert.deepEqual(b.recv.decrypt(a.send.encrypt(msg)), msg);
      assert.deepEqual(a.recv.decrypt(b.send.encrypt(msg)), msg);
    }
    const big = crypto.randomBytes(65519);
    assert.deepEqual(b.recv.decrypt(a.send.encrypt(big)), big);
    assert.throws(() => a.send.encrypt(Buffer.alloc(65520)), NoiseError);
  });

  test(`wrong PSK fails ${suite}`, () => {
    const lt = crypto.randomBytes(32);
    const { init, m2 } = pair(suite, { psk: lt, responderPsk: crypto.randomBytes(32) });
    assert.throws(() => init.readMessage2(m2), NoiseError);
    assert.throws(() => init.readMessage2(m2, SENTINEL_PSK), NoiseError);
    assert.equal(init.handshakeComplete, false);
    assert.throws(() => init.split(), NoiseError);
  });

  test(`sentinel fallback retry ${suite}`, () => {
    const lt = crypto.randomBytes(32);
    const { init, resp, m2 } = pair(suite, { psk: lt, responderPsk: SENTINEL_PSK });
    assert.throws(() => init.readMessage2(m2), NoiseError);
    init.readMessage2(m2, SENTINEL_PSK);
    assert.deepEqual(init.handshakeHash, resp.handshakeHash);
    assert.throws(() => init.readMessage2(m2, SENTINEL_PSK), NoiseError);
  });

  test(`prologue mismatch fails ${suite}`, () => {
    const init = new NoiseInitiator({ suite, staticKeyPair: SERVER, remoteStaticPublicKey: CLIENT.publicKey, prologue: Buffer.from('a'), psk: SENTINEL_PSK });
    const resp = new NoiseResponder({ suite, staticKeyPair: CLIENT, remoteStaticPublicKey: SERVER.publicKey, prologue: Buffer.from('b') });
    assert.throws(() => resp.readMessage1(init.writeMessage1(Buffer.from('{}'))), NoiseError);
  });

  test(`wrong static key fails ${suite}`, () => {
    const other = generateStaticKeyPair();
    const init = new NoiseInitiator({ suite, staticKeyPair: SERVER, remoteStaticPublicKey: CLIENT.publicKey, prologue: Buffer.alloc(0), psk: SENTINEL_PSK });
    const resp = new NoiseResponder({ suite, staticKeyPair: CLIENT, remoteStaticPublicKey: other.publicKey, prologue: Buffer.alloc(0) });
    assert.throws(() => resp.readMessage1(init.writeMessage1(Buffer.from('{}'))), NoiseError);
  });

  test(`tampered ciphertext throws ${suite}`, () => {
    const { init, resp, m2 } = pair(suite);
    const bad = Buffer.from(m2);
    bad[bad.length - 1] ^= 1;
    assert.throws(() => init.readMessage2(bad), NoiseError);
    init.readMessage2(m2);
    const a = init.split();
    const b = resp.split();
    const ct = a.send.encrypt(Buffer.from('hello'));
    for (const i of [0, 3, ct.length - 1]) {
      const t = Buffer.from(ct);
      t[i] ^= 0x80;
      assert.throws(() => b.recv.decrypt(t), NoiseError);
    }
    assert.throws(() => b.recv.decrypt(Buffer.alloc(15)), NoiseError);
    assert.equal(b.recv.nonce, 0);
    assert.deepEqual(b.recv.decrypt(ct), Buffer.from('hello'));
  });

  test(`nonce increments and replay fails ${suite}`, () => {
    const { init, resp, m2 } = pair(suite);
    init.readMessage2(m2);
    const a = init.split();
    const b = resp.split();
    assert.equal(a.send.nonce, 0);
    const c0 = a.send.encrypt(Buffer.from('x'));
    const c1 = a.send.encrypt(Buffer.from('x'));
    assert.equal(a.send.nonce, 2);
    assert.notDeepEqual(c0, c1);
    assert.throws(() => b.recv.decrypt(c1), NoiseError);
    b.recv.decrypt(c0);
    assert.throws(() => b.recv.decrypt(c0), NoiseError);
    b.recv.decrypt(c1);
    assert.equal(b.recv.nonce, 2);
  });

  test(`rehandshake with prior hash as prologue ${suite}`, () => {
    const first = pair(suite);
    first.init.readMessage2(first.m2);
    const pr = crypto.randomBytes(32);
    const second = pair(suite, { prologue: first.init.handshakeHash, psk: pr });
    second.init.readMessage2(second.m2);
    assert.notDeepEqual(second.init.handshakeHash, first.init.handshakeHash);
    const init = new NoiseInitiator({ suite, staticKeyPair: SERVER, remoteStaticPublicKey: CLIENT.publicKey, prologue: first.init.handshakeHash, psk: pr });
    const resp = new NoiseResponder({ suite, staticKeyPair: CLIENT, remoteStaticPublicKey: SERVER.publicKey, prologue: Buffer.alloc(32) });
    assert.throws(() => resp.readMessage1(init.writeMessage1(Buffer.from('{}'))), NoiseError);
  });
}

test('handshake state machine guards', () => {
  const init = new NoiseInitiator({ suite: SUITES[0], staticKeyPair: SERVER, remoteStaticPublicKey: CLIENT.publicKey, prologue: Buffer.alloc(0), psk: SENTINEL_PSK });
  assert.throws(() => init.readMessage2(Buffer.alloc(48)), NoiseError);
  init.writeMessage1(Buffer.from('{}'));
  assert.throws(() => init.writeMessage1(Buffer.from('{}')), NoiseError);
  assert.throws(() => init.readMessage2(Buffer.alloc(47)), NoiseError);
  assert.throws(() => new NoiseInitiator({ suite: 'nope', staticKeyPair: SERVER, remoteStaticPublicKey: CLIENT.publicKey, prologue: Buffer.alloc(0), psk: SENTINEL_PSK }), NoiseError);
  assert.throws(() => new NoiseInitiator({ suite: SUITES[0], staticKeyPair: SERVER, remoteStaticPublicKey: CLIENT.publicKey, prologue: Buffer.alloc(0), psk: Buffer.alloc(31) }), NoiseError);
  const resp = new NoiseResponder({ suite: SUITES[1], staticKeyPair: CLIENT, remoteStaticPublicKey: SERVER.publicKey, prologue: Buffer.alloc(0) });
  assert.throws(() => resp.writeMessage2(Buffer.from('{}'), SENTINEL_PSK), NoiseError);
  assert.throws(() => resp.readMessage1(Buffer.alloc(10)), NoiseError);
});

test('low-order ephemeral key is rejected', () => {
  const resp = new NoiseResponder({ suite: SUITES[0], staticKeyPair: CLIENT, remoteStaticPublicKey: SERVER.publicKey, prologue: Buffer.alloc(0) });
  assert.throws(() => resp.readMessage1(Buffer.alloc(64)), NoiseError);
});

test('cipher state without key passes through', () => {
  const cs = new CipherState(SUITES[0]);
  assert.equal(cs.hasKey, false);
  assert.deepEqual(cs.encrypt(Buffer.from('a')), Buffer.from('a'));
});

test('handshake payload helpers validate', () => {
  assert.throws(() => encodeMsg1Payload(SENTINEL_PSK_ID, 'xx'), NoiseError);
  assert.throws(() => parseMsg1Payload(Buffer.from('{"psk_id":"short","psk_category":"sn"}')), NoiseError);
  assert.throws(() => parseMsg1Payload(Buffer.from(`{"psk_id":"${SENTINEL_PSK_ID}","psk_category":"zz"}`)), NoiseError);
  assert.throws(() => parseMsg1Payload(Buffer.from([0xff, 0xfe])), NoiseError);
  assert.deepEqual(parseMsg2Payload(Buffer.from('{ }')), { canonical: false });
  assert.throws(() => parseMsg2Payload(Buffer.from('[]')), NoiseError);
  assert.throws(() => unpackHandshake('{"type":"noise/handshake","payload":{"data":"a b"}}'), NoiseError);
  assert.throws(() => unpackHandshake('{"type":"server/init","payload":{"data":"AA"}}'), NoiseError);
  assert.throws(() => unpackHandshake('nope'), NoiseError);
});

test('key ids encode and decode strictly', () => {
  const pub = Buffer.from(V.server.publicKey, 'hex');
  assert.deepEqual(decodeKeyId(V.server.id), pub);
  assert.equal(isKeyId(V.server.id), true);
  const bad = [
    undefined, 42, '', V.server.id.slice(0, 42), `${V.server.id}A`, `${V.server.id.slice(0, 42)}=`,
    `${V.server.id.slice(0, 42)}B`, `${V.server.id.slice(0, 41)}+A`, `${V.server.id.slice(0, 41)}/A`,
    Buffer.alloc(32).toString('base64'),
  ];
  for (const b of bad) {
    assert.throws(() => decodeKeyId(b), TypeError, String(b));
    assert.equal(isKeyId(b), false);
  }
  assert.throws(() => encodeKeyId(Buffer.alloc(31)), TypeError);
  assert.throws(() => pskId(Buffer.alloc(33)), TypeError);
  for (let i = 0; i < 50; i++) {
    const k = crypto.randomBytes(32);
    assert.deepEqual(decodeKeyId(encodeKeyId(k)), k);
  }
});

test('loadOrCreateServerKey persists a 0600 key file', async () => {
  const dir = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-keys-')), 'nested', 'sendspin');
  try {
    const a = await loadOrCreateServerKey(dir);
    const st = await fsp.stat(path.join(dir, SERVER_KEY_FILE));
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(a.serverId, encodeKeyId(a.publicKey));
    assert.deepEqual(publicKeyFromPrivate(a.privateKey), a.publicKey);
    const b = await loadOrCreateServerKey(dir);
    assert.deepEqual(b.privateKey, a.privateKey);
    assert.equal(b.serverId, a.serverId);
    const data = JSON.parse(await fsp.readFile(path.join(dir, SERVER_KEY_FILE), 'utf8'));
    data.publicKey = encodeKeyId(crypto.randomBytes(32));
    await fsp.writeFile(path.join(dir, SERVER_KEY_FILE), JSON.stringify(data));
    await assert.rejects(loadOrCreateServerKey(dir));
  } finally {
    await fsp.rm(path.dirname(path.dirname(dir)), { recursive: true, force: true });
  }
});

test('concurrent loadOrCreateServerKey calls agree', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-keys-'));
  try {
    const [a, b] = await Promise.all([loadOrCreateServerKey(dir), loadOrCreateServerKey(dir)]);
    assert.equal(a.serverId, b.serverId);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
