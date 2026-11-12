import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createArtwork, paletteFrom, contrast } from '../src/sendspin/artwork.js';

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

test('palette keeps WCAG 4.5:1 for every primary', () => {
  const primaries = [[0, 0, 0], [255, 255, 255], [128, 128, 128], [255, 0, 0], [20, 200, 40], [30, 30, 220], [250, 230, 30], [119, 119, 119]];
  for (const p of primaries) {
    const c = paletteFrom(p, [p, [10, 120, 200], [200, 40, 90]]);
    assert.deepEqual(c.primary, p);
    assert.ok(contrast(c.background_dark, WHITE) >= 4.5, `bg_dark/white ${p}`);
    assert.ok(contrast(c.background_dark, c.on_dark) >= 4.5, `bg_dark/on_dark ${p}`);
    assert.ok(contrast(c.on_dark, BLACK) >= 4.5, `on_dark/black ${p}`);
    assert.ok(contrast(c.background_light, BLACK) >= 4.5, `bg_light/black ${p}`);
    assert.ok(contrast(c.background_light, c.on_light) >= 4.5, `bg_light/on_light ${p}`);
    assert.ok(contrast(c.on_light, WHITE) >= 4.5, `on_light/white ${p}`);
    for (const v of Object.values(c)) assert.ok(v.length === 3 && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255));
  }
});

test('artwork is fitted inside the channel size with black padding, never cropped', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-art-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 250, g: 20, b: 20 } } }).png().toFile(path.join(dir, 'abc.png'));
  const art = createArtwork({ artDir: dir });
  const item = { file: path.join(dir, 'song.flac'), meta: { aaFile: 'abc.png' } };

  const jpeg = await art.artworkFor(item, { source: 'album', format: 'jpeg', width: 300, height: 300 });
  const meta = await sharp(jpeg).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.deepEqual([meta.width, meta.height], [300, 300]);
  const { data } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => [...data.subarray((y * 300 + x) * 3, (y * 300 + x) * 3 + 3)];
  assert.ok(px(150, 10).every((v) => v < 16), 'padding is black');
  assert.ok(px(150, 150)[0] > 200, 'image centred');
  assert.ok(px(2, 150)[0] > 200, 'full width kept (no crop)');

  const png = await art.artworkFor(item, { source: 'album', format: 'png', width: 64, height: 32 });
  assert.deepEqual(await sharp(png).metadata().then((m) => [m.format, m.width, m.height]), ['png', 64, 32]);
  assert.equal(await art.artworkFor(item, { source: 'artist', format: 'png', width: 64, height: 32 }), null);
  assert.equal(await art.artworkFor({ file: path.join(dir, 'none.flac'), meta: { aaFile: '../etc/passwd' } }, { source: 'album', format: 'png', width: 8, height: 8 }), null);

  const colors = await art.colorFor(item);
  assert.ok(colors.primary[0] > 200 && colors.primary[1] < 60);
});
