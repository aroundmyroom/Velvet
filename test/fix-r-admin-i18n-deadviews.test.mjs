import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adminJs = fs.readFileSync(path.join(root, 'webapp/admin/index.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'webapp/admin/index.html'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(root, 'webapp/locales/en.json'), 'utf8'));

describe('admin dead views (P082, P083, P141)', () => {
  it('rpn-view is gone', () => {
    assert.ok(!adminJs.includes("'rpn-view'"));
    assert.ok(!adminJs.includes('rpnView'));
    assert.ok(!/velvet\.io\/reverse-proxy-network/.test(adminJs));
  });

  it('old discord-webhook-view is gone, custom webhooks still handle Discord', () => {
    assert.ok(!adminJs.includes("'discord-webhook-view'"));
    assert.ok(!adminJs.includes('discordWebhookView'));
    assert.ok(adminJs.includes('/api/v1/admin/discord-webhook/config'));
    assert.ok(adminJs.includes("t('admin.discordWebhook.urlHint')"));
  });
});

describe('admin hardcoded English (P084)', () => {
  const literals = [
    '>Artist Albums<',
    '>Artist Albums Diagnostic<',
    '>Normalized Index Entry<',
    '>Albums per normalized variant<',
    '>No albums<',
    '>Album Version Tag Fields<',
    '>Failed to load<',
    '>Discord Webhook<',
    '>Select all<',
    '>Deselect all<',
    '>Genre tag<',
    '>Enable deletions above first<',
    '>New Velvet Password<',
    '>Subsonic API Password<',
    '>Accessible Folders<',
    '>No directories available<',
    '>Grant admin access<',
    '<b>What is TXXX?</b>',
    '"User: " + currentUser.value',
  ];

  for (const lit of literals) {
    it(`no literal ${lit} in admin/index.js`, () => {
      assert.ok(!adminJs.includes(lit), `found ${lit}`);
    });
  }

  it('Artist Albums nav item is translated', () => {
    assert.match(adminHtml, /data-i18n="admin\.nav\.artistAlbums"/);
  });

  it('no component defines its own t() method', () => {
    assert.ok(!/^\s+t\s*[:(]\s*(function\s*)?\(/m.test(adminJs));
  });

  it('every static admin.* key used in admin/index.js and index.html exists in en.json', () => {
    const src = adminJs + adminHtml;
    const keys = new Set();
    for (const m of src.matchAll(/\bt\(\s*['"](admin\.[A-Za-z0-9_.]+)['"]\s*[,)]/g)) keys.add(m[1]);
    for (const m of src.matchAll(/data-i18n="(admin\.[A-Za-z0-9_.]+)"/g)) keys.add(m[1]);
    const missing = [...keys].filter(k => !(k in en));
    assert.deepEqual(missing, []);
  });
});
