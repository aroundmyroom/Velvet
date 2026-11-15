import winston from 'winston';

export const PHASE = Object.freeze({ SERVICES: 0, HTTP: 1, DB: 2 });

const HOOK_TIMEOUT_MS = 4_000;
const SIGNALS = ['SIGTERM', 'SIGINT'];

const hooks = new Map();
let installed = false;
let running = null;

export function onShutdown(name, phase, fn) {
  hooks.set(name, { phase, fn });
}

function withTimeout(name, promise) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      winston.warn(`[shutdown] ${name} did not finish within ${HOOK_TIMEOUT_MS} ms`);
      resolve();
    }, HOOK_TIMEOUT_MS);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function runShutdown() {
  running ??= (async () => {
    const phases = [...new Set([...hooks.values()].map((h) => h.phase))].sort((a, b) => a - b);
    for (const phase of phases) {
      const current = [...hooks].filter(([, h]) => h.phase === phase);
      await Promise.all(current.map(([name, h]) => withTimeout(name, Promise.resolve().then(h.fn)).catch((err) => {
        winston.error(`[shutdown] ${name} failed`, { stack: err });
      })));
    }
  })();
  return running;
}

function onSignal(signal) {
  for (const s of SIGNALS) process.off(s, onSignal);
  winston.info(`[shutdown] ${signal} received`);
  runShutdown().finally(() => process.kill(process.pid, signal));
}

export function installSignalHandlers() {
  if (installed) return;
  installed = true;
  for (const s of SIGNALS) process.on(s, onSignal);
}
