import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseEmbeddedAlbumArt } from '../../src/db/album-art-select.js';

function pic(type, tag) {
  return { type, data: Buffer.from(tag), format: 'image/jpeg' };
}

test('prefers front cover among non-artist pictures', () => {
  const selected = chooseEmbeddedAlbumArt([
    pic('Band/orchestra', 'artist-photo'),
    pic('Cover (back)', 'back-cover'),
    pic('Cover (front)', 'front-cover')
  ]);
  assert.equal(String(selected.data), 'front-cover');
});

test('falls back to first non-artist picture when no front cover exists', () => {
  const selected = chooseEmbeddedAlbumArt([
    pic('Band/artist logotype', 'logo'),
    pic('Leaflet page', 'leaflet')
  ]);
  assert.equal(String(selected.data), 'leaflet');
});

test('returns null when only artist-typed pictures are present', () => {
  const selected = chooseEmbeddedAlbumArt([
    pic('Artist/performer', 'artist1'),
    pic('Band/orchestra', 'artist2')
  ]);
  assert.equal(selected, null);
});