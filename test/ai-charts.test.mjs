/**
 * Charts in the library (src/util/ai-charts.js): numbered folders found from
 * file names, the chart a request names, and the positions it asks for.
 *
 * Run with:
 *   node --test test/ai-charts.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chartPosition, detectCharts, findChart, matchChart, parseChartRange, stripChartWords } from '../src/util/ai-charts.js';

function numbered(folder, n, { pad = 3, sep = ' - ', start = 1, sub = null } = {}) {
  const rows = [];
  for (let i = start; i < start + n; i++) {
    const dir = sub ? `${folder}/${sub(i)}` : folder;
    rows.push({ vpath: 'Music', filepath: `${dir}/${String(i).padStart(pad, '0')}${sep}Act ${i} - Song ${i}.flac` });
  }
  return rows;
}

describe('chart positions', () => {
  it('reads the position from the file name, in every house style', () => {
    assert.equal(chartPosition('Housetop1000/001-100/001 - Jaydee - Plastic Dreams.flac'), 1);
    assert.equal(chartPosition('Housetop1000/001-100/012^ - Speedy J - Pullover.flac'), 12);
    assert.equal(chartPosition('Disco/-= Top 700 =-/1 - 100/12. The O\'Jays - I Love Music.wav'), 12);
    assert.equal(chartPosition('Kink/007 - 209 - Smiths - Bigmouth.flac'), 7);
    assert.equal(chartPosition('Housetop1000/2021 - NW/0926 - Someone - Something.flac'), 926);
    assert.equal(chartPosition('Albums/Cerrone/Supernature.flac'), null);
    assert.equal(chartPosition('Disco/10cc - I\'m Not In Love.flac'), null, 'a band name is not a position');
  });
});

describe('chart detection', () => {
  it('finds numbered lists and keeps the parent, not its hundred-folders', () => {
    const rows = [
      ...numbered('Housetop1000', 1000, { sub: i => `${String(Math.floor((i - 1) / 100) * 100 + 1).padStart(3, '0')}-${Math.floor((i - 1) / 100) * 100 + 100}` }),
      ...numbered('TOP40/Complete Top 40 Van 1983', 364),
      ...numbered('TOP40/Complete Top 40 Van 1984', 350),
      ...numbered('Disco/-= Top 700 =-', 700, { pad: 1, sep: '. ', sub: i => `${Math.floor((i - 1) / 100) * 100 + 1} - ${Math.floor((i - 1) / 100) * 100 + 100}` }),
      // an album: numbered, but short
      ...numbered('Albums/Cerrone/Supernature', 9, { pad: 2 }),
      // a box set: 45 numbered tracks in one folder, nothing in the name says list
      ...numbered('Albums/Kim Wilde/Greatest Hits Box', 45, { pad: 2 }),
      // year-prefixed mixes are not positions
      ...Array.from({ length: 40 }, (_, i) => ({ vpath: 'Music', filepath: `Disconet/Mixe/${1979 + (i % 9)} Disconet Top Tune Medley ${i}.flac` })),
      // unnumbered files
      ...Array.from({ length: 300 }, (_, i) => ({ vpath: 'Music', filepath: `12 inches/A-Z/Artist ${i} - Song.flac` })),
    ];
    const charts = detectCharts(rows);
    const labels = charts.map(c => c.label);
    assert.deepEqual(labels, ['Music/Housetop1000', 'Music/Disco/-= Top 700 =-', 'Music/TOP40/Complete Top 40 Van 1983', 'Music/TOP40/Complete Top 40 Van 1984']);
    const house = charts[0];
    assert.deepEqual([house.from, house.to, house.n, house.positions, house.name], [1, 1000, 1000, 1000, 'Housetop1000']);
    assert.ok(!labels.includes('Music/TOP40'), 'the parent of 62 year charts is not one chart');
  });
});

const charts = [
  { label: 'Music/Housetop1000', folder: 'Housetop1000', name: 'Housetop1000', from: 1, to: 1000, n: 1136 },
  { label: 'Music/TOP40/Complete Top 40 Van 1983', folder: 'TOP40/Complete Top 40 Van 1983', name: 'Complete Top 40 Van 1983', from: 1, to: 364, n: 364 },
  { label: 'Music/TOP40/Complete Top 40 Van 1984', folder: 'TOP40/Complete Top 40 Van 1984', name: 'Complete Top 40 Van 1984', from: 1, to: 350, n: 350 },
  { label: 'Music/Kink Top 500 80s 2022', folder: 'Kink Top 500 80s 2022', name: 'Kink Top 500 80s 2022', from: 2, to: 500, n: 437 },
  { label: 'Music/Disco/-= Top 700 =-', folder: 'Disco/-= Top 700 =-', name: '-= Top 700 =-', from: 1, to: 700, n: 700 },
];

describe('naming a chart', () => {
  it('matches the chart a request names, in Dutch and English, run-together or not', () => {
    assert.equal(matchChart('geef me de top 10 van de house top 1000', charts)?.label, 'Music/Housetop1000');
    assert.equal(matchChart('the top 10 of the housetop1000', charts)?.label, 'Music/Housetop1000');
    assert.equal(matchChart('nummer 1 van de top 40 van 1983', charts)?.label, 'Music/TOP40/Complete Top 40 Van 1983');
    assert.equal(matchChart('the top 40 of 1984 as a countdown', charts)?.label, 'Music/TOP40/Complete Top 40 Van 1984');
    assert.equal(matchChart('top 20 of the kink top 500', charts)?.label, 'Music/Kink Top 500 80s 2022', 'a year in the chart name is optional when the request has none');
    assert.equal(matchChart('positions 50 to 60 of the disco top 700', charts)?.label, 'Music/Disco/-= Top 700 =-');
    assert.equal(matchChart('de top 10 van de top 40', charts), null, 'sixty year charts: ambiguous, no guess');
    assert.equal(matchChart('two hours of house', charts), null);
    assert.equal(matchChart('my top 20 disco', charts), null);
  });

  it('finds the chart a brief names by label, folder or name', () => {
    assert.equal(findChart('Music/Housetop1000', charts)?.label, 'Music/Housetop1000');
    assert.equal(findChart('House Top 1000', charts)?.label, 'Music/Housetop1000');
    assert.equal(findChart('TOP40/Complete Top 40 Van 1983', charts)?.label, 'Music/TOP40/Complete Top 40 Van 1983');
    assert.equal(findChart('Top 40 1983', charts)?.label, 'Music/TOP40/Complete Top 40 Van 1983');
    assert.equal(findChart('Billboard Hot 100', charts), null);
  });

  it('reads the positions asked for', () => {
    assert.deepEqual(parseChartRange('geef me de top 10 van de house top 1000'), { from: 1, to: 10 });
    assert.deepEqual(parseChartRange('nummer 1 van de top 40 van 1983'), { from: 1, to: 1 });
    assert.deepEqual(parseChartRange('positions 50 to 60 of the disco top 700'), { from: 50, to: 60 });
    assert.deepEqual(parseChartRange('van plaats 100 tot 120 van de house top 1000'), { from: 100, to: 120 });
    assert.deepEqual(parseChartRange('the number one of 1988'), { from: 1, to: 1 });
    assert.deepEqual(parseChartRange('the whole house top 1000'), { from: 1, to: 1000 });
    assert.deepEqual(parseChartRange('de hele lijst'), { from: null, to: null });
  });

  it('takes the chart words out so they are not a genre or an era', () => {
    const rest = stripChartWords('geef me de top 10 van de house top 1000', charts[0]);
    assert.ok(!/house|1000/.test(rest), rest);
    assert.ok(/top 10/.test(rest), 'the positions asked for stay: ' + rest);
    assert.ok(!/1983|40/.test(stripChartWords('nummer 1 van de top 40 van 1983', charts[1])));
  });
});
