import fs from 'node:fs';
import path from 'node:path';

export function resolveChildPath(basePath, childName) {
  const child = String(childName || '').trim();
  if (!child) {
    throw new Error('Invalid child path');
  }

  const normalized = path.normalize(child);
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error('Invalid child path');
  }
  if (normalized.includes(path.sep)) {
    throw new Error('Invalid child path');
  }

  return path.join(basePath, normalized);
}

export function resolveExistingFileWithinRoots(candidatePath, allowedRoots) {
  const candidate = String(candidatePath || '').trim();
  if (!candidate) {
    throw new Error('Invalid file path');
  }

  const resolved = path.resolve(candidate);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error('Invalid file path');
  }

  const realPath = fs.realpathSync(resolved);
  for (const root of allowedRoots || []) {
    if (!root) continue;
    const resolvedRoot = path.resolve(root);
    const normalizedRoot = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
    if (realPath === resolvedRoot || realPath.startsWith(normalizedRoot)) {
      return realPath;
    }
  }

  throw new Error('Path outside allowed roots');
}

export function resolvePathWithinRoot(rootPath, relativePath) {
  const root = String(rootPath || '').trim();
  if (!root) {
    throw new Error('Invalid root path');
  }

  const rel = String(relativePath || '').trim();
  if (!rel) {
    return path.resolve(root);
  }

  if (path.isAbsolute(rel)) {
    throw new Error('Invalid relative path');
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, rel);
  const normalizedRoot = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(normalizedRoot)) {
    throw new Error('Path outside allowed root');
  }

  return resolvedPath;
}