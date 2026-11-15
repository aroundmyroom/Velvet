import { userOwnsChildPath } from './vpath.js';
import { resolvePathWithinRoot } from './path-security.js';

function parseMediaPath(reqPath) {
  const parts = String(reqPath || '').split('/').filter(Boolean);
  try {
    return { vpath: decodeURIComponent(parts[0] ?? ''), relPath: parts.slice(1).map(decodeURIComponent).join('/') };
  } catch {
    return null;
  }
}

export function canAccessMediaVpath(reqPath, user, folders) {
  const parsed = parseMediaPath(reqPath);
  if (!parsed || !folders || !Object.hasOwn(folders, parsed.vpath)) return false;
  if (!Array.isArray(user?.vpaths)) return false;
  if (user.vpaths.includes(parsed.vpath)) return true;
  if (!folders[parsed.vpath]?.root) return false;
  return userOwnsChildPath(user, parsed.vpath, parsed.relPath, folders);
}

// -> { vpath, relPath, filePath } or { status } (400 bad encoding, 404 unknown vpath / no file part, 403 outside the root)
export function resolveMediaPath(reqPath, folders) {
  const parsed = parseMediaPath(reqPath);
  if (!parsed) return { status: 400 };
  const root = folders && Object.hasOwn(folders, parsed.vpath) ? folders[parsed.vpath]?.root : null;
  if (!root || !parsed.relPath) return { status: 404 };
  try {
    return { ...parsed, filePath: resolvePathWithinRoot(root, parsed.relPath) };
  } catch {
    return { status: 403 };
  }
}
