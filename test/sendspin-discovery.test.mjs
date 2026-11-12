/* eslint-disable sonarjs/no-hardcoded-ip, sonarjs/no-clear-text-protocols -- LAN addresses are the test data; Sendspin mandates ws:// */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SendspinDiscovery, encodePacket, decodePacket, parseTxt, isValidPath, isUsableAddress, buildUrl, TYPE,
  CLIENT_SERVICE, SERVER_SERVICE, MdnsError, normalizeAddress, onLocalSubnet, localAddresses6, ipv6Interfaces,
} from '../src/sendspin/discovery.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const LAN = '192.168.1.40';
const RINFO = { address: LAN, port: 5353 };
const SUBNETS = () => [{ address: LAN, netmask: '255.255.255.0' }];

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
  const d = new SendspinDiscovery({ logger: quiet, transport: { send: (b) => sent.push(b), close() {} }, addresses: () => [LAN], subnets: SUBNETS, ...opts });
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
  const advD = new SendspinDiscovery({ logger: quiet, browse: null, transport: advEp.transport, addresses: () => ['192.168.1.10'], subnets: SUBNETS });
  const brD = new SendspinDiscovery({ logger: quiet, browse: SERVER_SERVICE, transport: brEp.transport, addresses: () => [LAN], subnets: SUBNETS });
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

test('addresses: IPv4-mapped/compatible IPv6 is judged as IPv4; link-local, loopback, multicast, broadcast refused', () => {
  assert.equal(normalizeAddress('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(normalizeAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeAddress('::7f00:1'), '127.0.0.1');
  assert.equal(normalizeAddress('::ffff:c0a8:0128'), LAN);
  assert.equal(normalizeAddress('fe80::1%eth0'), null);
  for (const a of ['::ffff:7f00:1', '::ffff:127.0.0.1', '::7f00:1', '::127.0.0.1', '::ffff:a9fe:101', '169.254.10.20', '0.1.2.3',
    '255.255.255.255', '239.1.1.1', '240.0.0.1', '::', '::1', 'fe80::1', 'febf::1', 'ff02::fb', 'fe80::1%eth0']) {
    assert.equal(isUsableAddress(a), false, a);
    assert.equal(buildUrl(a, 8928, '/s'), null, a);
  }
  assert.equal(buildUrl('::ffff:c0a8:128', 8928, '/s'), `ws://${LAN}:8928/s`);
  assert.equal(isUsableAddress('::ffff:7f00:1', { allowLoopback: true }), true);
  const subnets = [{ address: LAN, netmask: '255.255.255.0' }, { address: 'fd00::1', netmask: 'ffff:ffff:ffff:ffff::' }];
  assert.equal(onLocalSubnet('192.168.1.200', subnets), true);
  assert.equal(onLocalSubnet('::ffff:192.168.1.200', subnets), true);
  assert.equal(onLocalSubnet('192.168.2.1', subnets), false);
  assert.equal(onLocalSubnet('fd00::abcd', subnets), true);
  assert.equal(onLocalSubnet('fd01::1', subnets), false);
  assert.equal(onLocalSubnet('8.8.8.8', []), false);
});

test('browser refuses mapped-loopback, link-local and off-subnet addresses', async () => {
  const d = browser();
  await d.start();
  const found = [];
  d.on('found', (s) => found.push(s.url));
  d.handlePacket(clientResponse({ instance: 'm' }), RINFO);
  const aaaa = (instance, address) => encodePacket({
    response: true,
    answers: [{ name: CLIENT_SERVICE, type: TYPE.PTR, ttl: 120, data: `${instance}.${CLIENT_SERVICE}` }],
    additionals: [
      { name: `${instance}.${CLIENT_SERVICE}`, type: TYPE.SRV, ttl: 120, flush: true, data: { port: 8928, target: `${instance}.local` } },
      { name: `${instance}.${CLIENT_SERVICE}`, type: TYPE.TXT, ttl: 120, flush: true, data: ['path=/sendspin'] },
      { name: `${instance}.local`, type: TYPE.AAAA, ttl: 120, flush: true, data: address },
    ],
  });
  d.handlePacket(aaaa('mapped', '::ffff:7f00:1'), RINFO);
  d.handlePacket(aaaa('compat', '::7f00:1'), RINFO);
  d.handlePacket(clientResponse({ instance: 'll', address: '169.254.3.4' }), RINFO);
  d.handlePacket(clientResponse({ instance: 'far', address: '10.9.8.7' }), RINFO);
  assert.deepEqual(found, [`ws://${LAN}:8928/sendspin`]);
  d.handlePacket(aaaa('lanmapped', '::ffff:c0a8:12d'), RINFO);
  assert.equal(found.at(-1), 'ws://192.168.1.45:8928/sendspin');
  await d.stop();
});

test('advertiser ignores unicast-response (QU) queries from off-subnet sources', async () => {
  const sent = [];
  const d = new SendspinDiscovery({
    logger: quiet, browse: null, subnets: SUBNETS, addresses: () => [LAN],
    transport: { send: (b, address, port) => sent.push({ address, port }), close() {} },
  });
  await d.start();
  d.advertise({ instance: 'srv', port: 8927, path: '/sendspin', name: 'Velvet' });
  sent.length = 0;
  const qu = encodePacket({ questions: [{ name: SERVER_SERVICE, type: TYPE.PTR, unicast: true }] });
  d.handlePacket(qu, { address: '203.0.113.9', port: 40000 });
  d.handlePacket(qu, { address: '::ffff:cb00:7109', port: 40000 });
  assert.equal(sent.length, 0, 'no answer to an off-link unicast query');
  d.handlePacket(qu, { address: '192.168.1.77', port: 40000 });
  assert.deepEqual(sent, [{ address: '192.168.1.77', port: 40000 }]);
  d.handlePacket(encodePacket({ questions: [{ name: SERVER_SERVICE, type: TYPE.PTR }] }), { address: '203.0.113.9', port: 5353 });
  assert.equal(sent.at(-1).address, undefined, 'multicast queries are still answered on the group');
  await d.stop();
});

const V6_SUBNETS = () => [...SUBNETS(), { address: 'fd00:1::1', netmask: 'ffff:ffff:ffff:ffff::' }];

function hostResponse(instance, records) {
  const fqdn = `${instance}.${CLIENT_SERVICE}`;
  return encodePacket({
    response: true,
    answers: [{ name: CLIENT_SERVICE, type: TYPE.PTR, ttl: 120, data: fqdn }],
    additionals: [
      { name: fqdn, type: TYPE.SRV, ttl: 120, flush: true, data: { port: 8928, target: `${instance}.local` } },
      { name: fqdn, type: TYPE.TXT, ttl: 120, flush: true, data: ['path=/sendspin'] },
      ...records.map(([type, data]) => ({ name: `${instance}.local`, type, ttl: 120, flush: true, data })),
    ],
  });
}

test('IPv6: AAAA-only hosts are dialed on an on-link global/ULA address; IPv4 is preferred when both exist', async () => {
  const d = browser({ subnets: V6_SUBNETS });
  await d.start();
  const found = [];
  d.on('found', (s) => found.push(s.url));
  d.handlePacket(hostResponse('v6', [[TYPE.AAAA, 'fd00:1::42']]), RINFO);
  d.handlePacket(hostResponse('dual', [[TYPE.AAAA, 'fd00:1::43'], [TYPE.A, '192.168.1.43']]), RINFO);
  d.handlePacket(hostResponse('offlink', [[TYPE.AAAA, 'fd00:2::1']]), RINFO);
  d.handlePacket(hostResponse('ll', [[TYPE.AAAA, 'fe80::1']]), RINFO);
  d.handlePacket(hostResponse('global', [[TYPE.AAAA, '2001:db8::1']]), RINFO);
  assert.deepEqual(found, ['ws://[fd00:1::42]:8928/sendspin', 'ws://192.168.1.43:8928/sendspin']);
  await d.stop();
});

test('IPv6: an AAAA cache-flush does not drop the A record of the same host', async () => {
  const d = browser({ subnets: V6_SUBNETS });
  await d.start();
  const events = [];
  d.on('found', (s) => events.push(['found', s.url]));
  d.on('lost', (s) => events.push(['lost', s.url]));
  d.handlePacket(hostResponse('h', [[TYPE.A, '192.168.1.50']]), RINFO);
  const realNow = Date.now;
  Date.now = () => realNow() + 5000;
  try {
    d.handlePacket(encodePacket({ response: true, answers: [{ name: 'h.local', type: TYPE.AAAA, ttl: 120, flush: true, data: 'fd00:1::50' }] }), RINFO);
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(events, [['found', 'ws://192.168.1.50:8928/sendspin']]);
  await d.stop();
});

test('IPv6: missing address records are asked for as A and AAAA', async () => {
  const d = browser();
  await d.start();
  d.handlePacket(hostResponse('noaddr', []), RINFO);
  const q = decodePacket(d.sent.at(-1));
  assert.deepEqual(q.questions.map((x) => [x.name, x.type]), [['noaddr.local', TYPE.A], ['noaddr.local', TYPE.AAAA]]);
  await d.stop();
});

test('IPv6: the advertiser adds AAAA records only when asked to, and answers AAAA host queries', async () => {
  const sent = [];
  const d = new SendspinDiscovery({
    logger: quiet, browse: null, subnets: V6_SUBNETS, addresses: () => [LAN], addresses6: () => ['fd00:1::1'],
    transport: { send: (b, address, port) => sent.push({ pkt: decodePacket(b), address, port }), close() {} },
  });
  await d.start();
  d.advertise({ instance: 'v4only', port: 8927, path: '/sendspin', name: 'Velvet' });
  assert.ok(sent.at(-1).pkt.records.every((r) => r.type !== TYPE.AAAA), 'no AAAA without ipv6');
  d.advertise({ instance: 'dual', port: 8927, path: '/sendspin', name: 'Velvet', ipv6: true });
  const ann = sent.at(-1).pkt.records;
  assert.deepEqual(ann.filter((r) => r.type === TYPE.AAAA).map((r) => r.data), ['fd00:1::1']);
  assert.deepEqual(ann.filter((r) => r.type === TYPE.A).map((r) => r.data), [LAN]);
  const host = ann.find((r) => r.type === TYPE.SRV).data.target;
  sent.length = 0;
  d.handlePacket(encodePacket({ questions: [{ name: host, type: TYPE.AAAA }] }), { address: 'fd00:1::9', port: 5353 });
  const r = sent.at(-1).pkt;
  assert.deepEqual(r.records.map((x) => x.type), [TYPE.AAAA, TYPE.A], 'AAAA answered, A as additional');
  sent.length = 0;
  const qu = encodePacket({ questions: [{ name: SERVER_SERVICE, type: TYPE.PTR, unicast: true }] });
  d.handlePacket(qu, { address: 'fe80::9%eth0', port: 40000 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].address, undefined, 'link-local QU source answered on the group');
  d.handlePacket(qu, { address: 'fd00:1::9', port: 40000 });
  assert.equal(sent.at(-1).address, 'fd00:1::9', 'on-link global source answered directly');
  d.handlePacket(qu, { address: 'fd00:2::9', port: 40000 });
  assert.equal(sent.length, 2, 'off-link IPv6 QU source ignored');
  await d.stop();
});

test('IPv6: local address helpers skip link-local and internal addresses', () => {
  for (const a of localAddresses6()) {
    assert.equal(isUsableAddress(a), true, a);
    assert.equal(a.startsWith('fe80'), false, a);
  }
  assert.ok(Array.isArray(ipv6Interfaces()));
});
