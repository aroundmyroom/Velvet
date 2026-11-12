import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { SENTINEL_PSK, SENTINEL_PSK_ID, PSK_CATEGORY, pskId, isKeyId } from './keys.js';
import { METHODS } from './pairing.js';

export const TRUST_STORE_FILE = 'trust-store.json';
export const STAGED_PSK_LIFETIME_MS = 24 * 60 * 60 * 1000;
const NAME_MAX = 200;

const nowIso = (now) => new Date(now()).toISOString();
const label = (v) => (typeof v === 'string' ? v.slice(0, NAME_MAX) : null);

function checkClientId(clientId) {
  if (!isKeyId(clientId)) throw new TypeError('invalid client_id');
}

function checkPsk(psk) {
  if (!Buffer.isBuffer(psk) || psk.length !== 32) throw new TypeError('PSK must be a 32-byte Buffer');
}

function publicRecord(r) {
  return { clientId: r.clientId, pskId: r.pskId, pairMethods: [...r.pairMethods], createdAt: r.createdAt, updatedAt: r.updatedAt, name: r.name, mismatchAt: r.mismatchAt };
}

export class TrustStore {
  #file;
  #now;
  #records = new Map();
  #approvals = new Map();
  #staged = new Map();
  #sources = new Map();
  #writing = Promise.resolve();

  constructor(dir, { file = TRUST_STORE_FILE, now = Date.now } = {}) {
    this.dir = dir;
    this.#file = path.join(dir, file);
    this.#now = now;
  }

  static async open(dir, opts) {
    const store = new TrustStore(dir, opts);
    await store.#load();
    return store;
  }

  get file() {
    return this.#file;
  }

  async #load() {
    let raw;
    try {
      raw = await fsp.readFile(this.#file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    const data = JSON.parse(raw);
    for (const r of Object.values(data.records ?? {})) {
      const psk = Buffer.from(r.psk, 'base64url');
      checkClientId(r.clientId);
      checkPsk(psk);
      this.#records.set(r.clientId, {
        clientId: r.clientId, psk, pskId: pskId(psk),
        pairMethods: (r.pairMethods ?? []).filter((m) => Object.values(METHODS).includes(m)),
        createdAt: r.createdAt, updatedAt: r.updatedAt ?? r.createdAt, name: label(r.name), mismatchAt: r.mismatchAt ?? null,
      });
    }
    for (const a of Object.values(data.approvals ?? {})) {
      checkClientId(a.clientId);
      this.#approvals.set(a.clientId, { clientId: a.clientId, approvedAt: a.approvedAt, name: label(a.name), roles: Array.isArray(a.roles) ? a.roles.filter((x) => typeof x === 'string') : [] });
    }
    for (const x of Object.values(data.sources ?? {})) {
      checkClientId(x.clientId);
      this.#sources.set(x.clientId, {
        clientId: x.clientId, allowedAt: x.allowedAt, autoSwitch: x.autoSwitch === true,
        roomId: typeof x.roomId === 'string' ? x.roomId.slice(0, 64) : null,
      });
    }
    for (const s of Object.values(data.staged ?? {})) {
      const psk = Buffer.from(s.psk, 'base64url');
      checkClientId(s.clientId);
      checkPsk(psk);
      this.#staged.set(s.clientId, { clientId: s.clientId, psk, pskId: pskId(psk), createdAt: s.createdAt });
    }
  }

  #serialize() {
    const records = {};
    for (const r of this.#records.values()) records[r.clientId] = { ...publicRecord(r), psk: r.psk.toString('base64url') };
    const approvals = Object.fromEntries([...this.#approvals].map(([k, v]) => [k, { ...v }]));
    const staged = {};
    for (const s of this.#staged.values()) {
      if (!this.#expired(s)) staged[s.clientId] = { clientId: s.clientId, psk: s.psk.toString('base64url'), createdAt: s.createdAt };
    }
    const sources = Object.fromEntries([...this.#sources].map(([k, v]) => [k, { ...v }]));
    return JSON.stringify({ version: 1, records, approvals, staged, sources }, null, 2) + '\n';
  }

  #save() {
    const body = this.#serialize();
    const run = this.#writing.catch(() => {}).then(() => this.#atomicWrite(body));
    this.#writing = run;
    return run;
  }

  async #atomicWrite(body) {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const fh = await fsp.open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await fsp.rename(tmp, this.#file);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
    const dh = await fsp.open(this.dir, 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  }

  #expired(s) {
    return this.#now() - Date.parse(s.createdAt) > STAGED_PSK_LIFETIME_MS;
  }

  // ---- pairing records ----

  record(clientId) {
    const r = this.#records.get(clientId);
    return r ? { ...publicRecord(r), psk: Buffer.from(r.psk) } : null;
  }

  recordByPskId(id) {
    for (const r of this.#records.values()) if (r.pskId === id) return this.record(r.clientId);
    return null;
  }

  listRecords() {
    return [...this.#records.values()].map(publicRecord);
  }

  isPaired(clientId) {
    return this.#records.has(clientId);
  }

  async storePairing({ clientId, psk, method, name }) {
    checkClientId(clientId);
    checkPsk(psk);
    if (psk.equals(SENTINEL_PSK)) throw new TypeError('refusing to store the Sentinel PSK');
    const at = nowIso(this.#now);
    const prev = this.#records.get(clientId);
    const pairMethods = prev ? [...new Set([...prev.pairMethods, method])] : [method];
    this.#records.set(clientId, {
      clientId, psk: Buffer.from(psk), pskId: pskId(psk), pairMethods,
      createdAt: prev?.createdAt ?? at, updatedAt: at, name: label(name) ?? prev?.name ?? this.#approvals.get(clientId)?.name ?? null, mismatchAt: null,
    });
    this.#approvals.delete(clientId);
    this.#staged.delete(clientId);
    await this.#save();
    return this.record(clientId);
  }

  async unpair(clientId) {
    if (!this.#records.delete(clientId)) return false;
    this.#sources.delete(clientId);
    await this.#save();
    return true;
  }

  async markCredentialMismatch(clientId) {
    const r = this.#records.get(clientId);
    if (!r || r.mismatchAt) return false;
    r.mismatchAt = nowIso(this.#now);
    await this.#save();
    return true;
  }

  async clearCredentialMismatch(clientId) {
    const r = this.#records.get(clientId);
    if (!r?.mismatchAt) return false;
    r.mismatchAt = null;
    await this.#save();
    return true;
  }

  hasCredentialMismatch(clientId) {
    return Boolean(this.#records.get(clientId)?.mismatchAt);
  }

  async rename(clientId, name) {
    let changed = false;
    for (const map of [this.#records, this.#approvals]) {
      const e = map.get(clientId);
      if (e) {
        e.name = label(name);
        changed = true;
      }
    }
    if (changed) await this.#save();
    return changed;
  }

  // ---- unpaired-access approvals ----

  isApproved(clientId) {
    return this.#approvals.has(clientId);
  }

  approval(clientId) {
    const a = this.#approvals.get(clientId);
    return a ? { ...a, roles: [...a.roles] } : null;
  }

  listApprovals() {
    return [...this.#approvals.values()].map((a) => ({ ...a, roles: [...a.roles] }));
  }

  async approve(clientId, { name, roles = [] } = {}) {
    checkClientId(clientId);
    if (this.#records.has(clientId)) return false;
    const prev = this.#approvals.get(clientId);
    this.#approvals.set(clientId, {
      clientId, approvedAt: prev?.approvedAt ?? nowIso(this.#now), name: label(name) ?? prev?.name ?? null,
      roles: [...new Set([...(prev?.roles ?? []), ...roles.filter((x) => typeof x === 'string')])],
    });
    await this.#save();
    return true;
  }

  async revokeApproval(clientId) {
    if (!this.#approvals.delete(clientId)) return false;
    if (!this.#records.has(clientId)) this.#sources.delete(clientId);
    await this.#save();
    return true;
  }

  // ---- source approvals (explicit, separate from playback; survive pairing, die with trust) ----

  isSourceAllowed(clientId) {
    return this.#sources.has(clientId);
  }

  sourcePolicy(clientId) {
    const x = this.#sources.get(clientId);
    return x ? { ...x } : null;
  }

  listSources() {
    return [...this.#sources.values()].map((x) => ({ ...x }));
  }

  async allowSource(clientId, on) {
    checkClientId(clientId);
    if (!on) {
      if (!this.#sources.delete(clientId)) return false;
    } else {
      if (!this.#records.has(clientId) && !this.#approvals.has(clientId)) return false;
      if (this.#sources.has(clientId)) return true;
      this.#sources.set(clientId, { clientId, allowedAt: nowIso(this.#now), autoSwitch: false, roomId: null });
    }
    await this.#save();
    return true;
  }

  async setSourcePolicy(clientId, { autoSwitch, roomId } = {}) {
    const x = this.#sources.get(clientId);
    if (!x) return false;
    if (typeof autoSwitch === 'boolean') x.autoSwitch = autoSwitch;
    if (roomId !== undefined) x.roomId = typeof roomId === 'string' ? roomId.slice(0, 64) : null;
    await this.#save();
    return true;
  }

  // ---- staged pairing PSKs (operator entered a token before the device connected) ----

  stagedPairingPsk(clientId) {
    const s = this.#staged.get(clientId);
    if (!s || this.#expired(s)) return null;
    return { clientId, psk: Buffer.from(s.psk), pskId: s.pskId, createdAt: s.createdAt };
  }

  async stagePairingPsk(clientId, psk) {
    checkClientId(clientId);
    checkPsk(psk);
    this.#staged.set(clientId, { clientId, psk: Buffer.from(psk), pskId: pskId(psk), createdAt: nowIso(this.#now) });
    await this.#save();
  }

  async unstagePairingPsk(clientId) {
    if (!this.#staged.delete(clientId)) return false;
    await this.#save();
    return true;
  }

  // ---- handshake ----

  pskForClient(clientId) {
    const r = this.#records.get(clientId);
    if (r) return { psk: Buffer.from(r.psk), pskId: r.pskId, category: PSK_CATEGORY.LONG_TERM };
    const s = this.stagedPairingPsk(clientId);
    if (s) return { psk: s.psk, pskId: s.pskId, category: PSK_CATEGORY.PAIRING };
    return { psk: Buffer.from(SENTINEL_PSK), pskId: SENTINEL_PSK_ID, category: PSK_CATEGORY.SENTINEL };
  }

  trustState(clientId) {
    const r = this.#records.get(clientId);
    if (r) return r.mismatchAt ? 'mismatch' : 'paired';
    return this.#approvals.has(clientId) ? 'approved' : 'unknown';
  }

  async flush() {
    await this.#writing;
  }
}
