import Joi from 'joi';
import * as db from '../db/manager.js';
import * as vpath from '../util/vpath.js';
import { joiValidate } from '../util/validation.js';
import { ENERGY, flowOrder } from '../util/ai-queue.js';

export const FLOW_MAX_SONGS = 1000;

const flowSchema = Joi.object({
  songs: Joi.array().items(Joi.string().min(1).max(4096)).min(2).max(FLOW_MAX_SONGS).required(),
  pinFirst: Joi.boolean().default(true),
  energy: Joi.string().valid(...ENERGY).default('steady'),
});

// The caller's songs as database rows, by input index; a path the caller
// cannot resolve (missing, outside their libraries, malformed) is simply absent.
function resolveRows(filepaths, user) {
  const groups = new Map();
  filepaths.forEach((fp, i) => {
    try {
      const info = vpath.getVPathInfo(fp, user);
      if (!groups.has(info.vpath)) groups.set(info.vpath, []);
      groups.get(info.vpath).push({ i, relative: info.relativePath });
    } catch {
      // unresolvable: lands in `unplaced`
    }
  });
  const rows = new Map();
  for (const [vp, entries] of groups) {
    const byRel = db.getFilesWithMetadataByPaths(entries.map(e => e.relative), vp, user.username);
    for (const e of entries) {
      const row = byRel.get(e.relative);
      if (row) rows.set(e.i, row);
    }
  }
  return rows;
}

export function setup(velvet) {
  // GET /api/v1/queue  — return the full saved queue for the authenticated user
  velvet.get('/api/v1/queue', (req, res) => {
    const username = req.user?.username || 'velvet-user';
    const settings = db.getUserSettings(username);
    res.json(settings.queue ?? null);
  });

  // POST /api/v1/queue  — save (overwrite) the queue for the authenticated user
  velvet.post('/api/v1/queue', (req, res) => {
    const username = req.user?.username || 'velvet-user';
    db.saveUserSettings(username, { queue: req.body });
    res.json({ ok: true });
  });

  // POST /api/v1/queue/flow — the given songs in an order where each flows
  // into the next. Answers a permutation of the input indices; songs the
  // caller cannot resolve come last, in their own order, as `unplaced`.
  velvet.post('/api/v1/queue/flow', (req, res) => {
    const { value: body } = joiValidate(flowSchema, req.body);
    const rows = resolveRows(body.songs, req.user);
    const placed = [...rows.keys()].sort((a, b) => a - b);
    const unplaced = body.songs.map((_, i) => i).filter(i => !rows.has(i));
    // the pinned song must be the first placed one; an unresolvable first song is not pinned
    const pinFirst = body.pinFirst && rows.has(0);
    const flow = flowOrder(placed.map(i => rows.get(i)), { energy: body.energy, pinFirst });
    res.json({ order: [...flow.order.map(k => placed[k]), ...unplaced], unplaced, stats: flow.stats });
  });
}
