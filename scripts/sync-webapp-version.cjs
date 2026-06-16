const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const VERSION = require(path.join(ROOT, 'package.json')).version;

// Single source of truth = package.json "version". Every version string and
// asset cache-buster in the webapp is derived from it here, so a release only
// edits package.json.
//
// Cache-busters are `<asset>?v=<version>-<hash8>`, where <hash8> is a short
// content hash of the referenced file. The version keeps them human-readable
// across releases; the hash makes the URL change whenever the asset's CONTENT
// changes — so a merged-but-unreleased webapp change busts the browser cache on
// the next sync (boot or `/deploy`) without needing a version bump. The hash is
// derived from the committed file, so it is deterministic and the version-sync
// CI gate (sync then `git diff --exit-code`) still passes.
const _hashCache = new Map();
function assetHash(absPath) {
  if (_hashCache.has(absPath)) return _hashCache.get(absPath);
  let h = '';
  try { h = crypto.createHash('md5').update(fs.readFileSync(absPath)).digest('hex').slice(0, 8); }
  catch { /* asset not found on disk — fall back to version-only */ }
  _hashCache.set(absPath, h);
  return h;
}

// Build the cache-buster replacer for one HTML file. Resolves each referenced
// asset: a leading-slash path is server-root-relative (→ webapp/…), otherwise it
// is relative to the HTML file's own directory.
function cacheBusterSub(htmlRel) {
  const htmlDir = path.dirname(path.join(ROOT, htmlRel));
  return [
    /([^"'(\s>?]+\.(?:js|css))\?v=[^"'>\s]+/g,
    (_m, asset) => {
      const abs = asset.startsWith('/')
        ? path.join(ROOT, 'webapp', asset.slice(1))
        : path.join(htmlDir, asset);
      const h = assetHash(abs);
      return h ? `${asset}?v=${VERSION}-${h}` : `${asset}?v=${VERSION}`;
    },
  ];
}

// app.js is stamped (VELVET_VERSION) AND hashed by the HTML files, so it must be
// written before any HTML hashes it — keep it first.
const TARGETS = [
  ['webapp/app.js', [
    [/(const VELVET_VERSION = ')[^']*(')/, `$1${VERSION}$2`],
  ]],
  ['webapp/index.html', [
    cacheBusterSub('webapp/index.html'),
    [/(id="login-version"[^>]*>)v[^<]*/g, `$1v${VERSION}`],
  ]],
  ['webapp/admin/index.html',  [cacheBusterSub('webapp/admin/index.html')]],
  ['webapp/shared/index.html', [cacheBusterSub('webapp/shared/index.html')]],
  ['webapp/mobile/index.html', [cacheBusterSub('webapp/mobile/index.html')]],
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
      try { fs.writeFileSync(fp, txt); changed++; _hashCache.delete(fp); } catch { /* read-only fs (e.g. Docker image) — already stamped at build */ }
    }
  }
  return { version: VERSION, changed };
}

module.exports = { syncWebappVersion, VERSION };

if (require.main === module) {
  const { version, changed } = syncWebappVersion();
  console.log(`sync-webapp-version: ${version} (${changed} file(s) updated)`);
}
