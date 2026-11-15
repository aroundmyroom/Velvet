import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ZipArchive } from 'archiver';
import winston from 'winston';
import * as config from '../state/config.js';
import * as dbManager from '../db/manager.js';
import { resolvePathWithinRoot } from '../util/path-security.js';
import { sendspinBackupFiles, restoreSendspinFiles } from './backup.js';
import * as sendspinApi from './sendspin.js';
import { restoreRoomsFromImport } from './rooms-import.js';

const IMPORT_ID_RE = /^velvet-import-\d+$/;
const EXPORT_TTL_MS = 60 * 60 * 1000;

// Exports carry the config (JWT secret, password hashes, API keys), so they are staged in an
// owner-only folder next to the database, never in the shared system temp folder.
function stagingDir() {
  return path.join(config.program.storage.dbDirectory, '..', 'migrate');
}

async function ensureStagingDir() {
  await fsp.mkdir(stagingDir(), { recursive: true, mode: 0o700 });
  await fsp.chmod(stagingDir(), 0o700);
  return stagingDir();
}

function getVpathRoots() {
  return Object.keys(config.program.folders);
}

// ── Export ───────────────────────────────────────────────────────────────────

async function createExportArchive(options = {}) {
  const tempDir = await fsp.mkdtemp(path.join(await ensureStagingDir(), 'export-'));
  try {
    return await _buildExportArchive(tempDir, options);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function _buildExportArchive(tempDir, options) {
  const {
    includeWaveforms = true,
    includeArtistImages = false
  } = options;

  const ts = new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 16);

  const manifest = {
    version: process.env.VELVET_VERSION || process.env.MSTREAM_VERSION || 'unknown',
    exportedAt: new Date().toISOString(),
    vpathRoots: getVpathRoots(),
    includes: {
      database: true,
      config: true,
      waveforms: includeWaveforms,
      artistImages: includeArtistImages
    }
  };

  // 1. Export configuration
  const cfgFile = config.configFile;
  const configDest = path.join(tempDir, 'default.json');
  await fsp.copyFile(cfgFile, configDest);

  // 2. Export database (VACUUM INTO for clean SQLite copy)
  dbManager.vacuumInto(path.join(tempDir, 'velvet.sqlite'));

  // 3. Export waveforms if requested
  if (includeWaveforms) {
    const waveformSrc = config.program.storage.waveformDirectory;
    const waveformDest = path.join(tempDir, 'waveform-cache');
    try {
      await fsp.access(waveformSrc);
      await fsp.cp(waveformSrc, waveformDest, { recursive: true });
    } catch (e) {
      winston.warn(`[migrate] Waveform cache not found: ${e.message}`);
    }
  }

  // 4. Export artist images if requested
  if (includeArtistImages) {
    const artistSrc = path.join(config.program.storage.albumArtDirectory, 'artists');
    const artistDest = path.join(tempDir, 'image-cache', 'artists');
    try {
      await fsp.access(artistSrc);
      await fsp.mkdir(path.dirname(artistDest), { recursive: true });
      await fsp.cp(artistSrc, artistDest, { recursive: true });
    } catch (e) {
      winston.warn(`[migrate] Artist images not found: ${e.message}`);
    }
  }

  // 5. Velvet Rooms identity + pairing records (both or neither)
  const sendspinFiles = await sendspinBackupFiles();
  if (sendspinFiles.length) {
    await fsp.mkdir(path.join(tempDir, 'sendspin'), { recursive: true });
    for (const { src, name } of sendspinFiles) await fsp.copyFile(src, path.join(tempDir, name));
    manifest.includes.sendspin = true;
  }

  // 6. Write manifest
  await fsp.writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const filename = `velvet-export-${ts}-${crypto.randomBytes(4).toString('hex')}.zip`;
  const zipFile = path.join(stagingDir(), filename);

  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipFile, { mode: 0o600 });
      const archive = new ZipArchive({ zlib: { level: 6 } });
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(tempDir, false);
      archive.finalize();
    });
  } catch (e) {
    await fsp.rm(zipFile, { force: true });
    throw e;
  }
  return { path: zipFile, filename, manifest };
}

// ── Import ───────────────────────────────────────────────────────────────────
// The upload step (unzip with entry/byte budgets) is not built yet (docs/dev/todo.md), so
// apply only reads import folders inside the owner-only staging folder.

async function applyImportData(extractId, options = {}) {
  const { keepUsers = true } = options;
  if (!IMPORT_ID_RE.test(String(extractId))) throw new Error('Invalid import id');
  const extractDir = resolvePathWithinRoot(stagingDir(), extractId);
  const manifestPath = path.join(extractDir, 'manifest.json');

  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));

  // Throws on a corrupt config before it replaces the live one.
  const imported = JSON.parse(await fsp.readFile(path.join(extractDir, 'default.json'), 'utf8'));
  await config.updateConfigFile(current => {
    const users = current.users ?? {};
    for (const key of Object.keys(current)) delete current[key];
    Object.assign(current, imported);
    if (keepUsers) current.users = users;
  });

  // Reload config
  await config.setup(config.configFile);
  
  // 2. Restore database — accept both velvet.sqlite (new) and mstream.sqlite (legacy backup)
  let dbFile = path.join(extractDir, 'velvet.sqlite');
  try {
    await fsp.access(dbFile);
  } catch {
    dbFile = path.join(extractDir, 'mstream.sqlite');
    await fsp.access(dbFile);
  }
  const dbDir = config.program.storage.dbDirectory;
  const dbDest = path.join(dbDir, 'velvet.sqlite');
  
  dbManager.close();
  try {
    await fsp.copyFile(dbFile, dbDest);
  } finally {
    await dbManager.initDB();
  }

  // 3. Restore waveforms if present
  const waveformSrc = path.join(extractDir, 'waveform-cache');
  const waveformDest = config.program.storage.waveformDirectory;
  try {
    await fsp.access(waveformSrc);
    await fsp.mkdir(waveformDest, { recursive: true });
    await fsp.cp(waveformSrc, waveformDest, { recursive: true });
  } catch (e) {
    winston.warn(`[migrate] Waveform restore failed: ${e.message}`);
  }

  // 4. Restore artist images if present
  const artistSrc = path.join(extractDir, 'image-cache', 'artists');
  const artistDest = path.join(config.program.storage.albumArtDirectory, 'artists');
  try {
    await fsp.access(artistSrc);
    await fsp.mkdir(path.dirname(artistDest), { recursive: true });
    await fsp.cp(artistSrc, artistDest, { recursive: true });
  } catch (e) {
    winston.warn(`[migrate] Artist images restore failed: ${e.message}`);
  }
  
  await restoreRoomsFromImport(path.join(extractDir, 'sendspin'), {
    rooms: { stop: sendspinApi.stop, settingsChanged: sendspinApi.settingsChanged, applySettings: sendspinApi.applySettings },
    restore: restoreSendspinFiles,
  });

  // Clean up temp directory
  await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  
  return { 
    success: true,
    message: 'Import applied successfully',
    manifest 
  };
}

// ── Export Job Store ──────────────────────────────────────────────────────────
// status: 'building' | 'ready' | 'error'
const exportJobs = new Map(); // id → { status, createdAt, path?, filename?, sizeBytes?, error? }

function pruneOldExportJobs() {
  const cutoff = Date.now() - EXPORT_TTL_MS;
  for (const [id, job] of exportJobs) {
    if (job.createdAt < cutoff) {
      if (job.path) fsp.unlink(job.path).catch(() => {});
      exportJobs.delete(id);
    }
  }
}

// Export ZIPs and build folders left by a previous run belong to no job any more.
async function removeStaleExports() {
  let entries;
  try {
    entries = await fsp.readdir(stagingDir());
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const name of entries) {
    if (name.startsWith('export-') || name.startsWith('velvet-export-')) {
      await fsp.rm(path.join(stagingDir(), name), { recursive: true, force: true });
    }
  }
}

let _pruneTimer = null;

// ── API Setup ─────────────────────────────────────────────────────────────────

export function setup(velvet) {
  if (!_pruneTimer) {
    removeStaleExports().catch(e => winston.warn(`[migrate] Could not clear old exports: ${e.message}`));
    _pruneTimer = setInterval(pruneOldExportJobs, 10 * 60 * 1000);
    _pruneTimer.unref();
  }

  // POST: start background export build, returns { id }
  velvet.post('/api/v1/admin/migrate/export/start', (req, res) => {
    pruneOldExportJobs();

    const { includeWaveforms = true, includeArtistImages = false } = req.body ?? {};
    const id = `export-${crypto.randomUUID()}`;
    exportJobs.set(id, { status: 'building', createdAt: Date.now() });

    createExportArchive({
      includeWaveforms: includeWaveforms === true || includeWaveforms === 'true',
      includeArtistImages: includeArtistImages === true || includeArtistImages === 'true'
    }).then(async (result) => {
      const stat = await fsp.stat(result.path);
      const prev = exportJobs.get(id);
      exportJobs.set(id, {
        status: 'ready',
        createdAt: prev?.createdAt ?? Date.now(),
        path: result.path,
        filename: result.filename,
        sizeBytes: stat.size,
      });
    }).catch((err) => {
      winston.error(`[migrate] Background export failed: ${err.message}`);
      const prev = exportJobs.get(id);
      exportJobs.set(id, { status: 'error', createdAt: prev?.createdAt ?? Date.now(), error: err.message });
    });

    res.json({ id });
  });

  // GET: poll export job status
  velvet.get('/api/v1/admin/migrate/export/status/:id', (req, res) => {
    const { id } = req.params;
    const job = exportJobs.get(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const out = { status: job.status };
    if (job.status === 'ready') {
      out.filename = job.filename;
      out.sizeBytes = job.sizeBytes;
    } else if (job.status === 'error') {
      out.error = job.error;
    }
    res.json(out);
  });

  // GET: download the finished ZIP (streams with auth)
  velvet.get('/api/v1/admin/migrate/export/download/:id', (req, res) => {
    const { id } = req.params;
    const job = exportJobs.get(id);
    if (!job || job.status !== 'ready') {
      return res.status(404).json({ error: 'Export not ready or expired' });
    }

    res.download(job.path, job.filename, (err) => {
      if (err) winston.error(`[migrate] Download error: ${err.message}`);
      fsp.unlink(job.path).catch(() => {});
      exportJobs.delete(id);
    });
  });

  velvet.post('/api/v1/admin/migrate/upload', (req, res) => {
    req.resume();
    res.status(501).json({ error: 'Import is not available yet' });
  });

  // Apply import - Step 2
  velvet.post('/api/v1/admin/migrate/apply', async (req, res) => {
    try {
      const { id, keepUsers = true } = req.body;
      
      if (!id) {
        return res.status(400).json({ error: 'No import ID provided' });
      }
      
      const result = await applyImportData(id, { keepUsers });
      
      res.json({
        success: true,
        message: 'Import applied successfully. Please restart the server.',
        manifest: result.manifest
      });
    } catch (e) {
      winston.error(`[migrate] Apply failed: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Get import status / manifest
  velvet.get('/api/v1/admin/migrate/status/:id', async (req, res) => {
    try {
      const { id } = req.params;
      if (!IMPORT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid import id' });
      const extractDir = resolvePathWithinRoot(stagingDir(), id);
      const manifestPath = path.join(extractDir, 'manifest.json');

      try {
        const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
        res.json({ manifest, exists: true });
      } catch {
        res.json({ exists: false });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Clean up import temp files
  velvet.post('/api/v1/admin/migrate/cleanup/:id', async (req, res) => {
    try {
      const { id } = req.params;
      if (!IMPORT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid import id' });
      const extractDir = resolvePathWithinRoot(stagingDir(), id);
      await fsp.rm(extractDir, { recursive: true, force: true });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
