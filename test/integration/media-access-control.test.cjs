const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Media vpath access control helper', async () => {
  const { canAccessMediaVpath } = await import('../../src/util/media-access.js');

  const folders = {
    Music: { root: '/srv/music' },
    'Other Lib': { root: '/srv/other' }
  };

  it('allows access when user has the requested vpath', () => {
    const ok = canAccessMediaVpath('/Music/Artist/Track.mp3', { vpaths: ['Music'] }, folders);
    assert.equal(ok, true);
  });

  it('denies access when user lacks the requested vpath', () => {
    const ok = canAccessMediaVpath('/Music/Artist/Track.mp3', { vpaths: ['Other Lib'] }, folders);
    assert.equal(ok, false);
  });

  it('denies access for unknown vpaths', () => {
    const ok = canAccessMediaVpath('/Nope/Artist/Track.mp3', { vpaths: ['Nope'] }, folders);
    assert.equal(ok, false);
  });

  it('supports URL-encoded vpath names', () => {
    const ok = canAccessMediaVpath('/Other%20Lib/Artist/Track.mp3', { vpaths: ['Other Lib'] }, folders);
    assert.equal(ok, true);
  });

  it('denies malformed encoded vpaths', () => {
    const ok = canAccessMediaVpath('/%E0%A4%A/Artist/Track.mp3', { vpaths: ['Other Lib'] }, folders);
    assert.equal(ok, false);
  });
});
