import type { DOMElement } from 'ink';
import { describe, expect, test } from 'vitest';
import type { ToastTarget } from '../components/ToastStack.js';
import { hitTest } from './hit-test.js';
import type { FooterLayout, MenuLayout } from './layout.js';
import { screenTargets } from './screen-targets.js';

const node = (name: string) => ({ name }) as unknown as DOMElement;
const JUMP = node('jump');
const RESET_BUTTON = node('reset');
const OTHER_BUTTON = node('other');

/** Where each element sits, as `elementRect` (with its slack) would say. */
const RECTS = new Map([
  [JUMP, { col: 40, row: 50, width: 12, height: 1 }],
  [RESET_BUTTON, { col: 100, row: 49, width: 9, height: 1 }],
  [OTHER_BUTTON, { col: 100, row: 48, width: 8, height: 1 }],
]);
const rectOf = (n: DOMElement) => RECTS.get(n) ?? null;

const footer = {
  height: 4,
  targets: [
    { id: 'entry:app:api', rect: { col: 2, row: 1, width: 10, height: 1 }, action: { type: 'focus-index', index: 0 } }, // oxfmt-ignore
    { id: 'hint:keys:^c quit', rect: { col: 80, row: 3, width: 7, height: 1 }, action: { type: 'quit' } }, // oxfmt-ignore
  ],
} as unknown as FooterLayout;

const menu = {
  targets: [
    { id: 'menu:box', rect: { col: 2, row: -5, width: 30, height: 5 }, action: { type: 'custom-input', text: '' } }, // oxfmt-ignore
    { id: 'menu:row:0', rect: { col: 3, row: -4, width: 28, height: 1 }, action: { type: 'run-command', row: 0 } }, // oxfmt-ignore
  ],
} as unknown as MenuLayout;

const toast = (toastId: number, index: number, n: DOMElement, press = () => {}): ToastTarget => ({
  toastId,
  index,
  node: n,
  press,
});

describe('screenTargets', () => {
  test("footer and menu rows are moved to the screen, the rule line on the footer's first row", () => {
    const targets = screenTargets({ footer, menu, rows: 61, jump: null, toasts: [], reset: null }, rectOf); // oxfmt-ignore
    expect(targets.map((t) => [t.id, t.rect.row])).toEqual([
      ['entry:app:api', 59],
      ['hint:keys:^c quit', 61],
      ['menu:box', 53],
      ['menu:row:0', 54],
    ]);
  });

  test('the jump row and the toast buttons come between the footer and the menu', () => {
    const press = () => {};
    const targets = screenTargets(
      {
        footer,
        menu,
        rows: 61,
        jump: JUMP,
        toasts: [toast(7, 0, RESET_BUTTON), toast(8, 0, OTHER_BUTTON, press)],
        reset: { id: 7, target: 'db' },
      },
      rectOf,
    );
    expect(targets.map((t) => t.id)).toEqual([
      'entry:app:api',
      'hint:keys:^c quit',
      'jump-to-latest',
      'toast:7:0',
      'toast:8:0',
      'menu:box',
      'menu:row:0',
    ]);
    expect(hitTest(targets, 45, 50)?.action).toEqual({ type: 'scroll-newest' });
    // The armed reset's button confirms through the reducer, naming its entry; any other toast
    // button runs its own press.
    expect(hitTest(targets, 101, 49)).toMatchObject({ action: { type: 'reset-infra', target: 'db' } }); // oxfmt-ignore
    expect(hitTest(targets, 101, 49)?.press).toBeUndefined();
    expect(hitTest(targets, 101, 48)).toMatchObject({ press });
  });

  test('an element not laid out yet is no target, and with no reset armed a button only presses', () => {
    const targets = screenTargets(
      { footer, menu: null, rows: 61, jump: node('unplaced'), toasts: [toast(7, 0, RESET_BUTTON)], reset: null }, // oxfmt-ignore
      rectOf,
    );
    expect(targets.map((t) => t.id)).toEqual(['entry:app:api', 'hint:keys:^c quit', 'toast:7:0']);
    expect(targets[2]!.action).toBeUndefined();
  });
});
