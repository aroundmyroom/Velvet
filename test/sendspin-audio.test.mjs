import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  samplesToUs, Timeline, createDecoder, createEncoder, decodeQueue, pump, openTrack, probeChannels,
  FlacFramer, parseFlacFrameHeader, flacCodecHeader, MAX_CHUNK_MS, MIN_CHUNK_MS,
} from '../src/sendspin/audio.js';

const execFileP = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED = path.join(ROOT, 'bin/ffmpeg/ffmpeg');
const FFMPEG = process.env.FFMPEG || (fs.existsSync(BUNDLED) ? BUNDLED : 'ffmpeg');

let dir;
const F = {};

async function ff(args, input) {
  const p = execFileP(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'buffer', maxBuffer: 256 * 1024 * 1024,
  });
  if (input) { p.child.stdin.end(input); }
  return (await p).stdout;
}

const decodeRaw = (file, fmt, rate, ch) => ff(['-i', file, '-f', fmt, '-ar', String(rate), '-ac', String(ch), '-']);
const md5 = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function collect(enc) {
  const chunks = [];
  for await (const c of enc) chunks.push(c);
  return chunks;
}

function assertContinuous(chunks, format, baseUs = 0) {
  let t = baseUs;
  let s = 0;
  chunks.forEach((c, i) => {
    assert.equal(c.startUs, t, `chunk ${i} starts where the previous one ended`);
    assert.equal(c.durationUs, samplesToUs(s + c.samples, format.sample_rate) - samplesToUs(s, format.sample_rate));
    const ms = c.durationUs / 1000;
    assert.ok(ms <= MAX_CHUNK_MS, `chunk ${i} ${ms} ms too long`);
    if (i < chunks.length - 1) assert.ok(ms >= MIN_CHUNK_MS, `chunk ${i} ${ms} ms too short`);
    t += c.durationUs;
    s += c.samples;
  });
  return s;
}

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-audio-'));
  F.a44 = path.join(dir, 'a 44k.wav');
  F.b44 = path.join(dir, 'b-44k.wav');
  F.c48 = path.join(dir, 'c48.wav');
  F.n24 = path.join(dir, 'n24.wav');
  F.long = path.join(dir, 'long.flac');
  F.mono = path.join(dir, 'mono.wav');
  await ff(['-f', 'lavfi', '-i', 'sine=f=440:r=44100:d=3', '-ac', '2', '-c:a', 'pcm_s16le', F.a44]);
  await ff(['-f', 'lavfi', '-i', 'sine=f=660:r=44100:d=1.37', '-ac', '2', '-c:a', 'pcm_s16le', F.b44]);
  await ff(['-f', 'lavfi', '-i', 'sine=f=1000:r=48000:d=2', '-ac', '2', '-c:a', 'pcm_s16le', F.c48]);
  await ff(['-f', 'lavfi', '-i', 'anoisesrc=r=48000:a=0.3:d=2', '-ac', '2', '-c:a', 'pcm_s24le', F.n24]);
  await ff(['-f', 'lavfi', '-i', 'sine=f=220:r=44100:d=120', '-ac', '2', F.long]);
  await ff(['-f', 'lavfi', '-i', 'anoisesrc=r=44100:a=0.9:d=1.5', '-ac', '1', '-c:a', 'pcm_s16le', F.mono]);
});

after(() => fsp.rm(dir, { recursive: true, force: true }));

test('samplesToUs is exact for long timelines', () => {
  assert.equal(samplesToUs(44100, 44100), 1_000_000);
  assert.equal(samplesToUs(1, 44100), 22);
  const tenDays = 44100 * 86400 * 10 + 1;
  assert.equal(samplesToUs(tenDays, 44100), 864_000_000_000 + 22);
  const tl = new Timeline(44100, 5);
  let sum = 0;
  for (let i = 0; i < 100_000; i++) sum += tl.advance(1103).durationUs;
  assert.equal(sum, samplesToUs(110_300_000, 44100));
  assert.equal(tl.nowUs, 5 + sum);
});

test('pcm 16-bit: whole frames, bounded durations, bit-exact', async () => {
  const format = { codec: 'pcm', sample_rate: 44100, channels: 2, bit_depth: 16 };
  const enc = openTrack({ file: F.a44, format, ffmpeg: FFMPEG });
  assert.equal(enc.codecHeader, null);
  const chunks = await collect(enc);
  for (const c of chunks) assert.equal(c.frame.length, c.samples * 4);
  assert.equal(assertContinuous(chunks, format), 132300);
  const ref = await decodeRaw(F.a44, 's16le', 44100, 2);
  assert.equal(md5(Buffer.concat(chunks.map((c) => c.frame))), md5(ref));
});

test('pcm 24-bit is packed as 3 bytes per sample, bit-exact', async () => {
  const format = { codec: 'pcm', sample_rate: 48000, channels: 2, bit_depth: 24 };
  const chunks = await collect(openTrack({ file: F.n24, format, ffmpeg: FFMPEG }));
  for (const c of chunks) assert.equal(c.frame.length, c.samples * 6);
  assert.equal(assertContinuous(chunks, format), 96000);
  const ref = await decodeRaw(F.n24, 's24le', 48000, 2);
  assert.equal(md5(Buffer.concat(chunks.map((c) => c.frame))), md5(ref));
});

async function flacRoundTrip(file, format, rawFmt) {
  const enc = openTrack({ file, format, ffmpeg: FFMPEG });
  const header = Buffer.from(enc.codecHeader, 'base64');
  const chunks = await collect(enc);
  for (const c of chunks) {
    const h = parseFlacFrameHeader(c.frame, 0);
    assert.ok(h, 'chunk starts with a valid frame header');
    assert.equal(h.blockSize, c.samples);
  }
  const total = assertContinuous(chunks, format);
  const decoded = await ff(['-f', 'flac', '-i', 'pipe:0', '-f', rawFmt, '-'], Buffer.concat([header, ...chunks.map((c) => c.frame)]));
  return { header, chunks, total, decoded, enc };
}

test('flac 16-bit: complete frames per chunk, lossless round trip', async () => {
  const format = { codec: 'flac', sample_rate: 44100, channels: 2, bit_depth: 16 };
  const { header, chunks, total, decoded, enc } = await flacRoundTrip(F.a44, format, 's16le');
  assert.equal(header.length, 42);
  assert.equal(header.toString('latin1', 0, 4), 'fLaC');
  assert.equal(header[4], 0x80);
  assert.equal(chunks[0].samples, enc.chunkSamples);
  assert.equal(total, 132300);
  assert.equal(md5(decoded), md5(await decodeRaw(F.a44, 's16le', 44100, 2)));
});

test('flac 24-bit: lossless round trip', async () => {
  const format = { codec: 'flac', sample_rate: 48000, channels: 2, bit_depth: 24 };
  const { total, decoded } = await flacRoundTrip(F.n24, format, 's24le');
  assert.equal(total, 96000);
  assert.equal(md5(decoded), md5(await decodeRaw(F.n24, 's24le', 48000, 2)));
});

test('flac STREAMINFO matches what ffmpeg writes', async () => {
  const fmt = { sampleRate: 48000, channels: 2, bitDepth: 24, blockSize: 2400 };
  const ours = flacCodecHeader(fmt);
  const theirs = await ff(['-i', F.n24, '-t', '0.1', '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24',
    '-frame_size', '2400', '-f', 'flac', '-']);
  assert.deepEqual(ours.subarray(5, 14), theirs.subarray(5, 14));
  assert.deepEqual(ours.subarray(20, 42), theirs.subarray(20, 42));
  assert.equal(ours.readUIntBE(14, 3), 0, 'min frame size unknown');
});

test('FlacFramer splits a stream fed in tiny pieces identically', async () => {
  const stream = await ff(['-i', F.a44, '-c:a', 'flac', '-frame_size', '1000', '-f', 'flac', '-']);
  const whole = new FlacFramer();
  const ref = [...whole.push(stream), ...whole.end()];
  const framer = new FlacFramer();
  const got = [];
  let p = 0;
  let step = 1;
  while (p < stream.length) {
    got.push(...framer.push(stream.subarray(p, p + step)));
    p += step;
    step = (step % 7) + 1;
  }
  got.push(...framer.end());
  assert.equal(got.length, ref.length);
  assert.equal(got.length, Math.ceil(132300 / 1000));
  got.forEach((f, i) => assert.ok(f.frame.equals(ref[i].frame)));
  assert.ok(stream.subarray(stream.length - Buffer.concat(got.map((f) => f.frame)).length).equals(Buffer.concat(got.map((f) => f.frame))));
});

test('gapless: two tracks form one continuous timeline', async () => {
  const format = { codec: 'flac', sample_rate: 44100, channels: 2, bit_depth: 16 };
  const enc = createEncoder({ format, inputRate: 44100, inputChannels: 2, baseUs: 1_000_000, ffmpeg: FFMPEG });
  const pcm = createEncoder({ format: { ...format, codec: 'pcm' }, inputRate: 44100, inputChannels: 2, baseUs: 1_000_000 });
  const starts = [];
  async function* withMarks() {
    for await (const item of decodeQueue([{ file: F.a44 }, { file: F.b44 }], { sampleRate: 44100, channels: 2, ffmpeg: FFMPEG })) {
      if (item.trackStart) starts.push(item.sample);
      yield item;
    }
  }
  const pumping = pump(withMarks(), [enc, pcm]);
  const [flacChunks, pcmChunks] = await Promise.all([collect(enc), collect(pcm)]);
  await pumping;
  assert.deepEqual(starts, [0, 132300]);
  const total = 132300 + Math.round(1.37 * 44100);
  assert.equal(assertContinuous(flacChunks, format, 1_000_000), total);
  assert.equal(assertContinuous(pcmChunks, format, 1_000_000), total);
  const ref = Buffer.concat([await decodeRaw(F.a44, 's16le', 44100, 2), await decodeRaw(F.b44, 's16le', 44100, 2)]);
  assert.equal(md5(Buffer.concat(pcmChunks.map((c) => c.frame))), md5(ref));
  const header = Buffer.from(enc.codecHeader, 'base64');
  const decoded = await ff(['-f', 'flac', '-i', 'pipe:0', '-f', 's16le', '-'], Buffer.concat([header, ...flacChunks.map((c) => c.frame)]));
  assert.equal(md5(decoded), md5(ref));
});

test('seek starts at startMs sample-exactly', async () => {
  const format = { codec: 'pcm', sample_rate: 44100, channels: 2, bit_depth: 16 };
  const chunks = await collect(openTrack({ file: F.a44, startMs: 1000, format, ffmpeg: FFMPEG }));
  const got = Buffer.concat(chunks.map((c) => c.frame));
  const ref = (await decodeRaw(F.a44, 's16le', 44100, 2)).subarray(44100 * 4);
  assert.equal(got.length, ref.length);
  assert.equal(md5(got), md5(ref));
});

test('mono source reaches a stereo master at unity gain, bit-exact on both sides', async () => {
  assert.equal(await probeChannels(F.mono, { ffmpeg: FFMPEG }), 1);
  assert.equal(await probeChannels(F.a44, { ffmpeg: FFMPEG }), 2);
  assert.equal(await probeChannels(path.join(dir, 'missing.wav'), { ffmpeg: FFMPEG }), null);
  const src = await decodeRaw(F.mono, 's16le', 44100, 1);
  const master = [];
  for await (const item of decodeQueue([{ file: F.mono }], { sampleRate: 44100, channels: 2, ffmpeg: FFMPEG })) master.push(item.pcm);
  const formats = [
    { codec: 'pcm', sample_rate: 44100, channels: 1, bit_depth: 16 },
    { codec: 'pcm', sample_rate: 44100, channels: 2, bit_depth: 16 },
  ];
  const encs = formats.map((format) => createEncoder({ format, inputRate: 44100, inputChannels: 2, ffmpeg: FFMPEG }));
  const pumping = pump(master, encs);
  const [mono, stereo] = (await Promise.all(encs.map(collect))).map((chunks) => Buffer.concat(chunks.map((c) => c.frame)));
  await pumping;
  assert.equal(md5(mono), md5(src), 'mono out == source');
  const left = Buffer.alloc(stereo.length / 2);
  const right = Buffer.alloc(stereo.length / 2);
  for (let i = 0, o = 0; i < stereo.length; i += 4, o += 2) {
    stereo.copy(left, o, i, i + 2);
    stereo.copy(right, o, i + 2, i + 4);
  }
  assert.equal(md5(left), md5(src), 'left == source');
  assert.equal(md5(right), md5(src), 'right == source');
  const direct = await collect(openTrack({ file: F.mono, format: formats[1], ffmpeg: FFMPEG }));
  assert.equal(md5(Buffer.concat(direct.map((c) => c.frame))), md5(stereo), 'openTrack upmixes the same way');
});

test('gainDb scales the master decode', async () => {
  const peak = async (gainDb) => {
    const bufs = [];
    for await (const pcm of createDecoder({ file: F.c48, gainDb, sampleRate: 48000, channels: 2, ffmpeg: FFMPEG })) bufs.push(pcm);
    const all = Buffer.concat(bufs);
    let max = 0;
    for (let i = 0; i < all.length; i += 4) max = Math.max(max, Math.abs(all.readInt32LE(i)));
    return { max, samples: all.length / 8 };
  };
  const ref = await peak(0);
  const quiet = await peak(-6.02);
  assert.equal(quiet.samples, ref.samples);
  assert.ok(Math.abs(quiet.max / ref.max - 0.5) < 0.01, `ratio ${quiet.max / ref.max}`);
});

test('resampling: decoder and encoder rate conversion keep the sample count', async () => {
  const master = [];
  for await (const pcm of createDecoder({ file: F.a44, sampleRate: 48000, channels: 2, ffmpeg: FFMPEG })) master.push(pcm);
  const masterSamples = Buffer.concat(master).length / 8;
  assert.ok(Math.abs(masterSamples - 144000) <= 2, `master ${masterSamples}`);
  const format = { codec: 'pcm', sample_rate: 44100, channels: 1, bit_depth: 16 };
  const enc = createEncoder({ format, inputRate: 48000, inputChannels: 2, ffmpeg: FFMPEG });
  const pumping = pump(master, [enc]);
  const chunks = await collect(enc);
  await pumping;
  const total = assertContinuous(chunks, format);
  assert.ok(Math.abs(total - 132300) <= 2, `resampled ${total}`);
});

test('formats fan out from one decode at 48 kHz master', async () => {
  const formats = [
    { codec: 'pcm', sample_rate: 48000, channels: 2, bit_depth: 16 },
    { codec: 'flac', sample_rate: 48000, channels: 2, bit_depth: 24 },
    { codec: 'flac', sample_rate: 44100, channels: 2, bit_depth: 16 },
  ];
  const encs = formats.map((format) => createEncoder({ format, inputRate: 48000, inputChannels: 2, ffmpeg: FFMPEG }));
  const pumping = pump(createDecoder({ file: F.c48, sampleRate: 48000, channels: 2, ffmpeg: FFMPEG }), encs);
  const results = await Promise.all(encs.map(collect));
  await pumping;
  const totals = results.map((chunks, i) => assertContinuous(chunks, formats[i]));
  assert.equal(totals[0], 96000);
  assert.equal(totals[1], 96000);
  assert.ok(Math.abs(totals[2] - 88200) <= 2);
  const endUs = results.map((chunks) => chunks.at(-1).startUs + chunks.at(-1).durationUs);
  assert.ok(Math.abs(endUs[2] - endUs[0]) < 100, 'all formats end at the same time');
});

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test('abort kills the decoder and encoder processes', async () => {
  const ac = new AbortController();
  const decoder = createDecoder({ file: F.long, sampleRate: 44100, channels: 2, signal: ac.signal, ffmpeg: FFMPEG });
  const format = { codec: 'flac', sample_rate: 44100, channels: 2, bit_depth: 16 };
  const enc = createEncoder({ format, inputRate: 44100, inputChannels: 2, signal: ac.signal, ffmpeg: FFMPEG });
  const pumping = pump(decoder, [enc]);
  const first = await enc.read();
  assert.ok(first.samples > 0);
  assert.ok(alive(decoder.pid) && alive(enc.pid));
  ac.abort();
  await assert.rejects(collect(enc), { name: 'AbortError' });
  await Promise.all([decoder.exited, enc.exited, pumping]);
  assert.ok(!alive(decoder.pid), 'decoder gone');
  assert.ok(!alive(enc.pid), 'encoder gone');
});

test('ffmpeg errors are surfaced', async () => {
  const format = { codec: 'flac', sample_rate: 44100, channels: 2, bit_depth: 16 };
  const enc = openTrack({ file: path.join(dir, 'missing.flac'), format, ffmpeg: FFMPEG });
  await assert.rejects(collect(enc), /ffmpeg decode failed/);
  assert.throws(() => createEncoder({ format: { ...format, codec: 'vorbis' }, inputRate: 44100, inputChannels: 2 }), /Unsupported codec/);
  assert.throws(() => createEncoder({ format: { ...format, codec: 'opus' }, inputRate: 44100, inputChannels: 2 }), /Opus sample rate/);
});

test('raw pipes into ffmpeg skip the input probe, so output starts with the first chunk', async (t) => {
  const { mp3Encoder } = await import('../src/sendspin/sonos.js');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'velvet-fake-ffmpeg-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'ffmpeg');
  const log = path.join(dir, 'args.json');
  await fsp.writeFile(fake, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n`, { mode: 0o755 });
  const probedFirst = async () => {
    for (let i = 0; i < 100 && !fs.existsSync(log); i++) await new Promise((r) => setTimeout(r, 20));
    const args = JSON.parse(await fsp.readFile(log, 'utf8'));
    await fsp.rm(log);
    const at = (flag) => args.indexOf(flag);
    return at('-probesize') >= 0 && at('-analyzeduration') >= 0 && at('-probesize') < at('-i') && args[at('-probesize') + 1] === '32';
  };
  const enc = createEncoder({ format: { codec: 'pcm', sample_rate: 8000, channels: 1, bit_depth: 16 }, inputRate: 44100, inputChannels: 2, ffmpeg: fake });
  t.after(() => enc.close());
  const room = await probedFirst();
  const mp3 = mp3Encoder({ ffmpeg: fake });
  t.after(() => mp3.close());
  assert.ok(room, 'room encoder');
  assert.ok(await probedFirst(), 'Sonos MP3 stream');
});
