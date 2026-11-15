// Player fixes P028 (CUE sleep boundary) and P061 (cached theme colours) from fix-147-plan.md.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appSrc, loadFns, topLevelSource } from './helpers/fix-player-app.mjs';

describe('end-of-song sleep at a CUE virtual-track boundary (P028)', () => {
  const run = ({ sleepMins, paused, currentTime = 120.5 }) => {
    const calls = [];
    const ctx = loadFns(['_onAudioTimeupdateUI'], {
      S: { sleepMins, idx: 0, queue: [{ _isCueSplit: true, cueOffset: 0, cueEndOffset: 120.6 }] },
      // duration 0 makes the handler return right after the CUE check
      audioEl: { paused, currentTime, duration: 0 },
      Player: { next: () => calls.push('next'), toggle: () => calls.push('toggle') },
      _sleepStopped: () => calls.push('sleepStopped'),
      _syncGaplessWaveformNote() {},
    });
    ctx._onAudioTimeupdateUI();
    return calls;
  };

  it('pauses and ends the sleep timer instead of moving to the next CUE track', () => {
    assert.deepEqual(run({ sleepMins: -1, paused: false }), ['toggle', 'sleepStopped']);
  });

  it('advances to the next CUE track when no sleep is armed', () => {
    assert.deepEqual(run({ sleepMins: 0, paused: false }), ['next']);
    assert.deepEqual(run({ sleepMins: 30, paused: false }), ['next']);
  });

  it('does not advance on the timeupdate a pause fires at the boundary', () => {
    assert.deepEqual(run({ sleepMins: 0, paused: true }), []);
  });
});

describe('meter and waveform colours are cached (P061)', () => {
  const setup = () => {
    let reads = 0;
    const vars = { '--primary': ' #8b5cf6', '--accent': '#ec4899 ' };
    const classes = new Set();
    const ctx = loadFns(['_themeColorCache', '_themeColors', '_resetAlbumArtTheme', '_THEME_CLASSES', 'applyTheme'], {
      getComputedStyle: () => { reads++; return { getPropertyValue: n => vars[n] || '' }; },
      document: {
        documentElement: {
          classList: { remove: (...c) => c.forEach(x => classes.delete(x)), add: c => classes.add(c) },
          style: { removeProperty() {} },
        },
        querySelectorAll: () => [],
      },
      requestAnimationFrame() {},
      _updateBadgeFg() {}, _drawWaveform() {},
    });
    return { ctx, vars, reads: () => reads };
  };

  it('reads computed style once and reuses it for every frame', () => {
    const { ctx, reads } = setup();
    assert.deepEqual({ ...ctx._themeColors() }, { primary: '#8b5cf6', accent: '#ec4899' });
    for (let i = 0; i < 60; i++) ctx._themeColors();
    assert.equal(reads(), 1);
  });

  it('re-reads after a theme switch', () => {
    const { ctx, vars, reads } = setup();
    ctx._themeColors();
    vars['--primary'] = '#111111';
    ctx.applyTheme('light', false);
    assert.equal(ctx._themeColors().primary, '#111111');
    assert.equal(reads(), 2);
  });

  it('re-reads after the album-art colours are reset', () => {
    const { ctx, vars } = setup();
    ctx._themeColors();
    vars['--accent'] = '#00ff00';
    ctx._resetAlbumArtTheme();
    assert.equal(ctx._themeColors().accent, '#00ff00');
  });

  it('does not cache an empty value read before the stylesheet applies', () => {
    const { ctx, vars, reads } = setup();
    vars['--primary'] = '';
    ctx._themeColors();
    vars['--primary'] = '#8b5cf6';
    assert.equal(ctx._themeColors().primary, '#8b5cf6');
    assert.equal(reads(), 2);
  });

  it('clears the cache when album-art colours are applied', () => {
    const body = topLevelSource('_applyAlbumArtTheme');
    assert.match(body, /setProperty\('--primary-fg', primaryFg\);\s*_themeColorCache = null;/);
  });

  it('leaves no per-frame getComputedStyle in the meters or the waveform', () => {
    const calls = [...appSrc.matchAll(/getComputedStyle\(/g)].length;
    assert.equal(calls, 2);
    assert.match(topLevelSource('_themeColors'), /getComputedStyle\(/);
    assert.match(topLevelSource('_updateBadgeFg'), /getComputedStyle\(/);
    assert.doesNotMatch(topLevelSource('_drawWaveformBars'), /getComputedStyle/);
  });
});
