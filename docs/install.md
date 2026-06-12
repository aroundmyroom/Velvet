# Install Velvet (bare-metal)

> **Prefer Docker?** See [docker.md](docker.md) for the recommended container-based setup.

## Dependencies

- Node.js v22 or greater ([nodejs.org](https://nodejs.org/en/download/package-manager/))
- npm
- git

## Install

```shell
git clone https://github.com/aroundmyroom/Velvet.git
cd Velvet
npm install --only=prod
node cli-boot-wrapper.js
```

When you upgrade a Node-based install later, rerun `npm install --only=prod` after `git pull` so updated production dependencies are installed locally.

Open **http://localhost:3000** — on a fresh install with no users the admin panel is accessible without login.

---

## Running as a systemd service (Linux)

Create `/etc/systemd/system/music.service`:

```ini
[Unit]
Description=Velvet
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/path/to/Velvet
ExecStart=/usr/bin/node cli-boot-wrapper.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```shell
systemctl daemon-reload
systemctl enable music.service
systemctl start music.service
```

---

## Running as a background process with PM2

```shell
npm install -g pm2
pm2 start cli-boot-wrapper.js --name Velvet
pm2 save
pm2 startup
```

[PM2 quick-start docs](https://pm2.keymetrics.io/docs/usage/quick-start/)

---

## Updating

```shell
git pull
npm install --only=prod
systemctl restart music.service   # or: pm2 restart all
```

That step refreshes production dependencies for new releases and security fixes.

---

## Switching from the old repo (one-time)

Older Node installs were cloned from another location, which no longer exists. Velvet now lives at `https://github.com/aroundmyroom/Velvet.git` with a **fresh git history**, so a plain `git pull` fails with *"refusing to merge unrelated histories."*

Switch the existing clone over **in place** — your config and data are never touched, because they live in gitignored folders (`save/`, `image-cache/`, `waveform-cache/`, `bin/`).

```shell
# 1. Stop the service
systemctl stop music.service        # or: pm2 stop all

# 2. Safety net — back up your config + database
cp -r save save.backup

# 3. Point the existing clone at the new repo
git remote set-url origin https://github.com/aroundmyroom/Velvet.git
git fetch origin

# 4. Move onto Velvet's main branch, replacing the old tracked source.
#    Your gitignored save/ + caches are left untouched.
git checkout -B main origin/main
git reset --hard origin/main

# 5. Refresh dependencies and restart
npm install --only=prod
systemctl restart music.service     # or: pm2 restart all
```

Your `save/conf/default.json`, `save/db/velvet.sqlite`, logs, backups, caches, and downloaded binaries all stay in place — nothing to copy. If your old install still has `save/db/mstream.sqlite`, Velvet renames it to `velvet.sqlite` on first boot so your library, users, ratings, and starred titles carry over. After it boots, confirm your library and users are intact, then optionally remove `save.backup`.

> **Note:** step 4 discards any local edits you made to *tracked* source files. Config and data are safe (gitignored); the `save.backup` in step 2 covers the rest.

> **Prefer a clean directory instead?** Clone fresh and carry your state over:
> ```shell
> git clone https://github.com/aroundmyroom/Velvet.git ~/Velvet
> cp -r /path/to/old-clone/save ~/Velvet/
> cp -r /path/to/old-clone/image-cache /path/to/old-clone/waveform-cache ~/Velvet/   # optional caches
> cd ~/Velvet && npm install --only=prod
> # then update WorkingDirectory= in /etc/systemd/system/music.service to the new path:
> systemctl daemon-reload && systemctl restart music.service
> ```

