/**
 * bg-task-broker.js — Background DB-writing task broker
 *
 * Centralises scheduling of all background tasks that write to the database.
 * Guarantees:
 *   1. Only ONE task runs at a time (serialised queue).
 *   2. No task starts while a scan is in progress.
 *   3. Tasks deferred by a scan are replayed automatically when the scan ends
 *      (no silent drops).
 *
 * Tasks are deduplicated by key: submitting the same key while it is already
 * pending replaces the pending entry — the latest submission wins.  This means
 * rapid repeated triggers (e.g. multiple play events arriving in quick
 * succession) collapse into a single execution.
 *
 * Usage:
 *   import * as broker from '../state/bg-task-broker.js';
 *
 *   broker.submit('my-task', 'Human label', async () => { … });
 *
 * The fn MUST return a Promise (or be async).  The broker awaits it before
 * starting the next task.  Errors are caught and logged — they do not crash
 * the server or stall the queue.
 */

import winston from 'winston';
import { isScanRunning, onScanEnd } from './scan-lock.js';

// Ordered pending queue (Map preserves insertion order, key = dedup handle)
const _queue = new Map(); // key → { label, fn }

let _busy = false;

// Set to true when we've registered an onScanEnd callback so we only
// register one at a time, avoiding redundant firings.
let _waitingForScan = false;

/**
 * Submit a background task to the broker.
 *
 * @param {string}   key   Unique task identifier (deduplication key).
 * @param {string}   label Human-readable label used in log messages.
 * @param {Function} fn    Async task function — must return a Promise.
 */
export function submit(key, label, fn) {
  _queue.set(key, { label, fn });
  _tryDrain();
}

/** How many tasks are currently pending (not counting the running one). */
export function pendingCount() {
  return _queue.size;
}

/** True while the broker is executing a task. */
export function isBusy() {
  return _busy;
}

// ── Internal ─────────────────────────────────────────────────────────────────

function _tryDrain() {
  if (_busy || _queue.size === 0) return;

  if (isScanRunning()) {
    // Register a single post-scan wakeup — avoid stacking multiple callbacks.
    if (!_waitingForScan) {
      _waitingForScan = true;
      winston.info(`[bg-broker] Scan in progress — deferring ${_queue.size} pending task(s) until scan ends`);
      onScanEnd(() => {
        _waitingForScan = false;
        _tryDrain();
      });
    }
    return;
  }

  _busy = true;
  const [key, { label, fn }] = _queue.entries().next().value;
  _queue.delete(key);

  winston.info(`[bg-broker] Starting task "${label}" (${_queue.size} remaining in queue)`);

  Promise.resolve()
    .then(fn)
    .then(() => {
      winston.info(`[bg-broker] Task "${label}" finished`);
      _busy = false;
      _tryDrain();
    })
    .catch(err => {
      winston.error(`[bg-broker] Task "${label}" failed: ${err.message}`);
      _busy = false;
      _tryDrain();
    });
}
