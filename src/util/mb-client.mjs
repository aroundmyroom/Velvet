import { isMainThread, parentPort } from 'node:worker_threads';

export const MB_USER_AGENT = 'Velvet/1.0 (https://github.com/aroundmyroom/Velvet; admin-contact@music.aroundtheworld.net)';
export const MB_INTERVAL_MS = 1100;

// Grants are serialised and spaced by the actual grant time, so a timer that
// fires early can never shorten the gap below intervalMs.
export function createRateLimiter(intervalMs) {
  let chain = Promise.resolve();
  let last = -Infinity;
  return {
    acquire() {
      const grant = chain.then(async () => {
        for (let wait = last + intervalMs - Date.now(); wait > 0; wait = last + intervalMs - Date.now()) {
          await new Promise(r => setTimeout(r, wait));
        }
        last = Date.now();
        return last;
      });
      chain = grant;
      return grant;
    },
  };
}

// Only the main thread's instance hands out tokens: worker threads ask the
// host (worker-controller) for one, so the budget is shared process-wide.
const mbLimiter =createRateLimiter(MB_INTERVAL_MS);

const _waiting = new Map();
let _seq = 0;
if (!isMainThread) {
  parentPort.on('message', msg => {
    if (msg?.type !== 'mb-token') return;
    _waiting.get(msg.id)?.();
    _waiting.delete(msg.id);
  });
}

export function mbAcquire() {
  if (isMainThread) return mbLimiter.acquire();
  return new Promise(resolve => {
    const id = ++_seq;
    _waiting.set(id, resolve);
    parentPort.postMessage({ type: 'mb-token', id });
  });
}
