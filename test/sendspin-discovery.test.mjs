/* eslint-disable sonarjs/no-hardcoded-ip, sonarjs/no-clear-text-protocols -- LAN addresses are the test data; Sendspin mandates ws:// */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SendspinDiscovery, encodePacket, decodePacket, parseTxt, isValidPath, isUsableAddress, buildUrl, TYPE,
  CLIENT_SERVICE, SERVER_SERVICE, MdnsError,
} from '../src/sendspin/discovery.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const LAN = '192.168.1.40';
const RINFO = { address: LAN, port: 5353 };

function fakeBus() {
  const endpoints = [];
  return {
    endpoint(address) {
      const ep = { node: null };
      ep.transport = {
        send(buf) {
          for (const other of endpoints) if (other !== ep && other.node) other.node.handlePacket(buf, { address, port: 5353 });
        },
        close() {},
      };
      endpoints.push(ep);
      return ep;
    },
  };
}

function clientResponse({ instance = 'abc', path = '/sendspin', name = 'Kitchen', port = 8928, address = LAN, ttl = 120 } = {}) {
  const fqdn = `${instance}.${CLIENT_SERVICE}`;
  const host = `${instance}.local`;
  const txt = [];
  if (path !== null) txt.push(`path=${path}`);
  if (name !== null) txt.push(`name=${name}`);
  return encodePacket({
    response: true,
    answers: [{ name: CLIENT_SERVICE, type: TYPE.PTR, ttl, data: fqdn }],
    additionals: [
      { name: fqdn, type: TYPE.SRV, ttl, flush: true, data: { port, target: host } },
      { name: fqdn, type: TYPE.TXT, ttl, flush: true, data: txt },
      { name: host, type: TYPE.A, ttl, flush: true, data: address },
    ],
  });
}

function browser(opts = {}) {
  const sent = [];
  const d = new SendspinDiscovery({ logger: quiet, transport: { send: (b) => sent.push(b), close() {} }, addresses: () => [LAN], ...opts });
  d.sent = sent;
  return d;
}

test('DNS packet round trip with compression-free names, all record types', () => {
  const pkt = encodePacket({
    response: true,
    answers: [
      { name: SERVER_SERVICE, type: TYPE.PTR, ttl: 4500, data: `my\\.server.${SERVER_SERVICE}` },
      { name: `x.${SERVER_SERVICE}`, type: TYPE.SRV, ttl: 120, flush: true, data: { port: 8927, target: 'velvet.local' } },
      { name: `x.${SERVER_SERVICE}`, type: TYPE.TXT, ttl: 4500, data: ['path=/sendspin', 'name=Velvet ✓'] },
      { name: 'velvet.local', type: TYPE.A, ttl: 120, data: '10.0.0.2' },
      { name: 'velvet.local', type: TYPE.AAAA, ttl: 120, data: 'fd00::1:2' },
    ],
  });
  const d = decodePacket(pkt);
  assert.equal(d.response, true);
  assert.equal(d.records[0].data, `my\\.server.${SERVER_SERVICE}`);
  assert.deepEqual(d.records[1].data, { priority: 0, weight: 0, port: 8927, target: 'velvet.local' });
  assert.equal(d.records[1].flush, true);
  assert.equal(parseTxt(d.records[2].data).get('name'), 'Velvet ✓');
  assert.equal(d.records[3].data, '10.0.0.2');
  assert.equal(d.records[4].data, 'fd00::1:2');
  const q = decodePacket(encodePacket({ questions: [{ name: CLIENT_SERVICE, type: TYPE.PTR, unicast: true }] }));
  assert.deepEqual(q.questions, [{ name: CLIENT_SERVICE, type: TYPE.PTR, unicast: true }]);
});

test('decoder resists pointer loops, truncation and oversized counts', () => {
  const loop = Buffer.from([0, 0, 0x84, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 12, 0, 1]);
  assert.throws(() => decodePacket(loop), MdnsError);
  assert.throws(() => decodePacket(Buffer.alloc(5)), MdnsError);
  const many = Buffer.alloc(12);
  many.writeUInt16BE(0xffff, 6);
  assert.throws(() => decodePacket(many), MdnsError);
  const good = clientResponse();
  for (let cut = 13; cut < good.length; cut += 7) assert.throws(() => decodePacket(good.subarray(0, cut)), MdnsError);
});

test('TXT parsing: first key wins, case-insensitive keys, bad UTF-8 skipped', () => {
  const m = parseTxt([Buffer.from('Path=/a'), Buffer.from('path=/b'), Buffer.from('flag'), Buffer.from([0x6e, 0x3d, 0xff]), Buffer.from('=x')]);
  assert.equal(m.get('path'), '/a');
  assert.equal(m.has('flag'), false);
  assert.equal(m.has('n'), false);
});

test('path validation follows RFC 3986 path-absolute', () => {
  for (const p of ['/', '/sendspin', '/a/b', '/a%20b', "/x:y@z!$&'()*+,;="]) assert.ok(isValidPath(p), p);
  for (const p of ['', 'sendspin', '//host/x', '/a b', '/a\nb', '/%zz', '/a?b', '/a#b', `/${'a'.repeat(300)}`, null, 5]) assert.equal(isValidPath(p), false, String(p));
});

test('URL building rejects loopback, unspecified, multicast and bad ports', () => {
  assert.equal(buildUrl(LAN, 8928, '/sendspin'), `ws://${LAN}:8928/sendspin`);
  assert.equal(buildUrl('fd00::5', 8928, '/s'), 'ws://[fd00::5]:8928/s');
  for (const a of ['127.0.0.1', '0.0.0.0', '224.0.0.251', '::1', '::', 'fe80::1', 'host.local']) assert.equal(buildUrl(a, 8928, '/s'), null, a);
  assert.equal(buildUrl('127.0.0.1', 8928, '/s', { allowLoopback: true }), 'ws://127.0.0.1:8928/s');
  assert.equal(buildUrl(LAN, 0, '/s'), null);
  assert.equal(buildUrl(LAN, 8928, 'bad'), null);
  assert.equal(isUsableAddress('10.1.2.3'), true);
});

test('browser emits found, update and lost from responses', async () => {
  const d = browser();
  await d.start();
  const events = [];
  d.on('found', (s, prev) => events.push(['found', s.url, s.name, prev]));
  d.on('lost', (s) => events.push(['lost', s.url]));
  d.handlePacket(clientResponse(), RINFO);
  assert.deepEqual(events.shift(), ['found', `ws://${LAN}:8928/sendspin`, 'Kitchen', null]);
  d.handlePacket(clientResponse(), RINFO);
  assert.equal(events.length, 0, 'unchanged service emits nothing');
  d.handlePacket(clientResponse({ port: 9000 }), RINFO);
  assert.deepEqual(events.shift(), ['found', `ws://${LAN}:9000/sendspin`, 'Kitchen', `ws://${LAN}:8928/sendspin`]);
  assert.equal(d.instances.length, 1);
  d.handlePacket(clientResponse({ port: 9000, ttl: 0 }), RINFO);
  assert.deepEqual(events.shift(), ['lost', `ws://${LAN}:9000/sendspin`]);
  assert.equal(d.instances.length, 0);
  await d.stop();
});

test('browser ignores invalid paths, loopback addresses and foreign source ports', async () => {
  const d = browser();
  await d.start();
  const found = [];
  d.on('found', (s) => found.push(s));
  d.handlePacket(clientResponse({ instance: 'a', path: 'nope' }), RINFO);
  d.handlePacket(clientResponse({ instance: 'b', path: null }), RINFO);
  d.handlePacket(clientResponse({ instance: 'c', address: '127.0.0.1' }), RINFO);
  d.handlePacket(clientResponse({ instance: 'd' }), { address: LAN, port: 40000 });
  d.handlePacket(Buffer.from('garbage'), RINFO);
  assert.equal(found.length, 0);
  await d.stop();
});

test('browser queries for missing SRV/TXT and address records', async () => {
  const d = browser();
  await d.start();
  d.sent.length = 0;
  d.handlePacket(encodePacket({ response: true, answers: [{ name: CLIENT_SERVICE, type: TYPE.PTR, ttl: 120, data: `z.${CLIENT_SERVICE}` }] }), RINFO);
  const q = decodePacket(d.sent.at(-1));
  assert.deepEqual(q.questions.map((x) => x.type), [TYPE.SRV, TYPE.TXT]);
  await d.stop();
});

test('advertiser answers PTR queries; a browser on the same bus finds it', async () => {
  const bus = fakeBus();
  const advEp = bus.endpoint('192.168.1.10');
  const brEp = bus.endpoint(LAN);
  const advD = new SendspinDiscovery({ logger: quiet, browse: null, transport: advEp.transport, addresses: () => ['192.168.1.10'] });
  const brD = new SendspinDiscovery({ logger: quiet, browse: SERVER_SERVICE, transport: brEp.transport, addresses: () => [LAN] });
  advEp.node = advD;
  brEp.node = brD;
  await brD.start();
  await advD.start();
  advD.advertise({ instance: 'server-id', port: 8927, path: '/sendspin', name: 'Velvet' });
  assert.equal(brD.instances.length, 1, 'announcement alone is enough');
  const found = new Promise((resolve) => brD.once('found', resolve));
  brD.handlePacket(encodePacket({ response: true, answers: [{ name: SERVER_SERVICE, type: TYPE.PTR, ttl: 0, data: `server-id.${SERVER_SERVICE}` }] }), RINFO);
  assert.equal(brD.instances.length, 0);
  brD.query();
  const svc = await found;
  assert.equal(svc.url, 'ws://192.168.1.10:8927/sendspin');
  assert.equal(svc.name, 'Velvet');
  assert.equal(svc.instance, 'server-id');
  const lost = new Promise((resolve) => brD.once('lost', resolve));
  await advD.stop();
  assert.equal((await lost).url, 'ws://192.168.1.10:8927/sendspin');
  await brD.stop();
});

test('advertise rejects an invalid path', () => {
  const d = browser({ browse: null });
  assert.throws(() => d.advertise({ instance: 'x', port: 1, path: 'relative' }), MdnsError);
});
