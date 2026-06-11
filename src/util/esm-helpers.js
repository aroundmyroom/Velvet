import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

export function getDirname(importMetaUrl) {
  return dirname(fileURLToPath(importMetaUrl));
}
