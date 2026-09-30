const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('formatAutoDjPick — one bounded journal line per Auto-DJ pick', async () => {
  const { formatAutoDjPick } = await import('../../src/util/autodj-log.js');
  const row = { artist: 'Valerie Dore', title: 'Get Closer (original vocal version)', bpm: 112, musical_key: 'A major', year: 2012, genre: 'new wave, europop, synth-pop' };

  it('shows the pick, the numbers behind it, and the from→to context', () => {
    const line = formatAutoDjPick('dennis', row, { cands: 447, score: 0.8123, similar: 0, escape: 'dance', dropArtist: false, curBpm: 122, curKey: 'E major', curYear: 2020, curGenre: 'dance' });
    assert.equal(line, '[autodj] ▶ dennis: "Valerie Dore — Get Closer (original vocal version)" score=0.812 cands=447 similar=0 escape=dance | bpm 122→112 key E major→A major year 2020→2012 genre dance→new wave, europop, synth-pop');
  });

  it('collapses unchanged context and marks a hard escape', () => {
    const line = formatAutoDjPick('dennis', { ...row, bpm: 122, musical_key: 'E major', year: 2020, genre: 'dance' }, { cands: 12, score: 0.5, similar: 34, escape: 'dance', dropArtist: true, curBpm: 122, curKey: 'E major', curYear: 2020, curGenre: 'dance' });
    assert.match(line, / escape=dance\(hard\) \| bpm 122 key E major year 2020 genre dance$/);
  });

  it('never lets tag text break the line or grow it unbounded', () => {
    const nasty = 'x'.repeat(500) + '\n[autodj] forged';
    const line = formatAutoDjPick('u\nser', { ...row, title: nasty, genre: nasty }, { cands: 1, score: 1, curGenre: nasty });
    assert.equal(line.includes('\n'), false);
    assert.ok(line.length < 500, `line too long: ${line.length}`);
  });

  it('tolerates a missing trace or file fields', () => {
    const line = formatAutoDjPick('u', {}, {});
    assert.equal(line, '[autodj] ▶ u: "? — ?" score=? cands=? similar=0 | bpm ? key ? year ? genre ?');
  });
});
