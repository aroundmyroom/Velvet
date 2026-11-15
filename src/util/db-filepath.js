import * as config from '../state/config.js';
import { rootVpathOf } from './vpath.js';

// Files in a child vpath are stored under the ROOT vpath in the DB, so the
// playable/queueable path is always "<root vpath>/<child prefix><relPath>".
export function dbFilepath(vpath, relPath, folders = config.program.folders) {
  const { vpath: root, prefix } = rootVpathOf(vpath, folders);
  return `${root}/${prefix}${relPath}`;
}
