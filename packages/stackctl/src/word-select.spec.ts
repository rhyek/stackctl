import sliceAnsi from 'slice-ansi';
import { describe, test, expect } from 'vitest';
import { stripAnsi } from './format.js';
import {
  DOUBLE_CLICK_MS,
  trackClick,
  wordSelectionAt,
  wordSpanAt,
  type ClickState,
} from './word-select.js';

const ESC = String.fromCharCode(27);
const red = (s: string) => `${ESC}[31m${s}${ESC}[0m`;

/**
 * The word `wordSpanAt` picks out of `text` when display column `col` is
 * double-clicked. Sliced the same way the viewport highlights and copies it, so
 * the span really is in display columns.
 */
function wordAt(text: string, col: number): string | null {
  const span = wordSpanAt(text, col);
  return span ? stripAnsi(sliceAnsi(text, span.start, span.end)) : null;
}

describe('wordSpanAt', () => {
  test('selects a plain word bounded by spaces', () => {
    expect(wordAt('worker gateway', 2)).toBe('worker');
  });

  test('joins across an interior dot', () => {
    expect(wordAt('index.html', 3)).toBe('index.html');
  });

  test('joins across a hyphen, so kebab-case and flags select whole', () => {
    expect(wordAt('is-a', 0)).toBe('is-a');
    expect(wordAt('log-level', 1)).toBe('log-level');
    expect(wordAt('--verbose', 4)).toBe('--verbose');
  });

  test('selects a whole path, keeping its leading ./ and dropping a trailing dot', () => {
    expect(wordAt('./scripts/demo/record.sh.', 12)).toBe('./scripts/demo/record.sh');
  });

  test('stops at = so a key and its value are separate words', () => {
    expect(wordAt('env=value', 1)).toBe('env');
    expect(wordAt('env=value', 5)).toBe('value');
  });

  test('selects a whole URI from any part of it, query string included', () => {
    const url = 'http://localhost:3001/todos?a=1&b=2';
    // scheme, host, port, path, query key, query value, last character
    for (const col of [1, 9, 22, 25, 28, 30, url.length - 1]) {
      expect(wordAt(url, col)).toBe(url);
    }
  });

  test('leaves sentence punctuation off the end of a URI', () => {
    expect(wordAt('see http://x.io/a?b=1. next', 10)).toBe('http://x.io/a?b=1');
  });

  test('keeps a URI trailing slash', () => {
    expect(wordAt('http://x.io/ up', 3)).toBe('http://x.io/');
  });

  test('drops trailing sentence punctuation', () => {
    expect(wordAt('ready. next', 2)).toBe('ready');
    expect(wordAt('retry?', 2)).toBe('retry');
  });

  test('measures columns past ANSI styling rather than raw string indexes', () => {
    expect(wordAt(`${red('ERROR')} boom`, 1)).toBe('ERROR');
    expect(wordAt(`${red('ERROR')} boom`, 7)).toBe('boom');
  });

  test('measures a wide glyph as the two columns it occupies', () => {
    // `日本` is four display columns, so `foo` starts at column 5.
    expect(wordAt('日本 foo', 5)).toBe('foo');
    expect(wordAt('日本 foo', 2)).toBe('日本');
  });

  test('selects nothing when the column is not on a word', () => {
    expect(wordSpanAt('worker gateway', 6)).toBeNull();
    expect(wordSpanAt('[backend] up', 0)).toBeNull();
    expect(wordSpanAt('worker', 99)).toBeNull();
  });
});

describe('wordSpanAt on non-ASCII text', () => {
  test('keeps an accented word whole, composed or decomposed', () => {
    expect(wordAt('cafés ok', 2)).toBe('cafés');
    expect(wordAt('cafés ok'.normalize('NFD'), 2)).toBe('cafés'.normalize('NFD'));
  });

  test('treats an unspaced ideograph run as one word', () => {
    expect(wordAt('日本語 ok', 2)).toBe('日本語');
  });
});

describe('wordSpanAt on the shapes that show up in logs', () => {
  const cases: Array<[label: string, text: string, col: number, expected: string]> = [
    [
      'a URL, query string and all',
      'GET http://localhost:3001/todos?a=1&b=2 200',
      30,
      'http://localhost:3001/todos?a=1&b=2',
    ],
    [
      'a relative logfile path',
      'logfile: node_modules/.stackctl/logs/178.log',
      14,
      'node_modules/.stackctl/logs/178.log',
    ],
    ['a directory, keeping its trailing slash', 'wrote dist/ ok', 7, 'dist/'],
    ['a timestamp', '12:34:56.789 [api] up', 4, '12:34:56.789'],
    [
      'a UUID',
      'id 550e8400-e29b-41d4-a716-446655440000 done',
      5,
      '550e8400-e29b-41d4-a716-446655440000',
    ],
    ['an env key, without its value', 'FOO=bar baz', 1, 'FOO'],
    ['a key, dropping its colon', '  context: heartbeat', 4, 'context'],
    ['a percentage, dropping the sign', 'at 95% done', 4, '95'],
    ['a hidden file', 'read .env now', 7, '.env'],
    ['a home-relative path', 'cd ~/src/app now', 6, '~/src/app'],
    ['a run of only joiners', 'wait ... done', 6, '...'],
  ];
  for (const [label, text, col, expected] of cases) {
    test(`selects ${label}`, () => {
      expect(wordAt(text, col)).toBe(expected);
    });
  }
});

describe('wordSpanAt across one line covering every rule', () => {
  const line = 'worker cafés log-level index.html ready. ./scripts/demo/record.sh. retry now?';
  const at = (needle: string) => line.indexOf(needle) + 1;

  test.each([
    ['worker', 'worker'],
    ['cafés', 'cafés'],
    ['log-level', 'log-level'],
    ['index', 'index.html'],
    ['ready', 'ready'],
    ['demo', './scripts/demo/record.sh'],
    ['now', 'now'],
  ])('double-clicking %s selects %s', (needle, expected) => {
    expect(wordAt(line, at(needle))).toBe(expected);
  });
});

describe('trackClick', () => {
  const cell = { col: 10, row: 4 };

  /** Feed a series of `[cell, timestamp]` presses and return the click count each produced. */
  function counts(presses: Array<[{ col: number; row: number } | null, number]>): number[] {
    let state: ClickState = null;
    const out: number[] = [];
    for (const [at, now] of presses) {
      if (at === null) {
        // `null` stands for an intervening drag or wheel event, which breaks the streak.
        state = null;
        continue;
      }
      const next = trackClick(state, at, now);
      state = next.state;
      out.push(next.count);
    }
    return out;
  }

  test('counts a second press on the same cell as a double-click', () => {
    expect(
      counts([
        [cell, 1000],
        [cell, 1200],
      ]),
    ).toEqual([1, 2]);
  });

  test('counts a third press on the same cell as a triple-click', () => {
    expect(
      counts([
        [cell, 1000],
        [cell, 1200],
        [cell, 1400],
      ]),
    ).toEqual([1, 2, 3]);
  });

  test('starts over when the presses are too far apart', () => {
    expect(
      counts([
        [cell, 1000],
        [cell, 1000 + DOUBLE_CLICK_MS + 1],
      ]),
    ).toEqual([1, 1]);
  });

  test('starts over on a different cell', () => {
    expect(
      counts([
        [cell, 1000],
        [{ col: 11, row: 4 }, 1100],
      ]),
    ).toEqual([1, 1]);
    expect(
      counts([
        [cell, 1000],
        [{ col: 10, row: 5 }, 1100],
      ]),
    ).toEqual([1, 1]);
  });

  test('starts over when a drag or wheel event interrupts the streak', () => {
    expect(
      counts([
        [cell, 1000],
        [null, 1050],
        [cell, 1100],
      ]),
    ).toEqual([1, 1]);
  });

  test('measures each gap from the previous press, not from the first', () => {
    const gap = DOUBLE_CLICK_MS - 50;
    expect(
      counts([
        [cell, 1000],
        [cell, 1000 + gap],
        [cell, 1000 + gap * 2],
      ]),
    ).toEqual([1, 2, 3]);
  });
});

describe('wordSelectionAt across wrapped rows', () => {
  // One logical line — `[api] http://example.com/a?b=1 ok` — wrapped after `exa`.
  // Both rows carry the 6-column `[api] ` gutter; content starts past it.
  const segments = [
    { flatRow: 4, contentStart: 6, text: '[api] http://exa' },
    { flatRow: 5, contentStart: 6, text: '[api] mple.com/a?b=1 ok' },
  ];

  test('selects a URI split across the wrap, from the first row', () => {
    expect(wordSelectionAt(segments, { flatRow: 4, col: 8 })).toEqual({
      anchor: { flatRow: 4, col: 6 },
      focus: { flatRow: 5, col: 20 },
    });
  });

  test('selects the same URI when clicked on the second row', () => {
    expect(wordSelectionAt(segments, { flatRow: 5, col: 8 })).toEqual({
      anchor: { flatRow: 4, col: 6 },
      focus: { flatRow: 5, col: 20 },
    });
  });

  test('selects a plain word that straddles the wrap', () => {
    const split = [
      { flatRow: 1, contentStart: 4, text: '[w] connec' },
      { flatRow: 2, contentStart: 4, text: '[w] ted now' },
    ];
    expect(wordSelectionAt(split, { flatRow: 2, col: 5 })).toEqual({
      anchor: { flatRow: 1, col: 4 },
      focus: { flatRow: 2, col: 7 },
    });
  });

  test('keeps a word that does not straddle the wrap on its own row', () => {
    expect(wordSelectionAt(segments, { flatRow: 5, col: 21 })).toEqual({
      anchor: { flatRow: 5, col: 21 },
      focus: { flatRow: 5, col: 23 },
    });
  });

  test('declines a press in the gutter, leaving it to the single-row rules', () => {
    expect(wordSelectionAt(segments, { flatRow: 4, col: 2 })).toBeNull();
  });

  test('declines a press on whitespace between words', () => {
    expect(wordSelectionAt(segments, { flatRow: 5, col: 20 })).toBeNull();
  });
});
