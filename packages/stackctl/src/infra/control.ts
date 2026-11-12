import chalk from 'chalk';
import { execa, type ResultPromise } from 'execa';
import { EVENT_BY_ENV, type EventBy } from '../event-log.js';
import { stripTitleSequences } from '../terminal-title.js';
import { callEach } from '../util.js';
import type { InfraWatch } from './provider.js';
import type { InfraServiceState } from './types.js';

/** What a session can do to one of its infra services, from a hotkey or the control API. */
export type InfraAction = 'start' | 'stop' | 'restart' | 'reset';

export const INFRA_ACTIONS: readonly InfraAction[] = ['start', 'stop', 'restart', 'reset'];

/** A service's live state, or the action under way on it. */
export type InfraStatus = InfraServiceState | 'stopping' | 'restarting' | 'resetting';

/** How a service reads while an action is under way on it. */
const IN_PROGRESS: Record<InfraAction, InfraStatus> = {
  start: 'starting',
  stop: 'stopping',
  restart: 'restarting',
  reset: 'resetting',
};

/**
 * The `stackctl infra …` invocation an action runs: the infra command of the same name, for the
 * one service.
 */
export function infraCliArgs(action: InfraAction, service: string): string[] {
  return ['infra', action, '-s', service];
}

/** Why {@link InfraControl.run} did or didn't take an action on. */
export type InfraRunOutcome = 'accepted' | 'unknown' | 'busy';

export interface InfraControlOptions {
  /** The session's services, by name. */
  services: string[];
  /** Starts the live watch of their states (see `SessionInfra.watch`); absent, nothing watches. */
  watch?: (onStates: (states: Map<string, InfraServiceState>) => void) => InfraWatch;
  /** The command that runs the stackctl CLI: `[node, cli.js]`. */
  cli: string[];
  /** The session's mode, handed to every `infra` command it runs. */
  mode: string;
  /** The workspace root, where the commands run. */
  cwd: string;
  /** Receives every line an action prints, and the lines marking where it starts and ends. */
  log: (service: string, text: string, isError: boolean) => void;
  /** Called with each child spawned, for the session record's orphan sweep. */
  track?: (proc: ResultPromise, cwd: string) => void;
}

/**
 * A session's hold on its infra services: their live states, and the actions run on them.
 *
 * An action runs the `stackctl infra` command itself, as a child with its output piped into the
 * session log — the same command a terminal would run, and no provider output drawn over the
 * TUI. Every service is taken to be running until the watch first reports: the session only
 * starts once its infra is ready.
 */
export class InfraControl {
  private readonly states = new Map<string, InfraServiceState>();
  private readonly busy = new Map<string, InfraAction>();
  private readonly procs = new Set<ResultPromise>();
  private readonly listeners = new Set<() => void>();
  private watch: InfraWatch | null = null;
  /** Set by {@link stop}: a stopped control starts nothing, so nothing it runs outlives the session. */
  private stopped = false;

  constructor(private readonly opts: InfraControlOptions) {
    for (const service of opts.services) {
      this.states.set(service, 'running');
    }
  }

  /** The services, in the order the session lists them. */
  get services(): string[] {
    return this.opts.services;
  }

  /** Starts watching the services' states. A second call is a no-op. */
  start(): void {
    if (this.watch || !this.opts.watch) {
      return;
    }
    this.watch = this.opts.watch((states) => {
      let changed = false;
      for (const [name, state] of states) {
        if (this.states.has(name) && this.states.get(name) !== state) {
          this.states.set(name, state);
          changed = true;
        }
      }
      if (changed) {
        this.emit();
      }
    });
  }

  /**
   * Stops watching, and refuses every action from here on. An action under way logs no end line
   * once it exits. The actions under way are the
   * caller's to kill (see {@link takeLiving}).
   */
  stop(): void {
    this.stopped = true;
    this.watch?.stop();
    this.watch = null;
  }

  /** Calls `fn` whenever a service's status changes; returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** A service's status — the action under way, else its live state — or `undefined` for none. */
  status(service: string): InfraStatus | undefined {
    const action = this.busy.get(service);
    return action ? IN_PROGRESS[action] : this.states.get(service);
  }

  /** Every service's status, keyed by name: what `/query/status` reports under `infra`. */
  statuses(): Record<string, InfraStatus> {
    return Object.fromEntries(this.opts.services.map((s) => [s, this.status(s)!]));
  }

  /** Whether an action is under way on the service. */
  isBusy(service: string): boolean {
    return this.busy.has(service);
  }

  /**
   * Starts an action on a service for `by`, returning at once: `unknown` for a name the session
   * doesn't have, `busy` while another action on it is under way or once the control is stopped.
   * The command it runs writes the action's lines to the event log, with `by`.
   */
  run(service: string, action: InfraAction, by: EventBy): InfraRunOutcome {
    if (!this.states.has(service)) {
      return 'unknown';
    }
    if (this.stopped || this.busy.has(service)) {
      return 'busy';
    }
    this.busy.set(service, action);
    this.emit();
    void (async () => {
      try {
        await this.runCommand(service, infraCliArgs(action, service), by);
      } finally {
        this.busy.delete(service);
        this.emit();
        this.watch?.refresh();
      }
    })();
    return 'accepted';
  }

  /** Hands over the commands still running, for a shutdown to kill and wait on. */
  takeLiving(): ResultPromise[] {
    const living = [...this.procs];
    this.procs.clear();
    return living;
  }

  /** Signals every command still running, by process group. */
  kill(signal: NodeJS.Signals): void {
    for (const proc of this.procs) {
      try {
        if (proc.pid) {
          process.kill(-proc.pid, signal);
        }
      } catch {
        /* already gone */
      }
    }
  }

  private emit(): void {
    callEach(this.listeners, undefined);
  }

  /**
   * Runs one `stackctl infra …` command to its exit, its output going to the session log line by
   * line. It is kept among the commands running, and in
   * the session record, until it exits. Its end is logged, unless the session's shutdown stopped
   * it: a shutdown logs no end line for what it waits on.
   */
  private async runCommand(service: string, args: string[], by: EventBy): Promise<void> {
    const title = `stackctl ${args.join(' ')}`;
    this.opts.log(service, chalk.cyan(`▶ running: ${title}`), false);
    const [node, ...cliArgs] = this.opts.cli;
    const child = execa(node!, [...cliArgs, ...args, '--mode', this.opts.mode], {
      cwd: this.opts.cwd,
      env: { ...colorEnv(), [EVENT_BY_ENV]: JSON.stringify(by) },
      // Its own process group, so a shutdown can take down whatever it spawned with it.
      detached: true,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      buffer: false,
      reject: false,
    });
    this.procs.add(child);
    this.opts.track?.(child, this.opts.cwd);
    forEachLine(child.stdout, (line) => this.opts.log(service, line, false));
    forEachLine(child.stderr, (line) => this.opts.log(service, line, true));

    const { exitCode } = await child;
    this.procs.delete(child);
    if (this.stopped) {
      return;
    }
    const code = exitCode ?? 1;
    if (code === 0) {
      this.opts.log(service, chalk.green(`✔ ${title} finished`), false);
    } else {
      this.opts.log(service, chalk.red(`✘ ${title} exited with code ${String(code)}`), true);
    }
  }
}

/**
 * The session's environment for a child whose output is piped: piped, it would print without
 * color, so it is told the session's color level.
 */
function colorEnv(): NodeJS.ProcessEnv {
  return chalk.level === 0 ? process.env : { ...process.env, FORCE_COLOR: String(chalk.level) };
}

/**
 * Calls `onLine` with each line `stream` carries that isn't blank, without its newline (nor a
 * `\r` before it) and with any terminal-title sequences taken out. The last line goes out when the
 * stream ends, newline or not.
 */
function forEachLine(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) {
    return;
  }
  let partial = '';
  const send = (line: string) => {
    if (line.trim() !== '') {
      onLine(line);
    }
  };
  stream.on('data', (chunk: Buffer) => {
    partial += stripTitleSequences(chunk.toString());
    let newline = partial.indexOf('\n');
    while (newline !== -1) {
      send(partial.slice(0, newline).replace(/\r$/, ''));
      partial = partial.slice(newline + 1);
      newline = partial.indexOf('\n');
    }
  });
  stream.on('end', () => send(partial));
}
