import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import tty from 'node:tty';
import { execa } from 'execa';
import { startedByAgent } from '../agent-detection.js';
import { maskSecrets } from '../event-log.js';
import { commandLine, formatDuration, logTimestamp, stripAnsi } from '../format.js';
import { getDefaultLogFile } from '../log-files.js';

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

/** An exit while commands run ends them: execa's own cleanup is off (see {@link runOneOff}). */
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
 * and a last line with how it ended and how long it took. SIGTERM and SIGHUP sent to this process
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
  },
): Promise<OneOffResult> {
  const isTerminal = opts.isTerminal ?? ((fd) => tty.isatty(fd));
  const agent = opts.agent ?? startedByAgent();
  // A terminal is handed over, so the command behaves as it would run bare: a prompt, colors, a
  // watch mode's keys. Never to an agent, whose log then holds everything, as in CI.
  const toTerminal = (fd: OutputFd) => opts.stdio === 'inherit' && !agent && isTerminal(fd);
  const handed = ([1, 2] as const).filter(toTerminal);
  const logFile = getDefaultLogFile(opts.logDir);
  let logFd: number | undefined;
  let tracked: LiveChild | undefined;
  try {
    const fd = fs.openSync(logFile, 'w');
    logFd = fd;
    const log = (text: string) => fs.writeSync(fd, `${logTimestamp()} ${text}\n`);
    const startedAt = Date.now();
    log(`▶ running: ${commandLine(spec.command, maskSecrets(spec.args))} (in ${spec.cwd})`);
    if (handed.length > 0) {
      const names = handed.map((n) => STREAM_NAME[n]).join(' and ');
      log(`${names} went to the terminal, not to this log`);
    }
    const collected = { stdout: '', stderr: '' };
    // Tee one piped child stream: to the terminal or the result, then line-buffered timestamped
    // and stripped lines to the logfile. One decoder per stream, so a character split across
    // chunks stays whole. Returns a flush for what is left once the stream ends.
    const tee = (src: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr'): (() => void) => {
      if (!src) {
        return () => {};
      }
      const decoder = new StringDecoder('utf8');
      let buf = '';
      const take = (text: string) => {
        if (opts.stdio === 'pipe') {
          collected[name] += text;
        }
        buf += text;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          log(stripAnsi(buf.slice(0, nl)));
          buf = buf.slice(nl + 1);
        }
      };
      src.on('data', (chunk: Buffer) => {
        if (opts.stdio === 'inherit') {
          process[name].write(chunk);
        }
        take(decoder.write(chunk));
      });
      return () => {
        take(decoder.end());
        if (buf.length > 0) {
          log(stripAnsi(buf));
          buf = '';
        }
      };
    };

    const child = execa(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      extendEnv: false,
      stdin: 'inherit',
      stdout: toTerminal(1) ? 'inherit' : 'pipe',
      stderr: toTerminal(2) ? 'inherit' : 'pipe',
      buffer: false,
      reject: false,
      // execa's own cleanup answers a signal to this process by sending the command SIGTERM,
      // ahead of the signal forwarded here. Only an exit while the command runs ends it, here.
      cleanup: false,
    });
    tracked = {
      kill: (signal) => void child.kill(signal),
      sharesTerminal: opts.stdio === 'inherit' && isTerminal(0),
    };
    track(tracked);
    const flushOut = tee(child.stdout, 'stdout');
    const flushErr = tee(child.stderr, 'stderr');
    const result = await child;
    flushOut();
    flushErr();
    const took = tookFor(Date.now() - startedAt);
    if (result.exitCode === undefined && result.signal === undefined) {
      const why = result.shortMessage ?? `couldn't start ${spec.command}`;
      log(`✘ couldn't start: ${stripAnsi(why.split('\n')[0]!)}`);
      throw new CommandStartError(why);
    }
    if (result.signal) {
      log(`✘ ended by ${result.signal} after ${took}`);
    } else if (result.exitCode === 0) {
      log(`✔ finished in ${took}`);
    } else {
      log(`✘ exited with code ${String(result.exitCode)} after ${took}`);
    }
    return {
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
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
