/**
 * Spawns an mStream server in a child process for integration tests.
 *
 * Each test run gets a fresh temp directory (config, DB, logs, image cache)
 * and a free TCP port — so tests don't collide with a dev server running on
 * the default 3000, and don't leave state behind between runs.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureFixtures } from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForReady(baseUrl, timeoutMs = 30_000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/`);
      if (r.status < 500) { return; }
    } catch (err) { lastErr = err; }
    await sleep(200);
  }
  throw new Error(`server not ready within ${timeoutMs}ms: ${lastErr?.message || 'unknown'}`);
}

async function waitForScanComplete(baseUrl, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/api/v1/db/status`);
      if (r.ok) {
        const j = await r.json();
        if (!j.locked && j.totalFileCount > 0) { return j.totalFileCount; }
      }
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('initial scan did not complete within timeout');
}

/**
 * Start an mStream instance. Returns { baseUrl, port, tmpDir, musicDir,
 * subsonicBaseUrl, subsonicPort, stop }.
 *
 * @param {Object}   opts
 * @param {string}   [opts.dlnaMode='disabled']      DLNA mode
 * @param {string}   [opts.subsonicMode='same-port'] Subsonic API mode
 * @param {number}   [opts.subsonicPort]             Port for separate-port mode
 * @param {boolean}  [opts.waitForScan=true]         Block until scan finishes
 * @param {boolean}  [opts.captureLogs=false]        Pipe stdout/stderr to test process
 * @param {Object[]} [opts.users]                    Users to create after boot
 * @param {Object}   [opts.extraFolders]             Extra library mounts
 * @param {Object}   [opts.extraConfig]              Extra top-level config keys
 */
export async function startServer(opts = {}) {
  const {
    dlnaMode     = 'disabled',
    subsonicMode = 'same-port',
    subsonicPort,
    waitForScan  = true,
    captureLogs  = false,
    users        = [],
    extraFolders = {},
    extraConfig  = {},
  } = opts;

  const musicDir = await ensureFixtures();
  const tmpDir   = await fs.mkdtemp(path.join(os.tmpdir(), 'mstream-test-'));
  const port     = await findFreePort();

  const sPort = subsonicMode === 'separate-port'
    ? (subsonicPort ?? await findFreePort())
    : 3012;

  const config = {
    port,
    address: '127.0.0.1',
    ui: 'velvet',
    dlna: { mode: dlnaMode, name: 'mStream Test' },
    subsonic: { mode: subsonicMode, port: sPort },
    scanOptions: { bootScanEnabled: true, bootScanDelay: 0 },
    folders: {
      testlib: { root: musicDir },
      ...Object.fromEntries(
        Object.entries(extraFolders).map(([name, root]) => [name, { root }])
      ),
    },
    storage: {
      albumArtDirectory:   path.join(tmpDir, 'image-cache'),
      dbDirectory:         path.join(tmpDir, 'db'),
      logsDirectory:       path.join(tmpDir, 'logs'),
      syncConfigDirectory: path.join(tmpDir, 'sync'),
    },
    ...extraConfig,
  };

  const configPath = path.join(tmpDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

  for (const dir of Object.values(config.storage)) {
    await fs.mkdir(dir, { recursive: true });
  }

  const proc = spawn(
    process.execPath,
    ['cli-boot-wrapper.js', '-j', configPath],
    {
      cwd: REPO_ROOT,
      stdio: captureLogs ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    },
  );

  if (!captureLogs) {
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  let exitedEarly = null;
  proc.once('exit', code => { if (!exitedEarly) exitedEarly = `server exited with code ${code}`; });

  try {
    await waitForReady(baseUrl);
  } catch (err) {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw exitedEarly ? new Error(exitedEarly) : err;
  }

  if (waitForScan) {
    await waitForScanComplete(baseUrl);
  }

  // Create users. While there are zero users the server is in public-access
  // mode (admin=true), so the first PUT goes through without a token.
  // Subsequent users require an admin token from the first user.
  let adminToken = null;

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const headers = { 'Content-Type': 'application/json' };
    if (adminToken) headers['x-access-token'] = adminToken;

    const body = {
      username: u.username,
      password: u.password,
      admin:    u.admin ?? (i === 0),
      vpaths:   u.vpaths ?? ['testlib'],
    };
    const r = await fetch(`${baseUrl}/api/v1/admin/users`, {
      method: 'PUT', headers, body: JSON.stringify(body),
    });
    if (!r.ok) {
      const msg = await r.text();
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`failed to create user "${u.username}": ${r.status} ${msg}`);
    }

    // After the first user is created, log in to get a token for subsequent calls.
    if (i === 0) {
      const loginR = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST', headers,
        body: JSON.stringify({ username: u.username, password: u.password }),
      });
      const j = await loginR.json();
      if (j?.token) adminToken = j.token;
    }

    // Set the Subsonic password (separate from the mStream login password).
    // Defaults to the same value as the mStream password for test convenience.
    const spw = u.subsonicPassword ?? u.password;
    const spwHeaders = { 'Content-Type': 'application/json' };
    if (adminToken) spwHeaders['x-access-token'] = adminToken;
    await fetch(`${baseUrl}/api/v1/admin/users/subsonic-password`, {
      method: 'POST', headers: spwHeaders,
      body: JSON.stringify({ username: u.username, password: spw }),
    });
  }

  async function stop() {
    if (proc.exitCode == null && proc.signalCode == null) {
      proc.kill('SIGKILL');
      await new Promise(r => proc.once('exit', r));
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  const subsonicBaseUrl = subsonicMode === 'separate-port'
    ? `http://127.0.0.1:${sPort}`
    : baseUrl;

  return { baseUrl, port, tmpDir, musicDir, subsonicBaseUrl, subsonicPort: sPort, stop };
}
