# Updates — Admin → Updates

Velvet can tell you when a new release is out, show you its release notes, and
— on installs where that is safe — update itself and restart, all from the
admin area. Admins only.

## Seeing it without opening the page

The admin sidebar item **Server → Updates** carries a red badge with the new
version number (for example `v0.6.1`) whenever a newer release exists, so a
new release is visible the moment the admin area opens. The badge uses the same
cached check as the page and disappears once the install is on that version.

## What the page shows

- **Installed vs. latest release.** The latest comes from GitHub's releases
  API (`/repos/aroundmyroom/Velvet/releases/latest`), cached for 30 minutes;
  **Check now** forces a fresh lookup. Drafts and pre-releases are ignored, so
  only a real `vX.Y.Z` tag is ever offered. If GitHub can't be reached (or its
  unauthenticated rate limit — 60 requests/hour per IP — is hit) the page says
  so and keeps the last good answer.
- **Release notes** for that release, rendered from the GitHub release body.
  Reading them never changes anything — they are there so you can decide.
- **Can this install update itself?** — a checklist of exactly what the
  updater needs, each line with a ✓/✗ and, when ✗, the reason *and* the fix.
- **Update to vX.Y.Z** — a separate, explicitly confirmed action, enabled only
  when a newer release exists *and* every check passes.

## What "update" actually does (bare-metal / systemd / pm2)

The same steps `docs/install.md` tells you to run by hand, with every step's
output streamed to the page as a progress log:

1. **Preflight** — re-checks everything below; refuses if anything is off.
   Boot-stamped cache-buster files (`webapp/*/index.html` version stamps) are
   discarded since the server rewrites them on every start; any *other* local
   change blocks the update rather than being overwritten.
2. **`git fetch --tags origin`** — then verifies the tag exists.
3. **Fast-forward** — on a branch (`main`): `git merge --ff-only vX.Y.Z`, so
   the branch moves to the release and a later manual `git pull` still works.
   On a detached HEAD it simply checks the tag out. A checkout with local
   commits not in the release is refused.
4. **`npm install --omit=dev`** — only when `package.json`/`package-lock.json`
   changed between the old and new version; npm's output is the progress.
5. **Verify** — the new `package.json` reports the target version and the
   entry point parses.
6. **Restart** — see below. If steps 4–5 fail, the checkout is reset to the
   previous commit (`git reset --hard <old>`, safe because the tree was
   verified clean) and no restart happens; the page shows the error and log.

The page polls the job every second while it runs, then — once the process
exits to restart — waits for the server to answer again with the new version
and reloads itself to pick up the new admin UI.

### Who may update, and as whom

Only an admin account can see the page or start an update. The update runs
*inside the Velvet process*, so it runs as whatever OS user runs Velvet — the
checklist shows that user and whether it can write the application folder,
`.git`, `package.json` and `node_modules`. If not, the fix is shown
(`chown -R <user> <folder>`, or run Velvet as the owning user). Running as
`root` always passes; it is still a good idea to own the folder as the service
user.

### How the restart works

Node caches modules, so an in-process reload can't load new code — the process
must exit and come back. The updater detects what will bring it back:

| Supervisor | Detected by | Restart |
|---|---|---|
| **systemd** | `INVOCATION_ID` in the environment | exits with code 1 — restarts under both `Restart=on-failure` (what `docs/install.md` ships) and `Restart=always` |
| **pm2** | `PM2_HOME` / `pm_id` | exits with code 1 — pm2 restarts on any exit |
| **none** | neither | starts a detached copy of itself, then exits. Works, but that copy's stdout/stderr go nowhere — run under systemd or pm2 |

Playback stops for the restart (roughly 10 seconds). Sonos casts resume from
the web player once it reconnects.

## Docker

Inside a container the application files are part of the image and there is
no git, so the updater does not touch anything. The page still checks for and
shows the new release and its notes, then tells you how to update: pull the
new image and recreate the container — Portainer, Dockhand, Watchtower, or
the `docker pull` / `docker compose up -d` commands it prints with the right
tag. That is the correct Docker update path; an in-container file update would
be undone by the next recreate.

## Requirements (bare-metal)

- Installed with `git clone` (the method in `docs/install.md`), origin pointing
  at `github.com/aroundmyroom/Velvet`.
- `git` on the system; `npm` next to the `node` that runs Velvet or on PATH
  (only needed when a release changes dependencies).
- The Velvet process user can write the application folder.
- A clean checkout: no uncommitted changes, no local commits.
- Outbound HTTPS to `api.github.com` and `github.com`.

## API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/admin/update/check?force=1` | Installed vs. latest release, release notes, the environment checklist with blockers, Docker hints, and the current job state. |
| `POST` | `/api/v1/admin/update/start` | `{ version }` — must equal the latest release shown. Refused when blocked, already on it, or a job is running. |
| `GET` | `/api/v1/admin/update/status` | Job state: `state` (`idle`/`running`/`restarting`/`failed`/`done`), `phase`, `percent`, `log[]`, `error`. |

All three are admin-only. Every log line also goes to the server log as
`[update] …`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Button is grey, checklist shows ✗ | Read the red line under the checklist — it names the exact fix. |
| "Local changes" lists `webapp/index.html` only | Normal after a manual edit of a webapp file; those stamps are discarded automatically. Anything else listed is a real local edit — commit or revert it. |
| "GitHub API rate limit reached" | Unauthenticated GitHub allows 60 checks/hour per IP; wait, the last good result stays shown. |
| Update failed at npm | The previous version was restored automatically. The log shows npm's own error; the usual cause is no network or a node version older than the release requires. |
| Page never comes back after "Restarting" | The supervisor didn't restart Velvet — check `systemctl status music.service` / `pm2 ls`. The files are already at the new version; a manual start finishes the job. |
