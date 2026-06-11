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

