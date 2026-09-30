const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('artistLookupCandidates — names tried against Last.fm, in order', async () => {
  const { artistLookupCandidates } = await import('../../src/util/artist-credit.js');

  it('tries the exact credit first, then the collaboration parts', () => {
    assert.deepEqual(artistLookupCandidates('Jax Jones feat. Ina Wroldsen'), ['Jax Jones feat. Ina Wroldsen', 'Jax Jones', 'Ina Wroldsen']);
    assert.deepEqual(artistLookupCandidates('Duke Dumont ft Jax Jones'), ['Duke Dumont ft Jax Jones', 'Duke Dumont', 'Jax Jones']);
  });

  it('understands the "Fe." shorthand that left Auto-DJ without similar artists', () => {
    // Seen live 2026-09-29: this credit got zero results and no part was tried.
    assert.deepEqual(artistLookupCandidates('Martin Solveig Fe. Roy Woods'), ['Martin Solveig Fe. Roy Woods', 'Martin Solveig', 'Roy Woods']);
    assert.deepEqual(artistLookupCandidates('MK fe Carla Monroe'), ['MK fe Carla Monroe', 'MK', 'Carla Monroe']);
  });

  it('keeps a duo/group whole before splitting it into halves', () => {
    assert.deepEqual(artistLookupCandidates('Mel & Kim'), ['Mel & Kim', 'Mel', 'Kim']);
    assert.deepEqual(artistLookupCandidates('Mel & Kim vs. Frantique'), ['Mel & Kim vs. Frantique', 'Mel & Kim', 'Frantique', 'Mel', 'Kim']);
  });

  it('strips a track number that leaked into the artist tag', () => {
    assert.deepEqual(artistLookupCandidates('12. Joel Corry Fe. MNEK'), ['12. Joel Corry Fe. MNEK', 'Joel Corry Fe. MNEK', 'Joel Corry', 'MNEK']);
    assert.deepEqual(artistLookupCandidates('05. Jax Jones'), ['05. Jax Jones', 'Jax Jones']);
  });

  it('does not treat an initial as a separator', () => {
    assert.deepEqual(artistLookupCandidates('George F. Zimmer'), ['George F. Zimmer']);
    assert.deepEqual(artistLookupCandidates('Olav Basoski f. Michie One'), ['Olav Basoski f. Michie One']);
  });

  it('dedupes case-insensitively and drops empties', () => {
    assert.deepEqual(artistLookupCandidates('Sting & sting'), ['Sting & sting', 'Sting']);
    assert.deepEqual(artistLookupCandidates('   '), []);
    assert.deepEqual(artistLookupCandidates(null), []);
  });
});
