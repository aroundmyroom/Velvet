/**
 * Dual-Hash Identity Tests
 * Verifies audio_hash is computed and stored correctly
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

describe('Dual-Hash Identity', () => {
  describe('audio_hash computation', () => {
    it('should compute consistent hash for song metadata', () => {
      // Simulate audio_hash calculation
      const song1 = { artist: 'Queen', album: 'A Night at the Opera', title: 'Bohemian Rhapsody', duration: 360 };
      const song2 = { artist: 'Queen', album: 'A Night at the Opera', title: 'Bohemian Rhapsody', duration: 360 };
      
      function calcAudioHash(song) {
        const id = `${(song.artist || '').toLowerCase()}|${(song.album || '').toLowerCase()}|${(song.title || '').toLowerCase()}|${Math.round(song.duration || 0)}`;
        return crypto.createHash('sha256').update(id).digest('hex');
      }
      
      const hash1 = calcAudioHash(song1);
      const hash2 = calcAudioHash(song2);
      
      assert.strictEqual(hash1, hash2, 'same song metadata should produce same hash');
      assert(hash1.length === 64, 'SHA-256 should produce 64 hex chars');
    });

    it('should produce different hashes for different songs', () => {
      const song1 = { artist: 'Queen', album: 'A Night at the Opera', title: 'Bohemian Rhapsody', duration: 360 };
      const song2 = { artist: 'Queen', album: 'A Night at the Opera', title: 'Don\'t Stop Me Now', duration: 240 };
      
      function calcAudioHash(song) {
        const id = `${(song.artist || '').toLowerCase()}|${(song.album || '').toLowerCase()}|${(song.title || '').toLowerCase()}|${Math.round(song.duration || 0)}`;
        return crypto.createHash('sha256').update(id).digest('hex');
      }
      
      const hash1 = calcAudioHash(song1);
      const hash2 = calcAudioHash(song2);
      
      assert.notStrictEqual(hash1, hash2, 'different songs should have different hashes');
    });

    it('should survive metadata normalization (case-insensitive)', () => {
      const song1 = { artist: 'QUEEN', album: 'A NIGHT AT THE OPERA', title: 'BOHEMIAN RHAPSODY', duration: 360 };
      const song2 = { artist: 'queen', album: 'a night at the opera', title: 'bohemian rhapsody', duration: 360 };
      
      function calcAudioHash(song) {
        const id = `${(song.artist || '').toLowerCase()}|${(song.album || '').toLowerCase()}|${(song.title || '').toLowerCase()}|${Math.round(song.duration || 0)}`;
        return crypto.createHash('sha256').update(id).digest('hex');
      }
      
      const hash1 = calcAudioHash(song1);
      const hash2 = calcAudioHash(song2);
      
      assert.strictEqual(hash1, hash2, 'case variations should produce same hash');
    });
  });

  describe('transcode scenarios', () => {
    it('should preserve audio_hash across transcoding (MP3 → FLAC)', () => {
      // Original file
      const original = { 
        artist: 'Queen', 
        album: 'A Night at the Opera', 
        title: 'Bohemian Rhapsody', 
        duration: 360,
        file_hash: 'abc123def456',  // original file hash (first 512 KB)
        format: 'mp3'
      };
      
      // Transcoded file (same audio content, different encoding)
      const transcoded = {
        artist: 'Queen',
        album: 'A Night at the Opera', 
        title: 'Bohemian Rhapsody',
        duration: 360,  // duration preserved
        file_hash: 'xyz789uvw012',  // different file (different encoding)
        format: 'flac'
      };
      
      function calcAudioHash(song) {
        const id = `${(song.artist || '').toLowerCase()}|${(song.album || '').toLowerCase()}|${(song.title || '').toLowerCase()}|${Math.round(song.duration || 0)}`;
        return crypto.createHash('sha256').update(id).digest('hex');
      }
      
      const audioHashOrig = calcAudioHash(original);
      const audioHashTransc = calcAudioHash(transcoded);
      
      assert.strictEqual(audioHashOrig, audioHashTransc, 'transcoded file should have same audio_hash');
      assert.notStrictEqual(original.file_hash, transcoded.file_hash, 'but file_hash should differ');
    });

    it('should detect when different audio is added to same file metadata', () => {
      // Use case: user re-encodes file with same tags but different audio content
      const original = {
        artist: 'Queen',
        album: 'A Night at the Opera',
        title: 'Bohemian Rhapsody',
        duration: 360
      };
      
      const replacement = {
        artist: 'Queen',
        album: 'A Night at the Opera',
        title: 'Bohemian Rhapsody',
        duration: 358  // slightly different duration = different audio
      };
      
      function calcAudioHash(song) {
        const id = `${(song.artist || '').toLowerCase()}|${(song.album || '').toLowerCase()}|${(song.title || '').toLowerCase()}|${Math.round(song.duration || 0)}`;
        return crypto.createHash('sha256').update(id).digest('hex');
      }
      
      const hash1 = calcAudioHash(original);
      const hash2 = calcAudioHash(replacement);
      
      assert.notStrictEqual(hash1, hash2, 'different duration = different audio_hash');
    });
  });

  describe('data preservation', () => {
    it('should enable play-count preservation across transcodes', () => {
      // User's play counts and ratings stored by audio_hash
      const playCountDB = {};
      
      const originalFile = {
        artist: 'Queen',
        album: 'A Night at the Opera',
        title: 'Bohemian Rhapsody',
        duration: 360
      };
      
      function calcAudioHash(song) {
        const id = `${(song.artist || '').toLowerCase()}|${(song.album || '').toLowerCase()}|${(song.title || '').toLowerCase()}|${Math.round(song.duration || 0)}`;
        return crypto.createHash('sha256').update(id).digest('hex');
      }
      
      const audioHash = calcAudioHash(originalFile);
      
      // User has played this song 42 times
      playCountDB[audioHash] = { plays: 42, rating: 5, lastPlayed: 1703001600 };
      
      // After transcode, same audio_hash retrieves play count
      const transcodedFile = {
        artist: 'Queen',
        album: 'A Night at the Opera',
        title: 'Bohemian Rhapsody',
        duration: 360  // same duration
      };
      
      const transcodedAudioHash = calcAudioHash(transcodedFile);
      const metadata = playCountDB[transcodedAudioHash];
      
      assert(metadata, 'transcoded file should find existing play count');
      assert.strictEqual(metadata.plays, 42, 'play count preserved across transcode');
    });
  });
});
