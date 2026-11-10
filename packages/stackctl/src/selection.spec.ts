import { describe, test, expect } from 'vitest';
import {
  classifyLine,
  highlightParts,
  isEmptySelection,
  normalizeSelection,
  rowSpan,
  selectionCopyText,
  selectionText,
  valueRun,
  viewportRowIndex,
  type RowMeta,
  type Selection,
} from './selection.js';

const ESC = String.fromCharCode(27);
const red = (s: string) => `${ESC}[31m${s}${ESC}[0m`;

describe('selection ordering', () => {
  test('detects an empty (click, no drag) selection', () => {
    expect(
      isEmptySelection({ anchor: { flatRow: 2, col: 3 }, focus: { flatRow: 2, col: 3 } }),
    ).toBe(true);
    expect(
      isEmptySelection({ anchor: { flatRow: 2, col: 3 }, focus: { flatRow: 2, col: 4 } }),
    ).toBe(false);
  });

  test('normalizes to top-left start .. bottom-right end regardless of drag direction', () => {
    const upward: Selection = { anchor: { flatRow: 5, col: 2 }, focus: { flatRow: 3, col: 8 } };
    expect(normalizeSelection(upward)).toEqual({
      start: { flatRow: 3, col: 8 },
      end: { flatRow: 5, col: 2 },
    });
    const sameRow: Selection = { anchor: { flatRow: 4, col: 9 }, focus: { flatRow: 4, col: 1 } };
    expect(normalizeSelection(sameRow)).toEqual({
      start: { flatRow: 4, col: 1 },
      end: { flatRow: 4, col: 9 },
    });
  });
});

describe('rowSpan', () => {
  const multi: Selection = { anchor: { flatRow: 2, col: 4 }, focus: { flatRow: 5, col: 3 } };

  test('is character-precise on the first and last rows, full-width in between', () => {
    expect(rowSpan(multi, 2, 20)).toEqual({ start: 4, end: 20 }); // first row: col4 -> end
    expect(rowSpan(multi, 3, 20)).toEqual({ start: 0, end: 20 }); // middle: whole row
    expect(rowSpan(multi, 5, 20)).toEqual({ start: 0, end: 3 }); // last row: start -> col3
  });

  test('returns null outside the selected rows', () => {
    expect(rowSpan(multi, 1, 20)).toBeNull();
    expect(rowSpan(multi, 6, 20)).toBeNull();
  });

  test('clamps to the row width and returns null for an empty span', () => {
    const single: Selection = { anchor: { flatRow: 1, col: 3 }, focus: { flatRow: 1, col: 100 } };
    expect(rowSpan(single, 1, 10)).toEqual({ start: 3, end: 10 }); // end clamped to width
    const zero: Selection = { anchor: { flatRow: 1, col: 5 }, focus: { flatRow: 1, col: 5 } };
    expect(rowSpan(zero, 1, 10)).toBeNull();
  });
});

describe('selectionText', () => {
  const rows = ['[api] hello world', '[api] second line', '[api] third line'];
  const rowAt = (flatRow: number) => rows[flatRow] ?? '';

  test('copies a character-precise slice of a single row', () => {
    const sel: Selection = { anchor: { flatRow: 0, col: 6 }, focus: { flatRow: 0, col: 11 } };
    expect(selectionText(sel, rowAt)).toBe('hello');
  });

  test('copies first-row-tail, whole middle rows, and last-row-head across a multi-row drag', () => {
    const sel: Selection = { anchor: { flatRow: 0, col: 6 }, focus: { flatRow: 2, col: 5 } };
    expect(selectionText(sel, rowAt)).toBe('hello world\n[api] second line\n[api]');
  });

  test('strips ANSI colors from the copied text (WYSIWYG plain glyphs)', () => {
    const colored = (flatRow: number) => [red('[api]') + ' hello'][flatRow] ?? '';
    const sel: Selection = { anchor: { flatRow: 0, col: 0 }, focus: { flatRow: 0, col: 11 } };
    expect(selectionText(sel, colored)).toBe('[api] hello');
  });

  test('slices by display column with wide (2-cell) glyphs', () => {
    const wide = (flatRow: number) => ['a世b'][flatRow] ?? '';
    // '世' occupies columns [1,3); selecting [1,3) yields just it.
    const sel: Selection = { anchor: { flatRow: 0, col: 1 }, focus: { flatRow: 0, col: 3 } };
    expect(selectionText(sel, wide)).toBe('世');
  });
});

describe('highlightParts', () => {
  test('keeps color on pre/post and strips it from the inverted middle', () => {
    const row = red('hello') + ' world';
    const { pre, mid, post } = highlightParts(row, { start: 2, end: 7 });
    expect(pre).toContain(`${ESC}[31m`); // colored pre
    expect(mid).toBe('llo w'); // plain middle
    expect(post.includes(ESC)).toBe(false); // ' world' had no active color
    expect(post).toContain('orld');
  });
});

describe('viewportRowIndex', () => {
  test('maps terminal rows directly when the pane is full (no blank padding)', () => {
    // topHeight=1, so the pane starts at terminal row 2; buffer fills the pane.
    expect(viewportRowIndex(2, 1, 10, 10)).toBe(0);
    expect(viewportRowIndex(11, 1, 10, 10)).toBe(9);
  });

  test('accounts for bottom-alignment when the buffer is shorter than the pane', () => {
    // paneHeight=10 but only 3 rendered rows -> 7 blank rows on top; content at
    // terminal rows 9,10,11 (topHeight=1 -> pane rows 2..11, blankTop=7).
    expect(viewportRowIndex(9, 1, 10, 3)).toBe(0);
    expect(viewportRowIndex(11, 1, 10, 3)).toBe(2);
    expect(viewportRowIndex(2, 1, 10, 3)).toBe(-7); // above the content (caller clamps)
  });
});

describe('classifyLine', () => {
  test('finds the value after an indented `key: `', () => {
    expect(classifyLine('  asset_path: /v1/store/abc')).toEqual({ kind: 'keyed', valueStart: 14 });
    expect(classifyLine('  attempt: 3')).toEqual({ kind: 'keyed', valueStart: 11 });
  });

  test('finds the value after a leading `[TOKEN] ` on a header line', () => {
    expect(classifyLine('[INFO] upload failed')).toEqual({ kind: 'header', valueStart: 7 });
    expect(classifyLine('[UNKNOWN LOGLVL: 30] x')).toEqual({ kind: 'header', valueStart: 21 });
  });

  test('treats an indented line with no key as a continuation of the value above', () => {
    expect(classifyLine('        second line of the note')).toEqual({
      kind: 'continuation',
      valueStart: 8,
    });
  });

  test('treats anything else as plain — the whole line is the value', () => {
    expect(classifyLine('listening on 3002')).toEqual({ kind: 'plain', valueStart: 0 });
  });

  test('classifies on the ANSI-stripped text', () => {
    expect(classifyLine(`  ${red('asset_path:')} /v1`)).toEqual({ kind: 'keyed', valueStart: 14 });
  });
});

// A rendered entry: header, a keyed attr that wraps over two rows, then a two-row keyed attr
// whose value contains a real newline, then the next entry. Gutter is 4 (`[p] `).
const G = 4;
const META: RowMeta[] = [
  { text: '[p] [INFO] upload failed', contentStart: G, valueStart: G + 7, lineIndex: 0, kind: 'header' }, // oxfmt-ignore
  { text: '[p]   asset_path: /v1/store/AAAA', contentStart: G, valueStart: G + 14, lineIndex: 1, kind: 'keyed' }, // oxfmt-ignore
  { text: '[p]               BBBB?sig=9f2c', contentStart: G + 14, valueStart: G + 14, lineIndex: 1, kind: 'keyed' }, // oxfmt-ignore
  { text: '[p]   note: first line', contentStart: G, valueStart: G + 8, lineIndex: 2, kind: 'keyed' }, // oxfmt-ignore
  // First row of a line, so contentStart is the gutter — its 8-space indent is display padding
  // that only `valueStart` accounts for. Matches what wrapLineRows actually produces.
  { text: '[p]         second line', contentStart: G, valueStart: G + 8, lineIndex: 3, kind: 'continuation' }, // oxfmt-ignore
  { text: '[p] [INFO] next entry', contentStart: G, valueStart: G + 7, lineIndex: 4, kind: 'header' }, // oxfmt-ignore
];
const metaAt = (flatRow: number): RowMeta | null => META[flatRow] ?? null;

describe('valueRun', () => {
  test('covers every wrapped row of the clicked line', () => {
    expect(valueRun(1, metaAt, META.length)).toEqual({ start: 1, end: 2 });
    expect(valueRun(2, metaAt, META.length)).toEqual({ start: 1, end: 2 });
  });

  test('extends through following indented continuations of the same value', () => {
    expect(valueRun(3, metaAt, META.length)).toEqual({ start: 3, end: 4 });
  });

  test('stops at the next keyed attr or entry', () => {
    expect(valueRun(0, metaAt, META.length)).toEqual({ start: 0, end: 0 });
    expect(valueRun(5, metaAt, META.length)).toEqual({ start: 5, end: 5 });
  });
});

describe('selectionCopyText', () => {
  const sel = (a: [number, number], f: [number, number], run: Selection['run']): Selection => ({
    anchor: { flatRow: a[0], col: a[1] },
    focus: { flatRow: f[0], col: f[1] },
    mode: run ? 'value' : 'wysiwyg',
    run,
  });

  test('joins wrapped rows of one line seamlessly, stripping gutter and hanging indent', () => {
    const s = sel([1, G + 14], [2, 31], { start: 1, end: 2 });
    expect(selectionCopyText(s, metaAt)).toBe('/v1/store/AAAABBBB?sig=9f2c');
  });

  test('joins distinct buffered lines with a newline — the value’s own line breaks', () => {
    const s = sel([3, G + 8], [4, 23], { start: 3, end: 4 });
    expect(selectionCopyText(s, metaAt)).toBe('first line\nsecond line');
  });

  test('reverts to WYSIWYG when the selection runs past the value', () => {
    const s = sel([1, G + 14], [5, 21], { start: 1, end: 2 });
    expect(selectionCopyText(s, metaAt)).toBe(
      [
        '/v1/store/AAAA',
        '[p]               BBBB?sig=9f2c',
        '[p]   note: first line',
        '[p]         second line',
        '[p] [INFO] next entry',
      ].join('\n'),
    );
  });

  test('reverts to WYSIWYG when the selection runs above the value', () => {
    const s = sel([0, G + 8], [2, 31], { start: 1, end: 2 });
    expect(selectionCopyText(s, metaAt)).toContain('[p]   asset_path:');
  });

  test('copies plainly when the drag began left of the value (wysiwyg mode)', () => {
    const s = sel([1, 2], [1, 32], null);
    expect(selectionCopyText(s, metaAt)).toBe(']   asset_path: /v1/store/AAAA');
  });
});

describe('rowSpan with a content floor', () => {
  test('clamps a continuation row’s highlight to where its content begins', () => {
    const s: Selection = {
      anchor: { flatRow: 1, col: G + 14 },
      focus: { flatRow: 2, col: 31 },
      mode: 'value',
      run: { start: 1, end: 2 },
    };
    expect(rowSpan(s, 2, 31, G + 14)).toEqual({ start: G + 14, end: 31 });
    // the anchor row keeps the exact click column
    expect(rowSpan(s, 1, 31, G)).toEqual({ start: G + 14, end: 31 });
  });
});
