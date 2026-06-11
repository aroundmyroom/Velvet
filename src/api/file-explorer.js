import path from 'node:path';
import fs from 'node:fs/promises';
import fsOld from 'node:fs';
import busboy from 'busboy';
import Joi from 'joi';
import { makeDirectorySync } from 'make-dir';
import winston from 'winston';
import * as fileExplorer from '../util/file-explorer.js';
import * as vpath from '../util/vpath.js';
import * as m3u from '../util/m3u.js';
import * as config from '../state/config.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';
import { resolvePathWithinRoot } from '../util/path-security.js';

async function recursiveFileScan(directory, fileList, relativePath, vPath) {
  for (const file of await fs.readdir(directory)) {
    let stat;
    try {
      stat = await fs.stat(resolvePathWithinRoot(directory, file));
    } catch (err) {
      /* Bad file or permission error, ignore and continue */
      winston.warn(`Failed to access file ${file} in directory ${directory}, skipping.`, { stack: err });
      continue;
    }

    if (stat.isDirectory()) {
      await recursiveFileScan(resolvePathWithinRoot(directory, file), fileList, path.join(relativePath, file), vPath);
    } else {
      const extension = fileExplorer.getFileType(file).toLowerCase();
      if (config.program.supportedAudioFiles[extension] === true) {
        fileList.push(path.join(vPath, path.join(relativePath, file)).replaceAll('\\', "/"));
      }
    }
  }
  return fileList;
}

export function setup(velvet) {
  velvet.post("/api/v1/file-explorer", async (req, res) => {
    const schema = Joi.object({
      directory: Joi.string().allow("").required(),
      sort: Joi.boolean().default(true),
      pullMetadata: Joi.boolean().default(false)
    });
    const { value } = joiValidate(schema, req.body);

    // Convenience functions to get the most useful directory
    if (value.directory === "~") {
      if (req.user.vpaths.length === 1) {
        value.directory = `/${req.user.vpaths[0]}`;
      } else {
        value.directory = "";
      }
    }

    // Return vpaths if no path is given
    if (value.directory === "" || value.directory === "/") {
      const directories = [];
      for (const dir of req.user.vpaths) {
        directories.push({ name: dir });
      }
      return res.json({ path: "/", directories: directories, files: [] });
    }

    // Get vPath Info
    const pathInfo = vpath.getVPathInfo(value.directory, req.user);

    // Do not allow browsing outside the directory
    if (pathInfo.fullPath.substring(0, pathInfo.basePath.length) !== pathInfo.basePath) {
      winston.warn(`user '${req.user.username}' attempted to access a directory they don't have access to: ${pathInfo.fullPath}`)
      throw new Error('Access to directory not allowed');
    }

    // get directory contents
    const folderContents = await fileExplorer.getDirectoryContents(pathInfo.fullPath, config.program.supportedAudioFiles, value.sort, value.pullMetadata, value.directory, req.user);

    // Format directory string for return value
    let returnDirectory = path.join(pathInfo.vpath, pathInfo.relativePath);
    returnDirectory = returnDirectory.replaceAll('\\', "/"); // Formatting for windows paths

    // Make sure we have a slash at the beginning & end
    if (returnDirectory.slice(1) !== "/") { returnDirectory = "/" + returnDirectory; }
    if (returnDirectory.slice(-1) !== "/") { returnDirectory += "/"; }

    res.json({
      path: returnDirectory,
      files: folderContents.files,
      directories: folderContents.directories
    });
  });



  velvet.post("/api/v1/file-explorer/recursive", async (req, res) => {
    const schema = Joi.object({ directory: Joi.string().required() });
    joiValidate(schema, req.body);

    // Get vPath Info
    const pathInfo = vpath.getVPathInfo(req.body.directory, req.user);

    // Do not allow browsing outside the directory
    if (pathInfo.fullPath.substring(0, pathInfo.basePath.length) !== pathInfo.basePath) {
      winston.warn(`user '${req.user.username}' attempted to access a directory they don't have access to: ${pathInfo.fullPath}`)
      throw new Error('Access to directory not allowed');
    }

    res.json(await recursiveFileScan(pathInfo.fullPath, [], pathInfo.relativePath, pathInfo.vpath));
  });

  velvet.post('/api/v1/file-explorer/upload', (req, res) => {
    if (config.program.noUpload === true) { throw new WebError('Uploading Disabled'); }
    if (req.user['allow-upload'] === false) { throw new WebError('Uploading Disabled', 403); }
    if (!req.headers['data-location']) { throw new WebError('No Location Provided', 403); }

    const pathInfo = vpath.getVPathInfo(decodeURI(req.headers['data-location']), req.user);
    makeDirectorySync(pathInfo.fullPath);

    let acceptedCount = 0;
    let firstRejectedExt = null;
    const bb = busboy({ headers: req.headers, defParamCharset: 'utf8' });
    bb.on('file', (fieldname, file, info) => {
      // Use path.basename() to strip any directory components from the
      // client-supplied filename before joining it to the upload path (CWE-22 fix).
      const safeFilename = path.basename(info.filename);
      if (!safeFilename || safeFilename.startsWith('.')) {
        file.resume(); // drain and discard the stream
        return;
      }
      // Only allow supported audio file types — reject everything else (PDFs, TXTs, etc.)
      const ext = fileExplorer.getFileType(safeFilename).toLowerCase();
      if (!config.program.supportedAudioFiles[ext]) {
        winston.warn(`Upload rejected from ${req.user.username}: unsupported file type '.${ext}' (${safeFilename})`);
        if (!firstRejectedExt) firstRejectedExt = ext;
        file.resume(); // drain and discard the stream
        return;
      }
      acceptedCount++;
      const saveTo = resolvePathWithinRoot(pathInfo.fullPath, safeFilename);
      winston.info(`Uploading from ${req.user.username} to: ${saveTo}`);
      file.pipe(fsOld.createWriteStream(saveTo));
    });

    bb.on('close', () => {
      if (firstRejectedExt && acceptedCount === 0) {
        return res.status(400).json({ error: `File type not allowed: .${firstRejectedExt}` });
      }
      res.json({});
    });
    req.pipe(bb);
  });

  velvet.post("/api/v1/file-explorer/m3u", async (req, res) => {
    const pathInfo = vpath.getVPathInfo(req.body.path, req.user);

    const playlistParentDir = path.dirname(req.body.path);
    const songs = await m3u.readPlaylistSongs(pathInfo.fullPath);
    res.json({
      files: songs.flatMap((song) => {
        try {
          const resolvedSongPath = resolvePathWithinRoot(playlistParentDir, song);
          return [{
            type: fileExplorer.getFileType(song),
            name: path.basename(song),
            path: resolvedSongPath.replaceAll('\\', '/')
          }];
        } catch {
          return [];
        }
      })
    });
  });
}
