import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { restoreRoomsFromImport } from '../src/api/rooms-import.js';

function fakeRooms({ changed = false } = {}) {
  const calls = [];
  return {
    calls,
    stop: () => Promise.resolve(calls.push('stop')),
    applySettings: () => Promise.resolve(calls.push('apply')),
    settingsChanged: () => changed,
  };
}

test('import without sendspin files leaves Rooms running unless its settings changed', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-migrate-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const restore = () => assert.fail('nothing to restore');
  const idle = fakeRooms();
  assert.equal(await restoreRoomsFromImport(path.join(dir, 'sendspin'), { rooms: idle, restore }), false);
  assert.deepEqual(idle.calls, []);
  const changed = fakeRooms({ changed: true });
  await restoreRoomsFromImport(path.join(dir, 'sendspin'), { rooms: changed, restore });
  assert.deepEqual(changed.calls, ['apply']);
});

test('a failing sendspin restore still restarts Rooms', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sendspin-migrate-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.mkdir(path.join(dir, 'sendspin'));
  const rooms = fakeRooms();
  const restore = () => {
    rooms.calls.push('restore');
    return Promise.reject(new Error('disk full'));
  };
  assert.equal(await restoreRoomsFromImport(path.join(dir, 'sendspin'), { rooms, restore }), true);
  assert.deepEqual(rooms.calls, ['stop', 'restore', 'apply']);
});
