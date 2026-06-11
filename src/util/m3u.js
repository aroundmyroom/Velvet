import fs from 'node:fs/promises';
import path from 'node:path';
import * as m3u8Parser from 'm3u8-parser';
import { resolveExistingFileWithinRoots } from './path-security.js';

export async function readPlaylistSongs(filePath) {
  const resolvedPath = resolveExistingFileWithinRoots(filePath, [path.dirname(filePath)]);
  const fileContents = (await fs.readFile(resolvedPath)).toString();

  const parser = new m3u8Parser.Parser();
  parser.push(fileContents);
  parser.end();

  let items = parser.manifest.segments.map(segment => { return segment.uri; });
  if (items.length === 0) {
    items = fileContents.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
  }

  return items.map(item => { return item.replaceAll('\\\\', "/"); });
}
