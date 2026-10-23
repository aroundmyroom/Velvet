/**
 * Regression tests for the issues fixed after the v0.7.0 opengrep scan.
 *
 * Run with:
 *   node --test test/security-hardening.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

describe('Jukebox session codes cannot resolve to Object.prototype members', () => {
  let srv;
  before(async () => { srv = await startServer({ waitForScan: false }); });
  after(async () => { await srv.stop(); });

  const post = (p, body) => fetch(srv.baseUrl + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  for (const code of ['__proto__', 'toString', 'constructor', 'hasOwnProperty']) {
    it(`update-now-playing rejects "${code}"`, async () => {
      const r = await post('/api/v1/jukebox/update-now-playing', { code, nowPlaying: { victim: { title: 'spoofed' } } });
      assert.equal(r.status, 404);
    });

    it(`update-playlist rejects "${code}"`, async () => {
      const r = await post('/api/v1/jukebox/update-playlist', { code, tracks: [], idx: 0 });
      assert.equal(r.status, 404);
    });

    it(`does-code-exist is false for "${code}"`, async () => {
      const r = await post('/api/v1/jukebox/does-code-exist', { code });
      assert.deepEqual(await r.json(), { status: false });
    });

    it(`/remote/${code} does not hand out a session`, async () => {
      const html = await (await fetch(`${srv.baseUrl}/remote/${encodeURIComponent(code)}`)).text();
      assert.doesNotMatch(html, /remoteProperties = \{"code"/);
    });
  }

  it('get-now-playing does not leak a spoofed prototype entry', async () => {
    await post('/api/v1/jukebox/update-now-playing', { code: '__proto__', nowPlaying: { victim: { title: 'spoofed' } } });
    const r = await fetch(`${srv.baseUrl}/api/v1/jukebox/get-now-playing?code=victim`);
    assert.equal(await r.json(), null);
  });

  it('push-to-client returns 404 for "toString" instead of throwing', async () => {
    const r = await post('/api/v1/jukebox/push-to-client', { code: 'toString', command: 'next' });
    assert.equal(r.status, 404);
  });
});

describe('Migration import routes only accept their own import ids', () => {
  let srv;
  before(async () => { srv = await startServer({ waitForScan: false }); });
  after(async () => { await srv.stop(); });

  for (const id of ['velvet-test-x', 'node-compile-cache', 'velvet-import-abc']) {
    it(`cleanup refuses "${id}"`, async () => {
      const r = await fetch(`${srv.baseUrl}/api/v1/admin/migrate/cleanup/${encodeURIComponent(id)}`, { method: 'POST' });
      assert.equal(r.status, 400);
    });

    it(`status refuses "${id}"`, async () => {
      const r = await fetch(`${srv.baseUrl}/api/v1/admin/migrate/status/${encodeURIComponent(id)}`);
      assert.equal(r.status, 400);
    });
  }

  it('apply refuses an id outside the import namespace', async () => {
    const r = await fetch(`${srv.baseUrl}/api/v1/admin/migrate/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'velvet-test-x' }),
    });
    assert.equal(r.status, 500);
    assert.match((await r.json()).error, /Invalid import id/);
  });
});

describe('SSRF guard (src/util/ssrf-check.js)', async () => {
  const { isPrivateHost, resolvesToPrivate, safeLookup, safeFetch } = await import('../src/util/ssrf-check.js');

  it('treats bracketed IPv6 literals from URL.hostname as private', () => {
    assert.equal(new URL('http://[::1]:3000/').hostname, '[::1]');
    assert.ok(isPrivateHost('[::1]'));
    assert.ok(isPrivateHost('[fd00::1]'));
    assert.ok(isPrivateHost('[::ffff:127.0.0.1]'));
  });

  it('blocks 0.0.0.0/8 and *.localhost', () => {
    assert.ok(isPrivateHost('0.0.0.0'));
    assert.ok(isPrivateHost(new URL('http://0/').hostname));
    assert.ok(isPrivateHost('anything.localhost'));
  });

  it('still allows public addresses', () => {
    assert.ok(!isPrivateHost('8.8.8.8'));
    assert.ok(!isPrivateHost('[2606:4700::6810:84e5]'));
  });

  it('URL normalisation of numeric hosts is caught', () => {
    assert.ok(isPrivateHost(new URL('http://2130706433/').hostname));
    assert.ok(isPrivateHost(new URL('http://0x7f.1/').hostname));
  });

  it('resolvesToPrivate follows DNS', async () => {
    assert.equal(await resolvesToPrivate('localhost'), true);
  });

  it('safeLookup refuses a name that resolves to loopback', async () => {
    const err = await new Promise(r => safeLookup('localhost', {}, e => r(e)));
    assert.equal(err?.code, 'ESSRF');
  });

  it('safeFetch refuses loopback and non-http schemes', async () => {
    await assert.rejects(safeFetch('http://localhost:1/'), /private/);
    await assert.rejects(safeFetch('http://[::1]:1/'), /private/);
    await assert.rejects(safeFetch('file:///etc/passwd'), /http or https/);
  });
});

describe('Art responses are sandboxed', () => {
  let srv;
  before(async () => { srv = await startServer({ waitForScan: false }); });
  after(async () => { await srv.stop(); });

  it('/album-art sends a sandbox CSP', async () => {
    const r = await fetch(`${srv.baseUrl}/album-art/does-not-exist.svg`);
    assert.match(r.headers.get('content-security-policy') || '', /sandbox/);
  });

  it('/api/v1/radio/art refuses loopback targets', async () => {
    const r = await fetch(`${srv.baseUrl}/api/v1/radio/art?url=${encodeURIComponent('http://[::1]:1/x.svg')}`);
    assert.equal(r.status, 403);
  });
});
