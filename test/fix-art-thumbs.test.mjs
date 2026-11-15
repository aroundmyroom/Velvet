import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import mime from 'mime-types';
import sharp from 'sharp';
import { artFileName, writeArtWithThumbs } from '../src/util/art-cache.js';

const src = rel => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

function oldScannerEmbeddedName(buf, format) {
  const raw = mime.extension(format);
  return crypto.createHash('md5').update(buf).digest('hex') + '.' + ((raw === 'jpeg') ? 'jpg' : (raw || 'jpg'));
}

describe('artFileName keeps the scanner naming', () => {
  const buf = crypto.randomBytes(500);
  for (const fmt of ['image/jpeg', 'image/png', 'image/jpg', 'image/webp']) {
    it(fmt, () => assert.equal(artFileName(buf, fmt), oldScannerEmbeddedName(buf, fmt)));
  }
  it('folder image keeps its own extension', () => {
    assert.equal(artFileName(buf, 'JPG'), crypto.createHash('md5').update(buf).digest('hex') + '.JPG');
  });
});

describe('writeArtWithThumbs', () => {
  let dir, png;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-artthumbs-'));
    png = await sharp({ create: { width: 1000, height: 800, channels: 3, background: '#336699' } }).png().toBuffer();
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes the original plus zs/zl/zm at 92/256/512', async () => {
    const name = artFileName(png, 'image/png');
    assert.equal(await writeArtWithThumbs(dir, png, name), true);
    assert.ok(fs.existsSync(path.join(dir, name)));
    for (const [prefix, px] of [['zs-', 92], ['zl-', 256], ['zm-', 512]]) {
      const meta = await sharp(path.join(dir, prefix + name)).metadata();
      assert.equal(Math.max(meta.width, meta.height), px, prefix);
    }
  });

  it('compress: false writes only the original', async () => {
    const buf = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#000' } }).jpeg().toBuffer();
    const name = artFileName(buf, 'image/jpeg');
    assert.equal(await writeArtWithThumbs(dir, buf, name, { compress: false }), true);
    assert.ok(fs.existsSync(path.join(dir, name)));
    assert.ok(!fs.existsSync(path.join(dir, 'zl-' + name)));
  });

  it('corrupt image falls back to copying the original as zl/zs', async () => {
    const bad = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(400)]);
    const name = artFileName(bad, 'image/jpeg');
    assert.equal(await writeArtWithThumbs(dir, bad, name), false);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'zl-' + name)), bad);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'zs-' + name)), bad);
  });

  it('rejects names that escape the art dir', async () => {
    await assert.rejects(writeArtWithThumbs(dir, png, '../escape.png'));
  });
});

describe('callers use the shared helper', () => {
  for (const file of ['src/db/scanner.mjs', 'src/api/discogs.js', 'src/api/album-art-workshop.js', 'src/db/image-compress-script.js', 'src/api/download.js']) {
    it(file, () => {
      const s = src(file);
      assert.ok(s.includes('writeArtWithThumbs('), 'uses writeArtWithThumbs');
      assert.ok(!/sharp\([^)]*\)\s*\.resize\((92|256|512),/.test(s), 'no own thumbnail resize');
    });
  }
  it('scanner names art with artFileName and has no compressAlbumArt', () => {
    const s = src('src/db/scanner.mjs');
    assert.ok(!s.includes('compressAlbumArt'));
    assert.equal((s.match(/artFileName\(/g) || []).length, 2);
  });
  it('discogs cleanup removes zm- too', () => {
    assert.ok(src('src/api/discogs.js').includes("['', 'zl-', 'zs-', 'zm-']"));
  });
});
