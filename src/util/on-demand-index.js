/**
 * on-demand-index.js
 *
 * When a file that hasn't been scanned yet is played via the file explorer,
 * index it immediately so play stats can be recorded normally.
 */

import fs from 'node:fs';
import { parseFile } from 'music-metadata';
import * as db from '../db/manager.js';
import * as config from '../state/config.js';
import { resolveExistingFileWithinRoots } from './path-security.js';
import { computeFileHash } from './file-hash.js';
import { rootVpathOf } from './vpath.js';

// Track in-flight indexing operations to prevent duplicate rows when the same
// unindexed file is played concurrently (async gap between findFileByPath and
// insertFile is large enough for a second request to race through).
const _inFlight = new Map(); // "vpath:relpath" → Promise<row|null>

/**
 * Index a single file on-the-fly for play tracking purposes.
 * @param {object} pathInfo - Result of vpath.getVPathInfo()
 * @returns {object|null} The inserted file row object, or null on failure.
 */
export async function indexFileOnDemand(pathInfo) {
  try {
    const resolvedPath = resolveExistingFileWithinRoots(pathInfo.fullPath, [pathInfo.basePath]);

    // Store the row under the ROOT vpath, exactly as the scanner would, so its finish-scan pruning matches it.
    const { vpath: effectiveVpath, prefix } = rootVpathOf(pathInfo.vpath, config.program?.folders || {});
    const effectiveRelPath = prefix + pathInfo.relativePath;

    // Deduplicate concurrent calls for the same file — the async gap between
    // findFileByPath() and insertFile() is large enough for a second request to
    // race through and create a duplicate row.
    const flightKey = `${effectiveVpath}:${effectiveRelPath}`;
    if (_inFlight.has(flightKey)) return _inFlight.get(flightKey);

    const promise = (async () => {
      // If the file is already in the DB under the resolved vpath, return it
      // without creating a duplicate row.
      const existing = db.findFileByPath(effectiveRelPath, effectiveVpath);
      if (existing) return existing;

      const hash = await computeFileHash(resolvedPath);
      const meta = await parseFile(resolvedPath, { skipCovers: true, duration: true });
      const t = meta.common;
      const stat = fs.statSync(resolvedPath);
      const fileData = {
        hash,
        filepath: effectiveRelPath,
        vpath:    effectiveVpath,
        title:    t.title  || null,
        artist:   t.artist || null,
        album:    t.album  || null,
        year:     t.year   || null,
        duration: meta.format.duration || null,
        format:   meta.format.container || null,
        genre:    t.genre?.[0] ? t.genre[0] : null,
        modified: stat.mtime.getTime(),
        ts:       Date.now(), // wall-clock time so files played before scanner runs still appear in Recently Added
      };
      return db.insertFile(fileData);
    })();

    _inFlight.set(flightKey, promise);
    try {
      return await promise;
    } finally {
      _inFlight.delete(flightKey);
    }
  } catch (e) {
    console.debug('[velvet] on-demand index', e?.message ?? e);
    return null;
  }
}
