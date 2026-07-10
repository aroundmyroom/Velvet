import path from 'node:path';
import * as config from '../state/config.js';

export function getVPathInfo(url, user) {
  if (!config.program) { throw new Error('Not Configured'); }

  // remove leading slashes
  if (url.charAt(0) === '/') {
    url = url.substr(1);
  }

  // Get vpath from url
  const vpath = url.split('/').shift();
  const folders = config.program.folders;

  if (!folders[vpath]) throw new Error(`Unknown vpath: ${vpath}`);

  // Verify user has access to this vpath (direct or via a child vpath).
  if (user && !user.vpaths.includes(vpath)) {
    // Allow if the user has a child vpath whose root is a subdirectory of this
    // vpath's root AND the relative path falls within that child's prefix.
    const parentRoot = folders[vpath].root.replace(/\/?$/, '/');
    const relativePath = url.slice(vpath.length + 1);
    const allowed = (user.vpaths || []).some(childName => {
      const childRoot = folders[childName]?.root?.replace(/\/?$/, '/');
      if (!childRoot || !childRoot.startsWith(parentRoot) || childRoot === parentRoot) return false;
      const childPrefix = childRoot.slice(parentRoot.length);
      return relativePath === childPrefix.replace(/\/$/, '') || relativePath.startsWith(childPrefix);
    });
    if (!allowed) throw new Error(`User does not have access to path ${vpath}`);
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
