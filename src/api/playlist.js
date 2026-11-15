import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { joiValidate } from '../util/validation.js';
import WebError from '../util/web-error.js';
import { rootVpathOf } from '../util/vpath.js';
import { canCastToServer } from '../util/permissions.js';
import { isEnabled as transcodeEnabled } from './transcode.js';
import { createRequire } from 'node:module';
import { access as fsAccess } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
const _require = createRequire(import.meta.url);
const _pkg = _require('../../package.json');

export function setup(velvet) {
  // NOTE(pending): This is a legacy endpoint that should be improved
  velvet.get('/api/v1/ping', async (req, res) => {
    const returnThis = {
      vpaths: req.user.vpaths,
      noUpload: config.program.noUpload === true,
      supportedAudioFiles: config.program.supportedAudioFiles,
      transcode: transcodeEnabled() ? {
        defaultCodec: config.program.transcode.defaultCodec,
        defaultBitrate: config.program.transcode.defaultBitrate,
        defaultAlgorithm: config.program.transcode.algorithm
      } : false,
      vpathMetaData: {}
    };

    const allFolders = config.program.folders;
    req.user.vpaths.forEach(p => {
      if (!allFolders[p]) { return; }
      // parentVpath is the ROOT vpath that holds this folder's DB rows; filepathPrefix ends with '/'
      // so a LIKE 'Disco/%' filter never matches a sibling such as "Disco Mix Club Series/".
      const { vpath: rootName, prefix } = rootVpathOf(p, allFolders);
      const parentVpath = rootName === p ? null : rootName;
      returnThis.vpathMetaData[p] = {
        type: allFolders[p].type,
        parentVpath,
        filepathPrefix: parentVpath ? prefix : null,
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
    // allow-mpv-cast: opt-in per user; admins always may cast
    returnThis.allowMpvCast = mpvEnabled && canCastToServer(req.user);
    returnThis.version = _pkg.version;
    returnThis.defaultTheme = (config.program.ui || 'velvet').replace(/^velvet-/, '') || 'velvet';

    res.json(returnThis);
  });

  velvet.post('/api/v1/playlist/delete', (req, res) => {
    const schema = Joi.object({ playlistname: Joi.string().required() });
    joiValidate(schema, req.body);

    db.deletePlaylist(req.user.username, req.body.playlistname);
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

    res.json({});
  });

  velvet.post('/api/v1/playlist/remove-song', (req, res) => {
    const schema = Joi.object({ id: Joi.number().integer().required() });
    joiValidate(schema, req.body);

    const result = db.getPlaylistEntryById(req.body.id);
    if (!result || result.user !== req.user.username) {
      throw new WebError('Forbidden', 403);
    }

    db.removePlaylistEntryById(req.body.id);
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

    res.json({});
  });

  velvet.post('/api/v1/playlist/save', (req, res) => {
    const schema = Joi.object({
      title: Joi.string().required(),
      songs: Joi.array().items(Joi.string()).required(),
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

    res.json({});
  });

  velvet.post('/api/v1/playlist/reorder', (req, res) => {
    const schema = Joi.object({
      playlistname: Joi.string().required(),
      ids: Joi.array().items(Joi.number().integer()).min(1).required(),
    });
    joiValidate(schema, req.body);
    db.reorderPlaylistEntries(req.user.username, req.body.playlistname, req.body.ids);
    res.json({ ok: true });
  });

  velvet.get('/api/v1/playlist/getall', (req, res) => {
    res.json(db.getUserPlaylists(req.user.username));
  });
}
