import path from 'node:path';
import Joi from 'joi';
import * as db from '../db/manager.js';
import * as config from '../state/config.js';
import { mergeGenreRows } from '../util/genre-merge.js';

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

/**
 * Resolve selected vpaths to the correct DB-level ignoreVPaths + filepathPrefix.
 * Child vpaths are stored under their parent vpath in the DB, so selecting only
 * a child requires a filepathPrefix filter rather than an ignoreVPaths exclusion.
 */
function resolveVpathParams(selectedVpaths, userVpaths) {
  if (!selectedVpaths || selectedVpaths.length === 0) {
    return { ignoreVPaths: [], filepathPrefix: null };
  }
  const selected = selectedVpaths.filter(v => userVpaths.includes(v));
  if (selected.length === 0 || selected.length === userVpaths.length) {
    return { ignoreVPaths: [], filepathPrefix: null };
  }
  const folders = config.program?.folders || {};
  // Build parent-child map for this user's vpaths
  const meta = {};
  for (const vp of userVpaths) {
    if (!folders[vp]) { meta[vp] = { parentVpath: null, filepathPrefix: null }; continue; }
    const myRoot = folders[vp].root.replace(/\/?$/, '/');
    const parentVpath = userVpaths.find(other =>
      other !== vp && folders[other] &&
      myRoot.startsWith(folders[other].root.replace(/\/?$/, '/'))
    );
    meta[vp] = {
      parentVpath: parentVpath || null,
      filepathPrefix: parentVpath ? myRoot.slice(folders[parentVpath].root.replace(/\/?$/, '/').length) : null,
    };
  }
  // If ALL selected vpaths are children of the same parent vpath, use filepathPrefix
  const allChildSameParent =
    selected.every(v => meta[v]?.parentVpath) &&
    new Set(selected.map(v => meta[v].parentVpath)).size === 1;
  if (allChildSameParent) {
    const parentVpath = meta[selected[0]].parentVpath;
    const filepathPrefix = selected.length === 1 ? meta[selected[0]].filepathPrefix : null;
    const ignoreVPaths = userVpaths.filter(v => v !== parentVpath && !meta[v]?.parentVpath);
    return { ignoreVPaths, filepathPrefix };
  }
  // Mixed selection: ignore root vpaths that are not selected and not a parent of a selected child
  const selectedParents = new Set(selected.map(v => meta[v]?.parentVpath).filter(Boolean));
  const ignoreVPaths = userVpaths.filter(v => !selected.includes(v) && !meta[v]?.parentVpath && !selectedParents.has(v));
  return { ignoreVPaths, filepathPrefix: null };
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
      // eslint-disable-next-line sonarjs/no-unused-vars
      const { selectedVpaths, freshPicks: _, ...songFilters } = value.filters; // freshPicks is client-only
      const { ignoreVPaths, filepathPrefix } = resolveVpathParams(selectedVpaths, req.user.vpaths);
      const filters = { ...songFilters, genres: expandGenres(songFilters.genres, req.user.vpaths) };
      const rows = db.runSmartPlaylist(filters, value.sort, value.limit, req.user.vpaths, req.user.username, ignoreVPaths, filepathPrefix);
      const songs = rows.map(renderRow);
      res.json({ songs, total: songs.length });
    } catch (e) { console.error('[SPL run]', e.message, e.stack); res.status(500).json({ error: e.message }); }
  });

  // Count matching songs (for the "X songs match" preview)
  velvet.post('/api/v1/smart-playlists/count', (req, res) => {
    const { error, value } = Joi.object({ filters: filtersSchema.required() }).validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    try {
      // eslint-disable-next-line sonarjs/no-unused-vars
      const { selectedVpaths, freshPicks: _, ...songFilters } = value.filters; // freshPicks is client-only
      const { ignoreVPaths, filepathPrefix } = resolveVpathParams(selectedVpaths, req.user.vpaths);
      const filters = { ...songFilters, genres: expandGenres(songFilters.genres, req.user.vpaths) };
      const count = db.countSmartPlaylist(filters, req.user.vpaths, req.user.username, ignoreVPaths, filepathPrefix);
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
