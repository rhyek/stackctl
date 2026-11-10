import type { Action } from './keymap.js';

/**
 * Click targets: each selectable thing's screen area and what a click on it dispatches. Pure,
 * over the laid-out rectangles, in the 1-based cell coordinates SGR mouse reports use.
 */

/** A screen area: its top-left cell (1-based) and its size in cells. */
export interface Rect {
  col: number;
  row: number;
  width: number;
  height: number;
}

export interface Target {
  /** Stable across layouts for the same thing, so a press and its release can be compared. */
  id: string;
  rect: Rect;
  action: Action;
}

function contains(rect: Rect, col: number, row: number): boolean {
  return (
    col >= rect.col &&
    col < rect.col + rect.width &&
    row >= rect.row &&
    row < rect.row + rect.height
  );
}

/**
 * The target under the cell, or `null` in a gap. Where targets overlap, the last one wins: it is
 * the one drawn on top (the floating menu over the log, say).
 */
export function hitTest<T extends { rect: Rect }>(
  targets: readonly T[],
  col: number,
  row: number,
): T | null {
  for (let i = targets.length - 1; i >= 0; i--) {
    if (contains(targets[i]!.rect, col, row)) {
      return targets[i]!;
    }
  }
  return null;
}

/**
 * Whether a press and its release make a click: both on the same target, with no drag report
 * between them (run-screen §6.6.2). A press and release on no target with no drag (in the log
 * pane, say) is not a target's click, but it still disarms a confirmation: the screen dispatches
 * it to the reducer with no action.
 */
export function isClick<T extends { id: string }>(
  press: T | null,
  release: T | null,
  moved: boolean,
): boolean {
  return !moved && press !== null && release !== null && press.id === release.id;
}
