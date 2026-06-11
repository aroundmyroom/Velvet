import fs from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import Joi from 'joi';
import winston from 'winston';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { getVPathInfo } from '../util/vpath.js';

// Maximum number of custom webhook slots the admin can configure.
const MAX_SLOTS = 2;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Return the per-slot user-config keys. */
function userKey(slot, field) {
  return `custom-webhook-${slot}-${field}`;
}

/** Safely get the configured webhook slots array. Always returns length <= MAX_SLOTS. */
function getSlots() {
  const raw = config.program.customWebhooks;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_SLOTS).map(s => ({
    name:    String(s.name    || '').slice(0, 64),
    url:     String(s.url     || ''),
    enabled: s.enabled === true,
  }));
}

// ── Scrobble sender ──────────────────────────────────────────────────────────

/**
 * POST a scrobble notification to the custom webhook at slotIndex.
 * Payload: { event, artist, album, track, username, timestamp }
 */
export async function sendCustomWebhookScrobble(user, { artist, album, track }, slotIndex) {
  const slots = getSlots();
  const slot  = slots[slotIndex];
  if (!slot || !slot.enabled || !slot.url) return;
  if (!user[userKey(slotIndex, 'enabled')]) return;

  let parsed;
  try { parsed = new URL(slot.url); } catch {
    winston.warn(`[custom-webhooks] slot ${slotIndex}: invalid URL, skipping`);
    return;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    winston.warn(`[custom-webhooks] slot ${slotIndex}: only http/https URLs are allowed`);
    return;
  }

  const nick = (user[userKey(slotIndex, 'nick')] || '').trim() || user.username || 'listener';

  const payload = JSON.stringify({
    event:     'scrobble',
    artist:    artist  || null,
    album:     album   || null,
    track:     track   || null,
    username:  nick,
    timestamp: new Date().toISOString(),
  });

  const useHttps = parsed.protocol === 'https:';
  const transport = useHttps ? https : http;
  const opts = {
    hostname: parsed.hostname,
    port:     parsed.port || (useHttps ? 443 : 80),
    path:     parsed.pathname + (parsed.search || ''),
    method:   'POST',
    headers:  {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  await new Promise((resolve) => {
    const req = transport.request(opts, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', (err) => {
      winston.warn(`[custom-webhooks] slot ${slotIndex} POST failed: ${err.message}`);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

// ── Express routes ───────────────────────────────────────────────────────────
export function setup(velvet) {

  // ── User: status ─────────────────────────────────────────────────────────
  // Returns per-slot status: name, serverEnabled, userEnabled, nick.
  velvet.get('/api/v1/custom-webhooks/status', (req, res) => {
    const slots = getSlots();
    res.json({
      webhooks: slots.map((s, i) => ({
        name:          s.name,
        serverEnabled: s.enabled,
        userEnabled:   req.user[userKey(i, 'enabled')] === true,
        nick:          req.user[userKey(i, 'nick')] || '',
      })),
    });
  });

  // ── User: save per-slot preference ───────────────────────────────────────
  velvet.post('/api/v1/custom-webhooks/save', async (req, res) => {
    const schema = Joi.object({
      slot:    Joi.number().integer().min(0).max(MAX_SLOTS - 1).required(),
      enabled: Joi.boolean().required(),
      nick:    Joi.string().allow('').max(64).optional(),
    });
    joiValidate(schema, req.body);

    const slotIndex = req.body.slot;
    const loadConfig = JSON.parse(await fs.readFile(config.configFile, 'utf-8'));
    if (!loadConfig.users) loadConfig.users = {};
    if (!loadConfig.users[req.user.username]) loadConfig.users[req.user.username] = {};
    loadConfig.users[req.user.username][userKey(slotIndex, 'enabled')] = req.body.enabled;
    if (req.body.nick !== undefined) {
      loadConfig.users[req.user.username][userKey(slotIndex, 'nick')] = req.body.nick;
    }
    await fs.writeFile(config.configFile, JSON.stringify(loadConfig, null, 2), 'utf8');

    config.program.users[req.user.username][userKey(slotIndex, 'enabled')] = req.body.enabled;
    if (req.body.nick !== undefined) {
      config.program.users[req.user.username][userKey(slotIndex, 'nick')] = req.body.nick;
    }

    res.json({});
  });

  // ── User: fire scrobble ───────────────────────────────────────────────────
  velvet.post('/api/v1/custom-webhooks/scrobble-by-filepath', async (req, res) => {
    const schema = Joi.object({
      filePath: Joi.string().required(),
      slot:     Joi.number().integer().min(0).max(MAX_SLOTS - 1).required(),
    });
    joiValidate(schema, req.body);

    const slotIndex = req.body.slot;
    const slots = getSlots();
    if (!slots[slotIndex]?.enabled) return res.json({ sent: false });
    if (!req.user[userKey(slotIndex, 'enabled')]) return res.json({ sent: false });

    // Resolve filepath — with child-vpath fallback (same as discord-webhook.js pattern)
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

    sendCustomWebhookScrobble(req.user, {
      artist: dbFileInfo.artist,
      album:  dbFileInfo.album,
      track:  dbFileInfo.title,
    }, slotIndex).catch((err) => winston.warn(`[custom-webhooks] scrobble error: ${err.message}`));
  });
}
