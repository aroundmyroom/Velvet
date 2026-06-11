import fsp from 'node:fs/promises';
import { nanoid } from 'nanoid';
import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { startStreamRecording, stopStreamRecording } from './radio-recorder.js';

const TICK_MS       = 30_000;
const FIRE_WINDOW_MS = TICK_MS + 10_000; // accept up to 40 s late

// scheduleId → recordingId (currently active scheduled recordings)
const scheduledActive = new Map();

import { isPrivateHost } from '../util/ssrf-check.js';

// ── Next-fire-time calculator ─────────────────────────────────────────────────
function _nextFireOnce(sched, hh, mm) {
  if (!sched.start_date) return null;
  const t = new Date(`${sched.start_date}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00`);
  return Number.isNaN(t.getTime()) ? null : t.getTime();
}

function _matchesRecurrence(sched, days, day) {
  if (sched.recurrence === 'daily')    return true;
  if (sched.recurrence === 'weekdays') return day >= 1 && day <= 5;
  if (sched.recurrence === 'custom')   return days.includes(day);
  return false;
}

function _nextFireMs(sched) {
  const [hh, mm] = sched.start_time.split(':').map(Number);
  if (sched.recurrence === 'once') return _nextFireOnce(sched, hh, mm);

  // Recurring — scan the next 8 days to find the next matching slot
  let days;
  if (sched.recurrence === 'custom') {
    try { days = JSON.parse(sched.recur_days || '[]'); } catch { days = []; }
  }

  const now  = Date.now();
  const base = new Date();
  base.setHours(hh, mm, 0, 0);

  for (let d = 0; d < 8; d++) {
    const cand    = new Date(base.getTime() + d * 86400000);
    const candMs  = cand.getTime();
    const day     = cand.getDay(); // 0=Sun … 6=Sat

    // Skip slots already past (beyond fire window on the first day)
    if (d === 0 && candMs < now - FIRE_WINDOW_MS) continue;
    if (_matchesRecurrence(sched, days, day)) return candMs;
  }

  return null;
}

// ── Scheduler tick ────────────────────────────────────────────────────────────
async function _tick() {
  const now = Date.now();
  let schedules;
  try { schedules = db.getAllEnabledRadioSchedules(); } catch { return; }

  for (const sched of schedules) {
    if (scheduledActive.has(sched.id)) continue;
    const fireMs = _nextFireMs(sched);
    if (fireMs === null) continue;
    const diff = fireMs - now;
    if (diff >  TICK_MS)        continue;
    if (diff < -FIRE_WINDOW_MS) continue;
    await _fireSchedule(sched);
  }
}

async function _fireSchedule(sched) {
  const folder = config.program.folders[sched.vpath];
  if (folder?.type !== 'recordings') return;

  const user = config.program.users[sched.username];
  if (user?.['allow-radio-recording'] !== true) return;
  if (!user.vpaths?.includes(sched.vpath)) return;

  try {
    if (isPrivateHost(new URL(sched.stream_url).hostname)) {
      console.warn(`[scheduler] SSRF blocked for schedule ${sched.id}`); return;
    }
  } catch { return; }

  try { await fsp.mkdir(folder.root, { recursive: true }); } catch (e) { console.debug('[velvet]', e?.message ?? e); }

  console.info(`[scheduler] Starting scheduled recording for ${sched.username}: "${sched.station_name}"`);

  try {
    const result = await startStreamRecording({
      username:        sched.username,
      url:             sched.stream_url,
      vpath:           sched.vpath,
      recordDir:       folder.root,
      stationName:     sched.station_name,
      artFile:         sched.art_file || null,
      durationMinutes: sched.duration_min,
      description:     sched.description || null,
    });

    scheduledActive.set(sched.id, {
      recordingId: result.id, stationName: sched.station_name,
      username: sched.username, startedAt: Date.now(), durationMin: sched.duration_min,
    });

    setTimeout(() => {
      scheduledActive.delete(sched.id);
      if (sched.recurrence === 'once') {
        try { db.toggleRadioScheduleById(sched.id, 0); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      }
    }, sched.duration_min * 60000 + 5000);

  } catch (err) {
    console.error(`[scheduler] Failed to start scheduled recording ${sched.id}: ${err.message}`);
  }
}

// ── Start background ticker ───────────────────────────────────────────────────
let _tickInterval = null;
function _startTicker() {
  if (_tickInterval) return;
  setTimeout(() => {
    _tick().catch(() => {});
    _tickInterval = setInterval(() => _tick().catch(() => {}), TICK_MS);
  }, 5000);
}

// ── HTTP API ──────────────────────────────────────────────────────────────────
export function setup(velvet) {
  _startTicker();

  // GET /api/v1/radio/schedules/active — lightweight poll for in-progress scheduled recordings
  velvet.get('/api/v1/radio/schedules/active', (req, res) => {
    if (!req.user['allow-radio-recording']) return res.json([]);
    const result = [];
    for (const [schedId, info] of scheduledActive) {
      if (info.username === req.user.username) {
        result.push({
          scheduleId:  schedId,
          stationName: info.stationName,
          startedAt:   info.startedAt,
          durationMin: info.durationMin,
        });
      }
    }
    res.json(result);
  });

  // GET /api/v1/radio/schedules — list user's schedules
  velvet.get('/api/v1/radio/schedules', (req, res) => {
    if (!req.user['allow-radio-recording']) return res.status(403).json({ error: 'Recording not enabled for this user' });
    try {
      const rows = db.getRadioSchedules(req.user.username);
      res.json(rows.map(r => ({
        id:              r.id,
        stationName:     r.station_name,
        streamUrl:       r.stream_url,
        artFile:         r.art_file,
        vpath:           r.vpath,
        startTime:       r.start_time,
        startDate:       r.start_date,
        durationMinutes: r.duration_min,
        recurrence:      r.recurrence,
        recurDays:       r.recur_days ? JSON.parse(r.recur_days) : null,
        enabled:         r.enabled === 1,
        createdAt:       r.created_at,
        active:          scheduledActive.has(r.id),
      })));
    } catch (err) {
      console.error('[scheduler] GET schedules failed:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // POST /api/v1/radio/schedules — create a schedule
  velvet.post('/api/v1/radio/schedules', (req, res) => {
    if (!req.user['allow-radio-recording']) return res.status(403).json({ error: 'Recording not enabled for this user' });

    const schema = Joi.object({
      stationName:     Joi.string().max(120).required(),
      streamUrl:       Joi.string().uri({ scheme: ['http', 'https'] }).required(),
      artFile:         Joi.string().max(200).pattern(/^[^/\\]+$/).allow(null, '').optional(),
      vpath:           Joi.string().required(),
      startTime:       Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
      startDate:       Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow(null, '').optional(),
      durationMinutes: Joi.number().integer().min(1).max(1440).required(),
      recurrence:      Joi.string().valid('once', 'daily', 'weekdays', 'custom').default('once'),
      recurDays:       Joi.array().items(Joi.number().integer().min(0).max(6)).max(7).allow(null).optional(),
      description:     Joi.string().max(80).allow(null, '').optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    // Validate vpath access + type
    const folder = config.program.folders[value.vpath];
    if (!folder) return res.status(400).json({ error: 'Unknown vpath' });
    if (!req.user.vpaths?.includes(value.vpath)) return res.status(403).json({ error: 'Access denied to this vpath' });
    if (folder.type !== 'recordings') return res.status(400).json({ error: 'Target folder must be a Recordings folder' });

    // SSRF protection
    let parsed;
    try { parsed = new URL(value.streamUrl); } catch { return res.status(400).json({ error: 'Invalid stream URL' }); }
    if (isPrivateHost(parsed.hostname)) return res.status(403).json({ error: 'SSRF protection: private/loopback addresses not allowed' });

    // startDate required for once
    if (value.recurrence === 'once' && !value.startDate) {
      return res.status(400).json({ error: 'startDate required for one-time schedules' });
    }

    try {
      const id = db.createRadioSchedule({
        id:           nanoid(10),
        username:     req.user.username,
        station_name: value.stationName,
        stream_url:   value.streamUrl,
        art_file:     value.artFile || null,
        vpath:        value.vpath,
        start_time:   value.startTime,
        start_date:   value.startDate || null,
        duration_min: value.durationMinutes,
        recurrence:   value.recurrence,
        recur_days:   value.recurDays ? JSON.stringify(value.recurDays) : null,
        description:  value.description || null,
        created_at:   Date.now(),
      });
      res.json({ id });
    } catch (err) {
      console.error('[scheduler] create schedule failed:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // DELETE /api/v1/radio/schedules/:id — remove a schedule
  velvet.delete('/api/v1/radio/schedules/:id', (req, res) => {
    if (!req.user['allow-radio-recording']) return res.status(403).json({ error: 'Recording not enabled for this user' });

    const id = req.params.id;
    // If the schedule is currently recording, stop it
    const info = scheduledActive.get(id);
    if (info) { stopStreamRecording(info.recordingId).catch(() => {}); scheduledActive.delete(id); }

    try {
      const deleted = db.deleteRadioSchedule(id, req.user.username);
      if (!deleted) return res.status(404).json({ error: 'Schedule not found' });
      res.json({});
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // PATCH /api/v1/radio/schedules/:id/enable — toggle enabled state
  velvet.patch('/api/v1/radio/schedules/:id/enable', (req, res) => {
    if (!req.user['allow-radio-recording']) return res.status(403).json({ error: 'Recording not enabled for this user' });

    const schema = Joi.object({ enabled: Joi.boolean().required() });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    try {
      const ok = db.toggleRadioSchedule(req.params.id, req.user.username, value.enabled ? 1 : 0);
      if (!ok) return res.status(404).json({ error: 'Schedule not found' });
      res.json({});
    } catch {
      res.status(500).json({ error: 'Internal error' });
    }
  });
}
