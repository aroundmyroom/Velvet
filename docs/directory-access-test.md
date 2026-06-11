# Directory Access Test

> **Admin Panel → Directories → Test Access**
> Added in v5.16.10-velvet

---

## What it does

When you click **Test Access** in the Directories card, Velvet immediately checks every configured vpath directory for read *and* write access, then shows the results in a modal — no server restart needed.

For each directory the server:
1. Opens the directory for reading (`fs.access R_OK`)
2. Creates a uniquely-named temp file (`.velvet-writetest-<timestamp>-<random>`)
3. Reads the temp file back to confirm the write succeeded
4. **Deletes the temp file** — no artifact is ever left on disk

---

## Reading the results

| Indicator | Meaning |
|---|---|
| ✓ Read + ✓ Write (green/green) | Full access — all features work |
| ✓ Read + ✗ Write (green/amber) | Read-only — streaming works, but cover-art embedding and tag writing will fail |
| ✗ Read (red) | No access at all — the directory cannot be opened |

Any OS error code (e.g. `EACCES`, `EROFS`, `ENOENT`) is shown alongside the indicator row.

---

## Storage-type badge

Velvet auto-detects the storage type from the path and running platform:

| Badge | Detected when |
|---|---|
| **Linux local** | Linux, path does not start with `/mnt/`, `/media/`, `/run/media/`, or `/net/` |
| **Linux mounted drive** | Linux, path starts with `/mnt/`, `/media/`, `/run/media/`, or `/net/` |
| **Windows local drive** | Windows, path does not start with `\\` |
| **Windows network share** | Windows, path starts with `\\` (UNC path) |
| **macOS local** | macOS, path does not start with `/Volumes/` |
| **macOS external drive** | macOS, path starts with `/Volumes/` |

---

## Fixing permission problems

### Linux / macOS — read-only or no access

```bash
# Give the user running Velvet ownership and full rw access
sudo chown -R $(whoami) /path/to/music
chmod -R u+rw /path/to/music
```

If Velvet runs as a systemd service under a dedicated user (e.g. `velvet`):

```bash
sudo chown -R velvet:velvet /path/to/music
sudo chmod -R u+rw /path/to/music
```

After fixing permissions, click **Test Access** again — no restart needed.

### Windows — read-only or no access

1. Right-click the music folder → **Properties** → **Security** tab
2. Select the user account or service account that runs Velvet
3. Click **Edit** → check **Modify** (which includes Read + Write + Delete)
4. Click **OK / Apply**

### Mounted / network drives

- The drive must be mounted *before* Velvet starts. If it was mounted after startup, restart the service: `systemctl restart music.service`
- Network shares require the Velvet service account to have credentials for the share; anonymous mounts are often read-only by default

---

## API reference

```
GET /api/v1/admin/directories/test
Authorization: Bearer <admin token>
```

**Response:**

```json
{
  "platform": "linux",
  "results": [
    {
      "vpath": "Music",
      "root": "/mnt/nas/music",
      "storageType": "linux-mounted",
      "readable": true,
      "writable": false,
      "error": "EACCES"
    }
  ]
}
```

`storageType` values: `linux-local`, `linux-mounted`, `windows-local`, `windows-network`, `mac-local`, `mac-external`
