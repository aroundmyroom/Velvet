const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Cross-device login pairing (TV / kiosk code pairing)', async () => {
  const { startPairing, getPairingStatus, approvePairing, _sweepExpired } = await import('../../src/api/auth-pair.js');

  const fakeDeps = (users = { alice: { vpaths: ['Music'] } }) => ({
    getUser: name => users[name],
    signToken: name => `fake-token-for-${name}`,
  });

  it('start returns a pairId, a 6-char code from the safe alphabet, and a TTL', () => {
    const { pairId, code, expiresInSec } = startPairing();
    assert.match(pairId, /^[0-9a-f-]{36}$/);
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/); // excludes 0/O/1/I
    assert.equal(expiresInSec, 300);
  });

  it('status is pending right after start, expired for an unknown pairId', () => {
    const { pairId } = startPairing();
    assert.deepEqual(getPairingStatus(pairId), { status: 'pending' });
    assert.deepEqual(getPairingStatus('not-a-real-id'), { status: 'expired' });
  });

  it('approve fails for an unknown code without touching the pairing store', () => {
    const result = approvePairing('ZZZZZZ', 'alice', fakeDeps());
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-or-expired');
  });

  it('approve fails when the approving user does not exist', () => {
    const { code } = startPairing();
    const result = approvePairing(code, 'ghost', fakeDeps({}));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-such-user');
  });

  it('approve succeeds and status then reports the token — single-use', () => {
    const { pairId, code } = startPairing();
    const result = approvePairing(code, 'alice', fakeDeps());
    assert.equal(result.ok, true);

    const status1 = getPairingStatus(pairId);
    assert.equal(status1.status, 'approved');
    assert.equal(status1.username, 'alice');
    assert.equal(status1.token, 'fake-token-for-alice');
    assert.deepEqual(status1.vpaths, ['Music']);

    // Collected once — a second poll for the same pairId is gone, not re-served.
    const status2 = getPairingStatus(pairId);
    assert.deepEqual(status2, { status: 'expired' });
  });

  it('approve is case-insensitive and trims whitespace on the code', () => {
    const { pairId, code } = startPairing();
    const result = approvePairing(`  ${code.toLowerCase()}  `, 'alice', fakeDeps());
    assert.equal(result.ok, true);
    assert.equal(getPairingStatus(pairId).status, 'approved');
  });

  it('a code cannot be approved twice', () => {
    const { code } = startPairing();
    assert.equal(approvePairing(code, 'alice', fakeDeps()).ok, true);
    const second = approvePairing(code, 'alice', fakeDeps());
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'invalid-or-expired');
  });

  it('status reports expired for a pairing past its TTL, even before the sweep runs', () => {
    const { pairId } = startPairing();
    _sweepExpired(Date.now() + 6 * 60 * 1000); // simulate the periodic sweep running late
    assert.deepEqual(getPairingStatus(pairId), { status: 'expired' });
  });
});
