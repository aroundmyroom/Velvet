/**
 * rsgain-bootstrap.js
 *
 * Auto-downloads the rsgain static binary on first use.
 * rsgain is the primary measurement tool for ReplayGain 2.0 / EBU R128.
 *
 * Supported platforms:
 *   Linux x64   → complexlogic/rsgain releases on GitHub
 *   All others  → silently unavailable; ffmpeg fallback will be used
 *
 * Binary is placed in bin/rsgain/rsgain (pre-downloaded in Docker image).
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadToBuffer, downloadToFile } from './bootstrap-helpers.js';
import { spawn } from 'node:child_process';
import winston from 'winston';

// Absolute path for tar — avoids PATH-injection (sonarjs/no-os-command-from-path)
const _SYSTEM_TAR = ['/usr/bin/tar', '/bin/tar'].find(p => fs.existsSync(p)) ?? 'tar';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUNDLED_RSGAIN_DIR = path.join(__dirname, '../../bin/rsgain');
const MIN_RSGAIN_MAJOR = 3;

let _initPromise = null;
let _updateTimer = null;
let _available    = false;  // set true once a usable binary is confirmed

// ── Path helpers ──────────────────────────────────────────────────────────────

export function rsgainBin() {
  return path.join(BUNDLED_RSGAIN_DIR, 'rsgain');
}

export function rsgainAvailable() {
  return _available;
}

// ── Platform guard ────────────────────────────────────────────────────────────

function isSupported() {
  return process.platform === 'linux' && process.arch === 'x64';
}

// ── GitHub release lookup ─────────────────────────────────────────────────────

async function fetchLatestRelease() {
  const buf = await downloadToBuffer('https://api.github.com/repos/complexlogic/rsgain/releases/latest', 'velvet-rsgain-bootstrap/1.0');
  const data = JSON.parse(buf.toString('utf8'));
  // tag_name is "v3.7" — strip the leading 'v'
  const tagName = data.tag_name || '';
  const ver = tagName.replace(/^v/, '');
  if (!ver) throw new Error('Could not parse tag_name from GitHub releases API');
  return { tagName, ver };
}

// ── Version check ──────────────────────────────────────────────────────────────

async function getRsgainVersion(binPath) {
  return new Promise(resolve => {
    try {
      // NO_COLOR=1 prevents ANSI escape codes in the version string that would
      // break the version regex (e.g. "\x1b[1;32mrsgain\x1b[0m 3.7")
      const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb' };
      const p = spawn(binPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env });
      let out = '';
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { out += d; });
      p.on('close', () => {
        // Strip any remaining ANSI escape codes just in case
        // eslint-disable-next-line no-control-regex
        const clean = out.replaceAll(/\x1b\[[0-9;]*m/g, '');
        // "rsgain 3.7" or "rsgain v3.7" — capture full version like "3.7"
        const m = /rsgain\s+v?(\d+(?:\.\d+)*)/i.exec(clean);
        if (m) return resolve({ major: Number.parseInt(m[1], 10), versionLine: `rsgain ${m[1]}` });
        resolve({ major: 0, versionLine: clean.split('\n')[0].trim() || '' });
      });
      p.on('error', () => resolve({ major: 0, versionLine: '' }));
    } catch {
      resolve({ major: 0, versionLine: '' });
    }
  });
}

// ── Download + install ─────────────────────────────────────────────────────────

async function downloadAndInstall() {
  if (!isSupported()) return false;

  const dir = BUNDLED_RSGAIN_DIR;
  await fsp.mkdir(dir, { recursive: true });

  let tagName, ver;
  try {
    ({ tagName, ver } = await fetchLatestRelease());
  } catch (e) {
    winston.warn(`[rsgain-bootstrap] Could not fetch release info: ${e.message}`);
    return false;
  }

  // Asset filename: rsgain-3.7-Linux.tar.xz  (no 'v' prefix in filename)
  const asset    = `rsgain-${ver}-Linux.tar.xz`;
  const url      = `https://github.com/complexlogic/rsgain/releases/download/${tagName}/${asset}`;
  const archPath = path.join(dir, asset);

  winston.info(`[rsgain-bootstrap] Downloading rsgain ${ver} for linux/x64…`);
  try {
    await downloadToFile(url, archPath, 'velvet-rsgain-bootstrap/1.0');
  } catch (e) {
    winston.warn(`[rsgain-bootstrap] Download failed: ${e.message}`);
    await fsp.unlink(archPath).catch(() => {});
    return false;
  }

  // Extract: the archive contains e.g. rsgain-3.7-Linux/rsgain
  // Use --strip-components=1 to land it directly in BUNDLED_RSGAIN_DIR/rsgain
  const extracted = await new Promise(resolve => {
    const proc = spawn(_SYSTEM_TAR, [
      '-xJf', archPath,
      '-C',   dir,
      '--strip-components=1',
      `rsgain-${ver}-Linux/rsgain`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });

  await fsp.unlink(archPath).catch(() => {});

  if (!extracted) {
    winston.warn('[rsgain-bootstrap] Extraction failed');
    return false;
  }

  await fsp.chmod(rsgainBin(), 0o750).catch(() => {});
  return true;
}

// ── Core init logic ────────────────────────────────────────────────────────────

async function _init() {
  if (!isSupported()) {
    winston.info(`[rsgain-bootstrap] Platform ${process.platform}/${process.arch} not supported — ffmpeg fallback will be used`);
    _available = false;
    return;
  }

  const bin = rsgainBin();
  let exists = false;
  try { await fsp.access(bin, fs.constants.X_OK); exists = true; } catch (e) {
    // ENOENT is expected on first boot before auto-download completes.
    if (e?.code !== 'ENOENT') console.debug('[velvet]', e?.message ?? e);
  }

  if (exists) {
    const { major, versionLine } = await getRsgainVersion(bin);
    if (major >= MIN_RSGAIN_MAJOR) {
      winston.info(`[rsgain-bootstrap] Using bundled ${versionLine}`);
      _available = true;
      _scheduleUpdate();
      return;
    }
    winston.info(`[rsgain-bootstrap] Bundled binary is too old (major=${major}), re-downloading…`);
  }

  const ok = await downloadAndInstall();
  if (ok) {
    const { major, versionLine } = await getRsgainVersion(bin);
    if (major >= MIN_RSGAIN_MAJOR) {
      winston.info(`[rsgain-bootstrap] Installed ${versionLine}`);
      _available = true;
      _scheduleUpdate();
      return;
    }
    winston.warn(`[rsgain-bootstrap] Installed binary version check failed (major=${major})`);
  }

  _available = false;
  winston.warn('[rsgain-bootstrap] rsgain unavailable — ffmpeg-based measurement will be used as fallback');
}

function _scheduleUpdate() {
  // Re-check once per day (non-blocking)
  _updateTimer = setTimeout(async () => {
    try { await _init(); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  }, 24 * 60 * 60 * 1000);
  if (_updateTimer.unref) _updateTimer.unref();
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Ensure rsgain is available. Safe to call multiple times — returns the same
 * Promise. Resolves (without rejection) when the check is complete.
 */
export function ensureRsgain() {
  if (!_initPromise) {
    _initPromise = _init().catch(e => {
      winston.warn(`[rsgain-bootstrap] init error: ${e.message}`);
      _available = false;
    });
  }
  return _initPromise;
}
