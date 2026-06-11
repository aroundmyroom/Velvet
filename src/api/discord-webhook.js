import fs from 'node:fs/promises';
import https from 'node:https';
import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { getVPathInfo } from '../util/vpath.js';

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
  velvet.post('/api/v1/discord-webhook/scrobble-by-filepath', async (req, res) => {
    const schema = Joi.object({ filePath: Joi.string().required() });
    joiValidate(schema, req.body);

    if (config.program.discordWebhook?.enabled !== true) return res.json({ sent: false });
    if (!req.user['discord-webhook-enabled']) return res.json({ sent: false });

    // Resolve filepath — with child-vpath fallback (same as scrobbler.js pattern)
    const pathInfo = getVPathInfo(req.body.filePath, req.user);
    let dbFileInfo = db.findFileByPath(pathInfo.relativePath, pathInfo.vpath);
    if (!dbFileInfo) {
      const folders = config.program?.folders || {};
      const myRoot  = folders[pathInfo.vpath]?.root.replace(/\/?$/, '/');
      if (myRoot) {
        for (const [parentKey, parentFolder] of Object.entries(folders)) {
          if (parentKey === pathInfo.vpath) continue;
          if (!req.user.vpaths.includes(parentKey)) continue;
          const parentRoot = parentFolder.root.replace(/\/?$/, '/');
          if (myRoot.startsWith(parentRoot) && myRoot !== parentRoot) {
            const prefix = myRoot.slice(parentRoot.length);
            dbFileInfo = db.findFileByPath(prefix + pathInfo.relativePath, parentKey);
            if (dbFileInfo) break;
          }
        }
      }
    }
    if (!dbFileInfo) return res.json({ sent: false });

    res.json({ sent: true });

    sendDiscordScrobble(req.user, {
      artist: dbFileInfo.artist,
      album:  dbFileInfo.album,
      track:  dbFileInfo.title,
    }).catch((err) => winston.warn('[discord-webhook] scrobble error: ' + err.message));
  });
}
