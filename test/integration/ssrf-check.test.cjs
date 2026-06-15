/**
 * SSRF Check — Unit Tests
 * Mirrors the _ssrfCheck function from src/api/radio.js and src/api/podcasts.js.
 * Both files contain identical copies of this function; both are kept in sync.
 *
 * Covers:
 *   - IPv4 loopback (127.x.x.x), private (10.x, 172.16-31.x, 192.168.x)
 *   - IPv4 link-local / APIPA (169.254.x.x) — cloud metadata endpoint
 *   - IPv6 loopback (::1), unspecified (::)
 *   - IPv6 ULA (fc00::/7 — fc/fd prefixes)
 *   - IPv6 link-local (fe80::/10 — fe80–febf)
 *   - IPv4-mapped IPv6 (::ffff:a.b.c.d) — recursed
 *   - Legitimate public addresses (should NOT be blocked)
 *   - Case-insensitivity
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ── Inline mirror of src/api/radio.js _ssrfCheck ─────────────────────────────
// Any change to this logic MUST also be reflected in src/api/radio.js
// and src/api/podcasts.js (both files carry an identical copy).
function _ssrfCheck(hostname) {
  const h = hostname.toLowerCase();
  // IPv4 private ranges + loopback
  if (h === 'localhost') return true;
  if (/^127\./.test(h) || /^10\./.test(h)) return true;
  if (/^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  // IPv4 link-local / APIPA (169.254.x.x) — includes AWS/GCP cloud metadata endpoint
  if (/^169\.254\./.test(h)) return true;
  // IPv6 loopback + unspecified
  if (h === '::1' || h === '::') return true;
  // IPv6 ULA (fc00::/7 — fc and fd prefixes)
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  // IPv6 link-local (fe80::/10 — second hex digit is 8, 9, a, or b)
  if (/^fe[89ab]/.test(h)) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — recurse with the v4 portion
  const v4mapped = h.match(/^::ffff:((\d+\.\d+\.\d+\.\d+))$/);
  if (v4mapped) return _ssrfCheck(v4mapped[1]);
  return false;
}
// ─────────────────────────────────────────────────────────────────────────────

describe('SSRF Check', () => {

  describe('localhost', () => {
    it('blocks "localhost"', () => assert.ok(_ssrfCheck('localhost')));
    it('blocks "LOCALHOST" (case-insensitive)', () => assert.ok(_ssrfCheck('LOCALHOST')));
    it('blocks "Localhost" (mixed case)', () => assert.ok(_ssrfCheck('Localhost')));
  });

  describe('IPv4 loopback 127.0.0.0/8', () => {
    it('blocks 127.0.0.1', () => assert.ok(_ssrfCheck('127.0.0.1')));
    it('blocks 127.0.0.0 (network address)', () => assert.ok(_ssrfCheck('127.0.0.0')));
    it('blocks 127.255.255.255 (broadcast)', () => assert.ok(_ssrfCheck('127.255.255.255')));
    it('blocks 127.1.2.3 (arbitrary loopback)', () => assert.ok(_ssrfCheck('127.1.2.3')));
  });

  describe('IPv4 private 10.0.0.0/8', () => {
    it('blocks 10.0.0.1', () => assert.ok(_ssrfCheck('10.0.0.1')));
    it('blocks 10.255.255.255', () => assert.ok(_ssrfCheck('10.255.255.255')));
    it('blocks 10.10.10.10', () => assert.ok(_ssrfCheck('10.10.10.10')));
  });

  describe('IPv4 private 192.168.0.0/16', () => {
    it('blocks 192.168.0.1', () => assert.ok(_ssrfCheck('192.168.0.1')));
    it('blocks 192.168.1.1 (common router)', () => assert.ok(_ssrfCheck('192.168.1.1')));
    it('blocks 192.168.255.255', () => assert.ok(_ssrfCheck('192.168.255.255')));
  });

  describe('IPv4 private 172.16.0.0/12', () => {
    it('blocks 172.16.0.1 (range start)', () => assert.ok(_ssrfCheck('172.16.0.1')));
    it('blocks 172.20.5.5', () => assert.ok(_ssrfCheck('172.20.5.5')));
    it('blocks 172.31.255.255 (range end)', () => assert.ok(_ssrfCheck('172.31.255.255')));
    it('does NOT block 172.15.0.1 (just outside range)', () => assert.ok(!_ssrfCheck('172.15.0.1')));
    it('does NOT block 172.32.0.1 (just outside range)', () => assert.ok(!_ssrfCheck('172.32.0.1')));
  });

  describe('IPv4 link-local / APIPA 169.254.0.0/16', () => {
    it('blocks 169.254.169.254 (AWS/GCP metadata endpoint)', () => assert.ok(_ssrfCheck('169.254.169.254')));
    it('blocks 169.254.0.1', () => assert.ok(_ssrfCheck('169.254.0.1')));
    it('blocks 169.254.255.255', () => assert.ok(_ssrfCheck('169.254.255.255')));
    it('does NOT block 169.253.0.1 (adjacent, not APIPA)', () => assert.ok(!_ssrfCheck('169.253.0.1')));
    it('does NOT block 169.255.0.1 (adjacent, not APIPA)', () => assert.ok(!_ssrfCheck('169.255.0.1')));
  });

  describe('IPv6 loopback and unspecified', () => {
    it('blocks ::1 (loopback)', () => assert.ok(_ssrfCheck('::1')));
    it('blocks :: (unspecified)', () => assert.ok(_ssrfCheck('::')));
    it('blocks ::1 uppercase', () => assert.ok(_ssrfCheck('::1')));
  });

  describe('IPv6 ULA fc00::/7', () => {
    it('blocks fc00::1', () => assert.ok(_ssrfCheck('fc00::1')));
    it('blocks fd00::1', () => assert.ok(_ssrfCheck('fd00::1')));
    it('blocks fd12:3456::1', () => assert.ok(_ssrfCheck('fd12:3456::1')));
    it('blocks FC00::1 (uppercase)', () => assert.ok(_ssrfCheck('FC00::1')));
    it('does NOT block fb00::1 (fb is not fc/fd)', () => assert.ok(!_ssrfCheck('fb00::1')));
    it('does NOT block fe00::1 (fe is not fc/fd)', () => assert.ok(!_ssrfCheck('fe00::1')));
  });

  describe('IPv6 link-local fe80::/10', () => {
    it('blocks fe80::1 (common link-local)', () => assert.ok(_ssrfCheck('fe80::1')));
    it('blocks fe90::1 (fe90 is in fe80::/10)', () => assert.ok(_ssrfCheck('fe90::1')));
    it('blocks fea0::1', () => assert.ok(_ssrfCheck('fea0::1')));
    it('blocks feb0::1 (febf is last in fe80::/10)', () => assert.ok(_ssrfCheck('feb0::1')));
    it('does NOT block fec0::1 (fec0 is outside fe80::/10)', () => assert.ok(!_ssrfCheck('fec0::1')));
    it('does NOT block fe70::1 (below fe80)', () => assert.ok(!_ssrfCheck('fe70::1')));
    it('blocks FE80::1 (uppercase)', () => assert.ok(_ssrfCheck('FE80::1')));
  });

  describe('IPv4-mapped IPv6 ::ffff:x.x.x.x', () => {
    it('blocks ::ffff:127.0.0.1 (mapped loopback)', () => assert.ok(_ssrfCheck('::ffff:127.0.0.1')));
    it('blocks ::ffff:192.168.1.1 (mapped private)', () => assert.ok(_ssrfCheck('::ffff:192.168.1.1')));
    it('blocks ::ffff:10.0.0.1 (mapped private)', () => assert.ok(_ssrfCheck('::ffff:10.0.0.1')));
    it('blocks ::ffff:169.254.169.254 (mapped metadata)', () => assert.ok(_ssrfCheck('::ffff:169.254.169.254')));
    it('does NOT block ::ffff:8.8.8.8 (mapped public)', () => assert.ok(!_ssrfCheck('::ffff:8.8.8.8')));
    it('does NOT block ::ffff:1.1.1.1 (mapped public)', () => assert.ok(!_ssrfCheck('::ffff:1.1.1.1')));
  });

  describe('legitimate public addresses (must NOT be blocked)', () => {
    it('allows 8.8.8.8 (Google DNS)', () => assert.ok(!_ssrfCheck('8.8.8.8')));
    it('allows 1.1.1.1 (Cloudflare DNS)', () => assert.ok(!_ssrfCheck('1.1.1.1')));
    it('allows 93.184.216.34 (example.com)', () => assert.ok(!_ssrfCheck('93.184.216.34')));
    it('allows 2606:4700::6810:84e5 (Cloudflare IPv6)', () => assert.ok(!_ssrfCheck('2606:4700::6810:84e5')));
    it('allows last.fm server hostname pattern', () => assert.ok(!_ssrfCheck('ws.audioscrobbler.com')));
    it('allows radio-browser.info', () => assert.ok(!_ssrfCheck('all.api.radio-browser.info')));
  });

});
