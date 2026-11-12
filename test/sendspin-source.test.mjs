import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SendspinServer } from '../src/sendspin/server.js';
import { IMPLEMENTED_ROLES, nowUs } from '../src/sendspin/connection.js';
import { RoomManager } from '../src/sendspin/rooms.js';
import {
  SourceManager, SourceSession, SourceError, LiveResampler, checkSourceFormat, flacChunkSamples, chunkSamples, flacMaxBytes, pcmToStereo,
  TARGET_MS, MAX_EXCESS_MS, BACKLOG_MS, BACKLOG_END_MS,
} from '../src/sendspin/source.js';
import { FakeMember, FFMPEG, PCM48, until, sleep } from './helpers/sendspin-fake-member.mjs';
import { SourceClient, sourceHello, sinePcm16, flacFrames } from './helpers/sendspin-source-client.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const PCM_SRC = { codec: 'pcm', sample_rate: 48000, channels: 2, bit_depth: 16 };

// ── pure parts ───────────────────────────────────────────────────────────────

test('source formats: pcm and flac accepted, opus and broken headers refused', async () => {
  assert.equal(checkSourceFormat(PCM_SRC).codec, 'pcm');
  assert.equal(checkSourceFormat({ ...PCM_SRC, bit_depth: 20 }), null);
  assert.equal(checkSourceFormat({ ...PCM_SRC, sample_rate: 1_000_000 }), null);
  assert.equal(checkSourceFormat({ codec: 'opus', sample_rate: 48000, channels: 2 }), null);
  const { header, frames } = await flacFrames(FFMPEG, { seconds: 0.2 });
  const flac = { codec: 'flac', sample_rate: 48000, channels: 2, bit_depth: 16, codec_header: header.toString('base64') };
  const fmt = checkSourceFormat(flac);
  assert.equal(fmt.maxBlock, 960);
  assert.equal(checkSourceFormat({ ...flac, sample_rate: 44100 }), null, 'STREAMINFO rate must match');
  assert.equal(checkSourceFormat({ ...flac, codec_header: 'not base64!' }), null);
  assert.equal(checkSourceFormat({ ...flac, codec_header: undefined }), null);
  assert.equal(flacChunkSamples(Buffer.concat(frames.slice(0, 3).map((f) => f.frame)), 960, 100_000), 2880);
  assert.equal(flacChunkSamples(Buffer.from([1, 2, 3, 4, 5]), 960, 100_000), null);
  const st = pcmToStereo(sinePcm16(4, { channels: 1 }), 16, 1);
  assert.equal(st.length, 8);
  assert.equal(st[2], st[3], 'mono reaches both sides unchanged');
});

// Simulates a source whose clock runs `ppm` off the server's, sending `chunkMs` chunks with arrival
// jitter, and a room clock pulling every 10 ms. Returns the level trace (ms) and the resampler.
function simulate({ ppm, seconds, rate = 8000, chunkMs = 20, jitterMs = 8, stallAt = null, stallMs = 0, burst = true }) {
  const rs = new LiveResampler({ rate });
  const srcRate = rate * (1 + ppm / 1e6);
  let phase = 0;
  const chunks = [];
  const chunkFrames = Math.round(rate * chunkMs / 1000);
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const total = Math.ceil(seconds * srcRate / chunkFrames);
  for (let k = 0; k < total; k++) {
    const capturedAt = (k + 1) * chunkFrames / srcRate * 1e6;
    let at = capturedAt + 5000 + rand() * jitterMs * 1000;
    if (stallAt !== null && capturedAt >= stallAt * 1e6 && capturedAt < (stallAt + stallMs / 1000) * 1e6) {
      if (!burst) continue;
      at = Math.max(at, (stallAt + stallMs / 1000) * 1e6);
    }
    const f = new Float32Array(chunkFrames * 2);
    for (let i = 0; i < chunkFrames; i++) {
      const v = Math.sin(phase);
      phase += 2 * Math.PI * 200 / rate;
      f[2 * i] = v;
      f[2 * i + 1] = v;
    }
    chunks.push({ at, f });
  }
  chunks.sort((a, b) => a.at - b.at);
  const levels = [];
  const outputs = [];
  let ci = 0;
  for (let t = 0; t < seconds * 1e6; t += 10_000) {
    while (ci < chunks.length && chunks[ci].at <= t) rs.push(chunks[ci++].f);
    const out = rs.pull(rate / 100);
    if (outputs.length < 400) outputs.push(out);
    levels.push({ t: t / 1e6, ms: rs.levelSeconds * 1000, priming: rs.priming });
  }
  return { rs, levels, outputs };
}

test('drift: +200 ppm and -200 ppm are absorbed, the buffer stays bounded over 15 simulated minutes', () => {
  for (const ppm of [200, -200, 800]) {
    const { rs, levels } = simulate({ ppm, seconds: 900 });
    const late = levels.filter((l) => l.t > 300);
    const max = Math.max(...late.map((l) => l.ms));
    const min = Math.min(...late.map((l) => l.ms));
    assert.equal(rs.underruns, 0, `${ppm} ppm: no underrun`);
    assert.ok(rs.dropped < 160, `${ppm} ppm: nothing dropped beyond the start surplus (${rs.dropped})`);
    assert.ok(Math.abs(rs.ppm - ppm) < 30, `${ppm} ppm estimated as ${rs.ppm.toFixed(1)}`);
    assert.ok(max < TARGET_MS + 15 && min > TARGET_MS - 15, `${ppm} ppm: level ${min.toFixed(1)}..${max.toFixed(1)} ms`);
    // Without correction 900 s at 800 ppm would have piled up 720 ms.
    const all = Math.max(...levels.filter((l) => l.t > 2).map((l) => l.ms));
    assert.ok(all < TARGET_MS + 40, `${ppm} ppm: worst level ${all.toFixed(1)} ms`);
  }
});

test('output is continuous: a sine through the resampler has no jumps', () => {
  const { outputs } = simulate({ ppm: 200, seconds: 4, rate: 8000 });
  const all = outputs.flatMap((o) => Array.from(o.filter((_, i) => i % 2 === 0)));
  const start = all.findIndex((v) => v !== 0);
  const maxStep = 2 * Math.sin(Math.PI * 200 / 8000) * 1.05;
  for (let i = start + 1; i < all.length; i++) assert.ok(Math.abs(all[i] - all[i - 1]) <= maxStep, `step at ${i}`);
});

test('a network stall: silence while starved, the stale burst is dropped, latency returns to target', () => {
  const { rs, levels } = simulate({ ppm: 200, seconds: 60, stallAt: 20, stallMs: 600 });
  assert.equal(rs.underruns, 1);
  assert.ok(rs.dropped > 0, 'the burst beyond target + excess was dropped');
  const after = levels.filter((l) => l.t > 40);
  assert.ok(after.every((l) => !l.priming && l.ms < TARGET_MS + 20), 'back at target');
  const peak = Math.max(...levels.map((l) => l.ms));
  assert.ok(peak <= TARGET_MS + MAX_EXCESS_MS + 25, `peak ${peak}`);
  const dropped = simulate({ ppm: 0, seconds: 30, stallAt: 10, stallMs: 600, burst: false });
  assert.equal(dropped.rs.underruns, 1, 'a source that dropped its backlog: one underrun, then steady');
  assert.ok(dropped.rs.dropped < 320);
});

// ── protocol + rooms ─────────────────────────────────────────────────────────

async function setup(t, { tickMs = 5 } = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-source-'));
  const server = new SendspinServer({ dataDir, host: '127.0.0.1', port: 0, logger: quiet, roles: [...IMPLEMENTED_ROLES] });
  await server.start();
  const rooms = await RoomManager.open(path.join(dataDir, 'rooms'), { ffmpeg: FFMPEG, idleGraceMs: 150, logger: quiet });
  const sources = new SourceManager({ server, rooms, logger: quiet, ffmpeg: FFMPEG, tickMs });
  const speaker = new FakeMember({ name: 'Living speaker', formats: [PCM48], player: { minBufferMs: 200 } });
  rooms.attach(speaker);
  const roomId = rooms.roomOf(speaker.clientId);
  t.after(async () => {
    sources.close();
    await rooms.close();
    await server.stop();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  return { server, rooms, sources, speaker, roomId };
}

async function connectSource(t, server, hello = sourceHello()) {
  const c = new SourceClient();
  await c.dial(`ws://127.0.0.1:${server.port}/sendspin`);
  t.after(() => c.close());
  const activate = await c.connect(hello);
  return { c, activate };
}

function streamPcm(c, { seconds, ppm = 200, gapAt = null, gapMs = 0, chunkMs = 20 }) {
  const rate = 48000;
  const frames = rate * chunkMs / 1000;
  const t0 = Number(nowUs());
  let k = 0;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const elapsed = (Number(nowUs()) - t0) / 1e6;
      const due = Math.floor(elapsed / (chunkMs / 1000) * (1 + ppm / 1e6));
      for (; k < due; k++) {
        const capturedUs = t0 + k * frames / (rate * (1 + ppm / 1e6)) * 1e6;
        if (gapAt !== null && capturedUs - t0 >= gapAt * 1e6 && capturedUs - t0 < gapAt * 1e6 + gapMs * 1000) continue;
        c.sendAudio(capturedUs, sinePcm16(frames, { offset: k * frames }));
      }
      if (elapsed >= seconds) {
        clearInterval(timer);
        resolve(k);
      }
    }, 5);
  });
}

test('approval gating: the role waits for explicit source approval; start only after state; stop', async (t) => {
  const { server, sources, speaker, roomId, rooms } = await setup(t);
  const { c, activate } = await connectSource(t, server);
  assert.deepEqual(activate.payload.active_roles, [], 'unknown device: no roles');
  await server.approve(c.clientId);
  await c.until(() => c.lastActivate && c.lastActivate.active_roles !== undefined);
  assert.ok(!(c.lastActivate.active_roles ?? []).includes('source@v1'), 'approval for playback is not approval as a source');
  assert.throws(() => sources.start(roomId, c.clientId), (e) => e instanceof SourceError && e.code === 'not_allowed');
  assert.equal(c.commands().length, 0);

  await sources.allow(c.clientId, true);
  await c.expect('server/activate', (p) => p.active_roles?.includes('source@v1'));
  assert.equal(sources.view(c.clientId).allowed, true);
  sources.start(roomId, c.clientId);
  await c.expect('server/activate', (p) => p.activities.includes('playback'));
  await sleep(50);
  assert.equal(c.commands().length, 0, 'no start before the source state');
  c.state(true, 'absent');
  await c.until(() => c.commands().includes('start'));
  assert.equal(rooms.getRoom(roomId).live.sourceId, c.clientId);
  assert.equal(rooms.getRoom(roomId).state, 'playing');

  sources.stop(c.clientId);
  await c.until(() => c.commands().includes('stop'));
  assert.equal(rooms.getRoom(roomId).live, null);
  assert.notEqual(rooms.getRoom(roomId).state, 'playing');
  await c.expect('server/activate', (p) => !p.activities.includes('playback'));
  assert.ok(speaker.of('server/activate').length > 0);

  await sources.allow(c.clientId, false);
  await c.expect('server/activate', (p) => Array.isArray(p.active_roles) && !p.active_roles.includes('source@v1'));
  assert.equal(server.trustStore.isSourceAllowed(c.clientId), false);
});

test('a microphone without unpaired access cannot be allowed until it is paired', async (t) => {
  const { server, sources } = await setup(t);
  const { c, activate } = await connectSource(t, server, sourceHello({ name: 'Mic', unpaired_access: { enabled: false } }));
  assert.deepEqual(activate.payload.active_roles, []);
  await assert.rejects(sources.allow(c.clientId, true), (e) => e.code === 'pairing_required');
  assert.equal(await server.allowSource(c.clientId, true), false, 'the store refuses an untrusted device too');
  assert.equal(server.trustStore.isSourceAllowed(c.clientId), false);
  await sleep(50);
  assert.ok(!c.inbox.some((m) => m.type === 'server/activate' && m.payload.active_roles?.includes('source@v1')));
});

test('an unsolicited client-stream/start is a protocol error', async (t) => {
  const { server, sources } = await setup(t);
  const { c } = await connectSource(t, server);
  await server.approve(c.clientId);
  await sources.allow(c.clientId, true);
  await c.expect('server/activate', (p) => p.active_roles?.includes('source@v1'));
  c.state(true, 'absent');
  c.streamStart(PCM_SRC);
  assert.equal(await c.closed, 1002);

  const { c: d } = await connectSource(t, server);
  await server.approve(d.clientId);
  await sources.allow(d.clientId, true);
  await d.expect('server/activate', (p) => p.active_roles?.includes('source@v1'));
  d.sendAudio(Number(nowUs()), sinePcm16(480));
  assert.equal(await d.closed, 1002, 'source audio without an open input stream closes too');
});

test('pcm line-in with a +200 ppm clock and a gap: the room hears continuous audio at live lead', { timeout: 20_000 }, async (t) => {
  const { server, sources, speaker, roomId, rooms } = await setup(t);
  const { c } = await connectSource(t, server, sourceHello({ supported_roles: ['source@v1', 'player@v1'], 'player@v1_support': { supported_formats: [PCM48], buffer_capacity: 1_000_000 } }));
  await server.approve(c.clientId);
  await sources.allow(c.clientId, true);
  await c.expect('server/activate', (p) => p.active_roles?.includes('source@v1'));
  c.state(true, 'present');
  sources.start(roomId, c.clientId);
  await c.until(() => c.commands().includes('start'));
  c.streamStart(PCM_SRC);
  await until(() => sources.session(c.clientId)?.streaming);
  await streamPcm(c, { seconds: 2.5, gapAt: 1.2, gapMs: 300 });

  const starts = speaker.of('stream/start');
  assert.equal(starts.length, 1);
  const chunks = speaker.chunks;
  assert.ok(chunks.length > 50, `got ${chunks.length} chunks`);
  for (let i = 1; i < chunks.length; i++) {
    const prevEnd = chunks[i - 1].ts + Math.round(chunks[i - 1].frame.length / 4 * 1e6 / 48000);
    assert.ok(Math.abs(chunks[i].ts - prevEnd) <= 1, `chunk ${i} contiguous (${chunks[i].ts - prevEnd} µs)`);
  }
  const leads = chunks.map((x) => (x.ts - x.at) / 1000);
  assert.ok(Math.min(...leads) >= 200 - 5, `min lead ${Math.min(...leads)} ms >= min_buffer_ms`);
  assert.ok(Math.max(...leads) < 200 + 50 + 60, `no extension toward required_lead_time_ms (max ${Math.max(...leads)})`);
  const loud = chunks.filter((x) => x.frame.readInt16LE(400) !== 0 || x.frame.readInt16LE(800) !== 0).length;
  assert.ok(loud > chunks.length / 2, 'the source audio reaches the room');
  const md = speaker.of('server/state').map((s) => s.payload.metadata).filter(Boolean).at(-1);
  assert.match(md.title, /^Line-in — /);
  assert.equal(md.progress.track_duration, 0);
  const ctl = speaker.of('server/state').map((s) => s.payload.controller).filter(Boolean).at(-1);
  assert.ok(!ctl.supported_commands.includes('seek') && ctl.seek_max_ms === undefined, 'no seek on live audio');
  const stats = sources.session(c.clientId).view();
  assert.ok(stats.jumps >= 1, 'the gap shows as a timestamp jump');
  assert.equal(rooms.getRoom(roomId).members.length, 1);

  c.streamEnd();
  await until(() => rooms.getRoom(roomId).live === null);
  assert.ok(c.commands().includes('stop'), 'source end stops the line-in');
});

test('flac line-in decodes through ffmpeg and plays', { timeout: 20_000 }, async (t) => {
  const { server, sources, speaker, roomId } = await setup(t);
  const { header, frames } = await flacFrames(FFMPEG, { seconds: 3 });
  const { c } = await connectSource(t, server);
  await server.approve(c.clientId);
  await sources.allow(c.clientId, true);
  await c.expect('server/activate', (p) => p.active_roles?.includes('source@v1'));
  c.state(true, 'present');
  sources.start(roomId, c.clientId);
  await c.until(() => c.commands().includes('start'));
  c.streamStart({ codec: 'flac', sample_rate: 48000, channels: 2, bit_depth: 16, codec_header: header.toString('base64') });
  await until(() => sources.session(c.clientId)?.streaming);
  const t0 = Number(nowUs());
  for (let k = 0; k < frames.length; k++) {
    const due = t0 + k * 20_000;
    while (Number(nowUs()) < due) await sleep(4);
    c.sendAudio(due, frames[k].frame);
  }
  await until(() => speaker.chunks.length > 40, { timeoutMs: 8000 });
  const loud = speaker.chunks.filter((x) => x.frame.readInt16LE(400) !== 0).length;
  assert.ok(loud > 20, `decoded flac reaches the room (${loud} loud chunks)`);
  assert.equal(sources.session(c.clientId).stats.rejected, 0);
  sources.stop(c.clientId);
});

test('auto-switch: signal present starts the last room, absent stops; off by default', async (t) => {
  const { server, sources, roomId, rooms } = await setup(t);
  const { c } = await connectSource(t, server);
  await server.approve(c.clientId);
  await sources.allow(c.clientId, true);
  await c.expect('server/activate', (p) => p.active_roles?.includes('source@v1'));
  c.state(true, 'absent');
  await sleep(30);
  await server.trustStore.setSourcePolicy(c.clientId, { roomId });
  c.state(true, 'present');
  await sleep(80);
  assert.equal(c.commands().length, 0, 'auto-switch is off by default');
  assert.equal(rooms.getRoom(roomId).live, null);

  await sources.setAutoSwitch(c.clientId, true);
  c.state(true, 'absent');
  await sleep(30);
  c.state(true, 'present');
  await c.until(() => c.commands().includes('start'));
  assert.equal(rooms.getRoom(roomId).live.sourceId, c.clientId);
  c.state(true, 'absent');
  await c.until(() => c.commands().includes('stop'));
  assert.equal(rooms.getRoom(roomId).live, null);
});

test('a device that is source and player is not fed its own line-in', async (t) => {
  const { server, sources, rooms } = await setup(t);
  const both = new FakeMember({ name: 'Speaker with AUX', formats: [PCM48] });
  rooms.attach(both);
  const { c } = await connectSource(t, server);
  await server.approve(c.clientId);
  await sources.allow(c.clientId, true);
  await c.expect('server/activate', (p) => p.active_roles?.includes('source@v1'));
  c.state(true, 'present');
  const fake = new FakeMember({ name: 'Turntable+speaker', formats: [PCM48], clientId: c.clientId });
  rooms.attach(fake);
  const roomId = rooms.createRoom('Both', [both.clientId, c.clientId]);
  sources.start(roomId, c.clientId);
  await until(() => both.of('stream/start').length === 1);
  await sleep(50);
  assert.equal(fake.of('stream/start').length, 0, 'the source device does not play its own input');
});

// ── second review: bounded input, line-in hand-over ─────────────────────────

const crc8 = (b) => {
  let c = 0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 7) & 0xff : (c << 1) & 0xff;
  }
  return c;
};
// A fixed-blocksize FLAC frame header (48 kHz, stereo, 16 bit): bsCode 6 = 8-bit block size, else a table size.
function flacHeader(number, { bsCode = 6, blockSize = 1 } = {}) {
  const h = [0xff, 0xf8, (bsCode << 4) | 10, 0x18, number];
  if (bsCode === 6) h.push(blockSize - 1);
  h.push(crc8(h));
  return Buffer.from(h);
}

test('flac: a chunk cannot hide megabytes behind a one-sample header or declare oversized frames', async () => {
  const fmt = { codec: 'flac', rate: 48000, channels: 2, bitDepth: 16, maxBlock: 960 };
  // The reviewer's chunk: one 1-sample frame, then 1 MiB of junk with stray 4096-sample headers.
  const junk = Buffer.alloc(1 << 20);
  flacHeader(0).copy(junk, 0);
  const unit = Buffer.concat([flacHeader(0, { bsCode: 12 }).subarray(0, 6), Buffer.alloc(10)]);
  for (let i = 16; i + unit.length <= junk.length; i += unit.length) unit.copy(junk, i);
  assert.throws(() => chunkSamples(fmt, junk), (e) => e instanceof SourceError && e.code === 'bad_chunk');
  // A small chunk: one sample's frame followed by far more bytes than one sample can take.
  assert.throws(() => chunkSamples(fmt, Buffer.concat([flacHeader(0), Buffer.alloc(4000)])), (e) => e.code === 'bad_chunk');
  // A frame header that continues the numbering but declares more than STREAMINFO's maximum block size.
  const big = Buffer.concat([flacHeader(0, { blockSize: 200 }), Buffer.alloc(40), flacHeader(1, { bsCode: 12 })]);
  assert.throws(() => flacChunkSamples(big, 960, 100_000, fmt), (e) => e.code === 'bad_chunk');
  assert.throws(() => flacChunkSamples(flacHeader(0, { bsCode: 12 }), 960, 100_000, fmt), (e) => e.code === 'bad_chunk');
  // Real frames still count exactly and pass the byte bound.
  const { frames } = await flacFrames(FFMPEG, { seconds: 0.2 });
  const real = Buffer.concat(frames.slice(0, 3).map((f) => f.frame));
  assert.equal(chunkSamples(fmt, real), 2880);
  assert.ok(real.length <= flacMaxBytes(2880, 3, 2, 16));
});

test('an invalid flac chunk closes the source connection', { timeout: 20_000 }, async (t) => {
  const { server, sources, roomId } = await setup(t);
  const { header, frames } = await flacFrames(FFMPEG, { seconds: 0.5 });
  const { c } = await connectSource(t, server);
  await server.approve(c.clientId);
  await sources.allow(c.clientId, true);
  await c.expect('server/activate', (p) => p.active_roles?.includes('source@v1'));
  c.state(true, 'present');
  sources.start(roomId, c.clientId);
  await c.until(() => c.commands().includes('start'));
  c.streamStart({ codec: 'flac', sample_rate: 48000, channels: 2, bit_depth: 16, codec_header: header.toString('base64') });
  await until(() => sources.session(c.clientId)?.streaming);
  c.sendAudio(Number(nowUs()), frames[0].frame);
  await sleep(30);
  assert.equal(sources.session(c.clientId).stats.chunks, 1);
  c.sendAudio(Number(nowUs()), Buffer.concat([flacHeader(1), Buffer.alloc(64 * 1024)]));
  assert.equal(await c.closed, 1002);
});

test('a decoder that falls behind: chunks are dropped, then the line-in ends; the backlog stays bounded', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-stuck-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const stuck = path.join(tmp, 'stuck-ffmpeg');
  await fsp.writeFile(stuck, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  let now = 1e12;
  const s = new SourceSession({ clientId: 'stuck-source-0000' }, { now: () => now, logger: quiet, ffmpeg: stuck });
  s.onStart({ codec: 'pcm', sample_rate: 44100, channels: 2, bit_depth: 16 });
  s.attach(48000);
  t.after(() => s.close());
  const chunk = sinePcm16(6615, { rate: 44100 });
  const limit = 44100 * 4 * BACKLOG_MS / 1000;
  const verdicts = [];
  for (let k = 0; k < 80 && verdicts.at(-1) !== 'overloaded'; k++) {
    now += 150_000;
    verdicts.push(s.onAudio(now - 160_000, chunk));
  }
  assert.equal(verdicts[0], 'ok');
  assert.ok(verdicts.includes('dropped'), 'chunks are dropped while the decoder is behind');
  assert.equal(verdicts.at(-1), 'overloaded', `the session gives up (${verdicts.join(',')})`);
  const firstDrop = verdicts.indexOf('dropped');
  assert.ok((verdicts.length - 1 - firstDrop) * 150 >= BACKLOG_END_MS - 150, 'only after staying behind for BACKLOG_END_MS');
  assert.ok(s.view().backlog > 0);
  assert.ok(verdicts.filter((v) => v === 'ok').length * chunk.length <= limit + 2 * chunk.length + 65536 * 2, 'what was queued stays near the bound');
});

test('chunk timing: sub-millisecond chunks are refused; the stale window is linear and still catches backlog', () => {
  let now = 1e12;
  const s = new SourceSession({ clientId: 'timing-source-000' }, { now: () => now, logger: quiet });
  s.onStart(PCM_SRC);
  assert.equal(s.onAudio(now, sinePcm16(10)), 'dropped');
  assert.equal(s.stats.rejected, 1);
  const one = sinePcm16(48);
  const t0 = process.hrtime.bigint();
  // 60 s of 1 ms chunks whose delay creeps up (the worst case for a sliding minimum).
  for (let k = 0; k < 60_000; k++) {
    now += 1000;
    assert.equal(s.onAudio(now - 1000 - k / 100, one), 'ok');
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 3000, `60k chunks in ${ms.toFixed(0)} ms`);
  now += 1000;
  assert.equal(s.onAudio(now - 1000 - 800_000, one), 'dropped', '800 ms behind the window best is stale');
  assert.equal(s.stats.stale, 1);
});

// A source that follows roles/source/v1.md: commands are handled in order, a start opens a stream after
// openMs (or right away), a stop clears a pending start and ends an open stream. Audio carries the stream
// number in its timestamp (ts % 10).
function specSource(c, { format = PCM_SRC, openMs = 0, lagMs = 0 } = {}) {
  const st = { open: false, pending: false, stream: 0, handled: 0 };
  const seenAt = [];
  const open = () => {
    if (!st.pending) return;
    st.pending = false;
    st.open = true;
    st.stream++;
    c.streamStart(format);
  };
  const timer = setInterval(() => {
    const cmds = c.commands();
    while (seenAt.length < cmds.length) seenAt.push(Date.now());
    for (; st.handled < cmds.length && Date.now() - seenAt[st.handled] >= lagMs; st.handled++) {
      const cmd = cmds[st.handled];
      if (cmd === 'start' && !st.open && !st.pending) {
        st.pending = true;
        if (openMs) setTimeout(open, openMs);
        else open();
      } else if (cmd === 'stop') {
        st.pending = false;
        if (st.open) {
          st.open = false;
          c.streamEnd();
        }
      }
    }
    if (st.open) c.sendAudio(Math.floor(Number(nowUs()) / 10) * 10 + st.stream, sinePcm16(240, { amp: 0.5 }));
  }, 5);
  return { st, stop: () => clearInterval(timer) };
}

async function twoRooms(t) {
  const env = await setup(t);
  const other = new FakeMember({ name: 'Den speaker', formats: [PCM48], player: { minBufferMs: 200 } });
  env.rooms.attach(other);
  const { c } = await connectSource(t, env.server);
  await env.server.approve(c.clientId);
  await env.sources.allow(c.clientId, true);
  await c.expect('server/activate', (p) => p.active_roles?.includes('source@v1'));
  c.state(true, 'present');
  return { ...env, other, roomB: env.rooms.roomOf(other.clientId), c };
}

test('moving a running line-in to another room keeps it live there; old in-flight audio is discarded', { timeout: 20_000 }, async (t) => {
  const { sources, rooms, roomId, roomB, c, other } = await twoRooms(t);
  const src = specSource(c, { lagMs: 40 });
  t.after(src.stop);
  sources.start(roomId, c.clientId);
  await until(() => sources.session(c.clientId)?.streaming);
  await sleep(300);
  assert.equal(rooms.getRoom(roomId).live?.sourceId, c.clientId);
  const conn = sources.session(c.clientId).conn;
  const late = [];
  let moved = false;
  conn.on('source-audio', (ts) => {
    if (moved && Number(ts) % 10 === 1) late.push(ts);
  });
  moved = true;
  sources.start(roomB, c.clientId);
  await until(() => src.st.stream === 2);
  await sleep(600);
  assert.deepEqual(c.commands(), ['start', 'stop', 'start']);
  assert.equal(rooms.getRoom(roomB).live?.sourceId, c.clientId, 'the line-in plays in the new room');
  assert.equal(rooms.getRoom(roomId).live, null);
  assert.equal(sources.session(c.clientId).roomId, roomB);
  assert.ok(sources.session(c.clientId).streaming);
  assert.deepEqual(late, [], 'audio of the superseded stream is discarded');
  await until(() => other.chunks.some((x) => x.frame.readInt16LE(400) !== 0), { timeoutMs: 3000 });
});

test('quick stop then start, before the client opened the first stream: the line-in stays live', { timeout: 20_000 }, async (t) => {
  for (const openMs of [0, 60]) {
    const { sources, rooms, roomId, roomB, c } = await twoRooms(t);
    const src = specSource(c, { openMs, lagMs: 30 });
    t.after(src.stop);
    sources.start(roomId, c.clientId);
    sources.stop(c.clientId);
    sources.start(roomB, c.clientId);
    await sleep(700);
    assert.equal(rooms.getRoom(roomB).live?.sourceId, c.clientId, `live in B (openMs ${openMs}, commands ${c.commands()})`);
    assert.ok(sources.session(c.clientId).streaming, `streaming (openMs ${openMs})`);
    assert.equal(src.st.open, true);
    src.stop();
  }
});
