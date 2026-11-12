import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { encodeKeyId } from '../src/sendspin/keys.js';
import { generateStaticKeyPair } from '../src/sendspin/noise.js';
import { SendspinServer, MAX_PENDING_PER_ADDRESS, MAX_UNTRUSTED_PER_ADDRESS } from '../src/sendspin/server.js';
import { TestClient } from './helpers/sendspin-test-client.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const HOST = '127.0.0.1';
const FLOODER = '127.0.0.2';
const OTHER = '127.0.0.3';

// Telling peers apart needs more than one loopback address (Linux routes all of 127/8; macOS does not by default).
async function multiLoopback() {
  const srv = net.createServer((s) => s.destroy());
  await new Promise((r) => srv.listen(0, HOST, r));
  try {
    return await new Promise((resolve) => {
      const s = net.connect({ host: HOST, port: srv.address().port, localAddress: FLOODER });
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
  } finally {
    srv.close();
  }
}
const skip = (await multiLoopback()) ? false : 'needs 127.0.0.2/127.0.0.3 as local addresses';

async function makeServer(t, opts = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-admission-'));
  const server = new SendspinServer({ dataDir, host: HOST, port: 0, logger: quiet, ...opts });
  await server.start();
  t.after(async () => {
    await server.stop();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  return server;
}

function rawSocket(t, port, localAddress) {
  const ws = new WebSocket(`ws://${HOST}:${port}/sendspin`, { localAddress });
  t.after(() => ws.terminate());
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  return new Promise((resolve) => {
    ws.once('open', () => resolve({ ws, closed, ok: true }));
    ws.once('error', () => resolve({ ws, closed, ok: false }));
  });
}

async function client(t, port, localAddress, opts = {}) {
  const c = new TestClient(opts);
  await c.dial(`ws://${HOST}:${port}/sendspin`, { localAddress });
  t.after(() => c.close());
  return c;
}

function settle(c) {
  const connected = c.connect();
  connected.catch(() => {});
  return Promise.race([connected.then((act) => ({ act })), c.closed.then((code) => ({ code }))]);
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test('one address opening idle sockets cannot lock out another speaker', { skip }, async (t) => {
  const server = await makeServer(t);
  const flood = await Promise.all(Array.from({ length: 40 }, () => rawSocket(t, server.port, FLOODER)));
  assert.equal(flood.filter((s) => s.ok).length, MAX_PENDING_PER_ADDRESS, 'extra upgrades from one address refused');
  const started = Date.now();
  const c = await client(t, server.port, HOST);
  const r = await settle(c);
  assert.ok(r.act, 'second address completes the handshake');
  assert.ok(Date.now() - started < 1000, `handshake took ${Date.now() - started} ms`);
});

test('sockets that never send client/init are closed after the init timeout, freeing the slots', { skip }, async (t) => {
  const server = await makeServer(t, { initTimeoutMs: 200 });
  const idle = await Promise.all(Array.from({ length: MAX_PENDING_PER_ADDRESS + 1 }, () => rawSocket(t, server.port, FLOODER)));
  assert.equal(idle.filter((s) => s.ok).length, MAX_PENDING_PER_ADDRESS);
  const started = Date.now();
  await Promise.all(idle.filter((s) => s.ok).map((s) => s.closed));
  assert.ok(Date.now() - started < 2000, 'closed by the init timeout, not the 30 s handshake timeout');
  await tick();
  assert.equal((await rawSocket(t, server.port, FLOODER)).ok, true);
});

test('closing a pending socket frees its slot', { skip }, async (t) => {
  const server = await makeServer(t);
  const held = await Promise.all(Array.from({ length: MAX_PENDING_PER_ADDRESS }, () => rawSocket(t, server.port, FLOODER)));
  assert.ok(held.every((s) => s.ok));
  assert.equal((await rawSocket(t, server.port, FLOODER)).ok, false);
  held[0].ws.terminate();
  await held[0].closed;
  await tick();
  assert.equal((await rawSocket(t, server.port, FLOODER)).ok, true);
});

test('a client that completed client/hello no longer holds a pending slot', { skip }, async (t) => {
  const server = await makeServer(t, { maxUntrustedPerAddress: 16 });
  for (let i = 0; i < MAX_PENDING_PER_ADDRESS + 2; i++) {
    const c = await client(t, server.port, FLOODER);
    assert.ok((await settle(c)).act);
  }
});

test('untrusted clients are capped per address; approved ones and other addresses are not', { skip }, async (t) => {
  const server = await makeServer(t);
  const approved = generateStaticKeyPair();
  await server.approve(encodeKeyId(approved.publicKey));
  for (let i = 0; i < MAX_UNTRUSTED_PER_ADDRESS; i++) assert.ok((await settle(await client(t, server.port, FLOODER))).act);
  assert.equal((await settle(await client(t, server.port, FLOODER))).code, 1013, 'one untrusted too many from this address');
  const good = await settle(await client(t, server.port, FLOODER, { keyPair: approved }));
  assert.ok(good.act.payload.active_roles.includes('player@v1'));
  assert.ok((await settle(await client(t, server.port, HOST))).act);
});

test('the address of a trusted device is not capped while it reconnects', { skip }, async (t) => {
  const server = await makeServer(t);
  const keyPair = generateStaticKeyPair();
  await server.approve(encodeKeyId(keyPair.publicKey));
  const first = await client(t, server.port, OTHER, { keyPair });
  assert.ok((await settle(first)).act);
  first.close();
  await first.closed;
  const idle = await Promise.all(Array.from({ length: MAX_PENDING_PER_ADDRESS + 2 }, () => rawSocket(t, server.port, OTHER)));
  assert.ok(idle.every((s) => s.ok), 'pending cap not applied to a trusted address');
  const again = await settle(await client(t, server.port, OTHER, { keyPair }));
  assert.ok(again.act.payload.active_roles.includes('player@v1'));
});
