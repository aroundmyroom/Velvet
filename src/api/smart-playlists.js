import path from 'node:path';
import Joi from 'joi';
import * as db from '../db/manager.js';
import * as config from '../state/config.js';
import { mergeGenreRows } from '../util/genre-merge.js';
import { rootVpathOf } from '../util/vpath.js';

const VALID_SORTS = ['artist', 'album', 'year_asc', 'year_desc', 'rating', 'play_count', 'last_played', 'random'];

function renderRow(row) {
  return {
    filepath: path.join(row.vpath, row.filepath).replaceAll('\\', '/'),
    metadata: {
      artist:               row.artist     || null,
      hash:                 row.hash       || null,
      album:                row.album      || null,
      track:                row.track      || null,
      disk:                 row.disk       || null,
      title:                row.title      || null,
      year:                 row.year       || null,
      'album-art':          row.aaFile     || null,
      rating:               row.rating     || null,
      'play-count':         row.playCount  || null,
      'last-played':        row.lastPlayed || null,
      genre:                row.genre      || null,
      'replaygain-track-db': row.replaygainTrackDb ?? null,
      duration:             row.duration ?? null,
    },
  };
}

const filtersSchema = Joi.object({
  genres:        Joi.array().items(Joi.string().max(200)).default([]),
  yearFrom:      Joi.number().integer().min(1000).max(9999).allow(null).default(null),
  yearTo:        Joi.number().integer().min(1000).max(9999).allow(null).default(null),
  // minRating is the raw DB value: 0=any, 2=1★, 4=2★, 6=3★, 8=4★, 10=5★
  minRating:     Joi.number().integer().min(0).max(10).default(0),
  playedStatus:  Joi.string().valid('any', 'never', 'played').default('any'),
  minPlayCount:  Joi.number().integer().min(0).default(0),
  starred:       Joi.boolean().default(false),
  artistSearch:  Joi.string().max(200).allow('').default(''),
  // selectedVpaths: which vpaths to include; empty = all. Server resolves root/child mapping.
  selectedVpaths: Joi.array().items(Joi.string()).default([]),
  // freshPicks: when true, the client sends sort='random'; validated here for completeness.
  freshPicks: Joi.boolean().default(false),
});

// Child vpaths are stored under their parent in the DB, so a selected child becomes
// an includeFilepathPrefixes whitelist entry on the parent (unless the parent itself
// is selected, which already covers it).
function resolveVpathParams(selectedVpaths, userVpaths) {
  const none = { ignoreVPaths: [], includeFilepathPrefixes: [] };
  if (!selectedVpaths || selectedVpaths.length === 0) return none;
  const selected = selectedVpaths.filter(v => userVpaths.includes(v));
  if (selected.length === 0 || selected.length === userVpaths.length) return none;
  const folders = config.program?.folders || {};
  const parentOf = {};
  const prefixOf = {};
  for (const vp of userVpaths) {
    if (!folders[vp]) continue;
    const { vpath: rootName, prefix } = rootVpathOf(vp, folders);
    if (rootName !== vp && userVpaths.includes(rootName)) { parentOf[vp] = rootName; prefixOf[vp] = prefix; }
  }
  const selectedRoots = new Set(selected.filter(v => !parentOf[v]));
  const includeFilepathPrefixes = selected
    .filter(v => parentOf[v] && !selectedRoots.has(parentOf[v]))
    .map(v => ({ vpath: parentOf[v], prefix: prefixOf[v] }));
  const keep = new Set([...selectedRoots, ...includeFilepathPrefixes.map(p => p.vpath)]);
  const ignoreVPaths = userVpaths.filter(v => !parentOf[v] && !keep.has(v));
  return { ignoreVPaths, includeFilepathPrefixes };
}

const runSchema = Joi.object({
  filters: filtersSchema.required(),
  sort:    Joi.string().valid(...VALID_SORTS).default('artist'),
  limit:   Joi.number().integer().min(1).max(1000).default(100),
});

const saveSchema = Joi.object({
  name:    Joi.string().min(1).max(200).trim().required(),
  filters: filtersSchema.required(),
  sort:    Joi.string().valid(...VALID_SORTS).default('artist'),
  limit:   Joi.number().integer().min(1).max(1000).default(100),
});

/**
 * Expand display genre names (e.g. "Space Rock") to the raw DB genre strings
 * that contain them (e.g. "Space Rock, Rock"). This is needed because the DB
 * stores multi-value genre fields as a single string and mergeGenreRows splits
 * them into display names — so we must reverse-map before querying.
 */
function expandGenres(displayGenres, vpaths) {
  if (!displayGenres || displayGenres.length === 0) return [];
  const rawRows = db.getGenres(vpaths);
  const { rawMap } = mergeGenreRows(rawRows);
  const rawSet = new Set();
  for (const display of displayGenres) {
    const set = rawMap.get(display);
    if (set) { for (const r of set) rawSet.add(r); }
    else { rawSet.add(display); } // fallback: pass through as-is
  }
  return [...rawSet];
}

function _resolveFilters(rawFilters, vpaths) {
  // eslint-disable-next-line sonarjs/no-unused-vars
  const { selectedVpaths, freshPicks: _, ...songFilters } = rawFilters; // freshPicks is client-only
  const { ignoreVPaths, includeFilepathPrefixes } = resolveVpathParams(selectedVpaths, vpaths);
  return { filters: { ...songFilters, genres: expandGenres(songFilters.genres, vpaths) }, ignoreVPaths, includeFilepathPrefixes };
}

function _validFilters(raw) {
  const { error, value } = filtersSchema.validate(raw ?? {});
  return error ? null : value;
}

/** Song rows of a saved smart playlist (db.getSmartPlaylists row) for a user's vpaths. */
export function runSavedSmartPlaylist(sp, vpaths, username) {
  const valid = _validFilters(sp.filters);
  if (!valid) return [];
  const { filters, ignoreVPaths, includeFilepathPrefixes } = _resolveFilters(valid, vpaths);
  const sort = VALID_SORTS.includes(sp.sort) ? sp.sort : 'artist';
  return db.runSmartPlaylist(filters, sort, sp.limit_n, vpaths, username, ignoreVPaths, null, includeFilepathPrefixes);
}

/** Number of songs a saved smart playlist currently yields (capped at its limit). */
export function countSavedSmartPlaylist(sp, vpaths, username) {
  const valid = _validFilters(sp.filters);
  if (!valid) return 0;
  const { filters, ignoreVPaths, includeFilepathPrefixes } = _resolveFilters(valid, vpaths);
  const n = db.countSmartPlaylist(filters, vpaths, username, ignoreVPaths, null, includeFilepathPrefixes);
  return Math.min(n, Math.min(Number(sp.limit_n) || 100, 1000));
}

export function setup(velvet) {
  // List all saved smart playlists for the current user
  velvet.get('/api/v1/smart-playlists', (req, res) => {
    try {
      res.json({ playlists: db.getSmartPlaylists(req.user.username) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Run a smart playlist (without saving) — returns matching songs
  velvet.post('/api/v1/smart-playlists/run', (req, res) => {
    const { error, value } = runSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    try {
      const { filters, ignoreVPaths, includeFilepathPrefixes } = _resolveFilters(value.filters, req.user.vpaths);
      const rows = db.runSmartPlaylist(filters, value.sort, value.limit, req.user.vpaths, req.user.username, ignoreVPaths, null, includeFilepathPrefixes);
      const songs = rows.map(renderRow);
      res.json({ songs, total: songs.length });
    } catch (e) { console.error('[SPL run]', e.message, e.stack); res.status(500).json({ error: e.message }); }
  });

  // Count matching songs (for the "X songs match" preview)
  velvet.post('/api/v1/smart-playlists/count', (req, res) => {
    const { error, value } = Joi.object({ filters: filtersSchema.required() }).validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    try {
      const { filters, ignoreVPaths, includeFilepathPrefixes } = _resolveFilters(value.filters, req.user.vpaths);
      const count = db.countSmartPlaylist(filters, req.user.vpaths, req.user.username, ignoreVPaths, null, includeFilepathPrefixes);
      res.json({ count });
    } catch (e) { console.error('[SPL count]', e.message, e.stack); res.status(500).json({ error: e.message }); }
  });

  // Save a new named smart playlist
  velvet.post('/api/v1/smart-playlists', (req, res) => {
    const { error, value } = saveSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    try {
      const id = db.saveSmartPlaylist(req.user.username, value.name, value.filters, value.sort, value.limit);
      res.json({ id, name: value.name });
    } catch (e) {
      if (e.message?.includes('UNIQUE')) {
        return res.status(409).json({ error: `A smart playlist named "${value.name}" already exists` });
      }
      res.status(500).json({ error: e.message });
    }
  });

  // Update an existing smart playlist
  velvet.put('/api/v1/smart-playlists/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const { error, value } = saveSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    try {
      const ok = db.updateSmartPlaylist(id, req.user.username, { name: value.name, filters: value.filters, sort: value.sort, limit_n: value.limit });
      if (!ok) return res.status(404).json({ error: 'Smart playlist not found' });
      res.json({});
    } catch (e) {
      if (e.message?.includes('UNIQUE')) {
        return res.status(409).json({ error: `A smart playlist named "${value.name}" already exists` });
      }
      res.status(500).json({ error: e.message });
    }
  });

  // Delete a smart playlist
  velvet.delete('/api/v1/smart-playlists/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    try {
      const ok = db.deleteSmartPlaylist(id, req.user.username);
      if (!ok) return res.status(404).json({ error: 'Smart playlist not found' });
      res.json({});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
