import { type Config, type TokenRecord, infraBuildAddress, infraServiceDetails } from '../config';
import type { ControlClient } from '../control-client';
import type { Envs, Profile } from '../env';
import {
  type HookScope,
  failedLine,
  lifecycleContext,
  runHook,
  scopeExec,
} from '../lifecycle/hooks';
import type { Exec, LineStream, SpawnInherit, Stream } from '../spawn';
import {
  InfraError,
  type InfraCallbackContext,
  type InfraDestroyTrigger,
  type InfraEvent,
  type InfraRunOptions,
  type InfraRunAction,
  type InfraRunContext,
  type InfraRunResult,
  type InfraRunSummary,
  type InfraServiceCallbacks,
  type InfraServiceResult,
  type InfraServiceState,
  type InfraServiceStatus,
  type InfraStartTrigger,
  type InfraStopTrigger,
  type InfraTrigger,
  type Readiness,
  unknownServicesError,
} from './types';

/** How long a watch lets a burst of changes settle before it reads the states once for all of them. */
const CHANGE_SETTLE_MS = 150;
/**
 * How often a watch re-reads while a service is starting. A health change is reported as a
 * change too; this is the backstop for a transition that a provider's feed missed.
 */
const STARTING_POLL_MS = 2000;
/** How long a watch waits to restart a change feed that ended — the runtime restarted, or isn't up. */
const RESTREAM_MS = 5000;

/**
 * The step a service shows once it is ready and its own `afterReady` is done, while the provider's
 * `afterReady` waits for the other services.
 */
const HELD_DETAIL = 'ready, waiting for the other services';

/** How often `up` re-reads the services' readiness, when the runtime doesn't say. */
const DEFAULT_POLL_INTERVAL_MS = 500;

/** What a provider needs from the session it runs in. */
export interface ProviderRuntime {
  /** The workspace root, absolute. */
  workspaceDir: string;
  profile: Profile;
  /** The resolved config, handed to every callback as `config`. */
  config: Config<string>;
  /**
   * The workspace-scope `.env` files for the profile and the ambient environment, the ambient
   * environment winning over the files except for the variables `env.override` names.
   */
  envs: Envs;
  /** The config's top-level `tokens`. */
  tokens: TokenRecord;
  /** Runs a command to completion, captured: {@link execLines}, or a stand-in in specs. */
  exec: Exec;
  /** Runs a command with the terminal handed over: {@link spawnInherit}, or a stand-in. */
  spawnInherit: SpawnInherit;
  /** Starts a long-running command read line by line: {@link streamLines}, or a stand-in. */
  stream: Stream;
  /**
   * Finds the running dev session of this config and profile, for a callback's `control`;
   * `undefined` when there is none. Absent, callbacks get no `control`.
   */
  connectControl?: () => Promise<ControlClient | undefined>;
  /**
   * Aborting it kills every command the callbacks are running: a session's hard kill, for the
   * infra startup it runs in its own process. Absent, nothing but the command's end stops them.
   */
  signal?: AbortSignal;
  /**
   * Aborting it asks every command the callbacks are running to end (SIGTERM, then a kill if one
   * still runs a moment later): a session's shutdown beginning, for the same infra startup.
   */
  abandon?: AbortSignal;
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
  /**
   * What started the run, which its callbacks get as `trigger`: `session`, `start` (the default),
   * `restart` or `reset`. A `reset` destroys the targets before starting them.
   */
  trigger?: InfraStartTrigger;
  /** How long to wait for the services to be ready, in ms. Default: the provider's `readyTimeout`. */
  readyTimeoutMs?: number;
  /**
   * The callbacks' shared `data`, when the run carries on one already begun: a session's start
   * hands it what its own `beforeStart` wrote. Default: a new, empty object.
   */
  data?: Record<string, unknown>;
  onEvent?: (event: InfraEvent) => void;
}

/** What {@link InfraProvider.down} is asked: like {@link InfraRunRequest}, for a stop. */
export interface InfraStopRequest {
  /** The services to stop. Omitted or empty means every enabled one. */
  services?: string[];
  /**
   * What started the stop, which its callbacks get as `trigger`: `stop` (the default), or
   * `restart` for a restart's first half.
   */
  trigger?: InfraStopTrigger;
  /**
   * The callbacks' shared `data`: a restart hands its stop and its start the same object.
   * Default: a new, empty object.
   */
  data?: Record<string, unknown>;
  onEvent?: (event: InfraEvent) => void;
}

/**
 * A provider's own `beforeStart`, `afterStart` or `afterReady`: once per run that starts its
 * services, around theirs.
 */
export type ProjectStartCallback = (
  ctx: InfraRunContext<TokenRecord, InfraStartTrigger>,
) => void | Promise<void>;

/** A provider's own `beforeStop` or `afterStop`: once per run that stops its services, around theirs. */
export type ProjectStopCallback = (
  ctx: InfraRunContext<TokenRecord, InfraStopTrigger>,
) => void | Promise<void>;

/** A provider's own `beforeDestroy` or `afterDestroy`: once per run that destroys its services, around theirs. */
export type ProjectDestroyCallback = (
  ctx: InfraRunContext<TokenRecord, InfraDestroyTrigger>,
) => void | Promise<void>;

/** The provider's own `lifecycle`, for the whole project. */
export interface ProjectCallbacks {
  beforeStart?: ProjectStartCallback;
  afterStart?: ProjectStartCallback;
  afterReady?: ProjectStartCallback;
  beforeStop?: ProjectStopCallback;
  afterStop?: ProjectStopCallback;
  beforeDestroy?: ProjectDestroyCallback;
  afterDestroy?: ProjectDestroyCallback;
}

/** The triggers each of the provider's own callbacks sees. */
interface ProjectTriggers {
  beforeStart: InfraStartTrigger;
  afterStart: InfraStartTrigger;
  afterReady: InfraStartTrigger;
  beforeStop: InfraStopTrigger;
  afterStop: InfraStopTrigger;
  beforeDestroy: InfraDestroyTrigger;
  afterDestroy: InfraDestroyTrigger;
}

export type Emit = (event: InfraEvent) => void;

/** What failed once a destroy sequence's removal was done: each service's `afterDestroy`, and the provider's. */
interface Removed {
  failures: Map<string, string>;
  project?: string;
}

/**
 * A service's callbacks that run once per phase, with the triggers each can see; `afterReady` has
 * its own path and context.
 */
interface PhaseTriggers {
  beforeDestroy: InfraDestroyTrigger;
  afterDestroy: InfraDestroyTrigger;
  beforeStart: InfraStartTrigger;
  afterStart: InfraStartTrigger;
  beforeStop: InfraStopTrigger;
  afterStop: InfraStopTrigger;
}

type CallbackName = keyof PhaseTriggers;

/** A service's callbacks for those phases, each taking a context with its phase's triggers. */
type PhaseCallbacks = {
  [N in CallbackName]?: (
    ctx: InfraCallbackContext<TokenRecord, PhaseTriggers[N]>,
  ) => void | Promise<void>;
};

const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

/**
 * Fails every target of `run` with `error`, and returns its summary; with no target, there being
 * no service to fail, rejects with it instead.
 */
function failEvery(run: Run, error: string): InfraRunSummary {
  if (run.targets.length === 0) {
    throw new InfraError(error);
  }
  run.failAll(error);
  return run.summary();
}

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
      {
        lifecycle?: InfraServiceCallbacks;
        enabled?: boolean;
        port?: number;
        publicOrigin?: string;
      }
    >,
    protected readonly readyTimeout: number,
    /** The provider's own `lifecycle`, for the whole project. */
    protected readonly projectLifecycle: ProjectCallbacks = {},
  ) {}

  /** The services this provider can run. */
  abstract listServices(): Promise<string[]>;
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

  /**
   * What a reset or a destroy of `targets` couldn't remove, one message per thing, `[]` when it
   * can remove all of it. `everything` is the whole project (nothing was named). Asked before any
   * hook runs, so a refusal leaves everything as it was.
   */
  protected abstract removalRefusals(
    targets: string[],
    everything: boolean,
    action: 'reset' | 'destroy',
  ): Promise<string[]>;
  /** Stops the targets and removes their containers, keeping their named volumes. */
  protected abstract stopServices(targets: string[], emit: Emit): Promise<void>;
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
  /** The command line that runs the provider's tool with `args`, for its callback helper. */
  protected abstract toolCommand(args: string[]): [command: string, args: string[]];
  /**
   * What the provider adds to its callbacks' context: its tool's helper (Docker Compose's
   * `compose`), given `run`, which runs the tool with the callback's environment and settles its
   * exit as `exec` does.
   */
  protected abstract toolContext(
    run: (args: string[], opts?: InfraRunOptions) => Promise<InfraRunResult>,
  ): object;

  /** How the provider's tool is named in a message about a command that failed. */
  protected toolLabel(): string {
    return this.key;
  }

  /** Variables the provider adds to what callbacks see and to the commands they run. */
  protected extraEnv(): Record<string, string> {
    return {};
  }

  /** Whether the config leaves `service` enabled in this profile. */
  protected enabled(service: string): boolean {
    return this.serviceConfig[service]?.enabled !== false;
  }

  /**
   * Brings the targets up and waits until each is ready. On a `reset`, first the destroy
   * sequence, as {@link destroy} runs it, with `reset` as its trigger; an `afterDestroy` failure
   * stops the reset there, before the start, every target left `destroyed` (the culprit with its
   * hook's error, `hookFailed`). Then the provider's own `beforeStart`, each service's
   * `beforeStart`, one start for all of them, each service's `afterStart` and the provider's, a
   * readiness poll, each service's `afterReady` the moment *it* is ready, and the provider's
   * `afterReady` once every one of them is. While the provider's `afterReady` can still run, each
   * service's final `ready` waits for it; once a service has failed, the rest are ready as soon as
   * they are. A reset with nothing named destroys the whole project; one that couldn't remove
   * something is refused before any of it runs.
   *
   * A failure before the services are started aborts the run and fails every target, and so does
   * a failing provider `afterStart` or `afterReady`. Otherwise each service runs to its own
   * result: a failing `afterStart` or `afterReady` fails only its own service. With no target the
   * provider's own hooks still run, around steps that do nothing, and the first that fails
   * rejects, there being no service to fail. Rejects too for a request that can't be run at all
   * (an unknown service); everything else is in the summary.
   */
  async up(req: InfraRunRequest = {}): Promise<InfraRunSummary> {
    const emit = req.onEvent ?? (() => {});
    const trigger = req.trigger ?? 'start';
    const { targets, everything } = await this.resolveTargets(req.services, 'up');
    // Nothing enabled is nothing to destroy or start — not an error, and not a reason to run the
    // provider's tool with an empty service list, which it would read as "all of them". The
    // provider's own hooks still run: what they do is about the project, not a service.
    const noTarget = targets.length === 0;
    if (trigger === 'reset' && !noTarget) {
      await this.refuseWhatCantBeRemoved(targets, everything, 'reset');
    }
    const run = new Run(targets, emit, this.runtime.connectControl, req.data);
    emit({ type: 'targets', provider: this.key, action: 'up', services: targets });
    run.setAll('pending');
    let fresh = new Set<string>();

    try {
      if (trigger === 'reset') {
        // With nothing named, the whole project, disabled services' data included; with names,
        // exactly those services.
        run.setAll('destroying');
        const removed = await this.destroyTargets(run, 'reset', everything);
        if (!removed) {
          return run.summary();
        }
        if (removed.failures.size > 0 || removed.project !== undefined) {
          const culprits = [...removed.failures.keys()].join(', ');
          for (const service of targets) {
            const errors = [removed.failures.get(service), removed.project].filter(isDefined);
            if (errors.length > 0) {
              run.hookFailed(service, 'destroyed', errors.join('\n'), 'destroyed');
            } else {
              run.leftAt(service, 'destroyed', `not started: ${culprits} failed in afterDestroy`);
            }
          }
          return run.summary();
        }
      }
      run.setAll('starting');
      const failure = await this.runProjectHook('beforeStart', run, trigger);
      if (failure !== undefined) {
        return failEvery(run, failure);
      }
      if (!(await this.runPhase('beforeStart', run, trigger))) {
        return run.summary();
      }
      if (!noTarget) {
        // After any destroy, so a reset service counts: its data is about to be created anew.
        fresh = await this.readFresh(targets);
        await this.startServices(targets, emit);
      }
    } catch (err) {
      if (noTarget) {
        throw err;
      }
      run.failAll(errorMessage(err));
      return run.summary();
    }

    // The services are started: from here on, a failure leaves running whatever is running.
    for (const service of targets) {
      if (this.serviceConfig[service]?.lifecycle?.afterStart) {
        run.set(service, 'starting', 'afterStart');
      }
    }
    const startFailures = await this.runCallbacks('afterStart', run, trigger, (service, error) =>
      run.fail(service, error),
    );
    const started = targets.filter((service) => !startFailures.has(service));
    if (this.projectLifecycle.afterStart) {
      for (const service of started) {
        run.set(service, 'starting', `${this.key} afterStart`);
      }
    }
    const projectStart = await this.runProjectHook('afterStart', run, trigger);
    if (projectStart !== undefined) {
      // On screen whatever else failed: the run's own error line, as a provider stop hook's is. A
      // service its own `afterStart` already failed keeps that status and result.
      emit({ type: 'output', line: projectStart, isError: true });
      for (const service of started) {
        run.fail(service, projectStart);
      }
      if (noTarget) {
        throw new InfraError(projectStart);
      }
      return run.summary();
    }

    // The provider's `afterReady` runs only if every target gets ready.
    const hold = this.projectLifecycle.afterReady !== undefined && startFailures.size === 0;
    const allReady = await this.awaitReady(
      run,
      started,
      trigger,
      fresh,
      req.readyTimeoutMs ?? this.readyTimeout,
      hold,
    );
    if (!allReady) {
      return run.summary();
    }
    for (const service of targets) {
      run.set(service, 'starting', `${this.key} afterReady`);
    }
    const projectReady = await this.runProjectHook('afterReady', run, trigger);
    if (projectReady !== undefined) {
      return failEvery(run, projectReady);
    }
    for (const service of targets) {
      run.succeed(service, 'ready');
    }
    return run.summary();
  }

  /**
   * Stops the targets and removes their containers, keeping their named volumes: with none named,
   * every enabled service, by name, so a disabled service's container and the project's network
   * are left alone. A disabled service named is refused before anything stops.
   *
   * Around the stop: the provider's own `beforeStop`, each service's `beforeStop`, then (once
   * the stop is done) each service's `afterStop` and the provider's `afterStop`. A hook that
   * fails holds nothing back: the stop goes ahead, and the failure is an error line in the run's
   * output (under the service, or untagged for the provider's own). A service stopped with a
   * hook failure ends `stopped`, its result failed with `hookFailed` and every failure that
   * concerns it (its own, and the provider's, which concern every service), in the order the
   * hooks ran. A stop that fails fails every target with its error and the hooks' before it,
   * and runs no `afterStop`. The provider's hooks run with no target too, and a failure then
   * rejects, having no service to fail.
   */
  async down(req: InfraStopRequest = {}): Promise<InfraRunSummary> {
    const emit = req.onEvent ?? (() => {});
    const trigger = req.trigger ?? 'stop';
    const { targets } = await this.resolveTargets(req.services, 'down');
    const run = new Run(targets, emit, this.runtime.connectControl, req.data);
    emit({ type: 'targets', provider: this.key, action: 'down', services: targets });
    run.setAll('stopping');
    // What failed, in the order the hooks ran: by service, and the provider's own.
    const hookErrors = new Map<string, string[]>(targets.map((service) => [service, []]));
    const projectErrors: string[] = [];
    const project = async (name: 'beforeStop' | 'afterStop') => {
      const failure = await this.runProjectHook(name, run, trigger);
      if (failure !== undefined) {
        emit({ type: 'output', line: failure, isError: true });
        projectErrors.push(failure);
        for (const errors of hookErrors.values()) {
          errors.push(failure);
        }
      }
    };
    const services = async (name: 'beforeStop' | 'afterStop') => {
      for (const [service, failure] of await this.runCallbacks(name, run, trigger)) {
        emit({ type: 'output', service, line: failure, isError: true });
        hookErrors.get(service)?.push(failure);
      }
    };

    await project('beforeStop');
    await services('beforeStop');
    if (targets.length > 0) {
      try {
        await this.stopServices(targets, emit);
      } catch (err) {
        for (const service of targets) {
          run.fail(service, [errorMessage(err), ...(hookErrors.get(service) ?? [])].join('\n'));
        }
        return run.summary();
      }
    }
    await services('afterStop');
    await project('afterStop');

    if (targets.length === 0 && projectErrors.length > 0) {
      throw new InfraError(projectErrors.join('\n'));
    }
    for (const service of targets) {
      const errors = hookErrors.get(service) ?? [];
      if (errors.length === 0) {
        run.succeed(service, 'stopped');
      } else {
        run.hookFailed(service, 'stopped', errors.join('\n'));
      }
    }
    return run.summary();
  }

  /**
   * Removes the targets and their data, around the hooks: the provider's own `beforeDestroy`,
   * each service's `beforeDestroy`, the removal, each service's `afterDestroy`, the provider's
   * `afterDestroy` — every one with `trigger: 'destroy'`. A `beforeDestroy` failure removes
   * nothing and fails every target. An `afterDestroy` failure leaves the removal done: its
   * service (every target, for the provider's) ends `destroyed`, its result failed with
   * `hookFailed` and the hook's error. With no services named it removes the whole project —
   * disabled services' leftovers included — and the targets, for the callbacks, are the enabled
   * ones. One that couldn't remove something is refused before any of it runs. With no target,
   * a failure rejects, there being no service to fail.
   */
  async destroy(req: Omit<InfraRunRequest, 'trigger'> = {}): Promise<InfraRunSummary> {
    const emit = req.onEvent ?? (() => {});
    const { targets, everything } = await this.resolveTargets(req.services, 'destroy');
    await this.refuseWhatCantBeRemoved(targets, everything, 'destroy');
    const run = new Run(targets, emit, this.runtime.connectControl);
    emit({ type: 'targets', provider: this.key, action: 'destroy', services: targets });
    run.setAll('destroying');
    let removed: Removed | undefined;
    try {
      removed = await this.destroyTargets(run, 'destroy', everything);
    } catch (err) {
      // With no targets — every service disabled — there is nothing to report the failure on,
      // so it propagates instead of vanishing.
      if (targets.length === 0) {
        throw err;
      }
      run.failAll(errorMessage(err));
      return run.summary();
    }
    if (!removed) {
      return run.summary();
    }
    for (const service of targets) {
      const errors = [removed.failures.get(service), removed.project].filter(isDefined);
      if (errors.length === 0) {
        run.succeed(service, 'destroyed');
      } else {
        run.hookFailed(service, 'destroyed', errors.join('\n'));
      }
    }
    return run.summary();
  }

  /**
   * The destroy sequence, for a destroy and a reset's first half: the provider's own
   * `beforeDestroy`, each service's, the removal, each service's `afterDestroy`, the provider's.
   * A `beforeDestroy` that fails fails every target and returns `undefined`, nothing removed. A
   * removal that fails rejects. Otherwise it returns what failed after the removal, for the
   * caller to report the services destroyed with: each service's own `afterDestroy`, and the
   * provider's. With no target, a reset removes nothing (a destroy still removes the project),
   * and the provider's failure rejects, there being no service to fail.
   */
  private async destroyTargets(
    run: Run,
    trigger: InfraDestroyTrigger,
    everything: boolean,
  ): Promise<Removed | undefined> {
    const noTarget = run.targets.length === 0;
    const before = await this.runProjectHook('beforeDestroy', run, trigger);
    if (before !== undefined) {
      failEvery(run, before);
      return undefined;
    }
    if (!(await this.runPhase('beforeDestroy', run, trigger))) {
      return undefined;
    }
    if (!noTarget || trigger === 'destroy') {
      await (everything ? this.destroyAll(run.emit) : this.destroyServices(run.targets, run.emit));
    }
    const failures = await this.runCallbacks('afterDestroy', run, trigger);
    const project = await this.runProjectHook('afterDestroy', run, trigger);
    if (project !== undefined && noTarget) {
      throw new InfraError(project);
    }
    return project === undefined ? { failures } : { failures, project };
  }

  /**
   * The services a request acts on, validated: a name the provider doesn't have is an error
   * listing the real ones — for a service named on the command line and for a key under the
   * config's `services` alike, before anything is touched.
   *
   * With none named, it is every **enabled** service. A disabled one can't be brought up by
   * name either — but it can be destroyed by name, to clean up after a profile where it ran.
   */
  private async resolveTargets(
    named: string[] | undefined,
    action: InfraRunAction,
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
    if (!named || named.length === 0) {
      return { targets: all.filter((name) => this.enabled(name)), everything: true };
    }
    const unknown = named.filter((name) => !all.includes(name));
    if (unknown.length > 0) {
      throw unknownServicesError(unknown, all);
    }
    const disabled = named.filter((name) => !this.enabled(name));
    if (action !== 'destroy' && disabled.length > 0) {
      throw new InfraError(
        `infra service${disabled.length > 1 ? 's' : ''} ${disabled.map((s) => `"${s}"`).join(', ')} ` +
          `${disabled.length > 1 ? 'are' : 'is'} disabled for profile "${this.runtime.profile}" ` +
          `(\`enabled\` in the stackctl config), so there is nothing to ${action === 'up' ? 'bring up' : 'stop'}.`,
      );
    }
    return { targets: [...new Set(named)], everything: false };
  }

  /** Throws an {@link InfraError} listing what `removalRefusals` found, before anything runs. */
  private async refuseWhatCantBeRemoved(
    targets: string[],
    everything: boolean,
    action: 'reset' | 'destroy',
  ): Promise<void> {
    const refusals = await this.removalRefusals(targets, everything, action);
    if (refusals.length > 0) {
      throw new InfraError(refusals.join('\n'));
    }
  }

  /**
   * Runs one callback for every target that has it, and decides the run: `true` to carry on.
   * If any failed, that service fails with its own error and the rest fail as not started (or,
   * for `beforeDestroy`, not destroyed) — these phases come before the single start or destroy,
   * so there is no partial way forward.
   */
  private async runPhase<N extends CallbackName>(
    name: N,
    run: Run,
    trigger: PhaseTriggers[N],
  ): Promise<boolean> {
    const failures = await this.runCallbacks(name, run, trigger);
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

  /**
   * Runs `name` for each target that has it, in parallel. Returns the failures, by service, each
   * also handed to `onFailure` the moment it happens.
   */
  private async runCallbacks<N extends CallbackName>(
    name: N,
    run: Run,
    trigger: PhaseTriggers[N],
    onFailure: (service: string, error: string) => void = () => {},
  ): Promise<Map<string, string>> {
    const failures = new Map<string, string>();
    const failed = (service: string, error: string) => {
      failures.set(service, error);
      onFailure(service, error);
    };
    await Promise.all(
      run.targets.map(async (service) => {
        const callbacks: PhaseCallbacks = this.serviceConfig[service]?.lifecycle ?? {};
        const callback = callbacks[name];
        if (!callback) {
          return;
        }
        const failure = await this.callHook(name, callback, async () =>
          this.context(service, trigger, run, await run.control()),
        );
        if (failure !== undefined) {
          failed(service, failure);
        }
      }),
    );
    return failures;
  }

  /** Runs the provider's own `name`, if it has one. Returns why it failed, if it did. */
  private async runProjectHook<N extends keyof ProjectTriggers>(
    name: N,
    run: Run,
    trigger: ProjectTriggers[N],
  ): Promise<string | undefined> {
    const callback = this.projectLifecycle[name] as
      | ((ctx: InfraRunContext<TokenRecord, ProjectTriggers[N]>) => void | Promise<void>)
      | undefined;
    return this.callHook(`${this.key} ${name}`, callback, () =>
      this.runContext(trigger, run, undefined),
    );
  }

  /**
   * Runs `hook`, if there is one, with the context `context` builds: the one way the provider
   * calls a `lifecycle` hook. Resolves with why it failed, as `<name> failed: <error>` (a failure
   * to build its context included), or `undefined`.
   */
  private async callHook<C>(
    name: string,
    hook: ((ctx: C) => void | Promise<void>) | undefined,
    context: () => C | Promise<C>,
  ): Promise<string | undefined> {
    if (!hook) {
      return undefined;
    }
    let ctx: C;
    try {
      ctx = await context();
    } catch (err) {
      return failedLine(name, errorMessage(err));
    }
    const outcome = await runHook(hook, ctx);
    return typeof outcome === 'object' ? failedLine(name, outcome.error) : undefined;
  }

  /**
   * Polls until each of `targets` is ready or failed, or the timeout elapses. Each service's
   * `afterReady` starts as soon as that service is ready, so a slow one doesn't hold up
   * another's migrations. With `hold` (the provider has an `afterReady`, and it can still run),
   * a service that got ready waits for the others without a final status; the first failure
   * releases them. Returns whether every target got ready while held: then the caller runs the
   * provider's `afterReady` and gives each its final status.
   */
  private async awaitReady(
    run: Run,
    targets: string[],
    trigger: InfraStartTrigger,
    fresh: Set<string>,
    timeoutMs: number,
    hold: boolean,
  ): Promise<boolean> {
    const held = new ReadyHold(run, targets.length, hold);
    const pending = new Set(targets);
    const settling: Promise<void>[] = [];
    const lastDetail = new Map<string, string>();
    const deadline = Date.now() + timeoutMs;
    const interval = this.runtime.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    while (pending.size > 0) {
      let readings: Map<string, Readiness>;
      try {
        readings = await this.readStatuses([...pending]);
      } catch (err) {
        for (const service of pending) {
          run.fail(service, errorMessage(err));
        }
        held.lost();
        break;
      }
      for (const service of pending) {
        const reading = readings.get(service) ?? { state: 'pending', detail: 'creating' };
        if (reading.state === 'ready') {
          pending.delete(service);
          settling.push(this.settleReady(service, run, trigger, fresh.has(service), held));
        } else if (reading.state === 'failed') {
          pending.delete(service);
          held.lost();
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
          run.fail(service, `not ready after ${formatTimeout(timeoutMs)}${saw ? ` (${saw})` : ''}`);
        }
        held.lost();
        break;
      }
      await sleep(interval);
    }
    await Promise.all(settling);
    return held.allReady;
  }

  /** Runs `service`'s `afterReady`, then reports it ready to `held`, or fails it. */
  private async settleReady(
    service: string,
    run: Run,
    trigger: InfraStartTrigger,
    fresh: boolean,
    held: ReadyHold,
  ): Promise<void> {
    const callback = this.serviceConfig[service]?.lifecycle?.afterReady;
    if (callback) {
      run.set(service, 'starting', 'afterReady');
      const failure = await this.callHook('afterReady', callback, async () => ({
        ...this.context(service, trigger, run, await run.control()),
        fresh,
      }));
      if (failure !== undefined) {
        run.fail(service, failure);
        held.lost();
        return;
      }
    }
    held.ready(service);
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

  /** What a callback for `service` receives, on a run `trigger` started. */
  private context<G extends InfraTrigger>(
    service: string,
    trigger: G,
    run: Run,
    control: ControlClient | undefined,
  ): InfraCallbackContext<TokenRecord, G> {
    return {
      ...this.runContext(trigger, run, service),
      service: infraServiceDetails(service, this.serviceConfig[service]),
      buildAddress: infraBuildAddress(service, this.serviceConfig[service], this.runtime.config),
      control,
    };
  }

  /**
   * What every callback of a run receives, with the provider's tool helper: its output tagged
   * with `service`, or untagged (the run's own lines) for the provider's own callbacks.
   */
  private runContext<G extends InfraTrigger>(
    trigger: G,
    run: Run,
    service: string | undefined,
  ): InfraRunContext<TokenRecord, G> {
    const { workspaceDir, profile, config, tokens } = this.runtime;
    const { emit } = run;
    const output = (line: string, isError: boolean) =>
      emit(
        service === undefined
          ? { type: 'output', line, isError }
          : { type: 'output', service, line, isError },
      );
    const scope: HookScope = {
      config,
      profile,
      workspaceDir,
      tokens,
      envs: { ...this.runtime.envs, ...this.extraEnv() },
      dir: workspaceDir,
      write: output,
      data: run.data,
      run: this.runtime.exec,
      signal: this.runtime.signal,
      abandon: this.runtime.abandon,
    };
    const exec = scopeExec(scope);
    return {
      ...lifecycleContext(scope),
      trigger,
      ...this.toolContext((args, opts) =>
        exec(
          ...this.toolCommand(args),
          // The provider's variables last: whatever `env` a callback passes, the tool stays on
          // this project.
          { ...opts, env: { ...opts?.env, ...this.extraEnv() } },
          [this.toolLabel(), ...args].join(' '),
        ),
      ),
    };
  }
}

/**
 * The services of an `up` that got ready, held for the provider's `afterReady` while it can still
 * run: it runs only once every target is ready, so the first failure releases them.
 */
class ReadyHold {
  /** Whether services are still being held: the provider's `afterReady` can still run. */
  holding: boolean;
  private readonly held: string[] = [];
  /** The targets not yet ready. */
  private left: number;

  constructor(
    private readonly run: Run,
    targets: number,
    hold: boolean,
  ) {
    this.holding = hold;
    this.left = targets;
  }

  /** Whether every target got ready while held: the provider's `afterReady` can run. */
  get allReady(): boolean {
    return this.holding && this.left === 0;
  }

  /** `service` is ready, its own `afterReady` done: `ready` now, or held for the provider's. */
  ready(service: string): void {
    this.left -= 1;
    if (!this.holding) {
      this.run.succeed(service, 'ready');
      return;
    }
    this.held.push(service);
    if (this.left > 0) {
      this.run.set(service, 'starting', HELD_DETAIL);
    }
  }

  /** A target failed: the provider's `afterReady` can't run, so whoever is held is ready. */
  lost(): void {
    if (!this.holding) {
      return;
    }
    this.holding = false;
    for (const service of this.held.splice(0)) {
      this.run.succeed(service, 'ready');
    }
  }
}

/** The bookkeeping of one `up`, `down` or `destroy`: each target's result, reported as it changes. */
class Run {
  private readonly results = new Map<string, InfraServiceResult>();
  private session: Promise<ControlClient | undefined> | null = null;

  constructor(
    readonly targets: string[],
    readonly emit: Emit,
    private readonly connectControl?: () => Promise<ControlClient | undefined>,
    /** The callbacks' `data`: one object for the whole run, shared by every callback in it. */
    readonly data: Record<string, unknown> = {},
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

  succeed(service: string, status: 'ready' | 'stopped' | 'destroyed'): void {
    this.results.set(service, { service, ok: true });
    this.set(service, status);
  }

  /**
   * `service` reached `status` all the same, but a hook around the step failed: its result is
   * failed with `hookFailed`, and its final status is `status`, with the `error` as its detail.
   * `reached` says so when that isn't the state the run names (a reset that stopped there).
   */
  hookFailed(
    service: string,
    status: 'stopped' | 'destroyed',
    error: string,
    reached?: 'destroyed',
  ): void {
    this.results.set(service, {
      service,
      ok: false,
      error,
      hookFailed: true,
      ...(reached === undefined ? {} : { reached }),
    });
    this.set(service, status, error);
  }

  /**
   * `service` reached `status`, and the run stopped there, short of the state it names, for
   * `why` (another service's hook failed): its result is failed, and records where it was left.
   */
  leftAt(service: string, status: 'destroyed', why: string): void {
    this.results.set(service, { service, ok: false, error: why, reached: status });
    this.set(service, status, why);
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
