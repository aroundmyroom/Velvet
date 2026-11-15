import * as config from '../state/config.js';
import * as vpath from './vpath.js';
import { resolvePathWithinRoot } from './path-security.js';

export const MAX_MEDIA_FILEPATH = 4096;

export function locateMedia(fp, user) {
  if (typeof fp !== 'string' || !fp || fp.length > MAX_MEDIA_FILEPATH || /[\0\\]/.test(fp)) return null;
  const segs = fp.split('/');
  if (segs.length < 2 || segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  let info;
  try {
    info = vpath.getVPathInfo(fp, user);
  } catch {
    return null;
  }
  if (config.program.folders[info.vpath]?.type === 'excluded') return null;
  const rel = segs.slice(1).join('/');
  let file;
  try {
    file = resolvePathWithinRoot(info.basePath, rel);
  } catch {
    return null;
  }
  const root = vpath.rootVpathOf(info.vpath);
  return { fp, file, info, dbVpath: root.vpath, dbRel: root.prefix + rel };
}
