import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionServiceStatus } from './control-client.js';
import type { InfraStatus } from './infra/control.js';
import { isProcessAlive } from './process-info.js';
import { readRunning } from './running.js';
import { currentSessionId, sessionEventsPath, writeTargetSessionId } from './session-files.js';

// A session's event log, `node_modules/.stackctl/modes/<mode>/sessions/<id>/events.jsonl`: one JSON
// object per line, its `type` first, for whatever changes the mode's stack. The session writes its
// state changes, its lifecycle and what its keys, control API and start-up infra step do; a stackctl
// command that acts without the session writes its own, to the running session's file or, with none
// running, the latest one's. `GET /events` streams the same lines (control-server.ts tails the
// session's file). Kept free of the config, so a CLI command loads only this.

/** Who asked for a command. */
export type EventBy =
  /** A person at the terminal UI: a key, or a click on its hint. */
  | { kind: 'ui'; key: string; click?: boolean }
  /** A control API request: `curl`, or a stackctl command that sends one (`userAgent` says). */
  | { kind: 'control-api'; request: string; userAgent: string | null }
  /** A stackctl command run from a shell: its own arguments, where, and whether an agent ran it. */
  | { kind: 'cli'; argv: string[]; cwd: string; agent: boolean }
  /** A Node script calling the SDK's `exec()` or `run()`: node's arguments, where, whether an agent ran it. */
  | { kind: 'sdk'; argv: string[]; cwd: string; agent: boolean }
  /** The session itself: its start-up infra step. */
  | { kind: 'session' };

/** What a command's `end` line has on top of its `begin` line's fields. */
interface Ended {
  ok: boolean;
  durationMs: number;
}

/** A command's two lines: `begin` with what was asked, then `end` with what came of it. */
type Command<T extends string, Asked, Result> =
  | ({ type: T; phase: 'begin'; id: string } & Asked & { by: EventBy })
  | ({ type: T; phase: 'end'; id: string } & Asked & { by: EventBy } & Ended & Result);

export type ServiceCommandEntry = Command<
  'service-command',
  { action: 'start' | 'stop' | 'restart'; service: string },
  { outcome: 'done' | 'busy' | 'waiting' | 'unknown' | 'unavailable' | 'closing' }
>;
export type InfraCommandEntry = Command<
  'infra-command',
  {
    action: 'start' | 'stop' | 'restart' | 'reset' | 'destroy';
    /** The services named; empty for all of them. */
    requested: string[];
  },
  {
    /** What `requested` resolved to. */
    services?: string[];
    /** A `destroy` of the whole project, its disabled services' leftovers included. */
    everything?: boolean;
    results?: Record<string, 'ready' | 'stopped' | 'destroyed' | 'failed'>;
    error?: string;
  }
>;
export type ComposeCommandEntry = Command<
  'compose-command',
  { args: string[] },
  { exitCode: number }
>;
export type OneOffCommandEntry = Command<
  'one-off-command',
  { kind: 'exec' | 'run'; service?: string; dir?: string; command?: string[]; script?: string; args?: string[] }, // oxfmt-ignore
  { exitCode: number | null; signal: string | null }
>;
export type SessionCommandEntry = Command<'session-command', { action: 'quit' | 'reset' }, object>;

export type CommandEntry =
  | ServiceCommandEntry
  | InfraCommandEntry
  | ComposeCommandEntry
  | OneOffCommandEntry
  | SessionCommandEntry;

/** What something is now, written when it changes; `previous…` is `null` the first time. */
export type StateEntry =
  | {
      type: 'service-state';
      service: string;
      status: SessionServiceStatus;
      ready: boolean;
      previousStatus: SessionServiceStatus | null;
      previousReady: boolean | null;
    }
  | {
      type: 'infra-state';
      service: string;
      status: InfraStatus;
      previousStatus: InfraStatus | null;
    }
  | { type: 'session-state'; ready: boolean };

/** What the session does on its own. */
export type LifecycleEntry =
  | {
      type: 'session-start';
      services: string[];
      headless: boolean;
      startedByAgent: boolean;
      argv: string[];
      version: string;
      logFile: string;
      /** The `sessionId` of the session it took over, or `null`. */
      replaced: string | null;
    }
  | { type: 'session-end'; cause: 'quit' | 'signal' | 'error'; durationMs: number }
  /** A service's process exited, and stackctl hadn't stopped it. */
  | { type: 'service-exit'; service: string; exitCode: number | null; signal: string | null }
  /** A `.env` file in `dir` (relative to the workspace) changed: `services` restart. */
  | { type: 'env-change'; dir: string; services: string[] };

/** One line of the event log, before its envelope. */
export type EventEntry = StateEntry | CommandEntry | LifecycleEntry;

/** What every line ends with. */
export interface EventEnvelope {
  /** ISO 8601 with the machine's offset, to the ms. */
  time: string;
  mode: string;
  /** The id of the mode's running session, or `null`. */
  sessionId: string | null;
  /** The process that wrote the line. */
  pid: number;
}

export type EventLine = EventEntry & EventEnvelope;

/**
 * Set by a session on the `stackctl infra` command its key or control API runs, to the `by` the
 * command's lines carry instead of its own.
 */
export const EVENT_BY_ENV = 'STACKCTL_EVENT_BY';

/** What a session handed this process in `EVENT_BY_ENV`, taken out by {@link takeHandedBy}. */
let handedBy: string | undefined;

/**
 * Takes `EVENT_BY_ENV` out of `env`, keeping it for {@link commandBy}: what this command runs (an
 * infra callback's `exec`, a `stackctl run` it starts) must not pass the session's `by` on as its
 * own. The CLI calls it first thing.
 */
export function takeHandedBy(env: NodeJS.ProcessEnv = process.env): void {
  handedBy = env[EVENT_BY_ENV] ?? handedBy;
  delete env[EVENT_BY_ENV];
}

/**
 * Who asked, for a stackctl command's own lines: the session that ran it, as it handed over in
 * `EVENT_BY_ENV`, else whoever ran it from a shell.
 */
export function commandBy(
  root: string,
  opts: { agent: boolean; invocationCwd: string; handed?: string },
): EventBy {
  const handed = opts.handed ?? handedBy;
  if (handed) {
    try {
      return JSON.parse(handed) as EventBy;
    } catch {
      /* not one of ours: the shell's */
    }
  }
  return {
    kind: 'cli',
    argv: maskSecrets(process.argv.slice(2)),
    cwd: path.relative(root, opts.invocationCwd) || '.',
    agent: opts.agent,
  };
}

/**
 * Who asked, for the lines of an SDK `exec()` or `run()`: the Node script that called it, its
 * path relative to `root` and its arguments, run in `cwd`.
 */
export function sdkBy(root: string, opts: { agent: boolean; cwd: string }): EventBy {
  const [script, ...args] = process.argv.slice(1);
  return {
    kind: 'sdk',
    argv: maskSecrets([...(script ? [path.relative(root, script) || '.'] : []), ...args]),
    cwd: path.relative(root, opts.cwd) || '.',
    agent: opts.agent,
  };
}

/** A file over this is renamed to `events.1.jsonl` by the next writer, replacing the old one. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * The event log `stackctl events` and `status` read: the running session's, else the latest
 * one's. `null` before any session ran.
 */
export function currentEventsPath(root: string, mode: string): string | null {
  const id = currentSessionId(root, mode);
  return id === null ? null : sessionEventsPath(root, mode, id);
}

/** `date` as ISO 8601 in the machine's time zone, with its offset, to the ms. */
export function localTime(date: Date): string {
  const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');
  const offset = -date.getTimezoneOffset();
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${offset < 0 ? '-' : '+'}` +
    `${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

/** `args` with a URL's password masked (`postgres://app:***@db/app`); the rest as given. */
export function maskSecrets(args: string[]): string[] {
  return args.map((arg) =>
    arg.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, '$1:***@'),
  );
}

/** Compose's subcommands that change nothing, which leave no line. */
const READ_ONLY_COMPOSE = new Set([
  'ps', 'ls', 'logs', 'top', 'config', 'images', 'port', 'version', 'events', 'stats',
]); // oxfmt-ignore

/**
 * Whether `stackctl infra docker-compose <args>` only reads: its subcommand, the first argument
 * that isn't a flag, is a read-only one. A flag's value read as the subcommand makes it false, so
 * the doubt is logged.
 */
export function isReadOnlyCompose(args: string[]): boolean {
  const sub = args.find((arg) => !arg.startsWith('-'));
  return sub !== undefined && READ_ONLY_COMPOSE.has(sub);
}

/**
 * A session's event log, for one process to write. Each line is one append, so several processes'
 * lines never interleave; a write it can't make is dropped, never thrown.
 */
export class EventLog {
  readonly file: string;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly opts: {
      /** The file it appends to: a session's `events.jsonl`, chosen once, so a command's lines share one. */
      file: string;
      mode: string;
      /** The mode's running session, asked at each write: a session's id is known only once it has one. */
      sessionId: () => string | null;
      maxBytes?: number;
    },
  ) {
    this.file = opts.file;
  }

  write(entry: EventEntry): void {
    const line: EventLine = {
      ...entry,
      time: localTime(new Date()),
      mode: this.opts.mode,
      sessionId: this.opts.sessionId(),
      pid: process.pid,
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.rotate();
      fs.appendFileSync(this.file, `${JSON.stringify(line)}\n`);
    } catch {
      return;
    }
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * Writes a command's `begin` line now, and returns what writes its `end` line, with the same
   * `id`, `by` and fields, once it is done.
   */
  begin<E extends CommandEntry>(
    asked: Omit<Extract<E, { phase: 'begin' }>, 'phase' | 'id' | 'by'>,
    by: EventBy,
  ): {
    end(
      result: Omit<
        Extract<E, { phase: 'end' }>,
        keyof Extract<E, { phase: 'begin' }> | 'durationMs'
      >,
    ): void;
  } {
    // oxfmt-ignore
    const id = randomBytes(4).toString('hex');
    const started = Date.now();
    const { type, ...fields } = asked as { type: string };
    this.write({ type, phase: 'begin', id, ...fields, by } as EventEntry);
    return {
      end: (result) => {
        const { ok, ...rest } = result as unknown as { ok: boolean };
        this.write({ type, phase: 'end', id, ...fields, by, ok, durationMs: Date.now() - started, ...rest } as EventEntry); // oxfmt-ignore
      },
    };
  }

  /** Calls `fn` after each line this process writes. Returns the unsubscribe. */
  onWrite(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private rotate(): void {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size > (this.opts.maxBytes ?? MAX_BYTES)) {
      fs.renameSync(this.file, this.file.replace(/\.jsonl$/, '.1.jsonl'));
    }
  }
}

/**
 * The event log a stackctl command writes to, from the workspace at `root`: the running session's,
 * else the latest one's, chosen now. Each line carries the id of the mode's session if one is
 * alive, else `null`.
 */
export function cliEventLog(root: string, mode: string): EventLog {
  return new EventLog({
    file: sessionEventsPath(root, mode, writeTargetSessionId(root, mode)),
    mode,
    sessionId: () => {
      const running = readRunning(root, mode);
      return running && isProcessAlive(running.pid) ? (running.sessionId ?? null) : null;
    },
  });
}

/** The file's size now, `0` when it isn't there. */
export function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Reads an event log as it grows: each `read()` returns the whole lines added since the last, and
 * keeps a line still being written for the next. A file smaller than where it got to has been
 * rotated, and is read again from its start.
 */
export class EventTail {
  private rest = Buffer.alloc(0);

  constructor(
    private readonly file: string,
    private offset: number,
  ) {}

  read(): string[] {
    let fd: number;
    try {
      fd = fs.openSync(this.file, 'r');
    } catch {
      return [];
    }
    try {
      const { size } = fs.fstatSync(fd);
      if (size < this.offset) {
        this.offset = 0;
        this.rest = Buffer.alloc(0);
      }
      if (size === this.offset) {
        return [];
      }
      const chunk = Buffer.alloc(size - this.offset);
      fs.readSync(fd, chunk, 0, chunk.length, this.offset);
      this.offset = size;
      const data = Buffer.concat([this.rest, chunk]);
      const end = data.lastIndexOf(0x0a);
      this.rest = end < 0 ? data : data.subarray(end + 1);
      return end < 0 ? [] : data.subarray(0, end).toString('utf8').split('\n').filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  }
}
