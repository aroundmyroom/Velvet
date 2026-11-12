import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createEncoder, samplesToUs, oggCrc, OggPacketReader, OpusDemuxer, opusPacketSamples, parseOpusHead,
  MIN_CHUNK_MS, MAX_CHUNK_MS,
} from '../src/sendspin/audio.js';
import { GroupStream, negotiateFormat, producible, sameFormat } from '../src/sendspin/scheduler.js';
import { FakeMember, FFMPEG, PCM48, FLAC44, tone } from './helpers/sendspin-fake-member.mjs';

const execFileP = promisify(execFile);
const OPUS48 = { codec: 'opus', sample_rate: 48000, channels: 2 };

let dir;
let files = 0;

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-opus-'));
});

after(() => fsp.rm(dir, { recursive: true, force: true }));

function masterTone({ rate, seconds, freq, silenceSeconds = 0, amp = 0.5 }) {
  const n = Math.round(rate * seconds);
  const lead = Math.round(rate * silenceSeconds);
  const pcm = Buffer.alloc(n * 8);
  for (let i = lead; i < n; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * freq * (i - lead) / rate) * amp * 0x7fffffff);
    pcm.writeInt32LE(v, i * 8);
    pcm.writeInt32LE(v, i * 8 + 4);
  }
  return pcm;
}

async function encode(pcm, { format = OPUS48, inputRate, inputChannels = 2, split = 4096, chunkMs } = {}) {
  const enc = createEncoder({ format, inputRate, inputChannels, chunkMs, ffmpeg: FFMPEG });
  const chunks = [];
  const reading = (async () => { for await (const c of enc) chunks.push(c); })();
  for (let p = 0; p < pcm.length; p += split * 8) await enc.write(pcm.subarray(p, p + split * 8));
  enc.end();
  await reading;
  return chunks;
}

function oggPage({ type = 0, granule = 0n, serial = 7, seq, lacing, body }) {
  const h = Buffer.alloc(27 + lacing.length);
  h.write('OggS', 0, 'latin1');
  h[5] = type;
  h.writeBigInt64LE(BigInt(granule), 6);
  h.writeUInt32LE(serial, 14);
  h.writeUInt32LE(seq, 18);
  h[26] = lacing.length;
  Buffer.from(lacing).copy(h, 27);
  const page = Buffer.concat([h, body]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

function lacingOf(len) {
  const l = new Array(Math.floor(len / 255)).fill(255);
  l.push(len % 255);
  return l;
}

function opusHead(channels, preSkip) {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'latin1');
  b[8] = 1;
  b[9] = channels;
  b.writeUInt16LE(preSkip, 10);
  b.writeUInt32LE(48000, 12);
  return b;
}

// Raw chunks back into an Ogg Opus file, one packet per page, as a player's decoder would see them.
function wrapOgg(chunks, { channels, preSkip, endGranule }) {
  const tags = Buffer.concat([Buffer.from('OpusTags', 'latin1'), Buffer.alloc(8)]);
  const pages = [
    oggPage({ type: 2, seq: 0, lacing: lacingOf(19), body: opusHead(channels, preSkip) }),
    oggPage({ seq: 1, lacing: lacingOf(tags.length), body: tags }),
  ];
  let granule = 0;
  chunks.forEach((c, i) => {
    granule += opusPacketSamples(c.frame);
    const last = i === chunks.length - 1;
    pages.push(oggPage({
      type: last ? 4 : 0, seq: i + 2, granule: last && endGranule ? endGranule : granule, lacing: lacingOf(c.frame.length), body: c.frame,
    }));
  });
  return Buffer.concat(pages);
}

async function decodeOgg(ogg, channels) {
  const file = path.join(dir, `rt-${files++}.opus`);
  await fsp.writeFile(file, ogg);
  const { stdout } = await execFileP(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-i', file, '-f', 's16le', '-ac', String(channels), '-ar', '48000', '-',
  ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const out = new Float64Array(stdout.length / 2 / channels);
  for (let i = 0; i < out.length; i++) out[i] = stdout.readInt16LE(i * 2 * channels) / 32768;
  return out;
}

function goertzel(x, freq, rate, from = 0, to = x.length) {
  const k = 2 * Math.cos(2 * Math.PI * freq / rate);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    const s = x[i] + k * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const n = to - from;
  return Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2) / (n / 2);
}

test('TOC byte: frame size per config and frame count code (RFC 6716 §3.1)', () => {
  const toc = (config, code, extra = []) => Buffer.from([(config << 3) | code, ...extra, 0, 0]);
  assert.equal(opusPacketSamples(toc(0, 0)), 480);
  assert.equal(opusPacketSamples(toc(3, 0)), 2880);
  assert.equal(opusPacketSamples(toc(13, 0)), 960);
  assert.equal(opusPacketSamples(toc(14, 0)), 480);
  assert.equal(opusPacketSamples(toc(16, 0)), 120);
  assert.equal(opusPacketSamples(toc(31, 0)), 960);
  assert.equal(opusPacketSamples(toc(31, 1)), 1920);
  assert.equal(opusPacketSamples(toc(31, 2)), 1920);
  assert.equal(opusPacketSamples(toc(31, 3, [6])), 5760);
  assert.equal(opusPacketSamples(toc(16, 3, [0x80 | 5])), 600);
  assert.equal(opusPacketSamples(toc(31, 3, [7])), null, 'over 120 ms');
  assert.equal(opusPacketSamples(toc(31, 3, [0])), null, 'zero frames');
  assert.equal(opusPacketSamples(Buffer.from([(31 << 3) | 3])), null, 'code 3 without a count byte');
  assert.equal(opusPacketSamples(Buffer.alloc(0)), null);
  assert.deepEqual(parseOpusHead(opusHead(2, 312)), { channels: 2, preSkip: 312, inputRate: 48000 });
  assert.equal(parseOpusHead(Buffer.from('OpusTags')), null);
});

test('Ogg reader: packets across pages, any byte split, exact 255 multiples', () => {
  const big = Buffer.alloc(1000, 1);
  const exact = Buffer.alloc(510, 2);
  const small = Buffer.from([3, 4, 5]);
  const lace = lacingOf(big.length);
  const pages = Buffer.concat([
    oggPage({ type: 2, seq: 0, lacing: lacingOf(small.length), body: small }),
    oggPage({ seq: 1, lacing: lace.slice(0, 2), body: big.subarray(0, 510) }),
    oggPage({ type: 1, seq: 2, lacing: [...lace.slice(2), ...lacingOf(exact.length)], body: Buffer.concat([big.subarray(510), exact]) }),
    oggPage({ type: 4, seq: 3, lacing: lacingOf(small.length), body: small }),
  ]);
  const expect = [small, big, exact, small];
  for (const split of [1, 2, 3, 7, 27, 28, 255, 256, pages.length]) {
    const r = new OggPacketReader();
    const got = [];
    for (let p = 0; p < pages.length; p += split) got.push(...r.push(pages.subarray(p, p + split)));
    r.end();
    assert.deepEqual(got, expect, `split ${split}`);
  }
});

test('Ogg reader: bad CRC, sequence gap, continuation mismatch and truncation are rejected', () => {
  const pkt = Buffer.from([9, 9, 9]);
  const bos = oggPage({ type: 2, seq: 0, lacing: [3], body: pkt });
  const bad = Buffer.from(bos);
  bad[bad.length - 1] ^= 1;
  assert.throws(() => new OggPacketReader().push(bad), /CRC/);
  assert.throws(() => new OggPacketReader().push(Buffer.concat([bos, oggPage({ seq: 2, lacing: [3], body: pkt })])), /sequence/);
  assert.throws(() => new OggPacketReader().push(Buffer.concat([bos, oggPage({ type: 1, seq: 1, lacing: [3], body: pkt })])), /continuation/);
  assert.throws(() => new OggPacketReader().push(Buffer.concat([bos, oggPage({ seq: 1, serial: 8, lacing: [3], body: pkt })])), /single logical/);
  assert.throws(() => new OggPacketReader().push(oggPage({ seq: 0, lacing: [3], body: pkt })), /BOS/);
  assert.throws(() => new OggPacketReader().push(Buffer.from('OggX'.padEnd(40, '\0'))), /capture pattern/);
  const open = new OggPacketReader();
  open.push(Buffer.concat([bos, oggPage({ seq: 1, lacing: [255], body: Buffer.alloc(255) })]));
  assert.throws(() => open.end(), /ended inside/);
  const cut = new OggPacketReader();
  cut.push(bos.subarray(0, 20));
  assert.throws(() => cut.end(), /ended inside/);
});

test('Opus demuxer: skips OpusHead/OpusTags, needs both', () => {
  const tags = Buffer.from('OpusTags\0\0\0\0\0\0\0\0', 'latin1');
  const audio = Buffer.from([(31 << 3), 1, 2]);
  const ogg = Buffer.concat([
    oggPage({ type: 2, seq: 0, lacing: [19], body: opusHead(1, 120) }),
    oggPage({ seq: 1, lacing: [tags.length], body: tags }),
    oggPage({ seq: 2, lacing: [3, 3], body: Buffer.concat([audio, audio]) }),
  ]);
  const d = new OpusDemuxer();
  const out = d.push(ogg);
  assert.equal(d.head.preSkip, 120);
  assert.deepEqual(out.map((p) => p.samples), [960, 960]);
  assert.throws(() => new OpusDemuxer().push(oggPage({ type: 2, seq: 0, lacing: [3], body: audio })), /OpusHead/);
});

test('opus encode: one raw packet per 20 ms chunk, pre-skip aligned, round trip keeps duration and tone', async () => {
  const rate = 44100;
  const seconds = 2;
  const silence = 0.5;
  const pcm = masterTone({ rate, seconds, freq: 1000, silenceSeconds: silence });
  const chunks = await encode(pcm, { inputRate: rate, split: 1234 });
  const preSkipUs = -chunks[0].startUs;
  assert.ok(preSkipUs > 0 && preSkipUs <= 80_000, `pre-skip ${preSkipUs} µs`);
  const preSkip = preSkipUs * 48000 / 1_000_000;
  assert.ok(Number.isInteger(preSkip));
  for (const [i, c] of chunks.entries()) {
    assert.equal(c.samples, 960);
    assert.equal(opusPacketSamples(c.frame), 960);
    assert.ok(c.durationUs >= MIN_CHUNK_MS * 1000 && c.durationUs <= MAX_CHUNK_MS * 1000);
    if (i) assert.equal(c.startUs, chunks[i - 1].startUs + chunks[i - 1].durationUs);
    assert.equal(c.startUs, samplesToUs(i * 960, 48000) - preSkipUs);
  }
  const inSamples = seconds * 48000;
  assert.equal(chunks.length, Math.ceil((inSamples + preSkip) / 960));

  const trimmed = await decodeOgg(wrapOgg(chunks, { channels: 2, preSkip, endGranule: preSkip + inSamples }), 2);
  assert.ok(Math.abs(trimmed.length - inSamples) <= 1, `decoded ${trimmed.length} of ${inSamples}`);
  const at = (s) => Math.round(s * 48000);
  const tone = goertzel(trimmed, 1000, 48000, at(0.8), at(1.8));
  assert.ok(tone > 0.4 && tone < 0.6, `1 kHz amplitude ${tone}`);
  assert.ok(goertzel(trimmed, 1500, 48000, at(0.8), at(1.8)) < 0.01);
  assert.ok(goertzel(trimmed, 1000, 48000, 0, at(0.45)) < 0.01, 'leading silence stays silent');

  // A player gets no OpusHead and plays all decoded samples from the first chunk's timestamp:
  // the tone must start at exactly 0.5 s on the stream timeline.
  const raw = await decodeOgg(wrapOgg(chunks, { channels: 2, preSkip: 0 }), 2);
  const onset = raw.findIndex((v) => Math.abs(v) > 0.05);
  const onsetUs = chunks[0].startUs + samplesToUs(onset, 48000);
  assert.ok(Math.abs(onsetUs - silence * 1_000_000) <= 1000, `onset at ${onsetUs} µs`);
});

test('opus mono and other rates: samples counted at the format rate, chunkMs picks the frame size', async () => {
  const pcm = masterTone({ rate: 48000, seconds: 1, freq: 440 });
  const mono = await encode(pcm, { format: { codec: 'opus', sample_rate: 24000, channels: 1 }, inputRate: 48000, chunkMs: 45 });
  assert.ok(mono.length >= 25 && mono.length <= 27, `${mono.length} chunks`);
  for (const c of mono) {
    assert.equal(c.samples, 960);
    assert.equal(c.durationUs, 40_000);
    assert.equal(opusPacketSamples(c.frame), 1920);
    assert.equal(c.frame[0] & 4, 0, 'mono packet');
  }
  assert.throws(() => createEncoder({ format: { codec: 'opus', sample_rate: 44100, channels: 2 }, inputRate: 48000, inputChannels: 2 }), /Opus sample rate/);
  assert.throws(() => createEncoder({ format: { codec: 'opus', sample_rate: 48000, channels: 6 }, inputRate: 48000, inputChannels: 2 }), /channel count/);
});

test('negotiation: opus only when listed, client priority and preference respected', () => {
  const opusList = { ...OPUS48, bit_depth: 16 };
  assert.deepEqual(negotiateFormat(new FakeMember({ formats: [opusList, FLAC44] })), { ...OPUS48, bit_depth: 16 });
  assert.deepEqual(negotiateFormat(new FakeMember({ formats: [OPUS48, FLAC44] })), { ...OPUS48, bit_depth: 16 });
  assert.deepEqual(negotiateFormat(new FakeMember({ formats: [FLAC44, OPUS48] })), FLAC44);
  assert.deepEqual(negotiateFormat(new FakeMember({ formats: [PCM48, FLAC44] })), PCM48);
  const pref = new FakeMember({ formats: [FLAC44, opusList], player: { format: OPUS48 } });
  assert.deepEqual(negotiateFormat(pref), { ...OPUS48, bit_depth: 16 }, 'bit_depth is ignored when matching an opus preference');
  const unlisted = new FakeMember({ formats: [FLAC44], player: { format: OPUS48 } });
  assert.deepEqual(negotiateFormat(unlisted), FLAC44);
  assert.ok(producible({ codec: 'opus', sample_rate: 16000, channels: 1 }));
  assert.ok(!producible({ codec: 'opus', sample_rate: 44100, channels: 2 }));
  assert.ok(!producible({ codec: 'opus', sample_rate: 48000, channels: 3 }));
  assert.ok(sameFormat({ ...OPUS48, bit_depth: 24 }, OPUS48));
  assert.ok(!sameFormat({ ...FLAC44, bit_depth: 24 }, FLAC44));
});

test('group stream: opus member gets stream/start without codec_header and a gapless packet timeline', async () => {
  const a = await tone(path.join(dir, 'a.wav'), { freq: 440, rate: 48000, seconds: 0.6 });
  const b = await tone(path.join(dir, 'b.wav'), { freq: 660, rate: 44100, seconds: 0.4 });
  const s = new GroupStream({ ffmpeg: FFMPEG });
  const m = new FakeMember({ formats: [OPUS48, PCM48], player: { minBufferMs: 150 } });
  m.activate({ activities: ['playback'] });
  assert.ok(s.addMember(m));
  const tracks = [];
  s.on('track', (t) => tracks.push(t));
  const ended = new Promise((r) => s.once('ended', r));
  s.play([{ file: a, id: 'a' }, { file: b, id: 'b' }]);
  await ended;
  const start = m.of('stream/start')[0].payload.player;
  assert.deepEqual(start, { ...OPUS48, bit_depth: 16 });
  assert.equal(start.codec_header, undefined);
  const first = m.chunks[0];
  const preSkipUs = tracks[0].timestampUs - first.ts;
  assert.ok(preSkipUs > 0 && preSkipUs < 80_000, `first packet ${preSkipUs} µs ahead of the track`);
  for (let i = 1; i < m.chunks.length; i++) assert.equal(m.chunks[i].ts - m.chunks[i - 1].ts, 20_000);
  const total = m.chunks.length * 960;
  assert.ok(total >= 48000 + preSkipUs * 0.048 && total < 48000 + preSkipUs * 0.048 + 960, `${m.chunks.length} packets`);
  assert.equal(tracks[1].timestampUs, tracks[0].timestampUs + samplesToUs(28800, 48000));
  assert.equal(s.stats()[0].dropped, 0);
  s.stop();
});
