import React from 'react';
import { Text } from 'ink';
import type { Session, SessionSnapshot } from '../session/session.js';
import { logError } from './actions.js';
import {
  type FooterLayout,
  type FooterOptions,
  type MenuLayout,
  type MenuOptions,
  footerLayout,
  menuLayout,
} from './layout.js';
import type { UiState } from './ui-state.js';

/**
 * The footer's and the menu's guard (run-screen §11.3): a fault while laying them out or drawing
 * them is logged as a `[stackctl]` error line, and the footer draws as one dim line instead. The
 * log pane and the keys keep working, so Ctrl+C still quits.
 */

const FAILED = 'footer failed to render; see the log';

/** One dim row, no targets, no entries: what the footer shows when it can't be laid out. */
const FAILED_LAYOUT: FooterLayout = {
  rows: [[{ text: FAILED, dim: true }]],
  height: 1,
  keysRow: 1,
  targets: [],
  rects: [],
  entries: [],
};

/**
 * Each session's last layout fault per guard (footer, menu), so one that persists is logged once,
 * not per layout, even while both guards fault at once.
 */
const lastFault = new WeakMap<Session, Map<string, string>>();

function logFault(session: Session, what: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  let faults = lastFault.get(session);
  if (!faults) {
    faults = new Map();
    lastFault.set(session, faults);
  }
  if (faults.get(what) !== message) {
    faults.set(what, message);
    logError(session, what, err);
  }
}

/** `footerLayout`, or the one-line fallback when it throws. */
export function guardedFooterLayout(
  session: Session,
  snapshot: SessionSnapshot,
  ui: UiState,
  cols: number,
  opts: FooterOptions,
): FooterLayout {
  try {
    return footerLayout(snapshot, ui, cols, opts);
  } catch (err) {
    logFault(session, 'lay out the footer', err);
    return FAILED_LAYOUT;
  }
}

/** `menuLayout`, or no menu when it throws. */
export function guardedMenuLayout(
  session: Session,
  snapshot: SessionSnapshot,
  ui: UiState,
  cols: number,
  opts: MenuOptions,
): MenuLayout | null {
  try {
    return menuLayout(snapshot, ui, cols, opts);
  } catch (err) {
    logFault(session, 'lay out the commands menu', err);
    return null;
  }
}

interface Props {
  session: Session;
  /** A new layout tries the footer again. */
  layout: FooterLayout;
  children: React.ReactNode;
}

interface State {
  failed: boolean;
  /** The layout the failure happened on; a new one tries the footer again. */
  layout: FooterLayout;
}

export class FooterBoundary extends React.Component<Props, State> {
  override state: State = { failed: false, layout: this.props.layout };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.layout === state.layout ? null : { failed: false, layout: props.layout };
  }

  override componentDidCatch(err: unknown): void {
    logError(this.props.session, 'render the footer', err);
  }

  override render(): React.ReactNode {
    return this.state.failed ? <Text dimColor>{FAILED}</Text> : this.props.children;
  }
}
