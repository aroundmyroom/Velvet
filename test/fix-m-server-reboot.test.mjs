import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureFixtures } from './helpers/fixtures.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitFor(url, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(url)).status < 500) return true; } catch { /* retry */ }
    await sleep(200);
  }
  return false;
}

describe('P037: reboot() closes the localHttpPort listener before re-listening', () => {
  let proc, tmpDir, localPort, logs = '';

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velvet-reboot-'));
    const key = path.join(tmpDir, 'key.pem');
    const cert = path.join(tmpDir, 'cert.pem');
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
    localPort = await freePort();
    const storage = {
      albumArtDirectory: path.join(tmpDir, 'image-cache'),
      dbDirectory:       path.join(tmpDir, 'db'),
      logsDirectory:     path.join(tmpDir, 'logs'),
    };
    for (const d of Object.values(storage)) await fs.mkdir(d, { recursive: true });
    const configPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({
      port: await freePort(),
      address: '127.0.0.1',
      ssl: { key, cert },
      localHttpPort: localPort,
      dlna: { mode: 'disabled' },
      folders: { testlib: { root: await ensureFixtures() } },
      storage,
    }, null, 2));
    proc = spawn(process.execPath, ['cli-boot-wrapper.js', '-j', configPath], {
      cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test' },
    });
    proc.stdout.on('data', c => { logs += c; });
    proc.stderr.on('data', c => { logs += c; });
    assert.ok(await waitFor(`http://127.0.0.1:${localPort}/api/`), 'local HTTP port never came up');
  });

  after(async () => {
    if (proc && proc.exitCode == null && proc.signalCode == null) {
      proc.kill('SIGKILL');
      await new Promise(r => proc.once('exit', r));
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('survives two reboots with the LAN HTTP port still answering', async () => {
    for (const size of ['60MB', '70MB']) {
      const r = await fetch(`http://127.0.0.1:${localPort}/api/v1/admin/config/max-request-size`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify({ maxRequestSize: size }),
      });
      assert.equal(r.status, 200);
      await sleep(1500);
      assert.equal(proc.exitCode, null, `server exited:\n${logs.slice(-2000)}`);
      assert.ok(await waitFor(`http://127.0.0.1:${localPort}/api/`, 10_000), 'local HTTP port did not come back');
    }
    assert.doesNotMatch(logs, /EADDRINUSE/);
  });
});
