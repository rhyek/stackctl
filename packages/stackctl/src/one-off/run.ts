import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { execa } from 'execa';
import { logTimestamp, stripAnsi } from '../format.js';
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

/**
 * Runs `spec` to completion and resolves with how it ended. stdin is inherited, so the command
 * stays interactive. With `stdio: 'inherit'` its output streams to this process's stdout and
 * stderr raw (colors intact); with `'pipe'` it is collected into the result instead. Either way it
 * is teed to a fresh log file in `logDir` (default: the mode's log directory) — line-buffered,
 * timestamped and ANSI-stripped, as a session logs. SIGTERM and SIGHUP sent to this process are
 * forwarded to the command while it runs, and so is SIGINT, unless the command shares this
 * process's terminal; the listeners are removed once no command runs. Never exits the process.
 * Rejects with a {@link CommandStartError} when the command can't start.
 */
export async function runOneOff(
  spec: OneOffSpec,
  opts: {
    stdio: 'inherit' | 'pipe';
    logDir?: string;
    /** Whether stdin is a terminal; a seam for tests. Default: `process.stdin.isTTY`. */
    isTerminal?: () => boolean;
  },
): Promise<OneOffResult> {
  const logFile = getDefaultLogFile(opts.logDir);
  let logFd: number | undefined;
  let tracked: LiveChild | undefined;
  try {
    const fd = fs.openSync(logFile, 'w');
    logFd = fd;
    const collected = { stdout: '', stderr: '' };
    // Tee one child stream: to the terminal or the result, then line-buffered timestamped and
    // stripped lines to the logfile. One decoder per stream, so a character split across chunks
    // stays whole. Returns a flush for what is left once the stream ends.
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
          fs.writeSync(fd, `${logTimestamp()} ${stripAnsi(buf.slice(0, nl))}\n`);
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
          fs.writeSync(fd, `${logTimestamp()} ${stripAnsi(buf)}\n`);
          buf = '';
        }
      };
    };

    const child = execa(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      extendEnv: false,
      stdin: 'inherit',
      stdout: 'pipe',
      stderr: 'pipe',
      buffer: false,
      reject: false,
      // execa's own cleanup answers a signal to this process by sending the command SIGTERM,
      // ahead of the signal forwarded here. Only an exit while the command runs ends it, here.
      cleanup: false,
    });
    tracked = {
      kill: (signal) => void child.kill(signal),
      sharesTerminal:
        opts.stdio === 'inherit' && (opts.isTerminal ?? (() => process.stdin.isTTY))(),
    };
    track(tracked);
    const flushOut = tee(child.stdout, 'stdout');
    const flushErr = tee(child.stderr, 'stderr');
    const result = await child;
    flushOut();
    flushErr();
    if (result.exitCode === undefined && result.signal === undefined) {
      throw new CommandStartError(result.shortMessage);
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
