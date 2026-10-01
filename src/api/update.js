import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import Joi from 'joi';
import winston from 'winston';
import * as broker from '../state/bg-task-broker.js';
import { joiValidate } from '../util/validation.js';
import { fetchPublicJson } from '../util/ssrf-check.js';
import { getDirname } from '../util/esm-helpers.js';
import {
  compareVersions, parseGitHubRelease, splitDirtyFiles, detectSupervisor,
  restartPlan, blockersFor, planCheckout, phasePercent,
} from '../util/self-update.js';

// In-app updater (Admin → Updates). Shows what the latest GitHub release is and
// its notes without doing anything; a separate, admin-only, explicitly confirmed
// action performs the same steps docs/install.md tells a human to run by hand —
// git fetch + fast-forward to the tag, npm install for production deps when the
// lockfile changed, then a process restart — with every step streamed back to the
// admin page as progress. Inside Docker it only ever advises (pull the new image).
// See docs/updates.md.

const ROOT = path.resolve(getDirname(import.meta.url), '../..');
const REPO = 'aroundmyroom/Velvet';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOCKER_IMAGE = 'ghcr.io/aroundmyroom/velvet';
const CHECK_CACHE_MS = 30 * 60 * 1000;
const LOG_MAX_LINES = 400;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CURRENT = pkg.version;

let _latestCache = null; // { at, release, error }
let _job = { state: 'idle', target: null, phase: null, percent: 0, log: [], startedAt: null, finishedAt: null, error: null, startedBy: null };

// ── small process helpers ────────────────────────────────────────────────────
function run(cmd, args, { timeout = 60_000, cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Long-running commands (git fetch, npm install): every output line goes to the
// job log as it happens — that is the progress indicator the admin watches.
function runStreaming(cmd, args, { timeout = 15 * 60_000, cwd = ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { p.kill('SIGTERM'); reject(new Error(`${cmd} timed out after ${Math.round(timeout / 1000)}s`)); }, timeout);
    const feed = buf => String(buf).split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(l => _log(l));
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} exited with code ${code}`)); });
  });
}

function _log(line) {
  const l = String(line).replaceAll(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, 400); // eslint-disable-line no-control-regex
  _job.log.push(l);
  if (_job.log.length > LOG_MAX_LINES) _job.log.splice(0, _job.log.length - LOG_MAX_LINES);
  winston.info(`[update] ${l}`);
}
function _phase(phase, msg) { _job.phase = phase; _job.percent = phasePercent(phase); if (msg) _log(msg); }

async function _writable(p) { try { await fsp.access(p, fs.constants.W_OK); return true; } catch { return false; } }

// ── environment probe ────────────────────────────────────────────────────────
async function probeEnvironment() {
  const p = {
    root: ROOT,
    runtime: 'node',
    supervisor: detectSupervisor(),
    nodeVersion: process.version,
    processUser: null, processUid: null, dirOwnerUid: null, sameUser: false,
    gitAvailable: false, gitRepo: false, branch: null, head: null, remote: null, remoteOk: null,
    dirtyReal: [], dirtyStamped: [], localAhead: false,
    writable: false, unwritable: [],
    npmPath: null,
  };
  try { fs.accessSync('/.dockerenv'); p.runtime = 'docker'; } catch { /* not docker */ }
  try { const u = os.userInfo(); p.processUser = u.username; p.processUid = u.uid; } catch { /* unknown */ }
  try { p.dirOwnerUid = (await fsp.stat(ROOT)).uid; } catch { /* unknown */ }
  p.sameUser = p.processUid != null && (p.processUid === 0 || p.processUid === p.dirOwnerUid);

  const mustWrite = [ROOT, path.join(ROOT, '.git'), path.join(ROOT, 'package.json'), path.join(ROOT, 'node_modules')];
  for (const f of mustWrite) {
    if (!fs.existsSync(f)) continue;
    if (!(await _writable(f))) p.unwritable.push(path.relative(ROOT, f) || '.');
  }
  p.writable = p.unwritable.length === 0;

  try { await run('git', ['--version'], { timeout: 10_000 }); p.gitAvailable = true; } catch { /* no git */ }
  if (p.gitAvailable) {
    try {
      const inside = (await run('git', ['rev-parse', '--is-inside-work-tree'])).stdout.trim();
      p.gitRepo = inside === 'true';
    } catch { p.gitRepo = false; }
  }
  if (p.gitRepo) {
    try { p.branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(); } catch { /* detached/unknown */ }
    try { p.head = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim(); } catch { /* unknown */ }
    try {
      p.remote = (await run('git', ['config', '--get', 'remote.origin.url'])).stdout.trim();
      p.remoteOk = /github\.com[/:]aroundmyroom\/Velvet(\.git)?$/i.test(p.remote);
    } catch { p.remote = null; p.remoteOk = false; }
    try {
      const lines = (await run('git', ['status', '--porcelain', '--untracked-files=no'])).stdout.split('\n').filter(Boolean);
      const { stamped, real } = splitDirtyFiles(lines);
      p.dirtyReal = real; p.dirtyStamped = stamped;
    } catch { /* leave empty */ }
  }

  // npm next to the running node binary first (systemd units rarely carry the
  // interactive PATH), then whatever PATH has.
  const beside = path.join(path.dirname(process.execPath), 'npm');
  if (fs.existsSync(beside)) p.npmPath = beside;
  else { try { await run('npm', ['--version'], { timeout: 15_000 }); p.npmPath = 'npm'; } catch { /* none */ } }

  p.blockers = blockersFor(p);
  p.canSelfUpdate = p.blockers.length === 0;
  return p;
}

// ── latest release ───────────────────────────────────────────────────────────
async function fetchLatest(force) {
  if (!force && _latestCache && Date.now() - _latestCache.at < CHECK_CACHE_MS) return _latestCache;
  try {
    const json = await fetchPublicJson(RELEASES_API, {
      headers: { 'User-Agent': `velvet-self-update/${CURRENT}`, Accept: 'application/vnd.github+json' },
      timeout: 15_000, maxContentLength: 2 * 1024 * 1024,
    });
    const release = parseGitHubRelease(json);
    _latestCache = { at: Date.now(), release, error: release ? null : 'latest release is not a plain vX.Y.Z tag' };
  } catch (e) {
    const msg = /HTTP 403/.test(e.message) ? 'GitHub API rate limit reached — try again later' : e.message;
    // Keep a previously good answer around rather than blanking the page on a blip.
    _latestCache = { at: Date.now(), release: _latestCache?.release || null, error: msg };
  }
  return _latestCache;
}

// ── the update job ───────────────────────────────────────────────────────────
async function performUpdate(target, env) {
  const tag = `v${target}`;
  _phase('preflight', `Preflight for ${tag} as ${env.processUser || 'unknown user'} in ${ROOT}`);
  if (env.blockers.length) throw new Error(`Blocked: ${env.blockers.map(b => b.code).join(', ')}`);
  if (env.dirtyStamped.length) {
    _log(`Discarding boot-stamped files (regenerated on every start): ${env.dirtyStamped.join(', ')}`);
    await run('git', ['checkout', '--', ...env.dirtyStamped]);
  }
  const oldHead = env.head;

  _phase('fetch', 'git fetch --tags origin');
  await runStreaming('git', ['fetch', '--tags', '--prune', 'origin'], { timeout: 5 * 60_000 });
  let tagCommit;
  try { tagCommit = (await run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`])).stdout.trim(); }
  catch { throw new Error(`Tag ${tag} does not exist on origin`); }
  _log(`${tag} → ${tagCommit.slice(0, 10)}`);

  let isAncestor = true;
  try { await run('git', ['merge-base', '--is-ancestor', 'HEAD', tagCommit]); } catch { isAncestor = false; }
  const plan = planCheckout({ branch: env.branch, isAncestor });
  if (!plan.ok) throw new Error(`Cannot update: this checkout has local commits that are not in ${tag} (${plan.reason})`);

  _phase('checkout', plan.mode === 'ff' ? `git merge --ff-only ${tag} (staying on ${env.branch})` : `git checkout ${tag}`);
  if (plan.mode === 'ff') await run('git', ['merge', '--ff-only', tagCommit]);
  else await run('git', ['checkout', '-q', tagCommit]);

  let depsChanged = true;
  try {
    const diff = (await run('git', ['diff', '--name-only', oldHead, tagCommit, '--', 'package.json', 'package-lock.json'])).stdout.trim();
    depsChanged = diff.length > 0;
  } catch { /* assume changed */ }

  try {
    if (depsChanged) {
      if (!env.npmPath) throw new Error('package.json changed but npm was not found next to node or on PATH');
      _phase('deps', `Dependencies changed — ${env.npmPath} install --omit=dev`);
      await runStreaming(env.npmPath, ['install', '--omit=dev', '--no-audit', '--no-fund', '--progress=false', '--loglevel=info'], {
        timeout: 20 * 60_000,
        env: { ...process.env, NODE_ENV: 'production', CI: '1' },
      });
    } else {
      _phase('deps', 'Dependencies unchanged — skipping npm install');
    }
    _phase('verify', 'Verifying the new tree');
    const newPkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    if (newPkg.version !== target) throw new Error(`package.json reports ${newPkg.version}, expected ${target}`);
    await run(process.execPath, ['--check', path.join(ROOT, 'cli-boot-wrapper.js')], { timeout: 30_000 });
    _log(`Now at ${tag} on disk — restarting to load it`);
  } catch (e) {
    // Put the tree back exactly where it was; the working tree was verified clean.
    _log(`Failed: ${e.message} — rolling back to ${oldHead.slice(0, 10)}`);
    try { await run('git', ['reset', '--hard', oldHead]); _log('Rolled back'); } catch (re) { _log(`Rollback failed: ${re.message}`); }
    throw e;
  }
}

function scheduleRestart(env) {
  const plan = restartPlan(env.supervisor);
  _phase('restart', plan.method === 'exit'
    ? `Exiting for ${env.supervisor} to restart the service`
    : 'No supervisor detected — starting a new copy and handing over');
  _job.state = 'restarting';
  setTimeout(() => {
    if (plan.method === 'reexec') {
      const child = spawn(process.execPath, [path.join(ROOT, 'cli-boot-wrapper.js')], { cwd: ROOT, env: process.env, detached: true, stdio: 'ignore' });
      child.unref();
      winston.info(`[update] spawned replacement pid ${child.pid}`);
      setTimeout(() => process.exit(plan.exitCode), 1500);
      return;
    }
    process.exit(plan.exitCode);
  }, 1500);
}

export function setup(velvet) {
  const adminOnly = (req, res) => { if (req.user?.admin !== true) { res.status(403).json({ error: 'Admin only' }); return false; } return true; };

  velvet.get('/api/v1/admin/update/check', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const force = req.query?.force === '1';
    const [latest, env] = await Promise.all([fetchLatest(force), probeEnvironment()]);
    const release = latest.release;
    res.json({
      currentVersion: CURRENT,
      latest: release,
      isNewer: release ? compareVersions(release.version, CURRENT) > 0 : false,
      checkedAt: latest.at,
      checkError: latest.error,
      environment: env,
      docker: env.runtime === 'docker' ? {
        image: DOCKER_IMAGE,
        tag: release ? `v${release.version}` : 'latest',
        commands: [
          `docker pull ${DOCKER_IMAGE}:${release ? `v${release.version}` : 'latest'}`,
          'docker compose up -d   # or: recreate the container with the new image',
        ],
      } : null,
      job: _job,
    });
  });

  velvet.get('/api/v1/admin/update/status', (req, res) => {
    if (!adminOnly(req, res)) return;
    res.json({ currentVersion: CURRENT, job: _job });
  });

  velvet.post('/api/v1/admin/update/start', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const schema = Joi.object({ version: Joi.string().pattern(/^\d+\.\d+\.\d+$/).required() });
    joiValidate(schema, req.body);
    if (_job.state === 'running' || _job.state === 'restarting') return res.status(409).json({ error: 'An update is already running', job: _job });

    const target = req.body.version;
    const latest = await fetchLatest(false);
    // Only ever update to what the page showed — the notes the admin read and
    // approved are the notes for this exact version.
    if (!latest.release || latest.release.version !== target) return res.status(400).json({ error: 'That version is not the current latest release — check again first' });
    if (compareVersions(target, CURRENT) <= 0) return res.status(400).json({ error: `Already on ${CURRENT}` });

    const env = await probeEnvironment();
    if (!env.canSelfUpdate) return res.status(400).json({ error: 'This install cannot update itself', blockers: env.blockers, environment: env });

    _job = { state: 'running', target, phase: null, percent: 0, log: [], startedAt: Date.now(), finishedAt: null, error: null, startedBy: req.user.username };
    winston.info(`[update] ${req.user.username} started update ${CURRENT} → ${target}`);
    res.json({ ok: true, job: _job });

    // Through the broker so it never overlaps a scan or an analysis worker.
    broker.submit('self-update', `Update to v${target}`, async () => {
      try {
        await performUpdate(target, env);
        _job.finishedAt = Date.now();
        scheduleRestart(env);
      } catch (e) {
        _job.state = 'failed';
        _job.error = e.message;
        _job.finishedAt = Date.now();
        winston.error(`[update] failed: ${e.message}`);
      }
    });
  });
}
