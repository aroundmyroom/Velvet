import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { GroupStream, serverNow } from '../src/sendspin/scheduler.js';
import { samplesToUs } from '../src/sendspin/audio.js';
import { RoomManager } from '../src/sendspin/rooms.js';
import { IMPLEMENTED_ROLES, negotiateRoles, parseClientHello } from '../src/sendspin/connection.js';
import {
  Analyser, FFT, RoomVisualizer, aWeightDb, bandEdges, dbScale, streamConfig, RATE_MAX_CAP,
} from '../src/sendspin/visualizer.js';
import { FakeMember, FFMPEG, PCM48, until, sleep } from './helpers/sendspin-fake-member.mjs';

const execFileP = promisify(execFile);
let dir;
const F = {};

async function signal(name, expr, seconds) {
  const file = path.join(dir, `${name}.wav`);
  await execFileP(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${expr}|${expr}:s=48000:d=${seconds}`,
    '-c:a', 'pcm_s24le', file,
  ]);
  return file;
}

async function master(file) {
  const { stdout } = await execFileP(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-i', file, '-f', 's32le', '-c:a', 'pcm_s32le', '-ar', '48000', '-ac', '2', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 1 << 28 });
  return stdout;
}

// Feeds a whole file through the analyser the way GroupStream does (decode-sized items), then flushes.
async function analyse(file, { rate = 30, onsets = true, display = true, spectra = new Map(), bpm = null } = {}) {
  const pcm = await master(file);
  const an = new Analyser(48000);
  an.configure({ display, onsets, rate, spectra });
  const step = 8192 * 8;
  for (let off = 0, sample = 0; off < pcm.length; off += step) {
    const chunk = pcm.subarray(off, off + step);
    an.push({ pcm: chunk, sample, trackStart: sample === 0, track: { item: { meta: { bpm } } } });
    sample += chunk.length / 8;
    an.advance(sample - 48000);
  }
  an.end();
  an.advance(Infinity);
  return an;
}

const clicks = (periodS, startS = 0) => `if(lt(mod(t+${periodS - startS}\\,${periodS})\\,0.004)\\,0.8*sin(2*PI*2000*t)\\,0)`;
const beatsMs = (an) => an.events.filter((e) => e.kind === 0).map((e) => e.sample / 48);

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-vis-'));
  F.sine1k = await signal('sine1k', '0.1*sin(2*PI*1000*t)', 1);
  F.sine3k = await signal('sine3k', '0.5*sin(2*PI*3333*t)', 1);
  F.sine2k = await signal('sine2k', '0.5*sin(2*PI*2000*t)', 1);
  F.click120 = await signal('click120', clicks(0.5, 0.25), 8);
  F.click180 = await signal('click180', clicks(1 / 3, 0.1), 8);
  F.tone2s = await signal('tone2s', '0.3*sin(2*PI*500*t)', 2);
  F.late = await signal('late', `if(gte(t\\,1)\\,${clicks(0.5)}\\,0)`, 3);
});

after(() => fsp.rm(dir, { recursive: true, force: true }));

test('FFT matches a direct DFT; A-weighting is 0 dB at 1 kHz', () => {
  const n = 64;
  const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1));
  const fft = new FFT(n);
  const mag = fft.magnitudes(x);
  for (let k = 0; k <= n / 2; k++) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      re += x[t] * fft.window[t] * Math.cos(2 * Math.PI * k * t / n);
      im -= x[t] * fft.window[t] * Math.sin(2 * Math.PI * k * t / n);
    }
    assert.ok(Math.abs(Math.hypot(re, im) - mag[k]) < 1e-9);
  }
  assert.ok(Math.abs(aWeightDb(1000)) < 0.1);
  assert.ok(aWeightDb(100) < -18 && aWeightDb(100) > -20);
  assert.equal(dbScale(1), 65535);
  assert.equal(dbScale(1e-3), 0);
  assert.equal(dbScale(0.1), 43690);
});

test('loudness: a -20 dBFS 1 kHz sine maps to -20 dB on the -60..0 dB scale', async () => {
  const an = await analyse(F.sine1k, { onsets: false });
  const frames = an.events.filter((e) => e.kind === 2).slice(5, -5);
  for (const f of frames) assert.ok(Math.abs(f.loudness - 43690) < 400, `loudness ${f.loudness}`);
});

test('f_peak: the dominant frequency within one FFT bin, amplitude on the dB scale', async () => {
  for (const [file, hz, ampDb] of [[F.sine1k, 1000, -20], [F.sine3k, 3333, -6 + aWeightDb(3333)]]) {
    const an = await analyse(file, { onsets: false });
    for (const f of an.events.filter((e) => e.kind === 2).slice(5, -5)) {
      assert.ok(Math.abs(f.freq - hz) < 48000 / 2048, `f_peak ${f.freq} for ${hz}`);
      assert.ok(Math.abs(f.amp - dbScale(10 ** (ampDb / 20))) < 700, `amp ${f.amp}`);
    }
  }
});

test('spectrum: a 2 kHz sine lands in the display bin that holds 2 kHz, for mel, log and lin', async () => {
  const configs = ['mel', 'log', 'lin'].map((scale) => ({ n_disp_bins: 32, scale, f_min: 20, f_max: 20000 }));
  const spectra = new Map(configs.map((c) => [`${c.n_disp_bins}:${c.scale}:${c.f_min}:${c.f_max}`, c]));
  const an = await analyse(F.sine2k, { onsets: false, spectra });
  const frame = an.events.filter((e) => e.kind === 2)[15];
  for (const [key, sp] of spectra) {
    const bins = frame.spectra.get(key);
    assert.equal(bins.length, 32);
    const edges = bandEdges(32, sp.scale, 20, 20000);
    const want = edges.findIndex((e, i) => e <= 2000 && edges[i + 1] > 2000);
    const got = bins.indexOf(Math.max(...bins));
    assert.equal(got, want, `${sp.scale}: max in bin ${got}, 2 kHz is bin ${want}`);
    assert.ok(bins[got] > 55000 && bins[0] < 10000, `${sp.scale}: ${bins[got]} / ${bins[0]}`);
  }
  const lin = bandEdges(4, 'lin', 0, 400);
  assert.deepEqual([...lin], [0, 100, 200, 300, 400]);
  const log = bandEdges(2, 'log', 10, 1000);
  assert.ok(Math.abs(log[1] - 100) < 1e-9);
  const mel = bandEdges(2, 'mel', 0, 8000);
  assert.ok(Math.abs(2595 * Math.log10(1 + mel[1] / 700) - 2595 * Math.log10(1 + 8000 / 700) / 2) < 1e-6);
});

function assertGrid(beats, { firstMs, periodMs, tolMs = 12, untilMs }) {
  const want = [];
  for (let t = firstMs; t < untilMs; t += periodMs) want.push(t);
  for (const t of want) assert.ok(beats.some((b) => Math.abs(b - t) <= tolMs), `no beat near ${t} ms in ${beats.map(Math.round)}`);
  for (const b of beats) assert.ok(want.some((t) => Math.abs(b - t) <= tolMs), `stray beat at ${b.toFixed(1)} ms`);
}

test('beat: a 120 BPM click track gives a beat every 500 ms, with and without the DB bpm prior', async () => {
  for (const bpm of [null, 120]) {
    const an = await analyse(F.click120, { display: false, bpm });
    assertGrid(beatsMs(an), { firstMs: 250, periodMs: 500, untilMs: 8000 });
  }
  const peaks = (await analyse(F.click120, { display: false })).events.filter((e) => e.kind === 1);
  assert.equal(peaks.length, 16);
  const offGrid = (ms) => {
    const d = (((ms - 250) % 500) + 500) % 500;
    return Math.min(d, 500 - d);
  };
  for (const p of peaks) assert.ok(p.strength > 100 && offGrid(p.sample / 48) < 8, `peak ${p.sample / 48} ms, strength ${p.strength}`);
});

test('beat: the DB bpm prior settles the octave the free tracker cannot know', async () => {
  const free = beatsMs(await analyse(F.click180, { display: false }));
  const gaps = free.slice(1).map((b, i) => b - free[i]);
  assert.ok(gaps.every((g) => Math.abs(g - 666.7) < 15 || Math.abs(g - 333.3) < 15), `free gaps ${gaps}`);
  const prior = beatsMs(await analyse(F.click180, { display: false, bpm: 180 }));
  assertGrid(prior, { firstMs: 100, periodMs: 1000 / 3, untilMs: 8000 });
});

test('streamConfig: subset of the request, rate capped, tracks_downbeats only with beat, spectrum echoed', () => {
  const sp = { n_disp_bins: 16, scale: 'log', f_min: 30, f_max: 16000 };
  assert.deepEqual(streamConfig({ types: ['spectrum', 'beat'], rate_max: 240, spectrum: sp }), {
    types: ['beat', 'spectrum'], rate_max: RATE_MAX_CAP, tracks_downbeats: false, spectrum: sp,
  });
  assert.deepEqual(streamConfig({ types: ['loudness'], rate_max: 20 }), { types: ['loudness'], rate_max: 20 });
  const huge = { ...sp, n_disp_bins: 4096 };
  assert.deepEqual(streamConfig({ types: ['spectrum', 'peak'], rate_max: 30, spectrum: huge }).types, ['peak']);
  assert.deepEqual(streamConfig({ types: [], rate_max: 30 }), { types: [], rate_max: 30 });
});

test('visualizer@v1 is offered; its hello support carries buffer_capacity', () => {
  assert.ok(IMPLEMENTED_ROLES.includes('visualizer@v1'));
  const hello = { name: 'Lights', supported_roles: ['visualizer@v1', 'player@v1'], 'visualizer@v1_support': { buffer_capacity: 4096 } };
  assert.deepEqual(parseClientHello(hello).visualizer, { bufferCapacity: 4096 });
  assert.deepEqual(negotiateRoles(hello.supported_roles, hello), ['visualizer@v1']);
  assert.deepEqual(negotiateRoles(['visualizer@v1'], {}), []);
  assert.throws(() => parseClientHello({ ...hello, 'visualizer@v1_support': { buffer_capacity: 0 } }));
});

const req = (types, rate = 30, spectrum = undefined) => ({ types, rate_max: rate, ...(spectrum ? { spectrum } : {}) });

function setup({ leadMs = 30_000 } = {}) {
  const s = new GroupStream({ ffmpeg: FFMPEG });
  const v = new RoomVisualizer(s, { now: serverNow, leadMs, tickMs: 10 });
  return { s, v };
}

function member(opts) {
  const m = new FakeMember({ formats: [PCM48], ...opts });
  m.activate({ activities: ['playback'] });
  return m;
}

const visOf = (m, type) => m.vis.filter((c) => c.payload.type === type).map((c) => c.payload);

test('frames ride the audio timeline: beats land on the clicks as heard, frames on the sample grid, in order', async () => {
  const { s, v } = setup();
  const m = member({ roles: ['player', 'visualizer'], visualizer: req(['beat', 'loudness', 'peak'], 25) });
  s.addMember(m);
  v.addMember(m);
  const ended = new Promise((r) => s.once('ended', r));
  s.play([{ file: F.late, item: { meta: { bpm: 120 } } }]);
  await ended;
  const start = m.of('stream/start').map((c) => c.payload);
  assert.deepEqual(start.find((p) => p.visualizer).visualizer, { types: ['beat', 'loudness', 'peak'], rate_max: 25, tracks_downbeats: false });
  const t0 = m.chunks[0].ts;
  assert.equal(t0, s.t0);
  const beats = visOf(m, 'beat').map((b) => (b.ts - t0) / 1000);
  assertGrid(beats, { firstMs: 1000, periodMs: 500, untilMs: 3000 });
  assert.ok(visOf(m, 'beat').every((b) => b.downbeat === false));
  const loud = visOf(m, 'loudness');
  for (const f of loud) {
    const sample = Math.round((f.ts - t0) * 48 / 1000);
    assert.equal(f.ts - t0, samplesToUs(sample, 48000));
    assert.equal(sample % (48000 / 25), 0);
  }
  const quiet = loud.filter((f) => f.ts - t0 < 900_000);
  assert.ok(quiet.length > 15 && quiet.every((f) => f.value === 0));
  const all = m.vis.map((c) => c.payload.ts);
  assert.ok(all.every((ts, i) => i === 0 || ts >= all[i - 1]), 'non-decreasing timestamps');
  assert.ok(m.vis.every((c) => c.payload.ts > c.at), 'never stale on arrival');
  s.stop();
  assert.deepEqual(m.calls.filter((c) => c.type === 'stream/end').map((c) => c.payload.roles).flat().sort(), ['player', 'visualizer']);
  assert.equal(m.calls.findLast((c) => c.type === 'vis').at <= m.calls.findLast((c) => c.type === 'stream/end').at, true);
});

test('only the requested types, at most rate_max periodic frames per type; one analysis serves different configs', async () => {
  const { s, v } = setup();
  const sp = { n_disp_bins: 8, scale: 'mel', f_min: 40, f_max: 12000 };
  const a = member({ roles: ['player', 'visualizer'], visualizer: req(['loudness'], 30) });
  const b = member({ roles: ['visualizer'], visualizer: req(['spectrum', 'f_peak'], 10, sp) });
  s.addMember(a);
  v.addMember(a);
  v.addMember(b);
  const ended = new Promise((r) => s.once('ended', r));
  s.play([{ file: F.sine2k }]);
  await ended;
  await sleep(30);
  assert.deepEqual([...new Set(a.vis.map((c) => c.payload.type))], ['loudness']);
  assert.deepEqual([...new Set(b.vis.map((c) => c.payload.type))].sort(), ['f_peak', 'spectrum']);
  for (const [m, type, rate] of [[a, 'loudness', 30], [b, 'spectrum', 10], [b, 'f_peak', 10]]) {
    const ts = visOf(m, type).map((f) => f.ts);
    assert.ok(ts.length >= rate * 0.8, `${type}: ${ts.length} frames`);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 1_000_000 / rate - 100, `${type} interval ${ts[i] - ts[i - 1]}`);
  }
  assert.ok(visOf(b, 'spectrum').every((f) => f.bins.length === 8));
  assert.ok(visOf(b, 'f_peak').slice(2).every((f) => Math.abs(f.freq - 2000) < 24));
  assert.deepEqual(b.of('stream/start')[0].payload, { visualizer: { types: ['f_peak', 'spectrum'], rate_max: 10, spectrum: sp } });
  s.stop();
});

test('buffer_capacity: never more future-stamped visualizer bytes outstanding than the client allows', async () => {
  const { s, v } = setup();
  const cap = 300;
  const m = member({ roles: ['visualizer'], visCapacity: cap, visualizer: req(['loudness', 'f_peak'], 60) });
  v.addMember(m);
  s.play([{ file: F.sine1k }]);
  await until(() => m.vis.length > 60, { timeoutMs: 4000 });
  for (let i = 0; i < m.vis.length; i++) {
    const c = m.vis[i];
    let outstanding = 0;
    for (const p of m.vis.slice(0, i)) if (p.payload.ts > c.at) outstanding += p.payload.size;
    assert.ok(outstanding + c.payload.size <= cap, `message ${i}: ${outstanding} + ${c.payload.size} > ${cap}`);
  }
  s.stop();
});

test('seek = stream/clear, a new timeline from the start; pause = stream/end; resume = stream/start', async () => {
  const { s, v } = setup();
  const m = member({ roles: ['player', 'visualizer'], visualizer: req(['loudness'], 20) });
  s.addMember(m);
  v.addMember(m);
  s.play([{ file: F.click120 }]);
  await until(() => m.vis.length > 10);
  const firstT0 = s.t0;
  s.play([{ file: F.click120, startMs: 4000 }]);
  const clears = m.of('stream/clear').map((c) => c.payload.roles);
  assert.deepEqual(clears, [['player'], ['visualizer']]);
  const clearAt = m.calls.findIndex((c) => c.type === 'stream/clear' && c.payload.roles[0] === 'visualizer');
  await until(() => m.calls.slice(clearAt).some((c) => c.type === 'vis'));
  const after = m.calls.slice(clearAt).filter((c) => c.type === 'vis').map((c) => c.payload.ts);
  assert.ok(s.t0 > firstT0);
  assert.ok(after.every((ts) => ts >= s.t0));
  assert.equal(m.of('stream/end').length, 0);
  s.stop();
  assert.deepEqual(m.of('stream/end').map((c) => c.payload.roles).flat().sort(), ['player', 'visualizer']);
  const n = m.vis.length;
  await sleep(60);
  assert.equal(m.vis.length, n, 'nothing after stream/end');
  s.play([{ file: F.click120 }]);
  assert.equal(m.of('stream/start').at(-1).payload.visualizer.types[0], 'loudness');
  await until(() => m.vis.length > n);
  s.stop();
});

test('late joiner: stream/start, then only frames that are still in the future', async () => {
  const { s, v } = setup({ leadMs: 500 });
  const a = member({ roles: ['player'] });
  s.addMember(a);
  s.play([{ file: F.click120 }]);
  await until(() => a.chunks.length > 0);
  await sleep(300);
  const m = member({ roles: ['visualizer'], visualizer: req(['loudness', 'beat'], 30) });
  const joinedAt = serverNow();
  v.addMember(m);
  assert.equal(m.calls.at(-1).type, 'stream/start');
  await until(() => visOf(m, 'beat').length >= 2, { timeoutMs: 4000 });
  assert.ok(m.vis.every((c) => c.payload.ts >= joinedAt + 50_000));
  const beats = visOf(m, 'beat').map((b) => (b.ts - s.t0) / 1000);
  for (const b of beats) assert.ok(Math.abs(((b - 250) % 500 + 500) % 500) < 12 || Math.abs(((b - 250) % 500) - 500) < 12, `beat at ${b}`);
  v.removeMember(m.clientId);
  assert.deepEqual(m.calls.at(-1).payload, { roles: ['visualizer'] });
  s.stop();
});

test('a changed request mid-stream is an in-place stream/start, no clear', async () => {
  const { s, v } = setup({ leadMs: 500 });
  const m = member({ roles: ['player', 'visualizer'], visualizer: req(['loudness'], 20) });
  s.addMember(m);
  v.addMember(m);
  s.play([{ file: F.click120 }]);
  await until(() => m.vis.length > 5);
  m.setState({ roles: { visualizer: req(['loudness', 'peak'], 10) } });
  v.memberChanged(m.clientId);
  const restart = m.of('stream/start').at(-1).payload;
  assert.deepEqual(restart, { visualizer: { types: ['loudness', 'peak'], rate_max: 10 } });
  v.memberChanged(m.clientId);
  assert.equal(m.of('stream/start').filter((c) => c.payload.visualizer).length, 2, 'unchanged request: no stream/start');
  await until(() => visOf(m, 'peak').length > 1);
  assert.equal(m.of('stream/clear').length, 0);
  const ts = m.vis.map((c) => c.payload.ts);
  assert.ok(ts.every((t, i) => i === 0 || t >= ts[i - 1]));
  s.stop();
});

test('a queue edit that cuts the read-ahead withdraws the frames already sent past the cut (from_timestamp)', async () => {
  const { s, v } = setup();
  const m = member({ roles: ['player', 'visualizer'], visualizer: req(['loudness', 'f_peak'], 20) });
  s.addMember(m);
  v.addMember(m);
  s.play([{ file: F.tone2s, id: 'x' }, { file: F.sine2k, id: 'z' }]);
  await until(() => s.t0 !== null && m.vis.some((c) => c.payload.ts > s.t0 + 2_300_000));
  assert.ok(s.replaceUpcoming(() => [{ file: F.sine1k, id: 'y' }]));
  const cutUs = s.t0 + samplesToUs(2 * 48000, 48000);
  const clear = m.of('stream/clear').find((c) => c.payload.roles.includes('visualizer'));
  assert.deepEqual(clear.payload, { roles: ['visualizer'], fromTimestamp: cutUs });
  const idx = m.calls.indexOf(clear);
  await until(() => m.calls.slice(idx).some((c) => c.type === 'vis' && c.payload.ts > cutUs + 300_000));
  const later = m.calls.slice(idx).filter((c) => c.type === 'vis').map((c) => c.payload);
  assert.ok(later.every((f) => f.ts >= cutUs));
  const peaks = later.filter((f) => f.type === 'f_peak' && f.ts > cutUs + 100_000).map((f) => f.freq);
  assert.ok(peaks.length && peaks.every((hz) => Math.abs(hz - 1000) < 24), `after the cut: ${peaks}`);
  s.stop();
});

test('rooms: a visualizer-only speaker gets playback and its own stream; pause ends it, resume restarts it', async () => {
  const rmDir = path.join(dir, 'rooms');
  const rm = await RoomManager.open(rmDir, { ffmpeg: FFMPEG, idleGraceMs: 150 });
  const speaker = new FakeMember({ name: 'Speaker', formats: [PCM48] });
  const lights = new FakeMember({ name: 'Lights', roles: ['visualizer'], visualizer: req(['beat', 'loudness'], 30) });
  rm.attach(speaker);
  rm.attach(lights);
  const id = rm.createRoom('Party', [speaker.clientId, lights.clientId]);
  rm.play(id, { items: [{ filepath: 'Music/c.wav', file: F.click120, meta: { title: 'C', durationMs: 8000, bpm: 120 } }] });
  assert.ok(lights.activities.includes('playback'));
  await until(() => visOf(lights, 'beat').length >= 2, { timeoutMs: 5000 });
  assert.equal(lights.chunks.length, 0);
  assert.deepEqual(lights.of('stream/start')[0].payload.visualizer.types, ['beat', 'loudness']);
  rm.pause(id);
  assert.deepEqual(lights.of('stream/end').at(-1).payload.roles, ['visualizer']);
  rm.resume(id);
  assert.ok(lights.of('stream/start').length >= 2);
  rm.stop(id);
  await rm.close();
});
