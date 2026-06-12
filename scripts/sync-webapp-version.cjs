const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VERSION = require(path.join(ROOT, 'package.json')).version;

// Single source of truth = package.json "version". Every other version/cache-buster
// string in the webapp is derived from it here, so a release only edits package.json.
// Stamp every `.js`/`.css` cache-buster (`foo.js?v=…`, `bar.css?v=…`) from
// package.json. Anchoring on the `.js`/`.css` extension covers all current and
// future asset cache-busters in any webapp HTML while never matching an
// unrelated query string such as a YouTube `watch?v=…` placeholder.
const ASSET_CACHE_BUSTER = [/((?:\.js|\.css)\?v=)[^"'>\s]+/g, `$1${VERSION}`];

const TARGETS = [
  ['webapp/index.html', [
    ASSET_CACHE_BUSTER,
    [/(id="login-version"[^>]*>)v[^<]*/g, `$1v${VERSION}`],
  ]],
  ['webapp/app.js', [
    [/(const VELVET_VERSION = ')[^']*(')/, `$1${VERSION}$2`],
  ]],
  ['webapp/admin/index.html',  [ASSET_CACHE_BUSTER]],
  ['webapp/shared/index.html', [ASSET_CACHE_BUSTER]],
  ['webapp/mobile/index.html', [ASSET_CACHE_BUSTER]],
  ['webapp/package.json', [
    [/("version":\s*")[^"]+/, `$1${VERSION}`],
  ]],
];

function syncWebappVersion() {
  let changed = 0;
  for (const [rel, subs] of TARGETS) {
    const fp = path.join(ROOT, rel);
    let txt;
    try { txt = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    const orig = txt;
    for (const [re, rep] of subs) txt = txt.replace(re, rep);
    if (txt !== orig) {
      try { fs.writeFileSync(fp, txt); changed++; } catch { /* read-only fs (e.g. Docker image) — already stamped at build */ }
    }
  }
  return { version: VERSION, changed };
}

module.exports = { syncWebappVersion, VERSION };

if (require.main === module) {
  const { version, changed } = syncWebappVersion();
  console.log(`sync-webapp-version: ${version} (${changed} file(s) updated)`);
}
