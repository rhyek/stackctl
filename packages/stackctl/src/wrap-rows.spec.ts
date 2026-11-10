import { describe, expect, test } from 'vitest';
import { countWrappedRows, expandTabs, measureText, wrapRows } from './wrap-rows.js';

/** A small seeded generator, so a failure names a case that can be replayed. */
function random(seed: number) {
  let state = seed;
  const next = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  return { next, int, pick };
}

const SGR = ['\x1b[31m', '\x1b[39m', '\x1b[1m', '\x1b[22m', '\x1b[0m', '\x1b[2m', '\x1b[38;5;200m'];
const ASCII = 'abcdefghijklmnopqrstuvwxyzABCXYZ0123456789:/.,-_=?&[]{}"\'()#%+~@';
// One-column characters outside ASCII, the kind dev servers print.
const NARROW = '✓➜…│─éñ«»°';

function randomText(rng: ReturnType<typeof random>, opts: { sgr: boolean; narrow: boolean }) {
  const chars = opts.narrow ? ASCII + NARROW : ASCII;
  let out = rng.next() < 0.3 ? ' '.repeat(rng.int(1, 6)) : '';
  const words = rng.int(1, 25);
  for (let w = 0; w < words; w++) {
    if (opts.sgr && rng.next() < 0.25) {
      out += rng.pick(SGR);
    }
    const length = rng.next() < 0.1 ? rng.int(20, 90) : rng.next() < 0.05 ? 0 : rng.int(1, 12);
    for (let c = 0; c < length; c++) {
      out += chars[Math.floor(rng.next() * chars.length)];
      if (opts.sgr && rng.next() < 0.02) {
        out += rng.pick(SGR);
      }
    }
    if (w < words - 1) {
      out += ' '.repeat(rng.next() < 0.1 ? rng.int(2, 5) : 1);
    }
  }
  return rng.next() < 0.1 ? out + ' '.repeat(rng.int(1, 20)) : out;
}

/** The row count under test, and the rows it has to agree with. */
function counted(text: string, width: number, indent: number) {
  return {
    count: countWrappedRows(text, measureText(text), width, indent),
    rows: wrapRows(text, width, indent),
  };
}

describe('countWrappedRows', () => {
  // The count is worked out without wrapping, so the only thing that makes it right is agreeing
  // with the wrapper — on every input, since a disagreement shifts every row below it.
  for (const variant of [
    { name: 'plain ASCII', sgr: false, narrow: false },
    { name: 'colored ASCII', sgr: true, narrow: false },
    { name: 'colored text with one-column symbols', sgr: true, narrow: true },
  ]) {
    test(`agrees with wrapRows on random ${variant.name}`, () => {
      const rng = random(variant.name.length);
      for (let n = 0; n < 150; n++) {
        const text = randomText(rng, variant);
        const width = rng.next() < 0.15 ? rng.int(1, 8) : rng.int(9, 110);
        const indent = rng.next() < 0.5 ? 0 : rng.int(0, width - 1);
        expect(measureText(text).cells, text).not.toBeNull();
        const { count, rows } = counted(text, width, indent);
        expect(count, JSON.stringify({ text, width, indent, rows })).toBe(rows.length);
      }
    });
  }

  // Random text rarely lands a word exactly on a row boundary, which is where the rules live.
  test('agrees with wrapRows where a word meets the row boundary', () => {
    const token = (length: number, char: string) => char.repeat(Math.max(0, length));
    for (const width of [1, 2, 5, 21]) {
      for (const indent of [0, 1, 4, 19].filter((i) => i < width)) {
        const next = width - indent;
        const lengths = new Set<number>();
        for (const base of [0, next, width, width + next]) {
          for (const delta of [-1, 0, 1]) {
            if (base + delta >= 0) {
              lengths.add(base + delta);
            }
          }
        }
        for (const gap of [1, 2, width]) {
          for (const a of lengths) {
            for (const b of lengths) {
              const texts = [
                `${token(a, 'a')}${' '.repeat(gap)}${token(b, 'b')}`,
                `h${' '.repeat(gap)}${token(a, 'a')}${' '.repeat(gap)}${token(b, 'b')} tail`,
                `\x1b[31m${token(a, 'a')}\x1b[39m${' '.repeat(gap)}${token(b, 'b')}${' '.repeat(gap)}`,
              ];
              for (const text of texts) {
                const { count, rows } = counted(text, width, indent);
                expect(count, JSON.stringify({ text, width, indent, rows })).toBe(rows.length);
              }
            }
          }
        }
      }
    }
  });

  test('wraps for real what it cannot count by column offset', () => {
    for (const text of [
      'a wide glyph 漢字 in a line long enough to wrap more than once at this width',
      'an emoji 🚀 in a line long enough to wrap more than once at this narrow width',
      'a\ttab in a line long enough to wrap more than once at this narrow width, twice',
      'a combining mark é in a line long enough to wrap more than once at this width',
    ]) {
      expect(measureText(text).cells, text).toBeNull();
      const { count, rows } = counted(text, 24, 2);
      expect(count, text).toBe(rows.length);
    }
  });
});

describe('measureText', () => {
  test('measures colored text by its visible columns', () => {
    expect(measureText('\x1b[31mred\x1b[39m text')).toEqual({ width: 8, cells: 'red text' });
  });

  test('keeps one-column symbols countable', () => {
    expect(measureText('✓ built … ➜ ready')).toEqual({ width: 17, cells: '✓ built … ➜ ready' });
  });

  test('gives up on anything that is not one column per character', () => {
    expect(measureText('漢字')).toEqual({ width: 4, cells: null });
    expect(measureText('🚀 go')).toEqual({ width: 5, cells: null });
    expect(measureText('a\tb').cells).toBeNull();
    expect(measureText('non breaking').cells).toBeNull();
    // An escape sequence that is not a color (an OSC 8 hyperlink).
    expect(measureText('\x1b]8;;http://example.test\x07link\x1b]8;;\x07').cells).toBeNull();
  });
});

describe('expandTabs', () => {
  test('expands each tab to the next stop of 8 columns', () => {
    expect(expandTabs('a\tb')).toBe('a       b');
    expect(expandTabs('\tindented')).toBe('        indented');
    expect(expandTabs('12345678\tx')).toBe('12345678        x');
    expect(expandTabs('id\tname\tstate')).toBe('id      name    state');
  });

  test('gives colors no columns', () => {
    expect(expandTabs('\x1b[31mab\x1b[39m\tc')).toBe('\x1b[31mab\x1b[39m      c');
  });

  test('leaves a line with no tab as it is', () => {
    const line = '  key: value  ';
    expect(expandTabs(line)).toBe(line);
  });

  test('makes a line wrap at the width it is drawn at', () => {
    const rows = wrapRows(expandTabs('a\tb\tc\td'), 10, 0);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => row.length <= 10)).toBe(true);
    expect(rows.join('').replaceAll(' ', '')).toBe('abcd');
  });
});
