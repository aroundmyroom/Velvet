import { WebSocket } from 'ws';
import {
  NoiseResponder, SUITES, generateStaticKeyPair, MSG2_PAYLOAD, packHandshake, unpackHandshake,
} from '../../src/sendspin/noise.js';
import { encodeKeyId, decodeKeyId, SENTINEL_PSK } from '../../src/sendspin/keys.js';
import { MSG, Reassembler, fragment, frame, decodeJson } from '../../src/sendspin/wire.js';

export const PCM = { codec: 'pcm', sample_rate: 48000, channels: 2, bit_depth: 16 };
export const PLAYER_STATE = {
  output_delay_ms: 0, min_buffer_ms: 100, required_lead_time_ms: 100, supported_commands: ['volume', 'mute'], volume: 40, muted: false,
};

// Minimal unpaired Sendspin speaker for REST integration tests: Sentinel handshake, hello,
// player state, and a log of every JSON message and binary frame it receives.
export class RoomClient {
  constructor({ name = 'Test Speaker', keyPair = generateStaticKeyPair() } = {}) {
    this.name = name;
    this.keyPair = keyPair;
    this.clientId = encodeKeyId(keyPair.publicKey);
    this.inbox = [];
    this.audio = 0;
    this.texts = [];
    this.waiters = [];
    this.reassembler = new Reassembler();
  }

  async dial(url) {
    this.ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (data, isBinary) => this.#onMessage(Buffer.from(data), isBinary));
  }

  #onMessage(buf, isBinary) {
    if (!isBinary) this.texts.push(buf);
    else {
      const msg = this.reassembler.push(this.rx.decrypt(buf));
      if (msg?.type === MSG.JSON) {
        const m = decodeJson(msg.payload);
        this.inbox.push(m);
        if (m.type === 'server/activate' && m.payload.active_roles?.includes('player@v1')) this.sendState();
      }
      else if (msg?.type === MSG.AUDIO) this.audio++;
    }
    for (const w of this.waiters.splice(0)) w();
  }

  async until(pred, ms = 15000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = pred();
      if (v) return v;
      if (Date.now() > deadline) {
        const last = this.inbox.slice(-8).map((m) => m.type).join(', ');
        throw new Error(`RoomClient: timed out after ${ms} ms (audio ${this.audio}, last messages: ${last})`);
      }
      await Promise.race([new Promise((r) => this.waiters.push(r)), new Promise((r) => setTimeout(r, 50))]);
    }
  }

  seen(type, pred = () => true) {
    return this.inbox.find((m) => m.type === type && pred(m.payload)) ?? null;
  }

  waitFor(type, pred = () => true, ms) {
    return this.until(() => this.seen(type, pred), ms);
  }

  send(type, payload) {
    const plain = frame(MSG.JSON, Buffer.from(JSON.stringify({ type, payload })));
    for (const part of fragment(plain)) this.ws.send(this.tx.encrypt(part), { binary: true });
  }

  async connect() {
    const init = Buffer.from(JSON.stringify({ payload: { client_id: this.clientId, suite: SUITES[0], version: 1 }, type: 'client/init' }));
    this.ws.send(init, { binary: false });
    await this.until(() => this.texts.length >= 2);
    const [serverInit, hs1] = this.texts.splice(0, 2);
    const responder = new NoiseResponder({
      suite: SUITES[0], staticKeyPair: this.keyPair, remoteStaticPublicKey: decodeKeyId(JSON.parse(serverInit).payload.server_id),
      prologue: Buffer.concat([init, serverInit]),
    });
    responder.readMessage1(unpackHandshake(hs1.toString()));
    this.ws.send(packHandshake(responder.writeMessage2(MSG2_PAYLOAD, SENTINEL_PSK)), { binary: false });
    const { send, recv } = responder.split();
    this.tx = send;
    this.rx = recv;
    await this.waitFor('server/hello');
    this.send('client/hello', {
      name: this.name,
      supported_roles: ['player@v1', 'controller@v1', 'metadata@v1'],
      'player@v1_support': { supported_formats: [PCM], buffer_capacity: 4_000_000 },
      device_info: { product_name: 'Fake', manufacturer: 'Velvet tests' },
      supported_pair_methods: { pairing_psk: {} },
      unpaired_access: { enabled: true },
    });
    await this.waitFor('server/activate');
    this.sendState();
  }

  sendState(player = PLAYER_STATE) {
    this.send('client/state', { available: true, player });
  }

  close() {
    this.ws?.terminate();
  }
}
