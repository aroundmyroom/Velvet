#!/usr/bin/env node
'use strict';
/*
 * scripts/release.cjs — one-command release orchestrator for Velvet.
 *
 * Collapses the full release checklist into a single guarded run:
 *   bump package.json → sync webapp cache-busters → retention of release notes →
 *   docker.md pin → tests → commit → push → tag → push tag → GitHub release.
 *
 * The PROSE (changelog entry + releases/vX.Y.Z.md) is written during development;
 * this script refuses to run until both exist, so a release is never undocumented.
 *
 * Target version is read from the TOP "## vX.Y.Z" header in changes-velvet.md
 * (the staged entry). Override with the first positional arg.
 *
 * Usage:
 *   node scripts/release.cjs                 # release the staged changelog version
 *   node scripts/release.cjs 0.1.5           # release a specific version
 *   node scripts/release.cjs --dry-run       # show every step, change/push nothing
 *   node scripts/release.cjs --no-push       # commit + tag locally, no push/release
 *   node scripts/release.cjs --force         # override the blackout-window guard
 *   node scripts/release.cjs --skip-tests    # skip `npm test` (emergencies only)
 *   node scripts/release.cjs --title "..."   # override the commit/release title
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REPO = 'aroundmyroom/Velvet';
const CHANGELOG = path.join(ROOT, 'changes-velvet.md');
const PKG = path.join(ROOT, 'package.json');
const RELEASES = path.join(ROOT, 'releases');
const DOCKER_MD = path.join(ROOT, 'docs', 'docker.md');
const KEEP_RELEASE_NOTES = 5;

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const DRY = flag('--dry-run');
const NO_PUSH = flag('--no-push');
const FORCE = flag('--force');
const SKIP_TESTS = flag('--skip-tests');
const titleArg = (() => { const i = args.indexOf('--title'); return i >= 0 ? args[i + 1] : null; })();
const versionArg = args.find(a => /^\d+\.\d+\.\d+$/.test(a)) || null;

const C = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` };
let step = 0;
const say = msg => console.log(`${C.g('▸')} ${msg}`);
const stepLog = msg => console.log(`\n${C.b(`[${++step}] ${msg}`)}`);
const die = msg => { console.error(`\n${C.r('✗ ' + msg)}`); process.exit(1); };
const sh = (cmd, opts = {}) => {
  if (DRY && !opts.always) { console.log(C.dim(`  (dry-run) ${cmd}`)); return ''; }
  console.log(C.dim(`  $ ${cmd}`));
  return execSync(cmd, { cwd: ROOT, stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' }) || '';
};
const cap = cmd => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();

function cmp(a, b) { const pa = a.split('.').map(Number), pb = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] - pb[i]; } return 0; }

// ── Resolve target version + title from the changelog ──────────────────────
const changelog = fs.readFileSync(CHANGELOG, 'utf8');
const headerRe = /^## v(\d+\.\d+\.\d+)\b.*$/m;
const topMatch = changelog.match(headerRe);
if (!topMatch) die(`No "## vX.Y.Z" header found in ${path.basename(CHANGELOG)}`);
const version = versionArg || topMatch[1];
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));

// Title: --title, else the summary line right under the version's header.
let title = titleArg;
if (!title) {
  const sec = changelog.slice(changelog.indexOf(`## v${version}`));
  const lines = sec.split('\n').slice(1).map(l => l.trim());
  title = (lines.find(l => l && !l.startsWith('#')) || `release ${version}`).replace(/\.$/, '');
}

console.log(C.b(`\n  Velvet release → v${version}`));
console.log(`  ${C.dim('title:')}  ${title}`);
console.log(`  ${C.dim('pkg:')}    ${pkg.version} → ${version}`);
console.log(`  ${C.dim('flags:')}  ${[DRY && 'dry-run', NO_PUSH && 'no-push', FORCE && 'force', SKIP_TESTS && 'skip-tests'].filter(Boolean).join(', ') || 'none'}`);

// ── Pre-flight guards ───────────────────────────────────────────────────────
stepLog('Pre-flight checks');

const branch = cap('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') die(`Must be on 'main' to release (on '${branch}'). Only main may be pushed.`);
say(`branch is main`);

if (cmp(version, pkg.version) < 0) die(`Target v${version} is older than package.json (${pkg.version}).`);

if (!fs.existsSync(path.join(RELEASES, `v${version}.md`))) {
  die(`Missing releases/v${version}.md — write the release notes first (the changelog entry + this file are required).`);
}
say(`release notes present: releases/v${version}.md`);
say(`changelog entry present: ## v${version}`);

// Blackout window: Mon–Fri 09:00–17:00 Europe/Amsterdam — no push unless --force.
if (!NO_PUSH && !DRY) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(now);
  const wd = parts.find(p => p.type === 'weekday').value;
  const hour = Number(parts.find(p => p.type === 'hour').value);
  const weekday = !['Sat', 'Sun'].includes(wd);
  if (weekday && hour >= 9 && hour < 17) {
    if (!FORCE) die(`Blackout window (Mon–Fri 09:00–17:00 CET, now ${wd} ${hour}:00). Re-run with --force to override.`);
    console.log(C.y(`  ⚠ in blackout window (${wd} ${hour}:00) — proceeding because --force`));
  }
}

// Tag must not already exist.
const tags = cap('git tag').split('\n');
if (tags.includes(`v${version}`)) die(`Tag v${version} already exists — bump the version or delete the tag.`);
say(`tag v${version} is free`);

// ── Mechanical steps ────────────────────────────────────────────────────────
stepLog('Bump package.json + sync webapp cache-busters');
if (pkg.version !== version) {
  if (!DRY) { pkg.version = version; fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n'); }
  say(`package.json → ${version}`);
} else { say(`package.json already ${version}`); }
sh('npm run sync-version');

stepLog('Pin docker.md to this version');
if (!DRY) {
  const dm = fs.readFileSync(DOCKER_MD, 'utf8');
  const pinned = dm.replace(/(ghcr\.io\/aroundmyroom\/velvet:v)\d+\.\d+\.\d+/g, `$1${version}`);
  if (pinned !== dm) { fs.writeFileSync(DOCKER_MD, pinned); say('docker.md pin updated'); }
  else say('docker.md pin already current');
} else { console.log(C.dim('  (dry-run) update docker.md pin')); }

stepLog('Release-notes retention (keep newest 5)');
const notes = fs.readdirSync(RELEASES).filter(f => /^v\d+\.\d+\.\d+\.md$/.test(f)).map(f => f.slice(1, -3)).sort(cmp);
const stale = notes.slice(0, Math.max(0, notes.length - KEEP_RELEASE_NOTES));
if (!stale.length) say('nothing to archive');
for (const v of stale) sh(`git mv releases/v${v}.md releases/earlier/v${v}.md`);

if (!SKIP_TESTS) {
  stepLog('Run test suite');
  sh('npm test');
  say('tests passed');
} else { stepLog('Skipping tests (--skip-tests)'); }

stepLog('Commit');
sh('git add -A');
const subject = `v${version}: ${title}`.slice(0, 72);
sh(`git commit -m ${JSON.stringify(subject)}`);
say(`committed: ${subject}`);

if (NO_PUSH) { console.log(C.y('\n  --no-push: committed locally. Push/tag/release skipped.')); process.exit(0); }

stepLog('Sync with remote + push main');
// Integrate any commits pushed to main since we branched (e.g. Dependabot merges)
// so the push is a fast-forward. The working tree is clean here (just committed),
// so the rebase is safe; a genuine conflict stops the run for manual resolution.
sh('git pull --rebase origin main');
sh('git push origin main');

stepLog('Tag + push tag (triggers Docker build)');
sh(`git tag v${version}`);
sh(`git push origin v${version}`);

stepLog('GitHub release');
sh(`gh release create v${version} --title ${JSON.stringify(`v${version} — ${title}`)} --notes-file releases/v${version}.md --repo ${REPO}`);

console.log(C.g(`\n✓ Released v${version}.`));
if (!DRY) {
  console.log(`  ${C.dim('release:')} https://github.com/${REPO}/releases/tag/v${version}`);
  console.log(`  ${C.dim('docker :')} ghcr.io/aroundmyroom/velvet:v${version} (building — check: gh run list --repo ${REPO} --limit 1)`);
}
