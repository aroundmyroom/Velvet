import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { before, after } from 'node:test';
import { startServer } from '../helpers/server.mjs';

let srv;

before(async () => {
  srv = await startServer({ waitForScan: false });
  const dir = path.join(srv.tmpDir, 'image-cache');
  await fs.writeFile(path.join(dir, 'abc123.jpg'), 'full');
  await fs.writeFile(path.join(dir, 'zs-abc123.jpg'), 'small');
});

after(async () => { await srv?.stop(); });

test('album art is served immutable with a long max-age', async () => {
  const r = await fetch(`${srv.baseUrl}/album-art/abc123.jpg`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'full');
  assert.match(r.headers.get('cache-control'), /max-age=31536000/);
  assert.match(r.headers.get('cache-control'), /immutable/);
});

test('compressed variant is preferred and also immutable', async () => {
  const r = await fetch(`${srv.baseUrl}/album-art/abc123.jpg?compress=s`);
  assert.equal(await r.text(), 'small');
  assert.match(r.headers.get('cache-control'), /immutable/);
});

test('missing compressed variant falls back to the original', async () => {
  const r = await fetch(`${srv.baseUrl}/album-art/abc123.jpg?compress=l`);
  assert.equal(await r.text(), 'full');
});

test('missing art returns the no-store fallback SVG', async () => {
  const r = await fetch(`${srv.baseUrl}/album-art/nope.jpg`);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('content-type'), /svg/);
});
