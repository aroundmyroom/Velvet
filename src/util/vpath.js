import path from 'node:path';
import * as config from '../state/config.js';
import WebError from './web-error.js';

export function normRoot(root) {
  return root.replace(/\/?$/, '/');
}

function _root(folders, name) {
  const r = folders?.[name]?.root;
  return r ? normRoot(r) : null;
}

export function childPrefixWithin(parentName, childName, folders = config.program.folders) {
  if (parentName === childName) return null;
  const p = _root(folders, parentName);
  const c = _root(folders, childName);
  if (!p || !c || c === p || !c.startsWith(p)) return null;
  return c.slice(p.length);
}

export function parentVpathOf(name, folders = config.program.folders) {
  let parent = null;
  let best = Infinity;
  for (const other of Object.keys(folders || {})) {
    const prefix = childPrefixWithin(other, name, folders);
    if (prefix !== null && prefix.length < best) { parent = other; best = prefix.length; }
  }
  return parent;
}

export function rootVpathOf(name, folders = config.program.folders) {
  let vpath = name;
  for (let p = parentVpathOf(vpath, folders); p; p = parentVpathOf(vpath, folders)) vpath = p;
  return { vpath, prefix: vpath === name ? '' : childPrefixWithin(vpath, name, folders) };
}

// { name: root } for the ROOT vpaths only — the ones the DB indexes
export function rootFolders(folders = config.program.folders) {
  return Object.fromEntries(Object.entries(folders || {})
    .filter(([name, cfg]) => cfg.root && !parentVpathOf(name, folders))
    .map(([name, cfg]) => [name, cfg.root]));
}

export function userRootVpaths(user, folders = config.program.folders) {
  return [...new Set((user?.vpaths || []).filter(v => folders?.[v]?.root).map(v => rootVpathOf(v, folders).vpath))];
}

export function expandDbVpaths(vpaths, folders = config.program.folders) {
  const out = new Set(vpaths || []);
  for (const v of vpaths || []) {
    for (const other of Object.keys(folders || {})) {
      if (childPrefixWithin(other, v, folders) !== null) out.add(other);
    }
  }
  return [...out];
}

export function normalizeRelPath(relPath) {
  const norm = path.posix.normalize(String(relPath ?? '').replaceAll('\\', '/'));
  if (norm === '..' || norm.startsWith('../') || norm.startsWith('/')) return null;
  return norm === '.' ? '' : norm;
}

export function userOwnsChildPath(user, vpath, relPath, folders = config.program.folders) {
  const rel = normalizeRelPath(relPath);
  if (rel === null) return false;
  return (user?.vpaths || []).some(childName => {
    const prefix = childPrefixWithin(vpath, childName, folders);
    return prefix !== null && (rel === prefix.slice(0, -1) || rel.startsWith(prefix));
  });
}

export function dbLocationCandidates(pathInfo, user, folders = config.program.folders) {
  const allowed = user ? new Set(expandDbVpaths(user.vpaths, folders)) : null;
  const parents = [];
  for (const other of Object.keys(folders || {})) {
    if (allowed && !allowed.has(other)) continue;
    const prefix = childPrefixWithin(other, pathInfo.vpath, folders);
    if (prefix !== null) parents.push({ vpath: other, relPath: prefix + pathInfo.relativePath, prefix });
  }
  parents.sort((a, b) => b.prefix.length - a.prefix.length);
  return [{ vpath: pathInfo.vpath, relPath: pathInfo.relativePath, prefix: '' }, ...parents];
}

export function getVPathInfo(url, user) {
  if (!config.program) { throw new Error('Not Configured'); }

  // remove leading slashes
  if (url.charAt(0) === '/') {
    url = url.substr(1);
  }

  // Get vpath from url
  const vpath = url.split('/').shift();
  const folders = config.program.folders;

  if (!folders[vpath]) throw new WebError(`Unknown vpath: ${vpath}`, 404);

  if (user && !user.vpaths.includes(vpath) && !userOwnsChildPath(user, vpath, url.slice(vpath.length + 1), folders)) {
    throw new WebError(`User does not have access to path ${vpath}`, 404);
  }

  const baseDir = folders[vpath].root;
  const result = {
    vpath: vpath,
    basePath: baseDir,
    relativePath: path.relative(vpath, url),
    fullPath: path.join(baseDir, path.relative(vpath, url))
  };

  // Ensure the resolved path stays within the vpath root (CWE-22 fix).
  // Use a trailing separator so '/media/music-extra' can't pass a '/media/music' check.
  const normalizedBase = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (result.fullPath !== baseDir && !result.fullPath.startsWith(normalizedBase)) {
    throw new Error(`Access to path not allowed: ${result.fullPath}`);
  }

  return result;
}
