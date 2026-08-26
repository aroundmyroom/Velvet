import { statfsSync } from 'node:fs';

const LOW_DISK_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Classify a boot-time DB or config failure into a stable category string.
 * Returns null for failures that should crash as usual (migration bugs, etc.).
 *
 * Holdable categories (environmental — user can fix without a code change):
 *   disk-full       — storage at or near 0 free bytes
 *   db-io           — SQLite I/O error (WAL shared-memory, FUSE, network FS)
 *   db-damaged      — corrupt or truncated database file
 *   db-unwritable   — PUID/permission mismatch
 *   db-locked       — CIFS/NFS broken byte-range locking
 *   db-missing-dir  — configured directory does not exist / cannot be created
 */
export function classifyBootError(err, dbDirectory) {
  if (!err) return null;
  const msg   = (err.message || '').toLowerCase();
  const code  = err.code;
  // node:sqlite exposes errcode (SQLite extended result code) on thrown errors.
  const errcode = err.errcode ?? 0;

  // SQLite extended result codes — see https://www.sqlite.org/rescode.html
  // SQLITE_IOERR family: 0x0A = 10, upper byte = extended subcode
  const isIoErr    = (errcode & 0xFF) === 10; // SQLITE_IOERR (any sub-code)
  const isCorrupt  = (errcode & 0xFF) === 11; // SQLITE_CORRUPT
  const isReadonly = (errcode & 0xFF) === 8;  // SQLITE_READONLY
  const isBusy     = errcode === 5 || errcode === 6; // SQLITE_BUSY / SQLITE_LOCKED

  // Directory missing / permission denied at the OS level
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
    return 'db-missing-dir';
  }
  if (msg.includes('no such file or directory') || msg.includes('cannot open')) {
    return 'db-missing-dir';
  }

  // Disk full — check free space if we can
  if (isIoErr || msg.includes('disk i/o error') || msg.includes('ioerr')) {
    const free = _freeBytes(dbDirectory);
    if (free !== null && free < LOW_DISK_BYTES) return 'disk-full';
    return 'db-io';
  }

  if (isCorrupt || msg.includes('database disk image is malformed') || msg.includes('file is not a database')) {
    return 'db-damaged';
  }

  if (isReadonly || msg.includes('attempt to write a readonly database') || msg.includes('readonly')) {
    return 'db-unwritable';
  }

  if (isBusy || msg.includes('database is locked') || msg.includes('database table is locked')) {
    return 'db-locked';
  }

  return null; // not a known environmental failure — crash as usual
}

function _freeBytes(dir) {
  try {
    const s = statfsSync(dir || '/');
    return s.bfree * s.bsize;
  } catch {
    return null;
  }
}

/** Human-readable title and hint for each category. */
export function bootErrorMessage(category, dbDirectory, freeBytes) {
  const dir = dbDirectory || '(unknown)';
  const free = freeBytes != null
    ? _humanBytes(freeBytes) + ' free'
    : 'unknown free space';
  switch (category) {
    case 'disk-full':
      return {
        title: 'Disk full',
        detail: `The volume holding the database is full or nearly full (${free} on ${dir}). Free up space and Velvet will recover automatically.`,
      };
    case 'db-io':
      return {
        title: 'Database I/O error',
        detail: `Velvet cannot read or write its database at ${dir}. This usually means the storage is on a network filesystem (FUSE, sshfs, mergerfs with cache.files=off) that does not support SQLite WAL shared-memory. Move the database to local storage, or contact support.`,
      };
    case 'db-damaged':
      return {
        title: 'Database file damaged',
        detail: `The database file at ${dir} appears corrupt or truncated. Restore from a backup (Admin → Backup), or remove the file to start fresh.`,
      };
    case 'db-unwritable':
      return {
        title: 'Database directory not writable',
        detail: `Velvet cannot write to its database directory at ${dir}. Check that the PUID/PGID environment variables match the owner of that directory.`,
      };
    case 'db-locked':
      return {
        title: 'Database locked',
        detail: `The database at ${dir} is locked by another process, or the filesystem does not support byte-range locking (CIFS/NFS). If the volume is on CIFS, add the nobrl mount option. If it is on NFS, ensure lockd/statd are running or move the database to local storage.`,
      };
    case 'db-missing-dir':
      return {
        title: 'Database directory missing or inaccessible',
        detail: `Velvet cannot access the database directory at ${dir}. Check that the path exists and that the process has read/write permission.`,
      };
    default:
      return {
        title: 'Startup error',
        detail: 'Velvet encountered an unexpected error and cannot start. Check the logs for details.',
      };
  }
}

function _humanBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(0) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}
