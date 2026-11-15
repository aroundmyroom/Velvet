import Joi from 'joi';
import * as db from '../db/manager.js';
import { userRootVpaths } from '../util/vpath.js';
import WebError from '../util/web-error.js';
import { joiValidate } from '../util/validation.js';
import { locateMedia, MAX_MEDIA_FILEPATH } from '../util/media-locate.js';
import { nextForUser } from '../autodj/library.js';
import { renderMetadataObj, enforceChildScope, computeChildExclusions, userDbVpaths } from './db.js';

const MAX_RECENT = 200;

const prefixList = Joi.array().items(Joi.object({
  vpath: Joi.string().max(MAX_MEDIA_FILEPATH).required(),
  prefix: Joi.string().max(MAX_MEDIA_FILEPATH).required(),
})).max(100);

const nextSchema = Joi.object({
  seedFilepath: Joi.string().max(MAX_MEDIA_FILEPATH),
  recent: Joi.array().items(Joi.string().max(MAX_MEDIA_FILEPATH)).max(MAX_RECENT).default([]),
  scope: Joi.object({
    ignoreVPaths: Joi.array().items(Joi.string().max(MAX_MEDIA_FILEPATH)).max(100),
    filepathPrefix: Joi.string().max(MAX_MEDIA_FILEPATH).allow(''),
    includeFilepathPrefixes: prefixList,
    excludeFilepathPrefixes: prefixList,
    minRating: Joi.number().integer().min(0).max(10),
    minDuration: Joi.number().min(0).max(86400),
    maxDuration: Joi.number().min(0).max(86400),
    allowUnknownDuration: Joi.boolean(),
  }).default({}),
});

// Rows for DB paths the user may read, in the order given; unknown paths are skipped.
function rowsFor(paths, user) {
  const located = paths.map(fp => locateMedia(fp, user)).filter(Boolean);
  const byVpath = new Map();
  for (const l of located) {
    if (!byVpath.has(l.dbVpath)) byVpath.set(l.dbVpath, []);
    byVpath.get(l.dbVpath).push(l.dbRel);
  }
  const found = new Map();
  for (const [vp, rels] of byVpath) {
    for (const [rel, row] of db.getFilesWithMetadataByPaths(rels, vp, user.username)) found.set(`${vp}/${rel}`, row);
  }
  return located.map(l => found.get(`${l.dbVpath}/${l.dbRel}`)).filter(Boolean);
}

function _invertedDurationWindow(scope) {
  return Boolean(scope.minDuration && scope.maxDuration && scope.minDuration > scope.maxDuration);
}

// A request with an inverted duration window gets a 400 from the route; a room's stored
// settings may still hold one, and there the window is dropped so the pick keeps working.
export function enforcedScope(user, scope) {
  const excluded = [...(scope.excludeFilepathPrefixes || []), ...computeChildExclusions(userDbVpaths(user))];
  const out = {
    ...scope,
    ...enforceChildScope(user, scope),
    excludeFilepathPrefixes: excluded.length ? excluded : undefined,
  };
  if (_invertedDurationWindow(scope)) {
    delete out.minDuration;
    delete out.maxDuration;
  }
  return out;
}

export function setup(velvet) {
  velvet.post('/api/v1/autodj/next', async (req, res) => {
    const { value } = joiValidate(nextSchema, req.body ?? {});
    if (_invertedDurationWindow(value.scope)) throw new WebError('minDuration must be <= maxDuration', 400);
    const user = req.user;
    const seedRow = value.seedFilepath ? rowsFor([value.seedFilepath], user)[0] ?? null : null;
    const row = await nextForUser({
      seedRow,
      historyRows: rowsFor(value.recent, user),
      username: user.username,
      vpaths: userRootVpaths(user),
      scope: enforcedScope(user, value.scope),
    });
    res.json({ song: row ? renderMetadataObj(row) : null });
  });
}
