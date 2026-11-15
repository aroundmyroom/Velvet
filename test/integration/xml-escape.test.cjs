/**
 * XML Escape — Unit Tests
 * Tests src/util/xml.js xmlEscape() through the running DLNA service: each
 * value is set as the device name and read back from the <friendlyName> of
 * /dlna/description.xml.
 *
 * Verifies XML entity encoding, control character stripping (XML 1.0 §2.2),
 * lone surrogate half stripping (valid pairs such as emoji are kept), and non-character stripping
 * (U+FFFE, U+FFFF). All are required to produce valid DIDL-Lite XML that
 * won't crash strict parsers on renderers like Plex, Sonos, or LG TVs.
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const http = require('node:http');
const net = require('node:net');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function getText(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

describe('xmlEsc', () => {
  let srv, dlnaPort, xmlEsc;

  before(async () => {
    const { startServer } = await import('../helpers/server.mjs');
    dlnaPort = await freePort();
    srv = await startServer({
      waitForScan: false,
      extraConfig: { dlna: { mode: 'separate-port', enabled: true, port: dlnaPort, name: 'Velvet Test' } },
    });
    for (let i = 0; i < 50; i++) {
      const j = await (await fetch(`${srv.baseUrl}/api/v1/admin/dlna/config`)).json();
      if (j.running) break;
      await new Promise(r => setTimeout(r, 200));
    }
    const cache = new Map();
    xmlEsc = async (value) => {
      if (cache.has(value)) return cache.get(value);
      const r = await fetch(`${srv.baseUrl}/api/v1/admin/dlna/config`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: value }),
      });
      assert.equal(r.status, 200, await r.text());
      const xml = await getText(dlnaPort, '/dlna/description.xml');
      const out = xml.match(/<friendlyName>([\s\S]*?)<\/friendlyName>/)[1];
      cache.set(value, out);
      return out;
    };
  });

  after(async () => { await srv?.stop(); });

  describe('XML entity encoding', () => {
    it('escapes ampersand', async () => assert.equal(await xmlEsc('AT&T'), 'AT&amp;T'));
    it('escapes less-than', async () => assert.equal(await xmlEsc('a < b'), 'a &lt; b'));
    it('escapes greater-than', async () => assert.equal(await xmlEsc('a > b'), 'a &gt; b'));
    it('escapes double quote', async () => assert.equal(await xmlEsc('"hello"'), '&quot;hello&quot;'));
    it('escapes single quote', async () => assert.equal(await xmlEsc("it's"), 'it&apos;s'));
    it('escapes all five entities in one string', async () => {
      assert.equal(await xmlEsc('<a href="x&y">it\'s</a>'), '&lt;a href=&quot;x&amp;y&quot;&gt;it&apos;s&lt;/a&gt;');
    });
    it('double-escapes are not applied (& in output becomes &amp; in one pass)', async () => {
      const result = await xmlEsc('a & b');
      assert.equal(result, 'a &amp; b');
      assert.ok(!result.includes('&amp;amp;'), 'should not double-escape');
    });
  });

  describe('control character stripping (XML 1.0 §2.2)', () => {
    it('strips NUL (\\x00)', async () => assert.equal(await xmlEsc('a\x00b'), 'ab'));
    it('strips SOH (\\x01)', async () => assert.equal(await xmlEsc('a\x01b'), 'ab'));
    it('strips BEL (\\x07)', async () => assert.equal(await xmlEsc('a\x07b'), 'ab'));
    it('strips BS (\\x08)', async () => assert.equal(await xmlEsc('a\x08b'), 'ab'));
    it('strips VT (\\x0B)', async () => assert.equal(await xmlEsc('a\x0Bb'), 'ab'));
    it('strips FF (\\x0C)', async () => assert.equal(await xmlEsc('a\x0Cb'), 'ab'));
    it('strips SO (\\x0E)', async () => assert.equal(await xmlEsc('a\x0Eb'), 'ab'));
    it('strips US (\\x1F)', async () => assert.equal(await xmlEsc('a\x1Fb'), 'ab'));
    it('preserves HT (\\x09 — XML-legal whitespace)', async () => assert.equal(await xmlEsc('a\x09b'), 'a\x09b'));
    it('preserves LF (\\x0A — XML-legal whitespace)', async () => assert.equal(await xmlEsc('a\x0Ab'), 'a\x0Ab'));
    it('preserves CR (\\x0D — XML-legal whitespace)', async () => assert.equal(await xmlEsc('a\x0Db'), 'a\x0Db'));
  });

  describe('lone surrogate stripping', () => {
    it('strips lone high surrogate (U+D800)', async () => {
      const s = 'a\uD800b';
      assert.equal(await xmlEsc(s), 'ab');
    });
    it('strips lone low surrogate (U+DFFF)', async () => {
      const s = 'a\uDFFFb';
      assert.equal(await xmlEsc(s), 'ab');
    });
    it('strips mid-range surrogate (U+DC00)', async () => {
      const s = 'a\uDC00b';
      assert.equal(await xmlEsc(s), 'ab');
    });
    it('keeps valid surrogate pairs (emoji)', async () => {
      const s = 'track \uD83C\uDFB5 title';
      assert.equal(await xmlEsc(s), s);
    });
    it('strips a lone half next to a valid pair', async () => {
      assert.equal(await xmlEsc('\uD83C\uDFB5\uD800x'), '\uD83C\uDFB5x');
    });
  });

  describe('non-character stripping (U+FFFE, U+FFFF)', () => {
    it('strips U+FFFE', async () => assert.equal(await xmlEsc('a\uFFFEb'), 'ab'));
    it('strips U+FFFF', async () => assert.equal(await xmlEsc('a\uFFFFb'), 'ab'));
  });

  describe('realistic ID3 tag scenarios', () => {
    it('handles typical clean title', async () => {
      assert.equal(await xmlEsc('Bohemian Rhapsody'), 'Bohemian Rhapsody');
    });

    it('handles title with apostrophe', async () => {
      assert.equal(await xmlEsc("Don't Stop Me Now"), 'Don&apos;t Stop Me Now');
    });

    it('handles artist name with ampersand', async () => {
      assert.equal(await xmlEsc('Simon & Garfunkel'), 'Simon &amp; Garfunkel');
    });

    it('handles title with embedded NUL (corrupted ID3)', async () => {
      const dirty = 'Track\x00Title';
      assert.equal(await xmlEsc(dirty), 'TrackTitle');
    });

    it('keeps an emoji in a title', async () => {
      assert.equal(await xmlEsc('Caf\uD83E\uDD14'), 'Caf\uD83E\uDD14');
    });

    it('handles title with lone surrogate from mojibake UTF-16', async () => {
      assert.equal(await xmlEsc('Caf\uDD14'), 'Caf');
    });

    it('handles non-ASCII characters (accented, CJK)', async () => {
      assert.equal(await xmlEsc('Björk'), 'Björk');
      assert.equal(await xmlEsc('日本語'), '日本語');
      assert.equal(await xmlEsc('Ünited Ütensils'), 'Ünited Ütensils');
    });

    it('handles URL string in res element', async () => {
      const url = 'https://music.example.com/media/Music/Artist/Song%20Title.mp3';
      const result = await xmlEsc(url);
      assert.ok(!result.includes('&amp;amp;'), 'no double escaping');
      assert.equal(result, url, 'clean URLs pass through unchanged');
    });
  });

});
