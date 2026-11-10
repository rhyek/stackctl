import { describe, test, expect } from 'vitest';
import {
  anchorOffset,
  bottomAnchor,
  computeWindow,
  convertOffset,
  windowRows,
} from './log-window.js';

describe('computeWindow', () => {
  test('returns an empty window for an empty buffer', () => {
    expect(computeWindow([], 10, 0)).toEqual({
      startIndex: 0,
      endIndex: 0,
      topClip: 0,
      bottomClip: 0,
      totalRows: 0,
      maxScroll: 0,
    });
  });

  test('shows every line when the buffer is shorter than the pane', () => {
    const w = computeWindow([1, 1, 1], 10, 0);
    expect(w).toEqual({
      startIndex: 0,
      endIndex: 3,
      topClip: 0,
      bottomClip: 0,
      totalRows: 3,
      maxScroll: 0,
    });
  });

  test('follows the newest rows when scrollOffset is 0 and the buffer overflows', () => {
    // 5 single-row lines, pane of 3 -> show the last 3 (indices 2,3,4).
    const w = computeWindow([1, 1, 1, 1, 1], 3, 0);
    expect(w.startIndex).toBe(2);
    expect(w.endIndex).toBe(5);
    expect(w.topClip).toBe(0);
    expect(w.bottomClip).toBe(0);
    expect(w.maxScroll).toBe(2);
  });

  test('scrolls up by whole rows', () => {
    const w = computeWindow([1, 1, 1, 1, 1], 3, 1);
    expect(w.startIndex).toBe(1);
    expect(w.endIndex).toBe(4);
    expect(w.topClip).toBe(0);
    expect(w.bottomClip).toBe(0);
  });

  test('shows the top of the buffer at maximum scroll', () => {
    const w = computeWindow([1, 1, 1, 1, 1], 3, 2);
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(3);
    expect(w.topClip).toBe(0);
    expect(w.bottomClip).toBe(0);
  });

  test('clamps a scrollOffset beyond maxScroll', () => {
    const clamped = computeWindow([1, 1, 1, 1, 1], 3, 999);
    const atMax = computeWindow([1, 1, 1, 1, 1], 3, 2);
    expect(clamped).toEqual(atMax);
  });

  test('clips partial rows of wrapped (multi-row) lines at both edges', () => {
    // line0=3 rows, line1=1 row, line2=3 rows (total 7), pane 4, scrolled up 1.
    // flat window = rows [2,6): drop top 2 of line0, keep all line1, drop bottom 1 of line2.
    const w = computeWindow([3, 1, 3], 4, 1);
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(3);
    expect(w.topClip).toBe(2);
    expect(w.bottomClip).toBe(1);
    expect(w.totalRows).toBe(7);
    expect(w.maxScroll).toBe(3);
  });

  test('follows correctly with wrapped lines (no clip at the bottom)', () => {
    // total 7, pane 4, follow -> rows [3,7): startIndex 1 (line1), no clips.
    const w = computeWindow([3, 1, 3], 4, 0);
    expect(w.startIndex).toBe(1);
    expect(w.endIndex).toBe(3);
    expect(w.topClip).toBe(0);
    expect(w.bottomClip).toBe(0);
  });

  test('renders nothing when the pane has zero height', () => {
    const w = computeWindow([1, 1, 1], 0, 0);
    expect(w.startIndex).toBe(w.endIndex);
    expect(w.maxScroll).toBe(3);
  });
});

describe('windowRows', () => {
  const wrap = (rows: string[]) => rows;

  test('flattens the visible lines into their rendered rows', () => {
    const lines = [['a'], ['b'], ['c']];
    const w = computeWindow([1, 1, 1], 10, 0);
    expect(windowRows(lines, w, wrap)).toEqual(['a', 'b', 'c']);
  });

  test('applies top and bottom clips to partially-visible wrapped lines', () => {
    const lines = [['a1', 'a2', 'a3'], ['b1'], ['c1', 'c2', 'c3']];
    // pane 4, scrolled up 1 -> drop top 2 of line0, keep line1, drop bottom 1 of line2.
    const w = computeWindow([3, 1, 3], 4, 1);
    expect(windowRows(lines, w, wrap)).toEqual(['a3', 'b1', 'c1', 'c2']);
  });

  test('never emits more rows than the pane height', () => {
    const lines = Array.from({ length: 100 }, (_, i) => [`line ${i}`]);
    const w = computeWindow(
      lines.map(() => 1),
      12,
      0,
    );
    expect(windowRows(lines, w, wrap)).toHaveLength(12);
  });
});

// The bottom edge of the viewport as a (line, rows-clipped-below) pair, and back to a row offset
// in another layout of the same lines — how the scroll position survives a change of gutter
// width (the timestamp switching between `HH:MM:SS` and the full date reflows wrapped lines).
describe('bottomAnchor / anchorOffset', () => {
  test('following (offset 0) anchors to the last line with nothing clipped', () => {
    expect(bottomAnchor([1, 3, 2], 0)).toEqual({ line: 2, clip: 0 });
  });

  test('an offset inside a wrapped line records how many of its rows are hidden', () => {
    // rows: line0=[0], line1=[1,2,3], line2=[4,5]; offset 3 hides rows 5,4,3 → edge is in line 1, 1 row of it hidden.
    expect(bottomAnchor([1, 3, 2], 3)).toEqual({ line: 1, clip: 1 });
    expect(bottomAnchor([1, 3, 2], 2)).toEqual({ line: 1, clip: 0 });
  });

  test('clamps an offset past the top to the oldest row', () => {
    expect(bottomAnchor([1, 3, 2], 99)).toEqual({ line: 0, clip: 0 });
  });

  test('an empty buffer anchors nowhere', () => {
    expect(bottomAnchor([], 5)).toEqual({ line: -1, clip: 0 });
    expect(anchorOffset([], { line: -1, clip: 0 })).toBe(0);
  });

  test('anchorOffset inverts bottomAnchor in the same layout', () => {
    const counts = [1, 3, 2, 1, 4];
    const total = counts.reduce((a, b) => a + b, 0);
    for (let offset = 0; offset < total; offset++) {
      expect(anchorOffset(counts, bottomAnchor(counts, offset))).toBe(offset);
    }
  });

  test('carries the same bottom edge into a layout where lines wrap differently', () => {
    // Line 1 takes 3 rows in the wide-gutter layout but 2 in the narrow one.
    const wide = [1, 3, 2];
    const narrow = [1, 2, 2];
    // Edge in line 1 with 1 row hidden → same in the narrow layout: offset = 2 (line 2) + 1.
    expect(convertOffset(wide, narrow, 3)).toBe(3);
    // Edge in line 1 with 2 rows hidden: the narrow line has only 2 rows, so the clip is capped at 1.
    expect(convertOffset(wide, narrow, 4)).toBe(3);
    // Following stays following.
    expect(convertOffset(wide, narrow, 0)).toBe(0);
    expect(convertOffset(narrow, wide, 0)).toBe(0);
  });

  test('scrolling one row at a time in the narrow layout never gets stuck', () => {
    const wide = [1, 3, 2, 5];
    const narrow = [1, 2, 1, 3];
    const seen = new Set<number>();
    for (let offset = 0; offset < 7; offset++) {
      const back = convertOffset(narrow, wide, offset);
      expect(seen.has(back), `offset ${String(offset)} maps onto an already-used wide offset`).toBe(
        false,
      );
      seen.add(back);
      // and round-trips
      expect(convertOffset(wide, narrow, back)).toBe(offset);
    }
  });
});
