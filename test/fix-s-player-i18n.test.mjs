// Player i18n sweep (P072, fix-147-plan.md): Playback settings and the rest of the player use t() keys,
// every key the player asks for exists, and all 12 locales carry the same keys.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appSrc, indexHtml, topLevelSource } from './helpers/fix-player-app.mjs';

const LANGS = ['en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'ru', 'zh', 'ja', 'ko'];
const locales = Object.fromEntries(LANGS.map(l => [l, JSON.parse(fs.readFileSync(new URL(`../webapp/locales/${l}.json`, import.meta.url), 'utf8'))]));
const en = locales.en;

const textNodes = src => [...src.matchAll(/>([^<>`]*)</g)]
  .map(m => m[1].replaceAll(/\$\{[^}]*\}/g, '').replaceAll(/&[a-z]+;/g, '').trim())
  .filter(s => /[A-Za-z]{3,}/.test(s));

describe('Playback settings are translated (P072)', () => {
  const view = topLevelSource('viewPlayback');
  const template = view.slice(view.indexOf('setBody(`'), view.indexOf('</div>`)') + 7);

  it('has no hard-coded English text between tags', () => {
    assert.ok(template.includes('playback-panel'));
    assert.deepEqual(textNodes(template), []);
  });

  it('uses keys for every section', () => {
    for (const k of ['xfDesc', 'gaplessTitle', 'resumeTitle', 'rgTitle', 'rgModeTrack', 'rgClip', 'ytDesc', 'uiTitle', 'barTop', 'navTitle', 'dynTitle', 'qaaTitle']) {
      assert.ok(view.includes(`t('player.playback.${k}')`), k);
    }
    for (const k of ['player.player.crossfadeShort', 'player.autodj.crossfadeLabel', 'player.title.youtubeDownload', 'player.ytdl.formatOpus']) {
      assert.ok(view.includes(`t('${k}')`), k);
    }
  });

  it('shows a Dutch text for every new Playback key', () => {
    const keys = Object.keys(en).filter(k => k.startsWith('player.playback.'));
    assert.ok(keys.length >= 40);
    for (const k of keys) assert.equal(typeof locales.nl[k], typeof en[k], k);
    assert.equal(locales.nl['player.playback.rgTitle'], 'Volumenormalisatie');
  });
});

describe('player strings outside Playback (P072 sweep)', () => {
  it('has no English toast literals', () => {
    assert.doesNotMatch(appSrc, /toast\(\s*`⚠ [A-Z]/);
    assert.doesNotMatch(appSrc, /toast\(\s*`Saved /);
    assert.doesNotMatch(appSrc, /'Unknown'/);
  });

  it('pluralises through keys instead of English suffixes', () => {
    assert.doesNotMatch(appSrc, /\$\{[^}]*!== ?1 \? 's' : ''\}/);
    assert.doesNotMatch(appSrc, /=== 1 \? '(song|folder)' : /);
  });

  it('labels the sort bar from keys', () => {
    const src = topLevelSource('_mountSongVScroll');
    assert.match(src, /t\('player\.sortBar\.' \+ p\.dataset\.key\)/);
    for (const k of ['label', 'artist', 'title', 'album', 'year']) assert.ok(en[`player.sortBar.${k}`], k);
  });

  it('builds the VU reference knob title from the current level', () => {
    assert.match(en['player.ctrl.vuRefKnobDrag'], /\{\{db\}\}/);
    assert.ok(!('player.ctrl.vuRefKnob' in en));
    assert.doesNotMatch(indexHtml, /vu-ref-knob[^>]*data-i18n/);
  });

  it('translates aria-labels in index.html', () => {
    const tags = indexHtml.split('<').map(s => s.slice(0, s.indexOf('>'))).filter(tag => tag.includes(' aria-label="') && !tag.includes(' aria-label=""'));
    assert.ok(tags.length > 5);
    for (const tag of tags) assert.match(tag, /data-i18n-attr="[^"]*aria-label/, tag.slice(0, 80));
  });
});

describe('player key coverage', () => {
  it('defines every literal t(\'player.…\') key used in app.js', () => {
    const used = new Set([...appSrc.matchAll(/\bt\(\s*'(player\.[\w.]+\w)'/g)].map(m => m[1]));
    const missing = [...used].filter(k => !(k in en));
    assert.deepEqual(missing, []);
  });

  it('defines every data-i18n key in index.html', () => {
    const missing = [...indexHtml.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]).filter(k => !(k in en));
    assert.deepEqual(missing, []);
  });

  it('keeps all 12 locales on the same key set', () => {
    const enKeys = Object.keys(en).sort();
    for (const l of LANGS.slice(1)) assert.deepEqual(Object.keys(locales[l]).sort(), enKeys, l);
  });
});
