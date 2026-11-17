/**
 * Skins (docs/skins.md): listing, serving, the admin default and ping.
 *
 * Run with:
 *   node --test test/skins.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';

const ADMIN = { username: 'admin', password: 'admin123' };
const BOB = { username: 'bob', password: 'bob123', admin: false };

async function login(baseUrl, username, password) {
  const r = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return (await r.json()).token;
}
function call(baseUrl, method, route, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-access-token'] = token;
  return fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const readConfig = async (srv) => JSON.parse(await fs.readFile(path.join(srv.tmpDir, 'config.json'), 'utf8'));

describe('skins', () => {
  let srv, admin, bob;
  before(async () => {
    srv = await startServer({ users: [ADMIN, BOB], waitForScan: false });
    admin = await login(srv.baseUrl, ADMIN.username, ADMIN.password);
    bob = await login(srv.baseUrl, BOB.username, BOB.password);
  });
  after(async () => { await srv.stop(); });

  it('lists the built-in goud skin, no default, and serves its css', async () => {
    const ping = await (await call(srv.baseUrl, 'GET', '/api/v1/ping', bob)).json();
    assert.ok(ping.skins.some(s => s.id === 'goud' && s.v));
    assert.equal(ping.defaultSkin, '');
    const css = await fetch(`${srv.baseUrl}/skins/goud/skin.css`);
    assert.equal(css.status, 200);
    assert.match(await css.text(), /:root\[data-skin\]/);
  });

  it('picks up a skin dropped into the skins folder without a restart, and it wins over a built-in name', async () => {
    const dir = path.join(srv.tmpDir, 'skins');
    await fs.mkdir(path.join(dir, 'mine'), { recursive: true });
    await fs.writeFile(path.join(dir, 'mine', 'skin.css'), ':root[data-skin] { --primary: #00ff00; }');
    await fs.mkdir(path.join(dir, 'goud'), { recursive: true });
    await fs.writeFile(path.join(dir, 'goud', 'skin.css'), ':root[data-skin] { --primary: #123456; }');
    await fs.mkdir(path.join(dir, 'Bad Name'), { recursive: true });
    await fs.writeFile(path.join(dir, 'Bad Name', 'skin.css'), '');
    await fs.mkdir(path.join(dir, 'empty'), { recursive: true });
    const ping = await (await call(srv.baseUrl, 'GET', '/api/v1/ping', bob)).json();
    assert.deepEqual(ping.skins.map(s => s.id), ['goud', 'mine']);
    assert.match(await (await fetch(`${srv.baseUrl}/skins/mine/skin.css`)).text(), /#00ff00/);
    assert.match(await (await fetch(`${srv.baseUrl}/skins/goud/skin.css`)).text(), /#123456/);
  });

  it('lets an admin set the default skin, which ping then returns', async () => {
    const r = await call(srv.baseUrl, 'POST', '/api/v1/admin/config/skin', admin, { skin: 'goud' });
    assert.equal(r.status, 200);
    assert.equal((await readConfig(srv)).skin, 'goud');
    assert.equal((await (await call(srv.baseUrl, 'GET', '/api/v1/ping', bob)).json()).defaultSkin, 'goud');
    const cfg = await (await call(srv.baseUrl, 'GET', '/api/v1/admin/config', admin)).json();
    assert.equal(cfg.skin, 'goud');
    assert.ok(cfg.skins.some(s => s.id === 'goud'));
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/admin/config/skin', admin, { skin: '' })).status, 200);
    assert.equal((await readConfig(srv)).skin, '');
  });

  it('refuses an unknown or malformed skin and a non-admin', async () => {
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/admin/config/skin', admin, { skin: 'nope' })).status, 400);
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/admin/config/skin', admin, { skin: '../goud' })).status, 400);
    assert.equal((await call(srv.baseUrl, 'POST', '/api/v1/admin/config/skin', bob, { skin: 'goud' })).status, 403);
  });
});
