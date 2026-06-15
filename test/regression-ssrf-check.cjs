/**
 * regression-ssrf-check.cjs
 *
 * Verifies that isPrivateHost() in src/util/ssrf-check.js correctly blocks
 * private/loopback/link-local addresses and allows public ones.
 *
 * Run: node /home/mStream/test/regression-ssrf-check.cjs
 */
'use strict';

let pass = 0;
let fail = 0;

async function main() {
  // Dynamic import of ESM module from CJS
  const { isPrivateHost } = await import('../src/util/ssrf-check.js');

  function check(label, input, expected) {
    const result = isPrivateHost(input);
    if (result === expected) {
      console.log(`  ✓  ${label}`);
      pass++;
    } else {
      console.error(`  ✗  ${label} — expected ${expected}, got ${result} for input: ${input}`);
      fail++;
    }
  }

  console.log('\n── isPrivateHost() — should BLOCK ──────────────────────────────────');
  // IPv4 loopback
  check('127.0.0.1',           '127.0.0.1',       true);
  check('127.255.255.255',     '127.255.255.255',  true);
  check('localhost',            'localhost',         true);
  // IPv4 private
  check('10.0.0.1',            '10.0.0.1',         true);
  check('10.255.255.255',      '10.255.255.255',    true);
  check('172.16.0.1',          '172.16.0.1',        true);
  check('172.31.255.255',      '172.31.255.255',    true);
  check('192.168.1.1',         '192.168.1.1',       true);
  check('192.168.255.255',     '192.168.255.255',   true);
  // IPv4 link-local (APIPA / AWS metadata)
  check('169.254.0.1',         '169.254.0.1',       true);
  check('169.254.169.254',     '169.254.169.254',   true);  // AWS metadata
  // IPv6 loopback
  check('::1',                  '::1',               true);
  check(':: (unspecified)',     '::',                true);
  // IPv6 ULA
  check('fc00::1',              'fc00::1',           true);
  check('fd00::1',              'fd00::1',           true);
  check('fd12:3456:789a::1',   'fd12:3456:789a::1', true);
  // IPv6 link-local
  check('fe80::1',              'fe80::1',           true);
  check('fe90::1',              'fe90::1',           true);
  check('fea0::1',              'fea0::1',           true);
  check('feb0::1',              'feb0::1',           true);
  // IPv4-mapped IPv6 (private range)
  check('::ffff:192.168.1.1',  '::ffff:192.168.1.1', true);
  check('::ffff:10.0.0.1',     '::ffff:10.0.0.1',    true);
  check('::ffff:127.0.0.1',    '::ffff:127.0.0.1',   true);
  check('::ffff:169.254.169.254','::ffff:169.254.169.254', true);

  console.log('\n── isPrivateHost() — should ALLOW ──────────────────────────────────');
  // Public IPv4
  check('8.8.8.8',             '8.8.8.8',            false);
  check('1.1.1.1',             '1.1.1.1',            false);
  check('93.184.216.34',       '93.184.216.34',       false);
  check('172.15.255.255',      '172.15.255.255',      false);  // just outside 172.16-31
  check('172.32.0.1',          '172.32.0.1',          false);  // just outside 172.16-31
  check('192.167.1.1',         '192.167.1.1',         false);  // near but not 192.168
  check('169.253.255.255',     '169.253.255.255',     false);  // just outside 169.254
  // Public IPv6
  check('2001:db8::1',         '2001:db8::1',         false);
  check('2600::',              '2600::',              false);
  // IPv4-mapped public
  check('::ffff:8.8.8.8',     '::ffff:8.8.8.8',      false);

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`RESULT: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
