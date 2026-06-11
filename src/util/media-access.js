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
  return Array.isArray(user?.vpaths) && user.vpaths.includes(vpath);
}
