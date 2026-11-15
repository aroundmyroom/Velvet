import { DatabaseSync } from 'node:sqlite';

// A worker thread cannot share the main thread's connection; every worker opens its
// own through here so they all get the same WAL / busy-timeout settings as the main one.
export function openWorkerDb(dbPath, { busyTimeoutMs = 30_000, cacheKb = 4000 } = {}) {
  const db = new DatabaseSync(dbPath, { timeout: busyTimeoutMs });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`PRAGMA cache_size = -${cacheKb}`);
  return db;
}
