import { EventEmitter } from 'node:events';
import path from 'node:path';
import chalk from 'chalk';
import { STACKCTL_LABEL_COLOR, PACKAGE_PALETTE } from '../colors.js';
import {
  type AnyServiceConfig,
  findService,
  getDevScript,
  getRegisteredPackages,
} from '../config.js';
import { sessionTrustFile } from '../dev-tls.js';
import { type EnvWatch, type WatchTarget, watchEnvFiles } from '../env-watch.js';
import {
  type EnvFileOrder,
  EnvFileSnapshot,
  envCandidatePaths,
  envFileOrder,
  envKeysFile,
  packageEnvLayer,
} from '../env.js';
import { logTimestamp } from '../format.js';
import {
  type InternalLoggers,
  createInternalLogger,
  formatInternalRecord,
} from '../internal-logger.js';
import { defaultFormatter } from '../log-formatter.js';
import { type ExecSpec, scriptExec, menuCommandsOf, definesDevScript } from '../scripts.js';
import { depsOf } from '../selection-plan.js';
import type { ServiceGroups } from '../service-usage.js';
import { callEach } from '../util.js';
import type { LogStore } from './log-store.js';
import { waitsFor } from './plan.js';
import { type Clock, type Readiness, systemClock } from './readiness.js';
import {
  ChildRecords,
  type ProcessExit,
  type ProcessState,
  ServiceProcess,
  type ServiceProcessEvents,
  type ServiceProcessOptions,
} from './service-process.js';
import type { LogLabel, SessionPlan } from './types.js';

/** Where a service is in its life, as the session sees it. */
export type ServiceState =
  | 'pending'
  | 'waiting'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'stopped'
  | 'crashed';

/** A service's status as the control API, `/events` and the dev reverse proxy report it. */
export type PublicStatus = 'running' | 'stopped' | 'waiting' | 'restarting';

/**
 * The public status of a state: held services read `waiting`, a process being spawned already
 * reads `running`, and a crash reads `stopped`.
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
  /** Its process runs, and its healthcheck (when it has one) passes. */
  ready: boolean;
  /** The dev process's pid, which is also its group's id; `null` when none runs. */
  pid: number | null;
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
  /** A `.env` file in `dir` (relative to the workspace) changed: `services` restart. */
  'env-change': [dir: string, services: string[]];
};

/** How a one-off command ended, or `null` when it never ran (no such service, or shutting down). */
export type OneOffResult = { exitCode: number | null; signal: string | null } | null;

/** A one-off command of the commands menu: a script or make target, or a shell command line. */
export type OneOff = string | { shell: string };

/** How an {@link Supervisor.add} went. */
export type AddOutcome = 'done' | 'closing' | 'unknown';

/** How long the first `.env` read may take before a `[stackctl]` warning names what it waits on. */
const ENV_READ_WARN_MS = 3_000;

/** The color names a service's `color` may be: chalk's foreground colors, nothing else. */
const NAMED_COLORS = new Set([
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
  'grey',
  'blackBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
]);

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
const RGB = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;
const ANSI256 = /^ansi256\(\s*(\d{1,3})\s*\)$/;

type Paint = (text: string) => string;

const unpainted: Paint = (text) => text;

/**
 * How a service's label is painted: its `color` when set, else the palette color of its position
 * in the session, cycling. A `color` that is none of hex, `rgb(…)`, `ansi256(…)` or a chalk
 * foreground color name leaves the label uncolored.
 */
function paintFor(color: string | undefined, index: number): Paint {
  if (color === undefined) {
    return chalk.hex(PACKAGE_PALETTE[index % PACKAGE_PALETTE.length]!);
  }
  const hex = HEX.exec(color);
  if (hex) {
    return chalk.hex(`#${hex[1]!}`);
  }
  const rgb = RGB.exec(color);
  if (rgb) {
    const [r, g, b] = rgb.slice(1).map(Number) as [number, number, number];
    return r <= 255 && g <= 255 && b <= 255 ? chalk.rgb(r, g, b) : unpainted;
  }
  const ansi = ANSI256.exec(color);
  if (ansi) {
    const n = Number(ansi[1]);
    return n <= 255 ? chalk.ansi256(n) : unpainted;
  }
  if (NAMED_COLORS.has(color)) {
    return chalk[color as 'red'];
  }
  return unpainted;
}

/**
 * A command line `/bin/sh -c` runs as `spec` would spawn: a script's own text as it is, anything
 * else (a make target, the shell that reports a missing script) as its words, each quoted.
 */
function commandLine(spec: ExecSpec): string {
  if (spec.cmd === '/bin/sh' && spec.args.length === 2 && spec.args[0] === '-c') {
    return spec.args[1]!;
  }
  return [spec.cmd, ...spec.args].map(shellQuote).join(' ');
}

function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
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
  /** The wait on its deps, while it waits. */
  wait: AbortController | null;
  /** The restart under way. */
  restart: Promise<void> | null;
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
}

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
  private readonly root: string;
  private readonly envFiles: EnvFileOrder;
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
  private closing = false;
  private stopping: Promise<void> | null = null;
  /** Adds run one at a time, in the order asked. */
  private adds: Promise<unknown> = Promise.resolve();

  constructor(opts: {
    plan: SessionPlan;
    logs: LogStore;
    readiness: Readiness;
    clock?: Clock;
    /** Makes each process; a {@link ServiceProcess} unless given. */
    createProcess?: (opts: ServiceProcessOptions) => SupervisedProcess;
  }) {
    super();
    this.plan = opts.plan;
    this.logs = opts.logs;
    this.readiness = opts.readiness;
    this.clock = opts.clock ?? systemClock;
    this.createProcess = opts.createProcess ?? ((o) => new ServiceProcess(o));
    this.root = this.plan.cwd ?? process.cwd();
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

    this.warnTimer = this.clock.setTimeout(() => {
      this.warnTimer = undefined;
      this.log.system.warn(
        `waiting to read ${this.snapshot.reading ?? 'the .env files'} before starting services; if it is in a cloud-synced folder, the system may be asking for permission to access it`,
      );
    }, ENV_READ_WARN_MS);
    this.firstRead = this.snapshot
      .refresh([envKeysFile(), ...this.plan.sortedPackages.flatMap((p) => this.envPaths(p))])
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
   * are ready; the rest start. Only the first call does anything.
   */
  launchAll(): void {
    if (this.launched || this.closing) {
      return;
    }
    this.launched = true;
    for (const svc of this.services.values()) {
      if (svc.state === 'pending' && svc.turn === 0) {
        this.launch(svc, svc.asked);
      }
    }
  }

  /**
   * Starts a service now, skipping any wait on its deps. Does nothing while shutting down, for a
   * name not in the session, one already running or restarting, or one with no dev command.
   * The start waits for the first `.env` read, and for a process a stop let go of to finish
   * exiting, so one service never runs two copies; it resolves once it has happened.
   */
  start(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (
      !svc ||
      this.closing ||
      svc.proc ||
      svc.state === 'restarting' ||
      !definesDevScript(svc.config)
    ) {
      return Promise.resolve();
    }
    return this.begin(svc);
  }

  /**
   * Stops a service. One that is held (waiting, or pending a start) is `stopped` at once, with no
   * line; a running one is `stopped` at once and its readiness dropped, then logs `stopping...`
   * and, once its process has exited, `stopped`. A restart under way starts nothing after it: the
   * service ends `stopped`. Resolves once the service's process, if any, has exited.
   */
  async stop(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) {
      return;
    }
    svc.turn++;
    svc.restart = null;
    this.cancelWait(svc);
    if (svc.proc) {
      await this.halt(svc, 'stopped');
      return;
    }
    if (svc.state === 'pending' || svc.state === 'waiting' || svc.state === 'restarting') {
      this.setState(svc, 'stopped');
    }
    await this.exited(svc);
  }

  /**
   * Restarts a service: stops it (with its lines), reads the `.env` files again, starts it and
   * logs `restarted`. A stopped or waiting service is just started, skipping any wait. A restart
   * already under way is the one returned. Its start waits for a process an earlier stop let go of
   * to finish exiting; nothing starts once shutting down, or after a stop issued meanwhile.
   */
  restart(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc || this.closing) {
      return Promise.resolve();
    }
    if (!svc.restart) {
      const restart: Promise<void> = this.restartNow(svc).finally(() => {
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
        spec = { command: commandLine(exec), env: exec.env };
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
      cwd: svc.config.absoluteDir,
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
   * and restarts. A held, restarting or stopped one is left alone; its next start reads the files
   * as they are then.
   */
  envChanged(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc || this.closing || (svc.state !== 'running' && svc.state !== 'starting')) {
      return Promise.resolve();
    }
    this.status(svc, chalk.cyan('.env changed, restarting...'));
    return this.restart(name);
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
      this.stopping = Promise.all([...this.live.keys()].map((proc) => proc.stop())).then(() => {});
    }
    return this.stopping;
  }

  /**
   * An immediate SIGKILL to every process still running, those in a stop's grace period included.
   * Nothing starts after it.
   */
  killEverything(): void {
    this.close();
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
        pid: svc.proc?.pid ?? null,
      });
    }
    return states;
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
      wait: null,
      restart: null,
      turn: 0,
      exiting: null,
      reading: null,
      asked: false,
    };
    this.services.set(config.name, svc);
    this.readiness.track(config.name, this.plan.healthchecks[config.name]);
    return svc;
  }

  /** Launches a service as the session's start does; `force` ignores `autostart: false`. */
  private launch(svc: Service, force: boolean): void {
    if (this.closing) {
      return;
    }
    if ((!force && svc.config.autostart === false) || !definesDevScript(svc.config)) {
      this.setState(svc, 'stopped');
      return;
    }
    const deps = this.plan.waitsOn[svc.config.name] ?? [];
    if (deps.length === 0) {
      void this.begin(svc);
      return;
    }
    const wait = new AbortController();
    svc.wait = wait;
    this.setState(svc, 'waiting');
    this.status(svc, chalk.cyan(`waiting for ${deps.join(', ')}...`));
    this.readiness.whenReady(deps, wait.signal).then(
      () => {
        if (svc.wait !== wait || this.closing) {
          return;
        }
        svc.wait = null;
        this.status(svc, chalk.green(`${deps.join(', ')} ready, starting...`));
        void this.begin(svc);
      },
      () => {
        /* stopped, started or shut down while it waited */
      },
    );
  }

  /** Starts a service once the first `.env` read is done, unless something else happened first. */
  private async begin(svc: Service): Promise<void> {
    const turn = ++svc.turn;
    this.cancelWait(svc);
    if (!this.envRead || svc.reading || svc.exiting) {
      this.setState(svc, 'pending');
      await this.firstRead;
      await svc.reading;
      await this.exited(svc);
      if (svc.turn !== turn || this.closing) {
        return;
      }
    }
    this.spawn(svc);
  }

  /** Spawns the service's dev process. */
  private spawn(svc: Service): void {
    if (svc.proc) {
      return;
    }
    const { config } = svc;
    const name = config.name;
    let spec: ExecSpec;
    try {
      spec = scriptExec(config, getDevScript(config), [], this.envFor(config));
    } catch (err) {
      // Its environment couldn't be built: it ends as a spawn that failed does.
      svc.exitCode = 1;
      this.setState(svc, 'crashed');
      this.status(svc, chalk.red(`failed to start: ${(err as Error).message}`), true);
      this.status(svc, 'exited with code 1');
      this.emit('exit', name, 1, null);
      return;
    }
    const proc: SupervisedProcess = this.createProcess({
      name,
      command: commandLine(spec),
      cwd: config.absoluteDir,
      env: spec.env,
      onLine: (text, isError) => this.line(svc, proc, text, isError),
      records: this.records,
    });
    svc.proc = proc;
    svc.exitCode = null;
    this.live.set(proc, name);
    this.setState(svc, 'starting');
    this.status(svc, chalk.green('started'));
    this.readiness.processStarted(name);
    proc.on('state', (state) => {
      if (state === 'running' && svc.proc === proc && svc.state === 'starting') {
        this.setState(svc, 'running');
      }
    });
    proc.on('exit', (exit) => {
      this.live.delete(proc);
      // A stop let go of it first, and logs its own lines.
      if (svc.proc !== proc) {
        return;
      }
      svc.proc = null;
      const code = proc.exitCode ?? 1;
      svc.exitCode = code;
      this.setState(svc, exit.code === 0 ? 'stopped' : 'crashed');
      this.readiness.processExited(name);
      this.status(svc, `exited with code ${code}`);
      this.emit('exit', name, exit.code, exit.signal);
    });
    proc.start();
  }

  /**
   * Stops a service's dev process: the service is `next` at once and its readiness dropped, then
   * `stopping...`, and `stopped` once the process has exited (unless shutting down by then).
   */
  private async halt(svc: Service, next: 'stopped' | 'restarting'): Promise<void> {
    const proc = svc.proc!;
    svc.proc = null;
    svc.exitCode = null;
    // Recorded before anything is emitted, so a start a listener makes at once waits for it too.
    const exit = proc.stop();
    svc.exiting = exit;
    this.setState(svc, next);
    this.readiness.processExited(svc.config.name);
    this.status(svc, chalk.yellow('stopping...'));
    await exit;
    if (svc.exiting === exit) {
      svc.exiting = null;
    }
    if (!this.closing) {
      this.status(svc, chalk.red('stopped'));
    }
  }

  /** Waits until no process a stop let go of is still exiting. */
  private async exited(svc: Service): Promise<void> {
    while (svc.exiting) {
      await svc.exiting;
    }
  }

  private async restartNow(svc: Service): Promise<void> {
    const turn = ++svc.turn;
    this.cancelWait(svc);
    if (svc.proc) {
      await this.halt(svc, 'restarting');
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
      return;
    }
    if (definesDevScript(svc.config)) {
      this.spawn(svc);
    } else {
      this.setState(svc, 'stopped');
    }
    this.status(svc, chalk.green('restarted'));
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
      for (const svc of added) {
        if (svc.state === 'pending' && svc.turn === 0) {
          this.launch(svc, svc.asked);
        }
      }
    }
    return 'done';
  }

  /** The `.env` files a service's environment is read from. */
  private envPaths(config: AnyServiceConfig): string[] {
    return envCandidatePaths({
      cwd: this.root,
      relativeDir: config.relativeDir,
      files: this.envFiles,
    });
  }

  /** The environment a service's processes get: this process's, with the service's layer over it. */
  private envFor(config: AnyServiceConfig): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...packageEnvLayer(config, {
        cwd: this.root,
        files: this.envFiles,
        override: this.plan.envOverride,
        vars: this.plan.envVars,
        extraCaCerts: sessionTrustFile(this.root),
        read: this.snapshot.read,
      }),
    };
  }

  /**
   * (Re)watches the `.env` files: the workspace's restart every service, a service directory's
   * that service. Each change also reads the files again.
   */
  private watchEnv(): void {
    this.watch?.();
    const changed = (dir: string, names: string[]) => {
      void this.snapshot.refresh();
      const restarting = names.filter((name) => {
        const state = this.services.get(name)?.state;
        return !this.closing && (state === 'running' || state === 'starting');
      });
      this.emit('env-change', path.relative(root, dir) || '.', restarting);
      for (const name of names) {
        void this.envChanged(name);
      }
    };
    const root = path.resolve(this.root);
    const targets: WatchTarget[] = [
      {
        dir: root,
        filenames: this.envFiles.workspace,
        onChange: () => changed(root, [...this.services.keys()]),
      },
    ];
    for (const { config } of this.services.values()) {
      if (path.resolve(config.absoluteDir) !== root) {
        targets.push({
          dir: config.absoluteDir,
          filenames: this.envFiles.service,
          onChange: () => changed(config.absoluteDir, [config.name]),
        });
      }
    }
    this.watch = watchEnvFiles({
      targets,
      onError: (dir, error) => {
        this.log.system.warn(
          `stopped watching ${dir} for .env changes (${error.message}); edits there won't auto-restart services`,
        );
      },
    });
  }

  /** Shutting down from here on: nothing starts, nothing waits or probes, every service `stopped`. */
  private close(): void {
    if (this.closing) {
      return;
    }
    this.closing = true;
    this.readiness.off('ready', this.onReadiness);
    this.readiness.off('unready', this.onReadiness);
    this.clearWarnTimer();
    this.watch?.();
    this.watch = null;
    this.snapshot.dispose();
    for (const svc of this.services.values()) {
      this.cancelWait(svc);
    }
    for (const svc of this.services.values()) {
      if (svc.proc) {
        svc.proc = null;
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
