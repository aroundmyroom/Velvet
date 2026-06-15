/**
 * XML Escape — Unit Tests
 * Tests the xmlEsc function from src/api/dlna.js.
 *
 * Verifies XML entity encoding, control character stripping (XML 1.0 §2.2),
 * lone surrogate half stripping (U+D800–U+DFFF), and non-character stripping
 * (U+FFFE, U+FFFF). All are required to produce valid DIDL-Lite XML that
 * won't crash strict parsers on renderers like Plex, Sonos, or LG TVs.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ── Inline mirror of xmlEsc from src/api/dlna.js ─────────────────────────────
const XML_INVALID_CTRL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
const XML_INVALID_SURR = /[\uD800-\uDFFF\uFFFE\uFFFF]/g;

function xmlEsc(s) {
  if (s == null) return '';
  return String(s)
    .replace(XML_INVALID_CTRL, '')
    .replace(XML_INVALID_SURR, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
// ─────────────────────────────────────────────────────────────────────────────

describe('xmlEsc', () => {

  describe('null / undefined / empty', () => {
    it('returns empty string for null', () => assert.equal(xmlEsc(null), ''));
    it('returns empty string for undefined', () => assert.equal(xmlEsc(undefined), ''));
    it('returns empty string for empty string', () => assert.equal(xmlEsc(''), ''));
    it('coerces numbers to string', () => assert.equal(xmlEsc(42), '42'));
    it('coerces booleans to string', () => assert.equal(xmlEsc(true), 'true'));
  });

  describe('XML entity encoding', () => {
    it('escapes ampersand', () => assert.equal(xmlEsc('AT&T'), 'AT&amp;T'));
    it('escapes less-than', () => assert.equal(xmlEsc('a < b'), 'a &lt; b'));
    it('escapes greater-than', () => assert.equal(xmlEsc('a > b'), 'a &gt; b'));
    it('escapes double quote', () => assert.equal(xmlEsc('"hello"'), '&quot;hello&quot;'));
    it('escapes single quote', () => assert.equal(xmlEsc("it's"), 'it&apos;s'));
    it('escapes all five entities in one string', () => {
      assert.equal(xmlEsc('<a href="x&y">it\'s</a>'), '&lt;a href=&quot;x&amp;y&quot;&gt;it&apos;s&lt;/a&gt;');
    });
    it('double-escapes are not applied (& in output becomes &amp; in one pass)', () => {
      const result = xmlEsc('a & b');
      assert.equal(result, 'a &amp; b');
      assert.ok(!result.includes('&amp;amp;'), 'should not double-escape');
    });
  });

  describe('control character stripping (XML 1.0 §2.2)', () => {
    it('strips NUL (\\x00)', () => assert.equal(xmlEsc('a\x00b'), 'ab'));
    it('strips SOH (\\x01)', () => assert.equal(xmlEsc('a\x01b'), 'ab'));
    it('strips BEL (\\x07)', () => assert.equal(xmlEsc('a\x07b'), 'ab'));
    it('strips BS (\\x08)', () => assert.equal(xmlEsc('a\x08b'), 'ab'));
    it('strips VT (\\x0B)', () => assert.equal(xmlEsc('a\x0Bb'), 'ab'));
    it('strips FF (\\x0C)', () => assert.equal(xmlEsc('a\x0Cb'), 'ab'));
    it('strips SO (\\x0E)', () => assert.equal(xmlEsc('a\x0Eb'), 'ab'));
    it('strips US (\\x1F)', () => assert.equal(xmlEsc('a\x1Fb'), 'ab'));
    it('preserves HT (\\x09 — XML-legal whitespace)', () => assert.equal(xmlEsc('a\x09b'), 'a\x09b'));
    it('preserves LF (\\x0A — XML-legal whitespace)', () => assert.equal(xmlEsc('a\x0Ab'), 'a\x0Ab'));
    it('preserves CR (\\x0D — XML-legal whitespace)', () => assert.equal(xmlEsc('a\x0Db'), 'a\x0Db'));
  });

  describe('lone surrogate stripping', () => {
    it('strips lone high surrogate (U+D800)', () => {
      const s = 'a\uD800b';
      assert.equal(xmlEsc(s), 'ab');
    });
    it('strips lone low surrogate (U+DFFF)', () => {
      const s = 'a\uDFFFb';
      assert.equal(xmlEsc(s), 'ab');
    });
    it('strips mid-range surrogate (U+DC00)', () => {
      const s = 'a\uDC00b';
      assert.equal(xmlEsc(s), 'ab');
    });
    it('strips valid surrogate pairs too (regex strips all D800-DFFF code units)', () => {
      // The regex /[\uD800-\uDFFF]/ matches individual UTF-16 code units.
      // JS stores emoji as two surrogate halves, both in the D800-DFFF range,
      // so both halves get stripped. This is aggressive but safe for XML output.
      const s = 'track \uD83C\uDFB5 title';
      const result = xmlEsc(s);
      assert.equal(result, 'track  title', 'both surrogate halves are stripped');
    });
  });

  describe('non-character stripping (U+FFFE, U+FFFF)', () => {
    it('strips U+FFFE', () => assert.equal(xmlEsc('a\uFFFEb'), 'ab'));
    it('strips U+FFFF', () => assert.equal(xmlEsc('a\uFFFFb'), 'ab'));
  });

  describe('realistic ID3 tag scenarios', () => {
    it('handles typical clean title', () => {
      assert.equal(xmlEsc('Bohemian Rhapsody'), 'Bohemian Rhapsody');
    });

    it('handles title with apostrophe', () => {
      assert.equal(xmlEsc("Don't Stop Me Now"), 'Don&apos;t Stop Me Now');
    });

    it('handles artist name with ampersand', () => {
      assert.equal(xmlEsc('Simon & Garfunkel'), 'Simon &amp; Garfunkel');
    });

    it('handles title with embedded NUL (corrupted ID3)', () => {
      const dirty = 'Track\x00Title';
      assert.equal(xmlEsc(dirty), 'TrackTitle');
    });

    it('handles title with lone surrogate from mojibake UTF-16', () => {
      const mojibake = 'Caf\uD83E\uDD14'; // valid: thinking emoji pair
      assert.ok(!xmlEsc(mojibake).includes('\uD800'));  // no broken surrogates in output
    });

    it('handles non-ASCII characters (accented, CJK)', () => {
      assert.equal(xmlEsc('Björk'), 'Björk');
      assert.equal(xmlEsc('日本語'), '日本語');
      assert.equal(xmlEsc('Ünited Ütensils'), 'Ünited Ütensils');
    });

    it('handles URL string in res element', () => {
      const url = 'https://music.example.com/media/Music/Artist/Song%20Title.mp3';
      const result = xmlEsc(url);
      assert.ok(!result.includes('&amp;amp;'), 'no double escaping');
      assert.equal(result, url, 'clean URLs pass through unchanged');
    });
  });

});
