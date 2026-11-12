import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import winston from 'winston';

// eslint-disable-next-line sonarjs/no-hardcoded-ip -- the mDNS group is fixed by RFC 6762
export const MDNS_ADDRESS = '224.0.0.251';
export const MDNS_PORT = 5353;
export const CLIENT_SERVICE = '_sendspin._tcp.local';
export const SERVER_SERVICE = '_sendspin-server._tcp.local';
export const SERVICES_META = '_services._dns-sd._udp.local';
export const TYPE = Object.freeze({ A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 });
export const MAX_PATH_LENGTH = 256;

const CLASS_IN = 1;
const FLUSH = 0x8000;
const QU = 0x8000;
const MAX_RECORDS = 128;
const MAX_POINTER_JUMPS = 32;
const MAX_NAME_LENGTH = 255;
const MAX_INSTANCES = 128;
const MAX_HOSTS = 256;
const TTL_SHARED = 4500;
const TTL_HOST = 120;
const QUERY_MAX_INTERVAL_MS = 60_000;

export class MdnsError extends Error {}

function escapeLabel(label) {
  return label.replace(/[\\.]/g, (c) => `\\${c}`);
}

function splitName(name) {
  const labels = [];
  let cur = '';
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (c === '\\' && i + 1 < name.length) cur += name[++i];
    else if (c === '.') {
      labels.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) labels.push(cur);
  return labels;
}

export function joinName(labels) {
  return labels.map(escapeLabel).join('.');
}

function nameKey(name) {
  return name.toLowerCase();
}

function encodeName(name, out) {
  for (const label of splitName(name)) {
    const b = Buffer.from(label, 'utf8');
    if (b.length === 0 || b.length > 63) throw new MdnsError(`invalid DNS label in ${name}`);
    out.push(Buffer.from([b.length]), b);
  }
  out.push(Buffer.from([0]));
}

function encodeRdata(rec) {
  const parts = [];
  switch (rec.type) {
    case TYPE.PTR: encodeName(rec.data, parts); break;
    case TYPE.SRV: {
      const h = Buffer.alloc(6);
      h.writeUInt16BE(rec.data.priority ?? 0, 0);
      h.writeUInt16BE(rec.data.weight ?? 0, 2);
      h.writeUInt16BE(rec.data.port, 4);
      parts.push(h);
      encodeName(rec.data.target, parts);
      break;
    }
    case TYPE.TXT:
      for (const s of rec.data) {
        const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8');
        if (b.length > 255) throw new MdnsError('TXT string longer than 255 bytes');
        parts.push(Buffer.from([b.length]), b);
      }
      if (!rec.data.length) parts.push(Buffer.from([0]));
      break;
    case TYPE.A: parts.push(Buffer.from(rec.data.split('.').map(Number))); break;
    case TYPE.AAAA: parts.push(ipv6Bytes(rec.data)); break;
    default: parts.push(rec.data);
  }
  return Buffer.concat(parts);
}

function ipv6Bytes(addr) {
  const [head, tail = ''] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = addr.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(parseInt(g, 16), i * 2));
  return b;
}

function ipv6String(b) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i));
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; i++) {
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
  }
  const hex = groups.map((g) => g.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

export function encodePacket({ id = 0, response = false, questions = [], answers = [], additionals = [] }) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(response ? 0x8400 : 0, 2);
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(additionals.length, 10);
  const parts = [header];
  for (const q of questions) {
    encodeName(q.name, parts);
    const t = Buffer.alloc(4);
    t.writeUInt16BE(q.type, 0);
    t.writeUInt16BE(CLASS_IN | (q.unicast ? QU : 0), 2);
    parts.push(t);
  }
  for (const rec of [...answers, ...additionals]) {
    encodeName(rec.name, parts);
    const rdata = encodeRdata(rec);
    const t = Buffer.alloc(10);
    t.writeUInt16BE(rec.type, 0);
    t.writeUInt16BE(CLASS_IN | (rec.flush ? FLUSH : 0), 2);
    t.writeUInt32BE(rec.ttl, 4);
    t.writeUInt16BE(rdata.length, 8);
    parts.push(t, rdata);
  }
  return Buffer.concat(parts);
}

function followPointer(buf, pos, st) {
  if (pos + 1 >= buf.length) throw new MdnsError('truncated name pointer');
  if (++st.jumps > MAX_POINTER_JUMPS) throw new MdnsError('too many name pointers');
  if (st.end < 0) st.end = pos + 2;
  return ((buf[pos] & 0x3f) << 8) | buf[pos + 1];
}

function readLabel(buf, pos, labels, st) {
  const len = buf[pos];
  if (len & 0xc0) throw new MdnsError('unsupported label type');
  if (pos + 1 + len > buf.length) throw new MdnsError('label runs past the packet');
  st.total += len + 1;
  if (st.total > MAX_NAME_LENGTH) throw new MdnsError('name too long');
  labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
  return pos + 1 + len;
}

function decodeName(buf, start) {
  const labels = [];
  const st = { end: -1, jumps: 0, total: 0 };
  let pos = start;
  for (;;) {
    if (pos >= buf.length) throw new MdnsError('name runs past the packet');
    if (buf[pos] === 0) break;
    pos = (buf[pos] & 0xc0) === 0xc0 ? followPointer(buf, pos, st) : readLabel(buf, pos, labels, st);
  }
  return { name: joinName(labels), end: st.end < 0 ? pos + 1 : st.end };
}

function decodeRdata(buf, type, start, len) {
  const end = start + len;
  switch (type) {
    case TYPE.PTR: return decodeName(buf, start).name;
    case TYPE.SRV:
      if (len < 7) throw new MdnsError('short SRV record');
      return { priority: buf.readUInt16BE(start), weight: buf.readUInt16BE(start + 2), port: buf.readUInt16BE(start + 4), target: decodeName(buf, start + 6).name };
    case TYPE.TXT: {
      const strings = [];
      let p = start;
      while (p < end) {
        const l = buf[p];
        if (p + 1 + l > end) throw new MdnsError('TXT string runs past the record');
        if (l) strings.push(buf.subarray(p + 1, p + 1 + l));
        p += 1 + l;
      }
      return strings;
    }
    case TYPE.A:
      if (len !== 4) throw new MdnsError('bad A record');
      return [...buf.subarray(start, end)].join('.');
    case TYPE.AAAA:
      if (len !== 16) throw new MdnsError('bad AAAA record');
      return ipv6String(buf.subarray(start, end));
    default: return buf.subarray(start, end);
  }
}

export function decodePacket(buf) {
  if (buf.length < 12) throw new MdnsError('short DNS packet');
  const flags = buf.readUInt16BE(2);
  const counts = [4, 6, 8, 10].map((o) => buf.readUInt16BE(o));
  if (counts.reduce((a, b) => a + b, 0) > MAX_RECORDS) throw new MdnsError('too many records');
  let pos = 12;
  const questions = [];
  for (let i = 0; i < counts[0]; i++) {
    const { name, end } = decodeName(buf, pos);
    if (end + 4 > buf.length) throw new MdnsError('truncated question');
    const cls = buf.readUInt16BE(end + 2);
    questions.push({ name, type: buf.readUInt16BE(end), unicast: Boolean(cls & QU) });
    pos = end + 4;
  }
  const records = [];
  for (let i = 0; i < counts[1] + counts[2] + counts[3]; i++) {
    const { name, end } = decodeName(buf, pos);
    if (end + 10 > buf.length) throw new MdnsError('truncated record');
    const type = buf.readUInt16BE(end);
    const cls = buf.readUInt16BE(end + 2);
    const ttl = buf.readUInt32BE(end + 4);
    const len = buf.readUInt16BE(end + 8);
    if (end + 10 + len > buf.length) throw new MdnsError('record data runs past the packet');
    let data = null;
    if ([TYPE.PTR, TYPE.SRV, TYPE.TXT, TYPE.A, TYPE.AAAA].includes(type)) data = decodeRdata(buf, type, end + 10, len);
    records.push({ name, type, flush: Boolean(cls & FLUSH), ttl, data });
    pos = end + 10 + len;
  }
  return { id: buf.readUInt16BE(0), response: Boolean(flags & 0x8000), questions, records };
}

export function parseTxt(strings) {
  const out = new Map();
  for (const s of strings.slice(0, 64)) {
    const eq = s.indexOf(0x3d);
    if (eq <= 0) continue;
    const key = s.subarray(0, eq).toString('latin1').toLowerCase();
    if (out.has(key)) continue;
    let value;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(s.subarray(eq + 1));
    } catch {
      continue;
    }
    out.set(key, value);
  }
  return out;
}

const PCHAR = "(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})";
const PATH_ABSOLUTE = new RegExp(`^/(?:${PCHAR}+(?:/${PCHAR}*)*)?$`);

export function isValidPath(path) {
  return typeof path === 'string' && path.length <= MAX_PATH_LENGTH && PATH_ABSOLUTE.test(path);
}

export function isUsableAddress(address, { allowLoopback = false } = {}) {
  const v = net.isIP(address);
  if (v === 4) {
    const a = Number(address.split('.')[0]);
    if (a === 0 || a >= 224) return false;
    return a !== 127 || allowLoopback;
  }
  if (v === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower.startsWith('ff') || lower.includes('%')) return false;
    if (lower === '::1') return allowLoopback;
    return !lower.startsWith('fe80');
  }
  return false;
}

export function buildUrl(address, port, path, opts = {}) {
  if (!isUsableAddress(address, opts) || !Number.isInteger(port) || port < 1 || port > 65535 || !isValidPath(path)) return null;
  const host = net.isIP(address) === 6 ? `[${address}]` : address;
  return `ws://${host}:${port}${path}`;
}

export function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (!a.internal && a.family === 'IPv4') out.push(a.address);
    }
  }
  return out;
}

function flushStale(host, keep, now) {
  for (const [addr, v] of host) {
    if (addr !== keep && now - v.seen > 1000) host.delete(addr);
  }
}

function hostLabel(seed) {
  return `velvet-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8)}`;
}

export class SendspinDiscovery extends EventEmitter {
  #socket = null;
  #transport;
  #log;
  #advert = null;
  #browseType;
  #instances = new Map();
  #hosts = new Map();
  #queryTimer = null;
  #queryInterval = 1000;
  #expiryTimer = null;
  #allowLoopback;
  #addresses;
  #lastQuery = new Map();

  constructor({ browse = CLIENT_SERVICE, transport = null, logger = winston, allowLoopback = false, addresses = localAddresses } = {}) {
    super();
    this.#browseType = browse;
    this.#transport = transport;
    this.#log = logger;
    this.#allowLoopback = allowLoopback;
    this.#addresses = addresses;
  }

  get instances() {
    return [...this.#instances.values()].filter((i) => i.url).map((i) => this.#describe(i));
  }

  async start() {
    if (!this.#transport) this.#transport = await this.#openSocket();
    this.#expiryTimer = setInterval(() => this.#expire(), 5000);
    this.#expiryTimer.unref?.();
    if (this.#browseType) this.#scheduleQuery(0);
  }

  async #openSocket() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (msg, rinfo) => this.handlePacket(msg, rinfo));
    socket.on('error', (err) => this.#log.warn(`[sendspin] mDNS socket error: ${err.message}`));
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(MDNS_PORT, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    socket.setMulticastTTL(255);
    socket.setMulticastLoopback(true);
    let joined = 0;
    for (const addr of this.#addresses()) {
      try {
        socket.addMembership(MDNS_ADDRESS, addr);
        joined++;
      } catch (err) {
        this.#log.debug(`[sendspin] mDNS join on ${addr} failed: ${err.message}`);
      }
    }
    if (!joined) socket.addMembership(MDNS_ADDRESS);
    this.#socket = socket;
    return {
      send: (buf, address = MDNS_ADDRESS, port = MDNS_PORT) => socket.send(buf, port, address),
      close: () => socket.close(),
    };
  }

  advertise({ instance, port, path, name, service = SERVER_SERVICE }) {
    if (!isValidPath(path)) throw new MdnsError('advertised path must be an absolute path');
    const label = String(instance).slice(0, 63);
    const fqdn = `${escapeLabel(label)}.${service}`;
    const host = `${hostLabel(label)}.local`;
    const txt = [`path=${path}`];
    if (name) txt.push(`name=${Buffer.from(String(name), 'utf8').subarray(0, 200).toString('utf8')}`);
    this.#advert = { service, fqdn, host, port, txt };
    this.#announce(TTL_SHARED);
    setTimeout(() => this.#advert && this.#announce(TTL_SHARED), 1000).unref?.();
  }

  #advertRecords(ttlShared) {
    const a = this.#advert;
    const hostTtl = ttlShared === 0 ? 0 : TTL_HOST;
    return {
      ptr: { name: a.service, type: TYPE.PTR, ttl: ttlShared, data: a.fqdn },
      meta: { name: SERVICES_META, type: TYPE.PTR, ttl: ttlShared, data: a.service },
      srv: { name: a.fqdn, type: TYPE.SRV, ttl: hostTtl, flush: true, data: { port: a.port, target: a.host } },
      txt: { name: a.fqdn, type: TYPE.TXT, ttl: ttlShared, flush: true, data: a.txt },
      addrs: this.#addresses().map((ip) => ({ name: a.host, type: TYPE.A, ttl: hostTtl, flush: true, data: ip })),
    };
  }

  #announce(ttl) {
    const r = this.#advertRecords(ttl);
    this.#send(encodePacket({ response: true, answers: [r.ptr, r.srv, r.txt, ...r.addrs] }));
  }

  #send(buf, address, port) {
    try {
      this.#transport?.send(buf, address, port);
    } catch (err) {
      this.#log.debug(`[sendspin] mDNS send failed: ${err.message}`);
    }
  }

  handlePacket(buf, rinfo = {}) {
    let packet;
    try {
      packet = decodePacket(buf);
    } catch (err) {
      this.#log.debug(`[sendspin] ignoring malformed mDNS packet: ${err.message}`);
      return;
    }
    if (packet.response) {
      if (rinfo.port !== undefined && rinfo.port !== MDNS_PORT) return;
      this.#onResponse(packet.records);
    } else if (this.#advert) this.#onQuery(packet, rinfo);
  }

  #answerFor(q, r) {
    const a = this.#advert;
    const key = nameKey(q.name);
    const is = (...types) => q.type === TYPE.ANY || types.includes(q.type);
    if (key === nameKey(a.service) && is(TYPE.PTR)) return [[r.ptr], [r.srv, r.txt, ...r.addrs]];
    if (key === nameKey(SERVICES_META) && is(TYPE.PTR)) return [[r.meta], []];
    if (key === nameKey(a.fqdn)) return [[...(is(TYPE.SRV) ? [r.srv] : []), ...(is(TYPE.TXT) ? [r.txt] : [])], r.addrs];
    if (key === nameKey(a.host) && is(TYPE.A)) return [r.addrs, []];
    return null;
  }

  #onQuery(packet, rinfo) {
    const r = this.#advertRecords(TTL_SHARED);
    const answers = new Set();
    const additionals = new Set();
    let unicast = false;
    for (const q of packet.questions) {
      const hit = this.#answerFor(q, r);
      if (!hit) continue;
      hit[0].forEach((x) => answers.add(x));
      hit[1].forEach((x) => additionals.add(x));
      unicast ||= q.unicast;
    }
    if (!answers.size) return;
    const out = encodePacket({ response: true, answers: [...answers], additionals: [...additionals].filter((x) => !answers.has(x)) });
    if (unicast && rinfo.address) this.#send(out, rinfo.address, rinfo.port);
    else this.#send(out);
  }

  #onPtr(rec, now, touched) {
    const ikey = nameKey(rec.data);
    if (!ikey.endsWith(`.${nameKey(this.#browseType)}`)) return;
    let inst = this.#instances.get(ikey);
    if (!inst) {
      if (rec.ttl === 0 || this.#instances.size >= MAX_INSTANCES) return;
      inst = { fqdn: rec.data, ptrExpires: 0, srv: null, txt: null, url: null };
      this.#instances.set(ikey, inst);
    }
    inst.ptrExpires = now + rec.ttl * 1000;
    touched.add(ikey);
  }

  #onServiceRecord(rec, now, touched) {
    const key = nameKey(rec.name);
    const inst = this.#instances.get(key);
    const value = rec.type === TYPE.SRV ? { ...rec.data } : { map: parseTxt(rec.data) };
    value.expires = now + rec.ttl * 1000;
    inst[rec.type === TYPE.SRV ? 'srv' : 'txt'] = rec.ttl === 0 ? null : value;
    touched.add(key);
  }

  #onAddress(rec, now, touched) {
    const key = nameKey(rec.name);
    let host = this.#hosts.get(key);
    if (!host) {
      if (rec.ttl === 0 || this.#hosts.size >= MAX_HOSTS) return;
      host = new Map();
      this.#hosts.set(key, host);
    }
    if (rec.flush) flushStale(host, rec.data, now);
    if (rec.ttl === 0) host.delete(rec.data);
    else host.set(rec.data, { expires: now + rec.ttl * 1000, seen: now });
    for (const [ikey, inst] of this.#instances) {
      if (inst.srv && nameKey(inst.srv.target) === key) touched.add(ikey);
    }
  }

  #onResponse(records) {
    const now = Date.now();
    const touched = new Set();
    const typeKey = this.#browseType ? nameKey(this.#browseType) : null;
    for (const rec of records) {
      if (rec.type === TYPE.PTR && typeKey && nameKey(rec.name) === typeKey && typeof rec.data === 'string') this.#onPtr(rec, now, touched);
      else if ((rec.type === TYPE.SRV || rec.type === TYPE.TXT) && this.#instances.has(nameKey(rec.name))) this.#onServiceRecord(rec, now, touched);
      else if (rec.type === TYPE.A || rec.type === TYPE.AAAA) this.#onAddress(rec, now, touched);
    }
    for (const ikey of touched) this.#evaluate(ikey);
  }

  #describe(inst) {
    const label = splitName(inst.fqdn)[0];
    return { instance: label, fqdn: inst.fqdn, name: inst.txt?.map.get('name') ?? null, url: inst.url, path: inst.txt?.map.get('path') ?? null, port: inst.srv?.port ?? null };
  }

  #pickAddress(target) {
    const host = this.#hosts.get(nameKey(target));
    if (!host) return null;
    const addrs = [...host.keys()].filter((a) => isUsableAddress(a, { allowLoopback: this.#allowLoopback }));
    return addrs.find((a) => net.isIP(a) === 4) ?? addrs[0] ?? null;
  }

  #urlFor(inst) {
    if (!inst.srv || !inst.txt) return null;
    const path = inst.txt.map.get('path');
    const address = this.#pickAddress(inst.srv.target);
    if (!address || path === undefined) return null;
    return buildUrl(address, inst.srv.port, path, { allowLoopback: this.#allowLoopback });
  }

  #evaluate(ikey) {
    const inst = this.#instances.get(ikey);
    if (!inst) return;
    if (inst.ptrExpires <= Date.now()) {
      this.#instances.delete(ikey);
      this.#lastQuery.delete(ikey);
      if (inst.url) this.emit('lost', this.#describe(inst));
      return;
    }
    const url = this.#urlFor(inst);
    const prev = inst.url;
    inst.url = url;
    if (url && url !== prev) this.emit('found', this.#describe(inst), prev);
    if (!url && prev) this.emit('lost', { ...this.#describe(inst), url: prev });
    if (!url) this.#resolveMissing(inst);
  }

  #resolveMissing(inst) {
    const key = nameKey(inst.fqdn);
    const last = this.#lastQuery.get(key) ?? 0;
    if (Date.now() - last < 1000) return;
    this.#lastQuery.set(key, Date.now());
    const questions = [];
    if (!inst.srv) questions.push({ name: inst.fqdn, type: TYPE.SRV });
    if (!inst.txt) questions.push({ name: inst.fqdn, type: TYPE.TXT });
    if (inst.srv && !this.#pickAddress(inst.srv.target)) questions.push({ name: inst.srv.target, type: TYPE.A });
    if (questions.length) this.#send(encodePacket({ questions }));
  }

  #scheduleQuery(delay) {
    this.#queryTimer = setTimeout(() => {
      this.query();
      this.#queryInterval = Math.min(this.#queryInterval * 2, QUERY_MAX_INTERVAL_MS);
      this.#scheduleQuery(this.#queryInterval);
    }, delay);
    this.#queryTimer.unref?.();
  }

  query() {
    if (this.#browseType) this.#send(encodePacket({ questions: [{ name: this.#browseType, type: TYPE.PTR }] }));
  }

  #expire() {
    const now = Date.now();
    for (const [key, host] of this.#hosts) {
      for (const [addr, v] of host) if (v.expires <= now) host.delete(addr);
      if (!host.size) this.#hosts.delete(key);
    }
    for (const [ikey, inst] of this.#instances) {
      if (inst.srv && inst.srv.expires <= now) inst.srv = null;
      if (inst.txt && inst.txt.expires <= now) inst.txt = null;
      this.#evaluate(ikey);
    }
  }

  async stop() {
    clearTimeout(this.#queryTimer);
    clearInterval(this.#expiryTimer);
    if (this.#advert) {
      this.#announce(0);
      this.#advert = null;
    }
    const t = this.#transport;
    this.#transport = null;
    if (t) await new Promise((resolve) => setTimeout(() => { t.close(); resolve(); }, this.#socket ? 50 : 0));
    this.#socket = null;
  }
}
