// One resolver built from the approved genre-family rules, shared by every
// request. Null while no rule is approved, so random-songs sends exactly what
// it always did on an installation that never opened the AI-assist page.
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { mergeGenreRows, toKey } from './genre-merge.js';
import { createFamilyResolver } from './genre-family.js';

const TTL_MS = 10 * 60 * 1000;
let _resolver = null;
let _builtAt = 0;

export function allVpaths() {
  return Object.keys(config.program.folders || {});
}

export function invalidateGenreFamilyResolver() {
  _resolver = null;
  _builtAt = 0;
}

export function genreFamilyResolver() {
  if (_resolver && Date.now() - _builtAt < TTL_MS) return _resolver.active ? _resolver : null;
  const approved = db.getGenreFamilyRules('approved');
  const genreRules = new Map(approved.filter(r => r.kind === 'genre').map(r => [r.key, r.family]));
  const folderRules = approved.filter(r => r.kind === 'folder').map(r => ({ key: r.key, family: r.family }));
  const rawMap = genreRules.size ? mergeGenreRows(db.getGenres(allVpaths())).rawMap : new Map();
  _resolver = createFamilyResolver({ genreRules, folderRules, rawMap });
  _builtAt = Date.now();
  return _resolver.active ? _resolver : null;
}

export function genreRuleKey(displayGenre) {
  return toKey(displayGenre);
}
