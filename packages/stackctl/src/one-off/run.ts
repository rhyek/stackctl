import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import tty from 'node:tty';
import { startedByAgent } from '../agent-detection.js';
import { NESTED_ENV_VAR, isNested } from '../env-base.js';
import { maskSecrets } from '../event-log.js';
import { commandLine, formatDuration, logTimestamp, stripAnsi } from '../format.js';
import { getDefaultLogFile } from '../log-files.js';
import { forEachLine, spawnCommand, startFailure } from '../spawn.js';

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
const FORWARDED: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

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
  FORWARDED.map((signal) => [
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

/** How long a one-off command ran, for its log's last line. */
function tookFor(ms: number): string {
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
  },
): Promise<OneOffResult> {
  const isTerminal = opts.isTerminal ?? ((fd) => tty.isatty(fd));
  const agent = opts.agent ?? startedByAgent();
  // Inside a command stackctl runs (a dev script's `sctl exec -- node --watch …`), that command
  // already logs the output and hands over its terminal: this one passes its streams straight
  // through, and writes no log.
  const nested = opts.nested ?? isNested();
  // A terminal is handed over, so the command behaves as it would run bare: a prompt, colors, a
  // watch mode's keys. Never to an agent, whose log then holds everything, as in CI.
  const toTerminal = (fd: OutputFd) =>
    opts.stdio === 'inherit' && (nested || (!agent && isTerminal(fd)));
  const handed = ([1, 2] as const).filter(toTerminal);
  let logFd: number | undefined;
  let tracked: LiveChild | undefined;
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
      if (opts.stdio === 'inherit') {
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
      stdio: ['inherit', toTerminal(1) ? 'inherit' : 'pipe', toTerminal(2) ? 'inherit' : 'pipe'],
    });
    tracked = {
      kill: (signal) => void child.kill(signal),
      sharesTerminal: opts.stdio === 'inherit' && isTerminal(0),
    };
    track(tracked);
    tee(child.stdout, 'stdout');
    tee(child.stderr, 'stderr');
    const ended = await child.done;
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
    if (tracked) {
      untrack(tracked);
    }
    if (logFd !== undefined) {
      fs.closeSync(logFd);
    }
  }
}
