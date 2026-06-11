/**
 * Smart Playlist — API Routes
 *
 * User endpoints (beta-gated):
 *   GET  /api/v1/smartplaylist/generated          — fetch playlist for current (or requested) time slot
 *   POST /api/v1/smartplaylist/save-as-playlist   — save slot playlist as a regular playlist
 *
 * Admin endpoints (admin middleware already applied by adminApi.setup):
 *   GET  /api/v1/admin/smartplaylist/status       — feature status + per-user profile stats
 *   POST /api/v1/admin/smartplaylist/generate     — trigger generation immediately
 *   POST /api/v1/admin/smartplaylist/reset-profiles — clear EMA profiles for a user
 */

import Joi from 'joi';
import { BETA_SMART_PLAYLIST } from '../beta-flags.js';
import * as db from '../db/sqlite-backend.js';
import { currentSlot, triggerGeneration, startCron } from './playlist-generator.js';

const VALID_SLOTS = ['morning', 'afternoon', 'evening', 'night'];

function joiValidate(schema, data) {
  const { error, value } = schema.validate(data, { allowUnknown: false, stripUnknown: true });
  if (error) throw Object.assign(new Error(error.details[0].message), { status: 400 });
  return value;
}

export function setup(velvet) {
  // Start the hourly background cron for playlist generation
  startCron();

  // ── User: fetch generated playlist ───────────────────────────────────────
  velvet.get('/api/v1/smartplaylist/generated', (req, res) => {
    if (!BETA_SMART_PLAYLIST) {
      return res.status(501).json({ error: 'Smart Playlist feature is not enabled' });
    }
    const schema = Joi.object({
      slot: Joi.string().valid(...VALID_SLOTS).optional(),
    });
    const { slot: reqSlot } = joiValidate(schema, req.query);
    const slot = reqSlot || currentSlot();

    const row = db.spGetGeneratedPlaylist(req.user.username, slot);
    if (!row) {
      return res.json({ slot, tracks: [], generated_at: null, message: 'No playlist generated yet — listening more will improve results' });
    }
    let tracks;
    try { tracks = JSON.parse(row.tracks); } catch { tracks = []; }
    res.json({ slot, tracks, generated_at: row.generated_at });
  });

  // ── User: save generated playlist as a regular playlist ──────────────────
  velvet.post('/api/v1/smartplaylist/save-as-playlist', (req, res) => {
    if (!BETA_SMART_PLAYLIST) {
      return res.status(501).json({ error: 'Smart Playlist feature is not enabled' });
    }
    const schema = Joi.object({
      name: Joi.string().min(1).max(100).required(),
      slot: Joi.string().valid(...VALID_SLOTS).optional(),
    });
    const { name, slot: reqSlot } = joiValidate(schema, req.body);
    const slot = reqSlot || currentSlot();

    const row = db.spGetGeneratedPlaylist(req.user.username, slot);
    if (!row) {
      return res.status(404).json({ error: 'No generated playlist for this slot' });
    }
    let tracks;
    try { tracks = JSON.parse(row.tracks); } catch { tracks = []; }
    if (tracks.length === 0) {
      return res.status(404).json({ error: 'Generated playlist is empty' });
    }

    // Overwrite any existing playlist with this name
    db.deletePlaylist(req.user.username, name);
    for (const filepath of tracks) {
      db.createPlaylistEntry({ name, filepath, user: req.user.username });
    }
    // Sentinel null entry that marks the playlist as existing
    db.createPlaylistEntry({ name, filepath: null, user: req.user.username });
    db.saveUserDB();

    res.json({ saved: tracks.length, name });
  });

  // ── Admin: status & stats ─────────────────────────────────────────────────
  velvet.get('/api/v1/admin/smartplaylist/status', (req, res) => {
    const stats = db.spGetStats();
    res.json({ enabled: BETA_SMART_PLAYLIST, stats });
  });

  // ── Admin: trigger generation now ────────────────────────────────────────
  velvet.post('/api/v1/admin/smartplaylist/generate', (_req, res) => {
    triggerGeneration();
    res.json({ ok: true, message: 'Generation triggered' });
  });

  // ── Admin: reset slot profiles for a user ────────────────────────────────
  velvet.post('/api/v1/admin/smartplaylist/reset-profiles', (req, res) => {
    const schema = Joi.object({
      userId: Joi.string().optional(),
    });
    const { userId } = joiValidate(schema, req.body);
    const target = userId || req.user.username;
    db.spResetProfiles(target);
    res.json({ ok: true, userId: target });
  });
}
