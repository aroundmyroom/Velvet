/**
 * regression-bootstrap-helpers.cjs
 *
 * Verifies that the shared bootstrap-helpers.js module exports
 * the expected functions and that computeFileChecksum works correctly
 * against a known file.
 *
 * Run: node /home/velvet/test/regression-bootstrap-helpers.cjs
 */
'use strict';

const fs    = require('node:fs');
const fsp   = require('node:fs/promises');
const path  = require('node:path');
const os    = require('node:os');
const crypto = require('node:crypto');

let pass = 0;
let fail = 0;

function check(label, result, expected) {
  if (result === expected) {
    console.log(`  ✓  ${label}`);
    pass++;
  } else {
    console.error(`  ✗  ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(result)}`);
    fail++;
  }
}

async function main() {
  const { downloadToBuffer, downloadToFile, computeFileChecksum } =
    await import('../src/util/bootstrap-helpers.js');

  console.log('\n── bootstrap-helpers exports ────────────────────────────────────────');
  check('downloadToBuffer is a function', typeof downloadToBuffer, 'function');
  check('downloadToFile is a function',   typeof downloadToFile,   'function');
  check('computeFileChecksum is a function', typeof computeFileChecksum, 'function');

  console.log('\n── computeFileChecksum ──────────────────────────────────────────────');
  // Write a temp file with known content, verify the checksum
  const tmpDir  = await fsp.mkdtemp(path.join(os.tmpdir(), 'velvet-test-'));
  const tmpFile = path.join(tmpDir, 'test.txt');
  const content = 'Hello, mStream Velvet!';

  // Compute expected hash independently
  const expected = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  await fsp.writeFile(tmpFile, content, 'utf8');

  const actual = await computeFileChecksum(tmpFile);
  check(`SHA-256 of known content matches`, actual, expected);

  // Clean up
  await fsp.unlink(tmpFile).catch(() => {});
  await fsp.rmdir(tmpDir).catch(() => {});

  console.log('\n── bootstrap files import shared helpers ───────────────────────────');
  // Verify each bootstrap file no longer defines its own downloadToFile
  const bootstrapFiles = [
    'src/util/ffmpeg-bootstrap.js',
    'src/util/fpcalc-bootstrap.js',
    'src/util/rsgain-bootstrap.js',
  ];
  for (const f of bootstrapFiles) {
    const src = fs.readFileSync(path.join('/home/velvet', f), 'utf8');
    const hasLocalDef = /^function downloadToFile\b/.test(src) || /^function downloadToBuffer\b/.test(src);
    check(`${f} has no local downloadToFile/Buffer`, hasLocalDef, false);
    const hasImport = src.includes("from './bootstrap-helpers.js'");
    check(`${f} imports from bootstrap-helpers.js`, hasImport, true);
  }

  console.log('\n── BUNDLED_*_DIR not exported ──────────────────────────────────────');
  for (const f of bootstrapFiles) {
    const src = fs.readFileSync(path.join('/home/velvet', f), 'utf8');
    const hasExport = /^export const BUNDLED_/m.test(src);
    check(`${f} does not export BUNDLED_*_DIR`, hasExport, false);
  }

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`RESULT: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
