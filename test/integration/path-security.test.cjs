/**
 * Path Security — Unit Tests
 * Verifies the backend path helpers reject traversal and only allow trusted roots.
 */

'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-path-sec-'));
const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mstream-path-sec-out-'));
const insideFile = path.join(tmpRoot, 'inside.pem');
const outsideFile = path.join(outsideRoot, 'outside.pem');
fs.writeFileSync(insideFile, 'inside');
fs.writeFileSync(outsideFile, 'outside');

async function loadHelpers() {
  return import('../../src/util/path-security.js');
}

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(outsideRoot, { recursive: true, force: true }); } catch {}
});

describe('path-security helpers', () => {
  it('keeps child paths within the base directory', async () => {
    const { resolveChildPath } = await loadHelpers();
    const resolved = resolveChildPath('/var/lib/music', 'albums');
    assert.equal(resolved, path.join('/var/lib/music', 'albums'));
  });

  it('rejects traversal segments in child paths', async () => {
    const { resolveChildPath } = await loadHelpers();
    assert.throws(() => resolveChildPath('/var/lib/music', '../etc/passwd'));
  });

  it('allows existing files inside trusted roots', async () => {
    const { resolveExistingFileWithinRoots } = await loadHelpers();
    const resolved = resolveExistingFileWithinRoots(insideFile, [tmpRoot]);
    assert.equal(resolved, fs.realpathSync(insideFile));
  });

  it('rejects files outside trusted roots', async () => {
    const { resolveExistingFileWithinRoots } = await loadHelpers();
    assert.throws(() => resolveExistingFileWithinRoots(outsideFile, [tmpRoot]));
  });
});
