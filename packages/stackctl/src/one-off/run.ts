import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import tty from 'node:tty';
import { startedByAgent } from '../agent-detection';
import { NESTED_ENV_VAR, isNested } from '../env-base';
import { maskSecrets } from '../event-log';
import { commandLine, formatDuration, logTimestamp, stripAnsi } from '../format';
import { getDefaultLogFile } from '../log-files';
import { SHUTDOWN_GRACE_MS } from '../shutdown-timing';
import { forEachLine, spawnCommand, startFailure } from '../spawn';

// Running a one-off command, once it is resolved: shared by the CLI's `exec`/`run` and the SDK's
// `exec()`/`run()`, which resolve it differently (in-process, or in a child CLI).

/** A resolved one-off command: what runs, where, and with exactly which environment. */
export interface OneOffSpec {
  /** The working directory: the target's. */
  cwd: string;
  /** The program. */
  command: string;
  /** Its arguments. */
  args: string[];
  /** The command's whole environment: nothing else is merged in. */
  env: NodeJS.ProcessEnv;
}

/** How a one-off command ended. */
export type OneOffResult = {
  /** The exit code, or `null` when a signal ended the command. */
  exitCode: number | null;
  /** The signal that ended the command, or `null` when it exited. */
  signal: NodeJS.Signals | null;
  /** What the command wrote to stdout: only with `stdio: 'pipe'`. */
  stdout?: string;
  /** What the command wrote to stderr: only with `stdio: 'pipe'`. */
  stderr?: string;
};

/** A one-off command that never ran: the program isn't there, say. */
export class CommandStartError extends Error {}

/** Signals sent to this process that reach the command while it runs. */
export const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** A running one-off command, as the signal listeners see it. */
interface LiveChild {
  kill: (signal: NodeJS.Signals) => void;
  /** It shares this process's terminal: a Ctrl-C reached it already. */
  sharesTerminal: boolean;
}

/** Every one-off command running in this process: one set of listeners serves them all. */
const live = new Set<LiveChild>();

// One listener per signal, which knows its own: a listener isn't always told which it was.
const listeners = new Map(
  FORWARDED_SIGNALS.map((signal) => [
    signal,
    () => {
      for (const child of live) {
        // A terminal's Ctrl-C already reached a command in its foreground process group: sent
        // again it would be a second one, which many tools take as "force quit". The listener
        // still keeps this process alive until the command exits.
        if (signal !== 'SIGINT' || !child.sharesTerminal) {
          child.kill(signal);
        }
      }
    },
  ]),
);

/** An exit of this process while commands run ends them. */
const onExit = () => {
  for (const child of live) {
    child.kill('SIGTERM');
  }
};

function track(child: LiveChild): void {
  if (live.size === 0) {
    for (const [signal, listener] of listeners) {
      process.on(signal, listener);
    }
    process.on('exit', onExit);
  }
  live.add(child);
}

function untrack(child: LiveChild): void {
  if (!live.delete(child) || live.size > 0) {
    return;
  }
  for (const [signal, listener] of listeners) {
    process.off(signal, listener);
  }
  process.off('exit', onExit);
}

/** A stream stackctl may hand to the command: stdout (1) or stderr (2). */
type OutputFd = 1 | 2;

const STREAM_NAME = { 1: 'stdout', 2: 'stderr' } as const;

/**
 * The many form's default grace, from SIGTERM to SIGKILL. Strictly under a session's
 * {@link SHUTDOWN_GRACE_MS}: inside a service a session is stopping, the commands, each in a
 * group of its own, must be gone before the session's SIGKILL reaches the stackctl that started
 * them, which then can't end them any more.
 */
export const MANY_GRACE_MS = SHUTDOWN_GRACE_MS / 2;

/** How long a one-off command ran, for its log's last line and the many form's summary. */
export function tookFor(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} seconds` : formatDuration(ms);
}

/**
 * Runs `spec` to completion and resolves with how it ended. stdin is inherited, so the command
 * stays interactive. With `stdio: 'pipe'` its output is collected into the result. With
 * `'inherit'` each of stdout and stderr that is a terminal is handed to the command as it is, so
 * the command sees a terminal there, as it would run bare; one that isn't (a pipe, a file), or any
 * stream when a coding agent started this process, is piped and copied to this process's own.
 * A log file in `logDir` (a session's `commands/` folder) records every run: a first line with the
 * command (secrets masked) and its directory, what was piped (line-buffered, timestamped and
 * ANSI-stripped, as a session logs), a line for each stream that went to the terminal instead,
 * and a last line with how it ended and how long it took. Inside a command stackctl runs
 * ({@link isNested}), which logs the output already, the streams go straight through and no log is
 * written; outside one, the command gets {@link NESTED_ENV_VAR}, so an `exec` or `run` it starts
 * does the same. SIGTERM and SIGHUP sent to this process
 * are forwarded to the command while it runs, and so is SIGINT, unless the command shares this
 * process's terminal; the listeners are removed once no command runs. Never exits the process.
 * Rejects with a {@link CommandStartError} when the command can't start.
 *
 * With `many`, one of several commands run at once: stdin is closed, stdout and stderr are always
 * piped (and with `'inherit'` each line goes to `onLine`, when given), the log is as above, and
 * the command leads a process group of its own, which every signal is sent to, the forwarded ones
 * included (SIGINT too: the terminal's Ctrl-C doesn't reach that group). Aborting `stop` sends
 * the group SIGTERM, then SIGKILL after `graceMs`; a `stop` aborted already does so as soon as
 * the command has started. A forwarded signal is followed by the same SIGKILL, one per command,
 * timed from the first of the two. Once a command that either reached has ended, whatever it
 * left in its group is sent SIGKILL at once; a command that ended by itself leaves its group be.
 */
export async function runOneOff(
  spec: OneOffSpec,
  opts: {
    stdio: 'inherit' | 'pipe';
    logDir: string;
    /** Whether file descriptor `fd` is a terminal; a seam for tests. Default: `tty.isatty`. */
    isTerminal?: (fd: 0 | OutputFd) => boolean;
    /** Whether a coding agent started this process; a seam for tests. Default: {@link startedByAgent}. */
    agent?: boolean;
    /** Whether this runs inside a command stackctl runs; a seam for tests. Default: {@link isNested}. */
    nested?: boolean;
    /**
     * The many form: stdin closed, stdout and stderr piped whatever they are (nested too), the
     * command in a process group of its own, which `stop` ends.
     */
    many?: {
      /** With `stdio: 'inherit'`: each output line, in place of writing it. */
      onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
      /** Aborted: SIGTERM to the group, SIGKILL after `graceMs`. */
      stop: AbortSignal;
      /** Default: `MANY_GRACE_MS`. */
      graceMs?: number;
      /**
       * Called once, the first time a signal, from `stop` or forwarded, is sent to the command
       * while it still runs: what ends it then is stackctl's doing.
       */
      onStopSent?: () => void;
    };
  },
): Promise<OneOffResult> {
  const { many } = opts;
  const isTerminal = opts.isTerminal ?? ((fd) => tty.isatty(fd));
  const agent = opts.agent ?? startedByAgent();
  // Inside a command stackctl runs (a dev script's `sctl exec -- node --watch …`), that command
  // already logs the output and hands over its terminal: this one passes its streams straight
  // through, and writes no log.
  const nested = opts.nested ?? isNested();
  // A terminal is handed over, so the command behaves as it would run bare: a prompt, colors, a
  // watch mode's keys. Never to an agent, whose log then holds everything, as in CI. Never in the
  // many form, whose commands share this process's streams line by line.
  const toTerminal = (fd: OutputFd) =>
    !many && opts.stdio === 'inherit' && (nested || (!agent && isTerminal(fd)));
  const handed = ([1, 2] as const).filter(toTerminal);
  let logFd: number | undefined;
  let tracked: LiveChild | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  let onStop: (() => void) | undefined;
  try {
    const fd = nested ? undefined : fs.openSync(getDefaultLogFile(opts.logDir), 'w');
    logFd = fd;
    const log = (text: string) => {
      if (fd !== undefined) {
        fs.writeSync(fd, `${logTimestamp()} ${text}\n`);
      }
    };
    const startedAt = Date.now();
    log(`▶ running: ${commandLine(spec.command, maskSecrets(spec.args))} (in ${spec.cwd})`);
    if (handed.length > 0) {
      const names = handed.map((n) => STREAM_NAME[n]).join(' and ');
      log(`${names} went to the terminal, not to this log`);
    }
    const collected = { stdout: '', stderr: '' };
    // Tee one piped child stream: as it is to the terminal, or into the result, and its lines,
    // timestamped and stripped, to the log.
    const tee = (src: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr') => {
      if (!src) {
        return;
      }
      if (opts.stdio === 'inherit' && many?.onLine) {
        const onLine = many.onLine;
        forEachLine(src, (line) => onLine(name, line));
      } else if (opts.stdio === 'inherit') {
        src.on('data', (chunk: Buffer) => process[name].write(chunk));
      } else {
        const decoder = new StringDecoder('utf8');
        src.on('data', (chunk: Buffer) => (collected[name] += decoder.write(chunk)));
        src.on('end', () => (collected[name] += decoder.end()));
      }
      forEachLine(src, (line) => log(stripAnsi(line)));
    };

    const child = spawnCommand(spec.command, spec.args, {
      cwd: spec.cwd,
      // An `exec` or `run` the command starts is part of it, as this one is of its own.
      env: nested ? spec.env : { ...spec.env, [NESTED_ENV_VAR]: '1' },
      stdio: many
        ? ['ignore', 'pipe', 'pipe']
        : ['inherit', toTerminal(1) ? 'inherit' : 'pipe', toTerminal(2) ? 'inherit' : 'pipe'],
      // The many form's command leads a process group of its own, so a stop reaches what it runs.
      detached: many !== undefined,
    });
    let leaderExited = false;
    let stopSent = false;
    if (many) {
      child.once('exit', () => (leaderExited = true));
    }
    // The many form signals the command's whole group: the group outlives its leader while a
    // process it started runs on, and keeps its id from being reused until then. Where it can't
    // be signalled (no groups, on Windows), the command alone is, while it runs.
    const kill = many
      ? (signal: NodeJS.Signals) => {
          if (child.pid === undefined) {
            return;
          }
          if (!leaderExited && !stopSent) {
            stopSent = true;
            many.onStopSent?.();
          }
          try {
            process.kill(-child.pid, signal);
          } catch {
            if (!leaderExited) {
              try {
                process.kill(child.pid, signal);
              } catch {
                /* exited already */
              }
            }
          }
        }
      : (signal: NodeJS.Signals) => void child.kill(signal);
    // The many form's SIGKILL: one timer per command, armed by whichever comes first, a stop or a
    // forwarded signal; a later one neither restarts nor duplicates it.
    const graceMs = many?.graceMs ?? MANY_GRACE_MS;
    const escalate = () => {
      graceTimer ??= setTimeout(() => kill('SIGKILL'), graceMs);
    };
    tracked = {
      // A forwarded signal is followed by SIGKILL too in the many form: inside a service a
      // session stops, it is all this command is told, and the session's SIGKILL reaches this
      // process, not the command's group.
      kill: many
        ? (signal) => {
            kill(signal);
            escalate();
          }
        : kill,
      // A command in a group of its own doesn't get the terminal's Ctrl-C: it is forwarded.
      sharesTerminal: !many && opts.stdio === 'inherit' && isTerminal(0),
    };
    track(tracked);
    tee(child.stdout, 'stdout');
    tee(child.stderr, 'stderr');
    if (many) {
      onStop = () => {
        kill('SIGTERM');
        escalate();
      };
      // A stop aborted already ends the command as soon as it has started.
      if (many.stop.aborted) {
        onStop();
      } else {
        many.stop.addEventListener('abort', onStop, { once: true });
      }
    }
    const ended = await child.done;
    // The many form's sweep, once a signal was sent to the command: whatever survived it in the
    // command's group (a background job that ignores it, holding none of the command's pipes)
    // is killed now, since the grace timer is cleared below. A command that ended by itself is
    // left alone: a script may leave a process running on purpose. This rests on one
    // assumption: a group's id can't be reused while a member of the group is alive, so the
    // group signalled here is still the command's whenever anyone is left in it. When the group
    // is empty already, the signal finds nothing (ESRCH); the only exposure is the leader's pid
    // reused as an unrelated group's leader in the gap between its reaping and this call.
    if (many && child.pid !== undefined && (stopSent || graceTimer !== undefined)) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* the group is empty already */
      }
    }
    const took = tookFor(Date.now() - startedAt);
    if (ended.error) {
      const why = `couldn't start ${spec.command}: ${startFailure(ended.error, spec.cwd)}`;
      log(`✘ ${why}`);
      throw new CommandStartError(why);
    }
    if (ended.signal) {
      log(`✘ ended by ${ended.signal} after ${took}`);
    } else if (ended.exitCode === 0) {
      log(`✔ finished in ${took}`);
    } else {
      log(`✘ exited with code ${String(ended.exitCode)} after ${took}`);
    }
    return {
      exitCode: ended.exitCode,
      signal: ended.signal,
      ...(opts.stdio === 'pipe' ? collected : {}),
    };
  } finally {
    clearTimeout(graceTimer);
    if (onStop) {
      many?.stop.removeEventListener('abort', onStop);
    }
    if (tracked) {
      untrack(tracked);
    }
    if (logFd !== undefined) {
      fs.closeSync(logFd);
    }
  }
}
