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
import * as syncthing from '../state/syncthing.js';
import { getDirname } from './esm-helpers.js';

const __dirname = getDirname(import.meta.url);

export async function loadFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf-8'));
}

export function saveFile(saveData, file) {
  return fs.writeFile(file, JSON.stringify(saveData, null, 2), 'utf8');
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
  // confirm directory is real
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) { throw new Error(`${directory} is not a directory`); }

  if (config.program.folders[vpath]) { throw new Error(`'${vpath}' is already loaded into memory`); }

  // This extra step is so we can handle the process like a SQL transaction
    // The new var is a copy so the original program isn't touched
    // Once the file save is complete, the new user will be added
  const memClone = structuredClone(config.program.folders);
  memClone[vpath] = { root: directory };
  if (isExcluded) { memClone[vpath].type = 'excluded'; }
  else if (isAudioBooks) { memClone[vpath].type = 'audio-books'; }
  if (isRecording) {
    memClone[vpath].type = 'recordings';
  }
  // Only use 'youtube' type when youtube-only (not combined with radio recordings)
  if (isYoutube && !isRecording) {
    memClone[vpath].type = 'youtube';
  }
  if ((isRecording || isYoutube) && allowRecordDelete) {
    memClone[vpath].allowRecordDelete = true;
  }
  // Artist Library inclusion flag (default ON): when false, this folder's data
  // is excluded from artists_normalized rebuild and artist-facing features.
  memClone[vpath].artistsOn = artistsOn !== false;

  // add directory to config file
  const loadConfig = await loadFile(config.configFile);
  loadConfig.folders = memClone;
  if (autoAccess === true) {
    const memCloneUsers = structuredClone(config.program.users);
    Object.values(memCloneUsers).forEach(user => {
      user.vpaths.push(vpath);
    });
    loadConfig.users = memCloneUsers;
  }
  await saveFile(loadConfig, config.configFile);

  // add directory to program
  config.program.folders[vpath] = memClone[vpath];

  if (autoAccess === true) {
    Object.values(config.program.users).forEach(user => {
      user.vpaths.push(vpath);
    });
  }

  // add directory to server routing
  // audio/flac is the correct MIME type; audio/x-flac causes DEMUXER_ERROR_NO_SUPPORTED_STREAMS in Chromium.
  const setMediaHeaders = (res, filePath) => {
    if (filePath.toLowerCase().endsWith('.flac')) res.setHeader('Content-Type', 'audio/flac');
  };
  const routeVpath = vpath.replace(/[()[\]?+*!:]/g, '\\$&');
  velvet.use(`/media/${routeVpath}/`, express.static(directory, { setHeaders: setMediaHeaders }));
}

export async function removeDirectory(vpath) {
  if (!config.program.folders[vpath]) { throw new Error(`'${vpath}' not found`); }

  const memCloneFolders = structuredClone(config.program.folders);
  delete memCloneFolders[vpath];

  const memCloneUsers = structuredClone(config.program.users);
  Object.values(memCloneUsers).forEach(user => {
    if (user.vpaths.includes(vpath)) {
      user.vpaths.splice(user.vpaths.indexOf(vpath), 1);
    }
  });

  const loadConfig = await loadFile(config.configFile);
  loadConfig.folders = memCloneFolders;
  loadConfig.users = memCloneUsers;
  await saveFile(loadConfig, config.configFile);

  db.removeFilesByVpath(vpath);
  db.saveFilesDB();

  // reboot server
  VelvetServer.reboot();
}

export async function addUser(username, password, admin, vpaths) {
  if (config.program.users[username]) { throw new Error(`'${username}' is already loaded into memory`); }

  // hash password
  const hash = await auth.hashPassword(password);

  const newUser = {
    vpaths: vpaths,
    password: hash.hashPassword,
    salt: hash.salt,
    admin: admin
  };

  // This extra step is so we can handle the process like a SQL transaction
    // The new var is a copy so the original program isn't touched
    // Once the file save is complete, the new user will be added
  const memClone = structuredClone(config.program.users);
  memClone[username] = newUser;

  const loadConfig = await loadFile(config.configFile);
  loadConfig.users = memClone;
  await saveFile(loadConfig, config.configFile);

  config.program.users[username] = newUser;

  // NOTE(pending): add user from scrobbler
}

export async function deleteUser(username) {
  if (!config.program.users[username]) { throw new Error(`'${username}' does not exist`); }

  const memClone = structuredClone(config.program.users);
  delete memClone[username];

  const loadConfig = await loadFile(config.configFile);
  loadConfig.users = memClone;
  await saveFile(loadConfig, config.configFile);

  delete config.program.users[username];

  db.removeUserMetadataByUser(username);
  db.saveUserDB();

  db.removePlaylistsByUser(username);
  db.saveUserDB();

  db.removeSharedPlaylistsByUser(username);
  db.saveUserDB();

  // NOTE(pending): Remove user from scrobbler
}

export async function editUserPassword(username, password) {
  if (!config.program.users[username]) { throw new Error(`'${username}' does not exist`); }

  const hash = await auth.hashPassword(password);

  const memClone = structuredClone(config.program.users);
  memClone[username].password = hash.hashPassword;
  memClone[username].salt = hash.salt;

  const loadConfig = await loadFile(config.configFile);
  loadConfig.users = memClone;
  await saveFile(loadConfig, config.configFile);

  config.program.users[username].password = hash.hashPassword;
  config.program.users[username].salt = hash.salt;
}

export async function editSubsonicPassword(username, password) {
  if (!config.program.users[username]) { throw new Error(`'${username}' does not exist`); }

  const memClone = structuredClone(config.program.users);
  memClone[username]['subsonic-password'] = password;

  const loadConfig = await loadFile(config.configFile);
  loadConfig.users = memClone;
  await saveFile(loadConfig, config.configFile);

  config.program.users[username]['subsonic-password'] = password;
}

export async function editUserVPaths(username, vpaths) {
  if (!config.program.users[username]) { throw new Error(`'${username}' does not exist`); }

  const memClone = structuredClone(config.program.users);
  memClone[username].vpaths = vpaths;

  const loadConfig = await loadFile(config.configFile);
  loadConfig.users = memClone;
  await saveFile(loadConfig, config.configFile);

  config.program.users[username].vpaths = vpaths;
}

export async function editUserAccess(username, admin) {
  if (!config.program.users[username]) { throw new Error(`'${username}' does not exist`); }

  const memClone = structuredClone(config.program.users);
  memClone[username].admin = admin;

  const loadConfig = await loadFile(config.configFile);
  loadConfig.users = memClone;
  await saveFile(loadConfig, config.configFile);

  config.program.users[username].admin = admin;
}

export async function setUserLastFM(username, lastfmUser, lastfmPassword) {
  if (!config.program.users[username]) { throw new Error(`'${username}' does not exist`); }

  const memClone = structuredClone(config.program.users);
  memClone[username]['lastfm-user'] = lastfmUser;
  memClone[username]['lastfm-password'] = lastfmPassword;

  const loadConfig = await loadFile(config.configFile);
  loadConfig.users = memClone;
  await saveFile(loadConfig, config.configFile);

  config.program.users[username]['lastfm-user'] = lastfmUser;
  config.program.users[username]['lastfm-password'] = lastfmPassword;
}

export async function editPort(port) {
  if (config.program.port === port) { return; }

  const loadConfig = await loadFile(config.configFile);
  loadConfig.port = port;
  await saveFile(loadConfig, config.configFile);

  // reboot server
  VelvetServer.reboot();
}

export async function editMaxRequestSize(maxRequestSize) {
  if (config.program.maxRequestSize === maxRequestSize) { return; }

  const loadConfig = await loadFile(config.configFile);
  loadConfig.maxRequestSize = maxRequestSize;
  await saveFile(loadConfig, config.configFile);

  // reboot server
  VelvetServer.reboot();
}

export async function editUpload(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.noUpload = val;
  await saveFile(loadConfig, config.configFile);

  config.program.noUpload = val;
}

export async function editUi(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.ui = val;
  await saveFile(loadConfig, config.configFile);

  config.program.ui = val;
}


export async function editAddress(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.address = val;
  await saveFile(loadConfig, config.configFile);

  VelvetServer.reboot();
}

export async function editSecret(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.secret = val;
  await saveFile(loadConfig, config.configFile);

  config.program.secret = val;
}

export async function editScanInterval(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.scanInterval = val;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.scanInterval = val;

  // update timer
  dbQueue.resetScanInterval();
}

export async function editScanStartTime(val) {
  // val is "HH:MM" string or null/empty to clear
  const normalised = (val && /^\d{1,2}:\d{2}$/.test(val.trim())) ? val.trim() : null;
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.scanStartTime = normalised;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.scanStartTime = normalised;

  // reset timer with new start time
  dbQueue.resetScanInterval();
}

export async function editSkipImg(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.skipImg = val;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.skipImg = val;
}

export async function editBootScanDelay(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.bootScanDelay = val;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.bootScanDelay = val;
}

export async function editBootScanEnabled(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.bootScanEnabled = val;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.bootScanEnabled = val;
}

export async function editMaxConcurrentTasks(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.maxConcurrentTasks = val;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.maxConcurrentTasks = val;
}

export async function editAlbumVersionTags(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.albumVersionTags = val;
  await saveFile(loadConfig, config.configFile);
  config.program.albumVersionTags = val;
}

export async function editAlbumCategoryFolders(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.albumCategoryFolders = val;
  await saveFile(loadConfig, config.configFile);
  config.program.albumCategoryFolders = val;
}

export async function editCompressImages(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.compressImage = val;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.compressImage = val;
}

export async function editAllowId3Edit(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.allowId3Edit = val;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.allowId3Edit = val;
}

export async function editMaxRecordingMinutes(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.maxRecordingMinutes = val;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.maxRecordingMinutes = val;
}

export async function editMaxZipMb(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.maxZipMb = val;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.maxZipMb = val;
}

export async function editAllowRadioRecording(username, val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.users?.[username]) { throw new Error(`User '${username}' not found`); }
  loadConfig.users[username]['allow-radio-recording'] = val;
  await saveFile(loadConfig, config.configFile);

  config.program.users[username]['allow-radio-recording'] = val;
}

export async function editAllowYoutubeDownload(username, val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.users?.[username]) { throw new Error(`User '${username}' not found`); }
  loadConfig.users[username]['allow-youtube-download'] = val;
  await saveFile(loadConfig, config.configFile);

  config.program.users[username]['allow-youtube-download'] = val;
}

export async function editAllowUpload(username, val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.users?.[username]) { throw new Error(`User '${username}' not found`); }
  loadConfig.users[username]['allow-upload'] = val;
  await saveFile(loadConfig, config.configFile);

  config.program.users[username]['allow-upload'] = val;
}

export async function editAllowServerRemote(username, val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.users?.[username]) { throw new Error(`User '${username}' not found`); }
  loadConfig.users[username]['allow-server-remote'] = val;
  await saveFile(loadConfig, config.configFile);
  config.program.users[username]['allow-server-remote'] = val;
}

export async function editAllowMpvCast(username, val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.users?.[username]) { throw new Error(`User '${username}' not found`); }
  loadConfig.users[username]['allow-mpv-cast'] = val;
  await saveFile(loadConfig, config.configFile);
  config.program.users[username]['allow-mpv-cast'] = val;
}

export async function editScanErrorRetention(hours) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.scanOptions) { loadConfig.scanOptions = {}; }
  loadConfig.scanOptions.scanErrorRetentionHours = hours;
  await saveFile(loadConfig, config.configFile);

  config.program.scanOptions.scanErrorRetentionHours = hours;
}

export async function editWriteLogs(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.writeLogs = val;
  await saveFile(loadConfig, config.configFile);

  config.program.writeLogs = val;

  if (val === false) {
    logger.reset();
  } else {
    logger.addFileLogger(config.program.storage.logsDirectory, config.program.logRetention);
  }
}

export async function editLogRetention(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.logRetention = val;
  await saveFile(loadConfig, config.configFile);

  config.program.logRetention = val;

  // Re-initialise the file transport with the new maxFiles value so it takes
  // effect immediately (DailyRotateFile reads maxFiles at creation time).
  if (config.program.writeLogs) {
    logger.addFileLogger(config.program.storage.logsDirectory, val);
  }
}

/**
 * Delete log files in the logs directory whose date (parsed from the filename
 * `velvet-YYYY-MM-DD-HH.log`) is older than `retentionDays` days ago.
 * Returns the number of files deleted.
 */
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
    // Match velvet-YYYY-MM-DD-HH.log  OR  velvet-YYYY-MM-DD.log
    const m = entry.match(/^velvet-(\d{4}-\d{2}-\d{2}(?:-\d{2})?)\.log$/);
    if (!m) continue;

    // Parse date part — pad to hour granularity so Date.parse works
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

export async function enableTranscode(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.transcode) { loadConfig.transcode = {}; }
  loadConfig.transcode.enabled = val;
  await saveFile(loadConfig, config.configFile);

  config.program.transcode.enabled = val;
}

export async function editDefaultCodec(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.transcode) { loadConfig.transcode = {}; }
  loadConfig.transcode.defaultCodec = val;
  await saveFile(loadConfig, config.configFile);

  config.program.transcode.defaultCodec = val;
}

export async function editDefaultBitrate(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.transcode) { loadConfig.transcode = {}; }
  loadConfig.transcode.defaultBitrate = val;
  await saveFile(loadConfig, config.configFile);

  config.program.transcode.defaultBitrate = val;
}

export async function editDefaultAlgorithm(val) {
  const loadConfig = await loadFile(config.configFile);
  if (!loadConfig.transcode) { loadConfig.transcode = {}; }
  loadConfig.transcode.algorithm = val;
  await saveFile(loadConfig, config.configFile);

  config.program.transcode.algorithm = val;
}

export async function lockAdminApi(val) {
  const loadConfig = await loadFile(config.configFile);
  loadConfig.lockAdmin = val;
  await saveFile(loadConfig, config.configFile);

  config.program.lockAdmin = val;
}

export async function enableFederation(val) {
  const memClone = structuredClone(config.program.federation);
  memClone.enabled = val;

  const loadConfig = await loadFile(config.configFile);
  loadConfig.federation = memClone;
  await saveFile(loadConfig, config.configFile);

  config.program.federation.enabled = val;
  syncthing.setup();
}

export async function removeSSL() {
  const loadConfig = await loadFile(config.configFile);
  delete loadConfig.ssl;
  await saveFile(loadConfig, config.configFile);

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
  const loadConfig = await loadFile(config.configFile);
  loadConfig.ssl = sslObj;
  await saveFile(loadConfig, config.configFile);

  config.program.ssl = sslObj;
  VelvetServer.reboot();
}
