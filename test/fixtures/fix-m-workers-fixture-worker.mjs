import { workerData, parentPort } from 'node:worker_threads';
import { sleep, stopRequested, dbWriteWithRetry } from '../../src/util/worker-helpers.mjs';
import { mbAcquire } from '../../src/util/mb-client.mjs';

const { mode = 'normal', tokens = 0 } = workerData || {};

parentPort.postMessage({ type: 'ready' });

if (mode === 'hung') {
  setInterval(() => {}, 1000);
} else if (mode === 'mb') {
  for (let i = 0; i < tokens; i++) {
    await mbAcquire();
    parentPort.postMessage({ type: 'granted', at: Date.now() });
  }
  parentPort.postMessage({ type: 'stopped' });
} else {
  let n = 0;
  while (!stopRequested()) {
    await dbWriteWithRetry(() => { n++; parentPort.postMessage({ type: 'write', n }); });
    await sleep(10);
  }
  parentPort.postMessage({ type: 'stopped' });
}
