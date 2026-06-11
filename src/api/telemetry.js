/**
 * Anonymous instance ping — sends { id, version, platform, runtime } to the
 * Velvet Cloudflare Worker once at boot (60 s delay) then every 24 h.
 *
 * The instance UUID is generated once and persisted in save/conf/instance-id.
 * Set  "telemetry": false  in the JSON config to opt out completely.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as config from '../state/config.js';

// Detect whether we're running inside a Docker container.
// Docker always creates /.dockerenv on container startup.
function _detectRuntime() {
  try { fs.accessSync('/.dockerenv'); return 'docker'; } catch { /* not in docker */ }
  return 'node';
}

const RUNTIME = _detectRuntime();

const PING_URL   = 'https://velvet.aroundmyroom.com/ping';
const INTERVAL   = 24 * 60 * 60 * 1000; // 24 h
const BOOT_DELAY = 60 * 1000;            // 60 s

let _timer = null;

function _idFile() {
  return path.join(config.program.storage.dbDirectory, '..', 'conf', 'instance-id');
}

async function _getOrCreateId() {
  const file = _idFile();
  try {
    const id = (await fsp.readFile(file, 'utf8')).trim();
    if (/^[a-f0-9-]{36}$/.test(id)) return id;
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  const id = crypto.randomUUID();
  try { await fsp.writeFile(file, id, 'utf8'); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  return id;
}

async function _ping(version) {
  if (config.program.telemetry === false) return;
  try {
    const id = await _getOrCreateId();
    const body = JSON.stringify({ id, version, platform: os.platform(), runtime: RUNTIME });
    await fetch(PING_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // silently ignore — network down, worker unavailable, etc.
  }
}

export function setup(version) {
  if (config.program.telemetry === false) return;
  setTimeout(() => {
    _ping(version).catch(() => {});
    _timer = setInterval(() => _ping(version).catch(() => {}), INTERVAL);
  }, BOOT_DELAY);
}
