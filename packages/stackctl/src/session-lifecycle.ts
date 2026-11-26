import { type TokenRecord, getConfigTokens, getLoadedConfig, getWorkspaceDir } from './config';
import type { Envs } from './env';
import { errorMessage } from './errors';
import { workspaceCallbackEnvs } from './infra/manager';
import {
  ABORTED,
  type HookOutcome,
  type LifecycleContext,
  lifecycleContext,
  raceAbort,
  runHook,
} from './lifecycle/hooks';
import type { Exec } from './spawn';

/** How a session runs: the terminal UI, `--headless`, or the session `start --detach` starts. */
export type SessionMode = 'ui' | 'headless' | 'detached';

/** What the session's `beforeStart`, `afterStart` and `afterReady` receive. */
export interface SessionStartContext<T = TokenRecord> extends LifecycleContext<T> {
  /**
   * This profile's environment: the workspace-scope `.env` files and the ambient environment, as
   * the infra callbacks get it. It includes `STACKCTL_PROFILE`, and is what {@link exec} gives its
   * commands.
   */
  envs: Envs;
  /** How this session runs: `ui` (the terminal UI), `headless`, or `detached` (`start --detach`). */
  mode: SessionMode;
  /**
   * Runs a command with {@link envs} as its environment (an `env` option is merged on top). Its
   * output goes to the session's log as it comes; a non-zero exit rejects unless `reject: false`.
   */
  exec: LifecycleContext<T>['exec'];
  /** Writes a line to the session's log, under `[session]`. */
  log: (message: string) => void;
  /**
   * An object the whole of the session's start shares: what `beforeStart` writes to it,
   * `afterStart`, `afterReady`, every infra `lifecycle` callback of the start and every service's
   * start hooks read. Empty when the session starts.
   */
  data: Record<string, unknown>;
}

/** What the session's `beforeStop` and `afterStop` receive. */
export interface SessionStopContext<T = TokenRecord> extends LifecycleContext<T> {
  /**
   * This profile's environment: the workspace-scope `.env` files and the ambient environment, as
   * the infra callbacks get it. It includes `STACKCTL_PROFILE`, and is what {@link exec} gives its
   * commands.
   */
  envs: Envs;
  /** How this session runs: `ui` (the terminal UI), `headless`, or `detached` (`start --detach`). */
  mode: SessionMode;
  /**
   * Runs a command with {@link envs} as its environment (an `env` option is merged on top). Its
   * output goes to the session's log as it comes; a non-zero exit rejects unless `reject: false`.
   * A command still running when the hook's time is up is ended: SIGTERM, then a kill if it
   * still runs 2 seconds later, or when the session exits.
   */
  exec: LifecycleContext<T>['exec'];
  /** Writes a line to the session's log, under `[session]`. */
  log: (message: string) => void;
  /**
   * An object the whole shutdown shares: what `beforeStop` writes to it, `afterStop` and every
   * service's stop hooks read. Empty when the shutdown begins.
   */
  data: Record<string, unknown>;
}

/** The dev session's `lifecycle` callbacks. */
export interface SessionCallbacks<T = TokenRecord> {
  /**
   * Once as a session starts: after the picker, and after a session it replaces has quit, before
   * its infra and its services. In every kind of session, and in nothing else (`infra start`,
   * `exec`, `run`). For steps that keep a developer's checkout in shape, so it must be
   * idempotent. A failure fails the session's start before its infra or services start.
   */
  beforeStart?: (ctx: SessionStartContext<T>) => void | Promise<void>;
  /**
   * Once as a session starts, right after its infra is up and its services are told to start:
   * none may have run its own `beforeStart` yet, let alone be ready, so anything that needs a
   * service belongs in `afterReady`. `stackctl wait`, `start --detach`, `startStack()` and
   * `attach()` wait for it to finish. A failure fails the session's start, as a failed infra
   * startup does: a `--headless` session stops everything and exits 1, and the terminal UI shows
   * the error. Its `afterReady` then never runs. A quit while it runs abandons it: the session
   * stops waiting for it and ends the commands it runs.
   */
  afterStart?: (ctx: SessionStartContext<T>) => void | Promise<void>;
  /**
   * Once, the first time the session is ready: its infra up, and every service it runs ready
   * (healthy, and its own `afterReady` finished), after `afterStart`. Not again when a service
   * restarts. The session reports ready only once this has finished, and `stackctl wait`,
   * `start --detach`, `startStack()` and `attach()` wait for it. A failure fails the session's
   * start, as for `afterStart`, and those fail with its error. A quit while it runs abandons it.
   */
  afterReady?: (ctx: SessionStartContext<T>) => void | Promise<void>;
  /**
   * Once as the session quits, before any of its services is stopped, and before their own
   * `beforeStop`. It and theirs share 5 seconds: a hook still running then is abandoned, the
   * commands it started are ended, and the services are stopped. A failure is logged and the
   * shutdown goes on. Runs only when the session's start got past its `beforeStart`.
   */
  beforeStop?: (ctx: SessionStopContext<T>) => void | Promise<void>;
  /**
   * Once as the session quits, after every service has stopped and their own `afterStop` has run,
   * before the session exits. It and theirs share 5 seconds, as for `beforeStop`. A failure is
   * logged. Runs only when the session's start got past its `beforeStart`.
   */
  afterStop?: (ctx: SessionStopContext<T>) => void | Promise<void>;
}

/** A hook of the dev session's `lifecycle`. */
export type SessionHook = keyof SessionCallbacks;

/** Whether the loaded config has `session.lifecycle[hook]`. */
export function hasSessionHook(hook: SessionHook): boolean {
  return typeof getLoadedConfig()?.session?.lifecycle?.[hook] === 'function';
}

/**
 * Runs the loaded config's `session.lifecycle[hook]`, if it has one, with `deps.data` as its
 * `data` (the object the session then hands its infra startup), each line it or its commands
 * print going to `deps.write`. With a `budget`, the hook is abandoned once it aborts, the building
 * of its context included, and its commands are ended (SIGTERM, then a kill if one still runs a
 * moment later); `signal` kills them at once. Never rejects: the outcome says how it ended, a
 * failure to build its context included.
 */
export async function runSessionHook(
  hook: SessionHook,
  mode: SessionMode,
  deps: {
    data: Record<string, unknown>;
    write: (line: string, isError: boolean) => void;
    exec?: Exec;
    budget?: AbortSignal;
    /** Aborting it kills the command the hook is running, at once: the session's hard kill. */
    signal?: AbortSignal;
    /** Called with each command the hook starts: a promise that settles at the command's end. */
    onCommand?: (ended: Promise<void>) => void;
  },
): Promise<HookOutcome> {
  const config = getLoadedConfig();
  const fn = config?.session?.lifecycle?.[hook];
  if (!config || !fn) {
    return 'none';
  }
  const { budget } = deps;
  let ctx: SessionStartContext;
  try {
    const workspaceDir = getWorkspaceDir();
    const read = workspaceCallbackEnvs(config, workspaceDir);
    const envs = budget ? await raceAbort(read, budget) : await read;
    if (envs === ABORTED) {
      return 'abandoned';
    }
    ctx = {
      ...lifecycleContext({
        config,
        profile: config.profile,
        workspaceDir,
        tokens: getConfigTokens(),
        envs,
        dir: workspaceDir,
        write: deps.write,
        data: deps.data,
        run: deps.exec,
        signal: deps.signal,
        abandon: budget,
        onCommand: deps.onCommand,
      }),
      mode,
    };
  } catch (err) {
    return { error: errorMessage(err) };
  }
  return runHook(fn, ctx, { budget });
}
