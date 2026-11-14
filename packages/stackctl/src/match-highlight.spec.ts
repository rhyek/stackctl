import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MATCH_COLOR, ON_MATCH_COLOR } from './colors.js';
import { stripAnsi } from './format.js';
import { matchSpans, paintMatches, paintMatchRows } from './match-highlight.js';
import { filterTerms } from './tui/text-cells.js';

let prevLevel: typeof chalk.level;
beforeAll(() => {
  prevLevel = chalk.level;
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = prevLevel;
});

const GUTTER = '[api] ';
const row = (text: string, lineIndex = 0, contentStart = GUTTER.length) => ({
  text: GUTTER + text,
  contentStart,
  lineIndex,
});
const spansOf = (text: string, filter: string) => matchSpans([row(text)], filterTerms(filter))[0];

describe('matchSpans', () => {
  test('finds every occurrence, ignoring case and accents', () => {
    expect(spansOf('Café cafe', 'CAFE')).toEqual([
      { start: 6, end: 10 },
      { start: 11, end: 15 },
    ]);
  });

  test('counts a wide glyph before the match as two columns', () => {
    expect(spansOf('日本 error', 'error')).toEqual([{ start: 11, end: 16 }]);
  });

  test('merges overlapping and adjacent terms into one span', () => {
    expect(spansOf('an error here', 'err error')).toEqual([{ start: 9, end: 14 }]);
    expect(spansOf('foobar', 'foo bar')).toEqual([{ start: 6, end: 12 }]);
  });

  test('ignores the colors in the text', () => {
    expect(spansOf(chalk.red('api') + ' up', 'api')).toEqual([{ start: 6, end: 9 }]);
  });

  test('finds a term in the label, between its brackets, and never in the timestamp', () => {
    const gutter = '12:00:01 [api12 ] ';
    const label = { start: 9, end: 17 };
    const rows = [{ text: `${gutter}got 12`, contentStart: gutter.length, lineIndex: 0, label }];
    expect(matchSpans(rows, filterTerms('12'))[0]).toEqual([
      { start: 13, end: 15 },
      { start: 22, end: 24 },
    ]);
    expect(matchSpans(rows, filterTerms('api ]'))[0]).toEqual([{ start: 10, end: 13 }]);
  });

  test("finds a match the wrap broke across a line's rows", () => {
    const spans = matchSpans([row('id=abc12'), row('  34def', 0, 8)], filterTerms('1234'));
    expect(spans).toEqual([[{ start: 12, end: 14 }], [{ start: 8, end: 10 }]]);
  });
});

describe('paintMatches', () => {
  test('paints the match dark on gold, dropping its own colors and keeping the rest', () => {
    const text = GUTTER + chalk.hex(MATCH_COLOR)('gold error') + ' tail';
    const painted = paintMatches(text, [{ start: 11, end: 16 }]);
    expect(stripAnsi(painted)).toBe(stripAnsi(text));
    expect(painted).toContain(chalk.bgHex(MATCH_COLOR).hex(ON_MATCH_COLOR)('error'));
    expect(painted).toContain(chalk.hex(MATCH_COLOR)('gold '));
  });

  test('leaves a row without matches untouched', () => {
    expect(paintMatches('plain', [])).toBe('plain');
  });
});

describe('paintMatchRows', () => {
  test('searches each line on its own and leaves every row its text', () => {
    const rows = [row('alpha', 0), row('beta', 1)];
    const painted = paintMatchRows(rows, filterTerms('beta'));
    expect(painted[0]).toBe(rows[0]!.text);
    expect(painted[1]).not.toBe(rows[1]!.text);
    expect(painted.map(stripAnsi)).toEqual(rows.map((r) => r.text));
  });

  test('a black or white text on the gold, whichever reads', () => {
    expect(ON_MATCH_COLOR).toBe('#000000');
  });
});
