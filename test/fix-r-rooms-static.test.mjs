// P147 / P145: the CSP blocks inline handlers, and the phone app's Quality setting reaches /transcode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('shared and mobile pages carry no inline on* handlers', () => {
  for (const rel of ['webapp/shared/app.js', 'webapp/mobile/app.js', 'webapp/server-remote/app.js']) {
    assert.doesNotMatch(read(rel), /\son(click|error|load)=/, rel);
  }
});

test('mobile streamUrl builds a /transcode URL for a non-original quality', () => {
  const src = read('webapp/mobile/app.js');
  const body = src.slice(src.indexOf('function useTranscode()'), src.indexOf('function radioStreamUrl('));
  const S = { serverUrl: 'https://v.example', token: 'tok', transcodeOk: true, quality: 'mp3-128' };
  // eslint-disable-next-line sonarjs/code-eval
  const { streamUrl } = vm.runInNewContext(`${body}; ({ streamUrl })`, { S, URLSearchParams });
  const u = new URL(streamUrl('Music/A b/c#.flac', 42));
  assert.equal(u.pathname, '/transcode/Music/A%20b/c%23.flac');
  assert.equal(u.searchParams.get('codec'), 'mp3');
  assert.equal(u.searchParams.get('bitrate'), '128k');
  assert.equal(u.searchParams.get('offset'), '42');
  assert.equal(u.searchParams.get('token'), 'tok');
  S.quality = 'original';
  assert.equal(streamUrl('Music/x.flac'), 'https://v.example/media/Music/x.flac?token=tok');
  S.quality = 'opus-64';
  S.transcodeOk = false;
  assert.equal(streamUrl('Music/x.flac'), 'https://v.example/media/Music/x.flac?token=tok', 'no transcoding on the server: original');
});
