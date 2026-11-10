import chalk from 'chalk';
import { errorMessage } from '../errors.js';
import { formatDuration } from '../format.js';
import { displayLogFile } from '../log-files.js';
import type { Session } from '../session/session.js';

// How the app shell ends the process once Ink has unmounted, and how it restores the terminal on
// a fatal uncaught error. No Ink here: `App.tsx` wires these in.

/** The part of a session the exit reads and drives. */
export type ExitSession = Pick<Session, 'getSnapshot' | 'shutdown' | 'closed' | 'getLogFile'>;

/** What the exit reads once Ink has unmounted: the session, if one was made, or why not. */
export interface Shell {
  session: ExitSession | null;
  /** Why the session for the picks couldn't be made; `null` when nothing failed. */
  failure: unknown;
}

/** The process, as the exit uses it. */
export interface ExitIo {
  stdout: Pick<NodeJS.WritableStream, 'write'>;
  stderr: Pick<NodeJS.WritableStream, 'write'>;
  exit: (code: number) => void;
  now: () => number;
}

const processIo: ExitIo = {
  stdout: process.stdout,
  stderr: process.stderr,
  exit: (code) => process.exit(code),
  now: () => Date.now(),
};

/** Writes `text`, resolving once it is flushed: a pipe on macOS writes asynchronously. */
function flushed(stream: ExitIo['stdout'], text: string): Promise<void> {
  return new Promise((resolve) => {
    stream.write(text, () => resolve());
  });
}

/** Prints `stackctl: <message>` on stderr, then exits 1 once it is flushed. */
export async function failWith(err: unknown, io: ExitIo = processIo): Promise<void> {
  await flushed(io.stderr, `stackctl: ${errorMessage(err)}\n`);
  io.exit(1);
}

/** Writes `lines` dim, then exits with `code` once they are flushed. */
async function exitWith(lines: string[], code: number, io: ExitIo): Promise<void> {
  await flushed(io.stdout, lines.map((line) => `${chalk.dim(line)}\n`).join(''));
  io.exit(code);
}

/**
 * After Ink has unmounted and left the alternate screen (`crash` is Ink's rejection, `null` when
 * it unmounted cleanly):
 *
 * - from the picker, the exit line alone, 0;
 * - when the session for the picks couldn't be made, or the picker crashed, `stackctl: <message>`
 *   on stderr and 1 (picker §10.3.4);
 * - from the run screen, the session's end, then the exit line and the current logfile, with the
 *   session's code. When Ink went first (a render crash) the error is printed and the code is 1;
 *   the session is shut down here unless it is already stopping, since a second shutdown call
 *   would be the hard kill.
 */
export async function finish(
  shell: Shell,
  crash: unknown,
  startedAt: number,
  io: ExitIo = processIo,
): Promise<void> {
  const exited = () => `■ stackctl exited after ${formatDuration(io.now() - startedAt)}`;
  const { session } = shell;
  if (!session) {
    const failure = crash ?? shell.failure;
    if (failure !== null) {
      await failWith(failure, io);
      return;
    }
    await exitWith([exited()], 0, io);
    return;
  }
  if (crash !== null) {
    await flushed(io.stderr, `stackctl: ${errorMessage(crash)}\n`);
  }
  const stopHere = session.getSnapshot().phase !== 'stopping';
  if (stopHere) {
    void session.shutdown('user');
  }
  const code = await session.closed;
  const logfile = `  logfile: ${displayLogFile(session.getLogFile())}`;
  await exitWith([exited(), logfile], crash !== null || stopHere ? 1 : code, io);
}

/** The process hooks an uncaught exception's fate depends on. */
export type UncaughtHooks = Pick<
  NodeJS.Process,
  'listenerCount' | 'hasUncaughtExceptionCaptureCallback'
>;

/**
 * Whether an uncaught exception is handled by something else (an `uncaughtException` listener,
 * a capture callback), so the process isn't dying of it. The workspace's config runs in process,
 * with whatever it imports: an error reporter's handler keeps stackctl up.
 */
export function uncaughtIsHandled(hooks: UncaughtHooks = process): boolean {
  return (
    hooks.listenerCount('uncaughtException') > 0 || hooks.hasUncaughtExceptionCaptureCallback()
  );
}

/**
 * The `uncaughtExceptionMonitor` listener. On a fatal error it unmounts Ink first, releasing the
 * mouse and leaving the alternate screen, so Node prints the error on the primary screen, then
 * drops the exit hook that would leave it again. An error something else handles leaves the
 * screen alone. Should the unmount throw, the exit hook stays and restores the terminal.
 */
export function crashRestore(
  unmount: () => void,
  removeRestore: () => void,
  isHandled: () => boolean = () => uncaughtIsHandled(),
): () => void {
  return () => {
    if (isHandled()) {
      return;
    }
    try {
      unmount();
      removeRestore();
    } catch {
      /* the exit hook restores the terminal */
    }
  };
}
