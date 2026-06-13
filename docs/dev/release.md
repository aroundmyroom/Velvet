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
