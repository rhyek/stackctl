import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import { type ChildRecord, updateRunning } from '../running.js';
import { exitCodeOf } from '../scripts.js';
import { SHUTDOWN_GRACE_MS } from '../shutdown-timing.js';
import { stripTitleSequences } from '../terminal-title.js';
import { callEach } from '../util.js';

/** Where one OS process is in its life. It only ever moves forward. */
export type ProcessState = 'idle' | 'starting' | 'running' | 'stopping' | 'exited';

/** How a process ended: its own exit code, or the signal that killed it. Both `null` if it never ran. */
export interface ProcessExit {
  code: number | null;
  signal: string | null;
}

/**
 * What a {@link ServiceProcess} emits. A listener that throws is skipped over: the others still
 * hear the event, and the process's own bookkeeping goes on.
 */
export type ServiceProcessEvents = {
  /** Every state change, with the new state. */
  state: [state: ProcessState];
  /**
   * Once, when the process has exited (or failed to spawn), after every line its pipes held by
   * then. A member of its group that outlives it and keeps the pipes open can still send lines
   * through `onLine` afterwards.
   */
  exit: [exit: ProcessExit];
};

export interface ServiceProcessOptions {
  /** The service the process belongs to. */
  name: string;
  /** Run through `/bin/sh -c`, so pipes, redirects and `&&` work. */
  command: string;
  /** The directory it runs in. */
  cwd: string;
  /** Its whole environment. */
  env: NodeJS.ProcessEnv;
  /**
   * Each line of its output, without the newline; `isError` when it came from stderr. Lines can
   * still arrive after `exit` (see {@link ServiceProcessEvents.exit}). A throw is ignored.
   */
  onLine: (text: string, isError: boolean) => void;
  /** The session's child records, which the spawned process group is added to. */
  records: ChildRecords;
  /** How long a stop waits after SIGTERM before it SIGKILLs the group. */
  graceMs?: number;
}

/**
 * How long an exit waits for the process's output to finish arriving. Node reports the exit
 * before it has always read the last of the pipes; a member of the group that outlives the
 * process and keeps the pipes open would otherwise hold the exit back for as long as it lives.
 */
const DRAIN_MS = 100;

/**
 * How long a pipe stays quiet before the partial line it ends on is passed on without its
 * newline: a prompt or a `Listening on …` printed without one shows up while the process runs. A
 * line the OS delivers in two reads closer together than this is still one line.
 */
const PARTIAL_LINE_QUIET_MS = 100;

/**
 * A partial line longer than this is passed on without waiting for its newline, so a child that
 * never prints one and never pauses (a `\r`-redrawn progress bar) doesn't grow the buffer without
 * end.
 */
const PARTIAL_LINE_LIMIT = 64 * 1024;

/**
 * One OS process: a service's dev command, a one-off script, or a custom shell command. Spawned in
 * its own process group, so a signal reaches everything it starts. Its output arrives line by line
 * through `onLine`; it emits `state` on every change and `exit` once.
 */
export class ServiceProcess extends EventEmitter<ServiceProcessEvents> {
  readonly name: string;
  private readonly opts: ServiceProcessOptions;
  private readonly graceMs: number;
  private child: ChildProcess | null = null;
  private current: ProcessState = 'idle';
  /** The process itself has exited; its output may still be draining. Nothing is signalled now. */
  private leaderExited = false;
  private code: number | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private resolveExit!: (exit: ProcessExit) => void;
  private readonly exited = new Promise<ProcessExit>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(opts: ServiceProcessOptions) {
    super();
    this.name = opts.name;
    this.opts = opts;
    this.graceMs = opts.graceMs ?? SHUTDOWN_GRACE_MS;
  }

  get state(): ProcessState {
    return this.current;
  }

  /** The process's pid, which is also its group's id; `null` before the spawn or when it failed. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /**
   * The exit code by shell convention (`scripts.ts` `exitCodeOf`): its own code, 128 + the signal's
   * number when a signal killed it, 1 when it never ran. `null` until it has exited.
   */
  get exitCode(): number | null {
    return this.code;
  }

  /** Spawns the process. Only the first call does anything. */
  start(): void {
    if (this.current !== 'idle') {
      return;
    }
    this.setState('starting');
    const { command, cwd, env } = this.opts;
    let child: ChildProcess;
    try {
      child = spawn('/bin/sh', ['-c', command], {
        cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.failed(err);
      return;
    }
    this.child = child;
    const out = this.readLines(child.stdout!, false);
    const err = this.readLines(child.stderr!, true);
    child.once('error', (error) => {
      // Only a spawn that failed has no pid; any other error leaves the exit to report itself.
      if (child.pid === undefined) {
        this.failed(error);
      }
    });
    child.once('spawn', () => {
      if (this.current === 'starting') {
        this.setState('running');
      }
    });
    child.once('exit', (code, signal) => {
      this.leaderExited = true;
      this.clearGrace();
      void this.drain(child).then(() => {
        out.flush();
        err.flush();
        this.finish({ code, signal });
      });
    });
    if (child.pid !== undefined) {
      this.opts.records.add(child.pid, cwd);
    }
  }

  /**
   * SIGTERM to the process's group, then SIGKILL to it if the process hasn't exited when the grace
   * period runs out. Resolves when it has exited; every call while it stops gets the same promise.
   * Once the process itself has exited nothing more is sent, whatever else of its group lives on.
   */
  stop(): Promise<ProcessExit> {
    if (this.current === 'idle') {
      return Promise.resolve({ code: null, signal: null });
    }
    if ((this.current === 'starting' || this.current === 'running') && !this.leaderExited) {
      this.setState('stopping');
      this.signal('SIGTERM');
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        this.signal('SIGKILL');
      }, this.graceMs);
    }
    return this.exited;
  }

  /**
   * An immediate SIGKILL to the process's group, a stop in its grace period included. Nothing is
   * sent once the process itself has exited.
   */
  kill(): void {
    if (this.current === 'idle' || this.current === 'exited' || this.leaderExited) {
      return;
    }
    if (this.current !== 'stopping') {
      this.setState('stopping');
    }
    this.clearGrace();
    this.signal('SIGKILL');
  }

  private setState(state: ProcessState): void {
    this.current = state;
    this.notify('state', state);
  }

  /** Emits to each listener in turn; one that throws doesn't keep the event from the rest. */
  private notify<K extends keyof ServiceProcessEvents>(
    event: K,
    ...args: ServiceProcessEvents[K]
  ): void {
    callEach(
      this.rawListeners(event) as ((...a: ServiceProcessEvents[K]) => void)[],
      this,
      ...args,
    );
  }

  /** Passes a line on; a throw from `onLine` doesn't reach the pipe's reader. */
  private line(text: string, isError: boolean): void {
    try {
      this.opts.onLine(text, isError);
    } catch {
      /* the caller's own fault; reading goes on */
    }
  }

  /**
   * Signals the group, or the process alone when the group can't be. Gone already is fine.
   * Nothing is sent once the process has exited: its pid may no longer be its own.
   */
  private signal(sig: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (pid === undefined || this.leaderExited) {
      return;
    }
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* exited already */
      }
    }
  }

  private clearGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  /** A spawn that failed outright: the reason as an error line, then an exit like code 1's. */
  private failed(err: unknown): void {
    if (this.current === 'exited') {
      return;
    }
    const reason = fs.existsSync(this.opts.cwd)
      ? err instanceof Error
        ? err.message
        : String(err)
      : `directory not found: ${this.opts.cwd}`;
    this.line(`failed to start: ${reason}`, true);
    this.finish({ code: null, signal: null });
  }

  /** Records the exit and settles `stop()` before any listener hears of it. */
  private finish(exit: ProcessExit): void {
    if (this.current === 'exited') {
      return;
    }
    this.clearGrace();
    this.code = exitCodeOf({
      exitCode: exit.code ?? undefined,
      signal: exit.signal ?? undefined,
    });
    this.current = 'exited';
    this.resolveExit(exit);
    this.notify('state', 'exited');
    this.notify('exit', exit);
  }

  /** Waits, up to {@link DRAIN_MS}, for both pipes to reach their end. */
  private drain(child: ChildProcess): Promise<void> {
    const open = [child.stdout, child.stderr].filter(
      (s): s is Readable => s !== null && !s.readableEnded && !s.destroyed,
    );
    if (open.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let left = open.length;
      const timer = setTimeout(resolve, DRAIN_MS);
      const ended = () => {
        if (--left === 0) {
          clearTimeout(timer);
          resolve();
        }
      };
      for (const stream of open) {
        stream.once('close', ended);
      }
    });
  }

  /**
   * Splits a pipe into lines. A line is passed on once its newline arrives, so one the OS delivers
   * in two reads is still one line. A partial line is passed on without its newline once the pipe
   * has been quiet for {@link PARTIAL_LINE_QUIET_MS}, once it outgrows {@link PARTIAL_LINE_LIMIT},
   * and when the pipe ends or the process exits. The pipe is decoded as UTF-8, so a character
   * split across reads survives. Title sequences are removed and empty lines dropped; a `\r`
   * stays.
   */
  private readLines(stream: Readable, isError: boolean): { flush(): void } {
    let partial = '';
    let quiet: NodeJS.Timeout | null = null;
    const emit = (piece: string) => {
      const text = stripTitleSequences(piece);
      if (text !== '') {
        this.line(text, isError);
      }
    };
    const flush = () => {
      if (quiet) {
        clearTimeout(quiet);
        quiet = null;
      }
      if (partial !== '') {
        const text = partial;
        partial = '';
        emit(text);
      }
    };
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const pieces = (partial + chunk).split('\n');
      partial = pieces.pop()!;
      for (const piece of pieces) {
        emit(piece);
      }
      if (partial.length > PARTIAL_LINE_LIMIT) {
        flush();
      } else if (partial !== '') {
        quiet?.refresh();
        quiet ??= setTimeout(flush, PARTIAL_LINE_QUIET_MS).unref();
      } else if (quiet) {
        clearTimeout(quiet);
        quiet = null;
      }
    });
    stream.on('end', flush);
    // A pipe that fails is treated as ended; the exit still comes from the process.
    stream.on('error', flush);
    return { flush };
  }
}

/**
 * How many child records a session keeps. Each record left in the list when a session dies costs
 * the next session's orphan sweep a lookup in one `ps` listing, plus, for a group that is still
 * alive, a cwd check per member until one matches; the file is rewritten at every spawn. 256 holds
 * every group of a large workspace's session with room for hundreds of restarts and one-offs,
 * while keeping that file a few kilobytes and that sweep well under a second.
 */
export const CHILD_RECORD_LIMIT = 256;

/** `true` while any process of group `pgid` is alive. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The process groups a session has spawned, kept in its session record
 * (`node_modules/.stackctl/modes/<mode>/running.json`, `children`) for the next session's orphan
 * sweep. A record stays while any process of its group lives: a wrapper may exit while the rest of
 * its group lives on. Every add drops the records whose group has no process left, since a dead
 * group's pgid can be reused by a process stackctl never started. The list is bounded; over the
 * bound, the oldest record goes.
 */
export class ChildRecords {
  private readonly root: string;
  private readonly limit: number;
  private readonly list: ChildRecord[] = [];

  constructor(root: string, limit: number = CHILD_RECORD_LIMIT) {
    this.root = root;
    this.limit = limit;
  }

  get records(): readonly ChildRecord[] {
    return this.list;
  }

  /**
   * Records a group spawned in `cwd` and rewrites the session record's list, when this process
   * owns that record. Never throws: bookkeeping never blocks a spawn.
   */
  add(pid: number, cwd: string): void {
    // Pruned before the push, so a group that is already gone is still recorded this once.
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (!groupAlive(this.list[i]!.pid)) {
        this.list.splice(i, 1);
      }
    }
    this.list.push({ pid, cwd });
    while (this.list.length > this.limit) {
      this.list.shift();
    }
    try {
      updateRunning(this.root, { children: [...this.list] });
    } catch {
      /* bookkeeping only */
    }
  }
}
