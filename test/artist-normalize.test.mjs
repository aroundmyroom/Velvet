import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCanonicalName, toKey } from '../src/util/artist-normalize.js';

test('artist identity keys fold diacritics without changing display values', () => {
  assert.equal(toKey('Beyoncé'), 'beyonce');
  assert.equal(toKey('Mötörhead'), 'motorhead');
  assert.equal(toKey('Tiësto'), toKey('Tiesto'));
  assert.equal(toKey('Ærø'), 'aero');
});

test('canonical artist selection is deterministic and does not reorder input', () => {
  const variants = [
    { name: 'z artist', count: 10 },
    { name: 'A Artist', count: 10 },
  ];
  assert.equal(pickCanonicalName(variants), 'A Artist');
  assert.deepEqual(variants.map(v => v.name), ['z artist', 'A Artist']);
});
