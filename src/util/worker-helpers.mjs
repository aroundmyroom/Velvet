import { parentPort, workerData } from 'node:worker_threads';

const LOCKED_RE = /database is locked|SQLITE_BUSY/;
const DB_RETRY_ATTEMPTS = 60;
const DB_RETRY_DELAY_MS = 3_000;

let _stopRequested = false;
let _paused = workerData?.startPaused === true;
let _wakers = [];

function _wakeAll() {
  const w = _wakers;
  _wakers = [];
  for (const fn of w) fn();
}

parentPort.on('message', msg => {
  if (msg?.type === 'stop') { _stopRequested = true; _wakeAll(); }
  else if (msg?.type === 'pause') _paused = true;
  else if (msg?.type === 'resume') { _paused = false; _wakeAll(); }
});

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function stopRequested() { return _stopRequested; }

export function requestStop() { _stopRequested = true; _wakeAll(); }

// Sleeps up to ms, but returns as soon as a stop or resume arrives.
export function idle(ms) {
  if (_stopRequested) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { _wakers = _wakers.filter(fn => fn !== done); resolve(); }, ms);
    _wakers.push(done);
  });
}

// The host posts {type:'pause'} when a library scan starts and {type:'resume'}
// when it ends; no worker writes to the DB in between.
async function waitWhilePaused() {
  while (_paused && !_stopRequested) await new Promise(r => _wakers.push(r));
}

export async function dbWriteWithRetry(fn) {
  await waitWhilePaused();
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (!LOCKED_RE.test(err?.message ?? '') || i >= DB_RETRY_ATTEMPTS - 1 || _stopRequested) throw err;
      await sleep(DB_RETRY_DELAY_MS);
      await waitWhilePaused();
    }
  }
}

// Queue loop shared by the MusicBrainz workers: clear rows left 'pending' by an interrupted run,
// then process batches until stopped, reporting status after each batch.
export async function runBatchQueue({ resetPending, getQueue, getStats, batchSize, idleWaitMs, processFile }) {
  await dbWriteWithRetry(() => resetPending.run());
  parentPort.postMessage({ type: 'ready' });
  while (!stopRequested()) {
    const batch = getQueue.all(batchSize);
    if (batch.length === 0) {
      parentPort.postMessage({ type: 'status', stats: getStats.get(), idle: true });
      await idle(idleWaitMs);
      continue;
    }
    for (const row of batch) {
      if (stopRequested()) break;
      await processFile(row);
    }
    parentPort.postMessage({ type: 'status', stats: getStats.get(), idle: false });
  }
  parentPort.postMessage({ type: 'stopped', stats: getStats.get() });
}

export async function runWithLockRetry(run, label, delayMs = 60_000) {
  for (;;) {
    try {
      return await run();
    } catch (err) {
      if (_stopRequested) {
        parentPort.postMessage({ type: 'stopped' });
        return;
      }
      if (!LOCKED_RE.test(err?.message ?? '')) {
        parentPort.postMessage({ type: 'error', message: err.message });
        return;
      }
      parentPort.postMessage({ type: 'log', message: `[${label}] DB locked — waiting ${delayMs / 1000} s then retrying` });
      await idle(delayMs);
    }
  }
}
