// One cover-art / tag writer for every format (P106).
//
// Run with:
//   node --test test/fix-r-workers-ffmpeg-tags.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseFile } from 'music-metadata';
import * as config from '../src/state/config.js';
import { ffmpegBin } from '../src/util/ffmpeg-bootstrap.js';
import { embedCover, writeTags, writeAudioWithTags, extractCover, canEmbedCover } from '../src/util/ffmpeg-tags.js';

const FORMATS = {
  mp3:  ['-c:a', 'libmp3lame', '-b:a', '32k'],
  m4a:  ['-c:a', 'aac', '-b:a', '32k'],
  flac: ['-c:a', 'flac'],
  opus: ['-c:a', 'libopus', '-b:a', '24k'],
  ogg:  ['-c:a', 'libopus', '-b:a', '24k'],
};

let dir;
const ff = args => execFileSync(ffmpegBin(), ['-y', '-loglevel', 'error', ...args]);

function makeAudio(name, codecArgs, tags = {}) {
  const p = path.join(dir, name);
  const meta = Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '0.4', ...meta, ...codecArgs, p]);
  return p;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-fix-r-tags-'));
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, '{}');
  await config.setup(cfg);
  ff(['-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1', path.join(dir, 'red.jpg')]);
  ff(['-f', 'lavfi', '-i', 'color=blue:s=80x80', '-frames:v', '1', path.join(dir, 'blue.png')]);
  // Big enough that a base64 picture would not fit in one command-line argument.
  ff(['-f', 'lavfi', '-i', 'nullsrc=s=1000x1000,geq=random(1)*255:128:128', '-frames:v', '1', '-q:v', '2', path.join(dir, 'big.jpg')]);
});

after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const leftovers = () => fs.readdirSync(dir).filter(f => f.startsWith('.velvet-tag-'));

describe('embedCover', () => {
  for (const [ext, codec] of Object.entries(FORMATS)) {
    it(`${ext}: embeds exactly one picture and keeps the tags`, async () => {
      const file = makeAudio(`a.${ext}`, codec, { title: 'Song', artist: 'Band' });
      await embedCover({ input: file, artPath: path.join(dir, 'red.jpg') });
      const m = await parseFile(file);
      assert.equal(m.common.picture?.length, 1);
      assert.equal(m.common.title, 'Song');
      assert.equal(m.common.artist, 'Band');
      assert.deepEqual(leftovers(), []);
    });

    it(`${ext}: a second cover replaces the first`, async () => {
      const file = path.join(dir, `a.${ext}`);
      await embedCover({ input: file, artPath: path.join(dir, 'blue.png') });
      const m = await parseFile(file);
      assert.equal(m.common.picture?.length, 1);
    });
  }

  it('opus takes a cover of a megabyte (too long for a command-line argument)', async () => {
    const file = makeAudio('big.opus', FORMATS.opus);
    await embedCover({ input: file, artPath: path.join(dir, 'big.jpg') });
    const m = await parseFile(file);
    assert.equal(m.common.picture[0].data.length, fs.statSync(path.join(dir, 'big.jpg')).size);
  });

  it('writes to another output with extra tags and leaves the input alone', async () => {
    const input = makeAudio('in.mp3', FORMATS.mp3);
    const output = path.join(dir, 'out.mp3');
    await embedCover({ input, output, artPath: path.join(dir, 'red.jpg'), metadata: { title: 'New', album: null } });
    assert.equal((await parseFile(output)).common.title, 'New');
    assert.equal((await parseFile(input)).common.picture, undefined);
  });

  it('refuses WAV and leaves the file untouched', async () => {
    const file = makeAudio('a.wav', ['-c:a', 'pcm_s16le']);
    const before = fs.readFileSync(file);
    assert.equal(canEmbedCover(file), false);
    await assert.rejects(embedCover({ input: file, artPath: path.join(dir, 'red.jpg') }));
    assert.deepEqual(fs.readFileSync(file), before);
  });
});

describe('writeTags', () => {
  for (const ext of Object.keys(FORMATS)) {
    it(`${ext}: changes a tag, keeps the others and the cover`, async () => {
      const file = path.join(dir, `a.${ext}`);
      await writeTags(file, { title: 'Renamed', album: 'LP' });
      const m = await parseFile(file);
      assert.equal(m.common.title, 'Renamed');
      assert.equal(m.common.album, 'LP');
      assert.equal(m.common.artist, 'Band');
      assert.equal(m.common.picture?.length, 1);
      assert.ok(await extractCover(file));
    });
  }

  it('wav: writes the tag', async () => {
    const file = path.join(dir, 'a.wav');
    await writeTags(file, { title: 'Wave' });
    assert.equal((await parseFile(file)).common.title, 'Wave');
  });

  it('writeAudioWithTags drops any picture', async () => {
    const output = path.join(dir, 'plain.flac');
    await writeAudioWithTags({ input: path.join(dir, 'a.flac'), output, metadata: { title: 'Plain' } });
    const m = await parseFile(output);
    assert.equal(m.common.title, 'Plain');
    assert.equal(m.common.picture, undefined);
  });
});
