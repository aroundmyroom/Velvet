const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const ADMIN = { username: 'boss', password: 'boss123' };

describe('server-playback/detect only runs a safe mpv binary', () => {
  let srv, token;

  before(async () => {
    const { startServer } = await import('../helpers/server.mjs');
    srv = await startServer({ users: [ADMIN], extraConfig: { serverAudio: { enabled: false, mpvBin: 'mpv --help; touch x' } } });
    const r = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ADMIN),
    });
    token = (await r.json()).token;
  });

  after(async () => { await srv?.stop(); });

  it('falls back to plain mpv when the configured binary is not a safe name or executable path', async () => {
    const r = await fetch(`${srv.baseUrl}/api/v1/server-playback/detect`, { headers: { 'x-access-token': token } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).path, 'mpv');
  });
});
