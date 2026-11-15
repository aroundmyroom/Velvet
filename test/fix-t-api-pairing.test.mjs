import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startPairing, getPairingStatus, approvePairing } from '../src/api/auth-pair.js';

const deps = { getUser: () => ({ vpaths: ['Music'] }), signToken: n => `t-${n}` };

describe('pairing code normalisation', () => {
  it('accepts the code typed as shown on the TV (ABC DEF)', () => {
    const { pairId, code } = startPairing();
    const shown = `${code.slice(0, 3)} ${code.slice(3)}`.toLowerCase();
    assert.equal(approvePairing(shown, 'alice', deps).ok, true);
    assert.equal(getPairingStatus(pairId).status, 'approved');
  });

  it('accepts tabs and several spaces inside the code', () => {
    const { code } = startPairing();
    assert.equal(approvePairing(`${code.slice(0, 2)}\t ${code.slice(2)}`, 'alice', deps).ok, true);
  });
});
