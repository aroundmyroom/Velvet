# Admin Backup

Back up the database and configuration file from the admin panel.

## What is backed up

Each backup is a zip file containing:

- `velvet.sqlite` — the main database. It is written with SQLite `VACUUM INTO`, so it is a clean snapshot of the live database with no `-wal`/`-shm` files to copy.
- `default.json` — the active configuration file
- `sendspin/server-key.json` and `sendspin/trust-store.json` (plus `rooms.json` and `known-devices.json` when present) — the Velvet Rooms identity and pairing records. They are only included when both the key and the trust store exist, because one does not work without the other.

## Restoring

There is no restore button in the admin panel. To restore, stop Velvet, unzip the backup, and copy `velvet.sqlite` into `save/db/`, `default.json` into `save/conf/` and the `sendspin/` files into `save/sendspin/`, then start Velvet again.

## Storage location

Backups are stored in `backups/` next to the database directory (`save/backups/` by default), named `backup-YYYY-MM-DDTHH-mm-ss.zip`. A backup holds the config (login secret, password hashes, API keys), so the folder is created owner-only (`0700`) and each zip is written owner-only (`0600`).

## Failures

A backup either completes or fails loudly: if the database snapshot or the zip cannot be written, the manual backup answers `500` with the error, the weekly backup logs "Weekly backup failed" and tries again an hour later, and the partial zip is removed. Only a missing database file (a fresh install) is skipped; the zip then holds the config alone.

## Retention

Up to **4 backups** are kept. When a fifth backup is created the oldest is automatically deleted. This applies to manual and automatic backups alike.

## Manual backup

Open the admin panel → **Backup** (under **Server**) → click **Create Backup Now**.

The backup list shows filename, size, creation date, and a **Download** button for each backup.

## Automatic weekly backup

Velvet checks every hour (first check 30 seconds after boot) whether 7 days have passed since the last automatic backup. If so, a new backup is created.

The last-run timestamp is stored in `save/backups/.last-weekly`; it is only updated after a successful backup.

## API endpoints

All endpoints require admin authentication (`/api/v1/admin/*` guard).

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/admin/backup` | Create a backup now; returns `{ filename }` |
| `GET` | `/api/v1/admin/backups` | List backups, newest first; returns array of `{ filename, size, mtime }` |
| `GET` | `/api/v1/admin/backup/download/:filename` | Download a backup zip |

## Source

`src/api/backup.js`
