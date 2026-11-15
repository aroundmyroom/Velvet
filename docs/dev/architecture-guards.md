# Architecture guards

The `test/arch-*.test.mjs` files are static checks that run with `npm test` (and so in CI). They parse the code with
`acorn` and fail the build when a new violation appears, so the codebase never needs a full manual survey again.
Shared parsing, walking and route-collection code lives in `test/helpers/arch.mjs`. Every failure names `file:line`
and says how to fix it. Run them alone with:

```sh
node --test test/arch-*.test.mjs
```

| File | Guard |
|---|---|
| `arch-routes.test.mjs` | Every Express route in `src/` (`velvet.*`, `app.*`, `router.*` and the `admin()` / `player()` / `control()` / `edit()` / `simple()` wrappers in `src/api/sendspin.js`) has a row in `docs/API.md`, every `docs/API.md` row has a route, no route path is dynamic, and no method + path is registered twice. |
| `arch-duplicates.test.mjs` | No scope declares the same function/class/`var` twice (`src/` and the webapp's own JS), and no two `src/` files hold top-level functions with the same body once local variable and parameter names are ignored (copy-paste, also with renamed variables). |
| `arch-exports.test.mjs` | Every `export` in `src/` is imported by name somewhere: `src/`, `test/`, `scripts/` or a root script. An export that only a unit test imports is a legitimate test seam; the guard flags only exports nothing imports. |
| `arch-db-boundary.test.mjs` | Only `src/db/` imports `src/db/sqlite-backend.js`, and only `src/db/` opens a `new DatabaseSync(`. |
| `arch-i18n.test.mjs` | Every literal key in `t('…')`, `this.t('…')`, `I18N.t('…')` and `data-i18n="…"` in the player, admin UI and shared-playlist page (`webapp/shared/`) exists in `en.json`, and all 12 locales have exactly the same key set. |
| `arch-csp.test.mjs` | No inline `on…=` handler attributes in `webapp/**/*.html` or in markup strings in the webapp's JS (including `setAttribute('on…')`), and no inline `<script>` without `src` in HTML. |
| `arch-sendfile.test.mjs` | Every `res.sendFile()` in `src/` passes a `root` option, or a path built in the same function from `resolvePathWithinRoot()` / `resolveChildPath()` / `resolveMediaPath()` or only from config, module-level `const`s (traced through their initialiser) and the temp dir. A name it cannot trace (an import, a module-level `let`, a parameter) fails unless allowlisted. |
| `arch-hardcoded-text.test.mjs` | Ratchet on hardcoded English in `webapp/app.js`, `webapp/admin/index.js`, `webapp/shared/app.js`, `webapp/mobile/app.js` and `webapp/tizen/app.js` (HTML text nodes, `title=` / `placeholder=` / `aria-label=` / `alt=`, `toast('…')` with two or more words outside `t()`). |
| `arch-masking.test.mjs` | The guards skip one fixed block of `webapp/app.js` and its markup in `webapp/index.html`, nothing else; the test fails if that skipped area moves to another file or grows. |

## What is skipped

- Routes: Subsonic `/rest/*` (documented in `docs/subsonic.md`), the `ALL …/{*path}` guard middleware and `…/index.html`
  aliases. An `ALL` route counts as documented by a row for any verb on the same path (`ALL /api/v1/sonos/event` is
  documented as `NOTIFY`). A handler that ends in `next()` is a gate, not a duplicate.
- Vendored code in `webapp/assets/js/lib/`.
- Dynamic i18n keys such as `` t(`player.x.${y}`) `` cannot be checked statically.

## Allowlists

Add an entry only when the code is right and the checker cannot see it. Each entry carries a one-line reason, and an
entry that no longer matches anything fails the test, so allowlists cannot go stale.

- Unused exports: `ALLOWED_UNUSED` in `test/arch-exports.test.mjs`, key `'src/file.js#exportName'`. Use it only for an
  export that nothing in the repo imports but a loader outside the repo needs; otherwise drop the `export` keyword.
  Test seams need no entry: an import from `test/` already counts as use.
- `sendFile`: `ALLOWED` in `test/arch-sendfile.test.mjs`, key `'src/file.js#<source text of the path argument>'`.
- Hardcoded text: `ALLOW` in `test/arch-hardcoded-text.test.mjs` lists text that is not translatable (brand, product,
  licence, format or tag-frame names), each with a reason; an entry that no longer matches a finding fails the test.
  `MAX` holds the current count per file. When you translate strings, the test prints the new count; lower `MAX` to
  it. Never raise it.

The other guards have no allowlist: fix the code or the docs.
