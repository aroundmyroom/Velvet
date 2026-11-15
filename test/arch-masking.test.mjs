import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  abs, walk, read, rel, lineOf, ownWebappJs, hiddenRanges, hiddenHtmlLines, HIDDEN_JS_FILE, HIDDEN_HTML_FILE,
} from './helpers/arch.mjs';

// The guards skip exactly one block. These limits stop the masked area from growing unnoticed.
const MAX_JS_LINES = 600;
const MAX_HTML_LINES = 3;

describe('architecture: masked code stays small', () => {
  it(`only one block in ${HIDDEN_JS_FILE} is masked, at most ${MAX_JS_LINES} lines`, () => {
    const masked = [...walk('src'), ...ownWebappJs()].filter((f) => hiddenRanges(f).length).map(rel);
    assert.deepEqual(masked, [HIDDEN_JS_FILE]);
    const ranges = hiddenRanges(abs(HIDDEN_JS_FILE));
    assert.equal(ranges.length, 1, `expected one masked block in ${HIDDEN_JS_FILE}, found ${ranges.length}`);
    const src = read(abs(HIDDEN_JS_FILE));
    const lines = lineOf(src, ranges[0][1]) - lineOf(src, ranges[0][0]) + 1;
    assert.ok(lines <= MAX_JS_LINES, `masked block is ${lines} lines, limit ${MAX_JS_LINES}`);
  });

  it(`only ${HIDDEN_HTML_FILE} has masked markup, at most ${MAX_HTML_LINES} lines`, () => {
    const masked = walk('webapp', /\.html?$/).filter((f) => hiddenHtmlLines(f).length).map(rel);
    assert.deepEqual(masked, [HIDDEN_HTML_FILE]);
    assert.ok(hiddenHtmlLines(abs(HIDDEN_HTML_FILE)).length <= MAX_HTML_LINES);
  });
});
