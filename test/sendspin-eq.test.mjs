import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  EQ_BANDS, eqFilterChain, eqHeadroomDb, eqResponseDb, normalizeEq, defaultEq, LIMITER,
} from '../src/sendspin/eq.js';
import { openDecoder } from '../src/sendspin/audio.js';
import { GroupStream, serverNow } from '../src/sendspin/scheduler.js';
import { RoomManager } from '../src/sendspin/rooms.js';
import { PcmTap } from '../src/sendspin/sonos.js';
import { FakeMember, FFMPEG, PCM48, until, sleep, pcmDurationUs } from './helpers/sendspin-fake-member.mjs';

const execFileP = promisify(execFile);
const RATE = 48000;
const HOUSE = [6, 5, 2, -3, -1, 1, 2, 3];
const ALL12 = Array(8).fill(12);
const KHZ12 = [0, 0, 0, 0, 12, 0, 0, 0];

let dir;
const F = {};

async function lavfi(name, src) {
  const file = path.join(dir, `${name}.wav`);
  await execFileP(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', src, '-af', 'pan=stereo|c0=c0|c1=c0', '-c:a', 'pcm_s16le', file]);
  return file;
}

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-eq-'));
  F.sine1k = await lavfi('sine1k', `aevalsrc='sin(2*PI*1000*t)':s=${RATE}:d=1`);
  F.square = await lavfi('square', `aevalsrc='if(lt(mod(t*100\\,1)\\,0.5)\\,1\\,-1)':s=${RATE}:d=1`);
  F.noise = await lavfi('noise', `anoisesrc=a=1:c=white:d=1:r=${RATE}:s=7`);
  for (const f of [60, 100, 500, 3000, 14000]) F[`t${f}`] = await lavfi(`t${f}`, `aevalsrc='0.25*sin(2*PI*${f}*t)':s=${RATE}:d=1`);
  F.long = await lavfi('long', `sine=f=220:r=${RATE}:d=4`);
});

after(() => fsp.rm(dir, { recursive: true, force: true }));

async function decode(file, eq, gainDb = 0) {
  const parts = [];
  for await (const pcm of await openDecoder({ file, eq, gainDb, sampleRate: RATE, channels: 2, ffmpeg: FFMPEG })) parts.push(pcm);
  const buf = Buffer.concat(parts);
  const out = new Float64Array(buf.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt32LE(i * 8) / 2 ** 31;
  return { buf, left: out };
}

function rmsDb(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / (to - from));
}

const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

test('filter chain: browser bands as ffmpeg cookbook filters, headroom first, limiter last', () => {
  const { headroomDb, filters } = eqFilterChain({ enabled: true, gains: HOUSE }, RATE);
  assert.deepEqual(filters, [
    `aformat=sample_fmts=fltp:sample_rates=${RATE}`,
    'lowshelf=f=60:t=s:w=1:g=6',
    'equalizer=f=100:t=q:w=1.8:g=5',
    'equalizer=f=200:t=q:w=1.4:g=2',
    'equalizer=f=500:t=q:w=1.8:g=-3',
    'equalizer=f=1000:t=q:w=1.4:g=-1',
    'equalizer=f=3000:t=q:w=1.4:g=1',
    'equalizer=f=10000:t=q:w=1.4:g=2',
    'highshelf=f=14000:t=s:w=1:g=3',
    LIMITER,
  ]);
  assert.ok(headroomDb >= 6 && headroomDb < 6.5, `headroom ${headroomDb}`);
  const one = eqFilterChain({ enabled: true, gains: [0, 0, 0, 0, 0, 0, 0, -2.5] }, RATE);
  assert.deepEqual(one.filters.slice(1, -1), ['highshelf=f=14000:t=s:w=1:g=-2.5']);
  assert.equal(one.headroomDb, 0, 'cuts need no headroom');
  assert.equal(EQ_BANDS.length, 8);
});

test('flat or disabled EQ adds no filter at all and decodes bit-identical to no EQ', async () => {
  for (const eq of [null, defaultEq(), { enabled: false, gains: HOUSE }, { enabled: true, gains: Array(8).fill(0) }]) {
    assert.deepEqual(eqFilterChain(eq, RATE), { headroomDb: 0, filters: [] });
  }
  const plain = await decode(F.t500, null);
  const off = await decode(F.t500, { enabled: false, gains: HOUSE });
  assert.ok(off.buf.equals(plain.buf));
});

test('headroom is the peak of the whole cascade: neighbouring boosts add up', () => {
  assert.equal(eqHeadroomDb(Array(8).fill(0), RATE), 0);
  assert.ok(Math.abs(eqHeadroomDb(KHZ12, RATE) - 12) < 0.01);
  const lows = eqHeadroomDb([12, 12, 0, 0, 0, 0, 0, 0], RATE);
  assert.ok(lows > 13.5, `60 Hz shelf + 100 Hz peak reach ${lows} dB, more than either band`);
  assert.ok(Math.abs(eqResponseDb(KHZ12, 1000, RATE) - 12) < 1e-9);
  assert.ok(Math.abs(eqResponseDb([-6, 0, 0, 0, 0, 0, 0, 0], 5, RATE) + 6) < 0.01, 'a low shelf reaches its gain at DC');
});

test('the room sounds like the browser EQ: measured gain per band = cookbook response - headroom', async () => {
  const eq = { enabled: true, gains: HOUSE };
  const { headroomDb } = eqFilterChain(eq, RATE);
  for (const f of [60, 100, 500, 3000, 14000]) {
    const ref = (await decode(F[`t${f}`], null)).left;
    const out = (await decode(F[`t${f}`], eq)).left;
    const measured = rmsDb(out, 4800, 43200) - rmsDb(ref, 4800, 43200);
    const want = eqResponseDb(HOUSE, f, RATE) - headroomDb;
    assert.ok(Math.abs(measured - want) < 0.2, `${f} Hz: measured ${measured.toFixed(2)} dB, want ${want.toFixed(2)} dB`);
  }
});

test('never clips: full-scale sine, square and noise through +12 dB on every band stay below full scale', async () => {
  for (const [name, gains] of [['sine1k', KHZ12], ['sine1k', ALL12], ['square', ALL12], ['square', [12, 12, 0, 0, 0, 0, 0, 0]], ['noise', ALL12]]) {
    const ref = await decode(F[name], null);
    assert.ok(peak(ref.left) > 0.99, `${name} is full scale`);
    const { buf, left } = await decode(F[name], { enabled: true, gains }, 0);
    const p = peak(left);
    assert.ok(p < 0.99, `${name} ${gains}: peak ${(20 * Math.log10(p)).toFixed(2)} dBFS`);
    for (let i = 0; i < buf.length; i += 4) assert.ok(Math.abs(buf.readInt32LE(i)) < 0x7fffff00, `${name}: sample ${i / 4} at full scale`);
  }
  const loud = await decode(F.sine1k, { enabled: true, gains: KHZ12 });
  assert.ok(peak(loud.left) > 0.9, 'a single boost keeps the tone loud (headroom, not squashing)');
});

test('normalizeEq clamps, rounds and fills', () => {
  assert.deepEqual(normalizeEq({ enabled: true, gains: [20, -20, 1.26, 'x'], preset: 'House' }), {
    enabled: true, gains: [12, -12, 1.3, 0, 0, 0, 0, 0], preset: 'House',
  });
  assert.deepEqual(normalizeEq(undefined), defaultEq());
  assert.equal(normalizeEq({ enabled: false }).enabled, false);
});

const item = (file, title, durationMs) => ({ filepath: `Music/${title}.wav`, file, meta: { title, durationMs } });

test('a live EQ change keeps the song at its position: stream/clear from_timestamp, no earlier chunk, gapless', async () => {
  const rm = await RoomManager.open(path.join(dir, 'live'), { ffmpeg: FFMPEG, idleGraceMs: 150 });
  const a = new FakeMember({ formats: [PCM48] });
  rm.attach(a);
  const id = rm.createRoom('EQ', [a.clientId]);
  rm.play(id, { items: [item(F.long, 'L', 4000)] });
  await until(() => a.chunks.length > 0 && serverNow() > a.chunks[0].ts + 600_000);
  const start = a.chunks[0].ts;
  const posBefore = rm.getRoom(id).positionMs;
  const mark = a.calls.length;
  const ended = new Promise((res) => rm.once('ended', res));
  rm.setEq(id, { enabled: true, gains: KHZ12, preset: null });
  assert.deepEqual(rm.getRoom(id).eq.gains, KHZ12);
  assert.ok(rm.getRoom(id).positionMs >= posBefore, 'the position carries on');
  const after = a.calls.slice(mark);
  const clears = after.filter((c) => c.type === 'stream/clear');
  assert.equal(clears.length, 1);
  const from = clears[0].payload.fromTimestamp;
  assert.ok(from !== undefined, 'a cut, not a restart');
  assert.ok(from > clears[0].at && from - clears[0].at < 1_000_000, `takes effect within a second (${from - clears[0].at} us)`);
  await until(() => a.calls.slice(mark).some((c) => c.type === 'chunk'));
  const first = a.calls.slice(mark).find((c) => c.type === 'chunk');
  assert.ok(first.ts >= from, `first chunk after the clear (${first.ts}) is not earlier than from_timestamp (${from})`);
  await ended;
  assert.ok(!a.calls.slice(mark).some((c) => c.type === 'stream/start'), 'no restart');
  const split = a.calls[mark].at;
  const kept = a.chunks.filter((c) => c.at < split && c.ts < from);
  const fresh = a.chunks.filter((c) => c.at >= split);
  assert.ok(fresh.every((c) => c.ts >= from));
  const timeline = [...kept, ...fresh];
  for (let i = 1; i < timeline.length; i++) {
    assert.equal(timeline[i].ts, timeline[i - 1].ts + pcmDurationUs(timeline[i - 1], PCM48), `gapless at chunk ${i}`);
  }
  assert.equal(timeline.at(-1).ts + pcmDurationUs(timeline.at(-1), PCM48) - start, 4_000_000, 'nothing replayed or skipped');
  const level = (chunks) => {
    const b = Buffer.concat(chunks.map((c) => c.frame));
    const x = new Float64Array(b.length / 4);
    for (let i = 0; i < x.length; i++) x[i] = b.readInt16LE(i * 4) / 32768;
    return rmsDb(x);
  };
  const drop = level(kept.slice(1, -1)) - level(fresh.slice(2, -2));
  const want = 12 - eqResponseDb(KHZ12, 220, RATE);
  assert.ok(Math.abs(drop - want) < 0.5, `after the cut the room hears the EQ: ${drop.toFixed(2)} dB down, want ${want.toFixed(2)}`);
  await rm.close();
});

test('an EQ change while paused or stopped only stores it; the next play uses it', async () => {
  const rm = await RoomManager.open(path.join(dir, 'idle'), { ffmpeg: FFMPEG, idleGraceMs: 150 });
  const a = new FakeMember({ formats: [PCM48] });
  rm.attach(a);
  const id = rm.createRoom('Idle', [a.clientId]);
  const mark = a.calls.length;
  rm.setEq(id, { enabled: true, gains: KHZ12 });
  assert.ok(!a.calls.slice(mark).some((c) => c.type.startsWith('stream/')));
  rm.play(id, { items: [item(F.long, 'L', 4000)] });
  await until(() => a.chunks.length > 20);
  const b = Buffer.concat(a.chunks.slice(2, 20).map((c) => c.frame));
  const x = new Float64Array(b.length / 4);
  for (let i = 0; i < x.length; i++) x[i] = b.readInt16LE(i * 4) / 32768;
  const ref = (await decode(F.long, null)).left;
  assert.ok(rmsDb(ref) - rmsDb(x) > 10, 'played with the stored EQ');
  await rm.close();
});

test('the room EQ survives a restart; a default EQ is not written', async () => {
  const d = path.join(dir, 'persist');
  const rm = await RoomManager.open(d, { ffmpeg: FFMPEG });
  const a = new FakeMember({ name: 'A' });
  const b = new FakeMember({ name: 'B' });
  rm.attach(a);
  rm.attach(b);
  const id = rm.createRoom('Lounge', [a.clientId, b.clientId]);
  rm.setEq(id, { enabled: false, gains: HOUSE, preset: 'House' });
  await rm.close();
  const raw = JSON.parse(await fsp.readFile(path.join(d, 'rooms.json'), 'utf8'));
  assert.deepEqual(raw.rooms.find((r) => r.id === id).eq, { enabled: false, gains: HOUSE, preset: 'House' });
  assert.ok(raw.rooms.filter((r) => r.id !== id).every((r) => r.eq === undefined));
  const rm2 = await RoomManager.open(d, { ffmpeg: FFMPEG });
  assert.deepEqual(rm2.getRoom(id).eq, { enabled: false, gains: HOUSE, preset: 'House' });
  assert.deepEqual(rm2.listRooms().find((r) => r.id === id).eq.gains, HOUSE);
  await rm2.close();
});

test('Sonos followers hear the EQ: the master PCM tap carries the equalised audio', async () => {
  const s = new GroupStream({ ffmpeg: FFMPEG });
  const m = new FakeMember({ formats: [PCM48] });
  m.activate({ activities: ['playback'] });
  s.addMember(m);
  const tap = new PcmTap({ now: serverNow });
  tap.attach(s);
  const levelAt = async (eq) => {
    s.play([{ file: F.t500, eq }]);
    await until(() => s.t0 !== null && m.chunks.length > 10);
    await sleep(50);
    const out = tap.read(s.t0 + 200_000, 9600);
    const x = new Float64Array(out.length / 4);
    for (let i = 0; i < x.length; i++) x[i] = out.readInt16LE(i * 4) / 32768;
    return rmsDb(x);
  };
  const flat = await levelAt(null);
  const cut = await levelAt({ enabled: true, gains: [0, 0, 0, -12, 0, 0, 0, 0] });
  s.close();
  tap.detach();
  const want = -eqResponseDb([0, 0, 0, -12, 0, 0, 0, 0], 500, RATE);
  assert.ok(Math.abs(flat - cut - want) < 0.5, `tap ${(flat - cut).toFixed(2)} dB down, want ${want.toFixed(2)}`);
});

test('rerender is refused before the timeline is anchored (the room restarts instead)', () => {
  const s = new GroupStream({ ffmpeg: FFMPEG });
  assert.equal(s.rerender(() => []), false);
  s.play([{ file: F.long }]);
  assert.equal(s.rerender(() => []), false);
  s.close();
});
