# Admin Backup

Backups the database and configuration file from the admin panel.

## What is backed up

Each backup is a zip file containing:

- `velvet.sqlite` — the main database (plus `velvet.sqlite-wal` / `velvet.sqlite-shm` if WAL files are present)
- `default.json` — the active configuration file

## Storage location

Backups are stored in `save/backups/` (sibling of `save/db/`).

## Retention

Up to **4 backups** are kept. When a fifth backup is created the oldest is automatically deleted.

## Manual backup

Open the admin panel → **Backup** section → click **Create Backup Now**.

The backup list shows filename, size, creation date, and a **Download** button for each backup.

## Automatic weekly backup

Velvet checks every hour (with a 30-second delay on boot) whether 7 days have elapsed since the last automatic backup. If so, a new backup is created.

The last-run timestamp is stored in `save/backups/.last-weekly`.

## API endpoints

All endpoints require admin authentication (`/api/v1/admin/*` guard).

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/admin/backup` | Create a backup now; returns `{ filename }` |
| `GET` | `/api/v1/admin/backups` | List backups; returns array of `{ filename, size, mtime }` |
| `GET` | `/api/v1/admin/backup/download/:filename` | Download a backup zip |

## Source

`src/api/backup.js`
