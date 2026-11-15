// Source-level checks on webapp/app.js + webapp/index.html: one listener per button,
// every nav route reachable, no calls to missing Player methods, no duplicated helpers.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appSrc, indexHtml, topLevelSource } from './helpers/fix-player-app.mjs';

const count = (re) => (appSrc.match(re) || []).length;

describe('top-level click wiring', () => {
  it('wires each button once', () => {
    const ids = [...appSrc.matchAll(/^document\.getElementById\('([^']+)'\)\??\.addEventListener\('click'/gm)].map(m => m[1]);
    const seen = new Map();
    for (const id of ids) seen.set(id, (seen.get(id) || 0) + 1);
    const twice = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
    assert.deepEqual(twice, []);
  });

  it('keeps Enter-to-confirm on both playlist name inputs and the empty-queue guard', () => {
    assert.match(appSrc, /getElementById\('pl-new-name'\)\.addEventListener\('keydown'/);
    assert.match(appSrc, /getElementById\('pl-save-name'\)\.addEventListener\('keydown'/);
    assert.match(appSrc, /getElementById\('qp-save-btn'\)\.addEventListener\('click', \(\) => \{\n\s+if \(!S\.queue\.length\) \{ toast\(t\('player\.toast\.queueEmpty'\)\); return; \}/);
  });
});

describe('Player API surface', () => {
  it('only calls Player methods that exist', () => {
    const body = topLevelSource('Player');
    const defined = new Set([...body.matchAll(/^ {2}([a-zA-Z_]\w*)\s*\(/gm)].map(m => m[1]));
    const called = new Set([...appSrc.matchAll(/\bPlayer\.([a-zA-Z_]\w*)\(/g)].map(m => m[1]));
    const missing = [...called].filter(n => !defined.has(n));
    assert.deepEqual(missing, []);
  });
});

describe('nav reachability', () => {
  const routesStart = appSrc.indexOf('const VIEW_ROUTES = {');
  const routes = appSrc.slice(routesStart, appSrc.indexOf('\n};\n', routesStart));
  const routed = [...routes.matchAll(/^\s+'?([a-z][\w-]*)'?:\s+\{ open:/gm)].map(m => m[1]);
  // Opened from code (pinned start view, Playing Now bar), not from a sidebar button
  const programmatic = new Set(['playing-now', 'smart-playlists']);

  it('has a data-view button in index.html for every routed view', () => {
    const missing = [...new Set(routed)].filter(v => !programmatic.has(v) && !indexHtml.includes(`data-view="${v}"`));
    assert.deepEqual(missing, []);
  });

  it('has the Webhooks button that showApp un-hides', () => {
    assert.match(indexHtml, /<button class="nav-btn hidden" id="webhooks-nav-btn" data-view="webhooks"/);
    assert.match(appSrc, /getElementById\('webhooks-nav-btn'\)\?\.classList\.remove\('hidden'\)/);
    assert.equal(count(/viewDiscordWebhook/g), 0);
  });

  it('re-renders the Webhooks view on a language change', () => {
    assert.match(appSrc, /webhooks:\s+\{ open: \(\) => viewWebhooks\(\)/);
    const fn = topLevelSource('_rerenderCurrentViewForLanguageChange');
    assert.match(fn, /route\?\.rerender \|\| route\?\.open/);
  });

  it('drops the old Artists page except for the pin migration', () => {
    assert.equal((indexHtml.match(/artists_old/g) || []).length, 0);
    const lines = appSrc.split('\n').filter(l => l.includes('artists_old'));
    assert.deepEqual(lines, ["function _migratePinnedView(v) { return v === 'artists_old' ? 'artists' : v; }"]);
  });
});

describe('no duplicated helpers', () => {
  it('defines one browse-detail renderer, song card and seek preview', () => {
    assert.equal(count(/function renderBrowse\(/g), 1);
    assert.equal(count(/function songCard\(/g), 0);
    assert.equal(count(/function _homeSongCard\(/g), 1);
    assert.equal(count(/function initNpSeekPreview|function initSeekPreview/g), 0);
    assert.equal(count(/_initSeekPreview\('/g), 2);
    assert.equal(count(/function showAddToPlaylistModalBulk/g), 0);
    assert.equal(count(/api\('POST', 'api\/v1\/discogs\/embed'/g), 1);
    assert.equal(count(/function _l1MatchesArtist|function _l1m\(/g), 0);
  });

  it('sends the queue to user/settings only through the shared payload builder', () => {
    assert.equal(count(/api\('POST', 'api\/v1\/user\/settings', \{ queue:/g), 1);
    assert.match(appSrc, /api\('POST', 'api\/v1\/user\/settings', \{ queue: _buildQueueSyncPayload\(playing\) \}\)/);
  });

  it('resets smart-playlist filters only through the defaults', () => {
    assert.equal(count(/_splFilters = \{/g), 0);
  });

  it('closes Wrapped sessions in one place (beacons aside)', () => {
    assert.equal(count(/api\('POST', 'api\/v1\/wrapped\/(play-stop|radio-stop)'/g), 2);
  });
});

describe('keyboard shortcuts', () => {
  const start = appSrc.indexOf("case 'ArrowUp':");
  const block = appSrc.slice(start, appSrc.indexOf("case 'KeyR':", start));

  it('moves volume through the #volume input handler', () => {
    assert.match(block, /case 'ArrowUp':\s+case 'ArrowDown': \{/);
    assert.match(block, /sl\.dispatchEvent\(new Event\('input'\)\)/);
    assert.doesNotMatch(block, /audioEl\.volume\s*=/);
  });

  it('toggles shuffle through the shuffle button', () => {
    assert.match(block, /case 'KeyS':\s+if \(!e\.ctrlKey && !e\.metaKey\) \{\s+document\.getElementById\('shuffle-btn'\)\.click\(\);/);
  });
});
