import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import * as config from '../src/state/config.js';
import { isPrivateLan, sonosHttpGet } from '../src/sendspin/sonos.js';
import { clampGainDb } from '../src/sendspin/audio.js';
import { startPairing, _sweepExpired } from '../src/api/auth-pair.js';

describe('N130: isPrivateLan accepts only full RFC 1918 dotted quads', () => {
  it('accepts the three private ranges', () => {
    for (const ip of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.20']) assert.equal(isPrivateLan(ip), true, ip);
  });
  it('refuses 3- and 5-part strings, public and out-of-range addresses', () => {
    for (const ip of ['10.1.2', '192.168.1.2.3', '172.16.1.1.1', '172.15.0.1', '172.32.0.1', '8.8.8.8', '192.168.1.256', '127.0.0.1', '::1', '', null, 'sonos.local']) {
      assert.equal(isPrivateLan(ip), false, String(ip));
    }
  });
});

describe('N131: sonosHttpGet caps the body and refuses public hosts', () => {
  let srv, port;
  before(async () => {
    srv = http.createServer((req, res) => {
      if (req.url === '/big') { res.write('x'.repeat(64 * 1024)); res.end('x'.repeat(64 * 1024)); return; }
      res.end('<root>ok</root>');
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    port = srv.address().port;
  });
  after(() => new Promise(r => srv.close(r)));
  const allowHost = () => true;

  it('returns status and body for a small answer', async () => {
    const r = await sonosHttpGet({ ip: '127.0.0.1', port, path: '/x', allowHost });
    assert.deepEqual(r, { status: 200, body: '<root>ok</root>' });
  });
  it('aborts an answer over maxBytes', async () => {
    await assert.rejects(sonosHttpGet({ ip: '127.0.0.1', port, path: '/big', maxBytes: 1024, allowHost }), /exceeded 1024 bytes/);
  });
  it('refuses a non-private host before connecting', async () => {
    await assert.rejects(sonosHttpGet({ ip: '8.8.8.8', path: '/x' }), /not a private LAN address/);
  });
});

describe('N045: clampGainDb', () => {
  it('clamps to -30..+20 dB and drops non-finite values', () => {
    assert.equal(clampGainDb(60), 20);
    assert.equal(clampGainDb(-90), -30);
    assert.equal(clampGainDb(-6.5), -6.5);
    assert.equal(clampGainDb(Number.NaN), null);
    assert.equal(clampGainDb(Infinity), null);
  });
});

describe('N129: pair/start is capped globally (the per-IP limit is covered in fix-v-F-routes)', () => {
  it('refuses new pairings once 1000 are open', () => {
    _sweepExpired(Date.now() + 10 * 60_000);
    for (let i = 0; i < 1000; i++) assert.ok(startPairing());
    assert.equal(startPairing(), null);
    _sweepExpired(Date.now() + 10 * 60_000);
    assert.ok(startPairing(), 'room again once the old ones expired');
  });
});

describe('N043: Sonos stream URLs carry a per-file stream token', () => {
  let tmp, sonos;
  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'velvet-vF-'));
    const cfgFile = path.join(tmp, 'config.json');
    await fs.writeFile(cfgFile, JSON.stringify({
      secret: 'test-secret-vF',
      storage: { dbDirectory: path.join(tmp, 'db'), albumArtDirectory: path.join(tmp, 'img'), logsDirectory: path.join(tmp, 'logs') },
    }));
    await config.setup(cfgFile);
    sonos = await import('../src/api/sonos.js');
  });
  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
  });

  const tokenOf = (url) => new URL(url).searchParams.get('token');

  it('a /media URL token is scoped to that one file and expires', () => {
    const url = sonos._resolveStreamUrl({ vpath: 'Music', filepath: 'A/b c.flac' }, 'http://10.0.0.2:3001', 'alice');
    assert.match(url, /^http:\/\/10\.0\.0\.2:3001\/media\/Music\/A\/b%20c\.flac\?token=/);
    const claims = jwt.verify(tokenOf(url), config.program.secret);
    assert.equal(claims.username, 'alice');
    assert.equal(claims.scope, 'stream');
    assert.equal(claims.fp, 'Music/A/b c.flac');
    assert.ok(claims.exp - claims.iat <= 8 * 3600);
  });

  it('carries the user\'s tokenVersion, so it survives a password change made before the cast', () => {
    config.program.users = { alice: { vpaths: ['Music'], tokenVersion: 3 } };
    try {
      const url = sonos._resolveStreamUrl({ vpath: 'Music', filepath: 'a.mp3' }, 'http://10.0.0.2:3001', 'alice');
      assert.equal(jwt.verify(tokenOf(url), config.program.secret).tv, 3);
    } finally {
      config.program.users = {};
    }
  });

  it('a transcode-stream URL token names the same fp as the query', () => {
    config.program.sonos = { transcodeOpus: true };
    const url = sonos._resolveStreamUrl({ vpath: 'Music', filepath: 'x.opus' }, 'http://10.0.0.2:3001', 'alice', 30);
    const u = new URL(url);
    assert.equal(u.pathname, '/api/v1/sonos/transcode-stream');
    assert.equal(u.searchParams.get('fp'), 'Music/x.opus');
    const claims = jwt.verify(u.searchParams.get('token'), config.program.secret);
    assert.equal(claims.scope, 'stream');
    assert.equal(claims.fp, 'Music/x.opus');
  });
});
