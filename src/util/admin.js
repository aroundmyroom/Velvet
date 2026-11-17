import fs from 'node:fs/promises';
import path from 'node:path';
import child from 'node:child_process';
import express from 'express';
import * as auth from './auth.js';
import * as config from '../state/config.js';
import * as VelvetServer from '../server.js';
import * as dbQueue from '../db/task-queue.js';
import * as logger from '../logger.js';
import * as db from '../db/manager.js';
import { getDirname } from './esm-helpers.js';
import WebError from './web-error.js';

const __dirname = getDirname(import.meta.url);

function _requireUser(username) {
  if (!config.program.users[username]) { throw new WebError(`'${username}' does not exist`, 404); }
}

function editUserFields(username, fields) {
  _requireUser(username);
  return config.updateUserFields(username, fields);
}

async function _setTopLevel(key, val) {
  await config.updateConfigFile(c => { c[key] = val; });
  config.program[key] = val;
}

async function _setSection(section, key, val) {
  await config.updateConfigFile(c => {
    if (!c[section]) { c[section] = {}; }
    c[section][key] = val;
  });
  config.program[section][key] = val;
}

export async function addDirectory(directory, vpath, velvet, opts = {}) {
  const {
    autoAccess = false,
    isAudioBooks = false,
    isRecording = false,
    allowRecordDelete = false,
    isYoutube = false,
    isExcluded = false,
    artistsOn = true,
  } = opts;
  const root = config.normaliseFolderRoot(directory);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) { throw new Error(`${root} is not a directory`); }

  if (config.program.folders[vpath]) { throw new Error(`'${vpath}' is already loaded into memory`); }

  const folder = { root };
  if (isExcluded) { folder.type = 'excluded'; }
  else if (isAudioBooks) { folder.type = 'audio-books'; }
  if (isRecording) { folder.type = 'recordings'; }
  // Only use 'youtube' type when youtube-only (not combined with radio recordings)
  if (isYoutube && !isRecording) { folder.type = 'youtube'; }
  if ((isRecording || isYoutube) && allowRecordDelete) { folder.allowRecordDelete = true; }
  // Artist Library inclusion flag (default ON): when false, this folder's data
  // is excluded from artists_normalized rebuild and artist-facing features.
  folder.artistsOn = artistsOn !== false;

  await config.updateConfigFile(c => {
    c.folders = { ...c.folders, [vpath]: folder };
    if (autoAccess === true) {
      for (const user of Object.values(c.users || {})) { user.vpaths = [...(user.vpaths || []), vpath]; }
    }
  });

  config.program.folders[vpath] = structuredClone(folder);
  if (autoAccess === true) {
    for (const user of Object.values(config.program.users)) { user.vpaths = [...(user.vpaths || []), vpath]; }
  }

  // audio/flac is the correct MIME type; audio/x-flac causes DEMUXER_ERROR_NO_SUPPORTED_STREAMS in Chromium.
  const setMediaHeaders = (res, filePath) => {
    if (filePath.toLowerCase().endsWith('.flac')) res.setHeader('Content-Type', 'audio/flac');
  };
  const routeVpath = vpath.replace(/[()[\]?+*!:]/g, '\\$&');
  velvet.use(`/media/${routeVpath}/`, express.static(root, { setHeaders: setMediaHeaders }));
}

export async function removeDirectory(vpath) {
  if (!config.program.folders[vpath]) { throw new Error(`'${vpath}' not found`); }

  await config.updateConfigFile(c => {
    if (c.folders) { delete c.folders[vpath]; }
    for (const user of Object.values(c.users || {})) {
      if (user.vpaths?.includes(vpath)) { user.vpaths.splice(user.vpaths.indexOf(vpath), 1); }
    }
  });

  db.removeFilesByVpath(vpath);

  VelvetServer.reboot();
}

export async function addUser(username, password, admin, vpaths) {
  if (config.program.users[username]) { throw new WebError(`'${username}' already exists`, 409); }

  const hash = await auth.hashPassword(password);
  const newUser = {
    vpaths: vpaths,
    password: hash.hashPassword,
    salt: hash.salt,
    admin: admin
  };

  await config.updateConfigFile(c => {
    if (c.users?.[username]) { throw new WebError(`'${username}' already exists`, 409); }
    c.users = { ...c.users, [username]: newUser };
  });

  config.program.users[username] = structuredClone(newUser);
}

export async function deleteUser(username) {
  _requireUser(username);

  await config.updateConfigFile(c => { if (c.users) { delete c.users[username]; } });

  delete config.program.users[username];

  db.deleteAllUserData(username);
}

// Bumping tokenVersion invalidates every token issued to this user before now.
export async function editUserPassword(username, password) {
  _requireUser(username);
  const hash = await auth.hashPassword(password);
  const tokenVersion = (config.program.users[username].tokenVersion || 0) + 1;
  await editUserFields(username, { password: hash.hashPassword, salt: hash.salt, tokenVersion });
}

export async function revokeUserTokens(username) {
  _requireUser(username);
  await editUserFields(username, { tokenVersion: (config.program.users[username].tokenVersion || 0) + 1 });
}

export function editSubsonicPassword(username, password) {
  return editUserFields(username, { 'subsonic-password': password });
}

export function editUserVPaths(username, vpaths) {
  return editUserFields(username, { vpaths });
}

export function editUserAccess(username, admin) {
  return editUserFields(username, { admin });
}

export async function editPort(port) {
  if (config.program.port === port) { return; }
  await config.updateConfigFile(c => { c.port = port; });
  VelvetServer.reboot();
}

export async function editMaxRequestSize(maxRequestSize) {
  if (config.program.maxRequestSize === maxRequestSize) { return; }
  await config.updateConfigFile(c => { c.maxRequestSize = maxRequestSize; });
  VelvetServer.reboot();
}

export function editUpload(val) {
  return _setTopLevel('noUpload', val);
}

export function editUi(val) {
  return _setTopLevel('ui', val);
}

export function editSkin(val) {
  return _setTopLevel('skin', val);
}

export async function editAddress(val) {
  await config.updateConfigFile(c => { c.address = val; });
  VelvetServer.reboot();
}

export function editSecret(val) {
  return _setTopLevel('secret', val);
}

export async function editScanInterval(val) {
  await _setSection('scanOptions', 'scanInterval', val);
  dbQueue.resetScanInterval();
}

export async function editScanStartTime(val) {
  // val is "HH:MM" string or null/empty to clear
  const normalised = (val && /^\d{1,2}:\d{2}$/.test(val.trim())) ? val.trim() : null;
  await _setSection('scanOptions', 'scanStartTime', normalised);
  dbQueue.resetScanInterval();
}

export function editSkipImg(val) {
  return _setSection('scanOptions', 'skipImg', val);
}

export function editBootScanDelay(val) {
  return _setSection('scanOptions', 'bootScanDelay', val);
}

export function editBootScanEnabled(val) {
  return _setSection('scanOptions', 'bootScanEnabled', val);
}

export function editMaxConcurrentTasks(val) {
  return _setSection('scanOptions', 'maxConcurrentTasks', val);
}

export function editAlbumVersionTags(val) {
  return _setTopLevel('albumVersionTags', val);
}

export function editAlbumCategoryFolders(val) {
  return _setTopLevel('albumCategoryFolders', val);
}

export function editCompressImages(val) {
  return _setSection('scanOptions', 'compressImage', val);
}

export function editAllowId3Edit(val) {
  return _setSection('scanOptions', 'allowId3Edit', val);
}

export function editMaxRecordingMinutes(val) {
  return _setSection('scanOptions', 'maxRecordingMinutes', val);
}

export function editMaxZipMb(val) {
  return _setSection('scanOptions', 'maxZipMb', val);
}

export function editAllowRadioRecording(username, val) {
  return editUserFields(username, { 'allow-radio-recording': val });
}

export function editAllowYoutubeDownload(username, val) {
  return editUserFields(username, { 'allow-youtube-download': val });
}

export function editAllowAiDj(username, val) {
  return editUserFields(username, { 'allow-ai-dj': val });
}

export function editAllowUpload(username, val) {
  return editUserFields(username, { 'allow-upload': val });
}

export function editAllowServerRemote(username, val) {
  return editUserFields(username, { 'allow-server-remote': val });
}

export function editAllowMpvCast(username, val) {
  return editUserFields(username, { 'allow-mpv-cast': val });
}

export function editScanErrorRetention(hours) {
  return _setSection('scanOptions', 'scanErrorRetentionHours', hours);
}

export async function editWriteLogs(val) {
  await _setTopLevel('writeLogs', val);
  if (val === false) {
    logger.reset();
  } else {
    logger.addFileLogger(config.program.storage.logsDirectory, config.program.logRetention);
  }
}

export async function editLogRetention(val) {
  await _setTopLevel('logRetention', val);
  // DailyRotateFile reads maxFiles at creation time, so rebuild the transport.
  if (config.program.writeLogs) {
    logger.addFileLogger(config.program.storage.logsDirectory, val);
  }
}

// Deletes velvet-YYYY-MM-DD[-HH].log files older than retentionDays; returns the count.
export async function pruneOldLogs(retentionDays) {
  const dir = config.program.storage.logsDirectory;
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  for (const entry of entries) {
    const m = entry.match(/^velvet-(\d{4}-\d{2}-\d{2}(?:-\d{2})?)\.log$/);
    if (!m) continue;

    const datePart = m[1].length === 10 ? m[1] + 'T00:00:00Z' : m[1].replace(/(\d{4}-\d{2}-\d{2})-(\d{2})/, '$1T$2:00:00Z');
    const fileTime = Date.parse(datePart);
    if (Number.isNaN(fileTime) || fileTime >= cutoff) continue;

    try {
      await fs.unlink(path.join(dir, entry));
      deleted++;
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  }

  return deleted;
}

export function enableTranscode(val) {
  return _setSection('transcode', 'enabled', val);
}

export function editDefaultCodec(val) {
  return _setSection('transcode', 'defaultCodec', val);
}

export function editDefaultBitrate(val) {
  return _setSection('transcode', 'defaultBitrate', val);
}

export function editDefaultAlgorithm(val) {
  return _setSection('transcode', 'algorithm', val);
}

export function lockAdminApi(val) {
  return _setTopLevel('lockAdmin', val);
}

export async function removeSSL() {
  await config.updateConfigFile(c => { delete c.ssl; });
  delete config.program.ssl;
  VelvetServer.reboot();
}

function testSSL(jsonLoad) {
  return new Promise((resolve, reject) => {
    child.fork(path.join(__dirname, './ssl-test.js'), [JSON.stringify(jsonLoad)], { silent: true }).on('close', (code) => {
      if (code !== 0) {
        return reject(new Error('SSL Failure'));
      }
      resolve();
    });
  });
}

export async function setSSL(cert, key) {
  const sslObj = { key, cert };
  await testSSL(sslObj);
  await config.updateConfigFile(c => { c.ssl = sslObj; });
  config.program.ssl = sslObj;
  VelvetServer.reboot();
}
