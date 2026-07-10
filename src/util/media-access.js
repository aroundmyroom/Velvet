export function getMediaVpathFromPath(reqPath) {
  const parts = String(reqPath || '').split('/').filter(Boolean);
  if (parts.length === 0) return null;
  try {
    return decodeURIComponent(parts[0]);
  } catch {
    return null;
  }
}

export function canAccessMediaVpath(reqPath, user, folders) {
  const vpath = getMediaVpathFromPath(reqPath);
  if (!vpath) return false;
  if (!folders || !Object.hasOwn(folders, vpath)) return false;
  if (Array.isArray(user?.vpaths) && user.vpaths.includes(vpath)) return true;
  // Allow child-only users: check if the user has a child vpath whose root is
  // under this vpath's root, and the requested path falls within that child's prefix.
  if (!Array.isArray(user?.vpaths) || !folders[vpath]?.root) return false;
  const parentRoot = folders[vpath].root.replace(/\/?$/, '/');
  const parts = String(reqPath || '').split('/').filter(Boolean);
  let relPath;
  try { relPath = parts.slice(1).map(p => decodeURIComponent(p)).join('/'); } catch { return false; }
  return user.vpaths.some(childName => {
    const childRoot = folders[childName]?.root?.replace(/\/?$/, '/');
    if (!childRoot || !childRoot.startsWith(parentRoot) || childRoot === parentRoot) return false;
    const childPrefix = childRoot.slice(parentRoot.length);
    return relPath === childPrefix.replace(/\/$/, '') || relPath.startsWith(childPrefix);
  });
}
