import type { DragSelection, LogViewport } from '../components/LogPane.js';
import type { Toasts } from '../components/ToastStack.js';
import { errorMessage } from '../errors.js';
import type { Session } from '../session/session.js';
import type { Effect, EntryKey } from './ui-state.js';

/**
 * Carries out the reducer's effects against the session and the screen's own parts. Each runs in
 * its own guard: a throw, or a rejection from the session, is logged as a `[stackctl]` error line
 * (`[ERROR] <what> failed: <message>`) and the screen stays up (run-screen §11). An action the
 * session refuses (`busy`, `unavailable`, `closing`) is not an error and does nothing (§11.5).
 */

/** The confirmation toasts on screen, so a disarm takes down the right one. */
export interface ConfirmToasts {
  quit: number | null;
  reset: { id: number; target: string } | null;
}

export interface ActionDeps {
  session: Session;
  toasts: Pick<Toasts, 'notify' | 'dismiss' | 'dismissNewestSticky'>;
  selection: Pick<DragSelection, 'clear' | 'flashCopy'>;
  viewport: Pick<LogViewport, 'scrollPages' | 'scrollToTop' | 'scrollToBottom'>;
  confirmToasts: ConfirmToasts;
  /** Turns mouse reporting off: the shutdown's first step, before the screen collapses. */
  releaseMouse: () => void;
  /** Ends the process at once with `code`, the terminal restored: the second request's exit. */
  hardExit: (code: number) => void;
}

/** How long the filter's applied/cleared toast stays up (run-screen §4.1.3). */
const FILTER_TOAST_MS = 2_000;

/** Logs a fault in a handler of the screen's as a `[stackctl]` error line; never throws. */
export function logError(session: Session, what: string, err: unknown): void {
  try {
    session.systemLog.error(`${what} failed: ${errorMessage(err)}`);
  } catch {
    /* the log is closed; nothing more to do */
  }
}

/** Runs `fn` for `what`, logging a throw or a rejection instead of letting it through. */
export function guard(session: Session, what: string, fn: () => unknown): void {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.catch((err: unknown) => logError(session, what, err));
    }
  } catch (err) {
    logError(session, what, err);
  }
}

function serviceAction(
  session: Session,
  action: 'restart' | 'stop' | 'start',
  entry: EntryKey,
): unknown {
  if (entry.kind === 'app') {
    return session.runPackage(entry.name, action);
  }
  return session.runInfra(entry.name, action);
}

function describe(effect: Effect): string {
  switch (effect.type) {
    case 'restart':
    case 'stop':
    case 'start':
      return `${effect.type} ${effect.entry.name}`;
    case 'reset-infra':
      return `reset ${effect.target}`;
    case 'run-script':
      return `run ${effect.script} for ${effect.service}`;
    case 'run-custom':
      return `run "${effect.command}" for ${effect.service}`;
    case 'clear-log':
      return 'clear the log';
    default:
      return effect.type;
  }
}

function runOne(effect: Effect, deps: ActionDeps): unknown {
  const { session, toasts, selection, viewport, confirmToasts } = deps;
  switch (effect.type) {
    case 'arm':
      if (effect.kind === 'quit') {
        confirmToasts.quit = toasts.notify({
          message: 'Press Ctrl+C again to exit',
          duration: effect.ms,
        });
      } else {
        // The `[reset]` button's click goes through the reducer (the screen's hit target names
        // the entry), so its own press does nothing more than dismiss the toast.
        const id = toasts.notify({
          message: `Reset ${effect.target}? Its data is deleted. Press R again to confirm.`,
          tone: 'warn',
          duration: effect.ms,
          actions: [{ label: 'reset', onPress: () => {} }],
        });
        confirmToasts.reset = { id, target: effect.target };
      }
      return;
    case 'disarm':
      if (effect.kind === 'quit') {
        if (confirmToasts.quit !== null) {
          toasts.dismiss(confirmToasts.quit);
          confirmToasts.quit = null;
        }
      } else if (confirmToasts.reset) {
        toasts.dismiss(confirmToasts.reset.id);
        confirmToasts.reset = null;
      }
      return;
    case 'shutdown':
      if (session.getSnapshot().phase === 'stopping') {
        // The second request: the session kills every group; nothing waits for Ink.
        void session.shutdown('user');
        deps.hardExit(1);
        return;
      }
      deps.releaseMouse();
      return session.shutdown('user');
    case 'restart':
    case 'stop':
    case 'start':
      return serviceAction(session, effect.type, effect.entry);
    case 'reset-infra':
      return session.runInfra(effect.target, 'reset');
    case 'filter':
      session.applyFilter(effect.filter);
      // The rows reflow, so a selection would point at other text.
      selection.clear();
      toasts.notify({
        message: effect.filter === '' ? 'Filter cleared' : 'Filter applied',
        duration: FILTER_TOAST_MS,
      });
      return;
    case 'clear-selection':
      selection.clear();
      return;
    case 'dismiss-sticky-toast':
      toasts.dismissNewestSticky();
      return;
    case 'clear-log':
      selection.clear();
      session.clearLog();
      return;
    case 'scroll':
      switch (effect.to) {
        case 'page-older':
          viewport.scrollPages(1);
          return;
        case 'page-newer':
          viewport.scrollPages(-1);
          return;
        case 'oldest':
          viewport.scrollToTop();
          return;
        case 'newest':
          viewport.scrollToBottom();
          return;
      }
      return;
    case 'run-script':
      return session.runOneOff(effect.service, effect.script);
    case 'run-custom':
      return session.runOneOff(effect.service, { shell: effect.command });
  }
}

/** Carries out `effects` once each, in order. */
export function runEffects(effects: readonly Effect[], deps: ActionDeps): void {
  for (const effect of effects) {
    guard(deps.session, describe(effect), () => runOne(effect, deps));
  }
}
