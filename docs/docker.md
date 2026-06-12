# Running Velvet with Docker

> ### ⚠️ Upgrading from earlier fork versions — action required
>
> **Velvet now runs as the unprivileged `node` user by default.** Before restarting your container after pulling the new image you must:
>
> **1. Find your UID/GID** (the user that should own the files Velvet writes):
> ```shell
> id <your-username>
> # example output: uid=1000(jan) gid=1000(jan)
> ```
>
> **2. Fix ownership of the Velvet data directories on your host** (they were written as root before):
> ```shell
> # Replace 1000:1000 with your actual UID:GID
> chown -R 1000:1000 /path/to/save \
>                    /path/to/image-cache \
>                    /path/to/waveform-cache
> ```
> Do **not** chown your music library — those files are already owned correctly.
>
> **3. Leave `user:` unset for the first restart** so the entrypoint can repair ownership automatically. After startup succeeds, optionally set `user:` to your host UID/GID.
> ```yaml
> # user: "1000:1000"
> ```
>
> **4. Then pull and restart:**
> ```shell
> docker compose pull
> docker compose down
> docker compose up -d
> ```
>
> If your library and writable host folders are already owned by your target UID/GID, you can set `user:` immediately. If not, keep it unset until ownership is fixed.

---

## Migrating from the previous image

The project was previously hosted at `github.com/aroundmyroom/mstream` (that repository no longer exists). The Docker image has moved:

| Before | After |
|---|---|
| `ghcr.io/aroundmyroom/mstream-velvet:vX.Y.Z-velvet` | `ghcr.io/aroundmyroom/velvet:vX.Y.Z` |

or use `ghcr.io/aroundmyroom/velvet:latest`

**Your data is fully compatible.** The volume structure (`save/`, `image-cache/`, `waveform-cache/`) is unchanged — no data migration is needed.

### Steps

1. Stop your current container:
   ```shell
   docker compose down
   ```

2. Update the `image:` line in your `compose.yaml`:
   ```yaml
   # Before
   image: ghcr.io/aroundmyroom/mstream-velvet:latest

   # After
   image: ghcr.io/aroundmyroom/velvet:latest
   ```

3. Pull and restart:
   ```shell
   docker compose pull
   docker compose up -d
   ```

That's it — all your music, playlists, users, and settings are preserved in the mounted volumes.

---

## Updating to the latest release

If you installed via `compose.yaml` with `image: ghcr.io/aroundmyroom/velvet:latest`:

```shell
docker compose pull          # fetch the new image
docker compose down
docker compose up -d         # recreate the container
```

That's it — your `save/` folder (config, database, logs) and music volume are mounted from the host, so no data is lost.

> **Pinned to a specific version?** Update the tag in `compose.yaml` (e.g. `v0.0.1`), then run the same three commands.
> Check the [GitHub releases page](https://github.com/aroundmyroom/Velvet/releases) for the latest tag.

---

## Quick start — pull from GitHub Container Registry

The easiest way. No build step required.

```shell
docker pull ghcr.io/aroundmyroom/velvet:latest
```

Or pin to a specific release:

```shell
docker pull ghcr.io/aroundmyroom/velvet:v0.1.0
```

### compose.yaml (ghcr.io — recommended)

```yaml
services:
  velvet:
    image: ghcr.io/aroundmyroom/velvet:latest
    container_name: velvet
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./save:/app/save
      - /media/music:/music         # adjust host path to your library
      - ./waveform-cache:/app/waveform-cache
      - ./image-cache:/app/image-cache
    # user: "1000:1000"             # optional; enable only after host folder ownership is correct
    environment:
      MSTREAM_MUSIC_DIR: /music     # triggers first-run auto-config (optional, see below)
```

```shell
docker compose up -d
```

Open **http://localhost:3000**

---

## Build from source

```shell
git clone https://github.com/aroundmyroom/Velvet.git
cd Velvet
docker build -t velvet .
```

Then change the `image:` line in `compose.yaml` to `velvet`.

---

## How the image is published

Every time a `v*` tag is pushed to GitHub, the workflow `.github/workflows/docker-publish.yml` automatically:

1. Builds a multi-arch image (`linux/amd64` + `linux/arm64`)
2. Pushes it to `ghcr.io/aroundmyroom/velvet` with the version tag and `latest`

No manual steps are needed — tagging a release is enough.

---

## Volumes explained

| Volume | What it stores | Required? |
|---|---|---|
| `/app/save` | Config file (`save/conf/default.json`), SQLite database (`save/db/velvet.sqlite`), logs, sync state | **Yes** — without this, all data is lost on container restart |
| `/music` (or any host path) | Your music files — must be added to the config as a folder (see below) | Yes, unless music is already inside the image |
| `/app/waveform-cache` | Pre-computed waveforms (regenerated if missing, but takes time) | Recommended |
| `/app/image-cache` | Cached album art, podcast art, radio logos | Recommended |

---

## User / permission mapping

The container defaults to a root entrypoint that repairs host volume ownership and then drops to the unprivileged `node` user.

If your mounted shares already use a specific owner, you can set `user:` in `compose.yaml` to that UID/GID.

### Find your UID / GID

On the host (or in the NAS shell):

```shell
id <your-music-user>
# example output:  uid=1000(soulseek) gid=1000(soulseek)
```

### Set them in compose.yaml (optional)

```yaml
  user: "1000:1000"   # optional: only after mounted folders are writable by this UID:GID
```

If you are migrating from older root-owned data, keep `user:` unset for one restart so the entrypoint can repair ownership.

### Migration from a root container

If you previously ran as root, the `save/`, `image-cache/`, and `waveform-cache/` directories on your host may be owned by root. Fix them before restarting:

```shell
docker compose down

# Replace 1000:1000 with your actual UID:GID
chown -R 1000:1000 /path/to/save \
                   /path/to/image-cache \
                   /path/to/waveform-cache

# Leave `user:` unset for this first restart so ownership repair can run, then optionally set it later.
docker compose up -d
```

Your **music files** are already owned by your NAS user — do **not** chown those.

---

## First run — adding your music library

On first start Velvet creates a blank config at `save/conf/default.json`.

### Option 1 — environment variables (simple single-library setup)

Add an `environment:` block to your `compose.yaml`. Velvet will write the initial config automatically on the very first start and skip this step on every subsequent restart.

Complete copy-paste example:

```yaml
services:
  velvet:
    image: ghcr.io/aroundmyroom/velvet:latest
    container_name: velvet
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./save:/app/save            # config, database, logs
      - /media/music:/music         # your music library (adjust host path)
      - ./waveform-cache:/app/waveform-cache
      - ./image-cache:/app/image-cache
    # user: "1000:1000"            # optional; set only when mounted folders are writable by this UID:GID
    environment:
      MSTREAM_MUSIC_DIR: /music     # must match the volume target above

      # Admin account (optional).
      # If omitted the server starts in open mode — no login required.
      # MSTREAM_ADMIN_USER: admin
      # MSTREAM_ADMIN_PASS: changeme

      # Extra feature folders — uncomment to enable.
      # By default each type is applied directly to MSTREAM_MUSIC_DIR (/music).
      # If your files live in a sub-folder, add the matching *_SUBDIR variable:
      #   MSTREAM_ENABLE_YOUTUBE: "true"
      #   MSTREAM_YOUTUBE_SUBDIR: YouTube        # → folder root becomes /music/YouTube
      # You can also add, change or remove folders at any time in the Admin panel.
      # For full control, skip env vars and edit save/conf/default.json directly.

      # AudioBooks & Podcasts  (type: audio-books)
      # MSTREAM_ENABLE_AUDIOBOOKS: "true"
      # MSTREAM_AUDIOBOOKS_SUBDIR: Audiobooks    # optional — omit to use /music directly

      # Radio Recordings  (type: recordings — also enables the radio feature)
      # MSTREAM_ENABLE_RECORDINGS: "true"
      # MSTREAM_RECORDINGS_SUBDIR: Recordings    # optional — omit to use /music directly

      # YouTube Downloads  (type: youtube)
      # MSTREAM_ENABLE_YOUTUBE: "true"
      # MSTREAM_YOUTUBE_SUBDIR: YouTube          # optional — omit to use /music directly
```

```shell
docker compose up -d
```

Open **http://localhost:3000** (or the admin panel at **/admin** to start a scan).

> **When env vars are NOT sufficient** — use Option 2 instead if you need:
> multiple mount points, child-vpaths, `albumsOnly`/`filepathPrefix` filtering, or any advanced folder layout.

### Option 2 — edit the config file directly

Edit `save/conf/default.json` to point at your music volume:

```json
{
  "folders": {
    "music": {
      "root": "/music"
    }
  }
}
```

Then restart the container:

```shell
docker compose restart
```

Open the admin panel at **http://localhost:3000/admin** — no login is required on a fresh install with no users. Start a scan from the **Scan** button.

---

## Adding users

Once the library has been scanned, create your first user in the admin panel under **Users**. The first user should have admin access.

After creating at least one user, the server requires login and the no-auth bypass is disabled.

---

## Updating

Pull the latest changes, rebuild the image, and restart:

```shell
git pull
docker build -t velvet .
docker compose up -d
```

Your data in the mounted volumes is untouched.

---

## Useful commands

| Command | Effect |
|---|---|
| `docker compose up -d` | Start in background |
| `docker compose down` | Stop and remove container |
| `docker compose restart` | Restart after config change |
| `docker compose logs -f` | Follow live logs |
| `docker exec -it velvet sh` | Shell into the running container |

---

## Running without Docker Compose

```shell
docker run -d \
  --name velvet \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /home/Velvet/save:/app/save \
  -v /media/music:/music \
  -v /home/Velvet/waveform-cache:/app/waveform-cache \
  -v /home/Velvet/image-cache:/app/image-cache \
  velvet
```

---

## Behind a reverse proxy

If you run Velvet behind nginx or Caddy, see [deploy.md](deploy.md) for the recommended nginx configuration — required for large FLAC libraries to avoid stall on idle connections.
