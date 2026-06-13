import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import busboy from 'busboy';
import { ZipArchive } from 'archiver';
import winston from 'winston';
import * as config from '../state/config.js';
import * as dbManager from '../db/manager.js';
import { resolvePathWithinRoot } from '../util/path-security.js';

const TMP_DIR = os.tmpdir();

function getVpathRoots() {
  const cfg = config.program;
  return cfg.vpaths ? Object.keys(cfg.vpaths) : [];
}

// ── Export ───────────────────────────────────────────────────────────────────

async function createExportArchive(options = {}) {
  const {
    includeWaveforms = true,
    includeArtistImages = false
  } = options;

  const ts = new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 16);
  const tempDir = path.join(TMP_DIR, `velvet-migrate-${ts}`);
  await fsp.mkdir(tempDir, { recursive: true });

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
  const dbDir = config.program.storage.dbDirectory;
  const dbFile = path.join(dbDir, 'velvet.sqlite');
  let dbCopy = null;
  
  try {
    await fsp.access(dbFile);
    dbCopy = path.join(tempDir, 'velvet.sqlite');
    dbManager.vacuumInto(dbCopy);
    
    // Wait a bit for vacuum to complete
    await new Promise(resolve => setTimeout(resolve, 1000));
  } catch (e) {
    winston.error(`[migrate] Could not access DB file: ${e.message}`);
    throw new Error('Database file not found');
  }

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

  // 5. Write manifest
  await fsp.writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // 6. Create ZIP
  const zipFile = path.join(TMP_DIR, `velvet-export-${ts}.zip`);
  const output = fs.createWriteStream(zipFile);
  const archive = new ZipArchive({ zlib: { level: 6 } });

  return new Promise((resolve, reject) => {
    output.on('close', async () => {
      // Clean up temp directory
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      resolve({ 
        path: zipFile, 
        filename: `velvet-export-${ts}.zip`,
        manifest 
      });
    });
    
    archive.on('error', async (err) => {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      reject(err);
    });

    archive.pipe(output);
    
    // Add all files from temp dir to zip
    archive.directory(tempDir, false);
    
    archive.finalize();
  });
}

// ── Import ───────────────────────────────────────────────────────────────────

async function handleImportUpload(req) {
  const extractId = `velvet-import-${Date.now()}`;
  const extractDir = path.join(TMP_DIR, extractId);
  
  await fsp.mkdir(extractDir, { recursive: true });
  
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers });
    let zipFile = null;
    
    bb.on('file', (fieldname, file, info) => {
      if (fieldname !== 'file') {
        file.resume();
        return;
      }
      
      zipFile = path.join(TMP_DIR, `upload-migrate-${extractId}.zip`);
      const writeStream = fs.createWriteStream(zipFile);
      
      file.pipe(writeStream);
      
      writeStream.on('finish', () => {
        // File saved, now extract it
        const { Extract } = require('node:fs');
        const { createReadStream } = fs;
        
        const extract = Extract({ path: extractDir });
        const input = createReadStream(zipFile);
        
        input.pipe(extract);
        
        extract.on('close', async () => {
          // Clean up uploaded zip file
          await fsp.unlink(zipFile).catch(() => {});
          
          // Read manifest
          try {
            const manifestPath = path.join(extractDir, 'manifest.json');
            const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
            resolve({ 
              id: extractId,
              extractDir,
              manifest 
            });
          } catch (e) {
            reject(e);
          }
        });
        
        extract.on('error', reject);
      });
      
      writeStream.on('error', reject);
    });
    
    bb.on('error', reject);
    bb.on('finish', () => {
      if (!zipFile) {
        reject(new Error('No file uploaded'));
      }
    });
    
    req.pipe(bb);
  });
}

async function applyImportData(extractId, options = {}) {
  const { keepUsers = true } = options;
  let extractDir;
  try {
    extractDir = resolvePathWithinRoot(TMP_DIR, extractId);
  } catch {
    throw new Error('Invalid import id');
  }
  const manifestPath = path.join(extractDir, 'manifest.json');
  
  // Read manifest
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  
  // 1. Restore configuration
  const configSrc = path.join(extractDir, 'default.json');
  const configDest = config.configFile;
  
  // Read the imported config to handle vpath remapping
  const importedConfig = JSON.parse(await fsp.readFile(configSrc, 'utf8'));
  const currentConfig = config.program;
  
  // Handle vpath remapping - this would need UI interaction
  // For now, just restore config as-is
  await fsp.copyFile(configSrc, configDest);
  
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
  
  // Close current DB
  dbManager.close();
  
  // Replace database file
  await fsp.copyFile(dbFile, dbDest);
  
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
  const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour TTL
  for (const [id, job] of exportJobs) {
    if (job.createdAt < cutoff) {
      if (job.path) fsp.unlink(job.path).catch(() => {});
      exportJobs.delete(id);
    }
  }
}

// ── API Setup ─────────────────────────────────────────────────────────────────

export function setup(velvet) {

  // POST: start background export build, returns { id }
  velvet.post('/api/v1/admin/migrate/export/start', (req, res) => {
    pruneOldExportJobs();

    const { includeWaveforms = true, includeArtistImages = false } = req.body ?? {};
    const id = `export-${Date.now()}`;
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

  // Upload for import - Step 1
  velvet.post('/api/v1/admin/migrate/upload', async (req, res) => {
    try {
      const result = await handleImportUpload(req);
      
      res.json({
        id: result.id,
        manifest: result.manifest,
        message: 'ZIP uploaded and extracted. Review manifest and apply.'
      });
    } catch (e) {
      winston.error(`[migrate] Upload failed: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Apply import - Step 2
  velvet.post('/api/v1/admin/migrate/apply', async (req, res) => {
    try {
      const { id, keepUsers = true, pathMappings = {} } = req.body;
      
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
      const extractDir = resolvePathWithinRoot(TMP_DIR, id);
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
      const extractDir = resolvePathWithinRoot(TMP_DIR, id);
      await fsp.rm(extractDir, { recursive: true, force: true });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
