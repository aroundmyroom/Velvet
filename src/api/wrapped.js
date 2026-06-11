/**
 * Wrapped — listening statistics event collector + stats API
 *
 * Play-event lifecycle:
 *   play-start  → INSERT play_events row, UPSERT listening_sessions → returns { eventId }
 *   play-end    → UPDATE: ended naturally  (completed flag auto-computed)
 *   play-skip   → UPDATE: skipped before 30 % of track
 *   play-stop   → UPDATE: tab close / explicit stop (no skip/complete flags)
 *   session-end → UPDATE listening_sessions.ended_at
 *
 * Stats endpoints (GET):
 *   /api/v1/user/wrapped?period=monthly&offset=0   → full stats object
 *   /api/v1/user/wrapped/periods                   → available period buckets
 */

import Joi from 'joi';
import * as vpath from '../util/vpath.js';
import * as db from '../db/manager.js';
import * as config from '../state/config.js';
import { joiValidate } from '../util/validation.js';
import { getWrappedStats, getPeriodBounds } from '../db/wrapped-stats.mjs';
import { indexFileOnDemand } from '../util/on-demand-index.js';
import { BETA_SMART_PLAYLIST } from '../beta-flags.js';
import { triggerGeneration } from '../smartplaylist/playlist-generator.js';

// Debounce: trigger ML generation at most once per 2 minutes after a completed play
let _spGenTimer = null;
function _scheduleSpGen() {
  if (!BETA_SMART_PLAYLIST || _spGenTimer) return;
  _spGenTimer = setTimeout(() => { _spGenTimer = null; triggerGeneration(); }, 2 * 60 * 1000);
}

// ── helpers ────────────────────────────────────────────────────────────────────

function resolveFileRow(filePath, user) {
  if (!filePath || /^https?:\/\//i.test(filePath)) return null;
  const pathInfo = vpath.getVPathInfo(filePath, user);
  let result = db.findFileByPath(pathInfo.relativePath, pathInfo.vpath);
  if (!result) {
    const folders = config.program?.folders || {};
    const myRoot  = folders[pathInfo.vpath]?.root.replace(/\/?$/, '/');
    if (myRoot) {
      for (const [parentKey, parentFolder] of Object.entries(folders)) {
        if (parentKey === pathInfo.vpath) continue;
        if (!user.vpaths.includes(parentKey)) continue;
        const parentRoot = parentFolder.root.replace(/\/?$/, '/');
        if (myRoot.startsWith(parentRoot) && myRoot !== parentRoot) {
          const prefix = myRoot.slice(parentRoot.length);
          result = db.findFileByPath(prefix + pathInfo.relativePath, parentKey);
          if (result) break;
        }
      }
    }
  }
  return result;
}

// ── setup ──────────────────────────────────────────────────────────────────────

export function setup(velvet) {

  // ── play-start ─────────────────────────────────────────────────────────────
  velvet.post('/api/v1/wrapped/play-start', async (req, res) => {
    const schema = Joi.object({
      filePath:  Joi.string().required(),
      sessionId: Joi.string().max(64).required(),
      source:    Joi.string().valid('manual','queue','shuffle','autodj','playlist','smart-playlist').default('manual'),
    });
    joiValidate(schema, req.body);

    let fileRow = resolveFileRow(req.body.filePath, req.user);
    if (!fileRow) {
      try {
        const pathInfo = vpath.getVPathInfo(req.body.filePath, req.user);
        fileRow = await indexFileOnDemand(pathInfo); // NOSONAR — indexFileOnDemand is async
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    }
    if (!fileRow) { return res.json({ ok: false }); }

    const userId     = req.user.username;
    const now        = Date.now();
    const durationMs = fileRow.duration ? Math.round(fileRow.duration * 1000) : null;

    // Deduplicate page-reload resumes: find the most recent event for this
    // user+song within 10 minutes. If it was NOT completed (song was interrupted
    // by a reload or tab close), reuse that row. If it WAS completed, the user
    // genuinely replayed the song — allow a new row.
    const DEDUP_WINDOW_MS = 10 * 60 * 1000;
    const recent = db.findRecentPlayEvent(userId, fileRow.hash, DEDUP_WINDOW_MS);
    if (recent && !recent.completed) { return res.json({ ok: true, eventId: recent.id }); }

    const eventId = db.insertPlayEvent({
      user_id:    userId,
      file_hash:  fileRow.hash,
      started_at: now,
      duration_ms: durationMs,
      source:      req.body.source,
      session_id:  req.body.sessionId,
    });

    db.upsertListeningSession({
      session_id: req.body.sessionId,
      user_id:    userId,
      started_at: now,
    });

    return res.json({ ok: true, eventId });
  });

  // ── play-end (natural completion) ──────────────────────────────────────────
  velvet.post('/api/v1/wrapped/play-end', (req, res) => {
    const schema = Joi.object({
      eventId:  Joi.number().integer().positive().required(),
      playedMs: Joi.number().integer().min(0).required(),
    });
    joiValidate(schema, req.body);

    // Fetch the event to compute completed flag (played_ms >= 90% of duration_ms)
    const row = db.getPlayEventById(req.body.eventId, req.user.username);
    const completed = row?.duration_ms
      ? req.body.playedMs >= row.duration_ms * 0.9
      : false;

    db.updatePlayEvent(req.body.eventId, req.user.username, {
      ended_at:  Date.now(),
      played_ms: req.body.playedMs,
      completed,
      skipped:   false,
    });

    if (completed) _scheduleSpGen();

    return res.json({ ok: true });
  });

  // ── play-pause (user-initiated pause — increments pause counter) ───────────
  velvet.post('/api/v1/wrapped/pause', (req, res) => {
    const schema = Joi.object({
      eventId: Joi.number().integer().positive().required(),
    });
    joiValidate(schema, req.body);
    db.incrementPauseCount(req.body.eventId, req.user.username);
    return res.json({ ok: true });
  });

  // ── play-skip ──────────────────────────────────────────────────────────────
  velvet.post('/api/v1/wrapped/play-skip', (req, res) => {
    const schema = Joi.object({
      eventId:  Joi.number().integer().positive().required(),
      playedMs: Joi.number().integer().min(0).required(),
    });
    joiValidate(schema, req.body);

    db.updatePlayEvent(req.body.eventId, req.user.username, {
      ended_at:  Date.now(),
      played_ms: req.body.playedMs,
      completed: false,
      skipped:   true,
    });

    return res.json({ ok: true });
  });

  // ── play-stop (tab close / explicit stop — no semantic flag) ───────────────
  velvet.post('/api/v1/wrapped/play-stop', (req, res) => {
    const schema = Joi.object({
      eventId:  Joi.number().integer().positive().required(),
      playedMs: Joi.number().integer().min(0).required(),
    });
    joiValidate(schema, req.body);

    const row = db.getPlayEventById(req.body.eventId, req.user.username);
    const completed = row?.duration_ms
      ? req.body.playedMs >= row.duration_ms * 0.9
      : false;

    db.updatePlayEvent(req.body.eventId, req.user.username, {
      ended_at:  Date.now(),
      played_ms: req.body.playedMs,
      completed,
      skipped:   false,
    });

    return res.json({ ok: true });
  });

  // ── session-end ────────────────────────────────────────────────────────────
  velvet.post('/api/v1/wrapped/session-end', (req, res) => {
    const schema = Joi.object({
      sessionId: Joi.string().max(64).required(),
    });
    joiValidate(schema, req.body);

    db.updateListeningSession(req.body.sessionId, req.user.username, {
      ended_at: Date.now(),
    });

    return res.json({ ok: true });
  });

  // ── GET user stats ─────────────────────────────────────────────────────────
  velvet.get('/api/v1/user/wrapped', async (req, res) => {
    const schema = Joi.object({
      period: Joi.string().valid('weekly','monthly','quarterly','half-yearly','yearly').default('monthly'),
      offset: Joi.number().integer().min(-260).max(0).default(0),
    });
    joiValidate(schema, req.query);

    const { from, to, label } = getPeriodBounds(req.query.period, req.query.offset);
    const stats = await getWrappedStats(req.user.username, from, to, req.user.vpaths);
    return res.json({ ...stats, period_label: label, from_ms: from, to_ms: to, generated_at: Date.now() });
  });

  // ── GET available periods ──────────────────────────────────────────────────
  velvet.get('/api/v1/user/wrapped/periods', (req, res) => {
    const rows = db.getWrappedPeriods(req.user.username);
    return res.json({ periods: rows });
  });

  // ── radio-start ────────────────────────────────────────────────────────────
  velvet.post('/api/v1/wrapped/radio-start', (req, res) => {
    const schema = Joi.object({
      stationName: Joi.string().max(200).required(),
      stationId:   Joi.number().integer().optional().allow(null),
      sessionId:   Joi.string().max(64).required(),
    });
    joiValidate(schema, req.body);

    const eventId = db.insertRadioPlayEvent({
      user_id:      req.user.username,
      station_id:   req.body.stationId ?? null,
      station_name: req.body.stationName,
      started_at:   Date.now(),
      session_id:   req.body.sessionId,
    });
    return res.json({ ok: true, eventId });
  });

  // ── radio-stop ─────────────────────────────────────────────────────────────
  velvet.post('/api/v1/wrapped/radio-stop', (req, res) => {
    const schema = Joi.object({
      eventId:    Joi.number().integer().required(),
      listenedMs: Joi.number().integer().min(0).default(0),
    });
    joiValidate(schema, req.body);

    db.updateRadioPlayEvent(req.body.eventId, req.user.username, {
      ended_at:   Date.now(),
      listened_ms: Number.parseInt(req.body.listenedMs, 10) || 0,
    });
    return res.json({ ok: true });
  });

  // ── podcast-start ──────────────────────────────────────────────────────────
  velvet.post('/api/v1/wrapped/podcast-start', (req, res) => {
    const schema = Joi.object({
      episodeId: Joi.number().integer().required(),
      feedId:    Joi.number().integer().required(),
      sessionId: Joi.string().max(64).required(),
    });
    joiValidate(schema, req.body);

    const eventId = db.insertPodcastPlayEvent({
      user_id:    req.user.username,
      episode_id: req.body.episodeId,
      feed_id:    req.body.feedId,
      started_at: Date.now(),
      session_id: req.body.sessionId,
    });
    return res.json({ ok: true, eventId });
  });

  // ── podcast-end ────────────────────────────────────────────────────────────
  velvet.post('/api/v1/wrapped/podcast-end', (req, res) => {
    const schema = Joi.object({
      eventId:   Joi.number().integer().required(),
      playedMs:  Joi.number().integer().min(0).default(0),
      completed: Joi.boolean().default(false),
    });
    joiValidate(schema, req.body);

    db.updatePodcastPlayEvent(req.body.eventId, req.user.username, {
      ended_at:  Date.now(),
      played_ms: Number.parseInt(req.body.playedMs, 10) || 0,
      completed: req.body.completed === true,
    });
    return res.json({ ok: true });
  });

  // ── GET /api/v1/history — last 7 days of played songs ────────────────────
  velvet.get('/api/v1/history', (req, res) => {
    const DAYS = 7;
    const nowMs   = Date.now();
    const qFrom   = Number.parseInt(req.query.fromMs, 10);
    const qTo     = Number.parseInt(req.query.toMs, 10);
    const hasRange = Number.isFinite(qFrom) && Number.isFinite(qTo) && qTo > qFrom;
    const fromMs  = hasRange ? qFrom : (nowMs - DAYS * 24 * 60 * 60 * 1000);
    const toMs    = hasRange ? qTo   : null;
    const rows    = db.getHistoryEvents(req.user.username, fromMs, toMs);
    const events  = rows.map(r => ({
      id:         r.id,
      started_at: r.started_at,
      played_ms:  r.played_ms ?? 0,
      skipped:    r.skipped === 1,
      completed:  r.completed === 1,
      title:      r.title  || null,
      artist:     r.artist || null,
      album:      r.album  || null,
      aaFile:     r.aaFile || null,
      // Build full filepath for playback (vpath + '/' + relative filepath)
      filepath:   r.vpath && r.filepath ? `${r.vpath}/${r.filepath}` : null,
    })).filter(e => e.filepath);
    return res.json({ events });
  });

}
