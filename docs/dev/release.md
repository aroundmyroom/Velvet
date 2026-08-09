# Releasing Velvet

A release is **two parts**: the prose you write, and the mechanics the script runs.

## 1. Write the prose (during development)

These are the only things a human needs to author:

- **Changelog entry** — add `## vX.Y.Z (YYYY-MM-DD)` to the top of `changes-velvet.md`.
  The first non-heading line under the header becomes the commit/release title.
- **Release notes** — create `releases/vX.Y.Z.md` (H1: `# Velvet vX.Y.Z — <title>`).
- **API docs** — if you added a REST endpoint, add it to `docs/API.md`.

Read the last 3–5 files in `releases/` first so you don't re-announce shipped work.

## 2. Run the release

```shell
npm run release            # release the version from the top changelog entry
npm run release -- 0.1.6   # or pin an explicit version
```

(Or use the `/release` command in Claude Code, which checks the prose is ready
first, then runs this.)

The script (`scripts/release.cjs`) does, in order:

1. Reads the target version + title from the top `## vX.Y.Z` changelog header.
2. **Pre-flight guards** — refuses unless: on `main`; the tag is free; the
   changelog entry **and** `releases/vX.Y.Z.md` both exist; and (for a push) it is
   **not** the Mon–Fri 09:00–17:00 Europe/Amsterdam blackout window.
3. Bumps `package.json` and runs `npm run sync-version` (stamps every webapp
   cache-buster / `VELVET_VERSION` / `login-version`).
4. Pins `docs/docker.md` to the new version.
5. Release-note retention — keeps the newest 5 in `releases/`, `git mv`s older to
   `releases/earlier/`.
6. Runs `npm test` (aborts on failure).
7. `git add -A` → commit `vX.Y.Z: <title>`.
8. `git push origin main`.
9. `git tag vX.Y.Z` → `git push origin vX.Y.Z` (this triggers the multi-arch
   Docker build + publish to `ghcr.io/aroundmyroom/velvet`).
10. `gh release create` with `releases/vX.Y.Z.md` as the body.
11. **Tizen TV widget** — `npm run build:tizen:dist` (clean, credential-free) and
    `gh release upload` the resulting `dist/velvet-tv-X.Y.Z.wgt` onto the release.

**Every release body ALWAYS ends with a "Downloads" footer** the script appends
automatically — pointing to *both* artifacts no matter the version: the Samsung
TV widget (this release's `.wgt` asset) and the Docker image
(`docker pull ghcr.io/aroundmyroom/velvet:vX.Y.Z` + `:latest`, plus the GHCR
package page). You never hand-write these links; they are generated from the
version so they can't go stale.

## Flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Print every step, change/push nothing. Always run this first if unsure. |
| `--no-push` | Bump, sync, commit and tag **locally** — no push, no GitHub release. |
| `--force` | Override the blackout-window guard (only when you mean it). |
| `--skip-tests` | Skip `npm test` (emergencies only). |
| `--title "…"` | Override the commit/release title (default: the changelog summary line). |

## Notes

- Only `main` is ever pushed. The `art-workshop` branch must never be pushed; the
  script refuses to run anywhere but `main`.
- Commit messages never mention Claude/AI and carry no `Co-Authored-By` trailer.
- After the run, check the Docker build: `gh run list --repo aroundmyroom/Velvet --limit 1`.

## Tizen TV app (`.wgt`) — attach a CLEAN build

The Samsung TV widget ships as a GitHub **release asset**, not in the repo
(`dist/*` is git-ignored). `npm run release` now builds and attaches it
**automatically** as its final step, always using the **clean, credential-free
approach** — so every new version (e.g. `0.3.20`) gets a shareable widget with no
server URL or login baked in.

The release script runs:

```shell
npm run build:tizen:dist                                  # → dist/velvet-tv-<version>.wgt
gh release upload v<version> dist/velvet-tv-<version>.wgt  # attach to the release
```

Before uploading it aborts if the built `.wgt` looks like it contains credentials
(a safety net — the `:dist` build never reads
`webapp/tizen/velvet-tv.config.json` in the first place).

**Never attach `dist/velvet-tv.wgt`** (the plain `npm run build:tizen` output) —
that one bakes in whatever is in the git-ignored config and prints a
"do NOT distribute this build" warning.

### Manual / re-upload

If you need to (re)build and attach the widget by hand:

```shell
npm run build:tizen:dist          # clean, credential-free build
gh release upload v<version> dist/velvet-tv-<version>.wgt --repo aroundmyroom/Velvet
```

Verify the asset carries no secrets before uploading:

```shell
node -e "const s=require('fs').readFileSync('dist/velvet-tv-<version>.wgt','latin1');console.log('leak:', /aroundtheworld|password\" content=\"[^\"]/.test(s))"
# expect: leak: false
```

Release-note tip: the TV app has its own note file
(`releases/velvet-tv-<major.minor>.md`) suitable for the `--notes-file` body when
you want a dedicated TV-app release; see [`docs/tizen-tv.md`](../tizen-tv.md).
