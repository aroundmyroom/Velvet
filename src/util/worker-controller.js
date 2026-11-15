import { Worker } from 'node:worker_threads';
import winston from 'winston';
import * as config from '../state/config.js';
import { isScanRunning, onScanEnd, onEveryScanStart, onEveryScanEnd } from '../state/scan-lock.js';
import { mbAcquire } from './mb-client.mjs';

const POST_SCAN_STAGGER_MS = 5_000;
const CRASH_RESTART_MS = 10_000;

const _all = new Set();
const _postScan = [];

onEveryScanStart(() => { for (const c of _all) c.post({ type: 'pause' }); });
onEveryScanEnd(() => {
  for (const c of _all) c.post({ type: 'resume' });
  _postScan.forEach((c, i) => {
    setTimeout(() => c.autoStart('Post-scan auto-start'), i * POST_SCAN_STAGGER_MS).unref();
  });
});

// Writes one key into the config file and the live config.
export async function persistConfigValue(apply) {
  try {
    await config.updateConfigFile(apply);
    apply(config.program);
  } catch (err) {
    winston.warn(`[workers] Failed to save autostart flag: ${err.message}`);
  }
}

// Missing flag = allowed, so installs that never pressed Stop keep auto-starting.
function configAutostartFlag(key) {
  return {
    get: () => config.program?.workerAutostart?.[key] !== false,
    set: value => persistConfigValue(cfg => {
      cfg.workerAutostart = { ...cfg.workerAutostart, [key]: value };
    }),
  };
}

export function createWorkerController({
  name,
  path: workerPath,
  workerData = () => ({}),
  queued = null,
  autoStartCap = 500,
  stopTimeoutMs = 30_000,
  autostartFlag = configAutostartFlag(name),
  beforeStart = null,
  onMessage = null,
  onSpawn = null,
  onReset = null,
  autoStartAfterEveryScan = false,
  restartAfterCrash = () => false,
  crashRestartMs = CRASH_RESTART_MS,
}) {
  let worker = null;
  let stopping = false;
  let pendingStart = false;
  let startedAt = null;
  let stopTimer = null;

  function finish(w, crashed) {
    if (worker !== w) return;
    clearTimeout(stopTimer);
    worker = null;
    stopping = false;
    startedAt = null;
    onReset?.();
    w.terminate();
    if (crashed && restartAfterCrash()) {
      winston.info(`[${name}] Restarting worker in ${crashRestartMs / 1000}s after error...`);
      setTimeout(() => { if (!worker) launch(); }, crashRestartMs).unref();
    }
  }

  function spawn() {
    // A worker spawned while a scan runs (crash restart) must start paused; a
    // message would arrive only after its first DB write.
    const w = new Worker(workerPath, { workerData: { ...workerData(), startPaused: isScanRunning() } });
    worker = w;
    stopping = false;
    startedAt = Date.now();
    onSpawn?.();

    w.on('message', msg => {
      if (!msg) return;
      if (msg.type === 'mb-token') {
        mbAcquire().then(() => { if (worker === w) w.postMessage({ type: 'mb-token', id: msg.id }); });
        return;
      }
      onMessage?.(msg);
      if (msg.type === 'log') {
        winston[msg.level === 'warn' || msg.level === 'debug' ? msg.level : 'info'](msg.message);
      } else if (msg.type === 'stopped') {
        winston.info(`[${name}] Worker stopped`);
        finish(w, false);
      } else if (msg.type === 'error') {
        winston.error(`[${name}] Worker error: ${msg.message}`);
        finish(w, true);
      } else if (msg.type === 'fatal') {
        // A configuration error: retrying cannot help, so stay off until an admin starts again.
        winston.error(`[${name}] Worker stopped: ${msg.message}`);
        autostartFlag.set(false);
        finish(w, false);
      }
    });
    w.on('error', err => {
      winston.error(`[${name}] Worker thread error: ${err.message}`);
      finish(w, true);
    });
    w.on('exit', code => {
      if (worker !== w) return;
      if (code !== 0) winston.warn(`[${name}] Worker exited with code ${code}`);
      finish(w, code !== 0);
    });
    winston.info(`[${name}] Worker started`);
  }

  async function launch() {
    if (beforeStart && (await beforeStart()) === false) return false;
    if (!worker) spawn();
    return true;
  }

  const ctl = {
    name,
    get running() { return worker !== null; },
    get stopping() { return stopping; },
    get pendingStart() { return pendingStart && worker === null; },
    get startedAt() { return startedAt; },

    post(msg) { worker?.postMessage(msg); },

    // Admin start: 'already_running' | 'pending' | 'started' | 'unavailable'
    // remember=false for starts that only drain a small explicit request
    // (e.g. "scan these files") and should not re-enable auto-start.
    async start({ remember = true } = {}) {
      if (worker) return 'already_running';
      if (isScanRunning()) {
        pendingStart = true;
        if (remember) autostartFlag.set(true);
        onScanEnd(() => {
          if (!pendingStart || worker) return;
          pendingStart = false;
          launch().catch(e => winston.warn(`[${name}] Deferred start failed: ${e?.message ?? e}`));
        });
        return 'pending';
      }
      if (!(await launch())) return 'unavailable';
      if (remember) autostartFlag.set(true);
      return 'started';
    },

    // Admin stop: 'pending_cancelled' | 'not_running' | 'already_stopping' | 'stopping'
    stop() {
      if (pendingStart && !worker) {
        pendingStart = false;
        autostartFlag.set(false);
        return 'pending_cancelled';
      }
      if (!worker) return 'not_running';
      if (stopping) return 'already_stopping';
      stopping = true;
      autostartFlag.set(false);
      worker.postMessage({ type: 'stop' });
      const w = worker;
      stopTimer = setTimeout(() => {
        winston.warn(`[${name}] Worker did not stop in ${stopTimeoutMs / 1000} s — force-terminating`);
        finish(w, false);
      }, stopTimeoutMs);
      stopTimer.unref();
      return 'stopping';
    },

    async autoStart(reason = 'Auto-started', { bypassCap = false } = {}) {
      try {
        if (worker || pendingStart || !autostartFlag.get()) return false;
        if (isScanRunning()) {
          onScanEnd(() => ctl.autoStart(reason, { bypassCap }));
          return false;
        }
        const n = queued ? queued() : 0;
        if (n <= 0) return false;
        if (!bypassCap && n >= autoStartCap) {
          winston.info(`[${name}] Auto-start skipped: ${n} queued — backlog too large, start from Admin`);
          return false;
        }
        const ok = await launch();
        if (ok) winston.info(`[${name}] ${reason}: ${n} queued`);
        return ok;
      } catch (e) {
        winston.warn(`[${name}] Auto-start check failed: ${e?.message ?? e}`);
        return false;
      }
    },
  };

  _all.add(ctl);
  if (autoStartAfterEveryScan) _postScan.push(ctl);
  return ctl;
}
