import crypto from 'node:crypto';
import {
  CPace, METHODS, FORMATS, ROUND_LIMIT, commitNonce, deriveCodePrs, encodeCodeToken, pakeSid, wrap, wrapKey,
} from '../../src/sendspin/pairing.js';

const AD_SERVER = Buffer.from('server');
const AD_CLIENT = Buffer.from('client');
const msg = (type, payload = {}) => ({ type, payload });

// Client side of the three pairing flows, written from the spec for tests. `random(n, who)` lets
// a test replay recorded draws (who: nonceB | clientScalar | longTermPsk).
export class FakePairClient {
  constructor({
    method, format = null, suite, handshakeHash, pairingIndex, staticCode = null,
    random = (n) => crypto.randomBytes(n), holdBack = null, rounds = 0,
  }) {
    Object.assign(this, { method, format, suite, handshakeHash, pairingIndex, staticCode, random, holdBack, rounds });
    this.state = 'idle';
    this.emitted = [];
    this.longTermPsk = null;
    this.persisted = false;
    this.abortReason = null;
    this.round = 0;
  }

  start() {
    if (this.holdBack !== null) {
      this.state = 'pending';
      return [msg('client/pair-pending', this.holdBack ? { pairing_index: this.pairingIndex, message: this.holdBack } : { pairing_index: this.pairingIndex })];
    }
    return this.#init();
  }

  release() {
    this.holdBack = null;
    return this.#init();
  }

  #init() {
    if (this.method === METHODS.PAIRING_PSK) {
      this.longTermPsk = this.random(32, 'longTermPsk');
      this.state = 'awaiting_finalize';
      return [
        msg('client/pair-init', { pairing_index: this.pairingIndex }),
        msg('client/pair-finalize', { long_term_psk: this.longTermPsk.toString('base64url') }),
      ];
    }
    if (this.method === METHODS.DYNAMIC) {
      this.nonceB = this.random(32, 'nonceB');
      this.state = 'awaiting_server_init';
      return [msg('client/pair-init', { pairing_index: this.pairingIndex, commit_B: commitNonce(this.nonceB).toString('base64url') })];
    }
    this.round = 1;
    this.#startPake(Buffer.from(this.staticCode, 'ascii'));
    return [msg('client/pair-init', { pairing_index: this.pairingIndex })];
  }

  #startPake(prs) {
    this.sid = pakeSid(this.handshakeHash, this.pairingIndex, this.round);
    this.cpace = new CPace({ role: 'B', prs, sid: this.sid, ad: AD_CLIENT, scalar: this.random(32, 'clientScalar') });
    this.state = 'awaiting_auth';
  }

  #abort(reason) {
    this.state = 'aborted';
    this.abortReason = reason;
    return [msg('pair/abort', { reason })];
  }

  onMessage({ type, payload }) {
    const handler = {
      'pair/abort': () => this.#onAbort(payload),
      'server/pair-init awaiting_server_init': () => this.#onServerInit(payload),
      'server/pair-auth awaiting_auth': () => this.#onAuth(payload),
      'server/pair-confirm awaiting_confirm': () => this.#onConfirm(payload),
      'server/pair-finalize awaiting_finalize': () => this.#onFinalize(),
    }[type === 'pair/abort' ? type : `${type} ${this.state}`];
    if (!handler) throw new Error(`fake client: unexpected ${type} in ${this.state}`);
    return handler();
  }

  #onAbort(payload) {
    this.state = 'aborted';
    this.abortReason = payload.reason;
    return [];
  }

  #onServerInit(payload) {
    if (this.round === 0) {
      this.nonceA = Buffer.from(payload.nonce_A, 'base64url');
      this.prs = deriveCodePrs(this.handshakeHash, this.nonceA, this.nonceB, this.format);
      this.code = this.format === FORMATS.QR_CODE ? encodeCodeToken(this.prs) : this.prs.toString('ascii');
    } else if (payload.nonce_A !== undefined) {
      throw new Error('nonce_A after the first round');
    }
    this.round++;
    this.rounds++;
    this.emitted.push(this.code);
    this.#startPake(this.prs);
    return [];
  }

  #onAuth(payload) {
    this.cpace.derive(Buffer.from(payload.pake_msg_1, 'base64url'), AD_SERVER);
    this.state = 'awaiting_confirm';
    return [msg('client/pair-auth', { pake_msg_2: this.cpace.publicShare.toString('base64url') })];
  }

  #onConfirm(payload) {
    if (!this.cpace.verify(Buffer.from(payload.server_kc, 'base64url'))) {
      if (this.method === METHODS.STATIC || this.rounds >= ROUND_LIMIT) return this.#abort('pairing_code_mismatch');
      this.state = 'awaiting_server_init';
      return [msg('client/pair-retry')];
    }
    this.rounds = 0;
    const confirm = { client_kc: this.cpace.tag().toString('base64url') };
    if (this.method === METHODS.DYNAMIC) {
      confirm.wrapped_nonce_B = wrap(this.suite, wrapKey('nonce', this.sid, this.cpace.isk), this.nonceB).toString('base64url');
    }
    this.longTermPsk = this.random(32, 'longTermPsk');
    const wrapped = wrap(this.suite, wrapKey('psk', this.sid, this.cpace.isk), this.longTermPsk);
    this.state = 'awaiting_finalize';
    return [msg('client/pair-confirm', confirm), msg('client/pair-finalize', { wrapped_psk: wrapped.toString('base64url') })];
  }

  #onFinalize() {
    this.persisted = true;
    this.state = 'paired';
    return [];
  }
}

export function replayRandom(draws, who) {
  const queue = draws.filter((d) => d.who === who).map((d) => Buffer.from(d.hex, 'hex'));
  return () => {
    if (!queue.length) throw new Error(`no recorded ${who} draw left`);
    return queue.shift();
  };
}

export function recordedClientRandom(draws) {
  const pools = {};
  for (const who of ['nonceB', 'clientScalar', 'longTermPsk']) pools[who] = replayRandom(draws, who);
  return (n, who) => pools[who]();
}

export function recordedServerRandom(draws) {
  const nonceA = draws.filter((d) => d.who === 'nonceA').map((d) => Buffer.from(d.hex, 'hex'));
  const scalars = draws.filter((d) => d.who === 'serverScalar').map((d) => Buffer.from(d.hex, 'hex'));
  // The server draws nonce_A once, then one scalar per round, in that order.
  const queue = [...nonceA, ...scalars];
  return () => queue.shift();
}
