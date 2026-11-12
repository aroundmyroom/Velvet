// Manual end-to-end check of a room (scheduler + room manager) against reference players (not part of npm test).
//   node test/manual/sendspin-room-e2e.mjs [--clients 2] [--port 8927]
//   sendspin daemon --name R1 --url ws://127.0.0.1:8927/sendspin --settings-dir /tmp/ss-r1 --unpaired-access true \
//     --log-level DEBUG --disable-mpris --audio-device <null sink, see the plan's reference daemon notes>
//   (and R2 with another settings dir). Plays a two-track queue, seeks once, waits for the end.
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SendspinServer } from '../../src/sendspin/server.js';
import { RoomManager } from '../../src/sendspin/rooms.js';
import { serverNow } from '../../src/sendspin/scheduler.js';

const FFMPEG = process.env.FFMPEG || new URL('../../bin/ffmpeg/ffmpeg', import.meta.url).pathname;
const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : def);
const clients = opt('--clients', 2);
const port = opt('--port', 8927);
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(3)}s`;
const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((l) => [l, (m) => {
  if (l !== 'debug') console.log(`${stamp()} ${l.padEnd(5)} ${m}`);
}]));
const log = (m) => logger.info(`[e2e] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-room-e2e-'));
const tone = (file, freq, seconds) => {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=${freq}:r=44100:d=${seconds}`, '-ac', '2', file]);
  return file;
};
const items = [
  { filepath: 'e2e/a.flac', file: tone(path.join(dir, 'a.flac'), 440, 6), meta: { title: 'Tone A', artist: 'Velvet', durationMs: 6000 } },
  { filepath: 'e2e/b.flac', file: tone(path.join(dir, 'b.flac'), 660, 4), meta: { title: 'Tone B', artist: 'Velvet', durationMs: 4000 } },
];

const server = new SendspinServer({
  dataDir: dir, host: '127.0.0.1', port, name: 'Velvet Rooms e2e', languages: ['en'], logger,
  roles: ['player@v1', 'controller@v1', 'metadata@v1'],
});
await server.start();
const rooms = await RoomManager.open(dir, {
  ffmpeg: FFMPEG, logger, setPlayback: (member, on) => server.setPlayback(member.clientId, on),
});
rooms.on('member-error', (id, cid, err) => log(`member ${cid.slice(0, 8)} dropped: ${err.message}`));
rooms.on('error', (err) => log(`room error: ${err.message}`));
server.on('client', async (conn) => {
  rooms.attach(conn);
  if (!server.isApproved(conn.clientId)) await server.approve(conn.clientId, conn.info.name);
  log(`attached "${conn.info.name}" roles [${conn.activeRoles.join(', ')}]`);
});
server.on('client-removed', (conn) => rooms.detach(conn.clientId));
server.on('state', (conn, s) => log(`${conn.info.name} state available=${s.available} player=${JSON.stringify(s.player)}`));
log(`listening on ws://127.0.0.1:${port}/sendspin; waiting for ${clients} player(s)`);

const ready = () => [...server.clients.values()].filter((c) => c.state?.available && c.playerStateReceived && c.activeRoles.length);
const deadline = Date.now() + 60_000;
while (ready().length < clients) {
  if (Date.now() > deadline) throw new Error('players did not show up');
  await sleep(50);
}
const members = ready().slice(0, clients);
const id = rooms.createRoom('E2E Room', members.map((c) => c.clientId));
const ended = new Promise((r) => rooms.once('ended', r));
log(`play 2 tracks on ${members.map((c) => c.info.name).join(' + ')}`);
const playAt = serverNow();
rooms.play(id, { items });
const report = () => {
  const v = rooms.getRoom(id);
  const who = v.members.map((m) => [m.name, m.format?.codec ?? '-', m.format?.sample_rate ?? '', m.streaming ? '' : '(idle)'].join(' '));
  log(`room ${v.state} #${v.index} ${v.positionMs} ms; ${who.join(', ')}`);
};
const timer = setInterval(report, 1000);
await sleep(3000);
log('seek to 1000 ms');
rooms.seek(id, 1000);
let guard;
await Promise.race([ended, new Promise((r) => { guard = setTimeout(() => r(log('TIMEOUT waiting for the end')), 20_000); })]);
clearTimeout(guard);
clearInterval(timer);
report();
log(`done after ${((serverNow() - playAt) / 1e6).toFixed(2)} s of server time (expected ~3 + 5 + 4 + lead)`);
await rooms.close();
await server.stop();
