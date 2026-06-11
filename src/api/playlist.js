import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import { createRequire } from 'node:module';
import { access as fsAccess } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
const _require = createRequire(import.meta.url);
const _pkg = _require('../../package.json');

export function setup(velvet) {
  // NOTE(pending): This is a legacy endpoint that should be improved
  velvet.get('/api/v1/ping', async (req, res) => {
    let transcode = false;
    if (config.program.transcode?.enabled) {
      transcode = {
        defaultCodec: config.program.transcode.defaultCodec,
        defaultBitrate: config.program.transcode.defaultBitrate,
        defaultAlgorithm: config.program.transcode.algorithm
      }
    }

    const returnThis = {
      vpaths: req.user.vpaths,
      transcode,
      noUpload: config.program.noUpload === true,
      supportedAudioFiles: config.program.supportedAudioFiles,
      vpathMetaData: {}
    };

    const allFolders = config.program.folders;
    req.user.vpaths.forEach(p => {
      if (!allFolders[p]) { return; }
      const myRoot = allFolders[p].root.replace(/\/?$/, '/');
      // Find if this vpath's root sits inside another vpath the user has access to
      const parentVpath = req.user.vpaths.find(other =>
        other !== p &&
        allFolders[other] &&
        myRoot.startsWith(allFolders[other].root.replace(/\/?$/, '/')) &&
        allFolders[other].root.replace(/\/?$/, '/') !== myRoot
      );
      returnThis.vpathMetaData[p] = {
        type: allFolders[p].type,
        // parentVpath: the vpath that physically covers this folder's files in the DB
        // filepathPrefix: the relative path prefix to filter by inside the parent vpath
        parentVpath: parentVpath || null,
        // Normalize child root with a trailing slash before slicing so the
        // prefix always ends with '/' (e.g. "Disco/" not "Disco").
        // Without the slash, SQLite LIKE 'Disco%' would incorrectly match
        // sibling folders like "Disco Mix Club Series/".
        filepathPrefix: parentVpath
          ? allFolders[p].root.replace(/\/?$/, '/').slice(allFolders[parentVpath].root.replace(/\/?$/, '/').length)
          : null,
        allowRecordDelete: allFolders[p].allowRecordDelete === true,
        albumsOnly: allFolders[p].albumsOnly === true
      };
    });

    // Expose write-access map for admin users — used by client to gate art-search & tag-edit buttons
    if (req.user?.admin === true) {
      const wac = {};
      for (const p of req.user.vpaths) {
        if (!allFolders[p]) { wac[p] = false; continue; }
        try { await fsAccess(allFolders[p].root, FS.W_OK); wac[p] = true; }
        catch { wac[p] = false; }
      }
      returnThis.vpathWriteAccess = wac;
    }

    returnThis.allowRadioRecording = req.user['allow-radio-recording'] === true;
    returnThis.allowYoutubeDownload = req.user['allow-youtube-download'] === true;
    // upload: disabled globally (noUpload) or per-user (allow-upload === false) — applies to all users including admin
    returnThis.allowUpload = config.program.noUpload !== true &&
      req.user['allow-upload'] !== false;

    // Server Audio (MPV) permissions — only meaningful when MPV is configured & enabled
    const mpvEnabled = !!config.program.serverAudio?.enabled;
    // allow-server-remote: default true when MPV enabled (existing behaviour), default false when not
    returnThis.allowServerRemote = mpvEnabled && req.user['allow-server-remote'] !== false;
    // allow-mpv-cast: default false (opt-in per user)
    returnThis.allowMpvCast = mpvEnabled && req.user['allow-mpv-cast'] === true;
    returnThis.version = _pkg.version;
    returnThis.defaultTheme = (config.program.ui || 'velvet').replace(/^velvet-/, '') || 'velvet';

    res.json(returnThis);
  });

  velvet.post('/api/v1/playlist/delete', (req, res) => {
    const schema = Joi.object({ playlistname: Joi.string().required() });
    joiValidate(schema, req.body);

    db.deletePlaylist(req.user.username, req.body.playlistname);
    db.saveUserDB();
    res.json({});
  });

  velvet.post('/api/v1/playlist/rename', (req, res) => {
    const schema = Joi.object({
      oldName: Joi.string().required(),
      newName: Joi.string().required()
    });
    joiValidate(schema, req.body);

    if (db.findPlaylist(req.user.username, req.body.newName) !== null) {
      return res.status(400).json({ error: 'Playlist name already in use' });
    }

    db.renamePlaylist(req.user.username, req.body.oldName, req.body.newName);
    db.saveUserDB();
    res.json({});
  });

  velvet.post('/api/v1/playlist/add-song', (req, res) => {
    const schema = Joi.object({
      song: Joi.string().required(),
      playlist: Joi.string().required()
    });
    joiValidate(schema, req.body);

    db.createPlaylistEntry({
      name: req.body.playlist,
      filepath: req.body.song,
      user: req.user.username
    });

    db.saveUserDB();
    res.json({});
  });

  velvet.post('/api/v1/playlist/remove-song', (req, res) => {
    const schema = Joi.object({ id: Joi.number().integer().required() });
    joiValidate(schema, req.body);

    const result = db.getPlaylistEntryById(req.body.id);
    if (!result || result.user !== req.user.username) {
      throw new Error(`User ${req.user.username} tried accessing a resource they don't have access to. Playlist ID: ${req.body.id}`);
    }

    db.removePlaylistEntryById(req.body.id);
    db.saveUserDB();
    res.json({});
  });

  velvet.post('/api/v1/playlist/new', (req, res) => {
    const schema = Joi.object({ title: Joi.string().required() });
    joiValidate(schema, req.body);

    const results = db.findPlaylist(req.user.username, req.body.title);
    if (results !== null) {
      return res.status(400).json({ error: 'Playlist Already Exists' });
    }

    // insert null entry
    db.createPlaylistEntry({
      name: req.body.title,
      filepath: null,
      user: req.user.username,
      live: false
    });

    db.saveUserDB();
    res.json({});
  });

  velvet.post('/api/v1/playlist/save', (req, res) => {
    const schema = Joi.object({
      title: Joi.string().required(),
      songs: Joi.array().items(Joi.string()),
      live: Joi.boolean().optional()
    });
    joiValidate(schema, req.body);

    db.beginTransactionStrict();
    try {
      // Delete existing playlist
      db.deletePlaylist(req.user.username, req.body.title);

      for (const song of req.body.songs) {
        db.createPlaylistEntry({
          name: req.body.title,
          filepath: song,
          user: req.user.username
        });
      }

      // insert null entry
      db.createPlaylistEntry({
        name: req.body.title,
        filepath: null,
        user: req.user.username,
        live: typeof req.body.live === 'boolean' ? req.body.live : false
      });
      db.commitTransactionStrict();
    } catch (err) {
      db.rollbackTransactionStrict();
      throw err;
    }

    db.saveUserDB();
    res.json({});
  });

  velvet.get('/api/v1/playlist/getall', (req, res) => {
    res.json(db.getUserPlaylists(req.user.username));
  });
}
