import type { BuildAddressOptions, ServiceDetails, TokenRecord } from '../config';
import type { Envs } from '../env';
import type { LifecycleContext } from './hooks';

/**
 * Why a service's process is about to start (or has): `session` (the dev session is starting),
 * `start` (a start from the terminal UI, the control API or the SDK), `restart`, or `env` (a
 * `.env` file changed and the service restarts for it).
 */
export type ServiceStartTrigger = 'session' | 'start' | 'restart' | 'env';

/**
 * Why a service's process is being stopped: `stop`, `restart`, `env` (the stop half of a restart
 * a `.env` change causes) or `quit` (the session is shutting down).
 */
export type ServiceStopTrigger = 'stop' | 'restart' | 'env' | 'quit';

/** What a service's `lifecycle` hook receives. */
export interface ServiceHookContext<
  T = TokenRecord,
  G extends string = string,
> extends LifecycleContext<T> {
  /** What caused this start or stop. */
  trigger: G;
  /**
   * The service this hook belongs to: its `name`, its `port`, where the dev reverse proxy serves
   * it (`route`) and its `publicOrigin`.
   */
  service: ServiceDetails;
  /**
   * A URL built from the service's public origin, each option replacing one part of it, as the
   * service's `urls` callbacks get it: `buildAddress()` is the origin itself. See
   * {@link BuildAddressOptions}.
   */
  buildAddress: (opts?: BuildAddressOptions) => string;
  /** The config's top-level `tokens`, with the service's own merged over them. */
  tokens: T;
  /**
   * The environment the service's dev process gets: its `.env` files, `PORT`, `PUBLIC_ORIGIN`
   * and the rest. It is what {@link exec} gives its commands.
   */
  envs: Envs;
  /**
   * Runs a command with {@link envs} as its environment (an `env` option is merged on top), in
   * the service's directory, or `opts.cwd` resolved against it. Its output goes under the
   * service's label as it comes; a non-zero exit rejects unless `reject: false`. Its input is
   * closed, so a command that prompts gets no answer.
   */
  exec: LifecycleContext<T>['exec'];
  /** Writes a line to the log, under the service's label. */
  log: (message: string) => void;
  /**
   * One object shared by every hook of the operation that runs this one: a session's start (the
   * session's hooks, its infra's and every service's start hooks), one service's start, stop or
   * restart, the adding of a service to a running session (its start hooks and those of the
   * deps that come with it), or a shutdown. Empty when the operation begins.
   */
  data: Record<string, unknown>;
}

/** What a service's `beforeStart`, `afterStart` and `afterReady` receive. */
export type ServiceStartContext<T = TokenRecord> = ServiceHookContext<T, ServiceStartTrigger>;

/** What a service's `beforeStop` and `afterStop` receive. */
export type ServiceStopContext<T = TokenRecord> = ServiceHookContext<T, ServiceStopTrigger>;

/**
 * An application service's `lifecycle` hooks, run around its dev process by the dev session. Each
 * may be async. None has a time limit, except at a shutdown, where the stop hooks get 5 seconds.
 */
export interface ServiceCallbacks<T = TokenRecord> {
  /**
   * Before every spawn of the service's dev process: when the session starts (once its
   * dependencies are ready), on a start, on a restart, and on a restart caused by a `.env` change.
   * The process gets what it writes to the service's `.env` files. A failure starts nothing: the
   * service is stopped, with the error in its log and its status, and what waits for it keeps
   * waiting, until it is started again.
   */
  beforeStart?: (ctx: ServiceStartContext<T>) => void | Promise<void>;
  /**
   * Right after the service's dev process is spawned, before it is ready. A failure makes the
   * service `failed`: its process keeps running, but it is never ready, so what waits for it
   * doesn't start, until it is restarted. A stop or restart of the service while it runs
   * abandons it: stackctl stops waiting for it and ends the commands it runs.
   */
  afterStart?: (ctx: ServiceStartContext<T>) => void | Promise<void>;
  /**
   * Once per start, when the service's `healthcheck` first passes; a service with no
   * `healthcheck` runs it right after `afterStart`. The service is ready only once it has
   * finished, but it can already be reached, through `buildAddress()` too. A failure makes the
   * service `failed`, as for `afterStart`, and a stop or restart of the service abandons it the
   * same way.
   */
  afterReady?: (ctx: ServiceStartContext<T>) => void | Promise<void>;
  /**
   * Before the service's process is signalled, when a stop is requested: a stop, the stop half of
   * a restart, or the session shutting down. It doesn't run for a service that isn't running, or
   * one that exits by itself. The process still answers while it runs. A failure is logged and
   * the stop goes ahead. A second stop of the service abandons it (the commands it runs are
   * ended) and stops the process at once.
   */
  beforeStop?: (ctx: ServiceStopContext<T>) => void | Promise<void>;
  /**
   * After the service's process has exited, following a requested stop. A failure is logged. A
   * second stop of the service abandons it.
   */
  afterStop?: (ctx: ServiceStopContext<T>) => void | Promise<void>;
}
