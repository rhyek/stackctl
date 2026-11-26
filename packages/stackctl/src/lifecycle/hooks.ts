import type { Config, TokenRecord } from '../config';
import type { Envs, Profile } from '../env';
import { hookExec, type HookExecOptions, type HookExecResult } from '../hook-exec';
import { STOP_HOOK_BUDGET_MS } from '../shutdown-timing';
import { type Exec, execLines } from '../spawn';

/**
 * What every `lifecycle` hook in `stackctl.config.ts` receives, whatever it belongs to: the
 * session, an application service, the infra provider or an infra service. Each adds its own
 * fields on top.
 */
export interface LifecycleContext<T = TokenRecord> {
  /**
   * The profile stackctl runs in: `--profile`'s, else `STACKCTL_PROFILE`, else `test` in CI and
   * `development` elsewhere.
   */
  profile: Profile;
  /**
   * The resolved config, as `stackctl show-config` prints it for this profile: every service, its
   * port and public origin, the reverse proxy, the infra. Read it, don't change it: it is
   * stackctl's own object, not a copy.
   */
  readonly config: Config<string>;
  /** The workspace root, absolute. */
  workspaceDir: string;
  /** The environment the hook's commands get from {@link exec}. */
  envs: Envs;
  /** The config's top-level `tokens`, typed from what the config declares. */
  tokens: T;
  /**
   * Runs a command in the hook's own directory, or `opts.cwd` resolved against it, its output
   * going to stackctl's log as it comes. A non-zero exit rejects unless `reject: false`. Its input
   * is closed, so a command that prompts gets no answer.
   */
  exec: (command: string, args?: string[], opts?: HookExecOptions) => Promise<HookExecResult>;
  /** Prints a message in stackctl's logs, one line per line of the message. */
  log: (message: string) => void;
  /**
   * One object shared by every hook of one operation (a start, a stop, a shutdown, an `infra`
   * command), for passing values from one hook to another. Empty when the operation begins.
   */
  data: Record<string, unknown>;
}

/** What {@link lifecycleContext} is built from. */
export interface HookScope {
  config: Config<string>;
  profile: Profile;
  workspaceDir: string;
  tokens: TokenRecord;
  /** The environment `exec` runs commands with. */
  envs: Record<string, string>;
  /** `exec`'s default `cwd`. */
  dir: string;
  /** Receives each line the hook logs or its commands print. */
  write: (line: string, isError: boolean) => void;
  data: Record<string, unknown>;
  /** Runs commands: {@link execLines} unless a spec stands in. */
  run?: Exec;
  /** Aborting it kills the command a hook is running, at once: the session's hard kill. */
  signal?: AbortSignal;
  /**
   * Aborting it ends the command a hook is running, as an abandoned hook's is: SIGTERM, then a
   * kill if it still runs a moment later.
   */
  abandon?: AbortSignal;
  /** Called with each command `exec` starts: a promise that settles, never rejecting, at its end. */
  onCommand?: (ended: Promise<void>) => void;
}

/** The `exec` a hook gets, for `scope`. */
export function scopeExec(scope: HookScope): ReturnType<typeof hookExec> {
  const exec = hookExec({
    dir: scope.dir,
    env: scope.envs,
    onLine: scope.write,
    run: scope.run ?? execLines,
    signal: scope.signal,
    abandon: scope.abandon,
  });
  if (!scope.onCommand) {
    return exec;
  }
  return (...args) => {
    const running = exec(...args);
    scope.onCommand!(
      running.then(
        () => {},
        () => {},
      ),
    );
    return running;
  };
}

/** The context a lifecycle hook receives, for `scope`. */
export function lifecycleContext(scope: HookScope): LifecycleContext {
  const exec = scopeExec(scope);
  return {
    profile: scope.profile,
    config: scope.config,
    workspaceDir: scope.workspaceDir,
    envs: scope.envs as Envs,
    tokens: scope.tokens,
    exec: (command, args, opts) => exec(command, args, opts),
    log: (message) => {
      for (const line of message.split('\n')) {
        scope.write(line, false);
      }
    },
    data: scope.data,
  };
}

/**
 * How a hook ended: `'none'` when there was none, `'done'`, `'abandoned'` when its `budget` ran
 * out first (the hook is left running, and a later failure of it is ignored; one whose budget was
 * spent before it began is never called), or the `error` message it threw.
 */
export type HookOutcome = 'none' | 'done' | 'abandoned' | { error: string };

/**
 * Runs `hook` with `ctx`, never throwing: the result says how it ended. With a `budget`, it is
 * abandoned once that aborts, and not called at all when it has already.
 */
export async function runHook<C>(
  hook: ((ctx: C) => void | Promise<void>) | undefined,
  ctx: C,
  opts: { budget?: AbortSignal } = {},
): Promise<HookOutcome> {
  if (!hook) {
    return 'none';
  }
  const { budget } = opts;
  if (budget?.aborted) {
    return 'abandoned';
  }
  const outcome = settle((async () => hook(ctx))());
  if (!budget) {
    return outcome;
  }
  const first = await raceAbort(outcome, budget);
  return first === ABORTED ? 'abandoned' : first;
}

/**
 * Why a hook still running was abandoned: the shutdown's time for stop hooks ran out (`budget`),
 * a stop was asked for again while its stop hook ran (`again`), or what its service or session
 * did next: it was stopped, restarted or started again, or the session began to quit.
 */
export type AbandonCause = 'budget' | 'again' | 'stopped' | 'restarted' | 'started' | 'quit';

const STOP_HOOK_TIME_UP = `the ${String(STOP_HOOK_BUDGET_MS / 1000)} s for stop hooks ran out`;

const ABANDONED: Record<AbandonCause, string> = {
  budget: STOP_HOOK_TIME_UP,
  again: 'the stop was asked for again',
  stopped: 'the service was stopped',
  restarted: 'the service was restarted',
  started: 'the service was started again',
  quit: 'the session is quitting',
};

/** The log line for a hook that failed: `afterReady failed: <error>`. */
export const failedLine = (hook: string, error: string): string => `${hook} failed: ${error}`;

/**
 * The log line for a hook abandoned while it ran: `afterReady abandoned: the service was
 * stopped`.
 */
export const abandonedLine = (hook: string, cause: AbandonCause): string =>
  `${hook} abandoned: ${ABANDONED[cause]}`;

/** The log line for a stop hook the shutdown had no time left to begin. */
export const skippedLine = (hook: string): string => `${hook} skipped: ${STOP_HOOK_TIME_UP}`;

/** What {@link raceAbort} resolves with when its signal aborts first. */
export const ABORTED = Symbol('aborted');

/**
 * `promise`'s value, or {@link ABORTED} once `signal` aborts first (at once when it has already).
 * `promise` is left to run; a rejection of it once nobody waits is consumed.
 */
export async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    promise.catch(() => {});
    return ABORTED;
  }
  let onAbort = () => {};
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** `promise`'s end as an outcome; its rejection is always consumed, even once nobody waits. */
async function settle(promise: Promise<void>): Promise<HookOutcome> {
  try {
    await promise;
    return 'done';
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
