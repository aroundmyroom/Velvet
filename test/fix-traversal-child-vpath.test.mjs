import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { userOwnsChildPath, normalizeRelPath } from '../src/util/vpath.js';
import { canAccessMediaVpath } from '../src/util/media-access.js';

const folders = {
  Music: { root: '/srv/music' },
  Recordings: { root: '/srv/music/Recordings' },
};
const childOnly = { vpaths: ['Recordings'] };

describe('child-only users cannot climb out of their folder with ..', () => {
  it('normalizeRelPath resolves dot segments and rejects escapes', () => {
    assert.equal(normalizeRelPath('Recordings/../Secret/x.flac'), 'Secret/x.flac');
    assert.equal(normalizeRelPath('Recordings/./a.mp3'), 'Recordings/a.mp3');
    assert.equal(normalizeRelPath('../etc/passwd'), null);
    assert.equal(normalizeRelPath('a/../../b'), null);
    assert.equal(normalizeRelPath('/abs'), null);
  });

  it('userOwnsChildPath refuses a path that leaves the child prefix', () => {
    assert.equal(userOwnsChildPath(childOnly, 'Music', 'Recordings/show.opus', folders), true);
    assert.equal(userOwnsChildPath(childOnly, 'Music', 'Recordings/../Secret/x.flac', folders), false);
    assert.equal(userOwnsChildPath(childOnly, 'Music', 'Recordings/sub/../../Secret/x.flac', folders), false);
  });

  it('media access refuses encoded dot segments too', () => {
    assert.equal(canAccessMediaVpath('/Music/Recordings/show.opus', childOnly, folders), true);
    assert.equal(canAccessMediaVpath('/Music/Recordings/../Secret/x.flac', childOnly, folders), false);
    assert.equal(canAccessMediaVpath('/Music/Recordings/%2e%2e/Secret/x.flac', childOnly, folders), false);
  });
});
