import fs from 'node:fs';
import { startedByAgent } from '../agent-detection.js';
import { RELEASE_MESSAGE, currentMode, currentModeSource, isCI } from '../env-base.js';
import { findSession, unresponsiveMessage } from '../find-session.js';
import { startState } from '../relaunch.js';
import { SESSION_ID_ENV } from '../running.js';
import { sessionLogPath } from '../session-files.js';
import { type LaunchedSession, SessionStartError, launchSession, stopChild } from '../stack.js';
import type { StartOptions } from './default.js';
import { removeRecord, stopSession } from './stop.js';

// `stackctl start --detach`: a headless session in a process group of its own, which outlives the
// command. The command waits until the session is ready, as `startStack()` does, prints where it
// is, and exits; on a failure it ends the session and exits 1 with nothing left running.

/** How long to wait for the session to be ready when `--wait-timeout` doesn't say, in seconds. */
export const DEFAULT_DETACH_WAIT_TIMEOUT_S = 300;

/** How much of the session's log a failure prints. */
const LOG_TAIL_LINES = 50;

/** Why `start --detach` is refused here, or `undefined` when it may run. */
export function detachRefusal(
  agent: boolean = startedByAgent(),
  ci: boolean = isCI(startState().env),
): string | undefined {
  if (agent && !ci) {
    return (
      "start --detach is for CI: a session a coding agent detaches outside CI outlives the agent's task and stays running. " +
      'Run stackctl --headless in your own background task instead, then stackctl wait, or startStack(), so the session ends with you. ' +
      '(Not an agent? Set STACKCTL_STARTED_BY_AGENT=0.)'
    );
  }
  return undefined;
}

/** The last `count` lines of `file`, or `''` when it can't be read. */
function lastLines(file: string | null, count: number): string {
  if (file === null) {
    return '';
  }
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-count).join('\n');
  } catch {
    return '';
  }
}

/** Runs `start --detach`; ends by exiting the process. */
export async function runDetach(opts: StartOptions): Promise<never> {
  const root = process.cwd();
  const mode = currentMode();
  const source = currentModeSource();

  // Said here, where the caller sees it, rather than by the session, whose output is a file.
  if (!opts.killOthers) {
    const found = await findSession({ workspaceDir: root, mode });
    if (found.kind === 'running') {
      console.error(
        `stackctl: a ${mode} session of this workspace is already running (pid ${String(found.status.pid)}); ` +
          `stop it (stackctl --mode ${mode} stop), or pass --kill-others to have it quit first`,
      );
      process.exit(1);
    }
    if (found.kind === 'unresponsive') {
      console.error(`stackctl: ${unresponsiveMessage(found, mode)}; stop it, or pass --kill-others to have it killed`); // oxfmt-ignore
      process.exit(1);
    }
  }

  // The session resolves its mode as this invocation did: from the environment the command was
  // started with, and `--mode` only when it was given.
  const start = startState();
  const args = [
    ...(source === 'flag' ? ['--mode', mode] : []),
    '--workspace-dir',
    root,
    'start',
    '--headless',
    ...opts.service.flatMap((name) => ['-s', name]),
    ...(opts.lastAnswers ? ['--last-answers'] : []),
    ...(opts.killOthers ? ['--kill-others'] : []),
  ];
  // The id the session takes, handed to it, so its log is known before it says where it is.
  const id = String(Date.now());
  const sessionLog = sessionLogPath(root, mode, id);

  // Ctrl+C, or a SIGTERM, while waiting fails the start: the session is ended like any failure.
  const controller = new AbortController();
  let interruptedBy: NodeJS.Signals | undefined;

  /**
   * Reports a start that failed, its session ended, and exits: the error, the log's path and its
   * last lines (or the session's own output, with no log yet), with the record removed.
   */
  function failed(
    reason: string,
    { pid, logFile: knownLog, outputTail }: { pid: number | undefined; logFile: string | null; outputTail: string }, // oxfmt-ignore
  ): never {
    console.error(`stackctl: start --detach failed: ${reason}`);
    // A session that failed before it said where its log is has one all the same, once it got as
    // far as writing to it: in the folder of the id it was handed.
    const logFile = knownLog ?? (fs.existsSync(sessionLog) ? sessionLog : null);
    // Ended gracefully, the session removed its record; killed first, it couldn't.
    if (pid !== undefined) {
      removeRecord(root, mode, pid);
    }
    if (logFile !== null) {
      console.error(`log: ${logFile}`);
    }
    const tail = lastLines(logFile, LOG_TAIL_LINES) || outputTail;
    if (tail) {
      console.error(tail);
    }
    process.exit(interruptedBy === 'SIGTERM' ? 143 : interruptedBy === 'SIGINT' ? 130 : 1);
  }

  const onSignal = (signal: NodeJS.Signals) => {
    interruptedBy ??= signal;
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let launched: LaunchedSession;
  try {
    launched = await launchSession({
      args,
      cwd: start.cwd,
      env: { ...start.env, [SESSION_ID_ENV]: id },
      waitTimeout: opts.waitTimeout ?? DEFAULT_DETACH_WAIT_TIMEOUT_S,
      detached: true,
      outputTailLines: LOG_TAIL_LINES,
      signal: controller.signal,
      // As `stop` ends a session: the quit, then the kill of its process tree, with what that
      // leaves swept; then signals, should the session still not be gone.
      end: async ({ child, exited, gone, started }) => {
        await stopSession(root, mode);
        await stopChild(child, exited, gone);
        removeRecord(root, mode, started.pid);
      },
    });
  } catch (error) {
    if (!(error instanceof SessionStartError)) {
      throw error;
    }
    failed(error.reason, error);
  }
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  // The session is on its own from here: told so, then let go of. A session that has exited since
  // has no channel to tell, nor to close.
  const { child, ready } = launched;
  const released =
    child.connected &&
    (await new Promise<boolean>((resolve) => {
      child.send({ type: RELEASE_MESSAGE }, (error: Error | null) => resolve(error === null));
    }));
  if (child.connected) {
    child.disconnect();
  }
  child.unref();
  // Only a session that is still there, as itself, is reported ready.
  // A session gone by now refuses the connection: that's a failure to report, not one to throw.
  const status = released ? await launched.control.query.status().catch(() => null) : null;
  if (!status || status.pid !== ready.pid) {
    await stopSession(root, mode);
    failed('the session ended as it was let go of', {
      pid: ready.pid,
      logFile: ready.logFile,
      outputTail: '',
    });
  }
  console.log(
    `${ready.mode} session ready: pid ${String(ready.pid)}, control API on ${String(ready.port)}, log ${String(ready.logFile)}`,
  );
  process.exit(0);
}
