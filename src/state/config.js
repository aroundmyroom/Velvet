import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import Joi from 'joi';
import winston from 'winston';
import { getDirname } from '../util/esm-helpers.js';
import { getTransAlgos, getTransCodecs, getTransBitrates } from '../api/transcode.js';

const __dirname = getDirname(import.meta.url);

const storageJoi = Joi.object({
  albumArtDirectory: Joi.string().default(path.join(__dirname, '../../image-cache')),
  waveformDirectory: Joi.string().default(path.join(__dirname, '../../waveform-cache')),
  dbDirectory: Joi.string().default(path.join(__dirname, '../../save/db')),
  logsDirectory: Joi.string().default(path.join(__dirname, '../../save/logs')),
  syncConfigDirectory:  Joi.string().default(path.join(__dirname, '../../save/sync')),
});

const scanOptions = Joi.object({
  skipImg: Joi.boolean().default(false),
  scanInterval: Joi.number().min(0).default(24),
  scanStartTime: Joi.string().pattern(/^\d{1,2}:\d{2}$/).allow(null, '').default(null),
  saveInterval: Joi.number().default(250),
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

const rpnOptions = Joi.object({
  iniFile: Joi.string().default(path.join(__dirname, `../../bin/rpn/frps.ini`)),
  apiUrl: Joi.string().default('https://api.velvet.io'),
  email: Joi.string().allow('').optional(),
  password: Joi.string().allow('').optional(),
  token: Joi.string().optional(),
  url: Joi.string().optional()
});

const lastFMOptions = Joi.object({
  enabled:   Joi.boolean().default(true),
  apiKey:    Joi.string().allow('').default(''),
  apiSecret: Joi.string().allow('').default('')
});

const listenBrainzOptions = Joi.object({
  enabled: Joi.boolean().default(false),
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

const federationOptions = Joi.object({
  enabled: Joi.boolean().default(false),
  folder: Joi.string().optional(),
  federateUsersMode: Joi.boolean().default(false),
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
  knownIps:    Joi.array().items(Joi.string()).default([]),
  defaultRoom: Joi.object({
    name: Joi.string().allow('').default(''),
    ip:   Joi.string().allow('').default(''),
    uuid: Joi.string().allow('').default(''),
  }).optional().allow(null).default(null),
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
  discordWebhook: discordWebhookOptions.default(discordWebhookOptions.validate({}).value),
  discogs: discogsOptions.default(discogsOptions.validate({}).value),
  scanOptions: scanOptions.default(scanOptions.validate({}).value),
  noUpload: Joi.boolean().default(false),
  writeLogs: Joi.boolean().default(false),
  logRetention: Joi.string().valid('1d', '3d', '7d', '14d', '30d').default('14d'),
  lockAdmin: Joi.boolean().default(false),
  storage: storageJoi.default(storageJoi.validate({}).value),
  webAppDirectory: Joi.string().default(path.join(__dirname, '../../webapp')),
  rpn: rpnOptions.default(rpnOptions.validate({}).value),
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
    })
  ).default({}),
  ssl: Joi.object({
    key: Joi.string().allow('').optional(),
    cert: Joi.string().allow('').optional()
  }).optional(),
  federation: federationOptions.default(federationOptions.validate({}).value),
  serverAudio: serverAudioOptions.default(serverAudioOptions.validate({}).value),
  acoustid: acoustidOptions.default(acoustidOptions.validate({}).value),
  dlna: dlnaOptions.default(dlnaOptions.validate({}).value),
  sonos: sonosOptions.default(sonosOptions.validate({}).value),
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

export async function setup(configFileArg) {
  // Create config directory + file if they don't exist
  try {
    await fs.access(configFileArg);
  } catch {
    winston.info('Config File does not exist. Attempting to create file');
    await fs.mkdir(path.dirname(configFileArg), { recursive: true });
    await fs.writeFile(configFileArg, JSON.stringify({}), 'utf8');
  }

  const programData = JSON.parse(await fs.readFile(configFileArg, 'utf8'));
  configFile = configFileArg;

  // Verify paths are real; auto-create app-managed folders (recordings/youtube)
  for (const folder in programData.folders) {
    const folderCfg = programData.folders[folder];
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
  if (_needsSave) {
    await fs.writeFile(configFileArg, JSON.stringify(programData, null, 2), 'utf8');
  }

  program = await schema.validateAsync(programData, { allowUnknown: true });
}

export function getDefaults() {
  const { value } = schema.validate({});
  return value;
}

export async function testValidation(validateThis) {
  await schema.validateAsync(validateThis, { allowUnknown: true });
}

let isHttps = false;
export function getIsHttps() {
  return isHttps;
}

export function setIsHttps(isIt) {
  isHttps = isIt;
}
