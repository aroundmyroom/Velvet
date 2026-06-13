#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const require = createRequire(import.meta.url);
const version = require('./package.json').version;

/**
 * First-run bootstrap — executes when VELVET_MUSIC_DIR is set.
 *
 * Supported environment variables (the legacy MSTREAM_* names are still accepted
 * as a fallback so existing compose files keep working):
 *
 *   VELVET_MUSIC_DIR          Path to the music library inside the container (e.g. /music).
 *                             This is the only required variable to trigger auto-config.
 *
 *   VELVET_ADMIN_USER         Admin username (optional).
 *   VELVET_ADMIN_PASS         Admin password (optional).
 *                             If both are omitted the server starts without any users —
 *                             all library access is open to anyone (no login required).
 *
 *   VELVET_ENABLE_AUDIOBOOKS  Set to "true" to add an AudioBooks folder (type: audio-books).
 *   VELVET_ENABLE_RECORDINGS  Set to "true" to add a Recordings folder (type: recordings) and enable radio.
 *   VELVET_ENABLE_YOUTUBE     Set to "true" to add a YouTube downloads folder (type: youtube).
 *
 *   VELVET_AUDIOBOOKS_SUBDIR  Optional sub-folder name inside VELVET_MUSIC_DIR.
 *                             If omitted, the folder type is applied to VELVET_MUSIC_DIR itself.
 *   VELVET_RECORDINGS_SUBDIR  Optional sub-folder name inside VELVET_MUSIC_DIR.
 *                             If omitted, the folder type is applied to VELVET_MUSIC_DIR itself.
 *   VELVET_YOUTUBE_SUBDIR     Optional sub-folder name inside VELVET_MUSIC_DIR.
 *                             If omitted, the folder type is applied to VELVET_MUSIC_DIR itself.
 *
 * Auto-config runs in two independent phases, each only once:
 *   1. Folder phase  — runs when no folders are configured yet.
 *   2. User phase    — runs when no users exist yet and both VELVET_ADMIN_USER
 *                      and VELVET_ADMIN_PASS are set.
 *
 * This means you can set up folders on first boot (without admin vars) and then
 * add VELVET_ADMIN_USER/PASS on a later restart to create the admin account.
 * Once users exist the user phase is skipped on all subsequent restarts.
 */
const envVar = (name) => process.env['VELVET_' + name] ?? process.env['MSTREAM_' + name];

async function bootstrapFromEnv(configPath) {
  const musicDir = envVar('MUSIC_DIR');
  if (!musicDir) return;

  // Lazy-load — only needed on first run
  const fsp = (await import('fs/promises')).default;
  const pathMod = (await import('path')).default;

  const existing = await _readConfig(configPath, fsp);
  const hasFolders = existing.folders && Object.keys(existing.folders).length > 0;
  const hasUsers   = existing.users   && Object.keys(existing.users).length   > 0;

  // Nothing left to do
  if (hasFolders && hasUsers) return;

  const cfg = { ...existing };

  if (!hasFolders) await _bootstrapFolders(cfg, musicDir, pathMod, fsp);

  const adminUser = envVar('ADMIN_USER');
  const adminPass = envVar('ADMIN_PASS');
  if (!hasUsers && adminUser && adminPass) await _bootstrapUsers(cfg, adminUser, adminPass);

  await fsp.mkdir(pathMod.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8');
}

async function _readConfig(configPath, fsp) {
  try {
    return JSON.parse(await fsp.readFile(configPath, 'utf8'));
  } catch (_) {
    return {}; // file missing or empty — start fresh
  }
}

async function _resolveVpathDir(musicDir, subdirEnv, pathMod, fsp) {
  if (!subdirEnv) return musicDir;
  const dir = pathMod.join(musicDir, subdirEnv);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function _bootstrapFolders(cfg, musicDir, pathMod, fsp) {
  const folders = {};

  // Main music folder
  folders['Music'] = { root: musicDir, type: 'music', allowRecordDelete: false, albumsOnly: false };

  // AudioBooks / Podcasts
  if (envVar('ENABLE_AUDIOBOOKS') === 'true') {
    const dir = await _resolveVpathDir(musicDir, envVar('AUDIOBOOKS_SUBDIR'), pathMod, fsp);
    folders['AudioBooks'] = { root: dir, type: 'audio-books', allowRecordDelete: false, albumsOnly: false };
  }

  // Radio Recordings
  if (envVar('ENABLE_RECORDINGS') === 'true') {
    const dir = await _resolveVpathDir(musicDir, envVar('RECORDINGS_SUBDIR'), pathMod, fsp);
    folders['Recordings'] = { root: dir, type: 'recordings', allowRecordDelete: true };
    cfg.radio = { enabled: true };
  }

  // YouTube downloads
  if (envVar('ENABLE_YOUTUBE') === 'true') {
    const dir = await _resolveVpathDir(musicDir, envVar('YOUTUBE_SUBDIR'), pathMod, fsp);
    folders['YouTube'] = { root: dir, type: 'youtube', allowRecordDelete: true };
  }

  cfg.folders = folders;
}

async function _bootstrapUsers(cfg, adminUser, adminPass) {
  const { hashPassword } = await import('./src/util/auth.js');
  const hashed = await hashPassword(adminPass);
  // Grant access to all currently-configured folders
  const vpaths = Object.keys(cfg.folders || {});
  cfg.users = {
    [adminUser]: {
      password: hashed.hashPassword,
      salt:     hashed.salt,
      admin:    true,
      vpaths,
      'allow-radio-recording':  true,
      'allow-youtube-download': true,
    }
  };
}

// Check if we are in an electron environment
if (process.versions["electron"]) {
  // off to a separate electron boot environment
  await import("./build/electron.js");
} else {
  const { Command } = await import('commander');
  const program = new Command();
  program
    .version(version)
    .option('-j, --json <json>', 'Specify JSON Boot File', join(__dirname, 'save/conf/default.json'))
    .parse(process.argv);

  console.clear();
  console.log(`
    __   __   _          _
    \\ \\ / /__| |_   _____| |_
     \\ V / _ \\ \\ \\ / / _ \\ __|
      \\ V  __/ |\\ V /  __/ |_
       \\_/\\___|_| \\_/ \\___|\\__|`);
  console.log(`v${program.version()}`);
  console.log();
  console.log('Check out our Discord server:');
  console.log('https://discord.gg/KfsTCYrTkS');
  console.log();

  // First-run bootstrap: if VELVET_MUSIC_DIR is set and config has no folders
  // yet, auto-generate an initial config from environment variables.
  try {
    await bootstrapFromEnv(program.opts().json);
  } catch (err) {
    // Bootstrap failure is non-fatal — the server will still start.
    // Log clearly so the issue is visible in docker logs.
    console.error('[bootstrap] Failed to write initial config:', err.message);
  }

  // Boot the server
  const server = await import("./src/server.js");
  server.serveIt(program.opts().json);
}
