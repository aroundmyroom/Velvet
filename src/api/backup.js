import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ZipArchive } from 'archiver';
import winston from 'winston';
import * as config from '../state/config.js';
import * as dbManager from '../db/manager.js';

const MAX_BACKUPS = 4;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function backupDir() {
  return path.join(config.program.storage.dbDirectory, '..', 'backups');
}

async function ensureBackupDir() {
  await fsp.mkdir(backupDir(), { recursive: true });
}

async function createBackup() {
  await ensureBackupDir();
  const ts = new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 16);
  const filename = `backup-${ts}.zip`;
  const filepath = path.join(backupDir(), filename);
  const dbDir = config.program.storage.dbDirectory;
  const cfgFile = config.configFile;

  const filesToInclude = [{ src: cfgFile, name: 'default.json' }];

  // Always include any db files that exist on disk — covers cases where the
  // engine was switched (e.g. loki → sqlite) and both sets of files are present.

  // SQLite — use VACUUM INTO for a safe hot-backup: produces a clean,
  // fully-checkpointed, WAL-free snapshot without needing an exclusive lock.
  // Raw file copy of a live WAL-mode database is unsafe: restoring the main
  // file without a matching WAL silently rolls back all un-checkpointed data.
  const dbFile = path.join(dbDir, 'velvet.sqlite');
  let sqliteTmp = null;
  try {
    await fsp.access(dbFile);
    sqliteTmp = path.join(os.tmpdir(), `velvet-backup-${ts}.sqlite`);
    dbManager.vacuumInto(sqliteTmp);
    filesToInclude.push({ src: sqliteTmp, name: 'velvet.sqlite' });
  } catch {
    // DB not open yet (loki engine) — skip
  }

  // Loki — three separate .db files
  for (const name of ['user-data.loki-v1.db', 'files.loki-v3.db', 'shared.loki-v1.db']) {
    const src = path.join(dbDir, name);
    try {
      await fsp.access(src);
      filesToInclude.push({ src, name });
    } catch (e) {
      // ENOENT is expected on SQLite-only installs where Loki files were never created.
      if (e?.code !== 'ENOENT') console.debug('[velvet]', e?.message ?? e);
    }
  }

  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(filepath);
      const archive = new ZipArchive({ zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      for (const { src, name } of filesToInclude) {
        archive.file(src, { name });
      }
      archive.finalize();
    });
  } finally {
    // Always clean up the temp VACUUM file even if archiver fails
    if (sqliteTmp) fsp.unlink(sqliteTmp).catch(() => {});
  }

  await pruneOldBackups();
  winston.info(`Backup created: ${filename}`);
  return filename;
}

async function pruneOldBackups() {
  const dir = backupDir();
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch { return; }

  const backups = files
    .filter(f => f.startsWith('backup-') && f.endsWith('.zip'))
    .sort(); // lexicographic order = chronological (YYYY-MM-DDTHH-mm)

  const toDelete = backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS));
  for (const f of toDelete) {
    await fsp.unlink(path.join(dir, f)).catch(() => {});
    winston.info(`Old backup removed: ${f}`);
  }
}

async function listBackups() {
  const dir = backupDir();
  try {
    const files = await fsp.readdir(dir);
    const backups = [];
    for (const f of files.filter(f => f.startsWith('backup-') && f.endsWith('.zip'))) {
      const stat = await fsp.stat(path.join(dir, f)).catch(() => null);
      backups.push({ filename: f, size: stat?.size || 0, mtime: stat?.mtimeMs || 0 });
    }
    return backups.sort((a, b) => b.mtime - a.mtime); // newest first
  } catch { return []; }
}

// ── Weekly scheduler ──────────────────────────────────────────────────────────

let _weeklyInterval = null;

async function _checkWeekly() {
  const flagFile = path.join(backupDir(), '.last-weekly');
  let lastMs = 0;
  try {
    const txt = await fsp.readFile(flagFile, 'utf8');
    lastMs = Number.parseInt(txt) || 0;
  } catch (e) {
    // ENOENT is expected on first run before the weekly marker exists.
    if (e?.code !== 'ENOENT') console.debug('[velvet]', e?.message ?? e);
  }

  if (Date.now() - lastMs >= WEEK_MS) {
    try {
      await createBackup();
      await ensureBackupDir();
      await fsp.writeFile(flagFile, String(Date.now()), 'utf8');
    } catch (e) {
      winston.error('Weekly backup failed', { stack: e });
    }
  }
}

function _startWeeklyScheduler() {
  if (_weeklyInterval) return;
  // Check on boot after 30s, then every hour
  setTimeout(() => {
    _checkWeekly().catch(() => {});
    _weeklyInterval = setInterval(() => _checkWeekly().catch(() => {}), 60 * 60 * 1000);
  }, 30_000);
}

export function setup(velvet) {
  _startWeeklyScheduler();

  // Trigger a manual backup
  velvet.post('/api/v1/admin/backup', async (req, res) => {
    try {
      const filename = await createBackup();
      res.json({ filename });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // List available backups
  velvet.get('/api/v1/admin/backups', async (req, res) => {
    try {
      res.json(await listBackups());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Download a specific backup
  velvet.get('/api/v1/admin/backup/download/:filename', async (req, res) => {
    const { filename } = req.params;
    // Validate filename to prevent path traversal
    if (!/^backup-[\dT-]+\.zip$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filepath = path.join(backupDir(), filename);
    try {
      await fsp.access(filepath);
      res.download(filepath, filename);
    } catch {
      res.status(404).json({ error: 'Backup not found' });
    }
  });
}
