/**
 * scan-lock.js — global scan semaphore
 *
 * What is guaranteed while a scan runs:
 *   - Worker threads hosted by util/worker-controller.js (AcoustID, Tag
 *     Workshop, ReplayGain, BPM, genre enricher) receive {type:'pause'} when
 *     the first scan starts and {type:'resume'} when the last one ends; their
 *     DB writes go through worker-helpers dbWriteWithRetry(), which waits
 *     while paused. Their starts are deferred until the scan ends; a worker
 *     restarted after a crash during a scan starts paused.
 *   - Tasks submitted to state/bg-task-broker.js do not start during a scan.
 * Anything else that writes to the DB must check isScanRunning() itself.
 */

let _running = 0;  // count of active scans (multiple vpaths may scan concurrently)
const _callbacks = [];
const _persistentCallbacks = []; // fire after EVERY scan completion, not just once
const _startCallbacks = [];     // fire whenever the FIRST of a batch of scans begins

/** Returns true while at least one scan is in progress. */
export function isScanRunning() {
  return _running > 0;
}

/**
 * Register a persistent callback that fires every time scans start (counter
 * goes from 0 → 1).  The callback receives no arguments.
 */
export function onEveryScanStart(cb) {
  _startCallbacks.push(cb);
}

/**
 * Called by task-queue when a scan starts (once per vpath).
 * Increments the active-scan counter.
 */
export function scanStarted() {
  const wasIdle = _running === 0;
  _running++;
  if (wasIdle) {
    for (const cb of _startCallbacks) {
      try { setImmediate(cb); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }
  }
}

/**
 * Called by task-queue when a scan finishes (once per vpath, regardless of outcome).
 * Decrements counter. When it reaches 0, fires all deferred callbacks.
 */
export function scanEnded() {
  if (_running > 0) _running--;
  if (_running === 0) {
    if (_callbacks.length > 0) {
      const cbs = _callbacks.splice(0);
      for (const cb of cbs) {
        try { cb(); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      }
    }
    for (const cb of _persistentCallbacks) {
      try { setImmediate(cb); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }
  }
}

/**
 * Register a one-shot callback to fire when all active scans finish.
 * If no scan is running, the callback fires on the next event-loop tick.
 *
 * @param {Function} cb
 */
export function onScanEnd(cb) {
  if (_running === 0) {
    setImmediate(cb);
  } else {
    _callbacks.push(cb);
  }
}

/**
 * Register a persistent callback that fires after EVERY scan completion.
 * Unlike onScanEnd, this is never removed — it fires each time a scan ends.
 *
 * @param {Function} cb
 */
export function onEveryScanEnd(cb) {
  _persistentCallbacks.push(cb);
}
