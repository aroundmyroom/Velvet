// Pure decision logic for the in-app updater (Admin → Updates). Everything that
// touches git, npm, the filesystem or GitHub lives in src/api/update.js; this file
// only turns facts into decisions so the decisions can be unit-tested without any
// of that. See docs/updates.md.

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(v) {
  const m = SEMVER.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// -1 / 0 / 1; anything unparsable compares as equal (never "newer").
export function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// GitHub /releases/latest JSON → the shape the admin UI needs. Null when the tag
// isn't plain semver (a draft, a pre-release experiment, a typo) — never offer it.
export function parseGitHubRelease(json) {
  if (!json || typeof json !== 'object') return null;
  const tag = String(json.tag_name || '').trim();
  const pv = parseVersion(tag);
  if (!pv || json.draft || json.prerelease) return null;
  return {
    version: pv.join('.'),
    tag,
    name: String(json.name || tag),
    publishedAt: json.published_at || null,
    htmlUrl: typeof json.html_url === 'string' && /^https:\/\/github\.com\//.test(json.html_url) ? json.html_url : null,
    body: typeof json.body === 'string' ? json.body.slice(0, 60_000) : '',
    assets: Array.isArray(json.assets)
      ? json.assets.slice(0, 20).map(a => ({ name: String(a.name || ''), size: Number(a.size) || 0, url: a.browser_download_url || null }))
      : [],
  };
}

// Files the server rewrites on every boot (version cache-busters). A diff in only
// these is not "local changes" — they are regenerated anyway, so the updater may
// discard them rather than refuse.
export const AUTO_STAMPED_FILES = new Set([
  'webapp/index.html', 'webapp/mobile/index.html', 'webapp/shared/index.html',
  'webapp/admin/index.html', 'webapp/package.json', 'webapp/app.js',
]);

export function splitDirtyFiles(porcelainLines) {
  const stamped = [], real = [];
  for (const line of porcelainLines || []) {
    const file = String(line).slice(3).trim();
    if (!file) continue;
    (AUTO_STAMPED_FILES.has(file) ? stamped : real).push(file);
  }
  return { stamped, real };
}

export function detectSupervisor(env = process.env) {
  if (env.INVOCATION_ID || env.JOURNAL_STREAM) return 'systemd';
  if (env.PM2_HOME || env.pm_id !== undefined || env.PM2_JSON_PROCESSING) return 'pm2';
  return 'none';
}

// How to get the new code loaded. Node caches modules, so an in-process re-serve
// is useless here: the process has to end and come back.
//   systemd — exit non-zero: that restarts under Restart=on-failure AND Restart=always,
//             the two policies installs actually use (docs/install.md ships on-failure).
//   pm2     — restarts on any exit code; non-zero keeps its restart counters honest.
//   none    — nobody would bring us back, so spawn a detached copy of ourselves
//             after the port is released and only then exit.
export function restartPlan(supervisor) {
  if (supervisor === 'systemd' || supervisor === 'pm2') return { method: 'exit', exitCode: 1 };
  return { method: 'reexec', exitCode: 0 };
}

// The checklist the admin sees, and the gate the update job enforces. Every
// blocker says what is wrong AND what would fix it — the point of the page is
// that nobody has to guess why the button is grey.
export function blockersFor(p) {
  const out = [];
  if (p.runtime === 'docker') {
    out.push({ code: 'docker', fix: 'pull' });
    return out; // nothing below applies inside a container
  }
  if (!p.gitAvailable) out.push({ code: 'no-git', fix: 'install-git' });
  if (!p.gitRepo) out.push({ code: 'not-git-repo', fix: 'git-clone' });
  if (p.gitRepo && p.remoteOk === false) out.push({ code: 'wrong-remote', fix: 'remote' });
  if (!p.writable) out.push({ code: 'not-writable', fix: 'chown', detail: p.unwritable || [] });
  if (p.dirtyReal && p.dirtyReal.length) out.push({ code: 'local-changes', fix: 'commit-or-revert', detail: p.dirtyReal });
  if (p.localAhead) out.push({ code: 'local-commits', fix: 'push-or-reset' });
  return out;
}

// What git should do to land on the tag.
export function planCheckout({ branch, isAncestor }) {
  if (branch && branch !== 'HEAD') {
    if (!isAncestor) return { ok: false, reason: 'local-commits' };
    return { ok: true, mode: 'ff' };          // git merge --ff-only <tag>: branch pointer moves, stays on the branch
  }
  return { ok: true, mode: 'checkout' };      // detached HEAD: just check the tag out
}

// Progress percentages per phase — a fixed ladder so the bar never goes backwards
// and npm (whose own progress is unknowable) sits in a wide band with the live log.
export const PHASES = [
  ['preflight', 5], ['fetch', 15], ['checkout', 35], ['deps', 45], ['verify', 92], ['restart', 100],
];
export function phasePercent(phase) {
  const f = PHASES.find(([p]) => p === phase);
  return f ? f[1] : 0;
}
