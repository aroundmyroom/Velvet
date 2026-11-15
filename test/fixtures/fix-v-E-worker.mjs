import { workerData, parentPort } from 'node:worker_threads';
import { sleep, stopRequested, dbWriteWithRetry } from '../../src/util/worker-helpers.mjs';

const { mode = 'normal' } = workerData || {};

parentPort.postMessage({ type: 'ready', mode });

if (mode === 'fatal') {
  parentPort.postMessage({ type: 'fatal', message: 'Invalid API key' });
} else if (mode === 'error') {
  parentPort.postMessage({ type: 'error', message: 'boom' });
} else {
  let n = 0;
  while (!stopRequested()) {
    await dbWriteWithRetry(() => { n++; parentPort.postMessage({ type: 'write', n }); });
    await sleep(10);
  }
  parentPort.postMessage({ type: 'stopped' });
}
