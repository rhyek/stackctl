import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { startedByAgent } from '../agent-detection.js';
import { STACKCTL_LABEL_COLOR } from '../colors.js';
import {
  type UrlEntry,
  type UrlLine,
  findService,
  getLoadedConfig,
  getRegisteredPackages,
  infraServicesOf,
  normalizeUrlEntry,
} from '../config.js';
import {
  type ControlManager,
  type ServiceAction,
  type ServiceRunOutcome,
  startControlServer,
} from '../control-server.js';
import type { DevReverseProxyManager, DevReverseProxyServer } from '../dev-reverse-proxy.js';
import { currentProfile, profileLine } from '../env-base.js';
import { errorMessage } from '../errors.js';
import {
  EventLog,
  type EventBy,
  type InfraCommandEntry,
  type OneOffCommandEntry,
  type ServiceCommandEntry,
  type SessionCommandEntry,
  maskSecrets,
} from '../event-log.js';
import { logTimestamp } from '../format.js';
import {
  type InfraAction,
  InfraControl,
  type InfraRunOutcome,
  type InfraStatus,
} from '../infra/control.js';
import { InfraFailedError, runSessionInfra } from '../infra/session.js';
import type { InfraEvent, InfraRunSummary } from '../infra/types.js';
import type { InternalLoggers } from '../internal-logger.js';
import { isProcessAlive } from '../process-info.js';
import { pickRandomPort, readRunning, sessionId } from '../running.js';
import { definesDevScript } from '../scripts.js';
import { planSelection } from '../selection-plan.js';
import { UsageSampler, type UsageReader, createUsageReader } from '../service-usage.js';
import { sessionEventsPath } from '../session-files.js';
import { acquireSession } from '../session-takeover.js';
import { SHUTDOWN_GRACE_MS, SHUTDOWN_TIMEOUT_MS } from '../shutdown-timing.js';
import { installShutdownSignals } from '../signals.js';
import { readOwnVersion } from '../skill.js';
import type { StackMessage } from '../stack.js';
import { bounded } from '../util.js';
import { type GitBranchWatch, readGitBranch, followGitBranch } from './git-branch.js';
import { LogStore } from './log-store.js';
import { Readiness, probeHealthcheck } from './readiness.js';
import type { ServiceProcessOptions } from './service-process.js';
import { startSessionDevReverseProxy } from './start-proxy.js';
import {
  type OneOff,
  type OneOffResult,
  type ServiceState,
  type SupervisedProcess,
  Supervisor,
  publicStatus,
} from './supervisor.js';
import type { SessionInfra, SessionPlan } from './types.js';

/**
 * What ended a session: a signal, `/command/quit`, the person quitting the TUI (`user`, the run
 * screen's quit), or its owner following up on a failed startup.
 */
export type ShutdownReason = 'signal' | 'quit' | 'user' | 'startup-failed';

/** An infra service as the session shows it: its startup progress, then its live status. */
export type SessionInfraState = InfraStatus | 'pending' | 'failed';

/** Everything a screen shows of a session, as one immutable value. */
export interface SessionSnapshot {
  phase: 'starting' | 'running' | 'failed' | 'stopping';
  /** Why startup failed, once it has. */
  failure?: { message: string };
  /** Every service, in session order (added ones last). */
  services: ReadonlyArray<{
    name: string;
    state: ServiceState;
    /** Kept from an exit of its own or a failed spawn, until the next start; else `null`. */
    exitCode: number | null;
    ready: boolean;
    hasHealthcheck: boolean;
    /** The services it is held until ready. */
    waitsFor: string[];
    /**
     * Bytes in use by its processes, as shown: sampled only in an interactive session, and absent
     * before the first reading and while nothing of it runs.
     */
    memory?: number;
    links: UrlLine[];
  }>;
  /** Every infra service, once the infra step has named them. */
  infra: ReadonlyArray<{
    name: string;
    provider: string;
    state: SessionInfraState;
    /** The startup step it is on (`waiting for healthy`, …); cleared once it is healthy. */
    detail?: string;
    /** Bytes in use, as shown; sampled as for a service's. */
    memory?: number;
    links: UrlLine[];
  }>;
  workspaceLinks: UrlLine[];
  logFile: string;
  workspace: { name: string; branch: string | null };
}

/** What the infra step reports beyond its output lines, for a printer of its progress. */
export type InfraProgress = InfraEvent | { type: 'finished'; summary: InfraRunSummary };

type ControlServer = Awaited<ReturnType<typeof startControlServer>>;

/** What a session reaches outside itself; each defaults to the real thing. Tests replace them. */
export interface SessionSeams {
  /** Takeover: decides and records the control port, sweeps orphans. Resolves with the port. */
  acquire?: (onStatus: (message: string) => void) => Promise<number>;
  startProxy?: (controlPort: number) => Promise<DevReverseProxyServer | null>;
  startControlServer?: (opts: Parameters<typeof startControlServer>[0]) => Promise<ControlServer>;
  runInfra?: (onEvent: (event: InfraEvent) => void) => Promise<SessionInfra | undefined>;
  /** The command an infra action runs the CLI with; this stackctl's own `[node, cli.js]` unless given. */
  infraCli?: string[];
  createProcess?: (opts: ServiceProcessOptions) => SupervisedProcess;
  probe?: (name: string) => Promise<boolean>;
  /** The git branch for the first frame; {@link readGitBranch} unless given. */
  readBranch?: () => string | null;
  /** The branch an interactive session shows as it changes; {@link followGitBranch} unless given. */
  watchBranch?: (onChange: (branch: string | null) => void) => GitBranchWatch;
  /** Signals a process group; `process.kill(-pid, signal)` unless given. */
  signalGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /** Routes the shutdown signals; `signals.ts` unless given. */
  installSignals?: (onSignal: () => void) => () => void;
  /** The memory reader of an interactive session; the machine's (`createUsageReader`) unless given. */
  usageReader?: () => Promise<UsageReader | null>;
  /** A control port when acquisition fails in an interactive session; `pickRandomPort` unless given. */
  randomPort?: () => number;
  /** A forked session's IPC channel to its parent; `process` unless given. */
  parentChannel?: ParentChannel;
  /**
   * The profile's event log; the one under the workspace's `node_modules/.stackctl/` unless given.
   */
  events?: EventLog;
}

/** What a forked session sends its `started` message over: `process`'s IPC channel. */
export interface ParentChannel {
  readonly connected?: boolean;
  send?: (message: StackMessage, callback: (err: Error | null) => void) => boolean;
}

/**
 * Sends a forked session's parent its message, if the channel is still open. A parent that died
 * before it (`ERR_IPC_CHANNEL_CLOSED`, thrown or called back) is no failure of the session's: it
 * carries on, and is taken down as an orphaned child would be.
 */
export function tellParent(channel: ParentChannel, message: StackMessage): void {
  if (!channel.connected || !channel.send) {
    return;
  }
  try {
    channel.send(message, () => {
      /* a send the closing channel couldn't deliver */
    });
  } catch {
    /* the channel closed between the check and the send */
  }
}

/** How often an interactive session reads its infra services' memory (a round of Docker calls). */
const INFRA_MEMORY_INTERVAL_MS = 10_000;

/**
 * How long each closing step after the children are down (the proxy, the control server, the
 * logfile) may take before the shutdown goes on without it, so a stalled close never keeps the
 * process from exiting.
 */
const CLOSE_STEP_MS = 5_000;

const gold = chalk.hex(STACKCTL_LABEL_COLOR);

/** A snapshot entry's `memory`, left out when there is no figure. */
function memoryOf(bytes: number | undefined): { memory?: number } {
  return bytes === undefined ? {} : { memory: bytes };
}

function defaultSignalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
}

/**
 * What a session started for `names` launches, and so what its parent waits on: the services
 * picked and their deps, less those that never start on their own (no dev command, or
 * `autostart: false`, picked or not), which stay `stopped`.
 */
function servicesToWaitOn(names: string[]): string[] {
  return planSelection(names).order.filter((name) => {
    const pkg = findService(name);
    return definesDevScript(pkg) && pkg.autostart !== false;
  });
}

/**
 * One dev session, whatever shows it: starts everything in order (takeover, the dev reverse proxy,
 * the control server, infra, the services), runs the one shutdown path, and publishes one state
 * snapshot. It is the control server's manager and the proxy's.
 *
 * It never exits the process: {@link closed} says with which code its owner should.
 */
export class Session implements ControlManager, DevReverseProxyManager {
  readonly logs: LogStore;
  /** Resolves once the shutdown is done, with the exit code: 0, or 1 after a kill or a failed startup. */
  readonly closed: Promise<number>;

  private readonly plan: SessionPlan;
  private readonly configPath: string;
  private readonly forked: boolean;
  private readonly interactive: boolean;
  private readonly seams: SessionSeams;
  private readonly signalGroup: (pid: number, signal: NodeJS.Signals) => void;
  private readonly readiness: Readiness;
  private readonly supervisor: Supervisor;
  private resolveClosed!: (code: number) => void;
  private phase: SessionSnapshot['phase'] = 'starting';
  private failure: { message: string } | undefined;
  private started = false;
  private closing = false;
  private killed = false;
  private sampler: UsageSampler | null = null;
  /** The shutdown has finished. */
  private done = false;
  /** The startup step under way, settled (never rejecting); a shutdown waits for it. */
  private pendingStep: Promise<unknown> = Promise.resolve();
  private proxy: DevReverseProxyServer | null = null;
  private server: ControlServer | null = null;
  private infraControl: InfraControl | null = null;
  /** Infra services as the infra step reports them, until the infra control takes over. */
  private readonly infraStartup = new Map<
    string,
    { provider: string; state: SessionInfraState; detail?: string }
  >();
  private branch: GitBranchWatch | null = null;
  /** The branch read before any watch begins (the first frame), or for a session without one. */
  private branchBeforeStart: string | null | undefined;
  private releaseSignals: (() => void) | null = null;
  /** The groups the shutdown waits on, dev, one-off and infra action alike, from its start. */
  private readonly waitedGroups = new Set<number>();
  private readonly exitHook = () => this.killEverything();
  private snapshot: SessionSnapshot | null = null;
  private notifying = false;
  private readonly listeners = new Set<() => void>();
  private readonly infraListeners = new Set<(progress: InfraProgress) => void>();
  /** The profile's event log: what acts on the session, and what it does on its own. */
  private readonly events: EventLog;
  private startedAt = 0;
  /** The quit command under way, ended once the session has stopped. */
  private quitCommand: { end(result: { ok: boolean }): void } | null = null;

  constructor(opts: {
    plan: SessionPlan;
    configPath: string;
    logFile: string;
    /** Started by `startStack()`: tells its parent over the IPC channel once the control API is up. */
    forked: boolean;
    /**
     * Shown on a screen (the TUI): memory is sampled for the snapshot, and an acquisition that
     * fails falls back to a random control port instead of failing startup. Off for headless.
     */
    interactive?: boolean;
    seams?: SessionSeams;
  }) {
    this.plan = opts.plan;
    this.configPath = opts.configPath;
    this.forked = opts.forked;
    this.interactive = opts.interactive ?? false;
    this.seams = opts.seams ?? {};
    this.signalGroup = this.seams.signalGroup ?? defaultSignalGroup;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.logs = new LogStore({ logFile: opts.logFile });
    const healthchecks = this.plan.healthchecks;
    this.readiness = new Readiness({
      probe:
        this.seams.probe ??
        ((name) => {
          const healthcheck = healthchecks[name];
          return healthcheck ? probeHealthcheck(healthcheck) : Promise.resolve(false);
        }),
    });
    this.supervisor = new Supervisor({
      plan: this.plan,
      logs: this.logs,
      readiness: this.readiness,
      createProcess: this.seams.createProcess,
    });
    this.supervisor.on('change', () => this.changed());
    this.events =
      this.seams.events ??
      new EventLog({
        file: sessionEventsPath(process.cwd(), currentProfile(), sessionId()),
        profile: currentProfile(),
        sessionId: () => sessionId(),
      });
    this.supervisor.on('exit', (service, exitCode, signal) => {
      this.events.write({ type: 'service-exit', service, exitCode, signal });
    });
    this.supervisor.on('env-change', (dir, services) => {
      this.events.write({ type: 'env-change', dir, services });
    });
    // Infra's labels count in the width from the start, so a service's text and an infra
    // service's start in one column; a service the provider reports beyond the config's joins
    // them once infra names its targets.
    const config = getLoadedConfig();
    if (config?.infra) {
      this.logs.addLabels(['infra', ...infraServicesOf(config).map((s) => `infra:${s.name}`)]);
    }
  }

  /** stackctl's own channel, `[stackctl]` in the log. The proxy prints its route table through it. */
  get systemLog(): InternalLoggers['system'] {
    return this.supervisor.log.system;
  }

  /** Whether a second shutdown request killed everything, rather than the shutdown finishing. */
  get hardKilled(): boolean {
    return this.killed;
  }

  /** The commands menu's scripts and make targets, by service. */
  get commands(): Readonly<Record<string, readonly string[]>> {
    return this.plan.menuCommands;
  }

  /**
   * Starts the session, in order: takeover, the dev reverse proxy, the control server, infra, then
   * the services. The shutdown signals are watched from the first moment, and so is the git branch
   * of an interactive session, whose screen shows it. A failure on the way sets the phase `failed`
   * and logs a `[stackctl]` error line; nothing after it starts. A shutdown on the way (a signal
   * included) lets the step under way settle and closes what it produced (it doesn't wait for
   * infra), and nothing after it starts. Only the first call, before any shutdown, does anything.
   */
  async start(): Promise<void> {
    if (this.started || this.closing) {
      return;
    }
    this.started = true;
    // The shutdown path is in force from the first moment (ruling S2-R28): a signal during any
    // step runs it, which lets the step under way settle, and an exit by any other path takes
    // every group down with it.
    this.releaseSignals = (this.seams.installSignals ?? installShutdownSignals)(
      () => void this.shutdown('signal'),
    );
    process.on('exit', this.exitHook);
    const log = this.supervisor.log.system;
    log.info(profileLine());
    try {
      if (this.interactive) {
        this.branch = (this.seams.watchBranch ?? followGitBranch)(() => this.changed());
      }
      this.changed();
      this.logDeps();
      const acquire =
        this.seams.acquire ??
        ((onStatus) =>
          acquireSession({
            configPath: this.configPath,
            apiPortOverride: getLoadedConfig()?.apiPort,
            logFile: this.logs.getLogFile(),
            onStatus,
          }));
      const readUsage = this.interactive
        ? (this.seams.usageReader ?? createUsageReader)().catch(() => null)
        : null;
      // The profile's session before this one, if alive: gone after the takeover, it was replaced.
      const before = readRunning(process.cwd());
      const prior = before && before.pid !== process.pid && isProcessAlive(before.pid) ? before : null; // oxfmt-ignore
      const acquired = acquire((message) => log.info(message));
      const port = await this.step(
        this.interactive
          ? acquired.catch((err: unknown) => {
              // The TUI carries on without the session record's port (ruling S2-R9).
              const fallback = (this.seams.randomPort ?? pickRandomPort)();
              log.warn(
                `couldn't settle the session record (${errorMessage(err)}); using control port ${String(fallback)}`,
              );
              return fallback;
            })
          : acquired,
      );
      if (this.closing) {
        return;
      }
      this.startedAt = Date.now();
      this.events.write({
        type: 'session-start',
        services: this.plan.sortedPackages.map((pkg) => pkg.name),
        headless: !this.interactive,
        startedByAgent: startedByAgent(),
        argv: process.argv.slice(2),
        version: readOwnVersion(),
        logFile: path.relative(process.cwd(), this.logs.getLogFile()),
        replaced: prior && !isProcessAlive(prior.pid) ? (prior.sessionId ?? null) : null,
      });

      const startProxy =
        this.seams.startProxy ??
        ((controlApiPort) => startSessionDevReverseProxy({ controlApiPort }));
      const proxy = await this.step(startProxy(port).then((started) => (this.proxy = started)));
      if (this.closing) {
        return;
      }

      const startServer = this.seams.startControlServer ?? startControlServer;
      const server = await this.step(
        startServer({
          quitHandler: (by) => void this.requestQuit(by, 'quit'),
          port,
          events: this.events,
          configPath: this.configPath,
          logFile: this.logs.getLogFile(),
          reverseProxy: proxy,
        }).then((started) => (this.server = started)),
      );
      if (this.closing) {
        return;
      }
      if (this.forked) {
        const message: StackMessage = {
          type: 'started',
          pid: process.pid,
          port: server.port,
          sessionId: sessionId(),
          logFile: this.logs.getLogFile(),
          services: servicesToWaitOn([...this.plan.picked]),
        };
        tellParent(this.seams.parentChannel ?? process, message);
      }

      const infra = await this.bringUpInfra();
      if (this.closing) {
        return;
      }
      if (infra) {
        this.plan.infra = infra;
        this.attachInfra(infra);
      }
      // The services are ready: the proxy forwards to the infra routes from here on.
      proxy?.markInfraReady();
      server.bindSession(this);
      proxy?.bindSession(this);
      this.infraControl?.start();
      this.supervisor.launchAll();
      this.phase = 'running';
      this.changed();
      if (readUsage) {
        this.startSampler(await readUsage, infra);
      }
    } catch (err) {
      if (!this.closing) {
        this.fail(errorMessage(err));
      }
    }
  }

  /**
   * The one shutdown path. The first call stops every process (SIGTERM, then SIGKILL after the
   * grace period), closes the proxy, answers a held `/command/quit`, closes the control server and
   * the logfile. A call while that runs kills every process group at once and settles
   * {@link closed} with 1; a `startup-failed` call never escalates, since its caller only follows
   * up on a failure, and a call once the shutdown is done does nothing. A startup step under way
   * (takeover, the proxy, the control server, not infra) is let settle first, and what it produced
   * is closed with the rest. Resolves once this call's part is done.
   */
  async shutdown(reason: ShutdownReason): Promise<void> {
    if (this.done) {
      return;
    }
    if (this.closing) {
      if (!this.killed && reason !== 'startup-failed') {
        this.killed = true;
        this.killEverything();
        this.resolveClosed(1);
      }
      return;
    }
    this.closing = true;
    const failed = this.phase === 'failed';
    this.phase = 'stopping';
    this.changed();
    this.branch?.stop();
    this.sampler?.dispose();
    this.sampler = null;

    const groups = this.supervisor.groups();
    const infra = this.infraControl;
    infra?.stop();
    const living = infra?.takeLiving() ?? [];
    const livingPids = living.flatMap((proc) => (proc.pid ? [proc.pid] : []));
    // Kept for a second request: a leader that has exited by then no longer lists its group.
    for (const pids of groups.values()) {
      pids.forEach((pid) => this.waitedGroups.add(pid));
    }
    livingPids.forEach((pid) => this.waitedGroups.add(pid));
    if (groups.size > 0 || living.length > 0) {
      this.supervisor.log.system.warn('shutting down...');
    }
    for (const pid of livingPids) {
      this.signalGroup(pid, 'SIGTERM');
    }
    await bounded(
      Promise.all([
        this.supervisor.stopAll(),
        bounded(Promise.all(living.map((p) => p.done)), SHUTDOWN_GRACE_MS),
      ]),
      SHUTDOWN_TIMEOUT_MS,
    );
    // A quick leader can leave members of its group behind.
    for (const pids of groups.values()) {
      for (const pid of pids) {
        this.signalGroup(pid, 'SIGKILL');
      }
    }
    for (const pid of livingPids) {
      this.signalGroup(pid, 'SIGKILL');
    }

    // What a startup step under way produces is closed below; its own deadlines bound the wait.
    await this.pendingStep;
    if (this.proxy) {
      await bounded(this.proxy.close(), CLOSE_STEP_MS);
    }
    // Before the server closes, so the streams get them too.
    this.quitCommand?.end({ ok: true });
    this.quitCommand = null;
    if (this.startedAt > 0) {
      this.events.write({
        type: 'session-end',
        cause: reason === 'signal' ? 'signal' : failed || reason === 'startup-failed' ? 'error' : 'quit', // oxfmt-ignore
        durationMs: Date.now() - this.startedAt,
      });
    }
    if (this.server) {
      this.server.flush();
      // After the children are down (so it means "ports freed"), before the server closes.
      this.server.ackQuit();
      await bounded(this.server.close(), CLOSE_STEP_MS);
    }
    this.releaseSignals?.();
    this.releaseSignals = null;
    process.off('exit', this.exitHook);
    await bounded(this.logs.close(), CLOSE_STEP_MS);
    this.done = true;
    this.resolveClosed(this.killed || failed || reason === 'startup-failed' ? 1 : 0);
  }

  getSnapshot(): SessionSnapshot {
    this.snapshot ??= this.buildSnapshot();
    return this.snapshot;
  }

  /** Calls `fn` once per microtask after the snapshot changed; returns the unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Calls `fn` with each step of the infra step's progress, as it happens. */
  subscribeInfra(fn: (progress: InfraProgress) => void): () => void {
    this.infraListeners.add(fn);
    return () => {
      this.infraListeners.delete(fn);
    };
  }

  // ControlManager

  serviceStatuses(): Record<string, string> {
    const statuses: Record<string, string> = {};
    for (const [name, status] of this.supervisor.states()) {
      statuses[name] = publicStatus(status.state);
    }
    return statuses;
  }

  getAllReadiness(): Record<string, boolean> {
    const ready: Record<string, boolean> = {};
    for (const [name, status] of this.supervisor.states()) {
      ready[name] = status.ready;
    }
    return ready;
  }

  getConfig(): unknown {
    return getLoadedConfig();
  }

  getLogFile(): string {
    return this.logs.getLogFile();
  }

  /** Runs `action` on a service for `by`, writing its command's two lines. */
  async runPackage(name: string, action: ServiceAction, by: EventBy): Promise<ServiceRunOutcome> {
    const command = this.events.begin<ServiceCommandEntry>({ type: 'service-command', action, service: name }, by); // oxfmt-ignore
    const outcome = await this.runPackageNow(name, action);
    if (outcome === 'accepted') {
      // A restart runs on: its end is once the service has been started again.
      void this.supervisor.restart(name).then(() => command.end({ ok: true, outcome: 'done' }));
    } else {
      command.end({ ok: outcome === 'done', outcome });
    }
    return outcome;
  }

  private async runPackageNow(name: string, action: ServiceAction): Promise<ServiceRunOutcome> {
    const status = this.supervisor.states().get(name);
    if (!status) {
      if (action === 'start') {
        return this.supervisor.add(name);
      }
      return action === 'stop' && getRegisteredPackages().some((p) => p.name === name)
        ? 'done'
        : 'unknown';
    }
    if (action !== 'stop' && status.state === 'waiting') {
      return 'waiting';
    }
    if (action === 'restart') {
      void this.supervisor.restart(name);
      return 'accepted';
    }
    if (status.state === 'restarting') {
      return 'busy';
    }
    if (action === 'stop') {
      await this.supervisor.stop(name);
      return 'done';
    }
    const config = this.plan.sortedPackages.find((p) => p.name === name);
    if (config && !definesDevScript(config)) {
      return 'unavailable';
    }
    await this.supervisor.start(name);
    return 'done';
  }

  getInfraStatuses(): Record<string, InfraStatus> | null {
    return this.infraControl?.statuses() ?? null;
  }

  subscribeState(fn: () => void): () => void {
    return this.subscribe(fn);
  }

  /** Starts `action` on an infra service for `by`; the `stackctl infra` child it runs writes its lines. */
  runInfra(service: string, action: InfraAction, by: EventBy): InfraRunOutcome {
    return this.infraControl?.run(service, action, by) ?? 'unknown';
  }

  quit(): void {
    void this.shutdown('quit');
  }

  /**
   * Shuts the session down for `by` (a key, or a control API request), writing the quit's
   * `begin` line now and its `end` once the session has stopped. A second request while it
   * stops only goes on to the shutdown, which then kills everything.
   */
  requestQuit(by: EventBy, reason: 'quit' | 'user'): Promise<void> {
    if (!this.closing && !this.quitCommand) {
      this.quitCommand = this.events.begin<SessionCommandEntry>({ type: 'session-command', action: 'quit' }, by); // oxfmt-ignore
    }
    return this.shutdown(reason);
  }

  logControl(command: string, attrs?: Record<string, unknown>): void {
    this.supervisor.log.control.info(attrs ?? {}, command);
  }

  // The run screen's

  /**
   * Runs a one-off command for a service (the commands menu) for `by`, writing its two lines;
   * resolves once it has exited.
   */
  async runOneOff(name: string, command: OneOff, by: EventBy): Promise<OneOffResult> {
    const asked =
      typeof command === 'string'
        ? { kind: 'run' as const, service: name, script: command, args: [] }
        : { kind: 'exec' as const, service: name, command: maskSecrets([command.shell]) };
    const entry = this.events.begin<OneOffCommandEntry>({ type: 'one-off-command', ...asked }, by);
    const result = await this.supervisor.runOneOff(name, command);
    entry.end({ ok: result?.exitCode === 0, exitCode: result?.exitCode ?? null, signal: result?.signal ?? null }); // oxfmt-ignore
    return result;
  }

  /** Drops every buffered line, the hidden ones included. The logfile is untouched. */
  clearLog(): void {
    this.logs.clear();
  }

  /** Shows only the lines matching every term of `text`; an empty `text` shows every line. */
  applyFilter(text: string): void {
    this.logs.applyFilter(text.trim() === '' ? null : { text });
  }

  // DevReverseProxyManager

  getStatus(name: string): string | null {
    const status = this.supervisor.states().get(name);
    return status ? publicStatus(status.state) : null;
  }

  isReady(name: string): boolean {
    return this.readiness.isReady(name);
  }

  // Internals

  /** A startup step: the shutdown waits for it to settle, and closes what it produced. */
  private step<T>(promise: Promise<T>): Promise<T> {
    this.pendingStep = promise.catch(() => {});
    return promise;
  }

  /** One `[stackctl]` line per service that runs only because another needs it. */
  private logDeps(): void {
    for (const { name, why } of planSelection([...this.plan.picked]).services) {
      if (why !== null) {
        this.supervisor.log.system.info(`${name}: ${why}`);
      }
    }
  }

  /** The infra step: its output into the log as it arrives, the rest to {@link subscribeInfra}. */
  /** The infra step, written as an `infra-command` `start` by the session itself. */
  private async bringUpInfra(): Promise<SessionInfra | undefined> {
    const run = this.seams.runInfra ?? ((onEvent) => runSessionInfra(onEvent));
    const command = getLoadedConfig()?.infra
      ? this.events.begin<InfraCommandEntry>({ type: 'infra-command', action: 'start', requested: [] }, { kind: 'session' }) // oxfmt-ignore
      : null;
    try {
      const infra = await run((event) => this.infraEvent(event));
      if (infra && !this.closing) {
        this.emitInfra({ type: 'finished', summary: { ok: true, services: [] } });
      }
      const services = infra?.services.map((s) => s.name) ?? [];
      command?.end({ ok: true, services, results: Object.fromEntries(services.map((s) => [s, 'ready' as const])) }); // oxfmt-ignore
      return infra;
    } catch (err) {
      if (err instanceof InfraFailedError && !this.closing) {
        this.emitInfra({ type: 'finished', summary: err.summary });
      }
      const summary = err instanceof InfraFailedError ? err.summary : null;
      command?.end({
        ok: false,
        ...(summary
          ? { services: summary.services.map((s) => s.service), results: Object.fromEntries(summary.services.map((s) => [s.service, s.ok ? ('ready' as const) : ('failed' as const)])) } // oxfmt-ignore
          : {}),
        error: errorMessage(err),
      });
      throw err;
    }
  }

  private infraEvent(event: InfraEvent): void {
    if (this.closing) {
      return;
    }
    if (event.type === 'output') {
      this.appendInfra(event.service, event.line, event.isError);
      return;
    }
    if (event.type === 'targets') {
      this.logs.addLabels(event.services.map((name) => `infra:${name}`));
      for (const name of event.services) {
        this.infraStartup.set(name, { provider: event.provider, state: 'pending' });
      }
    } else {
      const entry = this.infraStartup.get(event.service);
      if (entry) {
        const state: Partial<Record<typeof event.status, SessionInfraState>> = {
          pending: 'pending',
          starting: 'starting',
          ready: 'running',
          failed: 'failed',
        };
        entry.state = state[event.status] ?? entry.state;
        // A startup step only; a healthy entry has none left (ruling S2-R26).
        entry.detail = entry.state === 'running' ? undefined : event.detail;
      }
    }
    this.changed();
    this.emitInfra(event);
  }

  private emitInfra(progress: InfraProgress): void {
    for (const fn of this.infraListeners) {
      try {
        fn(progress);
      } catch (err) {
        this.handlerError(err);
      }
    }
  }

  /** An infra line under `[infra]` (the provider's own) or `[infra:<service>]`. */
  private appendInfra(service: string | undefined, text: string, isError: boolean): void {
    const name = service === undefined ? 'infra' : `infra:${service}`;
    this.logs.append({
      service: null,
      text: isError ? chalk.red(text) : text,
      isError,
      at: Date.now(),
      ts: logTimestamp(),
      showTs: this.plan.logTimestamps ?? true,
      label: { name, paint: gold },
      filterKey: 'infra',
    });
  }

  private attachInfra(infra: SessionInfra): void {
    if (infra.services.length === 0) {
      return;
    }
    const records = this.supervisor.records;
    this.infraControl = new InfraControl({
      services: infra.services.map((s) => s.name),
      watch: infra.watch,
      cli: this.seams.infraCli ?? [
        process.execPath,
        fileURLToPath(new URL('../cli.js', import.meta.url)),
      ],
      profile: currentProfile(),
      cwd: this.plan.cwd ?? process.cwd(),
      log: (service, text, isError) => this.appendInfra(service, text, isError),
      track: (pid, cwd) => records.add(pid, cwd),
    });
    this.infraControl.subscribe(() => this.changed());
  }

  /** Samples memory for the snapshot; a sample that changes no shown figure notifies nothing. */
  private startSampler(reader: UsageReader | null, infra: SessionInfra | undefined): void {
    if (!reader || this.closing) {
      return;
    }
    const readMemory = infra?.readMemory;
    this.sampler = new UsageSampler(
      reader,
      () => this.supervisor.groups(),
      readMemory ? { interval: INFRA_MEMORY_INTERVAL_MS, read: readMemory } : null,
    );
    this.sampler.subscribe(() => this.changed());
    this.sampler.start();
  }

  private fail(message: string): void {
    this.phase = 'failed';
    this.failure = { message };
    this.supervisor.log.system.error(message);
    this.changed();
  }

  /** A fault in a handler of stackctl's own: logged, never fatal. */
  private handlerError(err: unknown): void {
    try {
      this.supervisor.log.system.error(`internal error: ${errorMessage(err)}`);
    } catch {
      /* nothing more to do */
    }
  }

  /** SIGKILL to every process group the session has, those in a grace period included. */
  private killEverything(): void {
    const pids = new Set(this.waitedGroups);
    for (const group of this.supervisor.groups().values()) {
      group.forEach((pid) => pids.add(pid));
    }
    this.supervisor.killEverything();
    this.infraControl?.kill('SIGKILL');
    for (const pid of pids) {
      this.signalGroup(pid, 'SIGKILL');
    }
  }

  private changed(): void {
    this.snapshot = null;
    if (this.notifying) {
      return;
    }
    this.notifying = true;
    queueMicrotask(() => {
      this.notifying = false;
      for (const fn of this.listeners) {
        try {
          fn();
        } catch (err) {
          this.handlerError(err);
        }
      }
    });
  }

  private readBranchOnce(): string | null {
    if (this.branchBeforeStart === undefined) {
      try {
        this.branchBeforeStart = (this.seams.readBranch ?? readGitBranch)();
      } catch {
        this.branchBeforeStart = null;
      }
    }
    return this.branchBeforeStart;
  }

  private buildSnapshot(): SessionSnapshot {
    const states = this.supervisor.states();
    const configs = new Map(this.plan.sortedPackages.map((p) => [p.name, p]));
    const declared = infraServicesOf(getLoadedConfig());
    const declaredUrls = (provider: string, name: string) =>
      declared.find((d) => d.provider === provider && d.name === name)?.service.urls;
    const links = (urls: UrlEntry[] | undefined) => (urls ?? []).map(normalizeUrlEntry);
    const infra: SessionSnapshot['infra'] = this.infraControl
      ? (this.plan.infra?.services ?? []).map((s) => {
          const state = this.infraControl!.status(s.name) ?? 'stopped';
          return {
            name: s.name,
            provider: s.provider,
            state,
            // Read every 10 s: a stopped entry's last figure would outlive it until the next read.
            ...(state === 'running' ? memoryOf(this.sampler?.infraMemoryBytes(s.name)) : {}),
            links: links(s.urls),
          };
        })
      : [...this.infraStartup].map(([name, entry]) => ({
          name,
          provider: entry.provider,
          state: entry.state,
          ...(entry.detail === undefined ? {} : { detail: entry.detail }),
          links: links(declaredUrls(entry.provider, name)),
        }));
    return {
      phase: this.phase,
      ...(this.failure ? { failure: this.failure } : {}),
      services: [...states].map(([name, status]) => ({
        name,
        state: status.state,
        exitCode: status.exitCode,
        ready: status.ready,
        hasHealthcheck: name in this.plan.healthchecks,
        waitsFor: this.plan.waitsOn[name] ?? [],
        ...memoryOf(this.sampler?.memoryBytes(name)),
        links: links(configs.get(name)?.urls),
      })),
      infra,
      workspaceLinks: this.plan.topLevelUrls ?? [],
      logFile: this.logs.getLogFile(),
      workspace: {
        name: path.basename(this.plan.cwd ?? process.cwd()),
        branch: this.branch ? this.branch.branch : this.readBranchOnce(),
      },
    };
  }
}
