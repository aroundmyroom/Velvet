import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { RoomManager, RoomError, groupVolumes } from '../src/sendspin/rooms.js';
import { serverNow } from '../src/sendspin/scheduler.js';
import { RoomsService, STOP_TIMEOUT_MS } from '../src/sendspin/service.js';
import { FakeMember, FFMPEG, PCM48, FLAC44, tone, until, sleep, pcmDurationUs } from './helpers/sendspin-fake-member.mjs';
import { RoomClient } from './helpers/sendspin-room-client.mjs';

let dir;
const F = {};

before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-rooms-'));
  F.a = await tone(path.join(dir, 'a.wav'), { freq: 440, seconds: 0.6 });
  F.b = await tone(path.join(dir, 'b.wav'), { freq: 660, seconds: 0.5 });
  F.long = await tone(path.join(dir, 'long.wav'), { freq: 220, seconds: 4 });
  F.mid = await tone(path.join(dir, 'mid.wav'), { freq: 330, seconds: 1.5 });
});

after(() => fsp.rm(dir, { recursive: true, force: true }));

let n = 0;
function manager(opts = {}) {
  const d = opts.dir ?? path.join(dir, `rm${++n}`);
  return RoomManager.open(d, { ffmpeg: FFMPEG, idleGraceMs: 150, ...opts });
}

const item = (file, title, durationMs, extra = {}) => ({
  filepath: `Music/${title}.wav`, file, meta: { title, artist: 'Tester', album: 'Tones', durationMs, track: 1, year: 2026 }, ...extra,
});
const queue = () => [item(F.a, 'A', 600), item(F.b, 'B', 500)];
const longQueue = () => [item(F.long, 'L', 4000), item(F.a, 'A', 600)];
const cmd = (m, command, extra = {}) => m.emit('command', { controller: { command, ...extra } });
const last = (m, type) => m.of(type).at(-1);
const metadataOf = (m) => m.of('server/state').filter((c) => c.payload.metadata).map((c) => ({ ...c.payload.metadata, at: c.at }));
const controllerOf = (m) => m.of('server/state').filter((c) => c.payload.controller).at(-1).payload.controller;

test('groupVolumes: delta from the average, clamp, redistribute, round', () => {
  assert.deepEqual(groupVolumes([20, 40], 50), [40, 60]);
  assert.deepEqual(groupVolumes([10, 50, 90], 100), [100, 100, 100]);
  assert.deepEqual(groupVolumes([10, 50, 90], 0), [0, 0, 0]);
  assert.deepEqual(groupVolumes([0, 100], 60), [20, 100]);
  assert.deepEqual(groupVolumes([80, 90, 20], 90), [100, 100, 70]);
  assert.deepEqual(groupVolumes([10, 11, 12], 50), [49, 50, 51]);
  assert.deepEqual(groupVolumes([33, 33, 34], 34), [34, 34, 35]);
  assert.deepEqual(groupVolumes([], 50), []);
});

test('every client starts in a solo room named after it; group/update after attach', async () => {
  const rm = await manager();
  const a = new FakeMember({ name: 'Kitchen' });
  const b = new FakeMember({ name: 'Study' });
  const ra = rm.attach(a);
  rm.attach(b);
  const g = last(a, 'group/update').payload;
  assert.equal(g.playbackState, 'stopped');
  assert.equal(g.groupId, ra);
  assert.match(g.groupId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(g.groupName, 'Kitchen');
  const rooms = rm.listRooms();
  assert.deepEqual(rooms.map((r) => r.name).sort(), ['Kitchen', 'Study']);
  assert.equal(rooms.find((r) => r.name === 'Kitchen').members[0].clientId, a.clientId);
  assert.ok(controllerOf(a).supported_commands.includes('switch'));
  assert.deepEqual(metadataOf(a)[0].progress, undefined);
  assert.throws(() => rm.getRoom('nope'), RoomError);
  await rm.close();
});

test('a room plays a two-track queue to two speakers: activation, streams, metadata scheduled at the boundary', async () => {
  const rm = await manager();
  const a = new FakeMember({ name: 'A', formats: [PCM48] });
  const b = new FakeMember({ name: 'B', formats: [FLAC44] });
  rm.attach(a);
  rm.attach(b);
  const id = rm.createRoom('Living room', [a.clientId, b.clientId]);
  assert.equal(last(a, 'group/update').payload.groupName, 'Living room');
  assert.equal(rm.listRooms().length, 1);
  const ended = new Promise((r) => rm.once('ended', r));
  rm.play(id, { items: queue() });
  assert.deepEqual(last(a, 'server/activate').payload.activities, ['playback']);
  assert.equal(last(a, 'group/update').payload.playbackState, 'playing');
  assert.equal(last(b, 'stream/start').payload.player.codec, 'flac');
  await until(() => a.chunks.length > 0 && b.chunks.length > 0);
  const view = rm.getRoom(id);
  assert.equal(view.state, 'playing');
  assert.equal(view.members.length, 2);
  assert.ok(view.members.every((m) => m.streaming));
  await ended;
  const md = metadataOf(a).filter((x) => x.title);
  assert.deepEqual(md.map((x) => x.title), ['A', 'B', 'A']);
  const t0 = a.chunks[0].ts;
  assert.equal(md[0].timestamp, t0);
  assert.deepEqual(md[0].progress, { track_progress: 0, track_duration: 600, playback_speed: 1000 });
  assert.equal(md[1].timestamp, t0 + 600_000);
  assert.ok(md[1].at < md[1].timestamp, 'next track metadata is sent ahead of its timestamp');
  assert.ok(md[1].timestamp - md[1].at <= 20_000_000);
  assert.ok(md[1].at > md[0].timestamp, 'the next update waits until the previous scheduled one took effect');
  assert.equal(md[2].progress.playback_speed, 0);
  assert.equal(last(a, 'group/update').payload.playbackState, 'stopped');
  assert.equal(last(a, 'stream/end').payload.roles[0], 'player');
  assert.equal(rm.getRoom(id).state, 'stopped');
  await until(() => !a.activities.includes('playback'));
  await rm.close();
});

test('group volume and mute: only supporting players get one command each; read-only players are shown', async () => {
  const rm = await manager();
  const a = new FakeMember({ player: { volume: 80 } });
  const b = new FakeMember({ player: { volume: 20, muted: true } });
  const ro = new FakeMember({ player: { volume: 5, supportedCommands: [] } });
  for (const m of [a, b, ro]) rm.attach(m);
  const id = rm.createRoom('Vol', [a.clientId, b.clientId, ro.clientId]);
  assert.equal(rm.getRoom(id).volume, 50);
  assert.equal(rm.getRoom(id).muted, false);
  const marker = [a, b, ro].map((m) => m.of('server/command').length);
  assert.deepEqual(rm.setVolume(id, 90), { [a.clientId]: 100, [b.clientId]: 80 });
  assert.deepEqual(a.of('server/command').slice(marker[0]).map((c) => c.payload.player), [{ command: 'volume', volume: 100 }]);
  assert.deepEqual(b.of('server/command').slice(marker[1]).map((c) => c.payload.player), [{ command: 'volume', volume: 80 }]);
  assert.equal(ro.of('server/command').length, marker[2]);
  rm.mute(id, true);
  assert.deepEqual(last(a, 'server/command').payload.player, { command: 'mute', mute: true });
  assert.equal(ro.of('server/command').length, marker[2]);
  a.setState({ player: { volume: 100, muted: true } });
  b.setState({ player: { volume: 80, muted: true } });
  const ctl = controllerOf(a);
  assert.equal(ctl.volume, 90);
  assert.equal(ctl.muted, true);
  b.setState({ player: { muted: false } });
  assert.equal(controllerOf(a).muted, false);
  assert.throws(() => rm.setMemberVolume(id, ro.clientId, 50), /read-only/);
  rm.setMemberVolume(id, b.clientId, 33);
  assert.deepEqual(last(b, 'server/command').payload.player, { command: 'volume', volume: 33 });
  const view = rm.getRoom(id).members.find((m) => m.clientId === ro.clientId);
  assert.equal(view.volume, 5);
  assert.equal(view.volumeSettable, false);
  const solo = new FakeMember({ player: { supportedCommands: [] } });
  const sid = rm.attach(solo);
  assert.equal(rm.getRoom(sid).volume, 100);
  assert.ok(!controllerOf(solo).supported_commands.includes('volume'));
  assert.ok(!controllerOf(solo).supported_commands.includes('mute'));
  await rm.close();
});

test('regroup does not interrupt members that stay; moved members join late, removed ones end', async () => {
  const rm = await manager();
  const [a, b, c] = [new FakeMember(), new FakeMember(), new FakeMember()];
  for (const m of [a, b, c]) rm.attach(m);
  const id = rm.createRoom('R', [a.clientId, b.clientId]);
  rm.play(id, { items: longQueue() });
  await until(() => a.chunks.length > 2);
  const marks = [a, b].map((m) => m.calls.length);
  rm.setMembers(id, [a.clientId, b.clientId, c.clientId]);
  assert.equal(last(c, 'stream/start').type, 'stream/start');
  assert.equal(last(c, 'group/update').payload.groupId, id);
  await until(() => c.chunks.length > 2);
  assert.ok(c.chunks[0].ts > c.of('stream/start').at(-1).at);
  rm.setMembers(id, [a.clientId, c.clientId]);
  assert.equal(last(b, 'stream/end').payload.roles[0], 'player');
  assert.notEqual(last(b, 'group/update').payload.groupId, id);
  const types = a.calls.slice(marks[0]).map((x) => x.type);
  assert.ok(!types.some((t) => t.startsWith('stream/')), `a got ${[...new Set(types)]}`);
  await rm.close();
});

test('available:false parks the speaker in a stopped solo room; switch brings it back', async () => {
  const rm = await manager();
  const a = new FakeMember({ name: 'A' });
  const b = new FakeMember({ name: 'B' });
  rm.attach(a);
  rm.attach(b);
  const id = rm.createRoom('Pair', [a.clientId, b.clientId]);
  rm.play(id, { items: longQueue() });
  await until(() => a.chunks.length > 2 && b.chunks.length > 2);
  a.setState({ available: false });
  const g = last(a, 'group/update').payload;
  assert.notEqual(g.groupId, id);
  assert.equal(g.playbackState, 'stopped');
  assert.equal(g.groupName, 'A');
  assert.ok(!a.activeStreams.includes('player'));
  assert.ok(!a.activities.includes('playback'));
  const n = b.chunks.length;
  await until(() => b.chunks.length > n + 3);
  a.setState({ available: true });
  assert.notEqual(rm.roomOf(a.clientId), id, 'never pulled back automatically');
  const mark = a.calls.length;
  cmd(a, 'switch');
  assert.equal(rm.roomOf(a.clientId), id);
  assert.equal(last(a, 'group/update').payload.groupId, id);
  assert.ok(a.calls.slice(mark).some((c) => c.type === 'stream/start'));
  await until(() => a.chunks.length > 0 && a.chunks.at(-1).at > a.calls[mark].at);
  await rm.close();
});

test('an initial available:false gets a grace period before the speaker is parked', async () => {
  const rm = await manager({ initialUnavailableGraceMs: 80 });
  const [a, b, c] = [new FakeMember(), new FakeMember(), new FakeMember()];
  for (const m of [a, b, c]) rm.attach(m);
  const id = rm.createRoom('Grace', [a.clientId, b.clientId, c.clientId]);
  rm.detach(a.clientId);
  rm.detach(b.clientId);
  const a2 = new FakeMember({ clientId: a.clientId, available: false });
  const b2 = new FakeMember({ clientId: b.clientId, available: false });
  rm.attach(a2);
  rm.attach(b2);
  a2.setState({ available: true });
  await sleep(150);
  assert.equal(rm.roomOf(a.clientId), id, 'synced in time: stays');
  assert.notEqual(rm.roomOf(b.clientId), id, 'still unavailable: parked');
  await rm.close();
});

test('client/leave parks without pulling back; a solo room just stops', async () => {
  const rm = await manager();
  const a = new FakeMember({ name: 'A' });
  const sid = rm.attach(a);
  rm.play(sid, { items: longQueue() });
  await until(() => a.chunks.length > 0);
  a.emit('leave');
  assert.equal(rm.getRoom(sid).state, 'stopped');
  assert.equal(rm.roomOf(a.clientId), sid);
  assert.equal(last(a, 'group/update').payload.playbackState, 'stopped');
  await rm.close();
});

test('switch cycle: playing multi rooms, then other solo players, then own solo room', async () => {
  const rm = await manager();
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((name) => new FakeMember({ name }));
  for (const m of [a, b, c, d]) rm.attach(m);
  const multi = rm.createRoom('Multi', [a.clientId, b.clientId]);
  const cRoom = rm.roomOf(c.clientId);
  const dSolo = rm.roomOf(d.clientId);
  const silent = rm.createRoom('Silent', []);
  rm.play(multi, { items: longQueue() });
  rm.play(cRoom, { items: longQueue() });
  assert.ok(silent);
  const seen = [];
  for (let i = 0; i < 4; i++) {
    cmd(d, 'switch');
    seen.push(rm.roomOf(d.clientId));
  }
  assert.deepEqual(seen, [multi, cRoom, dSolo, multi]);
  const remote = new FakeMember({ name: 'Remote', roles: ['controller'] });
  rm.attach(remote);
  cmd(remote, 'switch');
  cmd(remote, 'switch');
  const r2 = rm.roomOf(remote.clientId);
  cmd(remote, 'switch');
  assert.equal(r2, cRoom);
  assert.equal(rm.roomOf(remote.clientId), multi, 'controller-only clients skip a solo room');
  await rm.close();
});

test('controller commands drive the room queue; unsupported ones are ignored', async () => {
  const rm = await manager();
  const a = new FakeMember({ name: 'A' });
  const id = rm.attach(a);
  cmd(a, 'play');
  assert.equal(rm.getRoom(id).state, 'stopped', 'nothing queued, nothing played');
  rm.play(id, { items: [item(F.long, 'L1', 4000), item(F.long, 'L2', 4000), item(F.a, 'A', 600)] });
  await until(() => a.chunks.length > 0 && rm.getRoom(id).current.meta.title === 'L1');
  cmd(a, 'next');
  await until(() => metadataOf(a).at(-1).title === 'L2');
  assert.equal(last(a, 'stream/clear').type, 'stream/clear');
  assert.equal(rm.getRoom(id).index, 1);
  cmd(a, 'seek', { position_ms: 3000 });
  await until(() => metadataOf(a).at(-1).progress?.track_progress === 3000);
  cmd(a, 'seek', { position_ms: 99_000 });
  assert.equal(metadataOf(a).at(-1).progress.track_progress, 3000, 'seek beyond seek_max_ms is ignored');
  cmd(a, 'previous');
  await until(() => metadataOf(a).at(-1).progress?.track_progress === 0 && metadataOf(a).at(-1).title === 'L2');
  cmd(a, 'previous');
  await until(() => metadataOf(a).at(-1).title === 'L1');
  cmd(a, 'pause');
  assert.equal(rm.getRoom(id).state, 'paused');
  const md = metadataOf(a).at(-1);
  assert.equal(md.progress.playback_speed, 0);
  assert.ok(md.timestamp <= serverNow());
  cmd(a, 'repeat_one');
  cmd(a, 'shuffle');
  const ctl = controllerOf(a);
  assert.equal(ctl.repeat, 'one');
  assert.equal(ctl.shuffle, true);
  assert.equal(ctl.seek_max_ms, 4000);
  assert.equal(rm.getRoom(id).order[0], 0, 'the current track stays first when shuffling');
  cmd(a, 'unshuffle');
  assert.deepEqual(rm.getRoom(id).order, [0, 1, 2]);
  cmd(a, 'volume', { volume: 70 });
  assert.deepEqual(last(a, 'server/command').payload.player, { command: 'volume', volume: 70 });
  cmd(a, 'bogus');
  cmd(a, 'play');
  assert.equal(rm.getRoom(id).state, 'playing');
  cmd(a, 'stop');
  assert.equal(rm.getRoom(id).state, 'stopped');
  assert.equal(rm.getRoom(id).positionMs, 0);
  await rm.close();
});

test('queue: add, repeat all wraps, shuffle keeps every item', async () => {
  let r = 0;
  const random = () => {
    r = (r * 7 + 3) % 10;
    return r / 10;
  };
  const rm = await manager({ random });
  const a = new FakeMember();
  const id = rm.attach(a);
  rm.play(id, { items: [item(F.a, 'A', 600)] });
  rm.add(id, [item(F.b, 'B', 500), item(F.a, 'C', 600)]);
  assert.equal(rm.getRoom(id).queueLength, 3);
  rm.setRepeat(id, 'all');
  assert.throws(() => rm.setRepeat(id, 'sometimes'), RoomError);
  await until(() => metadataOf(a).filter((x) => x.title).map((x) => x.title).join('').startsWith('ABCA'), { timeoutMs: 4500 });
  rm.setShuffle(id, true);
  assert.deepEqual([...rm.getRoom(id).order].sort(), [0, 1, 2]);
  await rm.close();
});

test('artwork and colour roles: current image on stream start, paced parts, one transfer in flight', async () => {
  const image = Buffer.alloc(150_000, 7);
  const rm = await manager({
    artworkFor: (it, spec) => (spec.source === 'album' ? image : null),
    colorFor: () => ({ primary: [10, 20, 30] }),
  });
  const a = new FakeMember({
    roles: ['player', 'metadata', 'artwork', 'color'],
    artwork: { channels: [{ source: 'album', format: 'jpeg', width: 300, height: 300 }, { source: 'none' }] },
  });
  const id = rm.attach(a);
  assert.deepEqual(last(a, 'stream/start').payload.artwork.channels, [{ source: 'album', format: 'jpeg', width: 300, height: 300 }]);
  rm.play(id, { items: queue() });
  await until(() => {
    const parts = a.binary.filter((c) => c.payload.kind === 'part');
    return parts.reduce((s, c) => s + c.payload.data.length, 0) >= image.length * 2;
  });
  let inFlight = null;
  let got = 0;
  for (const { payload: p } of a.binary) {
    if (p.kind === 'announce') {
      assert.equal(inFlight, null, 'no announce while a transfer is in flight');
      if (p.totalSize) inFlight = { size: p.totalSize };
      got = 0;
    } else if (p.kind === 'part') {
      assert.ok(inFlight);
      got += p.data.length;
      if (got === inFlight.size) inFlight = null;
    } else if (p.kind === 'cancel') {
      inFlight = null;
    }
  }
  const parts = a.binary.filter((c) => c.payload.kind === 'part');
  assert.ok(parts.length >= 6);
  assert.ok(parts.at(-1).at - parts[0].at > 5000, 'parts are paced');
  const colors = a.of('server/state').filter((c) => c.payload.color).map((c) => c.payload.color);
  assert.ok(colors.some((c) => c.primary?.[2] === 30 && Number.isInteger(c.timestamp)));
  a.setState({ roles: { artwork: { channels: [{ source: 'none' }] } } });
  assert.equal(last(a, 'binary').payload.totalSize, 0, 'channel cleared before it goes to none');
  assert.equal(last(a, 'stream/end').payload.roles[0], 'artwork');
  await rm.close();
});

test('rooms, queue and position survive a restart; play resumes the last played track', async () => {
  const d = path.join(dir, 'persist');
  const rm = await manager({ dir: d });
  const a = new FakeMember({ name: 'A' });
  const b = new FakeMember({ name: 'B' });
  rm.attach(a);
  rm.attach(b);
  const id = rm.createRoom('Lounge', [a.clientId, b.clientId]);
  rm.play(id, { items: longQueue() });
  await until(() => a.chunks.length > 0);
  await until(() => serverNow() > a.chunks[0].ts + 400_000);
  rm.pause(id);
  const saved = rm.getRoom(id).positionMs;
  assert.ok(saved >= 350, `paused at ${saved}`);
  await rm.close();
  const raw = JSON.parse(await fsp.readFile(path.join(d, 'rooms.json'), 'utf8'));
  assert.equal(raw.rooms.find((r) => r.id === id).name, 'Lounge');

  const rm2 = await manager({ dir: d });
  const view = rm2.getRoom(id);
  assert.equal(view.name, 'Lounge');
  assert.equal(view.state, 'paused');
  assert.equal(view.positionMs, saved);
  assert.deepEqual(view.members.map((m) => [m.clientId, m.connected]), [[a.clientId, false], [b.clientId, false]]);
  const a2 = new FakeMember({ clientId: a.clientId, name: 'A' });
  assert.equal(rm2.attach(a2), id);
  rm2.play(id);
  await until(() => metadataOf(a2).some((m) => m.progress?.playback_speed === 1000));
  const md = metadataOf(a2).find((m) => m.progress?.playback_speed === 1000);
  assert.equal(md.title, 'L');
  assert.equal(md.progress.track_progress, saved);
  await rm2.close();
});

test('a speaker that drops mid-stream does not break the room; it rejoins on reconnect', async () => {
  const rm = await manager();
  const a = new FakeMember();
  const b = new FakeMember();
  rm.attach(a);
  rm.attach(b);
  const id = rm.createRoom('Drop', [a.clientId, b.clientId]);
  rm.play(id, { items: longQueue() });
  await until(() => b.chunks.length > 2);
  b.close();
  const n = a.chunks.length;
  await until(() => a.chunks.length > n + 5);
  assert.equal(rm.getRoom(id).members.find((m) => m.clientId === b.clientId).connected, false);
  const b2 = new FakeMember({ clientId: b.clientId });
  b2.playerStateReceived = true;
  rm.attach(b2);
  await until(() => b2.chunks.length > 2);
  assert.equal(b2.of('stream/start')[0].payload.player.codec, 'pcm');
  await rm.close();
});

test('roles granted later (approval) get their state; playback toggles do not resend it', async () => {
  const rm = await manager();
  const a = new FakeMember({ roles: [] });
  rm.attach(a);
  assert.equal(a.of('server/state').length, 0);
  assert.equal(a.of('group/update').length, 1);
  a.roles = ['player', 'controller', 'metadata'];
  a.state.player = { volume: 50, muted: false, outputDelayMs: 0, minBufferMs: 100, requiredLeadTimeMs: 0, supportedCommands: ['volume'] };
  a.emit('activated', {});
  assert.ok(controllerOf(a).supported_commands.includes('volume'));
  const n = a.of('server/state').length;
  a.activate({ activities: ['playback'] });
  assert.equal(a.of('server/state').length, n);
  await rm.close();
});

test('deleting a room sends its speakers back to their own rooms', async () => {
  const rm = await manager();
  const a = new FakeMember({ name: 'A' });
  rm.attach(a);
  const own = rm.roomOf(a.clientId);
  const id = rm.createRoom('Temp', [a.clientId]);
  assert.throws(() => rm.createRoom('', []), RoomError);
  rm.renameRoom(id, 'Temp 2');
  assert.equal(last(a, 'group/update').payload.groupName, 'Temp 2');
  rm.deleteRoom(id);
  assert.equal(rm.roomOf(a.clientId), own);
  assert.throws(() => rm.deleteRoom(own), RoomError);
  assert.throws(() => rm.getRoom(id), RoomError);
  await sleep(0);
  await rm.close();
});

test('pcm and flac members in one room stay on one timeline', async () => {
  const rm = await manager();
  const a = new FakeMember({ formats: [PCM48] });
  const b = new FakeMember({ formats: [FLAC44] });
  rm.attach(a);
  rm.attach(b);
  const id = rm.createRoom('Mixed', [a.clientId, b.clientId]);
  rm.play(id, { items: queue() });
  await new Promise((r) => rm.once('ended', r));
  assert.equal(a.chunks[0].ts, b.chunks[0].ts);
  const endA = a.chunks.at(-1).ts + (a.chunks.at(-1).frame.length / 4) * 1e6 / 48000;
  assert.ok(Math.abs(endA - (a.chunks[0].ts + 1_100_000)) < 100);
  await rm.close();
});

// What a client ends up showing: a later update with an earlier-or-equal timestamp replaces a pending one.
const titles = (m) => {
  const md = metadataOf(m).filter((x) => x.title && x.progress?.playback_speed === 1000);
  return md.filter((x, i) => !md.slice(i + 1).some((y) => y.timestamp <= x.timestamp)).map((x) => x.title);
};
const dedupe = (a) => a.filter((x, i) => x !== a[i - 1]);

test('jump keeps the shuffle order; play paused loads without streaming', async () => {
  let r = 0;
  const random = () => {
    r = (r * 7 + 3) % 10;
    return r / 10;
  };
  const rm = await manager({ random });
  const a = new FakeMember();
  const id = rm.attach(a);
  const items = [item(F.long, 'L1', 4000), item(F.long, 'L2', 4000), item(F.long, 'L3', 4000), item(F.a, 'A', 600)];
  rm.play(id, { items, index: 1, positionMs: 500, paused: true });
  let view = rm.getRoom(id);
  assert.equal(view.state, 'paused');
  assert.equal(view.index, 1);
  assert.equal(view.positionMs, 500);
  assert.equal(a.of('stream/start').length, 0, 'paused load sends no stream/start');
  assert.equal(a.of('server/activate').length, 0);
  assert.deepEqual(metadataOf(a).at(-1).progress, { track_progress: 500, track_duration: 4000, playback_speed: 0 });
  assert.equal(metadataOf(a).at(-1).title, 'L2');

  rm.setShuffle(id, true);
  const { order, queueVersion } = rm.getRoom(id);
  assert.equal(order[0], 1);
  rm.jump(id, 3);
  view = rm.getRoom(id);
  assert.equal(view.state, 'playing');
  assert.equal(view.index, 3);
  assert.deepEqual(view.order, order, 'jump keeps the shuffle order');
  assert.equal(view.queueVersion, queueVersion, 'jump is not a queue change');
  await until(() => a.chunks.length > 0);
  rm.jump(id, 0);
  assert.equal(last(a, 'stream/clear').payload.fromTimestamp, undefined, 'a jump is a plain stream/clear');
  assert.equal(a.of('stream/start').length, 1);
  assert.deepEqual(rm.getRoom(id).order, order);
  await until(() => metadataOf(a).at(-1).title === 'L1');
  assert.throws(() => rm.jump(id, 4), (err) => err instanceof RoomError && err.code === 'invalid');

  const starts = a.of('stream/start').length;
  rm.play(id, { items: queue(), index: 1, positionMs: 100, paused: true });
  assert.equal(last(a, 'stream/end').payload.roles[0], 'player');
  view = rm.getRoom(id);
  assert.equal(view.state, 'paused');
  assert.equal(view.current.meta.title, 'B');
  assert.ok(view.queueVersion > queueVersion);
  await sleep(150);
  assert.equal(a.of('stream/start').length, starts);
  await rm.close();
});

test('play next while playing: the cut is withdrawn with stream/clear from_timestamp, the current track plays on', async () => {
  const rm = await manager();
  const a = new FakeMember({ formats: [PCM48] });
  const b = new FakeMember({ formats: [FLAC44] });
  rm.attach(a);
  rm.attach(b);
  const id = rm.createRoom('Next', [a.clientId, b.clientId]);
  rm.play(id, { items: [item(F.mid, 'M', 1500), item(F.a, 'A', 600)] });
  await until(() => a.chunks.length > 0 && serverNow() > a.chunks[0].ts + 200_000);
  assert.ok(serverNow() + 400_000 < a.chunks[0].ts + 1_500_000, 'still well inside the first track');
  const sentPastCut = a.chunks.some((c) => c.ts >= a.chunks[0].ts + 1_500_000);
  assert.ok(sentPastCut, 'the next track was already sent ahead');
  const version = rm.getRoom(id).queueVersion;
  const mark = new Map([a, b].map((m) => [m, m.calls.length]));
  const ended = new Promise((res) => rm.once('ended', res));
  assert.equal(rm.add(id, [item(F.b, 'B', 500)], { next: true }), 3);
  const view = rm.getRoom(id);
  assert.deepEqual(view.queue.map((q) => q.meta.title), ['M', 'B', 'A']);
  assert.equal(view.index, 0);
  assert.equal(view.queueVersion, version + 1);
  for (const m of [a, b]) {
    const before = mark.get(m);
    const after = m.calls.slice(before);
    const clears = after.filter((c) => c.type === 'stream/clear');
    const pastCut = m.calls.slice(0, before).some((c) => c.type === 'chunk' && c.ts + 50_000 > m.chunks[0].ts + 1_500_000);
    assert.equal(clears.length, pastCut ? 1 : 0, 'stream/clear only when audio past the cut was sent');
    if (!pastCut) continue;
    const from = clears[0].payload.fromTimestamp;
    assert.ok(from > clears[0].at + 100_000, 'from_timestamp keeps the lead');
    assert.ok(from <= m.chunks[0].ts + 1_500_000 && from > m.chunks[0].ts + 1_300_000, 'the cut is at the first track boundary');
    assert.ok(!after.some((c) => c.type === 'stream/start' || c.type === 'stream/end'), 'no restart');
    await until(() => m.calls.slice(before).some((c) => c.type === 'chunk'));
    const next = m.calls.slice(before).find((c) => c.type === 'chunk');
    assert.ok(next.ts >= from && next.ts - from < 100, `first chunk after the clear starts at from_timestamp (${next.ts - from})`);
  }
  await ended;
  const split = a.calls[mark.get(a)].at;
  const kept = a.chunks.filter((c) => c.at < split && c.ts < last(a, 'stream/clear').payload.fromTimestamp);
  const timeline = [...kept, ...a.chunks.filter((c) => c.at >= split)];
  for (let i = 1; i < timeline.length; i++) {
    assert.equal(timeline[i].ts, timeline[i - 1].ts + pcmDurationUs(timeline[i - 1], PCM48), `gapless at chunk ${i}`);
  }
  assert.equal(timeline.at(-1).ts + pcmDurationUs(timeline.at(-1), PCM48) - timeline[0].ts, 2_600_000);
  assert.deepEqual(dedupe(titles(a)), ['M', 'B', 'A']);
  const md = metadataOf(a).filter((x) => x.title === 'B' && x.progress?.playback_speed === 1000);
  assert.equal(md.at(-1).timestamp, a.chunks[0].ts + 1_500_000);
  await rm.close();
});

test('play next before the decode reached the boundary takes effect there without any stream command', async () => {
  const rm = await manager({ streamOptions: { readAheadMs: 300, lowWaterMs: 200 } });
  const a = new FakeMember({ formats: [PCM48] });
  const id = rm.attach(a);
  rm.setShuffle(id, true);
  rm.play(id, { items: [item(F.mid, 'M', 1500), item(F.a, 'A', 600)] });
  await until(() => a.chunks.length > 0);
  const ended = new Promise((res) => rm.once('ended', res));
  rm.add(id, [item(F.b, 'B', 500), item(F.a, 'C', 600)], { next: true });
  const { order, queue: q } = rm.getRoom(id);
  assert.deepEqual(order.slice(0, 3).map((i) => q[i].meta.title), ['M', 'B', 'C'], 'inserted after the current track in shuffle order');
  await ended;
  assert.equal(a.of('stream/clear').length, 0);
  assert.equal(a.of('stream/start').length, 1);
  assert.deepEqual(dedupe(titles(a)), ['M', 'B', 'C', 'A']);
  const t0 = a.chunks[0].ts;
  const end = a.chunks.at(-1).ts + pcmDurationUs(a.chunks.at(-1), PCM48);
  assert.equal(end - t0, 3_200_000);
  await rm.close();
});

test('appending to a queue whose decode already ended still plays the new track', async () => {
  const rm = await manager();
  const a = new FakeMember();
  const id = rm.attach(a);
  rm.play(id, { items: [item(F.mid, 'M', 1500)] });
  await until(() => a.chunks.length > 0 && serverNow() > a.chunks[0].ts + 100_000);
  const ended = new Promise((res) => rm.once('ended', res));
  rm.add(id, [item(F.b, 'B', 500)]);
  await ended;
  assert.deepEqual(dedupe(titles(a)), ['M', 'B']);
  await rm.close();
});

test('forget drops the speaker\'s solo room and its seat in named rooms', async () => {
  const d = path.join(dir, 'forget');
  const rm = await manager({ dir: d });
  const a = new FakeMember({ name: 'A' });
  const b = new FakeMember({ name: 'B' });
  const soloA = rm.attach(a);
  const soloB = rm.attach(b);
  const id = rm.createRoom('Pair', [a.clientId, b.clientId]);
  b.close();
  assert.equal(rm.forget(b.clientId), true);
  assert.deepEqual(rm.getRoom(id).members.map((m) => m.clientId), [a.clientId]);
  assert.throws(() => rm.getRoom(soloB), RoomError);
  assert.equal(rm.roomOf(b.clientId), null);
  assert.equal(rm.forget(b.clientId), false);

  assert.equal(rm.forget(a.clientId), true);
  assert.deepEqual(rm.getRoom(id).members, []);
  assert.throws(() => rm.getRoom(soloA), RoomError);
  const fresh = rm.roomOf(a.clientId);
  assert.ok(fresh && fresh !== soloA, 'a connected speaker gets a new solo room');
  assert.equal(last(a, 'group/update').payload.groupId, fresh);
  await rm.flush();
  const raw = JSON.parse(await fsp.readFile(path.join(d, 'rooms.json'), 'utf8'));
  assert.deepEqual(raw.rooms.map((r) => r.id).sort(), [id, fresh].sort());
  assert.deepEqual(Object.keys(raw.clients), [a.clientId]);
  await rm.close();
});

test('service stop is bounded: a playing room, a speaker that never answers and a silent socket', { timeout: 15_000 }, async () => {
  const quiet = { info() {}, warn() {}, debug() {}, error() {} };
  const sv = new RoomsService({ dataDir: path.join(dir, 'svc'), logger: quiet, roomOptions: { ffmpeg: FFMPEG } });
  await sv.apply({ enabled: true, name: 'Stop test', languages: ['en'], bind: '127.0.0.1', port: 0, path: '/sendspin', discovery: false });
  assert.ok(sv.running);
  const port = sv.server.port;
  const speaker = new RoomClient({ name: 'Mute' });
  await speaker.dial(`ws://127.0.0.1:${port}/sendspin`);
  await speaker.connect();
  await sv.server.approve(speaker.clientId);
  await until(() => sv.rooms.getRoom(sv.rooms.roomOf(speaker.clientId)).members[0]?.player);
  const id = sv.rooms.roomOf(speaker.clientId);
  sv.rooms.play(id, { items: [item(F.long, 'L', 4000)] });
  await speaker.until(() => speaker.audio > 3);
  speaker.ws._socket.pause();
  const idle = net.connect(port, '127.0.0.1');
  idle.on('error', () => {});
  await new Promise((res) => idle.once('connect', res));
  const t = Date.now();
  await sv.stop();
  const took = Date.now() - t;
  assert.ok(took < STOP_TIMEOUT_MS, `stop took ${took} ms`);
  assert.equal(sv.running, false);
  speaker.close();
  idle.destroy();
});

test('a room whose only member shows metadata still advances, sends metadata and ends', async () => {
  const rm = await manager();
  const d = new FakeMember({ name: 'Display', roles: ['metadata', 'controller', 'artwork'] });
  rm.attach(d);
  const id = rm.listRooms()[0].id;
  const ended = new Promise((r) => rm.once('ended', r));
  rm.play(id, { items: queue() });
  await until(() => metadataOf(d).some((x) => x.title === 'A'));
  await sleep(300);
  assert.ok(rm.getRoom(id).positionMs > 0, 'position advances');
  await ended;
  const md = metadataOf(d).filter((x) => x.title);
  assert.deepEqual(md.map((x) => x.title).slice(0, 2), ['A', 'B']);
  assert.equal(md[1].timestamp - md[0].timestamp, 600_000);
  assert.equal(rm.getRoom(id).state, 'stopped');
  await rm.close();
});
