const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('self-update — the decisions behind Admin → Updates', async () => {
  const su = await import('../../src/util/self-update.js');

  describe('compareVersions', () => {
    it('orders plain semver numerically, not lexically', () => {
      assert.equal(su.compareVersions('0.5.30', '0.5.9'), 1);
      assert.equal(su.compareVersions('0.5.9', '0.5.30'), -1);
      assert.equal(su.compareVersions('1.0.0', '0.99.99'), 1);
      assert.equal(su.compareVersions('0.5.30', '0.5.30'), 0);
      assert.equal(su.compareVersions('v0.5.31', '0.5.30'), 1);
    });
    it('never calls an unparsable version newer', () => {
      assert.equal(su.compareVersions('0.6.0-beta', '0.5.30'), 0);
      assert.equal(su.compareVersions('', '0.5.30'), 0);
    });
  });

  describe('parseGitHubRelease', () => {
    const gh = { tag_name: 'v0.5.30', name: 'v0.5.30 — Sonos Keeps Playing', published_at: '2026-09-30T14:26:04Z', html_url: 'https://github.com/aroundmyroom/Velvet/releases/tag/v0.5.30', body: '# Notes', draft: false, prerelease: false, assets: [{ name: 'velvet-tv-0.5.30.wgt', size: 192600, browser_download_url: 'https://github.com/x/y.wgt' }] };
    it('maps the fields the admin page needs', () => {
      const r = su.parseGitHubRelease(gh);
      assert.equal(r.version, '0.5.30');
      assert.equal(r.tag, 'v0.5.30');
      assert.equal(r.htmlUrl, gh.html_url);
      assert.equal(r.assets[0].name, 'velvet-tv-0.5.30.wgt');
    });
    it('refuses drafts, pre-releases, odd tags and non-github links', () => {
      assert.equal(su.parseGitHubRelease({ ...gh, draft: true }), null);
      assert.equal(su.parseGitHubRelease({ ...gh, prerelease: true }), null);
      assert.equal(su.parseGitHubRelease({ ...gh, tag_name: 'v.1.2.0' }), null);
      assert.equal(su.parseGitHubRelease({ ...gh, html_url: 'https://evil.example/x' }).htmlUrl, null);
      assert.equal(su.parseGitHubRelease(null), null);
    });
  });

  describe('splitDirtyFiles — boot-stamped files are not "local changes"', () => {
    it('separates the cache-buster stamps the server rewrites on boot from real edits', () => {
      const { stamped, real } = su.splitDirtyFiles([' M webapp/index.html', ' M src/api/db.js', ' M webapp/mobile/index.html']);
      assert.deepEqual(stamped, ['webapp/index.html', 'webapp/mobile/index.html']);
      assert.deepEqual(real, ['src/api/db.js']);
    });
  });

  describe('blockersFor — every reason the button can be grey', () => {
    const ok = { runtime: 'node', gitAvailable: true, gitRepo: true, remoteOk: true, writable: true, unwritable: [], dirtyReal: [], localAhead: false };
    it('passes a clean git checkout the process can write to', () => {
      assert.deepEqual(su.blockersFor(ok), []);
    });
    it('inside Docker the only answer is "pull the image" — nothing else is even evaluated', () => {
      const b = su.blockersFor({ ...ok, runtime: 'docker', gitAvailable: false, writable: false });
      assert.deepEqual(b.map(x => x.code), ['docker']);
    });
    it('names the user/permission problem with the fix, rather than failing mid-update', () => {
      const b = su.blockersFor({ ...ok, writable: false, unwritable: ['.git', 'node_modules'] });
      assert.equal(b[0].code, 'not-writable');
      assert.equal(b[0].fix, 'chown');
      assert.deepEqual(b[0].detail, ['.git', 'node_modules']);
    });
    it('refuses to touch a checkout with real local changes or local commits', () => {
      assert.equal(su.blockersFor({ ...ok, dirtyReal: ['src/x.js'] })[0].code, 'local-changes');
      assert.equal(su.blockersFor({ ...ok, localAhead: true })[0].code, 'local-commits');
    });
    it('refuses a checkout pointed at a different repository', () => {
      assert.equal(su.blockersFor({ ...ok, remoteOk: false })[0].code, 'wrong-remote');
    });
  });

  describe('planCheckout', () => {
    it('fast-forwards a branch so the next deploy still works, and checks out a tag when detached', () => {
      assert.deepEqual(su.planCheckout({ branch: 'main', isAncestor: true }), { ok: true, mode: 'ff' });
      assert.deepEqual(su.planCheckout({ branch: 'HEAD', isAncestor: true }), { ok: true, mode: 'checkout' });
      assert.equal(su.planCheckout({ branch: 'main', isAncestor: false }).ok, false);
    });
  });

  describe('restartPlan / detectSupervisor', () => {
    it('exits non-zero under systemd and pm2 — the one code that restarts under on-failure AND always', () => {
      assert.deepEqual(su.restartPlan('systemd'), { method: 'exit', exitCode: 1 });
      assert.deepEqual(su.restartPlan('pm2'), { method: 'exit', exitCode: 1 });
    });
    it('re-execs itself when nothing would bring it back', () => {
      assert.equal(su.restartPlan('none').method, 'reexec');
    });
    it('recognises the supervisor from its environment', () => {
      assert.equal(su.detectSupervisor({ INVOCATION_ID: 'abc' }), 'systemd');
      assert.equal(su.detectSupervisor({ PM2_HOME: '/root/.pm2' }), 'pm2');
      assert.equal(su.detectSupervisor({}), 'none');
    });
  });

  it('phasePercent only ever climbs', () => {
    const pct = su.PHASES.map(([p]) => su.phasePercent(p));
    for (let i = 1; i < pct.length; i++) assert.ok(pct[i] > pct[i - 1]);
    assert.equal(su.phasePercent('restart'), 100);
  });
});
