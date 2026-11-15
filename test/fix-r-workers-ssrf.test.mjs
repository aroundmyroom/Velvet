// SSRF guard: names are judged by DNS, not by their first letters, and
// safeFetch connects to the address it checked (P143).
//
// Run with:
//   node --test test/fix-r-workers-ssrf.test.mjs

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import { isPrivateHost, safeFetch } from '../src/util/ssrf-check.js';

const realLookup = dns.lookup;
afterEach(() => { dns.lookup = realLookup; });

describe('isPrivateHost', () => {
  it('lets public names through that start like a private prefix', () => {
    for (const h of ['fdroid.org', 'fcbarcelona.com', 'febreze.com', 'fe80.example.com', '10.example.com', '127.0.0.1.nip.example', '192.168.example.org', 'fc::1']) {
      assert.equal(isPrivateHost(h), false, h);
    }
  });

  it('still blocks private IP literals in every spelling', () => {
    for (const h of ['fd00::1', '[fe80::1]', '[FEBF::1]', '10.0.0.1', '127.0.0.1', '0.0.0.0', '169.254.169.254', '::1', '[0:0:0:0:0:0:0:1]', '::ffff:10.0.0.1', new URL('http://[::ffff:127.0.0.1]/').hostname, 'localhost', 'a.localhost']) {
      assert.equal(isPrivateHost(h), true, h);
    }
  });

  it('keeps public IP literals public', () => {
    for (const h of ['8.8.8.8', '172.32.0.1', '[2606:4700::6810:84e5]', '::ffff:8.8.8.8', 'fec0::1']) {
      assert.equal(isPrivateHost(h), false, h);
    }
  });
});

describe('safeFetch', () => {
  it('refuses a name whose DNS answer is loopback, at connect time', async () => {
    const srv = http.createServer((req, res) => res.end('secret'));
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address();
    let lookups = 0;
    dns.lookup = (host, opts, cb) => {
      lookups++;
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      if (host !== 'rebind.example') return realLookup(host, opts, cb);
      const a = { address: '127.0.0.1', family: 4 };
      return opts?.all ? cb(null, [a]) : cb(null, a.address, a.family);
    };
    try {
      assert.equal(isPrivateHost('rebind.example'), false);
      await assert.rejects(safeFetch(`http://rebind.example:${port}/`), /private/);
      assert.ok(lookups >= 1);
    } finally {
      srv.close();
    }
  });

  it('refuses private literals and other schemes', async () => {
    await assert.rejects(safeFetch('http://10.0.0.1/'), /private/);
    await assert.rejects(safeFetch('http://[fd00::1]/'), /private/);
    await assert.rejects(safeFetch('ftp://example.com/'), /http or https/);
  });
});
