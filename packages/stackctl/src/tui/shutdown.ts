import fs from 'node:fs';
import { useEffect } from 'react';
import { useApp } from 'ink';
import { MOUSE_DISABLE } from '../mouse.js';
import type { Session } from '../session/session.js';

/**
 * The screen's part of the one shutdown path (`docs/architecture/exiting.md`; run-screen §9). The
 * session owns the rest: stopping the children, closing the proxy, acknowledging a held quit,
 * closing the control server. Whatever started it (Ctrl+C, a signal, `/command/quit`, a branch
 * change), the screen follows the session's `stopping` phase.
 */

/** Leaves the alternate screen and shows the cursor, with the mouse released first. */
const RESTORE_TERMINAL = `${MOUSE_DISABLE}\x1b[?1049l\x1b[?25h`;

/**
 * Once the session is done, how long Ink's teardown may take before the process exits anyway
 * with the session's code. Normally the exit line prints within milliseconds and this never fires.
 */
export const EXIT_SAFETY_NET_MS = 5_000;

function writeRestore(): void {
  try {
    fs.writeSync(1, RESTORE_TERMINAL);
  } catch {
    /* the terminal is gone */
  }
}

/**
 * Exits at once with `code`, the terminal restored: the mouse released, the alternate screen left
 * and the cursor shown. For the paths Ink doesn't unmount on (the hard kill, the safety net).
 */
export function hardExit(code: number): never {
  writeRestore();
  process.exit(code);
}

/**
 * Restores the terminal should the process exit while the screen is up by any path but Ink's own
 * unmount (an uncaught error, say). Returns the remover, which must run once Ink has left the
 * alternate screen: run after the exit line, leaving it again would move the cursor over it.
 */
export function installTerminalRestore(): () => void {
  process.on('exit', writeRestore);
  return () => {
    process.off('exit', writeRestore);
  };
}

/**
 * Follows the session to its end. When its phase turns `stopping`, the mouse is released at once,
 * before the screen collapses to its shutting-down line (the caller renders that from the
 * snapshot). When it has closed: after a hard kill (a second request) the process exits 1 at
 * once; otherwise Ink unmounts, with the safety net armed, and `renderApp` prints the exit line
 * and exits with the session's code.
 */
export function useShutdown(
  session: Session,
  stdout: NodeJS.WritableStream,
  /** How the process ends without Ink: {@link hardExit} unless given (specs). */
  endProcess: (code: number) => void = hardExit,
): void {
  const { exit } = useApp();
  useEffect(() => {
    let released = false;
    const release = () => {
      if (!released && session.getSnapshot().phase === 'stopping') {
        released = true;
        stdout.write(MOUSE_DISABLE);
      }
    };
    const unsubscribe = session.subscribe(release);
    let live = true;
    void session.closed.then((code) => {
      if (!live) {
        return;
      }
      if (session.hardKilled) {
        endProcess(1);
        return;
      }
      setTimeout(() => endProcess(code), EXIT_SAFETY_NET_MS);
      exit();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [session, stdout, exit, endProcess]);
}
