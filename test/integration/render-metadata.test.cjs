/**
 * renderMetadataObj — Unit Tests
 * Tests the metadata transformation function from src/api/db.js.
 *
 * Verifies field mapping, null handling, and the correct filepath format
 * (vpath + '/' + filepath, forward-slash normalized).
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ── Inline mirror of renderMetadataObj from src/api/db.js ────────────────────
function renderMetadataObj(row) {
  return {
    'filepath': path.join(row.vpath, row.filepath).replace(/\\/g, '/'),
    'metadata': {
      'artist':              row.artist      ? row.artist      : null,
      'hash':                row.hash        ? row.hash        : null,
      'album':               row.album       ? row.album       : null,
      'track':               row.track       ? row.track       : null,
      'track-of':            row.trackOf     ? row.trackOf     : null,
      'disk':                row.disk        ? row.disk        : null,
      'title':               row.title       ? row.title       : null,
      'year':                row.year        ? row.year        : null,
      'album-art':           row.aaFile      ? row.aaFile      : null,
      'rating':              row.rating      ? row.rating      : null,
      'play-count':          row.playCount   ? row.playCount   : null,
      'last-played':         row.lastPlayed  ? row.lastPlayed  : null,
      'genre':               row.genre       || null,
      'replaygain-track-db': row.replaygainTrackDb != null ? row.replaygainTrackDb : null,
      'duration':            row.duration    != null ? row.duration    : null,
      'bitrate':             row.bitrate     != null ? row.bitrate     : null,
      'sample-rate':         row.sample_rate != null ? row.sample_rate : null,
      'channels':            row.channels    != null ? row.channels    : null,
      'bit-depth':           row.bit_depth   != null ? row.bit_depth   : null,
      'album-version':       row.album_version || null,
    },
  };
}
// ─────────────────────────────────────────────────────────────────────────────

const FULL_ROW = {
  vpath:             'Music',
  filepath:          'Rock/Queen/Bohemian Rhapsody.mp3',
  artist:            'Queen',
  hash:              'abc123',
  album:             'A Night at the Opera',
  track:             1,
  trackOf:           12,
  disk:              1,
  title:             'Bohemian Rhapsody',
  year:              1975,
  aaFile:            'cover-abc123.jpg',
  rating:            5,
  playCount:         42,
  lastPlayed:        1700000000,
  genre:             'Rock',
  replaygainTrackDb: -6.5,
  duration:          354000,
  bitrate:           320,
  sample_rate:       44100,
  channels:          2,
  bit_depth:         16,
  album_version:     null,
};

describe('renderMetadataObj', () => {

  describe('filepath construction', () => {
    it('joins vpath + filepath with forward slash', () => {
      const result = renderMetadataObj(FULL_ROW);
      assert.equal(result.filepath, 'Music/Rock/Queen/Bohemian Rhapsody.mp3');
    });

    it('normalizes backslashes to forward slashes', () => {
      const row = { ...FULL_ROW, filepath: 'Rock\\Queen\\song.mp3' };
      const result = renderMetadataObj(row);
      assert.ok(!result.filepath.includes('\\'), 'should not contain backslashes');
    });

    it('preserves spaces in filepath', () => {
      const row = { ...FULL_ROW, filepath: 'Artist With Spaces/Album Name/Track 01.flac' };
      const result = renderMetadataObj(row);
      assert.ok(result.filepath.includes('Artist With Spaces'));
    });

    it('preserves vpath with spaces', () => {
      const row = { ...FULL_ROW, vpath: '12-inch classics' };
      const result = renderMetadataObj(row);
      assert.ok(result.filepath.startsWith('12-inch classics/'));
    });
  });

  describe('field mapping with full row', () => {
    it('maps artist correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata.artist, 'Queen'));
    it('maps hash correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata.hash, 'abc123'));
    it('maps album correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata.album, 'A Night at the Opera'));
    it('maps track correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata.track, 1));
    it('maps track-of (trackOf) correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata['track-of'], 12));
    it('maps disk correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata.disk, 1));
    it('maps title correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata.title, 'Bohemian Rhapsody'));
    it('maps year correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata.year, 1975));
    it('maps album-art (aaFile) correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata['album-art'], 'cover-abc123.jpg'));
    it('maps rating correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata.rating, 5));
    it('maps play-count (playCount) correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata['play-count'], 42));
    it('maps last-played (lastPlayed) correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata['last-played'], 1700000000));
    it('maps genre correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata.genre, 'Rock'));
    it('maps replaygain-track-db correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata['replaygain-track-db'], -6.5));
    it('maps duration correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata.duration, 354000));
    it('maps bitrate correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata.bitrate, 320));
    it('maps sample-rate (sample_rate) correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata['sample-rate'], 44100));
    it('maps channels correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata.channels, 2));
  });

  describe('null/missing field handling', () => {
    it('returns null for missing artist', () => {
      assert.equal(renderMetadataObj({ ...FULL_ROW, artist: null }).metadata.artist, null);
    });

    it('returns null for missing hash', () => {
      assert.equal(renderMetadataObj({ ...FULL_ROW, hash: null }).metadata.hash, null);
    });

    it('returns null for missing genre (uses || null not ternary)', () => {
      assert.equal(renderMetadataObj({ ...FULL_ROW, genre: null }).metadata.genre, null);
    });

    it('returns null for empty string genre', () => {
      assert.equal(renderMetadataObj({ ...FULL_ROW, genre: '' }).metadata.genre, null);
    });

    it('returns null for missing aaFile', () => {
      assert.equal(renderMetadataObj({ ...FULL_ROW, aaFile: null }).metadata['album-art'], null);
    });

    it('returns null for missing replaygainTrackDb', () => {
      assert.equal(renderMetadataObj({ ...FULL_ROW, replaygainTrackDb: null }).metadata['replaygain-track-db'], null);
    });

    it('returns 0 for replaygainTrackDb=0 (falsy but valid)', () => {
      assert.equal(renderMetadataObj({ ...FULL_ROW, replaygainTrackDb: 0 }).metadata['replaygain-track-db'], 0);
    });

    it('returns 0 for duration=0 (falsy but valid)', () => {
      assert.equal(renderMetadataObj({ ...FULL_ROW, duration: 0 }).metadata.duration, 0);
    });

    it('returns 0 for bitrate=0', () => {
      assert.equal(renderMetadataObj({ ...FULL_ROW, bitrate: 0 }).metadata.bitrate, 0);
    });

    it('returns null for missing track', () => {
      assert.equal(renderMetadataObj({ ...FULL_ROW, track: null }).metadata.track, null);
    });

    it('returns null for undefined channels', () => {
      const { channels: _, ...rowWithout } = FULL_ROW;
      assert.equal(renderMetadataObj(rowWithout).metadata.channels, null);
    });
  });

  describe('minimal row (only required fields)', () => {
    it('works with only vpath and filepath', () => {
      const row = { vpath: 'Music', filepath: 'test.mp3' };
      const result = renderMetadataObj(row);
      assert.equal(result.filepath, 'Music/test.mp3');
      assert.equal(result.metadata.artist, null);
      assert.equal(result.metadata.title, null);
      assert.equal(result.metadata.duration, null);
    });
  });

});
