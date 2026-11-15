'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('isPrivateHost (src/util/ssrf-check.js)', async () => {
  const { isPrivateHost } = await import('../../src/util/ssrf-check.js');

  describe('localhost', () => {
    it('blocks "localhost"', () => assert.ok(isPrivateHost('localhost')));
    it('blocks "LOCALHOST" (case-insensitive)', () => assert.ok(isPrivateHost('LOCALHOST')));
    it('blocks "Localhost" (mixed case)', () => assert.ok(isPrivateHost('Localhost')));
  });

  describe('IPv4 loopback 127.0.0.0/8', () => {
    it('blocks 127.0.0.1', () => assert.ok(isPrivateHost('127.0.0.1')));
    it('blocks 127.0.0.0 (network address)', () => assert.ok(isPrivateHost('127.0.0.0')));
    it('blocks 127.255.255.255 (broadcast)', () => assert.ok(isPrivateHost('127.255.255.255')));
    it('blocks 127.1.2.3 (arbitrary loopback)', () => assert.ok(isPrivateHost('127.1.2.3')));
  });

  describe('IPv4 private 10.0.0.0/8', () => {
    it('blocks 10.0.0.1', () => assert.ok(isPrivateHost('10.0.0.1')));
    it('blocks 10.255.255.255', () => assert.ok(isPrivateHost('10.255.255.255')));
    it('blocks 10.10.10.10', () => assert.ok(isPrivateHost('10.10.10.10')));
  });

  describe('IPv4 private 192.168.0.0/16', () => {
    it('blocks 192.168.0.1', () => assert.ok(isPrivateHost('192.168.0.1')));
    it('blocks 192.168.1.1 (common router)', () => assert.ok(isPrivateHost('192.168.1.1')));
    it('blocks 192.168.255.255', () => assert.ok(isPrivateHost('192.168.255.255')));
  });

  describe('IPv4 private 172.16.0.0/12', () => {
    it('blocks 172.16.0.1 (range start)', () => assert.ok(isPrivateHost('172.16.0.1')));
    it('blocks 172.20.5.5', () => assert.ok(isPrivateHost('172.20.5.5')));
    it('blocks 172.31.255.255 (range end)', () => assert.ok(isPrivateHost('172.31.255.255')));
    it('does NOT block 172.15.0.1 (just outside range)', () => assert.ok(!isPrivateHost('172.15.0.1')));
    it('does NOT block 172.32.0.1 (just outside range)', () => assert.ok(!isPrivateHost('172.32.0.1')));
  });

  describe('IPv4 link-local / APIPA 169.254.0.0/16', () => {
    it('blocks 169.254.169.254 (AWS/GCP metadata endpoint)', () => assert.ok(isPrivateHost('169.254.169.254')));
    it('blocks 169.254.0.1', () => assert.ok(isPrivateHost('169.254.0.1')));
    it('blocks 169.254.255.255', () => assert.ok(isPrivateHost('169.254.255.255')));
    it('does NOT block 169.253.0.1 (adjacent, not APIPA)', () => assert.ok(!isPrivateHost('169.253.0.1')));
    it('does NOT block 169.255.0.1 (adjacent, not APIPA)', () => assert.ok(!isPrivateHost('169.255.0.1')));
  });

  describe('IPv6 loopback and unspecified', () => {
    it('blocks ::1 (loopback)', () => assert.ok(isPrivateHost('::1')));
    it('blocks :: (unspecified)', () => assert.ok(isPrivateHost('::')));
    it('blocks [::1] (URL.hostname keeps IPv6 brackets)', () => assert.ok(isPrivateHost('[::1]')));
  });

  describe('IPv6 ULA fc00::/7', () => {
    it('blocks fc00::1', () => assert.ok(isPrivateHost('fc00::1')));
    it('blocks fd00::1', () => assert.ok(isPrivateHost('fd00::1')));
    it('blocks fd12:3456::1', () => assert.ok(isPrivateHost('fd12:3456::1')));
    it('blocks FC00::1 (uppercase)', () => assert.ok(isPrivateHost('FC00::1')));
    it('does NOT block fb00::1 (fb is not fc/fd)', () => assert.ok(!isPrivateHost('fb00::1')));
    it('does NOT block fe00::1 (fe is not fc/fd)', () => assert.ok(!isPrivateHost('fe00::1')));
  });

  describe('IPv6 link-local fe80::/10', () => {
    it('blocks fe80::1 (common link-local)', () => assert.ok(isPrivateHost('fe80::1')));
    it('blocks fe90::1 (fe90 is in fe80::/10)', () => assert.ok(isPrivateHost('fe90::1')));
    it('blocks fea0::1', () => assert.ok(isPrivateHost('fea0::1')));
    it('blocks feb0::1 (febf is last in fe80::/10)', () => assert.ok(isPrivateHost('feb0::1')));
    it('does NOT block fec0::1 (fec0 is outside fe80::/10)', () => assert.ok(!isPrivateHost('fec0::1')));
    it('does NOT block fe70::1 (below fe80)', () => assert.ok(!isPrivateHost('fe70::1')));
    it('blocks FE80::1 (uppercase)', () => assert.ok(isPrivateHost('FE80::1')));
  });

  describe('IPv4-mapped IPv6 ::ffff:x.x.x.x', () => {
    it('blocks ::ffff:127.0.0.1 (mapped loopback)', () => assert.ok(isPrivateHost('::ffff:127.0.0.1')));
    it('blocks ::ffff:192.168.1.1 (mapped private)', () => assert.ok(isPrivateHost('::ffff:192.168.1.1')));
    it('blocks ::ffff:10.0.0.1 (mapped private)', () => assert.ok(isPrivateHost('::ffff:10.0.0.1')));
    it('blocks ::ffff:169.254.169.254 (mapped metadata)', () => assert.ok(isPrivateHost('::ffff:169.254.169.254')));
    it('does NOT block ::ffff:8.8.8.8 (mapped public)', () => assert.ok(!isPrivateHost('::ffff:8.8.8.8')));
    it('does NOT block ::ffff:1.1.1.1 (mapped public)', () => assert.ok(!isPrivateHost('::ffff:1.1.1.1')));
  });

  describe('legitimate public addresses (must NOT be blocked)', () => {
    it('allows 8.8.8.8 (Google DNS)', () => assert.ok(!isPrivateHost('8.8.8.8')));
    it('allows 1.1.1.1 (Cloudflare DNS)', () => assert.ok(!isPrivateHost('1.1.1.1')));
    it('allows 93.184.216.34 (example.com)', () => assert.ok(!isPrivateHost('93.184.216.34')));
    it('allows 2606:4700::6810:84e5 (Cloudflare IPv6)', () => assert.ok(!isPrivateHost('2606:4700::6810:84e5')));
    it('allows last.fm server hostname pattern', () => assert.ok(!isPrivateHost('ws.audioscrobbler.com')));
    it('allows radio-browser.info', () => assert.ok(!isPrivateHost('all.api.radio-browser.info')));
  });

});
