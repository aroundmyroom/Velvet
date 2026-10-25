/**
 * "Restore previous queue" in the player's Up Next bar (webapp/app.js).
 * The helpers are evaluated from the app source against a stubbed player.
 *
 * Run with:
 *   node --test test/queue-undo.test.mjs
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../webapp/app.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('// ── Previous-queue undo'), src.indexOf('// ── PLAYER ──'));

const songs = (prefix, n) => Array.from({ length: n }, (_, i) => ({ filepath: `${prefix}/${i + 1}.mp3` }));

function makePlayer() {
  const btn = { style: { display: 'none' }, title: '' };
  const listeners = [];
  const ctx = {
    S: { queue: [], idx: -1, playSource: null },
    audioEl: { currentTime: 0, paused: true, addEventListener: (ev, fn, o) => listeners.push({ ev, once: o?.once }) },
    document: { getElementById: id => (id === 'qp-undo-btn' ? btn : null) },
    t: (k, p) => `${k}${p ? JSON.stringify(p) : ''}`,
    toasts: [],
    _pendingCueSeek: null,
    _qvsVersion: 0,
    played: [],
    calls: { persist: 0, sync: 0, refresh: 0 },
  };
  ctx.toast = m => ctx.toasts.push(m);
  ctx.persistQueue = () => ctx.calls.persist++;
  ctx._syncQueueToDb = () => ctx.calls.sync++;
  ctx.refreshQueueUI = () => ctx.calls.refresh++;
  ctx.Player = {
    playAt(i) { ctx.S.idx = i; ctx.played.push({ i, seek: ctx._pendingCueSeek }); ctx._pendingCueSeek = null; },
    setQueue(list, start) { ctx._snapshotQueueForUndo(list); ctx.S.queue = [...list]; this.playAt(start ?? 0); },
    playSingle(song) { ctx._snapshotQueueForUndo([song]); ctx.S.queue = [song]; this.playAt(0); },
  };
  vm.createContext(ctx);
  // app.js is a classic script, not a module: evaluate the undo helpers from our own source
  // eslint-disable-next-line sonarjs/code-eval
  vm.runInContext(`${block}\nthis._snapshotQueueForUndo = _snapshotQueueForUndo; this._restorePrevQueue = _restorePrevQueue; this.getPrev = () => _prevQueue;`, ctx);
  return { ctx, btn, listeners };
}

describe('Restore previous queue', () => {
  let p;
  beforeEach(() => {
    p = makePlayer();
    p.ctx.S.queue = songs('mix', 10);
    p.ctx.S.idx = 3;
    p.ctx.audioEl.currentTime = 42;
    p.ctx.audioEl.paused = false;
  });

  it('keeps the old queue when an album replaces it, and shows the button', () => {
    p.ctx.Player.setQueue(songs('album', 12), 0);
    assert.equal(p.ctx.getPrev().queue.length, 10);
    assert.equal(p.btn.style.display, '');
    assert.match(p.btn.title, /restorePrevQueueCount.*"count":10/);
  });

  it('a second click in the same album does not overwrite the original queue', () => {
    const album = songs('album', 12);
    p.ctx.Player.setQueue(album, 0);
    p.ctx.Player.setQueue(album, 5);
    assert.equal(p.ctx.getPrev().queue[0].filepath, 'mix/1.mp3');
  });

  it('restores the queue, position and playback point, then hides the button', () => {
    p.ctx.Player.setQueue(songs('album', 12), 0);
    p.ctx._restorePrevQueue();
    assert.equal(p.ctx.S.queue.length, 10);
    assert.equal(p.ctx.S.queue[0].filepath, 'mix/1.mp3');
    assert.deepEqual(p.ctx.played.at(-1), { i: 3, seek: 42 });
    assert.equal(p.ctx.getPrev(), null);
    assert.equal(p.btn.style.display, 'none');
    assert.equal(p.ctx.calls.persist, 1);
    assert.equal(p.ctx.calls.sync, 1);
    assert.equal(p.ctx.toasts.length, 1);
  });

  it('a song that was paused comes back paused', () => {
    p.ctx.audioEl.paused = true;
    p.ctx.Player.setQueue(songs('album', 3), 0);
    p.ctx._restorePrevQueue();
    assert.ok(p.listeners.some(l => l.ev === 'playing' && l.once));
  });

  it('playing a single song is undoable too', () => {
    p.ctx.Player.playSingle({ filepath: 'one/song.mp3' });
    assert.equal(p.ctx.getPrev().queue.length, 10);
  });

  it('there is nothing to undo when the queue was empty', () => {
    p.ctx.S.queue = [];
    p.ctx.S.idx = -1;
    p.ctx.Player.setQueue(songs('album', 3), 0);
    assert.equal(p.ctx.getPrev(), null);
    assert.equal(p.btn.style.display, 'none');
  });

  it('restoring twice does nothing the second time', () => {
    p.ctx.Player.setQueue(songs('album', 3), 0);
    p.ctx._restorePrevQueue();
    const played = p.ctx.played.length;
    p.ctx._restorePrevQueue();
    assert.equal(p.ctx.played.length, played);
  });
});

describe('Restore previous queue is wired into the player', () => {
  it('every queue replacement takes a snapshot first', () => {
    assert.match(src, /setQueue\(songs, start\) \{\n\s+_snapshotQueueForUndo\(songs\);/);
    assert.match(src, /playSingle\(song\) \{\n\s+_snapshotQueueForUndo\(\[song\]\);/);
    assert.match(src, /'qp-clear-btn'\)\.addEventListener\('click', \(\) => \{\n\s+_snapshotQueueForUndo\(null\);/);
  });

  it('the Up Next bar has the button', () => {
    const html = fs.readFileSync(new URL('../webapp/index.html', import.meta.url), 'utf8');
    assert.match(html, /id="qp-undo-btn"/);
    assert.match(src, /getElementById\('qp-undo-btn'\)\.addEventListener\('click', _restorePrevQueue\)/);
  });
});
