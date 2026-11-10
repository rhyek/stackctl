import { describe, expect, test } from 'vitest';
import { type Target, hitTest, isClick } from './hit-test.js';

// `  r restart   s stop` on row 10: `r restart` covers columns 3–11, `s stop` 15–20.
const restart: Target = {
  id: 'hint:r',
  rect: { col: 3, row: 10, width: 9, height: 1 },
  action: { type: 'restart' },
};
const stop: Target = {
  id: 'hint:s',
  rect: { col: 15, row: 10, width: 6, height: 1 },
  action: { type: 'stop-start' },
};
// A two-row box.
const box: Target = {
  id: 'box',
  rect: { col: 30, row: 4, width: 5, height: 2 },
  action: { type: 'close-menu' },
};

describe('hitTest', () => {
  test('hitTest picks the target under the cell and nothing in gaps', () => {
    const targets = [restart, stop, box];
    expect(hitTest(targets, 3, 10)).toBe(restart);
    expect(hitTest(targets, 11, 10)).toBe(restart);
    expect(hitTest(targets, 12, 10)).toBeNull();
    expect(hitTest(targets, 14, 10)).toBeNull();
    expect(hitTest(targets, 15, 10)).toBe(stop);
    expect(hitTest(targets, 20, 10)).toBe(stop);
    expect(hitTest(targets, 21, 10)).toBeNull();
    expect(hitTest(targets, 2, 10)).toBeNull();
    expect(hitTest(targets, 5, 9)).toBeNull();
    expect(hitTest(targets, 5, 11)).toBeNull();
    expect(hitTest(targets, 30, 4)).toBe(box);
    expect(hitTest(targets, 34, 5)).toBe(box);
    expect(hitTest(targets, 35, 5)).toBeNull();
    expect(hitTest(targets, 34, 6)).toBeNull();
    expect(hitTest([], 1, 1)).toBeNull();
  });

  test('where targets overlap, the one drawn last wins', () => {
    const under: Target = { ...box, id: 'under', action: { type: 'clear-log' } };
    expect(hitTest([under, box], 31, 4)).toBe(box);
    expect(hitTest([box, under], 31, 4)).toBe(under);
  });
});

describe('isClick', () => {
  test('a press and release on different targets is not a click', () => {
    expect(isClick(restart, stop, false)).toBe(false);
    expect(isClick(restart, null, false)).toBe(false);
    expect(isClick(null, restart, false)).toBe(false);
    expect(isClick(null, null, false)).toBe(false);
  });

  test('the same target with no drag between is a click, with a drag it is not', () => {
    expect(isClick(restart, restart, false)).toBe(true);
    // The same target recomputed by a new layout is still the same target.
    expect(isClick(restart, { ...restart, rect: { ...restart.rect, row: 11 } }, false)).toBe(true);
    expect(isClick(restart, restart, true)).toBe(false);
  });
});
