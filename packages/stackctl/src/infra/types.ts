import type {
  BuildAddressOptions,
  Config,
  ConfigContext,
  PublicOriginInput,
  ServiceContext,
  ServiceDetails,
  ServiceIdentity,
  PortResolver,
  TokenRecord,
  UrlEntry,
  UrlsInput,
} from '../config.js';
import type { ControlClient } from '../control-client.js';
import type { Envs, Mode } from '../env.js';

/** How long `infra up` waits for the services to become ready, when the config doesn't say. */
export const DEFAULT_READY_TIMEOUT_MS = 300_000;

/** Options for the `compose` and `exec` helpers an infra callback receives. */
export interface InfraRunOptions {
  /** Working directory; a relative path resolves against `workspaceDir`, which is the default. */
  cwd?: string;
  /** Extra variables for this one command, merged over the callback's `envs`. */
  env?: Record<string, string>;
  /** Set `false` to get the result of a failing command instead of a rejection. */
  reject?: boolean;
}

export interface InfraRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * What every infra callback receives. Unlike the config's other callbacks — synchronous, and
 * resolved once while the config loads — these are async and run when an `infra` command (or a
 * dev session's infra step) does.
 */
export interface InfraCallbackContext<T = TokenRecord> {
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
  /** The active mode: `development` unless `--mode` says otherwise, or any name you pass it. */
  mode: Mode;
  /**
   * The resolved config — what `stackctl show-config` prints, in this mode: every service, its
   * port and public origin, the reverse proxy, the infra. Read it, don't change it: it is
   * stackctl's own object, not a copy.
   */
  readonly config: Config<string>;
  /** `true` when this run is `infra up --reset`. Always `false` under `infra destroy`. */
  reset: boolean;
  /** The workspace root, absolute. */
  workspaceDir: string;
  /**
   * This mode's environment: the workspace-scope `.env` files and the ambient environment —
   * the ambient environment wins over the files, except for the variables `env.override` names —
   * plus whatever the provider adds (`COMPOSE_PROJECT_NAME`). It includes `STACKCTL_MODE`.
   *
   * It is the whole environment {@link exec} and {@link compose} give their commands. Workspace
   * scope only: a service's own `.env` files, and the `PORT`/`PUBLIC_ORIGIN` stackctl injects
   * into a service's process, aren't in it.
   */
  envs: Envs;
  /** The config's top-level `tokens`, typed from what the config declares. */
  tokens: T;
  /**
   * Runs `docker compose <args>` against this project — the compose file and the mode's project
   * name already applied, and {@link envs} as its environment (an `env` option is merged on top,
   * but can't change the project). Its output goes to stackctl's infra output, and a non-zero
   * exit rejects unless `reject: false`.
   */
  compose: (args: string[], opts?: InfraRunOptions) => Promise<InfraRunResult>;
  /**
   * Runs any other command with {@link envs} as its environment (an `env` option is merged on
   * top) — so a migration or seed script gets the mode's variables and `STACKCTL_MODE` with
   * nothing passed by hand. Output captured; a non-zero exit rejects unless `reject: false`.
   */
  exec: (command: string, args?: string[], opts?: InfraRunOptions) => Promise<InfraRunResult>;
  /** Writes a line to stackctl's infra output. */
  log: (message: string) => void;
  /**
   * A client for the running dev session of this config in this mode, its methods named after
   * the control API's paths: `query.status()`, `command.service.stop(name)` (and `start`,
   * `restart`), `command.infra.reset(service)` (and `start`, `stop`, `restart`),
   * `command.quit()`. `undefined` when no such session is running — `infra up` from a terminal
   * with no session up, say.
   *
   * It is bound when the run's first callback starts. At a session's own start its infra comes
   * up before its services, so `services` is still `null` there and the service commands return
   * `false`. Don't `quit()` from a callback: the session ends the run that is calling it.
   */
  control?: ControlClient;
  /**
   * One object per service for the whole run, empty when the run starts: what a callback
   * writes to it, the service's later callbacks in the same run read. So a `beforeDestroy` can
   * leave a note for its `afterReady` — `data.apiWasRunning = true`. Nothing is kept between
   * runs, and another service's callbacks get their own.
   */
  data: Record<string, unknown>;
}

export type InfraCallback<T = TokenRecord> = (ctx: InfraCallbackContext<T>) => void | Promise<void>;

/** What `afterReady` receives: the common context, plus what is only known once a service is up. */
export interface InfraReadyContext<T = TokenRecord> extends InfraCallbackContext<T> {
  /**
   * `true` when **this run created the service's data** — the first time it ever ran, and after
   * a destroy or a reset. The moment to seed: `if (fresh) await exec('pnpm', ['seed'])`.
   *
   * It goes by the service's named volumes: fresh means none of them existed before this run
   * started it. So stopping a service and starting it again (`infra down`, then `up`) is not
   * fresh — the container is new, the data isn't. A service with no named volume keeps its data
   * in the container, and is fresh when it had none.
   *
   * It describes this run only. If `afterReady` fails on the run where it is `true`, it is
   * `false` on the next one; `infra up --reset <service>` gives the service a clean start.
   */
  fresh: boolean;
}

/** The callbacks a service can attach. They run around stackctl's built-in steps, never instead. */
export interface InfraServiceCallbacks<T = TokenRecord> {
  /**
   * Before the service's container and volumes are removed — on `infra destroy` and on
   * `infra up --reset` (`reset` tells them apart). For whatever must let go of the data first,
   * such as a service holding connections to it: `control?.command.service.stop('api')`. A
   * failure stops the run before anything is removed.
   */
  beforeDestroy?: InfraCallback<T>;
  /**
   * After the service's container and volumes are removed — on `infra destroy` and on
   * `infra up --reset`. For state the provider can't see, such as a bind-mounted directory.
   */
  afterDestroy?: InfraCallback<T>;
  /** On every `infra up`, after any destroy and before the services are started. */
  beforeUp?: InfraCallback<T>;
  /**
   * On every `infra up`, once the service is ready — **including when it was already running**.
   * For migrations, so it must be idempotent; seed behind its `fresh` flag.
   */
  afterReady?: (ctx: InfraReadyContext<T>) => void | Promise<void>;
}

/**
 * What an `enabled` callback receives. Like the config's other load-time callbacks it is
 * synchronous and resolved once, while the config loads — so there is no service to act on yet,
 * only what decides whether there will be one.
 */
export interface InfraEnabledContext<T = TokenRecord> {
  /** The service the callback belongs to. Nothing else about it is resolved yet. */
  service: ServiceIdentity;
  /** The active mode: `development` unless `--mode` says otherwise, or any name you pass it. */
  mode: Mode;
  /**
   * The workspace-scope `.env` files for the mode and the ambient environment; the ambient
   * environment wins over the files, except for the variables `env.override` names.
   */
  envs: Envs;
  /** The config's top-level `tokens`. */
  tokens: T;
}

/**
 * What a service can be given under `services`: its callbacks, whether it runs at all, and the
 * port it answers on. Shared by every provider. `reverseProxy.routes` routes to it by its key.
 */
export interface InfraServiceInput<T = TokenRecord> extends InfraServiceCallbacks<T> {
  /**
   * Whether stackctl runs this service (default `true`). A literal, or a callback over the mode
   * and environment — `({ mode }) => mode !== 'test'`, `({ envs }) => Boolean(envs.API_KEY)`.
   * A disabled service is left out of `infra up` and of a dev session, and its callbacks don't
   * run. (Compose still starts it if an enabled service `depends_on` it.)
   */
  enabled?: boolean | ((ctx: InfraEnabledContext<T>) => boolean);
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

/**
 * A provider's `services`, written apart from `defineConfig` — in a file of its own, say — and
 * checked where it's written: `export const infraServices = { db, cache: {} } satisfies
 * InfraServicesInput`. `T` is the config's `tokens`, for the callbacks' `tokens`: pass
 * `typeof tokens` when the config's are declared as a `const`.
 *
 * Use `satisfies`, not an annotation: an annotation gives the variable this whole type, whose keys
 * are any `string`, so `reverseProxy.routes` could name any infra service, a misspelled one
 * included.
 */
export type InfraServicesInput<T = TokenRecord> = Record<string, InfraServiceInput<T>>;

/** A service's config, resolved: `enabled` decided, `port` and `urls` settled, the callbacks as written. */
export interface ResolvedInfraService extends InfraServiceCallbacks {
  enabled: boolean;
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
  /** How long `infra up` waits for the services to become ready, in ms. Defaults to 5 minutes. */
  readyTimeout?: number;
  /**
   * Per-service options, keyed by Compose service name. Every service Compose reports for the
   * file runs, listed here or not — unless its `enabled` says otherwise.
   */
  services?: Record<string, InfraServiceInput<T>>;
}

/** The top-level `infra` option: keyed by provider, and it must name at least one. */
export interface InfraInput<T = TokenRecord> {
  /** Docker Compose. `true` for a compose file that needs nothing configured — the same as `{}`. */
  'docker-compose'?: true | DockerComposeInfraInput<T>;
}

export interface ResolvedDockerComposeInfra<I extends string = string> {
  /** Absolute path to the compose file, or `undefined` when Compose discovers it. */
  file?: string;
  /** The Compose project name in force for the active mode. */
  projectName: string;
  readyTimeout: number;
  /**
   * The services the config names, with `enabled`, `port` and `urls` resolved and the callbacks
   * as written. Functions have no JSON form, so serializing one leaves the rest.
   */
  services: Record<I, ResolvedInfraService>;
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

/** Where a service is in an `up` or `destroy` run. `ready`, `destroyed` and `failed` are final. */
export type InfraServiceStatus =
  | 'pending'
  | 'destroying'
  | 'starting'
  | 'ready'
  | 'destroyed'
  | 'failed';

/** Everything a run reports, through one callback, for whichever surface is showing it. */
export type InfraEvent =
  /** The services this run acts on, once resolved, and the provider that runs them. */
  | { type: 'targets'; provider: string; action: 'up' | 'destroy'; services: string[] }
  /** A service changed status, or the step it is on (`detail`) changed. */
  | { type: 'status'; service: string; status: InfraServiceStatus; detail?: string }
  /** A line of output: from a callback (tagged with its service) or from the provider's tool. */
  | { type: 'output'; service?: string; line: string; isError: boolean };

export interface InfraServiceResult {
  service: string;
  ok: boolean;
  /** Why it failed; may span several lines (a failed container's log tail, say). */
  error?: string;
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
