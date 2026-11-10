import { useEffect, useRef } from 'react';
import type { DOMElement } from 'ink';
import { MOUSE_DISABLE, MOUSE_ENABLE, type MouseReport, createMouseDecoder } from '../mouse.js';
import { type Rect, hitTest, isClick } from './hit-test.js';
import type { Action } from './keymap.js';

/**
 * The run screen's mouse: SGR reporting switched on while the screen is up and off on the way out,
 * re-asserted on every resize and whenever a legacy report shows the terminal dropped it
 * (run-screen §6.1), and every report dispatched: a wheel notch, a click on a target (a press and
 * release on the same target with no drag between, §6.6.2), or a press, drag and release that goes
 * to the log's drag selection.
 */

export type PointerReport = Extract<MouseReport, { type: 'down' | 'move' | 'up' }>;

/** A clickable area in 1-based screen cells: dispatches `action`, or runs `press` (a toast button). */
export interface ClickTarget {
  id: string;
  rect: Rect;
  action?: Action;
  press?: () => void;
}

export interface MouseHandlers {
  /** The targets as laid out now, last drawn last (`hitTest` is last-wins). Read on a press. */
  targets(): readonly ClickTarget[];
  /** A click on `target`, or on no target (a press and release on nothing, with no drag). */
  onClick(target: ClickTarget | null): void;
  onWheel(dir: 'up' | 'down'): void;
  /** A press on no target, and its drag and release: the log's drag selection. */
  onPointer(report: PointerReport): void;
  /** A handler threw; the screen stays up. */
  onError(err: unknown): void;
}

/**
 * An Ink element's screen area, 1-based, widened by `slack` cells on each side; `null` before it
 * has been laid out. For the targets the pure layout doesn't place: toast buttons, the jump row.
 */
export function elementRect(node: DOMElement, slack = 0): Rect | null {
  let col = 0;
  let row = 0;
  for (let n: DOMElement | undefined = node; n; n = n.parentNode) {
    if (!n.yogaNode) {
      return null;
    }
    col += n.yogaNode.getComputedLeft();
    row += n.yogaNode.getComputedTop();
  }
  const width = node.yogaNode!.getComputedWidth();
  const height = node.yogaNode!.getComputedHeight();
  return { col: col + 1 - slack, row: row + 1, width: width + 2 * slack, height };
}

interface Press {
  target: ClickTarget | null;
  moved: boolean;
}

/**
 * Turns reports into the handlers' calls (run-screen §6.2, §6.6.2). A press on a target is a
 * click when its release lands on the same target with no drag between, and it never reaches the
 * drag selection. A press on no target goes to the drag selection, release included; with no drag
 * it is also a click on nothing, which disarms a confirmation and closes the menu. Only the left
 * button acts.
 */
export function createReportHandler(handlers: () => MouseHandlers): (report: MouseReport) => void {
  let press: Press | null = null;
  const at = (report: MouseReport) => hitTest(handlers().targets(), report.col, report.row);
  return (report) => {
    const h = handlers();
    if (report.type === 'wheel') {
      h.onWheel(report.dir);
      return;
    }
    if (report.button !== 0) {
      return;
    }
    switch (report.type) {
      case 'down': {
        const target = at(report);
        press = { target, moved: false };
        if (!target) {
          h.onPointer(report);
        }
        return;
      }
      case 'move':
        if (press) {
          press.moved = true;
          if (!press.target) {
            h.onPointer(report);
          }
        }
        return;
      case 'up': {
        const p = press;
        press = null;
        if (!p) {
          return;
        }
        if (p.target) {
          if (isClick(p.target, at(report), p.moved)) {
            h.onClick(p.target);
          }
          return;
        }
        h.onPointer(report);
        if (!p.moved) {
          h.onClick(null);
        }
        return;
      }
    }
  };
}

/**
 * Takes the mouse while `enabled`. Returns `dropKey()`, which the keyboard handler calls first:
 * `true` means the key event is a legacy report's coordinate bytes and must be dropped whole, so
 * it can't type into the filter or the custom command.
 */
export function useMouse(
  enabled: boolean,
  io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream },
  handlers: MouseHandlers,
): { dropKey(): boolean } {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const dropNext = useRef(false);
  const { stdin, stdout } = io;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const decode = createMouseDecoder();
    const handle = createReportHandler(() => handlersRef.current);

    const onData = (chunk: Buffer | string) => {
      const { reports, legacy } = decode(String(chunk));
      if (legacy) {
        stdout.write(MOUSE_ENABLE);
        dropNext.current = true;
      }
      for (const report of reports) {
        try {
          handle(report);
        } catch (err) {
          handlersRef.current.onError(err);
        }
      }
    };
    // A terminal reattached to a fresh emulator restores mouse modes that can lack the SGR
    // encoding; a reattach always re-measures, so the resize heals it.
    const reassert = () => stdout.write(MOUSE_ENABLE);

    stdout.write(MOUSE_ENABLE);
    stdin.on('data', onData);
    stdout.on('resize', reassert);
    return () => {
      stdin.off('data', onData);
      stdout.off('resize', reassert);
      stdout.write(MOUSE_DISABLE);
      if (stdin.listenerCount('readable') === 0) {
        stdin.pause();
      }
    };
  }, [enabled, stdin, stdout]);

  return {
    dropKey: () => {
      const drop = dropNext.current;
      dropNext.current = false;
      return drop;
    },
  };
}
