'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const login = async (srv, username, password) => {
  const r = await fetch(srv.baseUrl + '/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  return { status: r.status, body: await r.json() };
};
const get = async (srv, token, p) => {
  const r = await fetch(srv.baseUrl + p, { headers: { 'x-access-token': token } });
  return { status: r.status, body: await r.json() };
};

describe('v-P: /db/status counts only a child-only user\'s folders', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  const { ensureFixtures } = await import('../helpers/fixtures.mjs');
  let srv;

  before(async () => {
    const fixtures = await ensureFixtures();
    srv = await startServer({
      users: [
        { username: 'admin', password: 'pw-admin', vpaths: ['testlib', 'kidsA'] },
        { username: 'kid', password: 'pw-kid', admin: false, vpaths: ['kidsA'] },
      ],
      extraFolders: { kidsA: path.join(fixtures, 'Artist A') },
    });
  });
  after(async () => { await srv?.stop(); });

  it('totalFileCount', async () => {
    const kid = await get(srv, (await login(srv, 'kid', 'pw-kid')).body.token, '/api/v1/db/status');
    const admin = await get(srv, (await login(srv, 'admin', 'pw-admin')).body.token, '/api/v1/db/status');
    assert.equal(kid.status, 200);
    assert.equal(kid.body.totalFileCount, 3);
    assert.ok(admin.body.totalFileCount > 3, JSON.stringify(admin.body));
  });
});

describe('v-P: a login with a legacy password hash upgrades it', async () => {
  const { startServer } = await import('../helpers/server.mjs');
  let srv;
  const salt = crypto.randomBytes(16).toString('base64');
  const legacyHash = crypto.pbkdf2Sync('old-pw', salt, 15000, 32, 'sha512').toString('base64');

  before(async () => {
    // The helper's scan wait polls /db/status without a token, which a preconfigured user turns into a 401.
    srv = await startServer({
      waitForScan: false,
      extraConfig: { users: { legacy: { password: legacyHash, salt, admin: true, vpaths: ['testlib'] } } },
    });
  });
  after(async () => { await srv?.stop(); });

  it('re-hashes with the current scheme and keeps the session valid', async () => {
    const first = await login(srv, 'legacy', 'old-pw');
    assert.equal(first.status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(srv.tmpDir, 'config.json'), 'utf8')).users.legacy;
    assert.match(saved.salt, /^pbkdf2-210000\$/);
    assert.notEqual(saved.password, legacyHash);
    assert.equal(saved.tokenVersion, undefined);

    assert.equal((await get(srv, first.body.token, '/api/v1/db/status')).status, 200);
    assert.equal((await login(srv, 'legacy', 'old-pw')).status, 200);
    assert.equal((await login(srv, 'legacy', 'wrong')).status, 401);
  });
});
