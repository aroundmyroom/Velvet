import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Joi from 'joi';
import winston from 'winston';
import { getDirname } from '../util/esm-helpers.js';
import { getTransAlgos, getTransCodecs, getTransBitrates } from '../api/transcode.js';
import { VERSION_WORDS_SCHEMA } from '../util/version-words.js';
import { VALID_RETENTIONS, DEFAULT_RETENTION } from '../logger.js';

const __dirname = getDirname(import.meta.url);

const storageJoi = Joi.object({
  albumArtDirectory: Joi.string().default(path.join(__dirname, '../../image-cache')),
  waveformDirectory: Joi.string().default(path.join(__dirname, '../../waveform-cache')),
  dbDirectory: Joi.string().default(path.join(__dirname, '../../save/db')),
  logsDirectory: Joi.string().default(path.join(__dirname, '../../save/logs')),
});

const scanOptions = Joi.object({
  skipImg: Joi.boolean().default(false),
  scanInterval: Joi.number().min(0).default(24),
  scanStartTime: Joi.string().pattern(/^\d{1,2}:\d{2}$/).allow(null, '').default(null),
  pause: Joi.number().min(0).default(0),
  bootScanDelay: Joi.number().default(3),
  bootScanEnabled: Joi.boolean().default(false),
  maxConcurrentTasks: Joi.number().integer().min(1).default(1),
  compressImage: Joi.boolean().default(true),
  scanErrorRetentionHours: Joi.number().integer().valid(12, 24, 48, 72, 168, 336, 720).default(48),
  maxRecordingMinutes: Joi.number().integer().min(1).default(180),
  maxZipMb: Joi.number().integer().min(1).default(500)
});

const dbOptions = Joi.object({
  clearSharedInterval: Joi.number().integer().min(0).default(24),
}).unknown(true);

const transcodeOptions = Joi.object({
  algorithm: Joi.string().valid(...getTransAlgos()).default('stream'),
  enabled: Joi.boolean().default(false),
  ffmpegDirectory: Joi.string().default(path.join(__dirname, '../../bin/ffmpeg')),
  defaultCodec: Joi.string().valid(...getTransCodecs()).default('opus'),
  defaultBitrate: Joi.string().valid(...getTransBitrates()).default('96k')
});

const lastFMOptions = Joi.object({
  enabled:   Joi.boolean().default(true),
  apiKey:    Joi.string().allow('').default(''),
  apiSecret: Joi.string().allow('').default('')
});

const listenBrainzOptions = Joi.object({
  enabled: Joi.boolean().default(false),
});

const aiAssistOptions = Joi.object({
  enabled:          Joi.boolean().default(false),
  apiKey:           Joi.string().allow('').default(''),
  model:            Joi.string().default('claude-haiku-5-5'),
  monthlyBudgetUsd: Joi.number().min(0).default(2),
  queueBuilder:     Joi.boolean().default(false),
  maxQueueSongs:    Joi.number().integer().min(1).max(9999).default(500),
  // 'anthropic' (Claude) or 'openai': any server with an OpenAI-compatible
  // chat-completions API — Ollama, LM Studio, llama.cpp, vLLM, LocalAI, Jan.
  provider:         Joi.string().valid('anthropic', 'openai').default('anthropic'),
  localBaseUrl:     Joi.string().allow('').default(''),
  localModel:       Joi.string().allow('').default(''),
  localApiKey:      Joi.string().allow('').default(''),
  // The library owner's own notes for the DJ brief: aliases, house meanings, taste.
  djNotes:          Joi.string().allow('').max(4000).default(''),
  // The admin's own version-word families; absent means the built-in defaults.
  versionWords:     VERSION_WORDS_SCHEMA.optional(),
});

const discordWebhookOptions = Joi.object({
  enabled: Joi.boolean().default(false),
  url:     Joi.string().uri().allow('').default(''),
});

const discogsOptions = Joi.object({
  enabled:        Joi.boolean().default(false),
  allowArtUpdate: Joi.boolean().default(false),
  apiKey:         Joi.string().allow('').default(''),
  apiSecret:      Joi.string().allow('').default(''),
  userAgentTag:   Joi.string().allow('').pattern(/^[a-zA-Z0-9]{0,4}$/).default(''),
  itunesEnabled:  Joi.boolean().default(true),
  deezerEnabled:  Joi.boolean().default(true),
});

const albumArtOptions = Joi.object({
  autoApprove:           Joi.boolean().default(false),
  autoSuggestNewContent: Joi.boolean().default(false),
  coverArtArchive:       Joi.boolean().default(true),
});

const serverAudioOptions = Joi.object({
  enabled: Joi.boolean().default(false),
  mpvBin:  Joi.string().default('mpv'),
  autoUnmute: Joi.boolean().default(true),
});

const acoustidOptions = Joi.object({
  enabled:   Joi.boolean().default(false),
  apiKey:    Joi.string().allow('').default(''),
  autostart: Joi.boolean().default(false),
});

const dlnaOptions = Joi.object({
  enabled: Joi.boolean().default(false),
  port:    Joi.number().integer().min(1024).max(65535).default(10293),
  name:    Joi.string().allow('').max(64).default('Velvet'),
});

const sonosOptions = Joi.object({
  enabled:         Joi.boolean().default(true),
  transcodeOpus:   Joi.boolean().default(false),
  sleepEnabled:    Joi.boolean().default(false),
  hiddenFavorites: Joi.array().items(Joi.string()).default([]),
  knownIps:    Joi.array().items(Joi.string()).default([]),
  defaultRoom: Joi.object({
    name: Joi.string().allow('').default(''),
    ip:   Joi.string().allow('').default(''),
    uuid: Joi.string().allow('').default(''),
  }).optional().allow(null).default(null),
});

// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

export function defaultSendspinName() {
  return `Velvet (${os.hostname()})`.slice(0, 63);
}

const sendspinOptions = Joi.object({
  enabled:   Joi.boolean().default(false),
  name:      Joi.string().trim().min(1).max(63).pattern(CONTROL_CHARS, { invert: true }).default(() => defaultSendspinName()),
  port:      Joi.number().integer().min(1024).max(65535).default(8927),
  bind:      Joi.string().ip({ cidr: 'forbidden' }).default('0.0.0.0'),
  path:      Joi.string().pattern(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,255}$/).default('/sendspin'),
  discovery: Joi.boolean().default(true),
});

const extAuthOptions = Joi.object({
  enabled:          Joi.boolean().default(false),
  // Header a trusted reverse proxy (or an auth layer in front of it) sets to the
  // logged-in username. Matches Navidrome's default so existing proxy configs
  // (Authelia/Authentik forward-auth, etc.) can be pointed at Velvet unchanged.
  headerName:       Joi.string().min(1).default('Remote-User'),
  // IPv4 addresses or CIDR ranges (e.g. "172.18.0.0/16") allowed to assert the
  // header above. Checked against the raw TCP socket peer, never X-Forwarded-For.
  trustedProxies:   Joi.array().items(Joi.string()).default([]),
  // Optional shared-secret header, required in addition to the IP check — closes
  // the gap where an untrusted container on the same Docker network could reach
  // Velvet directly and spoof the header.
  secretHeaderName: Joi.string().allow('').default('X-Velvet-ExtAuth-Secret'),
  secretValue:      Joi.string().allow('').default(''),
  // Off by default — admin must pre-create matching Velvet usernames. When on,
  // a first-seen header username is created automatically with access to every
  // non-excluded folder and no admin rights.
  autoCreateUsers:  Joi.boolean().default(false),
});

const schema = Joi.object({
  address: Joi.string().ip({ cidr: 'forbidden' }).default('::'),
  port: Joi.number().default(3000),
  localHttpPort: Joi.number().integer().min(1024).max(65535).optional().allow(null).default(null),
  supportedAudioFiles: Joi.object().pattern(
    Joi.string(), Joi.boolean()
  ).default({
    "mp3": true, "flac": true, "wav": true,
    "ogg": true, "aac": true, "m4a": true, "m4b": true,
    "opus": true, "m3u": false
  }),
  lastFM: lastFMOptions.default(lastFMOptions.validate({}).value),
  listenBrainz: listenBrainzOptions.default(listenBrainzOptions.validate({}).value),
  aiAssist: aiAssistOptions.default(aiAssistOptions.validate({}).value),
  discordWebhook: discordWebhookOptions.default(discordWebhookOptions.validate({}).value),
  discogs: discogsOptions.default(discogsOptions.validate({}).value),
  scanOptions: scanOptions.default(scanOptions.validate({}).value),
  noUpload: Joi.boolean().default(false),
  writeLogs: Joi.boolean().default(false),
  logRetention: Joi.string().valid(...VALID_RETENTIONS).default(DEFAULT_RETENTION),
  lockAdmin: Joi.boolean().default(false),
  storage: storageJoi.default(storageJoi.validate({}).value),
  webAppDirectory: Joi.string().default(path.join(__dirname, '../../webapp')),
  transcode: transcodeOptions.default(transcodeOptions.validate({}).value),
  secret: Joi.string().optional(),
  maxRequestSize: Joi.string().pattern(/\d+(KB|MB)/i).default('10MB'),
  db: dbOptions.default(dbOptions.validate({}).value),
  folders: Joi.object().pattern(
    Joi.string(),
    Joi.object({
      root: Joi.string().required(),
      type: Joi.string().valid('music', 'audio-books', 'recordings', 'youtube', 'excluded').default('music'),
      allowRecordDelete: Joi.boolean().default(false),
      albumsOnly: Joi.boolean().default(false),
    })
  ).default({}),
  users: Joi.object().pattern(
    Joi.string(),
    Joi.object({
      password: Joi.string().required(),
      admin: Joi.boolean().default(false),
      salt: Joi.string().required(),
      vpaths: Joi.array().items(Joi.string()),
      'lastfm-user': Joi.string().optional(),
      'lastfm-password': Joi.string().optional(),
      'lastfm-session': Joi.string().optional(),
      'listenbrainz-token': Joi.string().allow('').optional(),
      'discord-webhook-enabled': Joi.boolean().optional(),
      'discord-webhook-nick': Joi.string().allow('').max(64).optional(),
      'allow-radio-recording': Joi.boolean().optional(),
      'allow-youtube-download': Joi.boolean().optional(),
      'allow-upload': Joi.boolean().optional(),
      'allow-ai-dj': Joi.boolean().optional(),
      tokenVersion: Joi.number().integer().min(0).optional(),
    })
  ).default({}),
  ssl: Joi.object({
    key: Joi.string().allow('').optional(),
    cert: Joi.string().allow('').optional()
  }).optional(),
  serverAudio: serverAudioOptions.default(serverAudioOptions.validate({}).value),
  acoustid: acoustidOptions.default(acoustidOptions.validate({}).value),
  dlna: dlnaOptions.default(dlnaOptions.validate({}).value),
  albumArt: albumArtOptions.default(albumArtOptions.validate({}).value),
  sonos: sonosOptions.default(sonosOptions.validate({}).value),
  sendspin: sendspinOptions.default(() => sendspinOptions.validate({}).value),
  extAuth: extAuthOptions.default(extAuthOptions.validate({}).value),
  ui: Joi.string().valid('velvet', 'velvet-dark', 'velvet-light').default('velvet'),
  instanceId: Joi.string().optional(),
});

export let program; // NOSONAR — live ESM binding, reassigned in load()
export let configFile; // NOSONAR — live ESM binding, reassigned in load()

export function asyncRandom(numBytes) {
  return new Promise((resolve, reject) => {
    crypto.randomBytes(numBytes, (err, salt) => {
      if (err) { return reject(new Error('Failed to generate random bytes')); }
      resolve(salt.toString('base64'));
    });
  });
}

export function normaliseFolderRoot(root) {
  const trimmed = root.replace(/[\\/]+$/, '');
  return trimmed === '' || /^[A-Za-z]:$/.test(trimmed) ? root : trimmed;
}

async function writeJsonAtomic(file, data) {
  let mode = 0o600;
  try {
    mode = (await fs.stat(file)).mode & 0o777;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const fh = await fs.open(tmp, 'wx', mode);
  try {
    await fh.chmod(mode);
    await fh.writeFile(JSON.stringify(data, null, 2), 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

let _configWriteChain = Promise.resolve();

// The only way to change the config file: writers run one at a time on the current
// file contents, and each write lands atomically (temp file + fsync + rename).
export function updateConfigFile(mutator) {
  const run = _configWriteChain.then(async () => {
    const data = JSON.parse(await fs.readFile(configFile, 'utf8'));
    const result = await mutator(data);
    await writeJsonAtomic(configFile, data);
    return result;
  });
  _configWriteChain = run.catch(() => {});
  return run;
}

// Callers check the user exists first (and answer 403/404); a missing user here is a bug.
export async function updateUserFields(username, fields) {
  await updateConfigFile(c => {
    if (!c.users?.[username]) throw new Error(`user '${username}' is not in the config file`);
    Object.assign(c.users[username], fields);
  });
  Object.assign(program.users[username], fields);
}

export async function setup(configFileArg) {
  try {
    await fs.access(configFileArg);
  } catch {
    winston.info('Config File does not exist. Attempting to create file');
    await fs.mkdir(path.dirname(configFileArg), { recursive: true });
    await writeJsonAtomic(configFileArg, {});
  }

  const programData = JSON.parse(await fs.readFile(configFileArg, 'utf8'));
  configFile = configFileArg;

  // Verify paths are real; auto-create app-managed folders (recordings/youtube)
  for (const folder in programData.folders) {
    const folderCfg = programData.folders[folder];
    if (typeof folderCfg.root === 'string') folderCfg.root = normaliseFolderRoot(folderCfg.root);
    if (folderCfg.type === 'recordings' || folderCfg.type === 'youtube') {
      await fs.mkdir(folderCfg.root, { recursive: true }).catch(() => {});
    }
    if (!(await fs.stat(folderCfg.root)).isDirectory()) {
      throw new Error('Path does not exist: ' + folderCfg.root);
    }
  }

  // Generate any missing secure identifiers and persist once
  let _needsSave = false;
  if (!programData.secret) {
    winston.info('Config file does not have secret.  Generating a secret and saving');
    programData.secret = await asyncRandom(128);
    _needsSave = true;
  }
  if (!programData.instanceId) {
    programData.instanceId = crypto.randomUUID();
    _needsSave = true;
  }
  // Older auth middleware wrote these per-request fields onto the live user object, which then got saved.
  for (const user of Object.values(programData.users || {})) {
    for (const key of ['username', 'dbVpaths']) {
      if (key in user) { delete user[key]; _needsSave = true; }
    }
  }
  if (_needsSave) {
    await writeJsonAtomic(configFileArg, programData);
  }

  program = await schema.validateAsync(programData, { allowUnknown: true });
}

let isHttps = false;
export function getIsHttps() {
  return isHttps;
}

export function setIsHttps(isIt) {
  isHttps = isIt;
}
