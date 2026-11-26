import { EventEmitter } from 'node:events';
import path from 'node:path';
import chalk from 'chalk';
import { STACKCTL_LABEL_COLOR } from '../colors';
import { type AnyServiceConfig, findService, getDevScript, getRegisteredPackages } from '../config';
import {
  EnvFileSnapshot,
  envCandidatePaths,
  envDirs,
  serviceEnvOptions,
  withoutWorkspaceEnv,
  ENV_KEYS_FILENAME,
  envFileOrder,
  envKeysFile,
  packageEnvLayer,
} from '../env';
import { type EnvWatch, type WatchTarget, watchEnvFiles } from '../env-watch';
import { commandLine, logTimestamp } from '../format';
import {
  type InternalLoggers,
  createInternalLogger,
  formatInternalRecord,
} from '../internal-logger';
import { type Paint, paintOfColor } from '../label-paint';
import {
  ABORTED,
  type AbandonCause,
  type HookOutcome,
  abandonedLine,
  failedLine,
  raceAbort,
  skippedLine,
} from '../lifecycle/hooks';
import type { ServiceHooks } from '../lifecycle/service-hooks';
import type {
  ServiceCallbacks,
  ServiceStartTrigger,
  ServiceStopTrigger,
} from '../lifecycle/service-types';
import { labelColorOf } from '../log-colors';
import { defaultFormatter } from '../log-formatter';
import { CONFIG_CHANGE_NOTE, restartCommand, retryAdvice } from '../retry-advice';
import { type ExecSpec, scriptExec, menuCommandsOf, definesDevScript } from '../scripts';
import { depsOf } from '../selection-plan';
import type { ServiceGroups } from '../service-usage';
import { COMMAND_END_GRACE_MS } from '../spawn';
import { sessionTrustFile } from '../trust-file';
import { callEach } from '../util';
import type { LogStore } from './log-store';
import { waitsFor } from './plan';
import { type Clock, type Readiness, systemClock } from './readiness';
import {
  ChildRecords,
  type ProcessExit,
  type ProcessState,
  ServiceProcess,
  type ServiceProcessEvents,
  type ServiceProcessOptions,
} from './service-process';
import type { LogLabel, SessionPlan } from './types';

/** Where a service is in its life, as the session sees it. */
export type ServiceState =
  | 'pending'
  | 'waiting'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'stopped'
  | 'crashed'
  /** Its process runs, but a start hook after the spawn failed: it never counts as ready. */
  | 'failed';

/** A service's status as the control API, `/events` and the dev reverse proxy report it. */
export type PublicStatus = 'running' | 'stopped' | 'waiting' | 'restarting' | 'failed';

/**
 * The public status of a state: held services read `waiting`, a process being spawned already
 * reads `running`, a crash reads `stopped`, and a failed hook `failed`.
 */
export function publicStatus(s: ServiceState): PublicStatus {
  switch (s) {
    case 'pending':
    case 'waiting':
      return 'waiting';
    case 'starting':
    case 'running':
      return 'running';
    case 'restarting':
      return 'restarting';
    case 'stopped':
    case 'crashed':
      return 'stopped';
    case 'failed':
      return 'failed';
  }
}

/** One service, as {@link Supervisor.states} reports it. */
export interface ServiceStatus {
  state: ServiceState;
  /**
   * The code of the dev process's last exit, kept until the next start; `null` unless it exited by
   * itself or failed to spawn. A stop, a restart's stop or the shutdown leaves no code.
   */
  exitCode: number | null;
  /**
   * Its process runs, its healthcheck (when it has one) passes, and its start hooks after the
   * spawn (`afterStart`, `afterReady`) have finished without failing.
   */
  ready: boolean;
  /** The dev process's pid, which is also its group's id; `null` when none runs. */
  pid: number | null;
  /**
   * The `lifecycle` hook of its own that runs now, or `null`: a start hook of its latest start, or
   * the stop hook a stop still runs, which a stop asked for now abandons.
   */
  hook: keyof ServiceCallbacks | null;
}

/** What the Supervisor needs of a process: what {@link ServiceProcess} does. */
export interface SupervisedProcess {
  readonly state: ProcessState;
  readonly pid: number | null;
  readonly exitCode: number | null;
  start(): void;
  stop(): Promise<ProcessExit>;
  kill(): void;
  on(event: 'state', listener: (...args: ServiceProcessEvents['state']) => void): unknown;
  on(event: 'exit', listener: (...args: ServiceProcessEvents['exit']) => void): unknown;
}

/**
 * What a {@link Supervisor} emits. `change` fires on every change of what
 * {@link Supervisor.states} reports, and when a service joins the session. A listener that
 * throws is skipped over: the others still hear the event.
 */
export type SupervisorEvents = {
  change: [];
  /** A service's dev process exited, or never started, and no stop asked it to. */
  exit: [name: string, exitCode: number | null, signal: string | null];
  /**
   * A `.env` file in `dir` (relative to the workspace) changed: `services` restart. `byHook`: it
   * restarts nothing because it is what a service's own `beforeStart` wrote, which its process
   * gets, or will, without one.
   */
  'env-change': [dir: string, services: string[], byHook: boolean];
};

/** How a one-off command ended, or `null` when it never ran (no such service, or shutting down). */
export type OneOffResult = { exitCode: number | null; signal: string | null } | null;

/** A one-off command of the commands menu: a script or make target, or a shell command line. */
export type OneOff = string | { shell: string };

/** How an {@link Supervisor.add} went. */
export type AddOutcome = 'done' | 'closing' | 'unknown';

/** How long the first `.env` read may take before a `[stackctl]` warning names what it waits on. */
const ENV_READ_WARN_MS = 3_000;

/** How long the `.env` changes one directory's watch targets report count as one: see `watchEnv`. */
const ENV_CHANGE_MERGE_MS = 50;

const unpainted: Paint = (text) => text;

/**
 * How a service's label is painted: in its {@link labelColorOf label color}, its `color` or the
 * palette's for its position in the session. A `color` that is none of hex, `rgb(…)`,
 * `ansi256(…)` or a chalk foreground color name leaves the label uncolored.
 */
function paintFor(color: string | undefined, index: number): Paint {
  return paintOfColor(labelColorOf(color, index)) ?? unpainted;
}

/**
 * Whether the service's dev process runs now, as a `.env` change sees it: `running`, `starting`,
 * or `failed` (a start hook failed after the spawn) with its process still up.
 */
function runsNow(svc: Service): boolean {
  return (
    svc.state === 'running' || svc.state === 'starting' || (svc.state === 'failed' && !!svc.proc)
  );
}

interface Service {
  readonly config: AnyServiceConfig;
  /** The gutter label, painted by the service's position when it joined. */
  readonly label: LogLabel;
  /** The filter key: the name, lowercased. */
  readonly key: string;
  /** Whether its lines show their timestamp on screen. */
  readonly showTs: boolean;
  state: ServiceState;
  exitCode: number | null;
  /** The dev process it owns. A stop lets go of it at once; the process may still be exiting. */
  proc: SupervisedProcess | null;
  /**
   * The process a stop let go of while its `beforeStop` runs, until it is signalled: it still
   * runs, can be reached, and its pid is the service's.
   */
  leaving: SupervisedProcess | null;
  /** The wait on its deps, while it waits. */
  wait: AbortController | null;
  /** The restart under way. */
  restart: Promise<RestartOutcome> | null;
  /**
   * Bumped by every start, stop and restart. A start held for the first `.env` read goes ahead
   * only while it is still the latest.
   */
  turn: number;
  /** The exit of the process a stop let go of, while it is still exiting. */
  exiting: Promise<unknown> | null;
  /** The read of its `.env` files, while the add that brought it into the session reads them. */
  reading: Promise<void> | null;
  /** An add asked for it: its launch ignores `autostart: false`. */
  asked: boolean;
  /**
   * The error of the start hook that failed it, until its next start or its process's end: its
   * `afterStart`'s or `afterReady`'s while it is `failed`, its `beforeStart`'s while it is
   * `crashed` with no process ever spawned.
   */
  failure: string | null;
  /** Called when its health flips to passing, while its `afterReady` waits for that. */
  healthWait: ((healthy: boolean) => void) | null;
  /**
   * What its `.env` files read as when its process was spawned, kept when a `beforeStart` ran
   * before that spawn ({@link Supervisor.envFingerprint}); `null` otherwise.
   */
  spawnedWith: string | null;
  /** The stop under way, from its `beforeStop` to its `afterStop`. */
  stopRun: StopRun | null;
  /** Its latest start's hooks, until a newer request supersedes them. */
  startRun: StartRun | null;
  /**
   * The commands of start hooks a newer request abandoned, while they are still ending: the
   * stop hooks and the next start wait for it.
   */
  ending: Promise<void> | null;
  /**
   * What the shutdown stops of it, fixed as it begins: `quit` for a process of its own, the stop
   * it overtook (whose `beforeStop` is its own, and whose `afterStop` the shutdown runs), or
   * `null` with nothing running.
   */
  shutdownStop: 'quit' | StopRun | null;
}

/** A requested stop (or a restart's) under way, from its `beforeStop` to its `afterStop`. */
interface StopRun {
  readonly trigger: ServiceStopTrigger;
  readonly data: Record<string, unknown>;
  /** The process it stops. */
  readonly proc: SupervisedProcess;
  /** The stop hook it runs now, until it settles. */
  hook: RunningHook | null;
  /** Its `afterStop` has begun, or has been left to the shutdown, which then runs it. */
  afterBegun: boolean;
}

/** A start's hooks, from its `beforeStart` to its `afterReady`. */
interface StartRun {
  /** Aborting it abandons the hook it runs now, ending its commands; none of its hooks runs after. */
  readonly abandon: AbortController;
  /** The start hook it runs now. */
  hook: 'beforeStart' | 'afterStart' | 'afterReady' | null;
}

/**
 * How long a step waits for the commands of an abandoned start hook to end before it goes on
 * without them: the time they have before they are killed, and a moment for their output.
 */
const COMMANDS_END_WAIT_MS = COMMAND_END_GRACE_MS + 1_000;

/** A stop hook running now. */
interface RunningHook {
  readonly hook: 'beforeStop' | 'afterStop';
  readonly outcome: Promise<HookOutcome>;
  /** Aborting it abandons the hook, and kills the commands it runs. */
  readonly abandon: AbortController;
  /**
   * Why it was abandoned: its time at the shutdown was up, a second stop was asked for, or
   * everything was killed.
   */
  why: 'budget' | 'again' | 'kill' | null;
  /** Its outcome has been logged. */
  reported: boolean;
}

/** How a {@link Supervisor.restart} ended: the service started again, or a stop or the shutdown came first. */
export type RestartOutcome = 'done' | 'cancelled';

/**
 * Every service process of a session: starts, stops and restarts them, holds a service until the
 * services it waits on are ready, adds services mid-session, restarts a service when its `.env`
 * files change, and runs the commands menu's one-offs. Every line they log goes to the
 * {@link LogStore} under the service's label, and stackctl's own records through {@link log}.
 *
 * Nothing spawns before the first read of the `.env` files, which begins when it is created. It
 * polls nothing: it acts on process, readiness and file-watch events.
 */
export class Supervisor extends EventEmitter<SupervisorEvents> {
  /**
   * stackctl's own records: `system` lines go under `[stackctl]`, `control` lines under
   * `[control]`, filed under the service a `service` attribute names when it is in the session.
   */
  readonly log: InternalLoggers;
  /** The session's child records, which every process it spawns is added to. */
  readonly records: ChildRecords;

  private readonly plan: SessionPlan;
  private readonly logs: LogStore;
  private readonly readiness: Readiness;
  private readonly clock: Clock;
  private readonly createProcess: (opts: ServiceProcessOptions) => SupervisedProcess;
  private readonly hooks: ServiceHooks | undefined;
  /** The session shows the terminal UI: a line can name its keys. */
  private readonly interactive: boolean;
  /** Where the CLI anchored, the config's folder: the session's records and trust file. */
  private readonly root: string;
  /** The workspace root the `.env` files are walked up to: the config's `workspaceDir`. */
  private readonly resolvedWorkspaceDir: string;
  private readonly envFiles: string[];
  private readonly snapshot = new EnvFileSnapshot();
  private readonly services = new Map<string, Service>();
  /** Every process still running, dev and one-off alike, by the service it belongs to. */
  private readonly live = new Map<SupervisedProcess, string>();
  private readonly stackctlLabel: LogLabel;
  private readonly controlLabel: LogLabel;
  private readonly firstRead: Promise<void>;
  private envRead = false;
  private warnTimer: unknown;
  private watch: EnvWatch | null = null;
  private launched = false;
  private readonly onReadiness = (name: string) => this.readinessChanged(name);
  private readonly onHealthy = (name: string, healthy: boolean) => {
    if (healthy) {
      this.services.get(name)?.healthWait?.(true);
    }
  };
  private closing = false;
  /** Everything was killed: no hook is reported from here on. */
  private killed = false;
  private stopping: Promise<void> | null = null;
  /** Every stop hook running now. */
  private readonly stopHooks = new Set<RunningHook>();
  /** Adds run one at a time, in the order asked. */
  private adds: Promise<unknown> = Promise.resolve();

  constructor(opts: {
    plan: SessionPlan;
    logs: LogStore;
    readiness: Readiness;
    clock?: Clock;
    /** Makes each process; a {@link ServiceProcess} unless given. */
    createProcess?: (opts: ServiceProcessOptions) => SupervisedProcess;
    /** The services' `lifecycle` hooks; none run without it. */
    hooks?: ServiceHooks;
    /** The session shows the terminal UI; not unless given. */
    interactive?: boolean;
  }) {
    super();
    this.plan = opts.plan;
    this.logs = opts.logs;
    this.readiness = opts.readiness;
    this.clock = opts.clock ?? systemClock;
    this.createProcess = opts.createProcess ?? ((o) => new ServiceProcess(o));
    this.hooks = opts.hooks;
    this.interactive = opts.interactive ?? false;
    this.root = this.plan.cwd ?? process.cwd();
    this.resolvedWorkspaceDir = this.plan.resolvedWorkspaceDir ?? this.root;
    this.envFiles = this.plan.envFiles ?? envFileOrder();
    this.records = new ChildRecords(this.root);
    const gold = chalk.hex(STACKCTL_LABEL_COLOR);
    this.stackctlLabel = { name: 'stackctl', paint: gold };
    this.controlLabel = { name: 'control', paint: gold };
    this.logs.addLabels([this.stackctlLabel.name, this.controlLabel.name]);
    this.log = createInternalLogger((line) => this.internal(line));

    this.plan.sortedPackages.forEach((config, index) => this.join(config, index));
    this.readiness.on('ready', this.onReadiness);
    this.readiness.on('unready', this.onReadiness);
    this.readiness.on('healthy', this.onHealthy);

    this.warnTimer = this.clock.setTimeout(() => {
      this.warnTimer = undefined;
      this.log.system.warn(
        `waiting to read ${this.snapshot.reading ?? 'the .env files'} before starting services; if it is in a cloud-synced folder, the system may be asking for permission to access it`,
      );
    }, ENV_READ_WARN_MS);
    this.firstRead = this.snapshot
      .refresh([
        ...this.plan.sortedPackages.flatMap((p) => this.envPaths(p)),
        ...(this.plan.envDecrypt ? [envKeysFile(this.resolvedWorkspaceDir)] : []),
      ])
      .catch(() => {})
      .then(() => {
        this.envRead = true;
        this.clearWarnTimer();
        if (!this.closing) {
          this.watchEnv();
        }
      });
  }

  /**
   * Launches every service in session order: one with `autostart: false` or no dev command is
   * left `stopped` (unless an add asked for it); one that waits on others is `waiting` until they
   * are ready; the rest start. Only the first call does anything. Every start hook it runs, a
   * waiter's included, gets the trigger `session` and `data`.
   */
  launchAll(data: Record<string, unknown> = {}): void {
    if (this.launched || this.closing) {
      return;
    }
    this.launched = true;
    for (const svc of this.services.values()) {
      if (svc.state === 'pending' && svc.turn === 0) {
        this.launch(svc, svc.asked, 'session', data);
      }
    }
  }

  /**
   * Starts a service now. Does nothing while shutting down, for a name not in the session, one
   * already running or restarting, one with no dev command, or one waiting for its deps: it starts
   * once they're ready, never before.
   * The start waits for the first `.env` read, and for a process a stop let go of to finish
   * exiting, so one service never runs two copies; it resolves once it has happened, its start
   * hooks included. Its hooks get the trigger `start` and `data`.
   */
  start(name: string, data: Record<string, unknown> = {}): Promise<void> {
    const svc = this.services.get(name);
    if (
      !svc ||
      this.closing ||
      svc.proc ||
      svc.state === 'restarting' ||
      svc.state === 'waiting' ||
      !definesDevScript(svc.config)
    ) {
      return Promise.resolve();
    }
    return this.begin(svc, 'start', data);
  }

  /**
   * Stops a service. One that is held (waiting, or pending a start) is `stopped` at once, with no
   * line; a running one is `stopped` at once and its readiness dropped, then logs `stopping...`,
   * runs its `beforeStop`, signals its process and, once it has exited, logs `stopped` and runs
   * its `afterStop`. Its stop hooks get the trigger `stop` and `data`. A restart under way starts
   * nothing after it: the service ends `stopped`. A stop while an earlier stop's (or a restart's)
   * `beforeStop` or `afterStop` still runs abandons that hook, killing its commands, with a line
   * saying so: from a `beforeStop`, the process is signalled at once. Resolves once the service's
   * process, if any, has exited and its `afterStop` has finished. Once shutting down, it only
   * waits for that: the shutdown stops the service.
   */
  async stop(name: string, data: Record<string, unknown> = {}): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) {
      return;
    }
    svc.turn++;
    svc.restart = null;
    this.cancelWait(svc);
    if (this.closing) {
      await this.exited(svc);
      return;
    }
    this.supersede(svc, 'stopped');
    const hook = svc.stopRun?.hook;
    if (hook) {
      this.abandonHook(hook, 'again');
    }
    if (svc.proc) {
      await this.halt(svc, 'stopped', 'stop', data);
      return;
    }
    if (svc.state === 'pending' || svc.state === 'waiting' || svc.state === 'restarting') {
      this.setState(svc, 'stopped');
    }
    await this.exited(svc);
  }

  /**
   * Restarts a service: stops it (with its lines and its stop hooks), reads the `.env` files
   * again, starts it and logs `restarted`. A stopped service is just started; one waiting for its
   * deps is left waiting. A restart already under way is the one returned. Its start waits for a
   * process an earlier stop let go of to finish exiting; nothing starts once shutting down, or
   * after a stop issued meanwhile. Its stop and start hooks get the trigger `restart` and `data`;
   * once its process has spawned, a further restart is a new one. Resolves `done` once it has
   * started the service again (or tried to: a start that failed is done too), `cancelled` when a
   * stop or the shutdown came first, or nothing was restarted.
   */
  restart(name: string, data: Record<string, unknown> = {}): Promise<RestartOutcome> {
    return this.restartFor(name, 'restart', data);
  }

  private restartFor(
    name: string,
    trigger: 'restart' | 'env',
    data: Record<string, unknown>,
  ): Promise<RestartOutcome> {
    const svc = this.services.get(name);
    if (!svc || this.closing || svc.state === 'waiting') {
      return Promise.resolve('cancelled');
    }
    if (!svc.restart) {
      const restart: Promise<RestartOutcome> = this.restartNow(svc, trigger, data).finally(() => {
        if (svc.restart === restart) {
          svc.restart = null;
        }
      });
      svc.restart = restart;
    }
    return svc.restart;
  }

  /**
   * Adds a service the config has, and its direct deps the session doesn't have yet. Each joins
   * the session (logging `added to the session`), their `.env` files are read, and each is
   * launched as {@link launchAll} would, except that the service asked for starts whatever its
   * `autostart`. `done` when it is in the session, now or already; `closing` when shutting down
   * first; `unknown` for a name the config doesn't have.
   */
  add(name: string): Promise<AddOutcome> {
    const next = this.adds.then(() => this.addNow(name));
    this.adds = next.catch(() => {});
    return next;
  }

  /**
   * Runs a one-off command for a service, alongside its dev process and without touching its
   * state: a script or make target, or a shell command line. Its output goes under the service's
   * label, framed by `▶ running: …` and `✔ … finished` or `✘ … exited with code <n>`. Resolves
   * with how it ended once it has exited; `null` for a name not in the session, and once shutting
   * down.
   */
  async runOneOff(name: string, command: OneOff): Promise<OneOffResult> {
    const svc = this.services.get(name);
    if (!svc || this.closing) {
      return null;
    }
    await this.firstRead;
    if (this.closing) {
      return null;
    }
    const title = typeof command === 'string' ? command : command.shell;
    this.status(svc, chalk.cyan(`▶ running: ${title}`));
    let spec: { command: string; env: NodeJS.ProcessEnv };
    try {
      const env = this.envFor(svc.config);
      if (typeof command === 'string') {
        const exec = scriptExec(svc.config, command, [], env);
        spec = { command: commandLine(exec.cmd, exec.args), env: exec.env };
      } else {
        spec = { command: command.shell, env };
      }
    } catch (err) {
      this.status(svc, chalk.red(`failed to start: ${(err as Error).message}`), true);
      this.status(svc, chalk.red(`✘ ${title} exited with code 1`), true);
      return { exitCode: 1, signal: null };
    }
    const proc: SupervisedProcess = this.createProcess({
      name,
      command: spec.command,
      cwd: svc.config.resolvedDir,
      env: spec.env,
      onLine: (text, isError) => this.line(svc, proc, text, isError),
      records: this.records,
    });
    this.live.set(proc, name);
    return new Promise<OneOffResult>((resolve) => {
      proc.on('exit', (exit) => {
        this.live.delete(proc);
        if (!this.closing) {
          const code = proc.exitCode ?? 1;
          if (code === 0) {
            this.status(svc, chalk.green(`✔ ${title} finished`));
          } else {
            this.status(svc, chalk.red(`✘ ${title} exited with code ${code}`), true);
          }
        }
        resolve({ exitCode: exit.code, signal: exit.signal });
      });
      proc.start();
    });
  }

  /**
   * A service's `.env` files changed: one that runs right now logs `.env changed, restarting...`
   * and restarts, its start hooks with the trigger `env`; so does a `failed` one, whose process
   * still runs. A held, restarting or stopped one is left alone; its next start reads the files as
   * they are then.
   */
  async envChanged(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc || this.closing || !runsNow(svc)) {
      return;
    }
    this.status(svc, chalk.cyan('.env changed, restarting...'));
    await this.restartFor(name, 'env', {});
  }

  /**
   * The shutdown begins: from now on nothing starts, and no wait or probe goes on. What runs keeps
   * running, and can still be reached, until {@link stopAll}: the shutdown's `beforeStop` hooks
   * run in between. What it stops of each service is fixed now ({@link running}). Only the first
   * call does anything.
   */
  beginShutdown(): void {
    this.close();
  }

  /**
   * The services the shutdown stops a dev process of: each with a process of its own, and each
   * whose stop (or restart) was under way as the shutdown began. Their stop hooks are the
   * shutdown's to run ({@link runStopHooks}). Empty before {@link beginShutdown}.
   */
  running(): string[] {
    return [...this.services.values()]
      .filter((svc) => svc.shutdownStop !== null)
      .map((svc) => svc.config.name);
  }

  /** Whether any of the services called `names` has `hook`. */
  hasStopHook(names: readonly string[], hook: 'beforeStop' | 'afterStop'): boolean {
    return !!this.hooks && names.some((name) => this.hooks!.has(name, hook));
  }

  /**
   * Runs the shutdown's `hook` for each of `names` ({@link running}) in parallel, with `data`,
   * each abandoned once `budget` aborts (its commands killed, a line saying so). A service with a
   * process of its own gets the trigger `quit`. One whose stop was under way keeps its own: its
   * `beforeStop` still running is waited for, within `budget`, and none is run anew; its
   * `afterStop`, unless it has begun, is run now with its stop's trigger and `data`. A failure is
   * an error line under the service. Resolves once every one has settled or been abandoned.
   */
  async runStopHooks(
    hook: 'beforeStop' | 'afterStop',
    names: readonly string[],
    data: Record<string, unknown>,
    budget: AbortSignal,
  ): Promise<void> {
    await Promise.all(names.map((name) => this.shutdownHook(name, hook, data, budget)));
  }

  /** One service's part of {@link runStopHooks}. */
  private async shutdownHook(
    name: string,
    hook: 'beforeStop' | 'afterStop',
    data: Record<string, unknown>,
    budget: AbortSignal,
  ): Promise<void> {
    const svc = this.services.get(name);
    const stop = svc?.shutdownStop;
    if (!svc || !stop || !this.hooks) {
      return;
    }
    if (stop === 'quit') {
      if (this.hooks.has(name, hook) && this.timeLeft(svc, hook, budget)) {
        const running = this.runStopHook(svc, hook, 'quit', data, budget, svc.ending);
        await this.settleWithin(svc, running, budget);
      }
      return;
    }
    // A stop the shutdown overtook: its own hooks, once each.
    if (hook === 'afterStop' && !stop.afterBegun) {
      stop.afterBegun = true;
      if (this.hooks.has(name, 'afterStop') && this.timeLeft(svc, hook, budget)) {
        stop.hook = this.runStopHook(svc, 'afterStop', stop.trigger, stop.data, budget, svc.ending); // oxfmt-ignore
      }
    }
    if (stop.hook?.hook === hook) {
      await this.settleWithin(svc, stop.hook, budget);
    }
  }

  /**
   * Whether `budget` leaves time to begin the service's `hook`. When it doesn't (the session's own
   * hook took it all), a line says the hook was skipped; none once everything was killed.
   */
  private timeLeft(svc: Service, hook: 'beforeStop' | 'afterStop', budget: AbortSignal): boolean {
    if (!budget.aborted) {
      return true;
    }
    if (!this.killed) {
      this.status(svc, chalk.yellow(skippedLine(hook)));
    }
    return false;
  }

  /**
   * The graceful stop of every process: from its first moment nothing new starts, every wait and
   * probe stops and every service is `stopped`; then each running process (dev, one-off, or one a
   * stop is still waiting on) gets SIGTERM, and SIGKILL if it outlives the grace period. Logs
   * nothing. Resolves once every one has exited. Every call gets the same promise.
   *
   * It signals no group whose leader has exited; the caller SIGKILLs the groups {@link groups}
   * listed before it began, once it resolves.
   */
  stopAll(): Promise<void> {
    if (!this.stopping) {
      this.close();
      this.release();
      this.stopping = Promise.all([...this.live.keys()].map((proc) => proc.stop())).then(() => {});
    }
    return this.stopping;
  }

  /**
   * An immediate SIGKILL to every process still running, those in a stop's grace period included,
   * and every stop hook still running abandoned, its commands killed. Nothing starts after it, and
   * no hook's outcome is logged.
   */
  killEverything(): void {
    // First, so nothing it interrupts is reported.
    this.killed = true;
    this.close();
    this.release();
    for (const hook of this.stopHooks) {
      this.abandonHook(hook, 'kill');
    }
    for (const proc of this.live.keys()) {
      proc.kill();
    }
  }

  /** Every service in session order, with its state. */
  states(): ReadonlyMap<string, ServiceStatus> {
    const states = new Map<string, ServiceStatus>();
    for (const [name, svc] of this.services) {
      states.set(name, {
        state: svc.state,
        exitCode: svc.exitCode,
        ready: publicStatus(svc.state) === 'running' && this.readiness.isReady(name),
        pid: (svc.proc ?? svc.leaving)?.pid ?? null,
        hook: (!this.closing && (svc.stopRun?.hook?.hook ?? svc.startRun?.hook)) || null,
      });
    }
    return states;
  }

  /**
   * Whether a dev process of the service's runs and can be reached: its own, or one a stop has
   * let go of while its `beforeStop` runs, before it is signalled.
   */
  hasProcess(name: string): boolean {
    const svc = this.services.get(name);
    return !!(svc?.proc ?? svc?.leaving);
  }

  /**
   * Why a start hook left the service unable to get ready, as `<hook> failed: <message>`: its
   * `afterStart`'s or `afterReady`'s error for a `failed` one, whose process runs, or its
   * `beforeStart`'s for one that was never started for it (it reads `stopped`). `null` for a
   * service no start hook failed, or not in the session.
   */
  failure(name: string): string | null {
    const svc = this.services.get(name);
    return svc?.state === 'failed' || svc?.state === 'crashed' ? svc.failure : null;
  }

  /**
   * Why a `waiting` service can't start while a service it waits on was failed by a start hook,
   * directly or through services that wait in turn: `waiting for api, which failed: <its error>.
   * Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a
   * new session`; `which failed to start: …` for one its `beforeStart` failed; or, through `api`
   * waiting on a failed `db`, `waiting for api, which waits for db, which failed: …`
   * ({@link failure}). One sentence for each failed service, every one after the first starting
   * with a capital. `null` while none has failed, and for a service not waiting.
   */
  blockedBy(name: string): string | null {
    const svc = this.services.get(name);
    if (svc?.state !== 'waiting') {
      return null;
    }
    const why = this.failedUpstream(name, new Set([name])).map(
      ({ via, dep, failure }) =>
        `waiting for ${[...via, dep].join(', which waits for ')}, which ${this.failedAs(dep)}: ${failure}. ` +
        retryAdvice(dep),
    );
    const sentences = why.map((sentence, i) =>
      i === 0 ? sentence : sentence.charAt(0).toUpperCase() + sentence.slice(1),
    );
    return sentences.length > 0 ? sentences.join('. ') : null;
  }

  /** How a service a start hook failed is said to have failed: its process runs, or never started. */
  private failedAs(name: string): 'failed' | 'failed to start' {
    return this.services.get(name)?.state === 'failed' ? 'failed' : 'failed to start';
  }

  /**
   * Each service a start hook failed that `name` waits on, directly or through services that are
   * `waiting` in turn (`via`, in order), once each; `seen` keeps a cycle from looping.
   */
  private failedUpstream(
    name: string,
    seen: Set<string>,
  ): { via: string[]; dep: string; failure: string }[] {
    const found: { via: string[]; dep: string; failure: string }[] = [];
    for (const dep of this.plan.waitsOn[name] ?? []) {
      if (seen.has(dep)) {
        continue;
      }
      seen.add(dep);
      const failure = this.failure(dep);
      if (failure !== null) {
        found.push({ via: [], dep, failure });
      } else if (this.services.get(dep)?.state === 'waiting') {
        for (const upstream of this.failedUpstream(dep, seen)) {
          found.push({ ...upstream, via: [dep, ...upstream.via] });
        }
      }
    }
    return found;
  }

  /**
   * A line one of a service's `lifecycle` hooks logged, or a command it ran printed, under the
   * service's label: red when `isError`. Nothing for a name not in the session.
   */
  hookLine(name: string, text: string, isError: boolean): void {
    const svc = this.services.get(name);
    if (svc) {
      this.status(svc, isError ? chalk.red(text) : text, isError);
    }
  }

  /** The process groups each service has running now: its dev process and its one-offs. */
  groups(): ServiceGroups {
    const groups = new Map<string, number[]>();
    for (const [proc, name] of this.live) {
      if (proc.pid !== null) {
        groups.set(name, [...(groups.get(name) ?? []), proc.pid]);
      }
    }
    return groups;
  }

  /**
   * A service joins: its label by its position now, counted in the log's label width, `pending`,
   * and tracked for readiness.
   */
  private join(config: AnyServiceConfig, index: number): Service {
    this.logs.addLabels([config.name]);
    const svc: Service = {
      config,
      label: { name: config.name, paint: paintFor(config.color, index) },
      key: config.name.toLowerCase(),
      showTs: config.logs?.timestamps ?? this.plan.logTimestamps ?? true,
      state: 'pending',
      exitCode: null,
      proc: null,
      leaving: null,
      wait: null,
      restart: null,
      turn: 0,
      exiting: null,
      reading: null,
      asked: false,
      failure: null,
      healthWait: null,
      spawnedWith: null,
      stopRun: null,
      startRun: null,
      ending: null,
      shutdownStop: null,
    };
    this.services.set(config.name, svc);
    this.readiness.track(config.name, this.plan.healthchecks[config.name]);
    return svc;
  }

  /**
   * Launches a service as the session's start does; `force` ignores `autostart: false`. Its start
   * hooks get `trigger` and `data`.
   */
  private launch(
    svc: Service,
    force: boolean,
    trigger: ServiceStartTrigger,
    data: Record<string, unknown>,
  ): void {
    if (this.closing) {
      return;
    }
    if ((!force && svc.config.autostart === false) || !definesDevScript(svc.config)) {
      this.setState(svc, 'stopped');
      return;
    }
    const deps = this.plan.waitsOn[svc.config.name] ?? [];
    if (deps.length === 0) {
      void this.begin(svc, trigger, data);
      return;
    }
    const wait = new AbortController();
    svc.wait = wait;
    this.setState(svc, 'waiting');
    this.status(svc, chalk.cyan(`waiting for ${deps.join(', ')}...`));
    for (const dep of deps) {
      const failure = this.failure(dep);
      if (failure !== null) {
        this.toldWaiting(svc, dep, failure);
      }
    }
    this.readiness.whenReady(deps, wait.signal).then(
      () => {
        if (svc.wait !== wait || this.closing) {
          return;
        }
        svc.wait = null;
        this.status(svc, chalk.green(`${deps.join(', ')} ready, starting...`));
        void this.begin(svc, trigger, data);
      },
      () => {
        /* stopped, started or shut down while it waited */
      },
    );
  }

  /**
   * Starts a service once the first `.env` read is done, unless something else happened first:
   * its `beforeStart`, the spawn, its `afterStart`.
   */
  private async begin(
    svc: Service,
    trigger: ServiceStartTrigger,
    data: Record<string, unknown>,
  ): Promise<void> {
    const turn = ++svc.turn;
    this.supersede(svc, 'started');
    this.cancelWait(svc);
    if (!this.envRead || svc.reading || svc.exiting || svc.ending) {
      this.setState(svc, 'pending');
      await this.firstRead;
      await svc.reading;
      await this.exited(svc);
      if (svc.turn !== turn || this.closing) {
        return;
      }
    }
    await this.startProcess(svc, turn, trigger, data);
  }

  /**
   * A start's sequence, for the start or restart on `turn`: its `beforeStart` (held `pending`
   * meanwhile; a restart's stays `restarting`), a read of the `.env` files the hook may have
   * written, the spawn, `spawned`, its `afterStart`. Nothing after the hook once a newer start,
   * stop or restart, or the shutdown, came first: that abandons the hook ({@link supersede}). A
   * hook that failed ends the service as a start that failed. Without a `beforeStart` nothing is
   * awaited before the spawn: a start spawns in the tick it is free to. Resolves `false` when a
   * newer request or the shutdown came first.
   */
  private async startProcess(
    svc: Service,
    turn: number,
    trigger: ServiceStartTrigger,
    data: Record<string, unknown>,
    spawned?: () => void,
  ): Promise<boolean> {
    const name = svc.config.name;
    const run: StartRun = { abandon: new AbortController(), hook: null };
    svc.startRun = run;
    if (this.hooks?.has(name, 'beforeStart')) {
      if (svc.state !== 'restarting') {
        this.setState(svc, 'pending');
      }
      svc.failure = null;
      const outcome = await this.startHook(svc, run, 'beforeStart', trigger, data);
      if (outcome === 'abandoned') {
        return false;
      }
      if (typeof outcome !== 'object') {
        // The process gets what the hook wrote to the `.env` files.
        await this.snapshot.refresh();
      }
      // Checked right before the spawn, with no await between: the latest request wins.
      if (svc.turn !== turn || this.closing) {
        return false;
      }
      if (typeof outcome === 'object') {
        this.failBeforeStart(svc, failedLine('beforeStart', outcome.error));
        return true;
      }
    }
    const proc = this.spawn(svc, this.hooks?.has(name, 'beforeStart') ?? false);
    spawned?.();
    await this.afterStart(svc, proc, run, turn, trigger, data);
    if (proc) {
      // Not awaited: a start is done once its process runs, however long it takes to get ready.
      void this.afterReady(svc, proc, run, turn, trigger, data);
    }
    return true;
  }

  /**
   * Runs one of the hooks of the start `run`, which a newer request abandons: `abandoned` then,
   * and for a start already superseded, whose hook is never called.
   */
  private async startHook(
    svc: Service,
    run: StartRun,
    hook: 'beforeStart' | 'afterStart' | 'afterReady',
    trigger: ServiceStartTrigger,
    data: Record<string, unknown>,
  ): Promise<HookOutcome> {
    if (run.abandon.signal.aborted) {
      return 'abandoned';
    }
    run.hook = hook;
    this.emitChange();
    const outcome = await this.hooks!.run(svc.config.name, hook, trigger, data, run.abandon.signal);
    if (run.hook === hook) {
      run.hook = null;
      this.emitChange();
    }
    return outcome;
  }

  /**
   * A newer request for the service (it was `stopped`, `restarted` or `started` again), or the
   * session's `quit`, supersedes its latest start: none of that start's hooks runs from now on,
   * and the one running is abandoned, its commands ended, with a line under the service saying
   * so (none once everything was killed). What comes next for the service waits for those
   * commands to have ended ({@link Service.ending}).
   */
  private supersede(svc: Service, cause: AbandonCause): void {
    const run = svc.startRun;
    if (!run) {
      return;
    }
    svc.startRun = null;
    const hook = run.hook;
    run.hook = null;
    run.abandon.abort();
    if (hook === null || !this.hooks) {
      return;
    }
    if (!this.killed) {
      this.status(svc, chalk.yellow(abandonedLine(hook, cause)));
    }
    const ended = this.commandsEnded(svc.config.name);
    const ending: Promise<void> = Promise.all([svc.ending, ended]).then(() => {
      if (svc.ending === ending) {
        svc.ending = null;
      }
    });
    svc.ending = ending;
    this.emitChange();
  }

  /**
   * Resolves once the commands the service's hooks started have ended, or their time to end is
   * up: a command that never ends (one holding its output open from outside its group, say)
   * holds nothing up for longer.
   */
  private commandsEnded(name: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = this.clock.setTimeout(resolve, COMMANDS_END_WAIT_MS);
      void this.hooks!.commandsEnded(name).then(() => {
        this.clock.clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Whether the service's start hooks hold its ready from its spawn until they have finished. */
  private holdsReady(name: string): boolean {
    return (
      !!this.hooks && (this.hooks.has(name, 'afterStart') || this.hooks.has(name, 'afterReady'))
    );
  }

  /** Whether `proc`, spawned on `turn`, is still the service's process, and not shutting down. */
  private current(svc: Service, proc: SupervisedProcess, turn: number): boolean {
    return svc.turn === turn && svc.proc === proc && !this.closing;
  }

  /**
   * Runs the service's `afterReady` once per start of `proc`: when its health first passes, once
   * its `afterStart` has finished (and not after one that failed). Then the hold on its ready is
   * released, or, when the hook failed, the service is `failed`. Nothing of a run whose process is
   * no longer the service's, but the error line of a failure.
   */
  private async afterReady(
    svc: Service,
    proc: SupervisedProcess,
    run: StartRun,
    turn: number,
    trigger: ServiceStartTrigger,
    data: Record<string, unknown>,
  ): Promise<void> {
    const name = svc.config.name;
    if (!this.hooks || !this.holdsReady(name) || !this.current(svc, proc, turn)) {
      return;
    }
    if (svc.state === 'failed') {
      return;
    }
    if (!this.hooks.has(name, 'afterReady')) {
      this.readiness.releaseReady(name, true);
      return;
    }
    if (!(await this.healthy(svc, proc)) || !this.current(svc, proc, turn)) {
      return;
    }
    const outcome = await this.startHook(svc, run, 'afterReady', trigger, data);
    if (this.closing || outcome === 'abandoned') {
      return;
    }
    if (typeof outcome === 'object') {
      const message = failedLine('afterReady', outcome.error);
      if (this.current(svc, proc, turn)) {
        this.fail(svc, message);
      } else {
        this.status(svc, chalk.red(message), true);
      }
      return;
    }
    if (this.current(svc, proc, turn)) {
      this.readiness.releaseReady(name, true);
    }
  }

  /**
   * Resolves `true` once the service is healthy while `proc` is its process: at once when it is;
   * `false` once `proc` is no longer its process.
   */
  private healthy(svc: Service, proc: SupervisedProcess): Promise<boolean> {
    if (this.readiness.isHealthy(svc.config.name)) {
      return Promise.resolve(true);
    }
    svc.healthWait?.(false);
    return new Promise<boolean>((resolve) => {
      svc.healthWait = (healthy) => {
        svc.healthWait = null;
        resolve(healthy && svc.proc === proc);
      };
    });
  }

  /**
   * A start hook after the spawn failed: the service is `failed` with `message`, which is logged
   * as an error; its process keeps running, it is never ready, and each service waiting on it is
   * told why it still waits.
   */
  private fail(svc: Service, message: string): void {
    const name = svc.config.name;
    svc.failure = message;
    this.setState(svc, 'failed');
    this.status(svc, chalk.red(message), true);
    this.readiness.releaseReady(name, false);
    this.tellWaiters(svc);
  }

  /** Tells each service waiting on `svc`, which a start hook just failed, why it still waits. */
  private tellWaiters(svc: Service): void {
    const name = svc.config.name;
    for (const waiter of this.services.values()) {
      if (
        waiter.state === 'waiting' &&
        (this.plan.waitsOn[waiter.config.name] ?? []).includes(name)
      ) {
        this.toldWaiting(waiter, name, svc.failure ?? '');
      }
    }
  }

  /**
   * The line under a waiting service that says the service `dep` it waits on was failed by a
   * start hook, why, and how to restart it: `api failed: <its error>; still waiting for api. Run
   * stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new
   * session` (`api failed to start: …` when its `beforeStart` failed). On the terminal UI it
   * names the key too, which acts on the focused service: `… Once it is fixed, focus api and
   * press r, or run stackctl service restart -s api; a change …`.
   */
  private toldWaiting(svc: Service, dep: string, failure: string): void {
    const how = this.interactive
      ? `Once it is fixed, focus ${dep} and press r, or run ${restartCommand(dep)}; ${CONFIG_CHANGE_NOTE}`
      : retryAdvice(dep);
    this.status(
      svc,
      chalk.yellow(`${dep} ${this.failedAs(dep)}: ${failure}; still waiting for ${dep}. ${how}`),
    );
  }

  /**
   * Runs the service's `afterStart`, if it has one and `proc` spawned. A failure is an error line
   * under the service, and makes it `failed` while `proc` is still its process; the process keeps
   * running.
   */
  private async afterStart(
    svc: Service,
    proc: SupervisedProcess | null,
    run: StartRun,
    turn: number,
    trigger: ServiceStartTrigger,
    data: Record<string, unknown>,
  ): Promise<void> {
    const name = svc.config.name;
    if (!proc || svc.proc !== proc || !this.hooks?.has(name, 'afterStart')) {
      return;
    }
    const outcome = await this.startHook(svc, run, 'afterStart', trigger, data);
    if (typeof outcome !== 'object' || this.closing) {
      return;
    }
    const message = failedLine('afterStart', outcome.error);
    if (this.current(svc, proc, turn)) {
      this.fail(svc, message);
    } else {
      this.status(svc, chalk.red(message), true);
    }
  }

  /**
   * The service's `beforeStart` failed, so nothing was spawned: it is `crashed` (it reads
   * `stopped`) with `message` kept as why ({@link failure}), logged as an error, and each service
   * waiting on it is told why it still waits. No exit is reported: no process ever ran.
   */
  private failBeforeStart(svc: Service, message: string): void {
    svc.exitCode = null;
    svc.failure = message;
    this.setState(svc, 'crashed');
    this.status(svc, chalk.red(`failed to start: ${message}`), true);
    this.tellWaiters(svc);
    // Its state may read the same as before (`crashed` again): what it reports has changed.
    this.emitChange();
  }

  /** A start that failed before any process spawned: the service is `crashed`, with code 1. */
  private failStart(svc: Service, message: string): void {
    svc.exitCode = 1;
    this.setState(svc, 'crashed');
    this.status(svc, chalk.red(`failed to start: ${message}`), true);
    this.status(svc, 'exited with code 1');
    this.emit('exit', svc.config.name, 1, null);
  }

  /**
   * Spawns the service's dev process; the process, or `null` when none was made. `afterHook`: a
   * `beforeStart` ran before it, so what the files read as now is kept, for {@link watchEnv}.
   */
  private spawn(svc: Service, afterHook = false): SupervisedProcess | null {
    if (svc.proc) {
      return null;
    }
    const { config } = svc;
    const name = config.name;
    let spec: ExecSpec;
    try {
      spec = this.devExec(config);
    } catch (err) {
      // Its environment couldn't be built: it ends as a spawn that failed does.
      this.failStart(svc, (err as Error).message);
      return null;
    }
    const proc: SupervisedProcess = this.createProcess({
      name,
      command: commandLine(spec.cmd, spec.args),
      cwd: config.resolvedDir,
      env: spec.env,
      onLine: (text, isError) => this.line(svc, proc, text, isError),
      records: this.records,
    });
    svc.proc = proc;
    svc.exitCode = null;
    svc.failure = null;
    svc.spawnedWith = afterHook ? this.envFingerprint(config) : null;
    this.live.set(proc, name);
    this.setState(svc, 'starting');
    this.status(svc, chalk.green('started'));
    // Put on before it starts: without a healthcheck it is healthy, and so ready, as it starts.
    if (this.holdsReady(name)) {
      this.readiness.holdReady(name);
    }
    this.readiness.processStarted(name);
    proc.on('state', (state) => {
      if (state === 'running' && svc.proc === proc && svc.state === 'starting') {
        this.setState(svc, 'running');
      }
    });
    proc.on('exit', (exit) => {
      this.live.delete(proc);
      // Exited by itself while its stop's beforeStop runs: nothing to reach any more.
      this.letGo(svc, proc);
      // A stop let go of it first, and logs its own lines.
      if (svc.proc !== proc) {
        return;
      }
      svc.proc = null;
      svc.healthWait?.(false);
      const code = proc.exitCode ?? 1;
      svc.exitCode = code;
      // Whatever a start hook said of it, it is now a process that exited.
      svc.failure = null;
      this.setState(svc, exit.code === 0 ? 'stopped' : 'crashed');
      this.processGone(svc);
      this.status(svc, `exited with code ${code}`);
      this.emit('exit', name, exit.code, exit.signal);
    });
    proc.start();
    return proc;
  }

  /**
   * Stops a service's dev process: the service is `next` at once and its ready dropped, then
   * `stopping...`; its `beforeStop`, the signal, and once the process has exited `stopped` and its
   * `afterStop`, each hook with `trigger` and `data`. While its `beforeStop` runs the process can
   * still be reached and its pid is the service's; both end at the signal. Until all of that is
   * done the service is `exiting`, so a start waits for it. A shutdown that overtakes it signals
   * the process all the same, and runs its `afterStop` itself ({@link runStopHooks}); no line.
   */
  private async halt(
    svc: Service,
    next: 'stopped' | 'restarting',
    trigger: ServiceStopTrigger,
    data: Record<string, unknown>,
  ): Promise<void> {
    const proc = svc.proc!;
    const name = svc.config.name;
    svc.proc = null;
    svc.healthWait?.(false);
    svc.exitCode = null;
    svc.failure = null;
    svc.spawnedWith = null;
    const hooked = this.hasStopHooks(name);
    svc.leaving = this.hooks?.has(name, 'beforeStop') ? proc : null;
    const run: StopRun = { trigger, data, proc, hook: null, afterBegun: false };
    svc.stopRun = run;
    // The stop hooks begin only once the state has flipped and `stopping...` is logged: a hook's
    // code runs as soon as it is called, and a restart must read `restarting` at once.
    let flipped = () => {};
    const flip = new Promise<void>((resolve) => (flipped = resolve));
    // Recorded before anything is emitted, so a start a listener makes at once waits for it too.
    const exit = this.stopSequence(svc, run, hooked ? flip : null, svc.ending);
    svc.exiting = exit;
    this.setState(svc, next);
    if (svc.leaving) {
      // Not ready from now on, but still reachable: its health follows the process until the
      // signal.
      this.readiness.holdReady(name);
    } else {
      this.letGoNow(svc);
    }
    this.status(svc, chalk.yellow('stopping...'));
    flipped();
    await exit;
    if (svc.exiting === exit) {
      svc.exiting = null;
    }
  }

  /**
   * The rest of the stop `run`, once `flip` settles (at once without one): its `beforeStop`, the
   * signal, the exit, `stopped`, its `afterStop`. The signal is sent whatever happened meanwhile:
   * the process has been let go of, and nothing else stops it. Once shutting down, the shutdown
   * runs its `afterStop`.
   */
  private async stopSequence(
    svc: Service,
    run: StopRun,
    flip: Promise<void> | null,
    ending: Promise<void> | null,
  ): Promise<void> {
    const name = svc.config.name;
    const { proc } = run;
    if (flip) {
      await flip;
      if (!this.closing) {
        await this.stopHook(svc, run, 'beforeStop', ending);
      }
    }
    this.letGo(svc, proc);
    await proc.stop();
    if (flip && !this.holdsReady(name)) {
      // Its old process is gone: the hold comes off, and what its probes saw while it was held was
      // that process, so the service is unhealthy until a probe passes again.
      this.readiness.processExited(name);
    }
    if (this.closing) {
      return;
    }
    this.status(svc, chalk.red('stopped'));
    if (flip) {
      run.afterBegun = true;
      await this.stopHook(svc, run, 'afterStop', ending);
    }
    if (svc.stopRun === run) {
      svc.stopRun = null;
    }
  }

  /**
   * `proc`, which a stop let go of, is signalled or has exited: it can no longer be reached, and
   * its pid is no longer the service's. Nothing for any other process.
   */
  private letGo(svc: Service, proc: SupervisedProcess): void {
    if (svc.leaving !== proc) {
      return;
    }
    svc.leaving = null;
    this.letGoNow(svc);
    this.emitChange();
  }

  /**
   * The service's readiness once a stop has let go of its process: unready and unreachable. One
   * with stop hooks stays held until its process has exited, so the old process answering in its
   * grace period can't make it ready.
   */
  private letGoNow(svc: Service): void {
    const name = svc.config.name;
    this.processGone(svc);
    if (this.hasStopHooks(name) && !this.holdsReady(name)) {
      this.readiness.holdReady(name);
    }
  }

  /** Whether the service has a `beforeStop` or an `afterStop`. */
  private hasStopHooks(name: string): boolean {
    return (
      !!this.hooks && (this.hooks.has(name, 'beforeStop') || this.hooks.has(name, 'afterStop'))
    );
  }

  /**
   * Runs one of the service's stop hooks for the stop `run`, if it has it, with no time limit: a
   * second stop abandons it. A failure is an error line under the service,
   * `beforeStop failed: <message>` or `afterStop failed: <message>`, and the stop goes ahead.
   */
  private async stopHook(
    svc: Service,
    run: StopRun,
    hook: 'beforeStop' | 'afterStop',
    ending: Promise<void> | null,
  ): Promise<void> {
    if (!this.hooks?.has(svc.config.name, hook)) {
      return;
    }
    const running = this.runStopHook(svc, hook, run.trigger, run.data, undefined, ending);
    // A stop asked for while it runs abandons it: the screen's `s` reads stop meanwhile.
    run.hook = running;
    this.emitChange();
    const outcome = await running.outcome;
    if (run.hook === running) {
      run.hook = null;
      this.emitChange();
    }
    this.report(svc, running, outcome);
  }

  /**
   * Starts one of the service's stop hooks; with a `budget`, it is abandoned once that aborts.
   * With `ending` (the commands of a start hook the stop abandoned), the hook is called only once
   * that settles: the wait is part of its run, abandoned like the rest of it.
   */
  private runStopHook(
    svc: Service,
    hook: 'beforeStop' | 'afterStop',
    trigger: ServiceStopTrigger,
    data: Record<string, unknown>,
    budget?: AbortSignal,
    ending?: Promise<void> | null,
  ): RunningHook {
    const abandon = new AbortController();
    const signal = budget ? AbortSignal.any([budget, abandon.signal]) : abandon.signal;
    const call = () => this.hooks!.run(svc.config.name, hook, trigger, data, signal);
    const running: RunningHook = {
      hook,
      outcome: ending ? raceAbort(ending, signal).then(call) : call(),
      abandon,
      why: null,
      reported: false,
    };
    this.stopHooks.add(running);
    void running.outcome.then(() => this.stopHooks.delete(running));
    return running;
  }

  /**
   * Waits for `running` to settle, abandoning it once `budget` aborts (it may have begun with no
   * time limit, as a requested stop's hook does), and logs how it ended.
   */
  private async settleWithin(
    svc: Service,
    running: RunningHook,
    budget: AbortSignal,
  ): Promise<void> {
    if ((await raceAbort(running.outcome, budget)) === ABORTED) {
      this.abandonHook(running, 'budget');
    }
    this.report(svc, running, await running.outcome);
  }

  /** Abandons a stop hook still running, for `why`: it settles as `abandoned`, its commands killed. */
  private abandonHook(running: RunningHook, why: 'budget' | 'again' | 'kill'): void {
    running.why ??= why;
    running.abandon.abort();
  }

  /**
   * Logs how a stop hook ended, once: an error line for a failure; for one abandoned, a line
   * saying why, but none once everything was killed.
   */
  private report(svc: Service, running: RunningHook, outcome: HookOutcome): void {
    if (running.reported || this.killed) {
      return;
    }
    running.reported = true;
    if (typeof outcome === 'object') {
      this.status(svc, chalk.red(failedLine(running.hook, outcome.error)), true);
    } else if (outcome === 'abandoned' && running.why !== 'kill') {
      this.status(svc, chalk.yellow(abandonedLine(running.hook, running.why ?? 'budget')));
    }
  }

  /**
   * The service let go of its process: it is unready at once. One whose start hooks hold its ready
   * is held again, until its next start's hooks have run, so its old process answering in its grace
   * period can't make it ready. (Before its first spawn it is not held: something run outside
   * stackctl that answers its healthcheck still makes it ready.)
   */
  private processGone(svc: Service): void {
    const name = svc.config.name;
    this.readiness.processExited(name);
    if (this.holdsReady(name)) {
      this.readiness.holdReady(name);
    }
  }

  /**
   * Waits until no process a stop let go of is still exiting, and no command of a start hook a
   * newer request abandoned is still ending.
   */
  private async exited(svc: Service): Promise<void> {
    while (svc.exiting || svc.ending) {
      await svc.exiting;
      await svc.ending;
    }
  }

  private async restartNow(
    svc: Service,
    trigger: 'restart' | 'env',
    data: Record<string, unknown>,
  ): Promise<RestartOutcome> {
    const turn = ++svc.turn;
    this.supersede(svc, 'restarted');
    this.cancelWait(svc);
    if (svc.proc) {
      // The stop half: `restarting` at once, then the stop hooks around the stop.
      await this.halt(svc, 'restarting', trigger, data);
    } else {
      this.setState(svc, 'restarting');
    }
    await this.firstRead;
    await svc.reading;
    await this.snapshot.refresh();
    // A process an earlier stop let go of finishes exiting first: one copy at a time.
    await this.exited(svc);
    // Shutting down, or stopped (or started anew) meanwhile: the user asked last.
    if (this.closing || svc.turn !== turn) {
      return 'cancelled';
    }
    if (!definesDevScript(svc.config)) {
      this.setState(svc, 'stopped');
      this.status(svc, chalk.green('restarted'));
      return 'done';
    }
    const started = await this.startProcess(svc, turn, trigger, data, () => {
      this.status(svc, chalk.green('restarted'));
      // Spawned: a restart from here on is a new one, though this one still runs its `afterStart`.
      svc.restart = null;
    });
    return started ? 'done' : 'cancelled';
  }

  private async addNow(name: string): Promise<AddOutcome> {
    if (this.services.has(name)) {
      return 'done';
    }
    if (this.closing) {
      return 'closing';
    }
    const config = getRegisteredPackages().find((p) => p.name === name);
    if (!config) {
      return 'unknown';
    }
    // Its direct deps the session lacks, in the config's order, then the service itself.
    const joining = depsOf(name)
      .filter((dep) => !this.services.has(dep))
      .map((dep) => findService(dep))
      .concat(config);
    const plan = this.plan;
    const added: Service[] = [];
    // A start of a joining service before this read is done waits for it, as one before the
    // first read waits for that: it must spawn with its `.env` values.
    const read = this.firstRead.then(() =>
      this.snapshot.refresh(joining.flatMap((p) => this.envPaths(p))),
    );
    for (const p of joining) {
      plan.sortedPackages.push(p);
      const waits = waitsFor(p);
      if (waits.length > 0) {
        plan.waitsOn[p.name] = waits;
      }
      if (p.healthcheck) {
        plan.healthchecks[p.name] = p.healthcheck;
      }
      const extra = menuCommandsOf(p);
      if (extra.length > 0) {
        plan.menuCommands[p.name] = extra;
      }
      const svc = this.join(p, plan.sortedPackages.length - 1);
      svc.asked = p.name === name;
      svc.reading = read;
      added.push(svc);
      this.status(svc, chalk.cyan('added to the session'));
    }
    plan.picked.add(name);
    this.emitChange();
    await read;
    for (const svc of added) {
      svc.reading = null;
    }
    if (this.closing) {
      return 'closing';
    }
    this.watchEnv();
    // Before the session's own launch, `launchAll` launches them. A service started, stopped or
    // restarted while the files were read is left as that made it.
    if (this.launched) {
      // One add is one operation: the services it brings in share one `data`.
      const data: Record<string, unknown> = {};
      for (const svc of added) {
        if (svc.state === 'pending' && svc.turn === 0) {
          this.launch(svc, svc.asked, 'start', data);
        }
      }
    }
    return 'done';
  }

  /** The `.env` files a service's environment is read from. */
  private envPaths(config: AnyServiceConfig): string[] {
    return envCandidatePaths({
      resolvedWorkspaceDir: this.resolvedWorkspaceDir,
      resolvedDir: config.resolvedDir,
      files: this.envFilesOf(config),
    });
  }

  /** The `.env` filenames a service looks for in each directory: its own, or the session's. */
  private envFilesOf(config: AnyServiceConfig): string[] {
    return serviceEnvOptions(config).files ?? this.envFiles;
  }

  /**
   * The environment a service's dev process gets: {@link envFor}, with what running its dev script
   * adds (its `node_modules/.bin` on `PATH`, `npm_lifecycle_event`, `INIT_CWD`, …). What its
   * `lifecycle` hooks get as `envs`. Throws when the `.env` files can't be resolved.
   */
  processEnv(config: AnyServiceConfig): NodeJS.ProcessEnv {
    return definesDevScript(config) ? this.devExec(config).env : this.envFor(config);
  }

  /** How the service's dev process is run: its dev script, with its environment. */
  private devExec(config: AnyServiceConfig): ExecSpec {
    return scriptExec(config, getDevScript(config), [], this.envFor(config));
  }

  /** What the `.env` files a service's environment is read from read as now, as one string. */
  private envFingerprint(config: AnyServiceConfig): string {
    const files = this.envPaths(config);
    if (this.plan.envDecrypt) {
      files.push(envKeysFile(this.resolvedWorkspaceDir));
    }
    return JSON.stringify(files.map((file) => this.snapshot.read(file)));
  }

  /**
   * Whether a change the watch reported leaves the service's process with what its files read as
   * now: it was spawned after its `beforeStart`, which read them afresh, and they read the same.
   * The change was one the process already has (the hook's own write, which the watch reports a
   * moment after the spawn), and needs no restart.
   */
  private hasEnvOfNow(svc: Service): boolean {
    return svc.spawnedWith !== null && svc.spawnedWith === this.envFingerprint(svc.config);
  }

  /**
   * The environment a service's processes get: this process's, without the workspace's layer the
   * CLI merged into it, with the service's own layer over it.
   */
  private envFor(config: AnyServiceConfig): NodeJS.ProcessEnv {
    return {
      ...withoutWorkspaceEnv(),
      ...packageEnvLayer(config, {
        resolvedWorkspaceDir: this.resolvedWorkspaceDir,
        files: this.envFiles,
        override: this.plan.envOverride,
        decrypt: this.plan.envDecrypt,
        vars: this.plan.envVars,
        extraCaCerts: sessionTrustFile(this.root),
        read: this.snapshot.read,
      }),
    };
  }

  /**
   * (Re)watches the `.env` files: a directory's restart every service at or below it — the
   * workspace's every service, a service directory's that service — and with `env.decrypt` so
   * does `.env.keys`. Each change also reads the files again. A service spawned after its
   * `beforeStart` whose files read as they did at that spawn is not restarted: its process has
   * them already.
   */
  private watchEnv(): void {
    this.watch?.();
    const apply = async (dir: string, names: string[]) => {
      const read = this.snapshot.refresh();
      // Only to compare with what a service spawned after its `beforeStart` read: no other waits.
      if (names.some((name) => this.services.get(name)?.spawnedWith != null)) {
        await read;
        if (this.closing) {
          return;
        }
      }
      const restarting = names.filter((name) => {
        const svc = this.services.get(name);
        return !this.closing && svc !== undefined && runsNow(svc) && !this.hasEnvOfNow(svc);
      });
      // A `beforeStart`'s own write: its service runs the hook now, or was spawned after it with
      // what the files read as.
      const byHook =
        restarting.length === 0 &&
        names.some((name) => {
          const svc = this.services.get(name);
          return (
            svc !== undefined &&
            (svc.startRun?.hook === 'beforeStart' || (runsNow(svc) && this.hasEnvOfNow(svc)))
          );
        });
      this.emit('env-change', path.relative(root, dir) || '.', restarting, byHook);
      for (const name of restarting) {
        void this.envChanged(name);
      }
    };
    // A directory's targets each see one edit to a file they share, a moment apart: what they
    // report within ENV_CHANGE_MERGE_MS is one change, of every service any of them names.
    const pending = new Map<string, Set<string>>();
    const changed = (dir: string, names: string[]) => {
      const merged = pending.get(dir);
      if (merged) {
        for (const name of names) {
          merged.add(name);
        }
        return;
      }
      pending.set(dir, new Set(names));
      setTimeout(() => {
        const all = pending.get(dir);
        pending.delete(dir);
        if (all && this.watch) {
          void apply(dir, [...all]);
        }
      }, ENV_CHANGE_MERGE_MS);
    };
    const root = path.resolve(this.resolvedWorkspaceDir);
    // Every directory some service reads `.env` files from, with the services that read them: the
    // root's are every service's, and one between the root and a service's every service below it.
    // Services that look for different names (an `env.additionalFiles` of their own) are a target
    // each, so a file only some of them look for restarts only those. One directory's targets
    // share its watcher.
    const readers = new Map<string, { dir: string; names: string[]; filenames: string[] }>();
    const readersOf = (dir: string, filenames: string[]) => {
      const key = JSON.stringify([dir, filenames]);
      const entry = readers.get(key) ?? { dir, names: [], filenames };
      readers.set(key, entry);
      return entry;
    };
    for (const { config } of this.services.values()) {
      const filenames = this.envFilesOf(config);
      for (const dir of envDirs(root, config.resolvedDir)) {
        readersOf(dir, filenames).names.push(config.name);
      }
    }
    const targets: WatchTarget[] = [...readers.values()].map(({ dir, names, filenames }) => ({
      dir,
      filenames:
        dir === root && this.plan.envDecrypt ? [...filenames, ENV_KEYS_FILENAME] : filenames,
      onChange: () => changed(dir, names),
    }));
    this.watch = watchEnvFiles({
      targets,
      onError: (dir, error) => {
        this.log.system.warn(
          `stopped watching ${dir} for .env changes (${error.message}); edits there won't auto-restart services`,
        );
      },
    });
  }

  /**
   * Shutting down from here on: nothing starts, nothing waits or probes. What the shutdown stops of
   * each service is fixed: its own process (`quit`), or the stop under way it overtakes.
   */
  private close(): void {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.readiness.off('ready', this.onReadiness);
    this.readiness.off('unready', this.onReadiness);
    this.readiness.off('healthy', this.onHealthy);
    this.clearWarnTimer();
    this.watch?.();
    this.watch = null;
    this.snapshot.dispose();
    for (const svc of this.services.values()) {
      this.cancelWait(svc);
      this.supersede(svc, 'quit');
      svc.shutdownStop = svc.proc ? 'quit' : svc.stopRun;
    }
  }

  /** Every service lets go of its process and is `stopped`: nothing can reach one from now on. */
  private release(): void {
    for (const svc of this.services.values()) {
      if (svc.proc || svc.leaving) {
        svc.proc = null;
        svc.leaving = null;
        svc.healthWait?.(false);
        this.readiness.processExited(svc.config.name);
      }
      this.setState(svc, 'stopped');
    }
  }

  private cancelWait(svc: Service): void {
    svc.wait?.abort();
    svc.wait = null;
  }

  private clearWarnTimer(): void {
    if (this.warnTimer !== undefined) {
      this.clock.clearTimeout(this.warnTimer);
      this.warnTimer = undefined;
    }
  }

  private setState(svc: Service, state: ServiceState): void {
    if (svc.state !== state) {
      svc.state = state;
      this.emitChange();
    }
  }

  private readinessChanged(name: string): void {
    if (this.services.has(name)) {
      this.emitChange();
    }
  }

  /** Emits `change` to each listener in turn; one that throws doesn't keep it from the rest. */
  private emitChange(): void {
    callEach(this.rawListeners('change') as (() => void)[], this);
  }

  /**
   * One raw line of a service's output, through its formatter (stackctl's default when it has
   * none). A formatter that throws or returns no string passes the line through; a line passed
   * through is red when it came from stderr. The result's lines are one entry.
   */
  private output(svc: Service, raw: string, isError: boolean): void {
    const formatter = svc.config.logs?.formatter ?? defaultFormatter;
    let result: unknown;
    try {
      result = formatter(raw);
    } catch {
      result = raw;
    }
    const text =
      typeof result === 'string' && result !== raw ? result : isError ? chalk.red(raw) : raw;
    const pieces = text.split('\n').filter((piece) => piece !== '');
    pieces.forEach((piece, i) => {
      this.append(svc, piece, isError, pieces.length > 1 ? i > 0 : undefined);
    });
  }

  /**
   * A line a process passes on. Output comes only from a process that has spawned; a line from one
   * with no pid is its own report of a spawn that failed, a status line the formatter never sees.
   */
  private line(svc: Service, proc: SupervisedProcess, text: string, isError: boolean): void {
    if (proc.pid === null) {
      this.status(svc, chalk.red(text), true);
    } else {
      this.output(svc, text, isError);
    }
  }

  /** One of the service's own lines: a status line, or a one-off's frame. */
  private status(svc: Service, text: string, isError = false): void {
    this.append(svc, text, isError, undefined);
  }

  private append(
    svc: Service,
    text: string,
    isError: boolean,
    continues: boolean | undefined,
  ): void {
    this.logs.append({
      service: svc.config.name,
      text,
      isError,
      at: Date.now(),
      ts: logTimestamp(),
      showTs: svc.showTs,
      label: svc.label,
      filterKey: svc.key,
      ...(continues === undefined ? {} : { continues }),
    });
  }

  /** One internal NDJSON record: rendered, and appended as one entry. A malformed one is dropped. */
  private internal(json: string): void {
    let record: ReturnType<typeof formatInternalRecord>;
    try {
      record = formatInternalRecord(json);
    } catch {
      return;
    }
    const control = record.component === 'control';
    const scoped =
      control && record.packageName !== undefined
        ? this.services.get(record.packageName)
        : undefined;
    const pieces = record.text.split('\n').filter((piece) => piece !== '');
    pieces.forEach((text, i) => {
      this.logs.append({
        service: scoped ? scoped.config.name : null,
        text,
        isError: record.isError,
        at: Date.now(),
        ts: logTimestamp(),
        showTs: scoped ? scoped.showTs : (this.plan.logTimestamps ?? true),
        label: control ? this.controlLabel : this.stackctlLabel,
        filterKey: scoped ? scoped.key : control ? 'control' : 'system',
        continues: i > 0,
      });
    });
  }
}
