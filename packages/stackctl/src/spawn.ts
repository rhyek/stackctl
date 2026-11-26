import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

// How stackctl runs a command: Node's own `spawn`, with a `done` promise on the child it returns.
// `spawnCommand` is the base; `runCommand` adds what most callers want on top (stdin closed or fed,
// the output collected and read line by line); the three runners below are what infra injects, so
// its specs need no Docker. Nothing here loads more than Node itself: `stackctl exec` starts
// through this file.

/** How a spawned command ended: its exit, or the error it never started for. */
export type SpawnEnd =
  | { exitCode: number | null; signal: NodeJS.Signals | null; error?: never }
  | { error: NodeJS.ErrnoException; exitCode?: never; signal?: never };

/**
 * How `child` ends: once it has exited and its pipes are drained (`close`), its exit code and
 * signal; once it fails to start (an `error` with no pid), the error. Never rejects. An `error`
 * after a start, a failed kill say, leaves the exit to report itself.
 */
function endOf(child: ChildProcess): Promise<SpawnEnd> {
  return new Promise<SpawnEnd>((resolve) => {
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (child.pid === undefined) {
        resolve({ error });
      }
    });
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

/** A spawned command: the child, for its streams and signals, with how it ends. */
export interface Spawned extends ChildProcess {
  /** How it ended: see {@link SpawnEnd}. Never rejects. */
  done: Promise<SpawnEnd>;
}

/** Spawns `command` with `args`, no shell: the program is found on `options.env`'s PATH. */
export function spawnCommand(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Spawned {
  const child = spawn(command, args, options);
  return Object.assign(child, { done: endOf(child) });
}

/**
 * What a start that failed says: `not found` for a missing program, else the error's code. Node
 * reports a working directory that doesn't exist as the program missing, so given `cwd`, that is
 * checked first.
 */
export function startFailure(error: NodeJS.ErrnoException, cwd?: string): string {
  if (error.code === 'ENOENT') {
    return cwd !== undefined && !fs.existsSync(cwd) ? `no directory ${cwd}` : 'not found';
  }
  return error.code ?? error.message;
}

/**
 * Calls `onLine` with each line `stream` carries, without its newline (nor a `\r` before it), as
 * it arrives; the last one when the stream ends, newline or not. A character split across chunks
 * stays whole.
 */
export function forEachLine(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  const decoder = new StringDecoder('utf8');
  let partial = '';
  const take = (text: string) => {
    partial += text;
    let nl: number;
    while ((nl = partial.indexOf('\n')) !== -1) {
      onLine(partial.slice(0, nl).replace(/\r$/, ''));
      partial = partial.slice(nl + 1);
    }
  };
  // A stream with an encoding set hands over strings, already whole.
  stream.on('data', (chunk: Buffer | string) =>
    take(typeof chunk === 'string' ? chunk : decoder.write(chunk)),
  );
  stream.on('end', () => {
    take(decoder.end());
    if (partial.length > 0) {
      onLine(partial.replace(/\r$/, ''));
      partial = '';
    }
  });
}

/** How a command {@link runCommand} ran ended, with what it printed. */
export type CommandResult = SpawnEnd & { stdout: string; stderr: string };

export interface RunCommandOptions extends Omit<SpawnOptions, 'stdio'> {
  /** Written to the command's stdin, which then closes. Absent, stdin is closed from the start. */
  input?: string;
  /** Called with each output line as it arrives, `isError` for stderr. */
  onLine?: (line: string, isError: boolean) => void;
  /** `false` keeps none of the output, for a command that prints for as long as it runs. */
  collect?: boolean;
  /**
   * The command leads a process group of its own, which every signal stackctl sends it reaches:
   * what it starts ends with it. Still ended when this process exits, unlike a `detached` one.
   * Made by a detached spawn, so it is a new session too: the command has no controlling
   * terminal, cannot prompt on one, and a terminal's Ctrl+C never reaches it.
   */
  group?: boolean;
}

/** A command {@link runCommand} started: the child, with how it ended and what it printed. */
export interface Running extends ChildProcess {
  /** Always piped. */
  stdout: Readable;
  stderr: Readable;
  /** Never rejects: a failed start is a result with `error`. */
  done: Promise<CommandResult>;
}

/** Commands started here and running; this process ending ends them (a detached one excepted). */
const living = new Set<ChildProcess>();
/** The commands of {@link living} that lead a process group of their own (`group`). */
const leaders = new WeakSet<ChildProcess>();

/**
 * What a group guard runs: a shell that reads `+<pgid>` and `-<pgid>` lines, and once its input
 * ends kills every group it still holds. Its input ends when the process writing to it is gone,
 * however it went: a SIGKILL too, which leaves that process no chance to end anything itself.
 * POSIX `sh` only, with no command but the `kill` built in.
 */
const GUARD_SCRIPT = [
  'groups=""',
  'while IFS= read -r line; do',
  '  case "$line" in',
  '    +*) groups="$groups ${line#+}" ;;',
  '    -*) kept=""; for g in $groups; do [ "$g" = "${line#-}" ] || kept="$kept $g"; done; groups=$kept ;;',
  '  esac',
  'done',
  'for g in $groups; do kill -s KILL -- "-$g" 2>/dev/null; done',
  'exit 0',
].join('\n');

/** Process groups that end with the process that holds them. */
export interface GroupGuard {
  /** Holds the group `pgid`. The function it returns lets the group go: it has ended. */
  add: (pgid: number) => () => void;
  /** Lets go of the guard itself, which kills every group it still holds. */
  close: () => void;
}

/**
 * A guard for process groups this process starts: a small shell, started with the first group it
 * is given, in a session of its own so no signal for this process reaches it. Once this process
 * is gone, by any means, it kills (SIGKILL) the groups it still holds. macOS has nothing that ties
 * a child's life to its parent's, and a process killed outright runs no code, so the watching is
 * done from outside. Without a guard (Windows, or a shell that can't start) nothing is held, and
 * what this process ends itself is all that ends.
 */
export function createGroupGuard(): GroupGuard {
  let input: Writable | null = null;
  let broken = process.platform === 'win32';
  const write = (line: string) => {
    if (broken) {
      return;
    }
    if (!input) {
      const shell = spawn('/bin/sh', ['-c', GUARD_SCRIPT], {
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      const fail = () => {
        broken = true;
        input = null;
      };
      shell.on('error', fail);
      shell.stdin.on('error', fail);
      // Neither the shell nor the pipe to it keeps this process alive.
      shell.unref();
      (shell.stdin as Writable & { unref?: () => void }).unref?.();
      input = shell.stdin;
    }
    input.write(`${line}\n`);
  };
  return {
    add: (pgid) => {
      write(`+${String(pgid)}`);
      let held = true;
      return () => {
        if (held) {
          held = false;
          write(`-${String(pgid)}`);
        }
      };
    },
    close: () => {
      input?.end();
      input = null;
    },
  };
}

/** This process's guard: every command that leads a group of its own is held by it. */
const guard = createGroupGuard();

/**
 * Has the process group `pgid`, one this process started and is to end, die with this process
 * however it goes. Returns what to call once the group has ended.
 */
export function guardGroup(pgid: number): () => void {
  return guard.add(pgid);
}

/** Sends `signal` to `child`, and to its whole process group when it leads one. */
function signalCommand(child: ChildProcess, signal: NodeJS.Signals): void {
  if (leaders.has(child) && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* the group is gone */
    }
    return;
  }
  child.kill(signal);
}

const endLiving = () => {
  for (const child of living) {
    signalCommand(child, 'SIGTERM');
  }
};

/**
 * Makes a signal that ends this process end the commands {@link runCommand} started (a detached
 * one excepted), for a command with no signal handling of its own: Node's default would leave them
 * running, since a signal for this process alone (a `kill <pid>`) never reaches them.
 *
 * - **SIGTERM, SIGHUP**: every command gets the same signal, a group's leader for its group.
 * - **SIGINT**: only the commands that lead a group of their own get it. A terminal's Ctrl+C has
 *   reached everything in its foreground group already, and a second one reads as "force" to
 *   many tools.
 *
 * A command that leads a group then has {@link COMMAND_END_GRACE_MS} to end before this process
 * exits, and the {@link createGroupGuard guard} kills what is left of its group. A second signal
 * skips the wait. The exit is the signal's: its code (143, 129) or, for SIGINT, the signal
 * itself, as with no handler. Returns the undo.
 */
export function endCommandsOnSignals(): () => void {
  let ending = false;
  const handlers = (['SIGTERM', 'SIGHUP', 'SIGINT'] as const).map((signal) => {
    const exit = () => {
      if (signal === 'SIGINT') {
        process.off(signal, handler);
        if (process.listenerCount(signal) === 0) {
          // As Node's default does: ended by the signal, with no exit handler run.
          process.kill(process.pid, signal);
          return;
        }
        // Another listener would swallow the signal raised again.
      }
      process.exit(128 + os.constants.signals[signal]);
    };
    const handler = () => {
      if (ending) {
        exit();
        return;
      }
      ending = true;
      const led: Promise<unknown>[] = [];
      for (const child of living) {
        const leads = leaders.has(child);
        if (leads || signal !== 'SIGINT') {
          signalCommand(child, signal);
        }
        if (leads) {
          led.push(new Promise((resolve) => child.once('exit', resolve)));
        }
      }
      if (led.length === 0) {
        exit();
        return;
      }
      const timer = setTimeout(exit, COMMAND_END_GRACE_MS);
      void Promise.all(led).then(() => {
        clearTimeout(timer);
        exit();
      });
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}

/**
 * Runs `command` with its output piped: collected into the result (unless `collect: false`) and
 * handed to `onLine` line by line. stdin is closed, or fed `input`. Spawn `options` pass through
 * (`cwd`, `env`, `detached`, `timeout`…). A command still running when this process exits is sent
 * SIGTERM (its group too, with `group`), unless it is `detached`, which is then the caller's to end.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Running {
  const { input, onLine, collect = true, group = false, ...spawnOptions } = options;
  // Windows has no process groups: there the command is signalled itself, and nothing guards it.
  const leads = group && process.platform !== 'win32';
  const child = spawn(command, args, {
    ...spawnOptions,
    // A detached spawn makes the group (a new session: no controlling terminal); it is still this
    // process's to end.
    ...(leads ? { detached: true } : {}),
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  // A group of its own is held by the guard until the command ends.
  const release = leads && child.pid !== undefined ? guard.add(child.pid) : null;
  if (leads) {
    leaders.add(child);
  }
  if (input !== undefined) {
    // A command that never started, or one that exits without reading, closes the pipe under us.
    child.stdin!.on('error', () => {});
    child.stdin!.end(input);
  }
  const output = { stdout: '', stderr: '' };
  for (const name of ['stdout', 'stderr'] as const) {
    const stream = child[name]!;
    if (collect) {
      stream.setEncoding('utf8');
      stream.on('data', (text: string) => (output[name] += text));
    }
    if (onLine) {
      forEachLine(stream, (line) => onLine(line, name === 'stderr'));
    } else if (!collect) {
      // Read and dropped: unread, a pipe that fills up stops the command.
      stream.resume();
    }
  }
  if (!spawnOptions.detached) {
    if (living.size === 0) {
      process.on('exit', endLiving);
    }
    living.add(child);
  }
  const done = endOf(child).then((end) => {
    release?.();
    if (living.delete(child) && living.size === 0) {
      process.off('exit', endLiving);
    }
    return { ...end, ...output };
  });
  return Object.assign(child as ChildProcess & Pick<Running, 'stdout' | 'stderr'>, { done });
}

// ---- The runners infra uses, each injected so its specs need no Docker ----

export interface ExecOptions {
  cwd: string;
  /** The child's whole environment: nothing is inherited implicitly. */
  env: Record<string, string>;
  /** Called with each complete output line as it arrives (`isError` for stderr). */
  onLine?: (line: string, isError: boolean) => void;
  /**
   * For an {@link Exec}: aborting kills the command and every process it started (SIGKILL to its
   * process group, which it then leads); it resolves as a command ended by a signal does. A
   * {@link Stream} ignores it.
   */
  signal?: AbortSignal;
  /**
   * For an {@link Exec}: aborting asks the command, and every process it started, to end: SIGTERM
   * to its process group (which it then leads), and SIGKILL if it still runs
   * {@link COMMAND_END_GRACE_MS} later. One aborted before the command starts kills it at once,
   * as `signal` does at any time. A {@link Stream} ignores it.
   */
  abandon?: AbortSignal;
}

/**
 * How long a command asked to end (`abandon`) has to do so after its SIGTERM, before it is
 * killed.
 */
export const COMMAND_END_GRACE_MS = 2_000;

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs a command to completion with its output captured. */
export type Exec = (command: string, args: string[], opts: ExecOptions) => Promise<ExecResult>;

/** A long-running command whose output arrives line by line, until it exits or is stopped. */
export interface LineStream {
  /** Ends the command. A no-op once it has exited. */
  stop: () => void;
  /** Resolves with the exit code once the command has exited, however it ended. */
  done: Promise<number>;
}

/** Starts a command whose output is read as it arrives. */
export type Stream = (command: string, args: string[], opts: ExecOptions) => LineStream;

/** Runs a command with the terminal handed over to it; resolves with its exit code. */
export type SpawnInherit = (
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
) => Promise<number>;

/** The exit code a shell reports for a command it couldn't find; ours for one that never ran. */
export const SPAWN_FAILED = 127;

/** An end as one exit code: 127 for a command that never ran, 1 for one a signal ended. */
function exitCodeOf(end: SpawnEnd): number {
  return end.error ? SPAWN_FAILED : (end.exitCode ?? 1);
}

/** Why `command` never ran, as a line for its stderr. */
const notRun = (command: string, error: NodeJS.ErrnoException, cwd: string) =>
  `couldn't run ${command}: ${startFailure(error, cwd)}`;

/**
 * Runs a command with stdin closed and both output streams captured, handing each line to
 * `onLine` as it arrives. **Never rejects**: a non-zero exit is a result, and a command that
 * can't be spawned at all comes back as exit 127 with the reason in `stderr`, and in a line to
 * `onLine`; callers decide what a failure means. `endGraceMs` is how long a command asked to end
 * (`abandon`) has before it is killed.
 */
export function execLinesWith(endGraceMs: number): Exec {
  return async (command, args, { cwd, env, onLine, signal, abandon }) => {
    // One that can be ended leads a group of its own, so its end is the end of what it started
    // too: a shell's or a package manager's children would otherwise outlive it, and hold its
    // pipes open.
    const group = signal !== undefined || abandon !== undefined;
    const child = runCommand(command, args, { cwd, env, onLine, group });
    let grace: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      clearTimeout(grace);
      signalCommand(child, 'SIGKILL');
    };
    const end = () => {
      signalCommand(child, 'SIGTERM');
      grace = setTimeout(kill, endGraceMs);
    };
    if (signal?.aborted || abandon?.aborted) {
      kill();
    } else {
      signal?.addEventListener('abort', kill, { once: true });
      abandon?.addEventListener('abort', end, { once: true });
    }
    const ended = await child.done;
    clearTimeout(grace);
    signal?.removeEventListener('abort', kill);
    abandon?.removeEventListener('abort', end);
    if (ended.error) {
      const why = notRun(command, ended.error, cwd);
      onLine?.(why, true);
      return { exitCode: SPAWN_FAILED, stdout: '', stderr: why };
    }
    return { exitCode: exitCodeOf(ended), stdout: ended.stdout, stderr: ended.stderr };
  };
}

/** {@link execLinesWith}, a command asked to end getting {@link COMMAND_END_GRACE_MS}. */
export const execLines: Exec = execLinesWith(COMMAND_END_GRACE_MS);

/**
 * Starts a command with stdin closed, handing each output line to `onLine` as it arrives and
 * keeping none of it: for a command that runs as long as it's needed, such as an event stream.
 * Like {@link execLines} it never rejects: a command that can't be spawned is done with 127.
 */
export const streamLines: Stream = (command, args, { cwd, env, onLine }) => {
  const child = runCommand(command, args, { cwd, env, onLine, collect: false });
  return {
    stop: () => {
      child.kill('SIGTERM');
    },
    done: child.done.then(exitCodeOf),
  };
};

/**
 * Runs a command with stdin, stdout and stderr inherited (the terminal is the command's, so a
 * TTY stays a TTY) and resolves with its exit code.
 *
 * While it runs, stackctl doesn't exit on SIGINT: the terminal delivers Ctrl+C to the whole
 * foreground group, so the command gets it too and decides what it means (`logs -f` stops,
 * an attached `up` shuts its containers down first). SIGTERM is forwarded.
 */
export const spawnInherit: SpawnInherit = async (command, args, { cwd, env }) => {
  const child = spawnCommand(command, args, { cwd, env, stdio: 'inherit' });
  const ignoreInterrupt = () => {};
  const forwardTerminate = () => child.kill('SIGTERM');
  process.on('SIGINT', ignoreInterrupt);
  process.on('SIGTERM', forwardTerminate);
  try {
    const end = await child.done;
    if (end.error) {
      console.error(notRun(command, end.error, cwd));
    }
    return exitCodeOf(end);
  } finally {
    process.off('SIGINT', ignoreInterrupt);
    process.off('SIGTERM', forwardTerminate);
  }
};
