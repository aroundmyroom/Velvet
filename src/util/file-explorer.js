import fs from 'node:fs/promises';
import path from 'node:path';
import winston from 'winston';
import * as dbApi from '../api/db.js';
import { resolvePathWithinRoot } from './path-security.js';

export function getFileType(pathString) {
  return path.extname(pathString).substr(1);
}

export async function getDirectoryContents(directory, fileTypeFilter, sort, pm, metaDir, user) {
  const rt = { directories: [], files: [] };
  const metadataRequests = [];
  for (const file of await fs.readdir(directory)) {
    let stat;
    try {
      stat = await fs.stat(resolvePathWithinRoot(directory, file));
    } catch (error) {
      // Bad file or permission error, ignore and continue
      winston.warn(`Failed to access file ${file} in directory ${directory}, skipping.`, { stack: error });
      continue;
    }

    // Handle Directory
    if (stat.isDirectory()) {
      rt.directories.push({ name: file });
      continue;
    }

    // Handle Files
    const extension = getFileType(file).toLowerCase();
    if (fileTypeFilter && extension in fileTypeFilter) {
      const fileInfo = {
        type: extension,
        name: file
      };

      rt.files.push(fileInfo);
      if (pm) {
        metadataRequests.push({ fileInfo, filepath: resolvePathWithinRoot(metaDir, file).replaceAll('\\', '/') });
      }
    }
  }

  if (pm && metadataRequests.length > 0) {
    const batch = dbApi.pullMetaDataBatch(metadataRequests.map(r => r.filepath), user);
    for (const r of metadataRequests) {
      r.fileInfo.metadata = batch[r.filepath] || { filepath: r.filepath, metadata: null };
    }
  }

  if (sort && sort === true) {
    // Sort it because we can't rely on the OS returning it pre-sorted
    rt.directories.sort((a, b) => { return a.name.localeCompare(b.name); });
    rt.files.sort((a, b) => { return a.name.localeCompare(b.name); });
  }

  return rt;
}
