import type { DOMElement } from 'ink';
import type { ToastTarget } from '../components/ToastStack.js';
import type { Rect, Target } from './hit-test.js';
import type { FooterLayout, MenuLayout } from './layout.js';
import { type ClickTarget, elementRect } from './use-mouse.js';

/**
 * Every click target on the run screen, in screen cells, drawn-last last (`hitTest` is last-wins):
 * the footer's, then the jump row's `Click here` and the toast buttons (found through their
 * elements, with one cell of slack each side), then the commands menu's. Pure but for reading the
 * laid-out elements' positions, which `rectOf` does.
 */
export interface ScreenTargetsInput {
  footer: FooterLayout;
  menu: MenuLayout | null;
  /** The screen's rows; the footer's last row is the screen's last. */
  rows: number;
  /** `Click here` in the jump row, while it is drawn. */
  jump: DOMElement | null;
  toasts: Iterable<ToastTarget>;
  /** The armed reset's toast: its `[reset]` confirms through the reducer, naming its entry. */
  reset: { id: number; target: string } | null;
}

/** One cell of slack on each side, as the copy icon has (run-screen §6.6.3). */
const SLACK = 1;

/** Footer and menu targets, from footer-relative rows (0 = the rule line) to screen rows. */
function onScreen(targets: readonly Target[], ruleRow: number): ClickTarget[] {
  return targets.map((t) => ({ ...t, rect: { ...t.rect, row: ruleRow + t.rect.row } }));
}

export function screenTargets(
  input: ScreenTargetsInput,
  rectOf: (node: DOMElement) => Rect | null = (node) => elementRect(node, SLACK),
): ClickTarget[] {
  const ruleRow = input.rows - input.footer.height + 1;
  const targets = onScreen(input.footer.targets, ruleRow);
  const jump = input.jump && rectOf(input.jump);
  if (jump) {
    targets.push({ id: 'jump-to-latest', rect: jump, action: { type: 'scroll-newest' } });
  }
  for (const toast of input.toasts) {
    const rect = rectOf(toast.node);
    if (!rect) {
      continue;
    }
    const id = `toast:${String(toast.toastId)}:${String(toast.index)}`;
    if (input.reset?.id === toast.toastId) {
      targets.push({ id, rect, action: { type: 'reset-infra', target: input.reset.target } });
    } else {
      targets.push({ id, rect, press: toast.press });
    }
  }
  if (input.menu) {
    targets.push(...onScreen(input.menu.targets, ruleRow));
  }
  return targets;
}
