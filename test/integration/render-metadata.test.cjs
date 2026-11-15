/**
 * renderMetadataObj — Unit Tests
 * Tests the exported renderMetadataObj from src/api/db.js.
 *
 * Verifies field mapping, null handling, and the correct filepath format
 * (vpath + '/' + filepath, forward-slash normalized).
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');


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

describe('renderMetadataObj', async () => {
  const { renderMetadataObj } = await import('../../src/api/db.js');

  describe('filepath construction', () => {
    it('joins vpath + filepath with forward slash', () => {
      const result = renderMetadataObj(FULL_ROW);
      assert.equal(result.filepath, 'Music/Rock/Queen/Bohemian Rhapsody.mp3');
    });

    it('normalizes backslashes to forward slashes', () => {
      const row = { ...FULL_ROW, filepath: 'Rock\\Queen\\song.mp3' };
      assert.equal(renderMetadataObj(row).filepath, 'Music/Rock/Queen/song.mp3');
    });

    it('does not double the slash when vpath or filepath carry one', () => {
      assert.equal(renderMetadataObj({ vpath: 'Music/', filepath: '/a/b.mp3' }).filepath, 'Music/a/b.mp3');
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
    it('maps bitrate (kbps in the DB) to bits per second', () => assert.equal(renderMetadataObj(FULL_ROW).metadata.bitrate, 320000));
    it('maps sample-rate (sample_rate) correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata['sample-rate'], 44100));
    it('maps channels correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata.channels, 2));
    it('maps bit-depth (bit_depth) correctly', () => assert.equal(renderMetadataObj(FULL_ROW).metadata['bit-depth'], 16));
    it('rounds bpm', () => assert.equal(renderMetadataObj({ ...FULL_ROW, bpm: 127.6 }).metadata.bpm, 128));
    it('maps musical-key correctly', () => assert.equal(renderMetadataObj({ ...FULL_ROW, musical_key: '8A' }).metadata['musical-key'], '8A'));
    it('falls back to album_artist when artist is empty', () => {
      const m = renderMetadataObj({ ...FULL_ROW, artist: null, album_artist: 'Various' }).metadata;
      assert.equal(m.artist, 'Various');
      assert.equal(m['album-artist'], 'Various');
    });
    it('builds the rg object from the track gain tag', () => {
      const { rg } = renderMetadataObj(FULL_ROW);
      assert.equal(rg.trackGain, -6.5);
      assert.equal(rg.src, 'tag');
    });
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
      assert.equal(result.metadata.bitrate, null);
      assert.equal(result.rg, null);
    });
  });

});
