import fs from 'node:fs/promises';
import https from 'node:https';
import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import { joiValidate } from '../util/validation.js';
import { findUserFile } from './scrobbler.js';

// ── Deterministic fun nick from username ────────────────────────────────────
const ADJECTIVES = ['Cosmic','Velvet','Groovy','Mellow','Electric','Funky','Dreamy','Neon','Crystal','Golden','Jazzy','Sonic','Stellar','Midnight','Vivid'];
const NOUNS      = ['Listener','Groover','Spinner','Wave','Beat','Rhythm','Melody','Sound','Note','Vibe','Tune','Groove','Echo','Pulse','Tempo'];

function deterministicNick(username) {
  let h = 0;
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.codePointAt(i)) >>> 0;
  return ADJECTIVES[h % ADJECTIVES.length] + NOUNS[(h >> 8) % NOUNS.length];
}

function getDisplayNick(user) {
  const custom = (user['discord-webhook-nick'] || '').trim();
  if (custom) return custom;
  return deterministicNick(user.username || 'listener');
}

// ── Send one message to the configured Discord webhook ──────────────────────
export async function sendDiscordScrobble(user, { artist, album, track }) {
  if (config.program.discordWebhook?.enabled !== true) return;
  if (!user['discord-webhook-enabled']) return;

  const webhookUrl = config.program.discordWebhook?.url;
  if (!webhookUrl) return;

  // Security: only allow discord.com webhook URLs (prevent SSRF)
  let parsed;
  try { parsed = new URL(webhookUrl); } catch {
    winston.warn('[discord-webhook] invalid webhook URL configured, skipping');
    return;
  }
  if (parsed.hostname !== 'discord.com' && parsed.hostname !== 'discordapp.com') {
    winston.warn('[discord-webhook] rejecting non-Discord hostname: ' + parsed.hostname);
    return;
  }

  const nick = getDisplayNick(user);
  const fields = [];
  if (artist) fields.push({ name: 'Artist', value: artist, inline: true });
  if (album)  fields.push({ name: 'Album',  value: album,  inline: true });

  const embed = {
    title:     track || 'Unknown Track',
    color:     0x5865F2,  // Discord blurple
    fields,
    footer:    { text: `🎵 ${nick} is listening` },
    timestamp: new Date().toISOString(),
  };

  const body = JSON.stringify({ embeds: [embed] });
  const opts = {
    hostname: parsed.hostname,
    path:     parsed.pathname + (parsed.search || ''),
    method:   'POST',
    headers:  {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  await new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', (err) => {
      winston.warn('[discord-webhook] POST failed: ' + err.message);
      resolve();
    });
    req.write(body);
    req.end();
  });
}

/** The Discord post for a song played 30 s. -> false when it is not sent (switched off, unknown file). */
export function discordScrobbleByFilepath(user, filePath) {
  if (config.program.discordWebhook?.enabled !== true) return false;
  if (!user['discord-webhook-enabled']) return false;
  const file = findUserFile(filePath, user);
  if (!file) return false;
  sendDiscordScrobble(user, { artist: file.artist, album: file.album, track: file.title })
    .catch((err) => winston.warn('[discord-webhook] scrobble error: ' + err.message));
  return true;
}

// ── Express routes ───────────────────────────────────────────────────────────
export function setup(velvet) {

  // Status — tells the client whether the feature is server-enabled and
  // whether the current user has opted in, plus their current nick.
  velvet.get('/api/v1/discord-webhook/status', (req, res) => {
    res.json({
      serverEnabled:  config.program.discordWebhook?.enabled === true,
      webhookEnabled: req.user['discord-webhook-enabled'] === true,
      nick:           req.user['discord-webhook-nick'] || '',
    });
  });

  // User opt-in/out + optional nick — saved to config file immediately.
  velvet.post('/api/v1/discord-webhook/save', async (req, res) => {
    const schema = Joi.object({
      enabled: Joi.boolean().required(),
      nick:    Joi.string().allow('').max(64).optional(),
    });
    joiValidate(schema, req.body);

    const loadConfig = JSON.parse(await fs.readFile(config.configFile, 'utf-8'));
    if (!loadConfig.users) loadConfig.users = {};
    if (!loadConfig.users[req.user.username]) loadConfig.users[req.user.username] = {};
    loadConfig.users[req.user.username]['discord-webhook-enabled'] = req.body.enabled;
    if (req.body.nick !== undefined) {
      loadConfig.users[req.user.username]['discord-webhook-nick'] = req.body.nick;
    }
    await fs.writeFile(config.configFile, JSON.stringify(loadConfig, null, 2), 'utf8');

    config.program.users[req.user.username]['discord-webhook-enabled'] = req.body.enabled;
    if (req.body.nick !== undefined) {
      config.program.users[req.user.username]['discord-webhook-nick'] = req.body.nick;
    }

    res.json({});
  });

  // Scrobble endpoint — called from the client 30 s after playback starts,
  // same pattern as /api/v1/lastfm/scrobble-by-filepath.
  velvet.post('/api/v1/discord-webhook/scrobble-by-filepath', (req, res) => {
    const schema = Joi.object({ filePath: Joi.string().required() });
    joiValidate(schema, req.body);

    res.json({ sent: discordScrobbleByFilepath(req.user, req.body.filePath) });
  });
}
