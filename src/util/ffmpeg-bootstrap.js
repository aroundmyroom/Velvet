/**
 * ffmpeg-bootstrap.js
 *
 * Auto-downloads static ffmpeg + ffprobe binaries on first use, with SHA256
 * checksum verification. Re-checks daily and auto-updates when a new version
 * is available from BtbN/FFmpeg-Builds on GitHub.
 *
 * Supported auto-download platforms:
 *   Linux x64   → BtbN ffmpeg-master-latest-linux64-gpl.tar.xz
 *   Linux arm64 → BtbN ffmpeg-master-latest-linuxarm64-gpl.tar.xz
 *   Windows x64 → BtbN ffmpeg-master-latest-win64-gpl.zip
 *   macOS x64/arm64 → martin-riedl.de signed static builds (no checksum)
 *
 * All other platforms: log a warning — user must provide binaries manually.
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadToBuffer, downloadToFile, computeFileChecksum } from './bootstrap-helpers.js';
import { spawn } from 'node:child_process';
import winston from 'winston';

// Absolute paths for system binaries — avoids PATH-injection (sonarjs/no-os-command-from-path)
const _SYSTEM_TAR = ['/usr/bin/tar', '/bin/tar'].find(p => fs.existsSync(p)) ?? 'tar';
const _SYSTEM_PS  = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell';
import * as config from '../state/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binaryExt = process.platform === 'win32' ? '.exe' : '';

// Default bundled directory — same location as before, so existing installs
// that already have binaries here continue to work without any migration.
const BUNDLED_FFMPEG_DIR = path.join(__dirname, '../../bin/ffmpeg');

// BtbN publishes a single checksums.sha256 file alongside each release.
const CHECKSUMS_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/checksums.sha256';

let _initPromise = null;
let _updateTimer = null;

// ── Path helpers ─────────────────────────────────────────────────────────────

// Returns the configured ffmpeg directory, falling back to the bundled dir.
export function getFfmpegDir() {
  return config.program.transcode?.ffmpegDirectory || BUNDLED_FFMPEG_DIR;
}

// Full path to the ffmpeg executable.
export function ffmpegBin() {
  return path.join(getFfmpegDir(), `ffmpeg${binaryExt}`);
}

// Full path to the ffprobe executable.
export function ffprobeBin() {
  return path.join(getFfmpegDir(), `ffprobe${binaryExt}`);
}

// ── Platform → asset mapping ─────────────────────────────────────────────────

// BtbN asset name for the current platform (Linux/Windows), or null.
function btbnAsset() {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64')   return 'ffmpeg-master-latest-linux64-gpl.tar.xz';
  if (platform === 'linux' && arch === 'arm64') return 'ffmpeg-master-latest-linuxarm64-gpl.tar.xz';
  if (platform === 'win32' && arch === 'x64')   return 'ffmpeg-master-latest-win64-gpl.zip';
  return null;
}

// Returns { url, asset, source } for the current platform, or null if unsupported.
// macOS uses martin-riedl.de (signed static builds, no checksum available).
function releaseInfo() {
  const asset = btbnAsset();
  if (asset) {
    return {
      url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${asset}`,
      asset,
      source: 'btbn',
    };
  }

  if (process.platform === 'darwin') {
    const macArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    return {
      url:        `https://ffmpeg.martin-riedl.de/packages/latest/macos/${macArch}/ffmpeg`,
      ffprobeUrl: `https://ffmpeg.martin-riedl.de/packages/latest/macos/${macArch}/ffprobe`,
      asset:      `ffmpeg-macos-${macArch}`,
      source:     'martin-riedl',
    };
  }

  return null;
}

// ── Checksum verification ────────────────────────────────────────────────────

// Fetch the BtbN checksums.sha256 file and return the expected hash for assetName.
// Returns null if the file can't be fetched or the asset isn't listed.
async function fetchExpectedChecksum(assetName) {
  try {
    const buf = await downloadToBuffer(CHECKSUMS_URL, 'velvet-ffmpeg-bootstrap/2.0');
    const lines = buf.toString('utf8').split('\n');
    for (const line of lines) {
      // Format: "sha256hash  filename"
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] === assetName) return parts[0];
    }
  } catch (e) {
    winston.warn(`[ffmpeg-bootstrap] Could not fetch checksums: ${e.message}`);
  }
  return null;
}

// ── Extraction ───────────────────────────────────────────────────────────────

// Extract ffmpeg and ffprobe from a .tar.xz archive using system tar.
// Works with both GNU tar (bare-metal/Debian) and BusyBox tar (Alpine/Docker).
function extractTarXz(tarPath, destDir, asset) {
  const prefix = asset.replace(/\.tar\.xz$/, '');
  return new Promise((resolve, reject) => {
    const proc = spawn(_SYSTEM_TAR, [
      '-xJf', tarPath,
      '-C', destDir,
      '--strip-components=2',
      `${prefix}/bin/ffmpeg`,
      `${prefix}/bin/ffprobe`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed (${code}): ${err.slice(-300)}`));
    });
    proc.on('error', reject);
  });
}

// Extract ffmpeg and ffprobe from a .zip archive using PowerShell (Windows).
function extractZip(zipPath, destDir, _asset) {
  return new Promise((resolve, reject) => {
    // PowerShell script: extract only ffmpeg.exe and ffprobe.exe to destDir
    const script = `
      Add-Type -AssemblyName System.IO.Compression.FileSystem;
      $zip = [IO.Compression.ZipFile]::OpenRead('${zipPath.replaceAll("'", "''")}');
      foreach ($entry in $zip.Entries) {
        if ($entry.Name -eq 'ffmpeg.exe' -or $entry.Name -eq 'ffprobe.exe') {
          $outPath = Join-Path '${destDir.replaceAll("'", "''")}' $entry.Name;
          [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $outPath, $true);
        }
      }
      $zip.Dispose();
    `;
    const proc = spawn(_SYSTEM_PS, ['-NoProfile', '-Command', script],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`zip extract failed (${code}): ${err.slice(-300)}`));
    });
    proc.on('error', reject);
  });
}

// ── Version check ────────────────────────────────────────────────────────────

// Run `ffmpeg -version` and return { major, versionLine }.
// Returns { major: 0, versionLine: '' } on any failure.
// Handles both stable releases ("ffmpeg version 7.1.1") and BtbN git snapshot
// builds ("ffmpeg version N-123777-g53537f6cf5-20260331").
const MIN_FFMPEG_MAJOR = 6;

function getFfmpegVersion(binPath) {
  return new Promise(resolve => {
    const p = spawn(binPath, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let o = '';
    p.stdout.on('data', d => { o += d; });
    p.on('close', () => {
      const line = o.split('\n')[0] || '';
      const stableMatch = /ffmpeg version (\d+)/.exec(line);
      if (stableMatch) return resolve({ major: Number.parseInt(stableMatch[1], 10), versionLine: line });
      // BtbN git snapshot: "ffmpeg version N-123777-g<hash>-<date>" — always valid
      if (/ffmpeg version N-\d+/.test(line)) return resolve({ major: 99, versionLine: line });
      resolve({ major: 0, versionLine: line });
    });
    p.on('error', () => resolve({ major: 0, versionLine: '' }));
  });
}

// ── Core download + install ──────────────────────────────────────────────────

// Returns the path where we persist the last known checksum for update detection.
function checksumFile() {
  return path.join(getFfmpegDir(), '.ffmpeg-checksum');
}

async function downloadAndInstall() {
  const info = releaseInfo();
  if (!info) {
    winston.warn(
      `[ffmpeg-bootstrap] No static build for ${process.platform}/${process.arch}. ` +
      `Place ffmpeg and ffprobe in ${getFfmpegDir()} manually.`
    );
    return false;
  }

  const dir = getFfmpegDir();
  await fsp.mkdir(dir, { recursive: true });

  winston.info(`[ffmpeg-bootstrap] Downloading ffmpeg for ${process.platform}/${process.arch}…`);

  try {
    if (info.source === 'martin-riedl') {
      // macOS: direct binary downloads (no archive, no checksum available)
      await downloadToFile(info.url,        ffmpegBin(),  'velvet-ffmpeg-bootstrap/2.0');
      await downloadToFile(info.ffprobeUrl, ffprobeBin(), 'velvet-ffmpeg-bootstrap/2.0');
      await fsp.chmod(ffmpegBin(),  0o750).catch(() => {});
      await fsp.chmod(ffprobeBin(), 0o750).catch(() => {});
    } else {
      // BtbN (Linux / Windows): download archive then verify checksum
      const archivePath = path.join(dir, info.asset);
      await downloadToFile(info.url, archivePath, 'velvet-ffmpeg-bootstrap/2.0');

      // Checksum verification — hard-fail if we can't obtain the expected hash, so a
      // transient network blip or compromised CDN can't slip an unverified binary through.
      const expected = await fetchExpectedChecksum(info.asset);
      if (!expected) {
        await fsp.unlink(archivePath).catch(() => {});
        winston.error(`[ffmpeg-bootstrap] Could not fetch checksum for ${info.asset} — refusing to install unverified binary`);
        return false;
      }
      const actual = await computeFileChecksum(archivePath);
      if (actual !== expected) {
        await fsp.unlink(archivePath).catch(() => {});
        winston.error(`[ffmpeg-bootstrap] Checksum mismatch! expected ${expected}, got ${actual}`);
        return false;
      }
      winston.info('[ffmpeg-bootstrap] Checksum verified');

      // Extract
      if (info.asset.endsWith('.tar.xz')) {
        await extractTarXz(archivePath, dir, info.asset);
      } else if (info.asset.endsWith('.zip')) {
        await extractZip(archivePath, dir, info.asset);
      }

      await fsp.chmod(ffmpegBin(),  0o750).catch(() => {});
      await fsp.chmod(ffprobeBin(), 0o750).catch(() => {});
      await fsp.unlink(archivePath).catch(() => {});

      // Persist checksum so the daily update checker can detect new releases
      if (expected) {
        await fsp.writeFile(checksumFile(), expected, 'utf8').catch(() => {});
      }
    }

    // Verify extraction actually produced the binaries
    await fsp.access(ffmpegBin());
    await fsp.access(ffprobeBin());

    const { versionLine } = await getFfmpegVersion(ffmpegBin());
    winston.info(`[ffmpeg-bootstrap] ffmpeg ready: ${versionLine || ffmpegBin()}`);
    return true;
  } catch (e) {
    winston.error(`[ffmpeg-bootstrap] Download failed: ${e.message}`);
    return false;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure ffmpeg + ffprobe are present and recent.
 * Downloads on first call if missing or outdated (major version < MIN_FFMPEG_MAJOR).
 * Safe to call multiple times — deduplicates via cached promise.
 */
export async function ensureFfmpeg() {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const bin   = ffmpegBin();
    const probe = ffprobeBin();

    let binPresent   = false;
    let probePresent = false;
    try { await fsp.access(bin);   binPresent   = true; } catch (e) {
      // ENOENT is expected on first boot before auto-download completes.
      if (e?.code !== 'ENOENT') console.debug('[velvet]', e?.message ?? e);
    }
    try { await fsp.access(probe); probePresent = true; } catch (e) {
      // ENOENT is expected on first boot before auto-download completes.
      if (e?.code !== 'ENOENT') console.debug('[velvet]', e?.message ?? e);
    }

    if (binPresent && probePresent) {
      const { major, versionLine } = await getFfmpegVersion(bin);
      if (major >= MIN_FFMPEG_MAJOR) {
        winston.info(`[ffmpeg-bootstrap] ${versionLine || 'ffmpeg v' + major + ' found'}`);
        // Schedule daily update check for BtbN platforms
        _scheduleDailyUpdateCheck();
        return getFfmpegDir();
      }
      winston.warn(
        `[ffmpeg-bootstrap] ffmpeg v${major || '?'} is outdated (need v${MIN_FFMPEG_MAJOR}+), updating…`
      );
    }

    await downloadAndInstall();
    _scheduleDailyUpdateCheck();
  })().catch(e => {
    winston.error(`[ffmpeg-bootstrap] ${e.message}`);
    _initPromise = null;
  });

  return _initPromise;
}

// ── Daily update check ───────────────────────────────────────────────────────

// Runs once per day: fetches the latest BtbN checksum and re-downloads if changed.
function _scheduleDailyUpdateCheck() {
  if (_updateTimer || !btbnAsset()) return; // no-op on macOS/unsupported or already scheduled
  _updateTimer = setInterval(_checkForUpdate, 24 * 60 * 60 * 1000);
  if (_updateTimer.unref) _updateTimer.unref(); // don't keep the process alive
}

async function _checkForUpdate() {
  const asset = btbnAsset();
  if (!asset) return;

  const expected = await fetchExpectedChecksum(asset);
  if (!expected) return;

  let stored = null;
  try { stored = (await fsp.readFile(checksumFile(), 'utf8')).trim(); } catch (e) { console.debug('[velvet]', e?.message ?? e); }

  if (stored === expected) return; // already up to date

  winston.info('[ffmpeg-bootstrap] New ffmpeg build available, updating…');
  const success = await downloadAndInstall();
  if (success) {
    await fsp.writeFile(checksumFile(), expected, 'utf8').catch(() => {});
  }
}
