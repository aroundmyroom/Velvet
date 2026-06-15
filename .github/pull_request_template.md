## What & why

<!-- One or two lines: what this changes and the reason. -->

## Checklist

- [ ] `npm test` passes locally (all 216 tests)
- [ ] `npm run lint` is clean
- [ ] Changelog updated — `## vX.Y.Z` entry in `changes-velvet.md`
- [ ] New user-visible strings use i18n keys, added to **all 12** locale files (`node scripts/check-locale-sync.cjs`)
- [ ] Version cache-busters synced (`npm run sync-version`, no diff)
- [ ] New REST endpoints documented in `docs/API.md`
- [ ] No AI attribution / `Co-Authored-By` in commits
- [ ] Branch is `feat/…`, `fix/…`, or `chore/…` (not `main`, not `art-workshop`)

## Verification

<!-- How this was tested: tests, manual run on a non-3000 port, curl against the API, etc. -->
