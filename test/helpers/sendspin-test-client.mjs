import { WebSocket } from 'ws';
import {
  NoiseResponder, SUITES, generateStaticKeyPair, MSG2_PAYLOAD, packHandshake, unpackHandshake, parseMsg1Payload,
} from '../../src/sendspin/noise.js';
import { encodeKeyId, decodeKeyId, SENTINEL_PSK, generatePsk, pskId } from '../../src/sendspin/keys.js';
import { MSG, Reassembler, fragment, frame, decodeJson } from '../../src/sendspin/wire.js';
import { PAIRING_MESSAGE_TYPES } from '../../src/sendspin/pairing.js';
import { FakePairClient } from './sendspin-pair-client.mjs';

export const PCM = { codec: 'pcm', sample_rate: 48000, channels: 2, bit_depth: 16 };
export const PLAYER_STATE = { output_delay_ms: 0, min_buffer_ms: 100, required_lead_time_ms: 100, supported_commands: ['volume'], volume: 50, muted: false };

export function helloPayload(over = {}) {
  return {
    name: 'Pair Speaker',
    supported_roles: ['player@v1', 'controller@v1'],
    'player@v1_support': { supported_formats: [PCM], buffer_capacity: 1_000_000 },
    device_info: { product_name: 'Fake', manufacturer: 'Velvet tests' },
    supported_pair_methods: {
      pairing_psk: {}, static_pairing_code: {}, dynamic_pairing_code: { formats: ['digits', 'qr_code'], out_channels: ['display'] },
    },
    unpaired_access: { enabled: true },
    ...over,
  };
}

// A Sendspin client written from the spec for the pairing integration tests: keeps its pairing
// PSK and long-term records as handshake candidates, answers re-handshakes and runs the client
// half of each pairing activation through FakePairClient.
export class TestClient {
  constructor({ suite = SUITES[0], keyPair = generateStaticKeyPair(), pairingPsk = generatePsk(), records = new Map(), staticCode = '12345678', holdBack = null } = {}) {
    Object.assign(this, { suite, keyPair, pairingPsk, records, staticCode, holdBack });
    this.clientId = encodeKeyId(keyPair.publicKey);
    this.inbox = [];
    this.binary = [];
    this.waiters = [];
    this.pair = null;
    this.pairingIndex = 0;
    this.matched = null;
    this.ws = null;
  }

  async dial(url, options = {}) {
    this.ws = new WebSocket(url, options);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.#attach();
  }

  #attach() {
    this.texts = [];
    this.inbox = [];
    this.binary = [];
    this.reassembler = new Reassembler();
    this.closed = new Promise((resolve) => this.ws.once('close', (code) => resolve(code)));
    this.ws.on('message', (data, isBinary) => {
      try {
        this.#onMessage(Buffer.from(data), isBinary);
      } catch (err) {
        this.error = err;
        this.ws.terminate();
      }
    });
  }

  #candidate(category, id, initial) {
    if (category === 'sn') return SENTINEL_PSK;
    if (category === 'pr' && pskId(this.pairingPsk) === id) return this.pairingPsk;
    if (category === 'lt') {
      const lt = this.records.get(this.serverId);
      if (lt && pskId(lt) === id) return lt;
    }
    return initial ? SENTINEL_PSK : null;
  }

  async connect(hello = helloPayload()) {
    this.initText = Buffer.from(JSON.stringify({ payload: { client_id: this.clientId, suite: this.suite, version: 1 }, type: 'client/init' }));
    this.ws.send(this.initText, { binary: false });
    const serverInit = await this.#nextText();
    this.serverId = JSON.parse(serverInit).payload.server_id;
    const hs1 = await this.#nextText();
    const r = new NoiseResponder({
      suite: this.suite, staticKeyPair: this.keyPair, remoteStaticPublicKey: decodeKeyId(this.serverId),
      prologue: Buffer.concat([this.initText, serverInit]),
    });
    this.msg1 = parseMsg1Payload(r.readMessage1(unpackHandshake(hs1.toString())));
    const psk = this.#candidate(this.msg1.pskCategory, this.msg1.pskId, true);
    this.matched = psk === SENTINEL_PSK ? 'sn' : this.msg1.pskCategory;
    this.ws.send(packHandshake(r.writeMessage2(MSG2_PAYLOAD, psk)), { binary: false });
    this.#keys(r);
    await this.expect('server/hello');
    this.send('client/hello', hello);
    this.activate = await this.expect('server/activate');
    return this.activate;
  }

  #keys(r) {
    const { send, recv } = r.split();
    this.tx = send;
    this.rx = recv;
    this.h = r.handshakeHash;
    this.pairingIndex = 0;
    this.pair = null;
  }

  #nextText() {
    return this.until(() => this.texts.shift());
  }

  #onMessage(buf, isBinary) {
    if (!isBinary) {
      this.texts.push(buf);
      return this.#wake();
    }
    const msg = this.reassembler.push(this.rx.decrypt(buf));
    if (!msg) return;
    if (msg.type !== MSG.JSON) {
      this.binary.push({ type: msg.type, payload: msg.payload });
      return this.#wake();
    }
    const m = decodeJson(msg.payload);
    if (m.type === 'noise/handshake') return this.#onRehandshake(m.payload);
    if (m.type === 'server/activate') this.#onActivate(m.payload);
    else if (m.type === 'server/unpair') this.#onUnpair();
    else if (this.pair && (m.type.startsWith('server/pair-') || m.type === 'pair/abort')) this.#onPair(m);
    this.inbox.push(m);
    this.#wake();
  }

  #onRehandshake(payload) {
    const r = new NoiseResponder({ suite: this.suite, staticKeyPair: this.keyPair, remoteStaticPublicKey: decodeKeyId(this.serverId), prologue: this.h });
    const m1 = parseMsg1Payload(r.readMessage1(Buffer.from(payload.data, 'base64url')));
    this.rehandshakes = (this.rehandshakes ?? 0) + 1;
    const psk = this.#candidate(m1.pskCategory, m1.pskId, false);
    if (!psk) {
      this.ws.close(1002);
      return;
    }
    this.send('noise/handshake', { data: r.writeMessage2(MSG2_PAYLOAD, psk).toString('base64url') });
    this.matched = m1.pskCategory;
    this.#keys(r);
    this.reassembler = new Reassembler();
  }

  #onActivate(payload) {
    this.lastActivate = payload;
    if (!payload.activities.includes('pairing')) {
      this.pair = null;
      return;
    }
    this.pairingIndex++;
    const { method, format = null } = payload.pairing;
    if (method === 'pairing_psk' && this.matched !== 'pr') {
      this.send('pair/abort', { reason: 'method_not_supported' });
      return;
    }
    this.pair = new FakePairClient({
      method, format, suite: this.suite, handshakeHash: this.h, pairingIndex: this.pairingIndex,
      staticCode: this.staticCode, holdBack: method === 'pairing_psk' ? null : this.holdBack,
    });
    this.#sendAll(this.pair.start());
  }

  #onPair(m) {
    this.#sendAll(this.pair.onMessage(m));
    if (m.type === 'server/pair-finalize') this.records.set(this.serverId, this.pair.longTermPsk);
  }

  release() {
    this.#sendAll(this.pair.release());
  }

  #onUnpair() {
    if (this.matched !== 'lt') return;
    this.records.delete(this.serverId);
    this.send('client/goodbye', { reason: 'unpaired' });
    this.ws.close(1000);
  }

  #sendAll(msgs) {
    for (const m of msgs) {
      if (!PAIRING_MESSAGE_TYPES.has(m.type)) throw new Error(`not a pairing message: ${m.type}`);
      this.send(m.type, m.payload);
    }
  }

  #wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  async until(pred, ms = 4000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = pred();
      if (v) return v;
      if (Date.now() > deadline) throw new Error('TestClient: timed out');
      await Promise.race([new Promise((r) => this.waiters.push(r)), new Promise((r) => setTimeout(r, 25))]);
    }
  }

  expect(type, pred = () => true) {
    return this.until(() => {
      const i = this.inbox.findIndex((m) => m.type === type && pred(m.payload));
      return i >= 0 ? this.inbox.splice(i, 1)[0] : null;
    });
  }

  send(type, payload = {}) {
    for (const part of fragment(frame(MSG.JSON, Buffer.from(JSON.stringify({ type, payload }))))) {
      this.ws.send(this.tx.encrypt(part), { binary: true });
    }
  }

  close() {
    this.ws?.terminate();
  }
}
