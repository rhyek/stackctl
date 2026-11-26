import type {
  BuildAddressOptions,
  ConfigContext,
  PublicOriginInput,
  ServiceContext,
  ServiceDetails,
  ServiceIdentity,
  PortResolver,
  TokenRecord,
  UrlEntry,
  UrlsInput,
} from '../config';
import type { ControlClient } from '../control-client';
import type { Envs, Profile } from '../env';
import type { HookExecOptions, HookExecResult } from '../hook-exec';
import type { LifecycleContext } from '../lifecycle/hooks';
import type { InfraAction } from './control';

/** How long `infra start` waits for the services to become ready, when the config doesn't say. */
export const DEFAULT_READY_TIMEOUT_MS = 300_000;

/** Options for the `compose` and `exec` helpers an infra callback receives. */
export type InfraRunOptions = HookExecOptions;

/** How a command an infra callback ran ended, with what it printed. */
export type InfraRunResult = HookExecResult;

/**
 * What started an infra run, as its callbacks get it in `trigger`:
 *
 * - `session`: a dev session bringing its infra up as it starts.
 * - `start`, `stop`, `restart`, `reset`: that `infra` command — run from a terminal, by a
 *   session's keys (`s`, `r`, `R`) or through the control API alike.
 * - `destroy`: `infra destroy`.
 */
export type InfraTrigger = 'session' | InfraAction | 'destroy';

/** The runs that start a service, so the triggers `beforeStart`, `afterStart` and `afterReady` see. */
export type InfraStartTrigger = Exclude<InfraTrigger, 'stop' | 'destroy'>;

/**
 * The runs that stop a service, so the triggers `beforeStop` and `afterStop` see: `infra stop`,
 * and the stop half of `infra restart`. A reset destroys and starts, and stops nothing.
 */
export type InfraStopTrigger = Extract<InfraTrigger, 'stop' | 'restart'>;

/** The runs that destroy a service, so the triggers `beforeDestroy` and `afterDestroy` see. */
export type InfraDestroyTrigger = Extract<InfraTrigger, 'destroy' | 'reset'>;

/**
 * What every infra `lifecycle` callback of a run receives, the provider's own and each service's.
 * Unlike the config's other callbacks — synchronous, and resolved once while the config loads —
 * these are async and run when an `infra` command (or a dev session's infra step) does.
 *
 * `G` is the triggers the callback can see. A service's callbacks get
 * {@link InfraCallbackContext}, which adds the service; a provider adds its own tool: see
 * {@link DockerComposeCallbackContext}, {@link DockerComposeProjectStartContext},
 * {@link DockerComposeProjectStopContext} and {@link DockerComposeProjectDestroyContext}.
 */
export interface InfraRunContext<
  T = TokenRecord,
  G extends InfraTrigger = InfraTrigger,
> extends LifecycleContext<T> {
  /**
   * What started this run: `session`, `start`, `stop`, `restart`, `reset` or `destroy` (see
   * {@link InfraTrigger}), narrowed to the runs this callback is part of. A reset runs both the
   * destroy callbacks and the start ones, each with `reset`; a restart runs the stop callbacks
   * and the start ones, each with `restart`.
   */
  trigger: G;
  /**
   * This profile's environment: the workspace-scope `.env` files and the ambient environment —
   * the ambient environment wins over the files, except for the variables `env.override` names —
   * plus whatever the provider adds (`COMPOSE_PROJECT_NAME`). It includes `STACKCTL_PROFILE`.
   *
   * It is the whole environment {@link exec} and the provider's tool give their commands. Workspace
   * scope only: a service's own `.env` files, and the `PORT`/`PUBLIC_ORIGIN` stackctl injects
   * into a service's process, aren't in it.
   */
  envs: Envs;
  /**
   * Runs any other command with {@link envs} as its environment (an `env` option is merged on
   * top) — so a migration or seed script gets the profile's variables and `STACKCTL_PROFILE` with
   * nothing passed by hand. Output captured; a non-zero exit rejects unless `reject: false`.
   */
  exec: (command: string, args?: string[], opts?: InfraRunOptions) => Promise<InfraRunResult>;
  /** Writes a line to stackctl's infra output. */
  log: (message: string) => void;
  /**
   * One object for the whole run, shared by every callback in it: the provider's own and each
   * service's (and, at a session's start, the session's start hooks and its services' too). An
   * `infra restart` is one run: its stop and its start share it, as a reset's destroy and start
   * do. Empty when the run starts, and nothing is kept between runs. So a `beforeDestroy` or a
   * `beforeStop` can leave a note for its `afterReady`: `data.apiWasRunning = true`. Key what one
   * service keeps by its name when another's must not touch it: `data.db = { … }`.
   */
  data: Record<string, unknown>;
}

/**
 * What a service's infra callbacks receive: the run's context, and the service itself.
 *
 * Each phase has its own context, with its own triggers: {@link InfraDestroyContext},
 * {@link InfraStartContext}, {@link InfraReadyContext} and {@link InfraStopContext}. A provider
 * adds its own tool: see {@link DockerComposeCallbackContext}.
 */
export interface InfraCallbackContext<
  T = TokenRecord,
  G extends InfraTrigger = InfraTrigger,
> extends InfraRunContext<T, G> {
  /**
   * The service this callback belongs to, as its `urls` callbacks saw it: its `name`, its `port`,
   * where the dev reverse proxy serves it (`route`) and its `publicOrigin`.
   */
  service: ServiceDetails;
  /**
   * A URL built from the service's public origin, each option replacing one part of it, as the
   * service's `urls` callbacks got it: `buildAddress()` is the origin itself. A service with no
   * public origin starts from the dev reverse proxy's public address (its route's subdomain, else
   * the bare domain), or `http://localhost:<port>` in a config without `reverseProxy`. See
   * {@link BuildAddressOptions}.
   */
  buildAddress: (opts?: BuildAddressOptions) => string;
  /**
   * A client for the running dev session of this config in this profile, its methods named after
   * the control API's paths: `query.status()`, `command.service.stop(name)` (and `start`,
   * `restart`), `command.infra.reset(service)` (and `start`, `stop`, `restart`),
   * `command.quit()`. `undefined` when no such session is running — `infra start` from a terminal
   * with no session up, say.
   *
   * It is bound when the run's first callback starts. At a session's own start (`trigger` is
   * `session`) its infra comes up before its services, so `services` is still `null` there and
   * the service commands return `false`. Don't `quit()` from a callback: the session ends the run
   * that is calling it.
   */
  control?: ControlClient;
}

export type InfraCallback<T = TokenRecord, C = InfraCallbackContext<T>> = (
  ctx: C,
) => void | Promise<void>;

/** What `beforeDestroy` and `afterDestroy` receive: the common context, on a destroy or a reset. */
export type InfraDestroyContext<T = TokenRecord> = InfraCallbackContext<T, InfraDestroyTrigger>;

/** What `beforeStart` and `afterStart` receive: the common context, on any run that starts the service. */
export type InfraStartContext<T = TokenRecord> = InfraCallbackContext<T, InfraStartTrigger>;

/** What `beforeStop` and `afterStop` receive: the common context, on a stop or a restart. */
export type InfraStopContext<T = TokenRecord> = InfraCallbackContext<T, InfraStopTrigger>;

/** What `afterReady` receives: the start context, plus what is only known once a service is up. */
export interface InfraReadyContext<T = TokenRecord> extends InfraStartContext<T> {
  /**
   * `true` when **this run created the service's data** — the first time it ever ran, and after
   * a destroy or a reset. The moment to seed: `if (fresh) await exec('pnpm', ['seed'])`.
   *
   * It goes by the service's named volumes: fresh means none of them existed before this run
   * started it. So stopping a service and starting it again (`infra stop`, then `start`) is not
   * fresh — the container is new, the data isn't. A service with no named volume keeps its data
   * in the container, and is fresh when it had none.
   *
   * It describes this run only. If `afterReady` fails on the run where it is `true`, it is
   * `false` on the next one; `infra reset -s <service>` gives the service a clean start.
   */
  fresh: boolean;
}

/** What the `docker-compose` provider adds to every callback's context: `compose`. */
export interface DockerComposeTool {
  /**
   * Runs `docker compose <args>` against this project — the compose file and the profile's project
   * name already applied, and the callback's `envs` as its environment (an `env` option is merged
   * on top, but can't change the project). Its output goes to stackctl's infra output, and a
   * non-zero exit rejects unless `reject: false`.
   */
  compose: (args: string[], opts?: InfraRunOptions) => Promise<InfraRunResult>;
}

/**
 * What a Docker Compose service's callbacks receive: the common context, and `compose`. Each phase
 * has its own, with its own triggers: {@link DockerComposeDestroyContext},
 * {@link DockerComposeStartContext}, {@link DockerComposeReadyContext} and
 * {@link DockerComposeStopContext}. This one, with every trigger, types a function shared by
 * several phases.
 */
export interface DockerComposeCallbackContext<
  T = TokenRecord,
  G extends InfraTrigger = InfraTrigger,
>
  extends InfraCallbackContext<T, G>, DockerComposeTool {}

/** What a Docker Compose service's `beforeDestroy` and `afterDestroy` receive. */
export type DockerComposeDestroyContext<T = TokenRecord> = DockerComposeCallbackContext<
  T,
  InfraDestroyTrigger
>;

/** What a Docker Compose service's `beforeStart` and `afterStart` receive. */
export type DockerComposeStartContext<T = TokenRecord> = DockerComposeCallbackContext<
  T,
  InfraStartTrigger
>;

/** What a Docker Compose service's `beforeStop` and `afterStop` receive. */
export type DockerComposeStopContext<T = TokenRecord> = DockerComposeCallbackContext<
  T,
  InfraStopTrigger
>;

/**
 * What the `docker-compose` provider's own `beforeStart`, `afterStart` and `afterReady` receive:
 * the run's context, and `compose`. They run once per run that starts the project's services,
 * around every service's own.
 */
export interface DockerComposeProjectStartContext<T = TokenRecord>
  extends InfraRunContext<T, InfraStartTrigger>, DockerComposeTool {}

/**
 * What the `docker-compose` provider's own `beforeStop` and `afterStop` receive: the run's
 * context, and `compose`. They run once per `infra stop`, and on the stop half of
 * `infra restart`.
 */
export interface DockerComposeProjectStopContext<T = TokenRecord>
  extends InfraRunContext<T, InfraStopTrigger>, DockerComposeTool {}

/**
 * What the `docker-compose` provider's own `beforeDestroy` and `afterDestroy` receive: the run's
 * context, and `compose`. They run once per `infra destroy`, and on the destroy half of
 * `infra reset`.
 */
export interface DockerComposeProjectDestroyContext<T = TokenRecord>
  extends InfraRunContext<T, InfraDestroyTrigger>, DockerComposeTool {}

/** The `lifecycle` callbacks of the `docker-compose` provider itself, for the whole project. */
export interface DockerComposeProjectCallbacks<T = TokenRecord> {
  /**
   * Once per run that starts the project's services — a session's start, `infra start`,
   * `restart` and `reset` — before any service's `beforeStart`, and in a reset after the
   * services are destroyed. A failure starts nothing and fails every service of the run; it
   * runs even when no service is enabled, and a failure then fails the command itself.
   */
  beforeStart?: (ctx: DockerComposeProjectStartContext<T>) => void | Promise<void>;
  /**
   * Once per run that starts the project's services, right after they are started and after
   * every service's `afterStart` — before anything is ready. It runs even when no service is
   * enabled. A failure fails every service of the run with its message, and nothing waits for
   * them to be ready: what was started keeps running.
   */
  afterStart?: (ctx: DockerComposeProjectStartContext<T>) => void | Promise<void>;
  /**
   * Once per run that starts the project's services, when every one of them is ready and its own
   * `afterReady` has finished — not run when any of them failed. It runs even when no service is
   * enabled. Until it has run, no service is reported ready: one whose own part is done shows
   * `ready, waiting for the other services` (and once any of them fails, the rest are ready as
   * soon as they are). A failure fails every service of the run with its message: what was
   * started keeps running.
   */
  afterReady?: (ctx: DockerComposeProjectStartContext<T>) => void | Promise<void>;
  /**
   * On `infra stop` and the stop half of `infra restart` (`trigger` tells them apart), before
   * any service's `beforeStop`; it runs even when no service is enabled. A failure doesn't hold
   * the stop back: the services are stopped all the same (and an `infra restart` starts them
   * again), the message is an error line in the infra output, each service is reported stopped,
   * but with the message, and the command exits 1.
   */
  beforeStop?: (ctx: DockerComposeProjectStopContext<T>) => void | Promise<void>;
  /**
   * On `infra stop` and the stop half of `infra restart`, once the services are stopped and
   * after every service's `afterStop`; it runs even when no service is enabled. A failure leaves
   * the services stopped (and an `infra restart` starts them again); the message is an error line
   * in the infra output, each service is reported stopped, but with the message, and the command
   * exits 1. Not run when the stop itself failed.
   */
  afterStop?: (ctx: DockerComposeProjectStopContext<T>) => void | Promise<void>;
  /**
   * On `infra destroy` and the destroy half of `infra reset` (`trigger` tells them apart), before
   * any service's `beforeDestroy`; it runs even when no service is enabled. A failure removes
   * nothing and runs no service's callback: every service of the run is failed with its message.
   */
  beforeDestroy?: (ctx: DockerComposeProjectDestroyContext<T>) => void | Promise<void>;
  /**
   * On `infra destroy` and the destroy half of `infra reset`, once the services' containers and
   * data are removed and after every service's `afterDestroy`; it runs even when no service is
   * enabled. A failure leaves them removed: every service of the run is reported `destroyed`,
   * but with the message, the command exits 1, and a reset stops there, before the start. Not
   * run when the removal itself failed.
   */
  afterDestroy?: (ctx: DockerComposeProjectDestroyContext<T>) => void | Promise<void>;
}

/** What a Docker Compose service's `afterReady` receives: the ready context, and `compose`. */
export interface DockerComposeReadyContext<T = TokenRecord>
  extends InfraReadyContext<T>, DockerComposeTool {}

/**
 * The callbacks a service can attach, under its `lifecycle`. They run around stackctl's built-in
 * steps, never instead.
 * The contexts its provider hands them: `D` the destroy callbacks', `S` `beforeStart`'s and
 * `afterStart`'s, `R` `afterReady`'s, `P` the stop callbacks'. For Docker Compose:
 * {@link DockerComposeDestroyContext}, {@link DockerComposeStartContext},
 * {@link DockerComposeReadyContext} and {@link DockerComposeStopContext}.
 */
export interface InfraServiceCallbacks<
  T = TokenRecord,
  D = InfraDestroyContext<T>,
  S = InfraStartContext<T>,
  R = InfraReadyContext<T>,
  P = InfraStopContext<T>,
> {
  /**
   * Before the service's container and volumes are removed — on `infra destroy` and on
   * `infra reset` (`trigger` tells them apart). For whatever must let go of the data first,
   * such as a service holding connections to it: `control?.command.service.stop('api')`. A
   * failure stops the run before anything is removed.
   */
  beforeDestroy?: InfraCallback<T, D>;
  /**
   * After the service's container and volumes are removed — on `infra destroy` and on
   * `infra reset`. For state the provider can't see, such as a bind-mounted directory. A failure
   * leaves the removal done: the service is reported `destroyed`, but with the message, the
   * command exits 1, and a reset stops there, before starting anything.
   */
  afterDestroy?: InfraCallback<T, D>;
  /**
   * On every run that starts the service — a session's start, `infra start`, `restart` and
   * `reset` — after any destroy and before the services are started. A failure starts nothing:
   * the service fails with its message, and every other service of the run as not started.
   */
  beforeStart?: InfraCallback<T, S>;
  /**
   * On every run that starts the service, right after the start — **including when it was
   * already running** — and before it is ready: for what only needs the container to exist.
   * A failure fails the service with its message (it keeps running, but nothing waits for it to
   * be ready and its `afterReady` doesn't run); the other services carry on.
   */
  afterStart?: InfraCallback<T, S>;
  /**
   * On every run that starts the service, once it is ready — **including when it was already
   * running**. For migrations, so it must be idempotent; seed behind its `fresh` flag, and read
   * `trigger` to skip work on some runs. A failure fails the service with its message; it keeps
   * running.
   */
  afterReady?: (ctx: R) => void | Promise<void>;
  /**
   * Before the service is stopped — on `infra stop` and the stop half of `infra restart`
   * (`trigger` tells them apart), not on a reset or a destroy. For what must let go of the
   * service first, or a note for the restart's `afterReady` in `data`. A failure doesn't hold
   * the stop back: the service is stopped all the same (and an `infra restart` starts it again),
   * the message is an error line under the service's name, it is reported stopped, but with the
   * message, and the command exits 1.
   */
  beforeStop?: InfraCallback<T, P>;
  /**
   * After the service is stopped — on `infra stop` and the stop half of `infra restart`, its
   * `beforeStop` failing or not. A failure leaves the service stopped (and an `infra restart`
   * starts it again); the message is an error line under the service's name, it is reported
   * stopped, but with the message, and the command exits 1. Not run when the stop itself failed.
   */
  afterStop?: InfraCallback<T, P>;
}

/**
 * What an `enabled` callback receives. Like the config's other load-time callbacks it is
 * synchronous and resolved once, while the config loads — so there is no service to act on yet,
 * only what decides whether there will be one.
 */
export interface InfraEnabledContext<T = TokenRecord> {
  /** The service the callback belongs to. Nothing else about it is resolved yet. */
  service: ServiceIdentity;
  /**
   * The active profile: `development` unless `--profile` says otherwise, or any name you pass it.
   */
  profile: Profile;
  /**
   * The workspace-scope `.env` files for the profile and the ambient environment; the ambient
   * environment wins over the files, except for the variables `env.override` names.
   */
  envs: Envs;
  /** The config's top-level `tokens`. */
  tokens: T;
}

/**
 * What a service can be given under `services`: its callbacks, whether it runs at all, and the
 * port it answers on. Shared by every provider, whose contexts its callbacks get (`D`, `S`, `R`,
 * `P`):
 * {@link DockerComposeServiceInput} for Docker Compose. `reverseProxy.routes` routes to it by its
 * key.
 */
export interface InfraServiceInput<
  T = TokenRecord,
  D = InfraDestroyContext<T>,
  S = InfraStartContext<T>,
  R = InfraReadyContext<T>,
  P = InfraStopContext<T>,
> {
  /**
   * Async callbacks around stackctl's own steps: `beforeDestroy`, `afterDestroy`, `beforeStart`,
   * `afterStart`, `afterReady`, `beforeStop` and `afterStop`. For migrations, seeds and teardown.
   */
  lifecycle?: InfraServiceCallbacks<T, D, S, R, P>;
  /**
   * Whether stackctl runs this service (default `true`). A literal, or a callback over the profile
   * and environment — `({ profile }) => profile !== 'test'`, `({ envs }) => Boolean(envs.API_KEY)`.
   * A disabled service is left out of `infra start` and of a dev session, and its callbacks don't
   * run. (Compose still starts it if an enabled service `depends_on` it.)
   */
  enabled?: boolean | ((ctx: InfraEnabledContext<T>) => boolean);
  /**
   * Labels for picking this service with `-t, --tag`, and for your own code. Only a service named
   * under `services` can carry tags.
   */
  tags?: string[] | undefined;
  /**
   * The port the service answers on at `localhost` — the host side of its port mapping, which
   * stackctl doesn't read from the provider's own file. A literal, or a callback over the
   * workspace context `{ envs, tokens, service }` resolved once at load, like a service's `port`:
   * `port: ({ envs }) => Number(envs.MAIL_UI_PORT)`. Required for a service `reverseProxy.routes`
   * names. Not resolved for a disabled service. It must differ from every service's port and from
   * the dev reverse proxy's.
   */
  port?: number | PortResolver<T>;
  /**
   * Links shown under the service's name in the footer's `infra` group — the same entries a
   * service's `urls` takes. A path (`''`, `'/inbox'`) is based on the service's public origin
   * (where the dev reverse proxy serves it, from a `reverseProxy.routes` `service` entry naming
   * it, or from its own `publicOrigin`), else on `http://localhost:<port>`; a callback gets
   * `{ envs, tokens, port, service, buildAddress }`.
   * One unlabelled link makes the service's name the link. A service with no `urls` shows none.
   * Not resolved for a disabled service. It may be a callback returning the list, as a service's
   * `urls` may.
   */
  urls?: UrlsInput<ServiceContext<T>>;
  /**
   * The service's public origin, set rather than built from its route, as a service's
   * `publicOrigin` is: what a path in its `urls` is based on, and where `buildAddress` starts.
   * **It only shapes those URLs:** it never changes routing, the proxy or TLS. Each part given
   * replaces that part of the proxy's public address (with the subdomain of the service's route,
   * else none), or of `http://localhost:<port>` in a config without `reverseProxy`. A
   * {@link PublicOriginInput}, or a callback over the workspace context `{ envs, tokens }`
   * returning one. Not resolved for a disabled service.
   */
  publicOrigin?: PublicOriginInput | ((ctx: ConfigContext<T>) => PublicOriginInput);
}

/** A provider's `services`, keyed by service name. For Docker Compose's, see {@link DockerComposeServicesInput}. */
export type InfraServicesInput<
  T = TokenRecord,
  D = InfraDestroyContext<T>,
  S = InfraStartContext<T>,
  R = InfraReadyContext<T>,
  P = InfraStopContext<T>,
> = Record<string, InfraServiceInput<T, D, S, R, P>>;

/** One Docker Compose service under `services`: its callbacks get `compose`. */
export type DockerComposeServiceInput<T = TokenRecord> = InfraServiceInput<
  T,
  DockerComposeDestroyContext<T>,
  DockerComposeStartContext<T>,
  DockerComposeReadyContext<T>,
  DockerComposeStopContext<T>
>;

/**
 * Docker Compose's `services`, written apart from `defineConfig` — in a file of its own, say —
 * and checked where it's written: `export const infraServices = { db, cache: {} } satisfies
 * DockerComposeServicesInput`. `T` is the config's `tokens`, for the callbacks' `tokens`: pass
 * `typeof tokens` when the config's are declared as a `const`.
 *
 * Use `satisfies`, not an annotation: an annotation gives the variable this whole type, whose keys
 * are any `string`, so `reverseProxy.routes` could name any infra service, a misspelled one
 * included.
 */
export type DockerComposeServicesInput<T = TokenRecord> = Record<
  string,
  DockerComposeServiceInput<T>
>;

/**
 * A service's config, resolved: `enabled` decided, `port` and `urls` settled, the callbacks as
 * written, taking its provider's contexts (`D`, `S`, `R`, `P`).
 */
export interface ResolvedInfraService<
  D = InfraDestroyContext,
  S = InfraStartContext,
  R = InfraReadyContext,
  P = InfraStopContext,
> {
  /** The service's callbacks, as written. */
  lifecycle?: InfraServiceCallbacks<TokenRecord, D, S, R, P>;
  enabled: boolean;
  /** The service's tags, without duplicates; `[]` when it has none. */
  tags: string[];
  /** The service's port on `localhost`, with any callback resolved; never set for a disabled service. */
  port?: number;
  /**
   * The service's public origin: the one its `publicOrigin` gives, else, on
   * `reverseProxy.publicAddress`, where a browser reaches it through the dev reverse proxy, at the
   * host of the first `reverseProxy.routes` `service` entry that names it (`'*'` aside). `undefined`
   * when it has neither, or it is disabled.
   */
  publicOrigin?: string;
  /** The service's footer links, resolved; never set for a disabled service. */
  urls?: UrlEntry[];
}

/** The `docker-compose` provider's options. `{}` — or `true` in its place — is a complete config. */
export interface DockerComposeInfraInput<T = TokenRecord> {
  /**
   * The compose file, relative to `workspaceDir`. Omit it to let Compose discover the file
   * (`compose.yaml`, `docker-compose.yaml`, and any override file).
   */
  file?: string;
  /** How long `infra start` waits for the services to become ready, in ms. Defaults to 5 minutes. */
  readyTimeout?: number;
  /**
   * Callbacks for the whole Compose project, each once per run, around every service's own:
   * `beforeStart`, `afterStart` and `afterReady` on a run that starts it, `beforeStop` and
   * `afterStop` on one that stops it, `beforeDestroy` and `afterDestroy` on one that destroys it.
   */
  lifecycle?: DockerComposeProjectCallbacks<T>;
  /**
   * Per-service options, keyed by Compose service name. Every service Compose reports for the
   * file runs, listed here or not — unless its `enabled` says otherwise.
   */
  services?: Record<string, DockerComposeServiceInput<T>>;
}

/** The top-level `infra` option: keyed by provider, and it must name at least one. */
export interface InfraInput<T = TokenRecord> {
  /** Docker Compose. `true` for a compose file that needs nothing configured — the same as `{}`. */
  'docker-compose'?: true | DockerComposeInfraInput<T>;
}

export interface ResolvedDockerComposeInfra<I extends string = string> {
  /** Absolute path to the compose file, or `undefined` when Compose discovers it. */
  file?: string;
  /** The Compose project name in force for the active profile. */
  projectName: string;
  readyTimeout: number;
  /** The provider's own callbacks, as written. */
  lifecycle?: DockerComposeProjectCallbacks;
  /**
   * The services the config names, with `enabled`, `port` and `urls` resolved and their
   * `lifecycle` as written. Functions have no JSON form, so serializing one leaves the rest.
   */
  services: Record<
    I,
    ResolvedInfraService<
      DockerComposeDestroyContext,
      DockerComposeStartContext,
      DockerComposeReadyContext,
      DockerComposeStopContext
    >
  >;
}

/**
 * `infra`, resolved, `I` the infra services' names. The service list isn't here: producing it
 * means running the provider.
 */
export interface ResolvedInfra<I extends string = string> {
  'docker-compose'?: ResolvedDockerComposeInfra<I>;
}

// ---------------------------------------------------------------------------
// Runtime: what a run reports while it happens, and what it returns.
// ---------------------------------------------------------------------------

/**
 * Where a service is in an `up`, `down` or `destroy` run. `ready`, `stopped`, `destroyed` and
 * `failed` are final.
 */
export type InfraServiceStatus =
  | 'pending'
  | 'destroying'
  | 'starting'
  | 'stopping'
  | 'ready'
  | 'stopped'
  | 'destroyed'
  | 'failed';

/** What a run does: `up` (a start, a restart's second half, a reset), `down` or `destroy`. */
export type InfraRunAction = 'up' | 'down' | 'destroy';

/** The final status a service that made it through a run ends on, by the run's action. */
export const INFRA_DONE_STATUS = {
  up: 'ready',
  down: 'stopped',
  destroy: 'destroyed',
} as const satisfies Record<InfraRunAction, InfraServiceStatus>;

/** Everything a run reports, through one callback, for whichever surface is showing it. */
export type InfraEvent =
  /** The services this run acts on, once resolved, and the provider that runs them. */
  | { type: 'targets'; provider: string; action: InfraRunAction; services: string[] }
  /**
   * A service changed status, or the step it is on (`detail`) changed. On a final status other
   * than `failed`, `detail` is what failed in a hook around the step that went ahead all the same,
   * or, for a reset that stopped after its destroy, why the service wasn't started.
   */
  | { type: 'status'; service: string; status: InfraServiceStatus; detail?: string }
  /** A line of output: from a callback (tagged with its service) or from the provider's tool. */
  | { type: 'output'; service?: string; line: string; isError: boolean };

export interface InfraServiceResult {
  service: string;
  ok: boolean;
  /** Why it failed; may span several lines (a failed container's log tail, say). */
  error?: string;
  /**
   * `true` when the service did reach the state the run names (`stopped` for a stop, `destroyed`
   * for a destroy, or what {@link reached} says) and only a lifecycle hook around that step
   * failed: `error` holds the hook's message. `ok` is `false` all the same, so the command exits
   * 1; but a restart whose stop ended this way still starts the service, as a stop that failed
   * would not.
   */
  hookFailed?: true;
  /**
   * Where the service was left when that isn't the state the run names: `destroyed`, for a reset
   * that removed it and stopped there, before the start, because an `afterDestroy` failed (its
   * own, with `hookFailed`, or another's). Absent when the service reached the run's state, or
   * failed.
   */
  reached?: 'destroyed';
}

export interface InfraRunSummary {
  /** True only when every target succeeded. */
  ok: boolean;
  services: InfraServiceResult[];
}

/** One reading of whether a service is ready. */
/**
 * How a service stands right now, for a live display: `running` (ready, by its healthcheck when
 * it has one), `starting` (up but not ready yet), or `stopped` (no container, or one that exited
 * with an error or is unhealthy).
 */
export type InfraServiceState = 'running' | 'starting' | 'stopped';

export interface Readiness {
  state: 'pending' | 'ready' | 'failed';
  /** What the provider saw, in a few words (`waiting for healthy`, `exited (1)`). */
  detail: string;
}

/** A failure with a message meant for the user as-is — printed without a stack trace. */
export class InfraError extends Error {
  override name = 'InfraError';
}

/** The error for service names that don't exist, listing the ones that do. */
export function unknownServicesError(unknown: string[], known: string[]): InfraError {
  return new InfraError(
    `unknown infra service${unknown.length > 1 ? 's' : ''} ${unknown.map((s) => `"${s}"`).join(', ')}. ` +
      `Services: ${known.join(', ') || '(none)'}`,
  );
}
