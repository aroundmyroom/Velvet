const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Reverse-proxy trusted-header auth (ext-auth)', async () => {
  const { isTrustedProxy, resolveExtAuthUser } = await import('../../src/util/ext-auth.js');

  describe('isTrustedProxy — IPv4 CIDR matching', () => {
    it('matches an exact IP entry', () => {
      assert.equal(isTrustedProxy('172.18.0.5', ['172.18.0.5']), true);
      assert.equal(isTrustedProxy('172.18.0.6', ['172.18.0.5']), false);
    });

    it('matches a CIDR range', () => {
      assert.equal(isTrustedProxy('172.18.4.200', ['172.18.0.0/16']), true);
      assert.equal(isTrustedProxy('172.19.0.1', ['172.18.0.0/16']), false);
    });

    it('strips the IPv4-mapped IPv6 prefix before matching', () => {
      assert.equal(isTrustedProxy('::ffff:172.18.0.5', ['172.18.0.5']), true);
    });

    it('rejects when no trustedProxies are configured', () => {
      assert.equal(isTrustedProxy('172.18.0.5', []), false);
      assert.equal(isTrustedProxy('172.18.0.5', undefined), false);
    });

    it('rejects malformed IPs and out-of-range prefixes without throwing', () => {
      assert.equal(isTrustedProxy('not-an-ip', ['172.18.0.0/16']), false);
      assert.equal(isTrustedProxy('172.18.0.5', ['172.18.0.0/99']), false);
    });
  });

  describe('resolveExtAuthUser', () => {
    const baseCfg = {
      enabled: true,
      headerName: 'Remote-User',
      trustedProxies: ['172.18.0.0/16'],
      secretHeaderName: 'X-Velvet-ExtAuth-Secret',
      secretValue: 'topsecret',
      autoCreateUsers: false,
    };
    const req = (overrides = {}) => ({
      socket: { remoteAddress: '172.18.0.5' },
      headers: {
        'remote-user': 'alice',
        'x-velvet-extauth-secret': 'topsecret',
        ...overrides,
      },
    });

    it('returns null when disabled', async () => {
      const got = await resolveExtAuthUser(req(), { cfg: { ...baseCfg, enabled: false } });
      assert.equal(got, null);
    });

    it('returns null when the socket peer is not a trusted proxy', async () => {
      const untrusted = req();
      untrusted.socket.remoteAddress = '10.0.0.1';
      const got = await resolveExtAuthUser(untrusted, { cfg: baseCfg, users: { alice: {} } });
      assert.equal(got, null);
    });

    it('returns null when the shared secret is missing or wrong', async () => {
      const got1 = await resolveExtAuthUser(req({ 'x-velvet-extauth-secret': undefined }), { cfg: baseCfg, users: { alice: {} } });
      assert.equal(got1, null);
      const got2 = await resolveExtAuthUser(req({ 'x-velvet-extauth-secret': 'wrong' }), { cfg: baseCfg, users: { alice: {} } });
      assert.equal(got2, null);
    });

    it('returns the username when trust, secret and an existing user all check out', async () => {
      const got = await resolveExtAuthUser(req(), { cfg: baseCfg, users: { alice: {} } });
      assert.equal(got, 'alice');
    });

    it('returns null for an unknown user when auto-create is off', async () => {
      const got = await resolveExtAuthUser(req(), { cfg: baseCfg, users: {} });
      assert.equal(got, null);
    });

    it('auto-creates an unknown user when autoCreateUsers is on', async () => {
      const users = {};
      let addUserCalledWith = null;
      const addUser = async (username, password, admin, vpaths) => {
        addUserCalledWith = { username, admin, vpaths };
        users[username] = { admin, vpaths };
      };
      const got = await resolveExtAuthUser(req(), {
        cfg: { ...baseCfg, autoCreateUsers: true },
        users,
        addUser,
      });
      assert.equal(got, 'alice');
      assert.equal(addUserCalledWith.username, 'alice');
      assert.equal(addUserCalledWith.admin, false);
    });

    it('tolerates a concurrent auto-create race (addUser rejects, user already present)', async () => {
      const users = { alice: {} };
      const addUser = async () => { throw new Error('already exists'); };
      const got = await resolveExtAuthUser(req(), {
        cfg: { ...baseCfg, autoCreateUsers: true },
        users,
        addUser,
      });
      assert.equal(got, 'alice');
    });

    it('returns null when no header name is configured', async () => {
      const got = await resolveExtAuthUser(req(), { cfg: { ...baseCfg, headerName: '' }, users: { alice: {} } });
      assert.equal(got, null);
    });
  });
});
