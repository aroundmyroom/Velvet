/**
 * Smart Playlist — Playlist Generator
 *
 * Background worker that:
 *   1. Reads new play_events and updates per-user per-slot EMA profiles.
 *   2. Scores the whole library against each profile and caches the top-50
 *      tracks in sp_generated_playlists.
 *
 * Runs once 2 minutes after server start, then every hour.
 *
 * Time slots:
 *   morning   — 06:00–10:59
 *   afternoon — 11:00–16:59
 *   evening   — 17:00–21:59
 *   night     — 22:00–05:59
 */

import winston from 'winston';
import * as db from '../db/sqlite-backend.js';
import * as config from '../state/config.js';
import { extractVector, cosineSimilarity, emaUpdate } from './feature-extractor.js';
import * as broker from '../state/bg-task-broker.js';

const SLOTS             = ['morning', 'afternoon', 'evening', 'night'];
const PLAYLIST_SIZE     = 50;
const EMA_ALPHA_COMPLETE = 0.15;   // full play
const EMA_ALPHA_PARTIAL  = 0.05;   // >30 s but not completed
const MIN_PLAYS_TO_GEN   = 3;      // minimum plays before generating
const NEUTRAL_PROFILE    = Object.freeze([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);

/** Map a 0–23 hour to a slot name. */
export function hourToSlot(hour) {
  if (hour >= 6  && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

/** Current slot based on local time. */
export function currentSlot() {
  return hourToSlot(new Date().getHours());
}

/** Update EMA slot profiles for a single user from unprocessed play_events. */
function processEventsForUser(userId) {
  // Load current profiles for all 4 slots
  const profiles = {};
  for (const slot of SLOTS) {
    const row = db.spGetProfile(userId, slot);
    profiles[slot] = {
      vec:         row ? JSON.parse(row.profile) : [...NEUTRAL_PROFILE],
      playCount:   row?.play_count     ?? 0,
      lastEventId: row?.last_event_id  ?? 0,
    };
  }

  // Start from the minimum processed event ID so we never skip events
  const minLastId = Math.min(...SLOTS.map(s => profiles[s].lastEventId));
  const events    = db.spGetNewEvents(userId, minLastId);
  if (events.length === 0) return;

  for (const event of events) {
    const slot = hourToSlot(new Date(event.started_at).getHours());
    const p    = profiles[slot];

    // Already processed for this slot?
    if (event.id <= p.lastEventId) continue;

    const isComplete = event.completed === 1;
    const isPartial  = !isComplete && (event.played_ms ?? 0) > 30_000;
    if (!isComplete && !isPartial) {
      // Still advance the high-water mark so we don't revisit
      if (event.id > p.lastEventId) p.lastEventId = event.id;
      continue;
    }

    const row = db.spGetTrackFeatures(event.file_hash);
    if (!row) {
      if (event.id > p.lastEventId) p.lastEventId = event.id;
      continue;
    }

    const vec   = extractVector(row);
    const alpha = isComplete ? EMA_ALPHA_COMPLETE : EMA_ALPHA_PARTIAL;
    p.vec       = emaUpdate(p.vec, vec, alpha);
    p.playCount++;
    if (event.id > p.lastEventId) p.lastEventId = event.id;
  }

  for (const slot of SLOTS) {
    const p = profiles[slot];
    db.spUpsertProfile(userId, slot, JSON.stringify(p.vec), p.playCount, p.lastEventId);
  }
}

/** Generate and cache playlists for one user. */
function generatePlaylistsForUser(userId) {
  const userCfg = config.program.users?.[userId];
  if (!userCfg) return;
  const vpaths = Array.isArray(userCfg.vpaths) && userCfg.vpaths.length > 0
    ? userCfg.vpaths
    : Object.keys(config.program.folders ?? {});
  if (vpaths.length === 0) return;

  const tracks = db.spGetAllTracksWithFeatures(vpaths);
  if (tracks.length === 0) return;

  for (const slot of SLOTS) {
    const row = db.spGetProfile(userId, slot);
    if (!row || (row.play_count ?? 0) < MIN_PLAYS_TO_GEN) continue;

    const profile = JSON.parse(row.profile);
    const scored  = tracks.map(t => {
      const nullCount = [t.genre, t.bpm, t.musical_key, t.danceability, t.loudness].filter(v => v == null).length;
      const quality   = 1 - (nullCount / 5) * 0.5;
      return { fullpath: t.vpath + '/' + t.filepath, artist: (t.artist || '').trim().toLowerCase(), score: cosineSimilarity(profile, extractVector(t)) * quality };
    });
    scored.sort((a, b) => b.score - a.score);

    const top = _pickTopTracks(scored);
    if (top.length > 0) db.spUpsertGeneratedPlaylist(userId, slot, JSON.stringify(top));
  }
}

function _pickTopTracks(scored) {
  const seenPaths   = new Set();
  const seenArtists = new Set();
  const top = [];
  for (const t of scored) {
    if (top.length >= PLAYLIST_SIZE) break;
    if (seenPaths.has(t.fullpath)) continue;
    if (t.artist && seenArtists.has(t.artist)) continue;
    seenPaths.add(t.fullpath);
    if (t.artist) seenArtists.add(t.artist);
    top.push(t.fullpath);
  }
  return top;
}

/**
 * Inner async logic executed by the broker when the slot is free and no
 * scan is running.  Errors propagate to the broker which logs them.
 */
async function _doGeneration() {
  const t0 = Date.now();
  const userIds = db.spGetAllUserIds();
  winston.info(`[smart-playlist] Starting generation for ${userIds.length} user(s)`);

  for (const userId of userIds) {
    processEventsForUser(userId);
    generatePlaylistsForUser(userId);
    // Yield to event loop between users to avoid blocking
    await new Promise(r => setImmediate(r));
  }

  winston.info(`[smart-playlist] Generation complete in ${Date.now() - t0} ms`);
}

/**
 * Schedule a generation cycle via the background task broker.
 * Deduplicated — multiple calls before the previous cycle starts collapse
 * into one execution.  Automatically deferred if a scan is in progress.
 */
export function runGeneration() {
  broker.submit('smart-playlist', 'ML generation', _doGeneration);
}

/** Fire-and-forget alias — safe to call from routes or event handlers. */
export function triggerGeneration() {
  setImmediate(() => runGeneration());
}

/** Start the hourly cron. Called once at server boot (from routes.js setup). */
export function startCron() {
  // Initial run 2 minutes after boot (let the server finish starting)
  setTimeout(() => triggerGeneration(), 2 * 60 * 1000);
  // Then every hour
  setInterval(() => triggerGeneration(), 60 * 60 * 1000);
}
