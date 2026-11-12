import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  GroupStream, negotiateFormat, memberLeadUs, producible, MIN_LEAD_FLOOR_MS,
} from '../src/sendspin/scheduler.js';
import { samplesToUs } from '../src/sendspin/audio.js';
import {
  FakeMember, FFMPEG, PCM48, FLAC44, tone, until, sleep, pcmDurationUs,
} from './helpers/sendspin-fake-member.mjs';

let dir;
const F = {};

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-sched-'));
  F.a = await tone(path.join(dir, 'a.wav'), { freq: 440, rate: 48000, seconds: 0.6 });
  F.b = await tone(path.join(dir, 'b.wav'), { freq: 660, rate: 44100, seconds: 0.4 });
  F.long = await tone(path.join(dir, 'long.wav'), { freq: 220, rate: 48000, seconds: 4 });
});

after(() => fsp.rm(dir, { recursive: true, force: true }));

const stream = (opts = {}) => new GroupStream({ ffmpeg: FFMPEG, ...opts });

function play(m) {
  m.activate({ activities: ['playback'] });
  return m;
}

function assertContiguous(chunks, format) {
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    assert.equal(chunks[i].ts, prev.ts + pcmDurationUs(prev, format), `chunk ${i} follows chunk ${i - 1}`);
  }
}

test('format negotiation: preference first, then priority order, only producible formats', () => {
  const opus96 = { codec: 'opus', sample_rate: 96000, channels: 2 };
  const m = new FakeMember({ formats: [opus96, { ...PCM48, bit_depth: 32 }, FLAC44, PCM48] });
  assert.deepEqual(negotiateFormat(m), FLAC44);
  m.state.player.format = PCM48;
  assert.deepEqual(negotiateFormat(m), PCM48);
  m.state.player.format = opus96;
  assert.deepEqual(negotiateFormat(m), FLAC44);
  assert.equal(negotiateFormat(new FakeMember({ formats: [opus96] })), null);
  assert.ok(producible({ codec: 'flac', sample_rate: 96000, channels: 1, bit_depth: 24 }));
  assert.ok(!producible({ codec: 'pcm', sample_rate: 48000, channels: 6, bit_depth: 16 }));
});

test('lead: min_buffer + output_delay, extended toward required_lead_time, with a floor', () => {
  const m = new FakeMember({ player: { minBufferMs: 200, requiredLeadTimeMs: 500, outputDelayMs: 30 } });
  assert.equal(memberLeadUs(m), 530_000);
  m.state.player.requiredLeadTimeMs = 0;
  assert.equal(memberLeadUs(m), 230_000);
  m.state.player.minBufferMs = 0;
  assert.equal(memberLeadUs(m), (MIN_LEAD_FLOOR_MS + 30) * 1000);
});

test('one member: send-ahead, chunk bounds, gapless two-track timeline, track events, ended', async () => {
  const s = stream();
  const m = play(new FakeMember({ formats: [PCM48], player: { minBufferMs: 150 } }));
  assert.ok(s.addMember(m));
  const tracks = [];
  s.on('track', (t) => tracks.push(t));
  const ended = new Promise((r) => s.once('ended', r));
  s.play([{ file: F.a, id: 'a' }, { file: F.b, id: 'b' }]);
  await ended;
  assert.equal(m.calls[1].type, 'stream/start');
  assert.deepEqual(m.calls[1].payload.player, PCM48);
  const first = m.chunks[0];
  assert.ok(first.ts - first.at >= s.sendAheadUs - 5_000, `lead ${first.ts - first.at} < ${s.sendAheadUs}`);
  assert.ok(s.sendAheadUs >= 150_000);
  for (const c of m.chunks.slice(0, -1)) {
    const ms = pcmDurationUs(c, PCM48) / 1000;
    assert.ok(ms >= 15 && ms <= 150, `chunk ${ms} ms`);
  }
  assertContiguous(m.chunks, PCM48);
  const total = m.chunks.reduce((n, c) => n + c.frame.length / 4, 0);
  assert.ok(Math.abs(total - 48000) <= 4, `samples ${total}`);
  assert.deepEqual(tracks.map((t) => t.track.id), ['a', 'b']);
  assert.equal(tracks[0].timestampUs, first.ts);
  assert.equal(tracks[1].timestampUs, first.ts + samplesToUs(28800, 48000));
  assert.ok(tracks[0].first && !tracks[1].first);
  assert.equal(m.chunks.length, s.stats()[0].sentChunks);
  assert.equal(s.stats()[0].dropped, 0);
  s.stop();
  assert.equal(m.calls.at(-1).type, 'stream/end');
});

test('buffer_capacity is never exceeded under the spec accounting', async () => {
  const capacity = 20_000;
  const s = stream();
  const m = play(new FakeMember({ formats: [PCM48], capacity, player: { outputDelayMs: 40, minBufferMs: 150 } }));
  s.addMember(m);
  const ended = new Promise((r) => s.once('ended', r));
  s.play([{ file: F.a }]);
  await ended;
  const od = 40_000;
  for (let i = 0; i < m.chunks.length; i++) {
    const c = m.chunks[i];
    let outstanding = 0;
    for (const p of m.chunks.slice(0, i)) if (p.ts + pcmDurationUs(p, PCM48) - od > c.at) outstanding += p.size;
    assert.ok(outstanding + c.size <= capacity, `chunk ${i}: ${outstanding} + ${c.size} > ${capacity}`);
  }
  assert.equal(s.stats()[0].dropped, 0);
  assertContiguous(m.chunks, PCM48);
  const spread = m.chunks.at(-1).at - m.chunks[0].at;
  assert.ok(spread > 300_000, `paced over ${spread} us`);
  s.stop();
});

test('late joiner: stream/start first, only future timestamps, sample-aligned with the group', async () => {
  const s = stream();
  const a = play(new FakeMember({ formats: [PCM48] }));
  const b = play(new FakeMember({ formats: [PCM48], player: { minBufferMs: 300 } }));
  s.addMember(a);
  s.play([{ file: F.long }]);
  await until(() => a.chunks.length > 0);
  await sleep(400);
  assert.notEqual(s.t0, null);
  const before = b.calls.length;
  s.addMember(b);
  const joined = b.calls[before];
  assert.equal(joined.type, 'stream/start');
  await until(() => b.chunks.length > 5);
  const firstB = b.chunks[0];
  assert.ok(firstB.ts >= joined.at + memberLeadUs(b), 'joiner starts in the future');
  assert.ok(firstB.ts - firstB.at > 0);
  await until(() => a.chunks.length && a.chunks.at(-1).ts > firstB.ts + 200_000);
  const aStream = Buffer.concat(a.chunks.map((c) => c.frame));
  const offsetSamples = Math.round((firstB.ts - a.chunks[0].ts) * 48000 / 1_000_000);
  assert.equal(firstB.ts - a.chunks[0].ts, samplesToUs(offsetSamples, 48000));
  const bBytes = Buffer.concat(b.chunks.slice(0, 4).map((c) => c.frame));
  assert.ok(aStream.subarray(offsetSamples * 4, offsetSamples * 4 + bBytes.length).equals(bBytes), 'same audio at the same timestamp');
  s.stop();
});

test('seek: stream/clear (never stream/end) and a new timeline from the new position', async () => {
  const s = stream();
  const m = play(new FakeMember({ formats: [PCM48] }));
  s.addMember(m);
  s.play([{ file: F.long }]);
  await until(() => m.chunks.length > 3);
  await sleep(200);
  const n = m.chunks.length;
  const marker = m.calls.length;
  s.play([{ file: F.long, startMs: 2000 }]);
  const after = m.calls.slice(marker);
  assert.equal(after[0].type, 'stream/clear');
  assert.ok(!after.some((c) => c.type === 'stream/end' || c.type === 'stream/start'));
  await until(() => m.chunks.length > n + 2);
  const next = m.chunks[n];
  assert.ok(next.ts - next.at >= s.sendAheadUs - 5_000, 'new timeline starts a full send-ahead out');
  const pos = s.position();
  assert.ok(pos.positionMs >= 2000 && pos.positionMs < 2300, `position ${pos.positionMs}`);
  s.stop();
});

test('pause and resume: stream/end, remembered position, stream/start on resume', async () => {
  const s = stream();
  const m = play(new FakeMember({ formats: [PCM48] }));
  s.addMember(m);
  s.play([{ file: F.long, id: 'L' }]);
  await until(() => m.chunks.length > 0);
  await until(() => s.position().audibleAtUs !== null && Number(process.hrtime.bigint() / 1000n) > m.chunks[0].ts + 300_000);
  const pos = s.stop();
  assert.equal(m.calls.at(-1).type, 'stream/end');
  assert.equal(pos.track.id, 'L');
  assert.ok(pos.positionMs >= 290 && pos.positionMs < 700, `paused at ${pos.positionMs}`);
  assert.ok(!s.playing);
  const marker = m.calls.length;
  s.play([{ file: F.long, id: 'L', startMs: pos.positionMs }]);
  assert.equal(m.calls[marker].type, 'stream/start');
  await until(() => m.chunks.length > 0 && m.calls.at(-1).type === 'chunk');
  assert.ok(s.position().positionMs >= pos.positionMs);
  s.stop();
});

test('format change mid-stream: new stream/start, contiguous timeline, no resend', async () => {
  const s = stream();
  const m = play(new FakeMember({ formats: [PCM48, FLAC44], capacity: 60_000 }));
  s.addMember(m);
  s.play([{ file: F.long }]);
  await until(() => m.chunks.length > 10);
  m.state.player.format = FLAC44;
  const marker = m.calls.length;
  const sent = m.chunks.length;
  const last = m.chunks[sent - 1];
  const endPcm = last.ts + pcmDurationUs(last, PCM48);
  s.memberChanged(m.clientId);
  const start = m.calls[marker];
  assert.equal(start.type, 'stream/start');
  assert.equal(start.payload.player.codec, 'flac');
  assert.equal(start.payload.player.sample_rate, 44100);
  assert.match(start.payload.player.codec_header, /^ZkxhQ/);
  await until(() => m.chunks.length > sent + 3);
  const firstFlac = m.chunks[sent];
  assert.ok(Math.abs(firstFlac.ts - endPcm) <= 25, `flac starts at ${firstFlac.ts}, pcm ended at ${endPcm}`);
  assert.ok(firstFlac.ts >= endPcm);
  assert.ok(!m.calls.slice(marker).some((c) => c.type === 'stream/clear' || c.type === 'stream/end'));
  assert.deepEqual(s.formatOf(m.clientId), FLAC44);
  s.stop();
});

test('a member that fails mid-stream is dropped; the others play on', async () => {
  const s = stream();
  const a = play(new FakeMember({ formats: [PCM48] }));
  const b = play(new FakeMember({ formats: [FLAC44] }));
  b.failAfterChunks = 3;
  s.addMember(a);
  s.addMember(b);
  const errors = [];
  s.on('member-error', (id) => errors.push(id));
  const ended = new Promise((r) => s.once('ended', r));
  s.play([{ file: F.a }]);
  await ended;
  assert.deepEqual(errors, [b.clientId]);
  assert.ok(!s.has(b.clientId));
  const total = a.chunks.reduce((n, c) => n + c.frame.length / 4, 0);
  assert.ok(Math.abs(total - 28800) <= 4);
  s.stop();
});

test('removing a member ends only its stream', async () => {
  const s = stream();
  const a = play(new FakeMember({ formats: [PCM48] }));
  const b = play(new FakeMember({ formats: [PCM48] }));
  s.addMember(a);
  s.addMember(b);
  s.play([{ file: F.long }]);
  await until(() => b.chunks.length > 2);
  s.removeMember(b.clientId);
  assert.equal(b.calls.at(-1).type, 'stream/end');
  const n = a.chunks.length;
  await until(() => a.chunks.length > n + 5);
  assert.ok(!a.calls.some((c) => c.type === 'stream/end'));
  s.stop();
});

test('decoder errors stop the stream cleanly', async () => {
  const s = stream();
  const m = play(new FakeMember({ formats: [PCM48] }));
  s.addMember(m);
  const err = new Promise((r) => s.once('error', r));
  s.play([{ file: path.join(dir, 'missing.flac') }]);
  assert.match((await err).message, /ffmpeg decode failed/);
  assert.ok(!s.playing);
  assert.equal(m.calls.at(-1).type, 'stream/end');
});

test('no audio feed (metadata-only room): the timeline still runs in real time and ends', async () => {
  const s = stream();
  assert.equal(s.addMember(new FakeMember({ roles: ['metadata', 'controller'] })), false);
  const tracks = [];
  s.on('track', (t) => tracks.push({ ...t, at: Date.now() }));
  const ended = new Promise((r) => s.once('ended', () => r(Date.now())));
  const started = Date.now();
  s.play([{ file: F.a, id: 'a' }, { file: F.b, id: 'b' }]);
  await until(() => tracks.length >= 1);
  assert.ok(s.t0 !== null);
  assert.equal(tracks[0].track.id, 'a');
  assert.equal(tracks[0].timestampUs, s.t0);
  await sleep(250);
  const mid = s.position();
  assert.equal(mid.track.id, 'a');
  assert.ok(mid.positionMs >= 100 && mid.positionMs < 600, `position ${mid.positionMs}`);
  const endedAt = await ended;
  assert.deepEqual(tracks.map((t) => t.track.id), ['a', 'b']);
  assert.equal(tracks[1].timestampUs, s.t0 + 600_000);
  assert.ok(endedAt - started >= 950, `ended after ${endedAt - started} ms, not in real time`);
  s.stop();
});

test('bytes still queued in the socket count toward buffer_capacity', async () => {
  const capacity = 20_000;
  const s = stream();
  const m = play(new FakeMember({ formats: [PCM48], capacity, player: { minBufferMs: 400 } }));
  m.bufferedAmount = capacity;
  s.addMember(m);
  s.play([{ file: F.a }]);
  await sleep(150);
  assert.equal(m.chunks.length, 0, 'held back while the socket is full');
  m.bufferedAmount = 0;
  await until(() => m.chunks.length > 0);
  assert.equal(s.stats()[0].dropped, 0);
  s.stop();
});
