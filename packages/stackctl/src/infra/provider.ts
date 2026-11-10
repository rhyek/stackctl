import path from 'node:path';
import {
  type Config,
  type TokenRecord,
  infraBuildAddress,
  infraServiceDetails,
} from '../config.js';
import type { ControlClient } from '../control-client.js';
import type { Envs, Mode } from '../env.js';
import type { Exec, ExecOptions, ExecResult, LineStream, SpawnInherit, Stream } from './exec.js';
import {
  InfraError,
  type InfraCallbackContext,
  type InfraEvent,
  type InfraRunOptions,
  type InfraRunResult,
  type InfraRunSummary,
  type InfraServiceCallbacks,
  type InfraServiceResult,
  type InfraServiceState,
  type InfraServiceStatus,
  type Readiness,
  unknownServicesError,
} from './types.js';

/** How long a watch lets a burst of changes settle before it reads the states once for all of them. */
const CHANGE_SETTLE_MS = 150;
/**
 * How often a watch re-reads while a service is starting. A health change is reported as a
 * change too; this is the backstop for a transition that a provider's feed missed.
 */
const STARTING_POLL_MS = 2000;
/** How long a watch waits to restart a change feed that ended — the runtime restarted, or isn't up. */
const RESTREAM_MS = 5000;

/** How often `up` re-reads the services' readiness, when the runtime doesn't say. */
const DEFAULT_POLL_INTERVAL_MS = 500;

/** What a provider needs from the session it runs in. */
export interface ProviderRuntime {
  /** The workspace root, absolute. */
  workspaceDir: string;
  mode: Mode;
  /** The resolved config, handed to every callback as `config`. */
  config: Config<string>;
  /**
   * The workspace-scope `.env` files for the mode and the ambient environment, the ambient
   * environment winning over the files except for the variables `env.override` names.
   */
  envs: Envs;
  /** The config's top-level `tokens`. */
  tokens: TokenRecord;
  exec: Exec;
  spawnInherit: SpawnInherit;
  /** Starts a long-running command read line by line; defaults to {@link streamLines}. */
  stream?: Stream;
  /**
   * Finds the running dev session of this config and mode, for a callback's `control`;
   * `undefined` when there is none. Absent, callbacks get no `control`.
   */
  connectControl?: () => Promise<ControlClient | undefined>;
  pollIntervalMs?: number;
}

/** A live reading of services' states, from {@link InfraProvider.watchStates}. */
export interface InfraWatch {
  /** Stops watching; nothing is reported after it. */
  stop: () => void;
  /** Reads the states again now, as after an action that changed them. */
  refresh: () => void;
}

export interface InfraRunRequest {
  /** The services to act on. Omitted or empty means all of them. */
  services?: string[];
  /** Destroy the targets before starting them. */
  reset?: boolean;
  onEvent?: (event: InfraEvent) => void;
}

export type Emit = (event: InfraEvent) => void;

/** The callbacks that run before the start; `afterReady` has its own path and context. */
type CallbackName = 'beforeDestroy' | 'afterDestroy' | 'beforeUp';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `90000` → `90s`, `300000` → `5m`. */
function formatTimeout(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0
    ? `${String(ms / 60_000)}m`
    : `${String(Math.round(ms / 100) / 10)}s`;
}

/**
 * One way of running infrastructure. This base class owns the **lifecycle** — the order of
 * destroy, callbacks, start, the readiness wait and `afterReady`, the timeout, and what gets
 * reported — and a subclass supplies only the primitives, with nothing to say about ordering.
 */
export abstract class InfraProvider {
  /** The provider's key under `infra` in the config (and its passthrough subcommand). */
  abstract readonly key: string;

  protected constructor(
    protected readonly runtime: ProviderRuntime,
    /** What the config says about each service it names: its callbacks, and whether it runs. */
    protected readonly serviceConfig: Record<
      string,
      InfraServiceCallbacks & { enabled?: boolean; port?: number; publicOrigin?: string }
    >,
    protected readonly readyTimeout: number,
  ) {}

  /** The services this provider can run. */
  abstract listServices(): Promise<string[]>;
  /** Stops and removes the services, keeping their data. Resolves with the tool's exit code. */
  abstract down(services: string[]): Promise<number>;
  /** Runs the provider's own tool with `args`, in `invocationCwd`, the terminal handed over. */
  abstract passthrough(args: string[], invocationCwd: string): Promise<number>;
  /**
   * How each target stands right now. Read-only, and unlike the readiness poll `up` runs it
   * remembers nothing between calls, so it can be read as often as a display needs.
   */
  abstract readStates(targets: string[]): Promise<Map<string, InfraServiceState>>;

  /**
   * Memory per running service, in bytes, for the footer. A provider that can't tell returns none;
   * so does one whose reading fails.
   */
  readMemory(): Promise<Map<string, number>> {
    return Promise.resolve(new Map<string, number>());
  }
  /**
   * Starts the runtime's feed of changes to the targets, calling `onChange` for each — what
   * changed doesn't matter, {@link watchStates} reads the states again either way. The feed
   * ends when the runtime stops sending (it restarted, or isn't running).
   */
  protected abstract streamChanges(targets: string[], onChange: () => void): LineStream;

  /**
   * Reports the targets' states now and again whenever they change, until stopped: a reading
   * after every burst of changes from {@link streamChanges}, a re-read every few seconds while
   * a service is starting, and a new feed whenever one ends. A reading that fails (the runtime
   * not answering, say) is skipped, not reported.
   */
  watchStates(
    targets: string[],
    onStates: (states: Map<string, InfraServiceState>) => void,
  ): InfraWatch {
    let stopped = false;
    let reading = false;
    let readAgain = false;
    let feed: LineStream | null = null;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const after = (ms: number, fn: () => void) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
      return timer;
    };
    const cancel = (timer: ReturnType<typeof setTimeout> | null) => {
      if (timer) {
        clearTimeout(timer);
        timers.delete(timer);
      }
    };
    let settle: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setTimeout> | null = null;

    const read = async (): Promise<void> => {
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      try {
        const states = await this.readStates(targets);
        if (stopped) {
          return;
        }
        onStates(states);
        cancel(poll);
        poll = [...states.values()].includes('starting')
          ? after(STARTING_POLL_MS, () => void read())
          : null;
      } catch {
        // The runtime not answering: keep the last states, and let the next change retry.
      } finally {
        reading = false;
        if (readAgain && !stopped) {
          readAgain = false;
          void read();
        }
      }
    };

    const listen = () => {
      feed = this.streamChanges(targets, () => {
        if (stopped) {
          return;
        }
        cancel(settle);
        settle = after(CHANGE_SETTLE_MS, () => void read());
      });
      void feed.done.then(() => {
        if (!stopped) {
          after(RESTREAM_MS, () => {
            void read();
            listen();
          });
        }
      });
    };

    void read();
    listen();
    return {
      stop: () => {
        stopped = true;
        for (const timer of timers) {
          clearTimeout(timer);
        }
        timers.clear();
        feed?.stop();
      },
      refresh: () => void read(),
    };
  }

  /** Removes the named services' containers and data — and nothing belonging to another service. */
  protected abstract destroyServices(targets: string[], emit: Emit): Promise<void>;
  /** Removes everything the provider created for the project. */
  protected abstract destroyAll(emit: Emit): Promise<void>;
  /**
   * Which of the targets have no data yet — the ones the coming start will create it for.
   * Called once, right before {@link startServices}: the last moment the question can be
   * answered, and a provider's one look at how things stand before it changes them.
   */
  protected abstract readFresh(targets: string[]): Promise<Set<string>>;
  /** Starts the services, without waiting for them to become ready. */
  protected abstract startServices(targets: string[], emit: Emit): Promise<void>;
  /** One readiness reading per target. */
  protected abstract readStatuses(targets: string[]): Promise<Map<string, Readiness>>;
  /** Text explaining why a service failed (its log tail, say); empty when there is none. */
  protected abstract failureDetail(service: string): Promise<string>;
  /** Runs the provider's tool for a callback's `compose` helper. */
  protected abstract runTool(args: string[], opts: ExecOptions): Promise<ExecResult>;

  /** How the provider's tool is named in a message about a command that failed. */
  protected toolLabel(): string {
    return this.key;
  }

  /** Variables the provider adds to what callbacks see and to the commands they run. */
  protected extraEnv(): Record<string, string> {
    return {};
  }

  /**
   * Brings the targets up and waits until each is ready: (with `reset`) `beforeDestroy`,
   * destroy them and `afterDestroy`, then `beforeUp`, one start for all of them, a readiness poll, and each
   * service's `afterReady` the moment *it* is ready.
   *
   * A failure before the services are started aborts the run and fails every target. After
   * that, each service runs to its own result. Rejects only for a request that can't be run
   * at all (an unknown service); everything else is in the summary.
   */
  async up(req: InfraRunRequest = {}): Promise<InfraRunSummary> {
    const emit = req.onEvent ?? (() => {});
    const reset = req.reset ?? false;
    const { targets } = await this.resolveTargets(req.services, 'up');
    const run = new Run(targets, emit, this.runtime.connectControl);
    emit({ type: 'targets', provider: this.key, action: 'up', services: targets });
    run.setAll('pending');
    let fresh: Set<string>;

    try {
      // Nothing enabled is nothing to destroy or start — not an error, and not a reason to run
      // the provider's tool with an empty service list, which it would read as "all of them".
      if (targets.length === 0) {
        return run.summary();
      }
      if (reset) {
        // Exactly the services about to be started, never the whole project: a reset must not
        // take the data of a service it isn't bringing back — one disabled in this mode, say.
        run.setAll('destroying');
        if (!(await this.runPhase('beforeDestroy', run, reset))) {
          return run.summary();
        }
        await this.destroyServices(targets, emit);
        if (!(await this.runPhase('afterDestroy', run, reset))) {
          return run.summary();
        }
      }
      run.setAll('starting');
      if (!(await this.runPhase('beforeUp', run, reset))) {
        return run.summary();
      }
      // After any destroy, so a reset service counts: its data is about to be created anew.
      fresh = await this.readFresh(targets);
      await this.startServices(targets, emit);
    } catch (err) {
      run.failAll(errorMessage(err));
      return run.summary();
    }

    await this.awaitReady(run, reset, fresh);
    return run.summary();
  }

  /**
   * Calls `beforeDestroy({ reset: false })`, removes the targets and their data, then calls
   * `afterDestroy({ reset: false })`. A `beforeDestroy` failure removes nothing. With no
   * services named it removes the whole project — disabled services' leftovers included — and
   * the targets, for the callbacks, are the enabled ones.
   */
  async destroy(req: Omit<InfraRunRequest, 'reset'> = {}): Promise<InfraRunSummary> {
    const emit = req.onEvent ?? (() => {});
    const { targets, everything } = await this.resolveTargets(req.services, 'destroy');
    const run = new Run(targets, emit, this.runtime.connectControl);
    emit({ type: 'targets', provider: this.key, action: 'destroy', services: targets });
    run.setAll('destroying');
    if (!(await this.runPhase('beforeDestroy', run, false))) {
      return run.summary();
    }
    try {
      await (everything ? this.destroyAll(emit) : this.destroyServices(targets, emit));
    } catch (err) {
      // With no targets — every service disabled — there is nothing to report the failure on,
      // so it propagates instead of vanishing.
      if (targets.length === 0) {
        throw err;
      }
      run.failAll(errorMessage(err));
      return run.summary();
    }
    const failures = await this.runCallbacks('afterDestroy', run, false);
    for (const service of targets) {
      const error = failures.get(service);
      if (error === undefined) {
        run.succeed(service, 'destroyed');
      } else {
        run.fail(service, error);
      }
    }
    return run.summary();
  }

  /**
   * The services a request acts on, validated: a name the provider doesn't have is an error
   * listing the real ones — for a service named on the command line and for a key under the
   * config's `services` alike, before anything is touched.
   *
   * With none named, it is every **enabled** service. A disabled one can't be brought up by
   * name either — but it can be destroyed by name, to clean up after a mode where it ran.
   */
  private async resolveTargets(
    named: string[] | undefined,
    action: 'up' | 'destroy',
  ): Promise<{ targets: string[]; everything: boolean }> {
    const all = await this.listServices();
    const strays = Object.keys(this.serviceConfig).filter((name) => !all.includes(name));
    if (strays.length > 0) {
      throw new InfraError(
        `infra: the config's \`${this.key}\` services name ${strays.map((s) => `"${s}"`).join(', ')}, ` +
          `which ${strays.length > 1 ? 'are not services' : 'is not a service'} the provider has. ` +
          `Services: ${all.join(', ') || '(none)'}`,
      );
    }
    const enabled = (name: string) => this.serviceConfig[name]?.enabled !== false;
    if (!named || named.length === 0) {
      return { targets: all.filter(enabled), everything: true };
    }
    const unknown = named.filter((name) => !all.includes(name));
    if (unknown.length > 0) {
      throw unknownServicesError(unknown, all);
    }
    const disabled = named.filter((name) => !enabled(name));
    if (action === 'up' && disabled.length > 0) {
      throw new InfraError(
        `infra service${disabled.length > 1 ? 's' : ''} ${disabled.map((s) => `"${s}"`).join(', ')} ` +
          `${disabled.length > 1 ? 'are' : 'is'} disabled for mode "${this.runtime.mode}" ` +
          '(`enabled` in the stackctl config), so there is nothing to bring up.',
      );
    }
    return { targets: [...new Set(named)], everything: false };
  }

  /**
   * Runs one callback for every target that has it, and decides the run: `true` to carry on.
   * If any failed, that service fails with its own error and the rest fail as not started (or,
   * for `beforeDestroy`, not destroyed) — these phases come before the single start or destroy,
   * so there is no partial way forward.
   */
  private async runPhase(name: CallbackName, run: Run, reset: boolean): Promise<boolean> {
    const failures = await this.runCallbacks(name, run, reset);
    if (failures.size === 0) {
      return true;
    }
    const culprits = [...failures.keys()].join(', ');
    for (const service of run.targets) {
      const skipped = name === 'beforeDestroy' ? 'not destroyed' : 'not started';
      run.fail(service, failures.get(service) ?? `${skipped}: ${culprits} failed in ${name}`);
    }
    return false;
  }

  /** Runs `name` for each target that has it, in parallel. Returns the failures, by service. */
  private async runCallbacks(
    name: CallbackName,
    run: Run,
    reset: boolean,
  ): Promise<Map<string, string>> {
    const failures = new Map<string, string>();
    await Promise.all(
      run.targets.map(async (service) => {
        const callback = this.serviceConfig[service]?.[name];
        if (!callback) {
          return;
        }
        try {
          await callback(this.context(service, reset, run, await run.control()));
        } catch (err) {
          failures.set(service, `${name} failed: ${errorMessage(err)}`);
        }
      }),
    );
    return failures;
  }

  /**
   * Polls until every target is ready or failed, or the timeout elapses. Each service's
   * `afterReady` starts as soon as that service is ready, so a slow one doesn't hold up
   * another's migrations.
   */
  private async awaitReady(run: Run, reset: boolean, fresh: Set<string>): Promise<void> {
    const pending = new Set(run.targets);
    const settling: Promise<void>[] = [];
    const lastDetail = new Map<string, string>();
    const deadline = Date.now() + this.readyTimeout;
    const interval = this.runtime.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    while (pending.size > 0) {
      let readings: Map<string, Readiness>;
      try {
        readings = await this.readStatuses([...pending]);
      } catch (err) {
        for (const service of pending) {
          run.fail(service, errorMessage(err));
        }
        break;
      }
      for (const service of pending) {
        const reading = readings.get(service) ?? { state: 'pending', detail: 'creating' };
        if (reading.state === 'ready') {
          pending.delete(service);
          settling.push(this.settleReady(service, run, reset, fresh.has(service)));
        } else if (reading.state === 'failed') {
          pending.delete(service);
          settling.push(this.settleFailed(service, reading.detail, run));
        } else if (lastDetail.get(service) !== reading.detail) {
          lastDetail.set(service, reading.detail);
          run.set(service, 'starting', reading.detail);
        }
      }
      if (pending.size === 0) {
        break;
      }
      if (Date.now() >= deadline) {
        for (const service of pending) {
          const saw = lastDetail.get(service);
          run.fail(
            service,
            `not ready after ${formatTimeout(this.readyTimeout)}${saw ? ` (${saw})` : ''}`,
          );
        }
        break;
      }
      await sleep(interval);
    }
    await Promise.all(settling);
  }

  private async settleReady(
    service: string,
    run: Run,
    reset: boolean,
    fresh: boolean,
  ): Promise<void> {
    const callback = this.serviceConfig[service]?.afterReady;
    if (callback) {
      run.set(service, 'starting', 'afterReady');
      try {
        await callback({
          ...this.context(service, reset, run, await run.control()),
          fresh,
        });
      } catch (err) {
        run.fail(service, `afterReady failed: ${errorMessage(err)}`);
        return;
      }
    }
    run.succeed(service, 'ready');
  }

  private async settleFailed(service: string, detail: string, run: Run): Promise<void> {
    let why = '';
    try {
      why = (await this.failureDetail(service)).trim();
    } catch {
      /* the reading already says it failed; the explanation is a bonus */
    }
    run.fail(service, why ? `${detail}\n${why}` : detail);
  }

  /** What a callback for `service` receives. */
  private context(
    service: string,
    reset: boolean,
    run: Run,
    control: ControlClient | undefined,
  ): InfraCallbackContext {
    const { workspaceDir, mode, config, tokens, exec } = this.runtime;
    const { emit } = run;
    const envs = { ...this.runtime.envs, ...this.extraEnv() };
    const output = (line: string, isError: boolean) =>
      emit({ type: 'output', service, line, isError });
    const execOptions = (opts: InfraRunOptions | undefined): ExecOptions => ({
      cwd: path.resolve(workspaceDir, opts?.cwd ?? '.'),
      env: { ...envs, ...opts?.env },
      onLine: output,
    });
    const settle = (
      label: string,
      result: ExecResult,
      opts: InfraRunOptions | undefined,
    ): InfraRunResult => {
      if (result.exitCode !== 0 && opts?.reject !== false) {
        throw new Error(`\`${label}\` exited with code ${String(result.exitCode)}`);
      }
      return result;
    };
    return {
      service: infraServiceDetails(service, this.serviceConfig[service]),
      buildAddress: infraBuildAddress(service, this.serviceConfig[service], config),
      mode,
      config,
      reset,
      workspaceDir,
      envs,
      tokens,
      compose: async (args, opts) =>
        settle(
          [this.toolLabel(), ...args].join(' '),
          await this.runTool(args, execOptions(opts)),
          opts,
        ),
      exec: async (command, args = [], opts) =>
        settle([command, ...args].join(' '), await exec(command, args, execOptions(opts)), opts),
      log: (message) => {
        for (const line of message.split('\n')) {
          output(line, false);
        }
      },
      control,
      data: run.data(service),
    };
  }
}

/** The bookkeeping of one `up` or `destroy`: each target's result, reported as it changes. */
class Run {
  private readonly results = new Map<string, InfraServiceResult>();
  private session: Promise<ControlClient | undefined> | null = null;
  private readonly dataByService = new Map<string, Record<string, unknown>>();

  constructor(
    readonly targets: string[],
    readonly emit: Emit,
    private readonly connectControl?: () => Promise<ControlClient | undefined>,
  ) {}

  /**
   * The callbacks' `control`: looked up once, when the run's first callback starts — a run with
   * no callbacks never looks — and shared by the rest. A lookup that fails is no session.
   */
  control(): Promise<ControlClient | undefined> {
    this.session ??= this.connectControl
      ? this.connectControl().catch(() => undefined)
      : Promise.resolve(undefined);
    return this.session;
  }

  /** The callbacks' `data` for `service`: one object for the whole run, empty when it starts. */
  data(service: string): Record<string, unknown> {
    let data = this.dataByService.get(service);
    if (!data) {
      data = {};
      this.dataByService.set(service, data);
    }
    return data;
  }

  set(service: string, status: InfraServiceStatus, detail?: string): void {
    this.emit(
      detail === undefined
        ? { type: 'status', service, status }
        : { type: 'status', service, status, detail },
    );
  }

  setAll(status: InfraServiceStatus): void {
    for (const service of this.targets) {
      this.set(service, status);
    }
  }

  succeed(service: string, status: 'ready' | 'destroyed'): void {
    this.results.set(service, { service, ok: true });
    this.set(service, status);
  }

  fail(service: string, error: string): void {
    this.results.set(service, { service, ok: false, error });
    this.set(service, 'failed', error);
  }

  failAll(error: string): void {
    for (const service of this.targets) {
      this.fail(service, error);
    }
  }

  summary(): InfraRunSummary {
    const services = this.targets.map(
      (service) => this.results.get(service) ?? { service, ok: false, error: 'did not finish' },
    );
    return { ok: services.every((s) => s.ok), services };
  }
}
