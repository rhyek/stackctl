import path from 'node:path';
import { inspect } from 'node:util';
import * as v from 'valibot';
import {
  type InfraServiceSchema,
  type ServiceConfigSchema,
  BuildAddressOptionsSchema,
  DefineConfigSchema,
  DepEntrySchema,
  DEFAULT_HEALTHCHECK_TIMEOUT_MS,
  EnvAdditionalFileSchema,
  PublicAddressSchema,
  PublicOriginInputSchema,
  type ReverseProxyRouteSchema,
  ReverseProxyTlsSchema,
} from './config-schema.js';
import {
  ENV_NAME_RE,
  baseEnvs,
  configEnvReader,
  envCandidatePaths,
  envKeysFile,
  resolveEnvFrom,
  envFileNames,
  envFileOrder,
  currentMode,
  type EnvAdditionalFile,
  type EnvFileOrder,
  type Envs,
  type EnvOverride,
  type Mode,
} from './env.js';
import { composeProjectName } from './infra/project-name.js';
import {
  DEFAULT_READY_TIMEOUT_MS,
  type InfraEnabledContext,
  type InfraInput,
  type InfraServiceCallbacks,
  type ResolvedInfra,
  type ResolvedInfraService,
} from './infra/types.js';
import type { InfraServiceName, ServiceName } from './register.js';
import { recordedConfigDir } from './workspace-root.js';

/** A single link: a bare URL, or a labeled URL (the label is shown in place of the URL). */
export type UrlLink = string | { label: string; url: string };
/**
 * One footer line's worth of links: a single link, or an array of links rendered on the
 * same line separated by a space. `urls` is a list of these entries, one line each.
 */
export type UrlEntry = UrlLink | UrlLink[];

/** One footer line after normalization: the links to render on it (label falls back to url). */
export type UrlLine = { label?: string; url: string }[];

/** Flattens a resolved `urls` entry into the links shown on a single footer line. */
export function normalizeUrlEntry(entry: UrlEntry): UrlLine {
  const links = Array.isArray(entry) ? entry : [entry];
  return links.map((link) => (typeof link === 'string' ? { url: link } : link));
}

/**
 * A resolved `command`: which script to run and how it behaves on file changes, or `null` for a
 * service with no dev process (stackctl never starts it).
 */
export type Command = {
  /** The script or target stackctl runs as the service's dev process. */
  name: string;
  /** The script watches files and reloads itself. */
  watches: boolean;
} | null;

/**
 * What every config callback receives. stackctl does no string interpolation — a value that
 * depends on the environment is a function of this context, evaluated once while the config
 * is being defined.
 *
 * An object (rather than positional arguments) so more context can be added later without
 * breaking existing configs.
 */
export interface ConfigContext<T = TokenRecord> {
  /**
   * The service's resolved `.env` files merged **over** `process.env` — the same environment
   * its dev process will be spawned with, minus the `PORT` and `PUBLIC_ORIGIN` stackctl injects.
   * File values win
   * over ambient ones, and service-scope files win over workspace-scope ones. (For the
   * workspace-wide `urls`, which belong to no service, this is the workspace scope alone.)
   * The config's own `env.vars` are in it too, ranked as a file below every real one — except
   * for the `env.vars` callback itself, which is what computes them. The variables stackctl
   * sets (`STACKCTL_MODE`, `STACKCTL_CWD`, `STACKCTL_WORKSPACE_DIR`) are always in it, by name.
   */
  envs: Envs;
  /**
   * The config's top-level `tokens` merged with this service's own `tokens` (the service's
   * win), **typed from what you declared** — so `tokens.domain` is known and a typo is a
   * compile error. The workspace-wide `urls` see only the top-level ones.
   */
  tokens: T;
}

/** Which service a callback belongs to: what is known of it before anything about it resolves. */
export interface ServiceIdentity {
  /** Its key in the config. */
  name: string;
  /** `'service'` for an application service, `'infra'` for an infra service. */
  kind: 'service' | 'infra';
}

/**
 * Where the dev reverse proxy serves a service: the host of the first `reverseProxy.routes` entry
 * that names it as its `service`, `'*'` aside.
 */
export interface ServiceRoute {
  /** The hostname a browser asks for: `<subdomain>.<domain>`, on the canonical domain. */
  host: string;
  /** The subdomain: the first one that entry lists. */
  subdomain: string;
}

/** A service as its `healthcheck`/`urls` callbacks and the infra callbacks see it: everything resolved. */
export interface ServiceDetails extends ServiceIdentity {
  /** Its resolved `port`, on loopback; `undefined` for a service that declares none. */
  port: number | undefined;
  /**
   * Where the dev reverse proxy serves it: the host of the first `reverseProxy.routes` entry that
   * names it as its `service` (`'*'` aside). `null` for a service no such entry names, including
   * one reached only through `'*'` or `paths`. Routing alone decides it: `publicOrigin` never
   * changes it.
   */
  route: ServiceRoute | null;
  /**
   * Its public origin, where a browser reaches it. With the service's own `publicOrigin` set, the
   * one that gives. Otherwise `<scheme>://<route.host>[:port]` for a service with a `route`,
   * `http://localhost:<port>` for an application service no route names, and `undefined` for one
   * reached only through `'*'` or `paths`, for an infra service with no `route`, and for a service
   * with no `port`. What a path in `urls` is based on, and what `buildAddress()` returns.
   */
  publicOrigin: string | undefined;
}

/**
 * What a `port` callback (and an infra service's `enabled` one) receives: {@link ConfigContext}
 * and which service it is for. Nothing else about the service is resolved yet.
 */
export interface PortContext<T = TokenRecord> extends ConfigContext<T> {
  /** The service the callback belongs to. */
  service: ServiceIdentity;
}

/**
 * What a service's `healthcheck`/`urls` callbacks receive: {@link ConfigContext}, the service with
 * everything about it resolved, its `port` again at the top, the field these callbacks read most,
 * and `buildAddress`, for URLs like its public origin.
 */
export interface ServiceContext<T = TokenRecord> extends ConfigContext<T> {
  /**
   * The service's resolved `port` — a literal, or its `port` callback's result (already
   * validated to be a finite number). Typed as `number`, not `number | undefined`, so it drops
   * straight into a URL or arithmetic with no `!` or `??`.
   *
   * That is **enforced at load time rather than by the type system**: whether a service declared
   * a `port` can't be reflected here (a mapped type infers exactly one type parameter, and this
   * config spends it on per-service `tokens`). So for a service with no `port`, reading `port`
   * in a callback throws immediately when the config loads, naming the service — instead of
   * silently interpolating `undefined` into a URL. A portless service whose callbacks never
   * read `port` is unaffected. (`service.port` is the honest `number | undefined`.)
   */
  port: number;
  /** The service the callback belongs to, resolved: its port, its route and its public origin. */
  service: ServiceDetails;
  /**
   * A URL built from this service's public origin (`service.publicOrigin`), each option replacing
   * one part of it: `buildAddress()` is the origin itself, `buildAddress({ subdomain: 'admin',
   * path: '/x' })` the same scheme, domain and port with `admin.` in front and `/x` after. A
   * service with no public origin starts from the dev reverse proxy's public address instead (its
   * route's subdomain, else the bare domain), or `http://localhost` and its `port` in a config
   * without `reverseProxy`. The port is left out when it is the scheme's default (443, 80). See
   * {@link BuildAddressOptions}.
   *
   * A plain function, not a method: destructuring it (`({ buildAddress }) =>`) is how it's meant
   * to be used.
   */
  buildAddress: (opts?: BuildAddressOptions) => string;
}

/**
 * What a workspace-wide `urls` callback receives: {@link ConfigContext} at the workspace scope,
 * and `buildAddress`. Those links belong to no service, so there is no `port` and no `service`.
 */
export interface WorkspaceUrlsContext<T = TokenRecord> extends ConfigContext<T> {
  /**
   * A URL on the dev reverse proxy's public address (`reverseProxy.publicAddress`), each option
   * replacing one part of it: `buildAddress()` is the bare domain, `buildAddress({ subdomain:
   * 'admin', path: '/x' })` is `<scheme>://admin.<domain>[:port]/x`. In a config without
   * `reverseProxy` it starts from `http://localhost`, with no port. The port is left out when it
   * is the scheme's default (443, 80). See {@link BuildAddressOptions}.
   *
   * A plain function, not a method: destructure it.
   */
  buildAddress: (opts?: BuildAddressOptions) => string;
}

/**
 * What `buildAddress` takes: each part to replace in the address it starts from, and a path to
 * append. Every field is optional; `buildAddress()` is that address unchanged.
 */
export interface BuildAddressOptions {
  /** The scheme: `'https'` or `'http'`. */
  scheme?: 'https' | 'http';
  /**
   * The subdomain in front of the domain, lowercase hostname labels (`'admin'`, `'v2.api'`) for
   * `admin.<domain>`, or `null` for the bare domain.
   */
  subdomain?: string | null;
  /** The domain, a lowercase hostname: `'example.test'`. */
  domain?: string;
  /**
   * The port, an integer from 1 to 65535. Left out of the URL when it is the scheme's default
   * (443 for https, 80 for http).
   */
  port?: number;
  /** A path to append: `'/docs'` (a missing leading `/` is added). Omit it for the origin alone. */
  path?: string;
}

/**
 * A service's `publicOrigin`: the parts of its public origin to set. Each part given replaces that
 * part of the origin stackctl would otherwise build for it; see {@link ServiceConfigInput.publicOrigin}.
 */
export interface PublicOriginInput {
  /** The scheme: `'https'` or `'http'`. */
  scheme?: 'https' | 'http';
  /**
   * The subdomain in front of the domain, lowercase hostname labels (`'app'`, `'v2.app'`), or
   * `null` for the bare domain.
   */
  subdomain?: string | null;
  /** The domain, a lowercase hostname: `'example.test'`. */
  domain?: string;
  /**
   * The port, an integer from 1 to 65535. Left out of the origin when it is the scheme's default
   * (443 for https, 80 for http).
   */
  port?: number;
}

/** Any `tokens` record: your own string values, keyed however you like. */
export type TokenRecord = Record<string, string | undefined>;

/**
 * A service's own `tokens` as inferred from the config, normalized. A service that declares
 * none infers `unknown` for its slot, which becomes the empty record here.
 *
 * The type parameter `P` in {@link defineConfig} is constrained to `Record<K, unknown>` rather
 * than `Record<K, TokenRecord>` on purpose: TypeScript validates an inferred type against its
 * constraint and, on failure, **throws the inference away and substitutes the constraint**. A
 * service with no `tokens` doesn't infer a `TokenRecord`, so the tighter constraint discarded
 * the inference for *every* service at once (see microsoft/TypeScript#52262). Keeping the
 * constraint permissive and normalizing here is what lets one service declare `tokens` while
 * its siblings declare nothing.
 */
export type OwnTokens<Own> = unknown extends Own
  ? Record<never, never>
  : Own extends TokenRecord
    ? Own
    : Record<never, never>;

/**
 * The token type a service's callbacks see: the config's top-level `tokens` with this
 * service's own merged **over** them.
 */
export type ServiceTokens<Top, Own> =
  // An override, not a merge: a key the service redeclares replaces the config's, so the
  // config's must be removed rather than intersected (`'https' & 'http'` would be `never`).
  Omit<Top, keyof OwnTokens<Own>> & OwnTokens<Own>;

/** A service `port` computed from the service's environment. */
export type PortResolver<T = TokenRecord> = (ctx: PortContext<T>) => number | undefined;

/** Environment variables a config declares; an `undefined` value leaves the variable out. */
export type EnvVars = Record<string, string | undefined>;

/** `env.vars` computed from the workspace's environment. */
export type EnvVarsResolver<T = TokenRecord> = (ctx: ConfigContext<T>) => EnvVars;

/**
 * The config's `env`: its options, or the `vars` callback on its own —
 * `env: ({ envs }) => ({ … })` is `env: { vars: ({ envs }) => ({ … }) }`.
 */
export type EnvInput<T = TokenRecord> =
  | EnvVarsResolver<T>
  | {
      /**
       * Environment variables of the config's own, for every service stackctl runs, `stackctl
       * exec` / `run`, and infra. A record, or a callback over the workspace context
       * `{ envs, tokens }` invoked once at load, before anything else in the config resolves —
       * so every other callback finds the result in its `envs`. They rank as a `.env` file read
       * before every real one, under the same rules: any file replaces them, the ambient
       * environment wins over them unless `override` names them, and a file's `${VAR}` can
       * reference them. A value is taken literally; one that is `undefined` is left out.
       */
      vars?: EnvVars | EnvVarsResolver<T>;
      /**
       * Variables whose `.env` or `env.vars` value may beat the ambient environment (`true` for all). By
       * default the ambient environment wins, as in Next.js/Vite/`node --env-file`.
       */
      override?: EnvOverride;
      /**
       * Extra `.env` files, each placed just `before` or `after` one of stackctl's own: `'base'`
       * (`.env`), `'local'` (`.env.local`), `'mode'` (`.env.<mode>`) or `'modeLocal'`
       * (`.env.<mode>.local`). Files on the same anchor load in array order. Each is an ordinary
       * `.env` file at its place: a later file wins, and a `${VAR}` expands against what the
       * files before it set. Looked for at both scopes unless `scope` says `'workspace'` or
       * `'service'`, and read wherever stackctl reads its own files. An array, or a callback
       * over `{ mode }`:
       *
       * ```ts
       * additionalFiles: ({ mode }) => [{ file: `.env.${mode}.pre`, before: 'mode' }]
       * ```
       */
      additionalFiles?: EnvAdditionalFile[] | EnvAdditionalFilesResolver;
      /**
       * Decrypt the `.env` values dotenvx encrypted (`encrypted:…`), with the private keys in
       * `.env.keys` at the workspace root and in any `DOTENV_PRIVATE_KEY*` variable of the
       * environment stackctl starts with. Off by default: an encrypted value stays as written.
       * A value with no key to decrypt it stays as written, and stackctl says which one.
       *
       * @see https://github.com/dotenvx/dotenvx#encryption
       */
      decrypt?: boolean;
    };

/** What an `env.additionalFiles` callback is given. */
export interface EnvFilesContext {
  /** The active mode, whose `.env.<mode>` files load. */
  mode: Mode;
}

/** `env.additionalFiles` computed from the mode. */
export type EnvAdditionalFilesResolver = (ctx: EnvFilesContext) => EnvAdditionalFile[];

/** A URL computed from the service's environment. */
export type UrlResolver<T = TokenRecord> = (ctx: ServiceContext<T>) => string;
/** A whole `urls` list computed from the service's environment. */
export type UrlsResolver<T = TokenRecord> = (ctx: ServiceContext<T>) => UrlEntry[];

/**
 * A URL in the config: a literal string, or a callback stackctl invokes once at load time.
 * `C` is the context the callback gets — {@link ServiceContext} for a service's fields,
 * {@link ConfigContext} for the workspace-wide `urls` (which have no port).
 */
export type UrlValue<C = ServiceContext> = string | ((ctx: C) => string);
/**
 * A `healthcheck` as written in the config: the URL on its own (a string or a callback), or an
 * object pairing it with a `timeout`. {@link defineConfig} normalizes both to
 * {@link ResolvedHealthcheck}.
 */
export type HealthcheckInput<C = ServiceContext> =
  | UrlValue<C>
  | {
      /**
       * The URL stackctl polls for readiness — a literal, or a callback over
       * `{ envs, tokens, port, service }` invoked once at load time:
       * `url: ({ port }) => \`http://localhost:${port}/health\``.
       */
      url: UrlValue<C>;
      /**
       * **Milliseconds** a single probe may take before stackctl aborts it. Defaults to
       * `1500`.
       *
       * Raise it for a service slow to answer on a cold start: aborting the request is
       * itself what makes such a server log a dropped connection (`ECONNRESET`), and the
       * abandoned probe leaves the service showing `starting` until a later one lands.
       *
       * Probes for a service never overlap — the next starts 2 s after the previous one
       * *started*, or immediately if that has already passed — so a longer timeout slows
       * this service's polling instead of stacking requests, and affects no other service.
       */
      timeout?: number;
    };
/** A service's `healthcheck` after resolution: the URL to probe, and how long a probe may take. */
export interface ResolvedHealthcheck {
  /** The URL stackctl polls, with any callback already resolved to a string. */
  url: string;
  /** **Milliseconds** a single probe may take before it's aborted (default `1500`). */
  timeout: number;
}
/** One link as written in the config: a URL, or a labeled URL. */
export type UrlLinkInput<C = ServiceContext> = UrlValue<C> | { label: string; url: UrlValue<C> };
/** One `urls` entry as written in the config: a single link, or several rendered on one line. */
export type UrlEntryInput<C = ServiceContext> = UrlLinkInput<C> | UrlLinkInput<C>[];
/**
 * A `urls` field as written in the config: a list of entries, or a callback over the same context
 * returning the list. The list a callback returns holds no callbacks itself: URLs and paths,
 * `{ label, url }`, and arrays of those, one entry per line.
 */
export type UrlsInput<C = ServiceContext> = UrlEntryInput<C>[] | ((ctx: C) => UrlEntry[]);

// ---------------------------------------------------------------------------
// The types a config is written against, and every field's docs. Declared here rather than
// inferred from the schemas in config-schema.ts, because they carry what a schema can't: the
// service names `N` that `deps` may list (`NoInfer`, so a typo is a compile error),
// and each callback's context typed from the config's own `tokens`. config.test-d.ts checks
// that they and the schemas accept the same fields.
//
// Each field is declared on a plain object type, never reached through `Omit`/`Pick` or another
// mapped type: TypeScript 7.0's editor shows no docs on hover for a field reached that way.
// ---------------------------------------------------------------------------

/** `command` options. */
export type CommandOptions = {
  /** The script watches files and reloads itself (default `true`). */
  watches?: boolean;
};

/**
 * The dev process to run and how it behaves: a script/target name, or
 * `[name, { watches }]`.
 */
export type CommandInput = string | [string, CommandOptions];

/**
 * One `deps` entry: a service's name, or `{ service, wait }` to also hold this one until
 * that service's `healthcheck` passes.
 */
export type DepInput<N extends string = string> =
  | N
  | {
      /** The service that runs alongside this one. */
      service: N;
      /**
       * Hold this service until that one's `healthcheck` passes (default `false`). That service
       * must declare a `healthcheck`.
       */
      wait?: boolean;
    };

/** A `deps` entry after resolution: `{ service, wait }`, whichever form the config wrote. */
export interface ResolvedDep<N extends string = string> {
  /** The service that runs alongside this one. */
  service: N;
  /** Whether this service is held until that one's `healthcheck` passes. */
  wait: boolean;
}

/**
 * What a `deps` callback receives: {@link ConfigContext} (the service's environment and tokens)
 * and the session's mode.
 */
export interface DepsContext<T = TokenRecord> extends ConfigContext<T> {
  /** The active mode: `development` unless `--mode` says otherwise, or any name you pass it. */
  mode: Mode;
}

/** A service's `deps` computed from its context: the same entries the array form lists. */
export type DepsResolver<N extends string = string, T = TokenRecord> = (
  ctx: DepsContext<T>,
) => DepInput<N>[];

/** A service's `deps` as written in the config. Every name is checked against the services. */
type DepsInput<N extends string, T = TokenRecord> = {
  /**
   * Services that run alongside this one: selecting this service runs them too (not their own
   * deps). A name, or `{ service, wait: true }` to also hold this service until that one's
   * `healthcheck` passes — `deps: ['worker', { service: 'api', wait: true }]`.
   *
   * Or a callback returning those entries, run once per session with the service's `envs` and
   * `tokens` and the session's `mode`, so a dep can run in some modes only:
   * `deps: ({ mode }) => (mode === 'test' ? ['gateway'] : ['codegen', 'gateway'])`.
   */
  deps?: DepInput<NoInfer<N>>[] | DepsResolver<NoInfer<N>, NoInfer<T>>;
};

/**
 * One service as written in the config. `Own` is that service's own `tokens` and `Top` the
 * config's — both inferred from what you wrote, so the callbacks below see the merged record
 * with real keys.
 */
export type ServiceConfigInput<
  Own = unknown,
  Top = object,
  N extends string = string,
  RootDir extends string | undefined = undefined,
> = DepsInput<N, ServiceTokens<Top, Own>> &
  RelativeDirField<RootDir> & {
    /**
     * Directory holding the service, relative to `workspaceDir`. Inferred as
     * `<serviceRootDir>/<key>` when the config sets `serviceRootDir`; required otherwise. Set it
     * to override the inferred one.
     */
    relativeDir?: string;
    /** Show in the interactive picker (default `true`). */
    selectable?: boolean | undefined;
    /**
     * Color for this service's log-prefix label, overriding the auto-assigned palette color. Any
     * Ink/chalk color: a name (`'magenta'`, `'blueBright'`), hex (`'#af87ff'`),
     * `'rgb(175,135,255)'`, or `'ansi256(140)'`.
     */
    color?: string | undefined;
    /**
     * Automatically start this service during the run phase (default `true`). When `false`,
     * stackctl leaves it stopped — start it yourself with the `s` hotkey (or a control-API
     * `start`). Ignored when `command` is `null` (that service never starts).
     */
    autostart?: boolean | undefined;
    /**
     * Values of your own for this service's callbacks, merged **over** the config's top-level
     * `tokens` and handed to them as `tokens` — typed from what you declare here, so
     * `tokens.region` is known and a typo is a compile error.
     *
     * Only this service's callbacks see these; a sibling that doesn't declare `region` gets a
     * compile error for `tokens.region`. Services with no tokens of their own simply omit the
     * field.
     *
     * (`NoInfer` on the value type keeps the declaration checked — a non-string token value is
     * an error here — without that check re-entering inference.)
     */
    tokens?: Own & NoInfer<TokenRecord>;
    /** Per-service log options, overriding the top-level {@link DefineConfigOptions.logs}. */
    logs?: {
      /**
       * Prefix this service's on-screen log lines with a `YYYY-MM-DD HH:MM:SS` (24-hour)
       * timestamp. Overrides the top-level `logs.timestamps` for this service; when omitted, it
       * inherits that setting (which itself defaults to `true`). The on-disk log file is always
       * timestamped regardless of this option.
       */
      timestamps?: boolean;
      /**
       * Transform each raw output line from this service's dev process before it's shown and
       * logged. Receives one line of the process's stdout/stderr (no stackctl prefix or timestamp)
       * and returns the string to display. **This is the general hook** — it sees the whole line as
       * a plain string and assumes nothing about its format, so it's what you use to reshape
       * *any* output, structured or not.
       *
       * If the process logs **structured JSON**, don't write this by hand — `logging.formatter`
       * (and its ecosystem presets) already builds one, and stackctl applies the default to every
       * service automatically. Reach for a hand-written formatter when the output isn't JSON, or
       * when you want a rendering the built-in one can't express:
       *
       * ```ts
       * logs: {
       *   formatter: (line) => {
       *     try {
       *       const o = JSON.parse(line);
       *       if (typeof o.level !== 'string' || typeof o.msg !== 'string') return line;
       *       return `${o.level} ${o.msg}`;
       *     } catch {
       *       return line; // not JSON — leave it as-is
       *     }
       *   },
       * },
       * ```
       *
       * Return the line unchanged to pass it through — a formatter that reshapes only some lines
       * is normal, and is how the built-in one behaves.
       *
       * stackctl owns the timestamp (its own, shown per `logs.timestamps` and always in the log
       * file), so drop the log's own time field rather than printing it. The returned string
       * (ANSI color allowed) is what's buffered, displayed, and written to the log file. A
       * formatter that throws or returns a non-string falls back to the raw line.
       */
      formatter?: (line: string) => string;
    };
    /**
     * The service's dev port. Injected into its dev process as `PORT` (only a `PORT` in the
     * service's own `.env` file overrides it), handed to this service's `healthcheck`/`urls`
     * callbacks, and swept on session handoff. A path in `healthcheck` is probed on it, at
     * `http://localhost:<port>`.
     *
     * Pass a **callback** to derive it from the service's environment. It receives
     * `{ envs, tokens, service }`: the service's `.env` files already resolved and merged over
     * `process.env` — the same environment the dev process will get — so the port can live in an
     * env file instead of being hardcoded:
     *
     * ```ts
     * {
     *   name: 'backend',
     *   port: ({ envs }) => Number(envs.BACKEND_PORT),
     *   healthcheck: ({ port }) => `http://localhost:${port}/health`,
     * }
     * ```
     *
     * The callback runs once, while the config is being defined, and must return a number
     * synchronously (or `undefined` for "no port", the same as omitting the field).
     */
    port?: number | PortResolver<ServiceTokens<Top, Own>>;
    /**
     * Links shown in the running footer, one entry per line. An entry is a URL, a
     * `{ label, url }`, or an **array** of those (rendered on one line, space-separated).
     *
     * A path (`'/todos'`, `''` for the origin itself) is based on the service's **public
     * origin** (`service.publicOrigin`): where a browser reaches it — unlike a path in
     * `healthcheck`. A service `reverseProxy.routes` reaches only through `'*'` or `paths` has no
     * public origin unless its `publicOrigin` gives one, so a path there is an error: give it a
     * `publicOrigin`, build the link with `buildAddress`, or write the full URL.
     *
     * Any URL — bare or inside `{ label, url }` — may instead be a **callback** receiving
     * `{ envs, tokens, port, service, buildAddress }`, so a link can be built from this service's
     * resolved port, its public origin, or its environment rather than hardcoded:
     *
     * ```ts
     * urls: [
     *   ({ port }) => `http://localhost:${port}/debug`,
     *   { label: 'docs', url: ({ service }) => `${service.publicOrigin}/docs` },
     *   ({ buildAddress }) => buildAddress({ subdomain: 'admin' }),
     * ]
     * ```
     *
     * `urls` may itself be a callback over the same context, returning the list. That's the way to
     * build several links from one list of values, since a callback inside the list must be
     * written there to get its types:
     *
     * ```ts
     * urls: ({ buildAddress }) => ['app', 'web'].map((subdomain) => buildAddress({ subdomain })),
     * ```
     */
    urls?: UrlsInput<ServiceContext<ServiceTokens<Top, Own>>>;
    /**
     * A URL polled for readiness; also required of a service another one waits for
     * (`deps: [{ service, wait: true }]`). A path (`'/health'`) is probed at
     * `http://localhost:<port>/health` — always the service itself on loopback, never its public
     * origin and never the dev reverse proxy, which holds requests until this very probe passes;
     * unlike a path in `urls`. Like `urls`, it may instead be a callback over
     * `{ envs, tokens, port, service, buildAddress }`.
     *
     * Pass an object to give this service's probes a longer deadline than the 1500 ms default —
     * worth doing for a service slow to answer on a cold start, since stackctl aborting the
     * request is itself what makes the server log a dropped connection:
     *
     * ```ts
     * healthcheck: { url: ({ port }) => `http://localhost:${port}/health`, timeout: 10_000 }
     * ```
     *
     * stackctl probes one service at a time, no more often than every 2 s (measured from the
     * start of the previous probe), so a longer `timeout` slows this service's polling rather
     * than stacking requests — and affects no other service.
     */
    healthcheck?: HealthcheckInput<ServiceContext<ServiceTokens<Top, Own>>>;
    /**
     * The service's public origin, set rather than built from its route: its `PUBLIC_ORIGIN`, its
     * resolved `publicOrigin`, what a path in its `urls` is based on, and where `buildAddress`
     * starts. **It only shapes those URLs:** it never changes routing (`reverseProxy.routes` alone
     * decides which host reaches the service), the proxy, TLS, or the `healthcheck`, which probes
     * the service on loopback.
     *
     * Each part given replaces that part of the address the origin is built on, and the rest stay:
     * under `reverseProxy`, the proxy's public address (`publicAddress`'s scheme, canonical domain
     * and port), with the subdomain of the service's route, else none; without `reverseProxy`,
     * `http://localhost:<port>`. So a service reached only through `'*'` or `paths` gets an origin
     * of its own with `publicOrigin: { subdomain: 'app' }`, and `subdomain: null` is the bare
     * domain. A {@link PublicOriginInput}, or a callback over the service's `{ envs, tokens }`
     * returning one, resolved once at load.
     */
    publicOrigin?: PublicOriginInput | ((ctx: ConfigContext<ServiceTokens<Top, Own>>) => PublicOriginInput); // oxfmt-ignore
    /**
     * The dev process to run and how it behaves. A script/target name, or
     * `[name, { watches }]`. Default `['dev', { watches: true }]`.
     * Pass `null` for a service with no dev process — stackctl never starts it and it's hidden
     * from the interactive picker.
     *
     * - `watches` — the script watches files and reloads itself. Drives what to do after editing
     *   this service's code: `watches`→nothing, else restart.
     */
    command?: CommandInput | null;
  };

/**
 * One application service, written apart from `defineConfig` — in a file of its own, say — and
 * checked where it's written: `export const api = { command: 'dev', deps: ['worker'] } satisfies
 * ServiceInput<'api' | 'worker'>`. `N` is the config's service names, which `deps` is checked
 * against (it can't be read from a config the file is imported by); `T` is the config's `tokens`.
 * `relativeDir` is optional here: `defineConfig` checks it once the service is in the config.
 *
 * Use `satisfies`, not an annotation: an annotation gives the variable this whole type, which is
 * wider than the service as written, so `defineConfig` infers less from it.
 */
export type ServiceInput<N extends string = string, T = TokenRecord> = ServiceConfigInput<
  unknown,
  T,
  N,
  string
>;

/** A `reverseProxy.routes` entry that sends every request on its hosts to one service. */
export interface ReverseProxyServiceRoute<N extends string = string> {
  /**
   * The hosts under `reverseProxy.publicAddress.domain` (and each of its aliases) the entry
   * handles: a subdomain, or an array of them.
   *
   * - A subdomain is lowercase hostname labels joined by dots — `'api'`, `'v2.api'` — and matches
   *   its exact host, `<subdomain>.<domain>`, and nothing under it.
   * - `'*'` matches every host the entries before it don't: the bare domain, and any subdomain
   *   however many labels it has. It stands alone (no `'*.api'`, never in an array with other
   *   names), and its entry comes last.
   *
   * No subdomain may appear in two entries.
   */
  subdomain: string | string[];
  /**
   * The application or infra service that gets every request on these hosts, whatever the path.
   * It needs a `port`. The first such entry that names a service, `'*'` aside, gives it its public
   * origin, from the entry's first subdomain: `<scheme>://<subdomain>.<domain>[:port]`. Several
   * entries may name one service.
   */
  service: N;
  /** An entry gives `service` or `paths`, never both. */
  paths?: never;
}

/** A `reverseProxy.routes` entry that routes its hosts by path. */
export interface ReverseProxyPathsRoute<N extends string = string> {
  /**
   * The hosts under `reverseProxy.publicAddress.domain` (and each of its aliases) the entry
   * handles: a subdomain, or an array of them.
   *
   * - A subdomain is lowercase hostname labels joined by dots — `'api'`, `'v2.api'` — and matches
   *   its exact host, `<subdomain>.<domain>`, and nothing under it.
   * - `'*'` matches every host the entries before it don't: the bare domain, and any subdomain
   *   however many labels it has. It stands alone (no `'*.api'`, never in an array with other
   *   names), and its entry comes last.
   *
   * No subdomain may appear in two entries.
   */
  subdomain: string | string[];
  /**
   * Path globs (picomatch syntax, each starting with `/`) to the application or infra service that
   * gets a request whose path matches: `{ '/docs/**': 'docs', '/**': 'web' }`. The first glob that
   * matches wins, in the order written; `/docs/**` matches `/docs`, `/docs/` and `/docs/a/b`, not
   * `/docsite`. A path that no glob matches gets a 404 page: the request never goes on to a later
   * entry. The query string is not part of the match, and the path reaches the service unchanged.
   * Each service named needs a `port`. A service named here gets no public origin from it.
   */
  paths: Record<`/${string}`, N>;
  /** An entry gives `service` or `paths`, never both. */
  service?: never;
}

/**
 * One `reverseProxy.routes` entry: its `subdomain`, and either `service` (the whole host to one
 * service) or `paths` (the host routed by path). `N` is the names it may route to, application and
 * infra services alike — by default {@link ServiceName} and {@link InfraServiceName}, your own
 * once `Register` is augmented. A list written apart from `defineConfig` is
 * `ReverseProxyRoute[]`, or `ReverseProxyRoute<'api' | 'mail'>[]` to name them.
 */
// Both are `string` until `Register` is augmented, which the rule reads as a duplicate.
// oxlint-disable-next-line typescript/no-duplicate-type-constituents
export type ReverseProxyRoute<N extends string = ServiceName | InfraServiceName> =
  | ReverseProxyServiceRoute<N>
  | ReverseProxyPathsRoute<N>;

/** A `service` entry of `reverseProxy.routes`, resolved. */
export interface ResolvedReverseProxyServiceRoute {
  /** The subdomains, always a list, in the order written: `['api']`, `['*']`. */
  subdomain: string[];
  /** The service that gets every request on these hosts. */
  service: string;
  /** Not on a `service` entry. */
  paths?: never;
}

/** A `paths` entry of `reverseProxy.routes`, resolved. */
export interface ResolvedReverseProxyPathsRoute {
  /** The subdomains, always a list, in the order written: `['app']`, `['*']`. */
  subdomain: string[];
  /** Path glob → service, in the order written: the order they are tried in. */
  paths: Record<string, string>;
  /** Not on a `paths` entry. */
  service?: never;
}

/** A `reverseProxy.routes` entry, resolved: `subdomain` always a list. */
export type ResolvedReverseProxyRoute =
  | ResolvedReverseProxyServiceRoute
  | ResolvedReverseProxyPathsRoute;

/**
 * The built-in dev reverse proxy, as written in the config. Its presence enables the proxy:
 * stackctl listens on `port` (loopback only) and routes each request on it by `routes`, an ordered
 * list modelled on a Kubernetes ingress: the first entry whose `subdomain` matches the request's
 * host handles it, sending it to the entry's `service`, or by path through its `paths`. A host no
 * entry matches gets a 404 page.
 *
 * The domains are `publicAddress.domain`. A browser can reach the proxy directly (over TLS too,
 * with `tls`), or a TLS terminator in front (Caddy, say) can forward `<domain>` and
 * `*.<domain>` to it.
 */
export interface ReverseProxyInput<Top = TokenRecord, N extends string = string> {
  /**
   * The loopback port the proxy listens on: what a browser, or a TLS terminator in front of the
   * proxy, connects to. A literal, or a callback over the workspace context `{ envs, tokens }`
   * resolved once at load, like a service `port`:
   * `port: ({ envs }) => Number(envs.REVERSE_PROXY_PORT)`. Must differ from every service's and
   * infra service's port.
   */
  port: number | ((ctx: ConfigContext<Top>) => number);
  /**
   * Where browsers reach the services: the domain the proxy routes by, and the scheme and port
   * of every URL stackctl generates for them. A {@link PublicAddress}, or a callback over the
   * workspace context `{ envs, tokens }` returning one:
   * `publicAddress: ({ envs }) => ({ domain: envs.APP_DOMAIN, scheme: 'https' })`.
   *
   * **The proxy routes by `domain`:** each `routes` entry's subdomains are hosts under it. So
   * requests must arrive with that `Host`.
   *
   * Beyond routing, it is only about the URLs stackctl generates: each service's `publicOrigin`
   * and `PUBLIC_ORIGIN` (unless the service's own `publicOrigin` replaces a part), the paths in
   * `urls`, `buildAddress`, `startStack`'s `origins`, `show-config` and the control API. Healthchecks never use it: they probe
   * `http://localhost:<port>`. It doesn't change how the proxy listens or serves (that is `port`
   * and `tls`). Getting traffic on this address to the proxy is up to something outside
   * stackctl: a TLS terminator such as Caddy, DNS, or the browser itself.
   *
   * Omitted: domain `localhost`, scheme `https` when the proxy does TLS itself (`tls`), else
   * `http`, and port `port`. In every generated URL, a port that is the scheme's default (443 for
   * https, 80 for http) is left out.
   */
  publicAddress?: PublicAddress | ((ctx: ConfigContext<Top>) => PublicAddress);
  /**
   * Which service gets each request, by its host and then its path: an ordered list, like a
   * Kubernetes ingress's rules. The first entry whose `subdomain` matches the request's host
   * handles it: a `service` entry sends it to that service whatever the path, a `paths` entry to
   * the service of the first glob its path matches (or a 404 page when none does). A host no entry
   * matches gets a 404 page. Websocket upgrades route the same way.
   *
   * ```ts
   * routes: [
   *   { subdomain: 'api', service: 'api' },
   *   { subdomain: ['admin', 'backoffice'], service: 'admin' },
   *   { subdomain: 'mail', service: 'mailpit' }, // an infra service
   *   { subdomain: '*', paths: { '/docs/**': 'docs', '/**': 'web' } },
   * ]
   * ```
   *
   * A service's public origin comes from the first `service` entry that names it, `'*'` aside. A
   * service reached only through `'*'` or `paths` has none, unless its own `publicOrigin` gives
   * one. See {@link ReverseProxyRoute}.
   */
  routes?: ReverseProxyRoute<NoInfer<N>>[];
  /**
   * Serve TLS on the proxy's port, beside plain HTTP: browsers get HTTP/2, and, without a
   * `publicAddress`, public origins become `https://`. `true` makes a self-signed certificate for
   * each hostname the proxy serves (the browser warns about it once per host); `{ key, cert }`
   * uses yours, each a PEM's text or a file's path (relative to the workspace). A callback over
   * `{ envs, tokens }` may return either. Off by default.
   */
  tls?: ReverseProxyTls | ((ctx: ConfigContext<Top>) => ReverseProxyTls);
}

/**
 * `reverseProxy.publicAddress`: where browsers reach the services — the domain the dev reverse
 * proxy routes by, and the scheme and port of the URLs stackctl generates for them.
 */
export interface PublicAddress {
  /**
   * The domain the services live under: each `reverseProxy.routes` subdomain is a host under it
   * (`<subdomain>.<domain>`), and `'*'` is every host under it, the bare domain included. A
   * lowercase hostname.
   *
   * An array adds aliases: the first entry is the canonical domain, the one public origins are
   * built from; a Host under any other entry routes exactly as under the canonical one. No two
   * entries may be equal, and none may be a suffix of another.
   */
  domain: string | string[];
  /** The scheme browsers use for it: `'https'` or `'http'`. */
  scheme: 'https' | 'http';
  /**
   * The port browsers use. Omit it for the scheme's default (443 for https, 80 for http), which
   * every generated URL leaves out.
   */
  port?: number;
}

/** `reverseProxy.tls`: off, self-signed certificates (`true`), or a key and certificate of yours. */
export type ReverseProxyTls = boolean | { key: string; cert: string };

/** `reverseProxy.publicAddress` after resolution: the callback invoked, the defaults filled in. */
export interface ResolvedPublicAddress {
  /** The canonical domain: the first entry when the config gives an array. Public origins use it. */
  domain: string;
  /** Every domain the proxy routes under, canonical first, then its aliases. */
  domains: string[];
  /** The scheme of the generated URLs: `'https'` or `'http'`. */
  scheme: 'https' | 'http';
  /** The port in the generated URLs, or `undefined` when it is the scheme's default (443, 80). */
  port: number | undefined;
}

/** The dev reverse proxy after resolution: callbacks invoked, `publicAddress` defaulted. */
export interface ResolvedReverseProxy {
  /** The loopback port the proxy listens on. */
  port: number;
  /** Where browsers reach the services, and the domains the proxy routes by. */
  publicAddress: ResolvedPublicAddress;
  /** The route list, in order (`[]` when the config gives none), each `subdomain` a list. */
  routes: ResolvedReverseProxyRoute[];
  /**
   * TLS on the proxy's port: `false`, `'self-signed'` for a certificate per hostname, or `'own'`
   * for the config's key and certificate — which stay off the resolved config, since it is
   * printed (`show-config`) and served (the control API); see {@link proxyKeyAndCert}.
   */
  tls: false | 'self-signed' | 'own';
}

/** The key and certificate each resolved proxy with `tls: 'own'` was given, as written. */
const ownKeyAndCert = new WeakMap<ResolvedReverseProxy, { key: string; cert: string }>();

/** The key and certificate the config gave the proxy (PEM text or paths, as written), if any. */
export function proxyKeyAndCert(
  proxy: ResolvedReverseProxy,
): { key: string; cert: string } | undefined {
  return ownKeyAndCert.get(proxy);
}

/**
 * The parts a public address is formatted from: a service's public origin, and every
 * `buildAddress` URL, which starts from one and replaces what its options give.
 */
interface AddressParts {
  scheme: 'https' | 'http';
  /** `null` for the bare domain. */
  subdomain: string | null;
  domain: string;
  /** `undefined` for the scheme's default. */
  port: number | undefined;
}

/** The port a URL with this scheme leaves out: 443 for https, 80 for http. */
function defaultPortOf(scheme: 'https' | 'http'): number {
  return scheme === 'https' ? 443 : 80;
}

/**
 * `<scheme>://[<subdomain>.]<domain>[:port][path]`, the port left out when it is the scheme's
 * default. What every public origin and every `buildAddress` URL is formatted by, so they agree.
 */
function formatAddress(parts: AddressParts, path = ''): string {
  const host = parts.subdomain === null ? parts.domain : `${parts.subdomain}.${parts.domain}`;
  const port = parts.port === undefined || parts.port === defaultPortOf(parts.scheme) ? '' : `:${String(parts.port)}`; // oxfmt-ignore
  return `${parts.scheme}://${host}${port}${path}`;
}

/** `parts`, with each field `given` sets (`null` included) in place of its own. */
function withParts(parts: AddressParts, given: Partial<AddressParts>): AddressParts {
  return {
    scheme: given.scheme ?? parts.scheme,
    subdomain: given.subdomain === undefined ? parts.subdomain : given.subdomain,
    domain: given.domain ?? parts.domain,
    port: given.port ?? parts.port,
  };
}

/**
 * Checks the hostname labels of the parts a `publicOrigin` or `buildAddress` call gives, once the
 * schema has checked their shape. `at` is where they came from, `note` what follows each error.
 */
function checkAddressParts(
  parts: { subdomain?: string | null | undefined; domain?: string | undefined },
  at: string,
  note = '',
): void {
  const { subdomain, domain } = parts;
  if (typeof subdomain === 'string' && !isRouteSubdomain(subdomain)) {
    throw new Error(`${at}.subdomain ${JSON.stringify(subdomain)} is not lowercase hostname labels${note}`); // oxfmt-ignore
  }
  if (domain !== undefined && !HOSTNAME_RE.test(domain)) {
    throw new Error(`${at}.domain ${JSON.stringify(domain)} is not a lowercase hostname${note}`);
  }
}

/**
 * The `buildAddress` a callback gets: a URL from `start`, each option replacing that part of it,
 * the path appended. `owner` is the config path of whose callback it is, for an error.
 */
function addressBuilder(
  start: AddressParts,
  owner: string,
): (opts?: BuildAddressOptions) => string {
  const at = `${owner} buildAddress`;
  return (opts = {}) => {
    const { path, ...given } = parseAt(BuildAddressOptionsSchema, opts, at);
    checkAddressParts(given, at);
    const suffix = path === undefined || path === '' || path.startsWith('/') ? (path ?? '') : `/${path}`; // oxfmt-ignore
    return formatAddress(withParts(start, given), suffix);
  };
}

/**
 * Makes a service's `relativeDir` required when the config sets no `serviceRootDir`, and adds
 * nothing when it does (the directory is then inferred as `<serviceRootDir>/<key>`). `RootDir` is
 * the type of the config's `serviceRootDir` — `undefined` when it isn't set. The field and its
 * docs are declared in {@link ServiceConfigInput}: a field declared only inside a conditional
 * type shows no docs on hover.
 */
type RelativeDirField<RootDir extends string | undefined> = undefined extends RootDir
  ? { relativeDir: string }
  : unknown;

/**
 * `defineConfig`'s options. `Top` is the config's own `tokens` and `P` the per-service ones,
 * keyed by service name — `services` is a mapped type over `P` so each service's callbacks are
 * typed with *its* tokens merged over `Top`, and `K` (the keys) types every name reference.
 */
export type DefineConfigOptions<
  Top extends TokenRecord,
  P extends Record<string, unknown>,
  K extends string = Extract<keyof P, string>,
  RootDir extends string | undefined = undefined,
  // The infra services' names, which `reverseProxy.routes` may name beside the services'.
  I extends string = string,
> = {
  /**
   * Fixed control-API port; omit to let stackctl pick one (recorded in `modes/<mode>/running.json`). A
   * fixed port serves the session of one mode at a time.
   */
  apiPort?: number | undefined;
  /**
   * Root each service's `relativeDir` resolves against. Defaults to the directory holding the
   * config file.
   */
  workspaceDir?: string | undefined;
  /** Log display options. */
  logs?:
    | {
        /**
         * Prefix each on-screen log line with a local-time (24-hour) timestamp — `HH:MM:SS`
         * while everything on screen is from one day, `YYYY-MM-DD HH:MM:SS` once two days are
         * visible. Defaults to `true`. The on-disk log file always includes timestamps
         * regardless of this setting.
         */
        timestamps?: boolean | undefined;
      }
    | undefined;
  /**
   * Environment options: `vars`, variables of the config's own, `override`, which `.env`
   * values may beat the ambient environment, and `additionalFiles`, extra `.env` files placed
   * among stackctl's own. Which of stackctl's files load is chosen with `--mode`. A callback
   * here is shorthand for `vars`. See {@link EnvInput}.
   */
  env?: EnvInput<Top>;
  /**
   * Infrastructure that isn't an application service — a database, a cache, a broker — keyed by
   * provider (`'docker-compose'` is the only one). `stackctl infra start` starts it and waits until
   * it is ready, and a dev session does the same before starting the services; quitting stackctl
   * leaves it running. `infra: { 'docker-compose': true }` is a complete config.
   * See {@link InfraInput}.
   */
  infra?: InfraInput<Top>;
  /**
   * The directory the services live under, relative to `workspaceDir` — `'apps'`, say. With
   * it set, a service's directory is inferred as `<serviceRootDir>/<key>` and its `relativeDir`
   * becomes optional (an override); without it, every service must set `relativeDir`.
   */
  serviceRootDir?: RootDir;
  /**
   * Run stackctl's own dev reverse proxy: a loopback listener routing each request under
   * `publicAddress.domain` to a service or an infra service, by its host and then its path, as
   * its `routes` list says. Its `publicAddress` is also where a routed service's public origin
   * comes from. Present = enabled; there is no `enabled` flag. See {@link ReverseProxyInput}.
   */
  reverseProxy?: ReverseProxyInput<Top, K | I>;
  /**
   * Your application services, **keyed by service name**. The key is the service's name —
   * what `-s` takes, what `deps` reference, and what `relativeDir` defaults from
   * (`<serviceRootDir>/<key>`).
   */
  // `& Record<K, unknown>` is a second, **key-only** inference channel, and it is what keeps the
  // service names narrowed. The mapped type infers `P` from each service's `tokens`, but a
  // service literal made up entirely of callbacks is context-sensitive: TypeScript skips it in
  // the pass that would register its key, so with the mapped type alone a config where *every*
  // service declares nothing but callbacks inferred no keys at all and `K` widened to `string`
  // (dropping the `deps` checks). `Record<K, unknown>` has `unknown` values, so it
  // needs no contextual typing and infers the keys regardless — without competing with `P`.
  services: { [Q in keyof P]: ServiceConfigInput<P[Q], Top, K, RootDir> } & Record<K, unknown>;
  /**
   * Values of your own, handed to every callback as `tokens` (merged under each service's own
   * `tokens`) and typed from what you declare here.
   */
  tokens?: Top;
  /**
   * Workspace-wide footer links, not tied to a service — same entry shape as a service's
   * `urls`, but a callback here gets only `{ envs, tokens, buildAddress }` (there's no service,
   * so no `port`, and only the top-level tokens), with `envs` resolved at the workspace scope.
   * Its `buildAddress` starts from the dev reverse proxy's public address, at the bare domain. It
   * may be a callback returning the list, as a service's may.
   */
  urls?: UrlsInput<WorkspaceUrlsContext<Top>>;
};

// ---------------------------------------------------------------------------
// Resolved (runtime) types — normalized `command`, callbacks already invoked. Declared with their
// docs like the input types, and for the same reason; config.test-d.ts checks the fields the
// schema resolves against what it gives back.
// ---------------------------------------------------------------------------

export type ResolvedServiceConfig<N extends string, T = TokenRecord> = {
  /** The service's name — the key it was declared under. */
  name: N;
  /** The services that run alongside this one, each `{ service, wait }`, names checked. */
  deps?: ResolvedDep<N>[];
  /** Show in the interactive picker. As the config wrote it: `undefined` means `true`. */
  selectable?: boolean | undefined;
  /**
   * Color for this service's log-prefix label, when the config sets one; without it the label
   * takes the next palette color.
   */
  color?: string | undefined;
  /**
   * Start this service during the run phase. As the config wrote it: `undefined` means `true`.
   */
  autostart?: boolean | undefined;
  /** The dev process, normalized from whichever form the config wrote. */
  command: Command;
  /** Per-service log options, as the config wrote them. */
  logs?:
    | {
        /**
         * Prefix this service's on-screen log lines with a timestamp; `undefined` inherits the
         * top-level `logs.timestamps`.
         */
        timestamps?: boolean | undefined;
        /** The config's line formatter; `undefined` means stackctl's default one. */
        formatter?: ((line: string) => string) | undefined;
      }
    | undefined;
  /**
   * The config's top-level `tokens` with this service's own merged over them, typed from
   * what was declared. Available on the exported config, so other scripts can read a
   * service's tokens: `config.services.api.tokens.region`.
   */
  tokens: T;
  /** The service directory relative to `workspaceDir`: as written, or `<serviceRootDir>/<key>`. */
  relativeDir: string;
  /** The service directory, absolute (`workspaceDir` + `relativeDir`). */
  absoluteDir: string;
  /** The service's dev port, with any `port` callback already resolved. */
  port?: number;
  /** Footer links, with every callback already resolved to a string. */
  urls?: UrlEntry[];
  /** The readiness probe, normalized from whichever form the config wrote. */
  healthcheck?: ResolvedHealthcheck;
  /**
   * The service's public origin. With the service's `publicOrigin` set, the one that gives.
   * Otherwise `<scheme>://<subdomain>.<domain>[:port]` on `reverseProxy.publicAddress` for a
   * service a `reverseProxy.routes` `service` entry names (the first such entry, `'*'` aside, and
   * its first subdomain); `http://localhost:<port>` for one no route names; `undefined` for one
   * reached only through `'*'` or `paths`, and for a service with no `port`. Injected into the service's process as `PUBLIC_ORIGIN` (only one in the service's
   * own `.env` file overrides it), and what its relative `urls` are based on.
   */
  publicOrigin?: string;
};

export type AnyServiceConfig = ResolvedServiceConfig<string>;

/**
 * The resolved config `defineConfig` returns (and a config file exports). `P` carries each
 * service's declared tokens, so `services` is keyed by name with per-service token types.
 */
export interface Config<
  N extends string,
  P extends Record<N, unknown> = Record<N, TokenRecord>,
  Top = TokenRecord,
  // The infra services' names.
  I extends string = string,
> {
  /** User-pinned control-API port, or `undefined` to let stackctl pick a random one at startup. */
  apiPort?: number;
  /** The directory service directories were inferred under, when the config set one. */
  serviceRootDir?: string;
  /**
   * The resolved services, **keyed by name** — the same keys the config declared, so
   * `config.services.api.tokens` is that service's tokens and `config.services.ghost` is a
   * compile error. Use `Object.values(config.services)` to iterate.
   */
  services: { [Q in N]: ResolvedServiceConfig<Q, ServiceTokens<Top, P[Q]>> };
  /** Workspace-wide URLs, with every callback resolved to a string, or `undefined` if none. */
  urls?: UrlEntry[];
  /** The dev reverse proxy, resolved, or `undefined` when the config declares none. */
  reverseProxy?: ResolvedReverseProxy;
  /** The infra providers, resolved, or `undefined` when the config declares none. */
  infra?: ResolvedInfra<I>;
  /**
   * The `.env` files looked for at each scope for the active mode, ascending precedence:
   * stackctl's own, with `env.additionalFiles` placed among them.
   */
  envFiles: EnvFileOrder;
  /** The active mode (`--mode`, else `STACKCTL_MODE`, else `test` in CI, else `development`). */
  envMode: Mode;
  /** Variables whose `.env` or `env.vars` value may beat the ambient environment. */
  envOverride?: EnvOverride;
  /** Whether dotenvx's encrypted values are decrypted (`env.decrypt`). */
  envDecrypt: boolean;
  /** The config's own variables (`env.vars`), resolved, or `undefined` when it declares none. */
  envVars?: Record<string, string>;
  /** Whether to prefix on-screen log lines with a timestamp (defaults to `false`). */
  logTimestamps: boolean;
}

// ---------------------------------------------------------------------------
// State + lookups
// ---------------------------------------------------------------------------

let registeredPackages: AnyServiceConfig[] = [];
let loadedConfig: Config<string> | null = null;
/** The loaded config's top-level `tokens` — what an infra callback receives as `tokens`. */
let loadedTokens: TokenRecord = {};
/**
 * Absolute directory service paths resolve against. Set when a config loads; until then the
 * process cwd, which is what `defineConfig` itself defaults to.
 */
let workspaceRoot: string = process.cwd();

export function getRegisteredPackages(): AnyServiceConfig[] {
  return registeredPackages;
}

/** The most recently defined config (meta + services), or null before any `defineConfig` runs. */
export function getLoadedConfig(): Config<string> | null {
  return loadedConfig;
}

/**
 * The workspace root every service path was resolved against — the config's `workspaceDir`, or
 * the cwd when it doesn't set one. Not the config file's own directory: a config in a subdirectory
 * can point `workspaceDir` elsewhere, and anything reasoning about "is this process ours?" has to
 * ask about the same tree the services actually live in.
 */
export function getWorkspaceDir(): string {
  return workspaceRoot;
}

/** The loaded config's top-level `tokens` (empty until a config loads, or when it declares none). */
export function getConfigTokens(): TokenRecord {
  return loadedTokens;
}

export function findService(name: string): AnyServiceConfig {
  const pkg = registeredPackages.find((p) => p.name === name);
  if (!pkg) {
    throw new Error(`no service is named ${name}`);
  }
  return pkg;
}

/** The dev-process script/target name for a service (`command.name`, default `'dev'`). */
export function getDevScript(pkg: AnyServiceConfig): string {
  return pkg.command?.name ?? 'dev';
}

// ---------------------------------------------------------------------------
// Callback resolution (post-parse) — every `port`/`healthcheck`/`urls` callback is invoked
// exactly once here, so nothing downstream ever encounters a function.
// ---------------------------------------------------------------------------

/**
 * Memoizes a synchronous factory. Every context is built through one of these, so a config
 * whose values are all literals never reads an `.env` file, and one that has ten callbacks
 * reads them once.
 */
function once<T>(factory: () => T): () => T {
  let cached: { value: T } | undefined;
  return () => (cached ??= { value: factory() }).value;
}

/**
 * What a URL is resolved against: the context its callback gets, the service's `port` and (under
 * the dev reverse proxy) public origin that a relative path is based on, and `where`, naming the
 * field in error messages. The workspace-wide `urls` have neither port nor origin.
 */
interface UrlScope {
  ctx: () => ServiceContext;
  port: number | undefined;
  publicOrigin: string | undefined;
  where: string;
  /** What declares the URL, for an error message: a service unless it says otherwise. */
  owner?: 'package' | 'service';
  /**
   * Set for a service `reverseProxy.routes` reaches only through `'*'` or `paths`, and whose own
   * `publicOrigin` gives it none: a path in its `urls` has nothing to be based on.
   */
  noPublicOrigin?: boolean;
}

/**
 * Every form a resolved URL can take. Identical for an absolute URL; for a relative path they
 * differ once the service's public origin is somewhere else than its loopback port (under the dev
 * reverse proxy, say) — and each call site picks: `urls` show `public` (one link, not a loopback
 * twin), a `healthcheck` probes `private` (the service itself; the proxy holds requests until that
 * very probe passes, so probing through it would never pass).
 */
export interface ResolvedUrlForms {
  /** `<publicOrigin>/path`: the same as `private` when the public origin is the service itself. */
  public: string;
  /** The service itself on loopback: `http://localhost:<port>/path`. */
  private: string;
}

/** `true` for anything with a scheme (`https://…`, `ws://…`, `mailto:…`) — left exactly as written. */
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A URL as written in the config, resolved into its {@link ResolvedUrlForms}: a literal or a
 * callback's return value, absolute as-is, or a relative path — with or without the leading
 * slash (`/todos` and `todos` alike), or `''` for the origin itself — based on the service. A
 * path's trailing slash is dropped (`/todos/` is `/todos`), which makes `/` the origin too.
 */
function resolveUrlForms(
  value: UrlValue,
  scope: UrlScope,
  use: keyof ResolvedUrlForms,
): ResolvedUrlForms {
  let url: unknown = value;
  if (typeof value === 'function') {
    url = value(scope.ctx());
    if (typeof url !== 'string') {
      throw new Error(`${scope.where}: callback returned ${String(url)} (expected a string)`);
    }
  }
  const text = url as string;
  if (ABSOLUTE_URL_RE.test(text)) {
    return { public: text, private: text };
  }
  // `''` is the origin itself; anything else is a path, leading slash optional and trailing
  // slash dropped — from the path alone, so a query or fragment stays exactly as written.
  const suffixAt = text.search(/[?#]/);
  const pathname = (suffixAt === -1 ? text : text.slice(0, suffixAt)).replace(/\/+$/, '');
  const suffix = suffixAt === -1 ? '' : text.slice(suffixAt);
  const path = `${pathname === '' || pathname.startsWith('/') ? pathname : `/${pathname}`}${suffix}`;
  // A `publicOrigin` override can give an origin to a service with no `port`: a link needs none.
  if (use === 'public' && scope.port === undefined && scope.publicOrigin !== undefined) {
    const pub = `${scope.publicOrigin}${path}`;
    return { public: pub, private: pub };
  }
  if (scope.port === undefined) {
    throw new Error(
      scope.publicOrigin === undefined && scope.where === 'top-level url'
        ? `${scope.where}: ${JSON.stringify(text)} is a path, but workspace-wide urls belong to no ` +
            "service, so there's nothing to base it on. Move it into a service's `urls`, or write the full URL."
        : `${scope.where}: ${JSON.stringify(text)} is a path, but this ${scope.owner ?? 'service'} declares no \`port\` to ` +
            'base it on. Add `port` to it, or write the full URL.',
    );
  }
  if (use === 'public' && scope.noPublicOrigin) {
    throw new Error(
      `${scope.where}: ${JSON.stringify(text)} is a path, but this ${scope.owner ?? 'service'} has no public ` +
        "origin to base it on: `reverseProxy.routes` reaches it only through '*' or `paths`, which " +
        'give it no host of its own. Give it one with `publicOrigin: { subdomain }`, build the link ' +
        'with `buildAddress({ subdomain, path })`, or write the full URL.',
    );
  }
  const priv = `http://localhost:${String(scope.port)}${path}`;
  return {
    public: scope.publicOrigin === undefined ? priv : `${scope.publicOrigin}${path}`,
    private: priv,
  };
}

/** Resolves one link (bare URL or `{ label, url }`) to its public form, preserving its shape. */
function resolveUrlLink(link: UrlLinkInput, scope: UrlScope): UrlLink {
  return typeof link === 'object'
    ? { ...link, url: resolveUrlForms(link.url, scope, 'public').public }
    : resolveUrlForms(link, scope, 'public').public;
}

/** Whether `value` is one link a `urls` callback may return: a string, or `{ label, url }` strings. */
function isPlainLink(value: unknown): value is UrlLink {
  if (typeof value === 'string') {
    return true;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const { label, url } = value as { label?: unknown; url?: unknown };
  return typeof label === 'string' && typeof url === 'string';
}

/**
 * Normalizes a `healthcheck` to `{ url, timeout }`: the bare-URL form takes the default
 * timeout, either form's URL may be a callback or a path, and the URL is the *private* one —
 * what the status probe polls.
 */
function resolveHealthcheck(value: HealthcheckInput, scope: UrlScope): ResolvedHealthcheck {
  const spec = typeof value === 'object' ? value : { url: value, timeout: undefined };
  return {
    url: resolveUrlForms(spec.url, scope, 'private').private,
    timeout: spec.timeout ?? DEFAULT_HEALTHCHECK_TIMEOUT_MS,
  };
}

/** Resolves a `urls` entry, which may be a single link or an array rendered on one line. */
function resolveUrlEntry(entry: UrlEntryInput, scope: UrlScope): UrlEntry {
  return Array.isArray(entry)
    ? entry.map((link) => resolveUrlLink(link, scope))
    : resolveUrlLink(entry, scope);
}

/**
 * Resolves a `urls` field: its list as written, or the list its callback returns, each entry's
 * paths based on the service as usual.
 */
function resolveUrls(urls: UrlsInput | undefined, scope: UrlScope): UrlEntry[] | undefined {
  if (urls === undefined) {
    return undefined;
  }
  let entries: readonly UrlEntryInput[] = urls as readonly UrlEntryInput[];
  if (typeof urls === 'function') {
    const value: unknown = urls(scope.ctx());
    const valid =
      Array.isArray(value) &&
      value.every(
        (entry) => isPlainLink(entry) || (Array.isArray(entry) && entry.every(isPlainLink)),
      );
    if (!valid) {
      throw new Error(
        `${scope.where}: callback returned ${JSON.stringify(value) ?? String(value)}, not a list of links`,
      );
    }
    entries = value as UrlEntry[];
  }
  return entries.map((entry) => resolveUrlEntry(entry, scope));
}

/** A parsed service plus the `name` taken from the key it was declared under. */
type ParsedPackage = v.InferOutput<typeof ServiceConfigSchema> & { name: string };

type Issue = v.BaseIssue<unknown>;

/** The keys an issue's path walks, from the value parsed. */
const keysOf = (issue: Issue): string[] => (issue.path ?? []).map((item) => String(item.key));

/** An issue with a strict object's keys, rather than its value: its path ends at the key. */
const onKey = (issue: Issue) =>
  issue.type === 'strict_object' && issue.path?.at(-1)?.origin === 'key';
/** A key a strict object doesn't know. */
const isUnknownKey = (issue: Issue) => onKey(issue) && issue.expected === 'never';
/** A key a strict object requires and the value lacks. */
const isMissingKey = (issue: Issue) => onKey(issue) && issue.expected !== 'never';

/**
 * How much an issue from one form of a failed union says about the value: a bad value in a field
 * the form has, most; then a key no form has; then a field that belongs to another form; then a
 * key the form needs and the value lacks, least, since the value was most likely meant as another
 * form.
 */
const telling = (issue: Issue) =>
  isMissingKey(issue) ? 0 : issue.type === 'never' ? 1 : isUnknownKey(issue) ? 2 : 3;

/**
 * The issue to report for `issue`, and the keys to it from the value parsed. A union that no
 * form matched holds every form's issues, with paths from the union: the most telling one inside
 * the value is reported, since a misspelled key or a bad field says more than "expected one of
 * these". When no form got past the union itself, the union's own issue is.
 */
function reported(issue: Issue): { issue: Issue; keys: string[] } {
  const keys = keysOf(issue);
  if (issue.type !== 'union' || !issue.issues) {
    return { issue, keys };
  }
  let best: { issue: Issue; keys: string[] } | undefined;
  for (const inner of issue.issues.map(reported)) {
    if (inner.keys.length > 0 && (!best || telling(inner.issue) > telling(best.issue))) {
      best = inner;
    }
  }
  return best ? { issue: best.issue, keys: [...keys, ...best.keys] } : { issue, keys };
}

/**
 * Renders a valibot parse failure into a readable, multi-line message: each issue's own message,
 * after its path. `at` is where in the config the parsed value came from, in front of each path.
 */
function formatConfigError(issues: readonly Issue[], at?: string): string {
  const lines = issues.map((top) => {
    const { issue, keys } = reported(top);
    const where = [...(at === undefined ? [] : [at]), ...keys].join('.');
    return `  - ${where || '(root)'}: ${issue.message}`;
  });
  return `invalid stackctl config:\n${lines.join('\n')}`;
}

/**
 * `value` parsed by `schema`, or the config error its failure gives, each issue under `at`.
 * `note` follows the issues, for a value a callback returned: what it ran with.
 */
function parseAt<S extends v.GenericSchema>(
  schema: S,
  value: unknown,
  at: string,
  note = '',
): v.InferOutput<S> {
  const result = v.safeParse(schema, value);
  if (!result.success) {
    throw new Error(`${formatConfigError(result.issues, at)}${note}`);
  }
  return result.output;
}

/** Which `.env` files a failed callback had to read from, for its error message. */
function envFilesNote(files: string[]): string {
  return files.length ? `env files loaded: ${files.join(', ')}` : 'no env files were found';
}

/**
 * `env.additionalFiles` for `mode`: the array, or its callback's result, checked against the
 * schema and then entry by entry. A bad entry is an error naming it — its index and its `file` —
 * and, for a callback, the mode it was called for.
 */
function resolveAdditionalFiles(
  input: EnvAdditionalFile[] | ((ctx: { mode: Mode }) => EnvAdditionalFile[]) | undefined,
  mode: Mode,
): EnvAdditionalFile[] {
  if (input === undefined) {
    return [];
  }
  const computed = typeof input === 'function';
  const called = computed
    ? `\n  (returned by the env.additionalFiles callback for mode "${mode}")`
    : '';
  const result = parseAt(
    v.array(EnvAdditionalFileSchema),
    computed ? input({ mode }) : input,
    'env.additionalFiles',
    called,
  );
  const standard = new Set(envFileNames(mode));
  const seen: { file: string; scope: unknown; at: string }[] = [];
  return result.map((entry, i): EnvAdditionalFile => {
    const at = `env.additionalFiles[${String(i)}]`;
    const { file, scope } = entry;
    const fail = (problem: string): never => {
      throw new Error(`${at} (${JSON.stringify(file)}): ${problem}${called}`);
    };
    if (file === '.' || file === '..' || /[/\\]/.test(file)) {
      fail("`file` must be a filename in the scope's directory, not a path");
    }
    if (standard.has(file)) {
      fail(
        `${JSON.stringify(file)} is one of stackctl's own files for mode "${mode}", which load anyway`,
      );
    }
    // Two entries clash when they name one file at a scope both are looked for at.
    const clash = seen.find(
      (other) =>
        other.file === file &&
        (other.scope === undefined || scope === undefined || other.scope === scope),
    );
    if (clash) {
      fail(`already listed as ${clash.at}`);
    }
    seen.push({ file, scope, at });
    return entry;
  });
}

/**
 * The config's own variables: the `env.vars` record, or its callback's result. A value that
 * isn't a string is an error naming the variable — and, for a callback, the env files loaded,
 * in the style of a service `port`. An `undefined` one is left out.
 */
function resolveEnvVars(
  vars: NonNullable<v.InferOutput<typeof DefineConfigSchema>['env']>['vars'],
  ctx: () => ConfigContext,
  envFilesLoaded: () => string[],
): Record<string, string> | undefined {
  if (vars === undefined) {
    return undefined;
  }
  const computed = typeof vars === 'function';
  const fail = (problem: string): never => {
    const where = computed ? `\n  ${envFilesNote(envFilesLoaded())}` : '';
    throw new Error(`env.vars: ${problem}${where}`);
  };
  const result: unknown = typeof vars === 'function' ? vars(ctx()) : vars;
  // A plain object only: a promise (an `async` callback) or a `Map` has no entries to read, and
  // would otherwise resolve to no variables at all without a word.
  const proto: unknown =
    typeof result === 'object' && result !== null ? Object.getPrototypeOf(result) : undefined;
  if (proto !== Object.prototype && proto !== null) {
    const shown = typeof result === 'string' ? JSON.stringify(result) : String(result);
    return fail(
      `${computed ? 'callback returned' : 'got'} ${shown} (expected an object of variables)`,
    );
  }
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (!ENV_NAME_RE.test(key)) {
      throw new Error(
        `env.vars: ${JSON.stringify(key)} is not a valid environment variable name ` +
          '(letters, digits, "_", "." and "-")',
      );
    }
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string') {
      return fail(
        `${key} is ${inspect(value)} (a ${typeof value}) — an environment variable must be a string`,
      );
    }
    resolved[key] = value;
  }
  return resolved;
}

/**
 * A service's effective port: the literal number, or the result of its `port` callback. The
 * callback can't see `port` itself, so it gets {@link PortContext}: the service's name alone.
 */
function resolvePort(
  pkg: ParsedPackage,
  ctx: () => PortContext,
  envFilesLoaded: () => string[],
): number | undefined {
  if (typeof pkg.port !== 'function') {
    return pkg.port;
  }
  const port = pkg.port(ctx());
  if (port === undefined) {
    return undefined;
  }
  if (typeof port !== 'number' || !Number.isFinite(port)) {
    throw new Error(
      `${pkg.name}: port callback returned ${String(port)} (check the env vars it reads)\n  ${envFilesNote(envFilesLoaded())}`,
    );
  }
  return port;
}

/**
 * Whether an infra service runs: its `enabled` literal, or its callback's answer, defaulting
 * to `true`. The callback must return a real boolean — `envs.SOME_KEY` (a string, or undefined)
 * is the easy slip, and quietly reading either as a yes or a no would be a guess.
 */
function resolveInfraEnabled(
  service: string,
  enabled: unknown,
  ctx: () => InfraEnabledContext,
): boolean {
  if (typeof enabled !== 'function') {
    return (enabled as boolean | undefined) ?? true;
  }
  const result: unknown = (enabled as (ctx: InfraEnabledContext) => unknown)(ctx());
  if (typeof result !== 'boolean') {
    throw new Error(
      `infra: the \`enabled\` callback of "${service}" returned ` +
        `${typeof result === 'string' ? JSON.stringify(result) : String(result)}, not a boolean — ` +
        'wrap it, e.g. `Boolean(envs.SOME_KEY)`.',
    );
  }
  return result;
}

/** An infra service as parsed, before anything about it is resolved. */
type ParsedInfraService = v.InferOutput<typeof InfraServiceSchema>;

/**
 * Resolves one infra service: `enabled` first, then — only for a service that runs — its `port`
 * and `urls` callbacks, over the workspace context. A service disabled in a mode is often exactly
 * the one whose variables that mode doesn't set, so its callbacks must not run there. The infra
 * callbacks are kept as written.
 */
function resolveInfraService(
  name: string,
  { enabled, port, urls, publicOrigin: originInput, ...callbacks }: ParsedInfraService,
  opts: {
    reverseProxy: ResolvedReverseProxy | undefined;
    ctx: () => ConfigContext;
    mode: Mode;
    envFilesLoaded: () => string[];
  },
): ResolvedInfraService {
  const identity: ServiceIdentity = { name, kind: 'infra' };
  const reach = reachOf(opts.reverseProxy, name);
  // Before `enabled` is read: a route with nothing to point at is a config bug in every mode.
  if (reach.routed && port === undefined) {
    throw new Error(
      `reverseProxy.routes routes to infra service "${name}", which declares no \`port\``,
    );
  }
  const isEnabled = resolveInfraEnabled(name, enabled, () => ({
    mode: opts.mode,
    ...opts.ctx(),
    service: identity,
  }));
  let resolvedPort: number | undefined;
  if (isEnabled && port !== undefined) {
    resolvedPort = typeof port === 'function' ? port({ ...opts.ctx(), service: identity }) : port;
    if (
      resolvedPort !== undefined &&
      (typeof resolvedPort !== 'number' || !Number.isFinite(resolvedPort))
    ) {
      throw new Error(
        `infra service "${name}": port callback returned ${String(resolvedPort)} (check the env vars it reads)\n  ${envFilesNote(opts.envFilesLoaded())}`,
      );
    }
  }
  // A port callback that answers "no port" leaves the route with nothing to point at, too.
  if (isEnabled && reach.routed && resolvedPort === undefined) {
    throw new Error(
      `reverseProxy.routes routes to infra service "${name}", whose \`port\` callback returned no port`,
    );
  }
  const route = isEnabled ? reach.route : null;
  const owner = `infra service "${name}"`;
  const configPath = infraConfigPath(name);
  const addresses = addressesOf(opts.reverseProxy, {
    kind: 'infra',
    port: resolvedPort,
    reach,
    // Like `port`, not resolved for a disabled service.
    override: isEnabled ? resolvePublicOriginInput(originInput, opts.ctx, configPath) : undefined,
    owner: configPath,
  });
  const publicOrigin = isEnabled ? addresses.publicOrigin : undefined;
  const details: ServiceDetails = { ...identity, port: resolvedPort, route, publicOrigin };
  const where = `${owner} urls`;
  // What a `urls` callback gets: a service's context, with the service resolved.
  const ctx = once((): ServiceContext =>
    packageContext(
      opts.ctx(),
      details,
      addresses.buildAddress,
      () =>
        `${where}: a callback read \`port\`, but this service declares no \`port\`. Add ` +
        '`port` to it, or drop `port` from the callback.',
    ),
  );
  const noPublicOrigin = reach.routed && publicOrigin === undefined;
  const resolved: ResolvedInfraService = {
    ...(callbacks as InfraServiceCallbacks),
    enabled: isEnabled,
    port: resolvedPort,
    publicOrigin,
    urls: isEnabled
      ? resolveUrls(urls, { ctx, port: resolvedPort, publicOrigin, where, owner: 'service', noPublicOrigin }) // oxfmt-ignore
      : undefined,
  };
  serviceDetailsOf.set(resolved, details);
  buildAddressOf.set(resolved, addresses.buildAddress);
  return resolved;
}

/** An infra service's path in the config, for an error about it. */
function infraConfigPath(name: string): string {
  return `infra.docker-compose.services.${name}`;
}

/** Each resolved infra service as its callbacks see it: what `infraServiceDetails` returns. */
const serviceDetailsOf = new WeakMap<object, ServiceDetails>();
/** The `buildAddress` each resolved infra service's callbacks get: what `infraBuildAddress` returns. */
const buildAddressOf = new WeakMap<object, (opts?: BuildAddressOptions) => string>();

/**
 * An infra service as its `beforeStart`/`afterReady`/… callbacks see it (`service` in their
 * context): the same {@link ServiceDetails} its `urls` callbacks got when the config loaded.
 */
export function infraServiceDetails(
  name: string,
  service: { port?: number | undefined; publicOrigin?: string | undefined } | undefined,
): ServiceDetails {
  return (
    (service && serviceDetailsOf.get(service)) ?? {
      name,
      kind: 'infra',
      port: service?.port,
      route: null,
      publicOrigin: service?.publicOrigin,
    }
  );
}

/**
 * The `buildAddress` an infra service's `beforeStart`/`afterReady`/… callbacks get: the same one its
 * `urls` callbacks got when the config loaded, else one starting from `config`'s proxy (its route's
 * subdomain, else the bare domain), or from `http://localhost:<port>` without one.
 */
export function infraBuildAddress(
  name: string,
  service: { port?: number | undefined } | undefined,
  config: Pick<Config<string>, 'reverseProxy'> | null | undefined,
): (opts?: BuildAddressOptions) => string {
  const known = service && buildAddressOf.get(service);
  if (known !== undefined) {
    return known;
  }
  const proxy = config?.reverseProxy;
  return addressBuilder(baseParts(proxy, reachOf(proxy, name), service?.port), infraConfigPath(name)); // oxfmt-ignore
}

/** How `reverseProxy.routes` reaches a service. */
interface RouteReach {
  /** The host of the first `service` entry that names it, `'*'` aside: its public origin's. */
  route: ServiceRoute | null;
  /** Whether any entry names it, as its `service` or in its `paths`. */
  routed: boolean;
}

/** How `reverseProxy.routes` reaches the service or infra service called `name`. */
function reachOf(reverseProxy: ResolvedReverseProxy | undefined, name: string): RouteReach {
  let routed = false;
  for (const entry of reverseProxy?.routes ?? []) {
    if (entry.service === name) {
      routed = true;
      // A `'*'` entry lists nothing else, so its first subdomain says which kind it is.
      const [subdomain] = entry.subdomain;
      if (subdomain !== undefined && subdomain !== '*') {
        return { route: { host: `${subdomain}.${reverseProxy!.publicAddress.domain}`, subdomain }, routed }; // oxfmt-ignore
      }
    } else if (entry.paths !== undefined && Object.values(entry.paths).includes(name)) {
      routed = true;
    }
  }
  return { route: null, routed };
}

/**
 * Builds the context a service's `healthcheck`/`urls` callbacks get: the base
 * {@link ConfigContext}, the service resolved, and its `port` at the top.
 *
 * {@link ServiceContext.port} is typed `number` so callbacks don't have to unwrap it, which the
 * type system can't verify — a mapped type infers only one type parameter and this config spends
 * it on per-service `tokens`. So when the service has no port, `port` becomes a getter that
 * throws. Callbacks all run here, once, while the config loads, so a service that reads a port it
 * never declared fails immediately with its own name in the message rather than quietly producing
 * `…:undefined`. Non-enumerable so a spread or a debug log of the context can't trip it.
 */
function packageContext(
  base: ConfigContext,
  // `undefined` for the workspace-wide `urls`, which belong to no service.
  service: ServiceDetails | undefined,
  buildAddress: (opts?: BuildAddressOptions) => string,
  whyPortMissing: () => string,
): ServiceContext {
  if (service?.port !== undefined) {
    return { ...base, port: service.port, service, buildAddress };
  }
  const ctx = { ...base, ...(service && { service }), buildAddress } as ServiceContext;
  return Object.defineProperty(ctx, 'port', {
    enumerable: false,
    configurable: true,
    get(): never {
      throw new Error(whyPortMissing());
    },
  });
}

/**
 * A service's directory when it sets no `relativeDir`: `<serviceRootDir>/<key>` (a trailing
 * slash on the root tolerated). Without a `serviceRootDir` there is nothing to infer from — the
 * types require `relativeDir` then, and this is the backstop for a config that bypassed them.
 */
function inferredRelativeDir(serviceRootDir: string | undefined, name: string): string {
  if (serviceRootDir === undefined) {
    throw new Error(
      `${name} has no \`relativeDir\`, and the config sets no \`serviceRootDir\` to infer it from. ` +
        `Set \`serviceRootDir\` (e.g. 'apps') at the top level, or \`relativeDir\` on ${name}.`,
    );
  }
  return `${serviceRootDir.replace(/\/+$/, '')}/${name}`;
}

/** A lowercase hostname: DNS labels of `[a-z0-9-]`, none starting or ending with a hyphen. */
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Resolves the `reverseProxy` block: its `port`/`publicAddress`/`tls` callbacks run once over the
 * workspace context. What a callback returns is checked as the field written out is, and an error
 * about it names the env files loaded, in the style of a service `port`.
 */
function resolveReverseProxy(
  block: NonNullable<v.InferOutput<typeof DefineConfigSchema>['reverseProxy']>,
  ctx: () => ConfigContext,
  envFilesLoaded: () => string[],
): ResolvedReverseProxy {
  const callbackNote = () => `\n  (returned by its callback)\n  ${envFilesNote(envFilesLoaded())}`;
  const port = typeof block.port === 'function' ? block.port(ctx()) : block.port;
  if (typeof port !== 'number' || !Number.isFinite(port)) {
    throw new Error(
      `reverseProxy.port: callback returned ${typeof port === 'string' ? JSON.stringify(port) : inspect(port, { depth: 1 })} (check the env vars it reads)\n  ${envFilesNote(envFilesLoaded())}`,
    );
  }
  const tls =
    typeof block.tls === 'function'
      ? parseAt(ReverseProxyTlsSchema, block.tls(ctx()), 'reverseProxy.tls', callbackNote())
      : (block.tls ?? false);
  const publicAddress =
    block.publicAddress === undefined
      ? defaultPublicAddress(port, tls !== false)
      : typeof block.publicAddress === 'function'
        ? resolvePublicAddress(block.publicAddress(ctx()), callbackNote())
        : resolvePublicAddress(block.publicAddress);
  const resolved: ResolvedReverseProxy = {
    port,
    publicAddress,
    routes: resolveRoutes(block.routes ?? []),
    tls: tls === false ? false : tls === true ? 'self-signed' : 'own',
  };
  if (typeof tls === 'object') {
    ownKeyAndCert.set(resolved, tls);
  }
  return resolved;
}

/**
 * The public address when the config gives none: the proxy itself, at `localhost` — `https` when
 * it does TLS, on its own port.
 */
function defaultPublicAddress(port: number, tls: boolean): ResolvedPublicAddress {
  const scheme = tls ? 'https' : 'http';
  return {
    domain: 'localhost',
    domains: ['localhost'],
    scheme,
    port: port === defaultPortOf(scheme) ? undefined : port,
  };
}

/**
 * Checks a `publicAddress`, as written or as its callback returned it (`note` then says so), and
 * settles it: the domain as a non-empty list, canonical first, and the port dropped when it is the
 * scheme's default.
 */
function resolvePublicAddress(value: unknown, note = ''): ResolvedPublicAddress {
  const { domain, scheme, port } = parseAt(PublicAddressSchema, value, 'reverseProxy.publicAddress', note); // oxfmt-ignore
  const domains = resolveDomains(domain, note);
  return {
    domain: domains[0]!,
    domains,
    scheme,
    port: port === undefined || port === defaultPortOf(scheme) ? undefined : port,
  };
}

/** A `routes` subdomain other than `'*'`: lowercase hostname labels, each at most 63 characters. */
function isRouteSubdomain(value: string): boolean {
  return HOSTNAME_RE.test(value) && value.split('.').every((label) => label.length <= 63);
}

/**
 * Checks `reverseProxy.routes`, entry by entry, once the schema has checked their shape, and
 * settles each `subdomain` as a list. What it rejects would otherwise be a route nobody can reach,
 * or one the proxy could not tell apart from another: `'*'` before the last entry, a subdomain two
 * entries list. The services each entry names are checked once the services are known.
 */
function resolveRoutes(
  routes: v.InferOutput<typeof ReverseProxyRouteSchema>[],
): ResolvedReverseProxyRoute[] {
  /** Each subdomain, and the entry that lists it. */
  const listedBy = new Map<string, string>();
  return routes.map((entry, i): ResolvedReverseProxyRoute => {
    const at = `reverseProxy.routes[${String(i)}]`;
    const list = resolveRouteSubdomain(entry.subdomain, at);
    for (const name of list) {
      const earlier = listedBy.get(name);
      if (earlier !== undefined) {
        throw new Error(`${earlier} and ${at} both list the subdomain ${JSON.stringify(name)}`);
      }
      listedBy.set(name, at);
    }
    if (list[0] === '*' && i !== routes.length - 1) {
      throw new Error(`${at} is '*', but is not the last entry`);
    }
    if (entry.service !== undefined) {
      return { subdomain: list, service: entry.service };
    }
    return { subdomain: list, paths: resolveRoutePaths(entry.paths, at) };
  });
}

/** An entry's `subdomain`, checked: a list of `'*'` alone, or of distinct hostname labels. */
function resolveRouteSubdomain(value: string | string[], at: string): string[] {
  const field = `${at}.subdomain`;
  const list = Array.isArray(value) ? value : [value];
  return list.map((name, j): string => {
    const where = Array.isArray(value) ? `${field}[${String(j)}]` : field;
    if (name === '*') {
      if (list.length > 1) {
        throw new Error(`${where} is '*' beside other subdomains`);
      }
      return name;
    }
    if (!isRouteSubdomain(name)) {
      throw new Error(`${where} ${JSON.stringify(name)} is not a subdomain`);
    }
    if (list.indexOf(name) !== j) {
      throw new Error(`${field} lists ${JSON.stringify(name)} twice`);
    }
    return name;
  });
}

/** An entry's `paths`, checked: globs that start with `/`, each to a name, in the order written. */
function resolveRoutePaths(value: Record<string, string>, at: string): Record<string, string> {
  const field = `${at}.paths`;
  const globs = Object.keys(value);
  if (globs.length === 0) {
    throw new Error(`${field} is empty`);
  }
  for (const glob of globs) {
    if (!glob.startsWith('/')) {
      throw new Error(`${field}: ${JSON.stringify(glob)} does not start with \`/\``);
    }
  }
  return value;
}

/** Every service `routes` names, with the field that names it, in the order written. */
function routeTargets(routes: ResolvedReverseProxyRoute[]): { field: string; name: string }[] {
  return routes.flatMap((entry, i) => {
    const at = `reverseProxy.routes[${String(i)}]`;
    return entry.service !== undefined
      ? [{ field: `${at}.service`, name: entry.service }]
      : Object.entries(entry.paths).map(([glob, name]) => ({ field: `${at}.paths[${JSON.stringify(glob)}]`, name })); // oxfmt-ignore
  });
}

/**
 * Checks a `publicAddress.domain` — a string, or an array of canonical-then-aliases — and returns
 * it as a list. A Host is routed by which entry it falls under, so the entries must leave no doubt:
 * none may equal another, or be another with labels in front (`a.example.test` beside
 * `example.test`, which would claim each other's hosts). `note` follows each error.
 */
function resolveDomains(value: string | string[], note: string): string[] {
  const at = 'reverseProxy.publicAddress.domain';
  const domains = Array.isArray(value) ? value : [value];
  domains.forEach((entry, i) => {
    if (!HOSTNAME_RE.test(entry)) {
      const field = Array.isArray(value) ? `${at}[${String(i)}]` : at;
      throw new Error(`${field} ${JSON.stringify(entry)} is not a lowercase hostname${note}`);
    }
  });
  domains.forEach((a, i) => {
    domains.forEach((b, j) => {
      if (i >= j) {
        return;
      }
      if (a === b) {
        throw new Error(`${at} lists "${a}" twice (entries ${String(i)} and ${String(j)})${note}`);
      }
      const [inner, outer] = a.endsWith(`.${b}`) ? [a, b] : b.endsWith(`.${a}`) ? [b, a] : [];
      if (inner !== undefined) {
        throw new Error(`${at} entries "${inner}" and "${outer!}" overlap${note}`);
      }
    });
  });
  return domains;
}

/**
 * The parts every address of a service is built on, before its own `publicOrigin`: under the dev
 * reverse proxy, its public address (scheme, canonical domain, port) with the subdomain of the
 * service's route, else none; without one, `http://localhost` on `port` (none for the
 * workspace-wide `urls`, which have no port).
 */
function baseParts(
  proxy: ResolvedReverseProxy | undefined,
  reach: RouteReach | undefined,
  port: number | undefined,
): AddressParts {
  if (proxy === undefined) {
    return { scheme: 'http', subdomain: null, domain: 'localhost', port };
  }
  const { scheme, domain, port: publicPort } = proxy.publicAddress;
  return { scheme, subdomain: reach?.route?.subdomain ?? null, domain, port: publicPort };
}

/**
 * A service's `publicOrigin`, as written or as its callback (over the service's `{ envs, tokens }`)
 * returned it, checked: the parts it gives. `undefined` when the service sets none. `owner` is the
 * service's path in the config, for an error.
 */
function resolvePublicOriginInput(
  input: unknown,
  ctx: () => ConfigContext,
  owner: string,
): Partial<AddressParts> | undefined {
  if (input === undefined) {
    return undefined;
  }
  const at = `${owner}.publicOrigin`;
  const isCallback = typeof input === 'function';
  const note = isCallback ? '\n  (returned by its callback)' : '';
  const value: unknown = isCallback ? (input as (ctx: ConfigContext) => unknown)(ctx()) : input;
  const parts = parseAt(PublicOriginInputSchema, value, at, note);
  checkAddressParts(parts, at, note);
  return parts;
}

/**
 * Settles a service's public origin, and where its `buildAddress` starts: the origin when it has
 * one, else {@link baseParts}.
 *
 * - Its own `publicOrigin` sets the origin: the base parts, each part it gives in place.
 * - Otherwise: the base parts for a service with a route of its own (under the proxy);
 *   `http://localhost:<port>` for an application service no route names, or every service in a
 *   config without a proxy. None for a service with no `port`, for one `routes` reaches only
 *   through `'*'` or `paths` (it has no host to be reached at), and for an infra service with no
 *   route of its own.
 */
function addressesOf(
  proxy: ResolvedReverseProxy | undefined,
  target: {
    kind: ServiceIdentity['kind'];
    port: number | undefined;
    reach: RouteReach;
    override: Partial<AddressParts> | undefined;
    owner: string;
  },
): { publicOrigin: string | undefined; buildAddress: (opts?: BuildAddressOptions) => string } {
  const { port, reach } = target;
  const base = baseParts(proxy, reach, port);
  const origin = ((): AddressParts | undefined => {
    if (target.override !== undefined) {
      return withParts(base, target.override);
    }
    if (port === undefined) {
      return undefined;
    }
    if (reach.route !== null && proxy !== undefined) {
      return base;
    }
    // An infra service is reached at a host of its own or not at all: a database's port is no origin.
    if (reach.routed || target.kind === 'infra') {
      return undefined;
    }
    return { scheme: 'http', subdomain: null, domain: 'localhost', port };
  })();
  return {
    publicOrigin: origin && formatAddress(origin),
    buildAddress: addressBuilder(origin ?? base, target.owner),
  };
}

/** One infra service with the provider that runs it — what routing and validation iterate over. */
export interface InfraServiceEntry {
  provider: string;
  name: string;
  service: ResolvedInfraService;
}

/** Every service the config names, across every provider, in declaration order. */
export function infraServicesOf(config: Pick<Config<string>, 'infra'> | null): InfraServiceEntry[] {
  return Object.entries(config?.infra ?? {}).flatMap(([provider, block]) =>
    Object.entries(servicesOf<ResolvedInfraService>(block)).map(([name, service]) => ({
      provider,
      name,
      service,
    })),
  );
}

/**
 * A provider block's `services`, whichever provider it is — every provider keys its services
 * the same way, which is what lets `port` and `reverseProxy.routes` work for one with no code of
 * its own.
 */
function servicesOf<S>(block: unknown): Record<string, S> {
  return (block as { services?: Record<string, S> } | undefined)?.services ?? {};
}

/**
 * Checks the proxy against the services and services it will route to. Every rule here is a
 * config bug the proxy would otherwise turn into a runtime surprise: a route to nowhere, or two
 * listeners on one port.
 */
function validateReverseProxy(
  proxy: ResolvedReverseProxy,
  packages: AnyServiceConfig[],
  services: InfraServiceEntry[],
) {
  // Every target must listen somewhere. (That each names a service is checked before the
  // services resolve; an infra service's port, as it resolves.)
  for (const { field, name } of routeTargets(proxy.routes)) {
    const target = packages.find((pkg) => pkg.name === name);
    if (target !== undefined && target.port === undefined) {
      throw new Error(`${field} is "${name}", which has no \`port\``);
    }
  }
  for (const pkg of packages) {
    if (pkg.port === proxy.port) {
      throw new Error(
        `reverseProxy.port ${String(proxy.port)} is also ${pkg.name}'s port — the proxy ` +
          "can't listen where a service does. Give one of them a different port.",
      );
    }
  }
  for (const { name, service } of services) {
    if (service.port === proxy.port) {
      throw new Error(
        `reverseProxy.port ${String(proxy.port)} is also infra service "${name}"'s port — the ` +
          "proxy can't listen where a service does. Give one of them a different port.",
      );
    }
  }
}

/**
 * Checks the infra services' `port` on its own, with or without a dev reverse proxy: a service's
 * port on the host is one nothing else in the config may claim — a service listening there too
 * would be shadowed by, or shadow, the service's published port.
 */
function validateInfraServices(services: InfraServiceEntry[], packages: AnyServiceConfig[]) {
  const portOwners = new Map<number, string>();
  for (const pkg of packages) {
    if (pkg.port !== undefined) {
      portOwners.set(pkg.port, `the service ${pkg.name}`);
    }
  }
  for (const { name, service } of services) {
    // A disabled service's port is never resolved, so it has none to check — and claims none.
    if (!service.enabled) {
      continue;
    }
    if (service.port === undefined) {
      continue;
    }
    const owner = portOwners.get(service.port);
    if (owner !== undefined) {
      throw new Error(
        `infra service "${name}" has port ${String(service.port)}, which is also ${owner}'s — ` +
          'two things cannot listen on one port. Give one of them a different port.',
      );
    }
    portOwners.set(service.port, `infra service "${name}"`);
  }
}

/**
 * Every hostname the dev reverse proxy sends to `pkg` whatever the path: the subdomains of each
 * `reverseProxy.routes` `service` entry that names it, in the order written, under the canonical
 * domain. The first is its public origin's host. Empty for a service no such entry names (`'*'`
 * names no host), for one with no `port`, and when the config has no proxy at all.
 */
export function proxyHostsFor(
  config: Pick<Config<string>, 'reverseProxy'> | null,
  pkg: Pick<AnyServiceConfig, 'name' | 'port'>,
): string[] {
  const proxy = config?.reverseProxy;
  if (!proxy || pkg.port === undefined) {
    return [];
  }
  return proxy.routes.flatMap((entry) =>
    entry.service === pkg.name && entry.subdomain[0] !== '*'
      ? entry.subdomain.map((subdomain) => `${subdomain}.${proxy.publicAddress.domain}`)
      : [],
  );
}

export function defineConfig<
  const Top extends TokenRecord,
  P extends Record<string, unknown>,
  K extends string = Extract<keyof P, string>,
  RootDir extends string | undefined = undefined,
  I extends string = never,
>(
  // The second member infers the infra services' names `I` from their keys alone, as `services`'
  // `Record<K, unknown>` infers the service names, for `reverseProxy.routes` to name.
  opts: DefineConfigOptions<Top, P, K, RootDir, I> & { infra?: { 'docker-compose'?: true | { services?: Record<I, unknown> } } }, // oxfmt-ignore
): Config<K, P, Top, I> {
  const result = v.safeParse(DefineConfigSchema, opts);
  if (!result.success) {
    throw new Error(formatConfigError(result.issues));
  }
  const parsed = result.output;

  const workspaceDir = parsed.workspaceDir ?? recordedConfigDir() ?? process.cwd();
  workspaceRoot = path.resolve(workspaceDir);

  // The key IS the service name. Everything downstream works on an array, so flatten here.
  const parsedPackages = Object.entries(parsed.services).map(([name, config]) => ({
    ...config,
    name,
  }));

  // JavaScript enumerates integer-like keys first, in ascending numeric order, regardless of
  // where they were written — which would silently reorder startup and the TUI. Reject them
  // rather than surprise anyone with a service that jumps the queue.
  for (const { name } of parsedPackages) {
    if (/^(0|[1-9]\d*)$/.test(name)) {
      throw new Error(
        `service name "${name}" is a number — object keys that look like integers are reordered ` +
          'by JavaScript, which would change the order services start in. Use a non-numeric name.',
      );
    }
  }

  // `deps` names are type-checked against the service keys, so a bad name is normally a compile
  // error. Re-checked here for configs that reach `defineConfig` unchecked (plain JS, a
  // `satisfies`-free dynamic build) and to enforce the healthcheck rule types can't express.
  const healthcheckPackages = new Set(parsedPackages.filter((c) => c.healthcheck).map((c) => c.name)); // oxfmt-ignore
  const allNames = new Set(parsedPackages.map((c) => c.name));
  /** A service's `deps` entries, as the array form lists them or its callback returns them, checked. */
  const resolveDepEntries = (name: string, entries: unknown): ResolvedDep[] => {
    if (!Array.isArray(entries)) {
      throw new Error(`${name}: the \`deps\` callback returned ${String(entries)}, not an array`);
    }
    return entries.map((entry: unknown, i): ResolvedDep => {
      const e = parseAt(DepEntrySchema, entry, `services.${name}.deps.${String(i)}`);
      const dep = typeof e === 'string' ? { service: e, wait: false } : { service: e.service, wait: e.wait ?? false }; // oxfmt-ignore
      if (!allNames.has(dep.service)) {
        throw new Error(`${name} has deps "${dep.service}" but no such service exists`); // oxfmt-ignore
      }
      if (dep.wait && !healthcheckPackages.has(dep.service)) {
        throw new Error(
          `${name} waits for "${dep.service}" (deps), but that service has no ` +
            '`healthcheck` to wait on. Add one to it, or drop `wait`.',
        );
      }
      return dep;
    });
  };
  /** A service's resolved `deps`: its array, or what its callback returns for this session. */
  const resolveDeps = (
    name: string,
    deps: DepInput[] | DepsResolver | undefined,
    ctx: () => DepsContext,
  ): ResolvedDep[] | undefined => {
    if (typeof deps !== 'function') {
      return deps && resolveDepEntries(name, deps);
    }
    let entries: unknown;
    try {
      entries = deps(ctx());
    } catch (err) {
      throw new Error(`${name}: the \`deps\` callback threw: ${err instanceof Error ? err.message : String(err)}`, { cause: err }); // oxfmt-ignore
    }
    return resolveDepEntries(name, entries);
  };
  // The array form is checked now; a callback runs with the service's context, below.
  for (const config of parsedPackages) {
    if (Array.isArray(config.deps)) {
      resolveDepEntries(config.name, config.deps);
    }
  }

  // Every infra service's name, whichever provider runs it. A route, `deps` and every message
  // name a service by its key alone, so an application service and an infra service sharing one
  // could not be told apart: a config bug in every mode, routed or not.
  const infraNames = Object.values(parsed.infra ?? {}).flatMap((block) =>
    Object.keys(servicesOf<ParsedInfraService>(block)),
  );
  for (const name of infraNames) {
    if (allNames.has(name)) {
      throw new Error(`"${name}" is both a service and an infra service`);
    }
  }

  const tokens = parsed.tokens ?? {};

  const envFiles = envFileOrder(
    currentMode(),
    resolveAdditionalFiles(parsed.env?.additionalFiles, currentMode()),
  );
  const envOverride = parsed.env?.override;
  const envDecrypt = parsed.env?.decrypt ?? false;

  const baseEnv = () => baseEnvs(workspaceRoot);

  // Every `.env` file a callback may read, read as the first one does: see `configEnvReader`.
  const envReader = once(() =>
    configEnvReader([
      ...new Set(
        [
          '.',
          ...parsedPackages.flatMap((config) => {
            try {
              return [
                config.relativeDir ?? inferredRelativeDir(parsed.serviceRootDir, config.name),
              ];
            } catch {
              return []; // reported as the service resolves
            }
          }),
        ].flatMap((relativeDir) =>
          envCandidatePaths({ cwd: workspaceDir, relativeDir, files: envFiles }),
        ),
      ),
      ...(envDecrypt ? [envKeysFile(workspaceDir)] : []),
    ]),
  );
  const loadEnv = (relativeDir: string, vars?: Record<string, string>) =>
    once(() =>
      resolveEnvFrom(
        {
          cwd: workspaceDir,
          relativeDir,
          files: envFiles,
          override: envOverride,
          decrypt: envDecrypt,
          vars,
        },
        envReader(),
      ),
    );

  // The config's own variables come first: every callback below finds them in its `envs`. Their
  // callback sees the workspace environment as it resolves without them.
  const workspaceFiles = loadEnv('.');
  const envVars = resolveEnvVars(
    parsed.env?.vars,
    () => ({ envs: Object.assign(baseEnv(), workspaceFiles().env), tokens }),
    () => workspaceFiles().files,
  );

  /**
   * The environment a callback sees: a scope's `.env` files, with the config's own variables
   * ranked as a file below them, merged over `process.env`.
   */
  const envsFor = (relativeDir: string) => {
    const load = loadEnv(relativeDir, envVars);
    return {
      envs: once(() => Object.assign(baseEnv(), load().env)),
      files: () => load().files,
    };
  };

  // Workspace-wide urls belong to no service: workspace-scope env, and no `port` to offer.
  const workspaceEnv = envsFor('.');
  const workspaceBase = once((): ConfigContext => ({ envs: workspaceEnv.envs(), tokens }));

  // The dev reverse proxy sees the workspace context, like the workspace-wide urls. Resolved
  // before the services, since a service's public origin — what its path urls are based on —
  // depends on it; validated after them, since that needs their *resolved* ports.
  const reverseProxy =
    parsed.reverseProxy &&
    resolveReverseProxy(parsed.reverseProxy, workspaceBase, workspaceEnv.files);
  // Every route names a service or an infra service: checked before either resolves, since a
  // service's route decides its public origin. (Types catch a misspelled name too, for a config
  // they can see.)
  for (const { field, name } of routeTargets(reverseProxy?.routes ?? [])) {
    if (!allNames.has(name) && !infraNames.includes(name)) {
      throw new Error(`${field} is "${name}", but no service or infra service is named that`);
    }
  }

  const packages = parsedPackages.map((config) => {
    const relativeDir = config.relativeDir ?? inferredRelativeDir(parsed.serviceRootDir, config.name); // oxfmt-ignore
    const env = envsFor(relativeDir);
    // The service's own tokens win over the config's, so a service can override a shared value.
    const pkgTokens = config.tokens ? { ...tokens, ...config.tokens } : tokens;
    const baseCtx = once((): ConfigContext => ({ envs: env.envs(), tokens: pkgTokens }));
    const identity: ServiceIdentity = { name: config.name, kind: 'service' };
    // Resolved first so the `healthcheck`/`urls` callbacks below can read it, and stored on the
    // resolved service so nothing downstream ever encounters a callback.
    const port = resolvePort(config, () => ({ ...baseCtx(), service: identity }), env.files);
    const reach = reachOf(reverseProxy, config.name);
    // What this service's relative URLs resolve against: its port on loopback, and its public
    // origin. `urls` show the public form, the `healthcheck` probes the private one (see
    // `ResolvedUrlForms`).
    const { publicOrigin, buildAddress } = addressesOf(reverseProxy, {
      kind: 'service',
      port,
      reach,
      override: resolvePublicOriginInput(config.publicOrigin, baseCtx, `services.${config.name}`),
      owner: `services.${config.name}`,
    });
    const ctx = once((): ServiceContext =>
      packageContext(
        baseCtx(),
        { ...identity, port, route: reach.route, publicOrigin },
        buildAddress,
        () =>
          `${config.name}: a callback read \`port\`, but this service declares no \`port\`. ` +
          `Add \`port\` to ${config.name} in stackctl.config.ts, or drop \`port\` from the callback.`,
      ),
    );
    const noPublicOrigin = reach.routed && publicOrigin === undefined;
    const scope = (where: string): UrlScope => ({ ctx, port, publicOrigin, where, noPublicOrigin });
    return {
      ...config,
      deps: resolveDeps(config.name, config.deps, () => ({ ...baseCtx(), mode: currentMode() })),
      // Stored resolved (config tokens + this service's own) so the exported config exposes
      // each service's tokens: `config.services.api.tokens`.
      tokens: pkgTokens,
      port,
      relativeDir,
      absoluteDir: path.resolve(workspaceDir, relativeDir),
      urls: resolveUrls(config.urls, scope(`${config.name} urls`)),
      healthcheck:
        config.healthcheck === undefined
          ? undefined
          : resolveHealthcheck(config.healthcheck, scope(`${config.name} healthcheck`)),
      // The same value the service's process gets as `PUBLIC_ORIGIN`, on the exported config.
      publicOrigin,
    };
  });

  // A workspace-wide `urls` callback is typed over `WorkspaceUrlsContext`; the throwing `port` is
  // only for a plain-JS config that reads it anyway. Its `buildAddress` starts from the proxy's
  // public address, at the bare domain.
  const workspaceCtx = once((): ServiceContext =>
    packageContext(
      workspaceBase(),
      undefined,
      addressBuilder(baseParts(reverseProxy, undefined, undefined), 'urls'),
      () =>
        'a workspace-wide `urls` callback read `port`, but those links belong to no service, so ' +
        "there's no port to give them. Move the link into a service's `urls`, or drop `port`.",
    ),
  );
  const urls = resolveUrls(parsed.urls, {
    ctx: workspaceCtx,
    port: undefined,
    publicOrigin: undefined,
    where: 'top-level url',
  });

  // The project name and each service's `enabled` and `port` are settled here, from the
  // workspace environment; the callbacks stay as written, to run when an `infra` command does.
  const resolveServices = (services: Record<string, ParsedInfraService> | undefined) =>
    Object.fromEntries(
      Object.entries(services ?? {}).map(([name, service]) => [
        name,
        resolveInfraService(name, service, {
          reverseProxy,
          ctx: workspaceBase,
          mode: currentMode(),
          envFilesLoaded: workspaceEnv.files,
        }),
      ]),
    );
  const compose = parsed.infra?.['docker-compose'];
  const infra: ResolvedInfra | undefined = compose && {
    'docker-compose': {
      file: compose.file === undefined ? undefined : path.resolve(workspaceDir, compose.file),
      projectName: composeProjectName({
        envs: workspaceEnv.envs(),
        workspaceDir,
        mode: currentMode(),
      }),
      readyTimeout: compose.readyTimeout ?? DEFAULT_READY_TIMEOUT_MS,
      services: resolveServices(compose.services),
    },
  };

  // Now that every service's and service's port is known, check them against each other and the
  // proxy against them all. (stackctl adds no footer link of its own: `urls` holds exactly what
  // the config lists — `'/'` or `''` there is how a service shows its public origin.)
  const services = infraServicesOf({ infra });
  validateInfraServices(services, packages);
  if (reverseProxy) {
    validateReverseProxy(reverseProxy, packages, services);
  }

  const resolved: Config<string> = {
    apiPort: parsed.apiPort,
    serviceRootDir: parsed.serviceRootDir,
    // Back to a record, keyed by name, preserving the declaration order of the keys.
    services: Object.fromEntries(packages.map((pkg) => [pkg.name, pkg])),
    urls,
    reverseProxy,
    infra,
    envFiles,
    envMode: currentMode(),
    envOverride,
    envDecrypt,
    envVars,
    logTimestamps: parsed.logs?.timestamps ?? true,
  };
  registeredPackages = packages;
  loadedConfig = resolved;
  loadedTokens = tokens;
  // The runtime shape is identical; only the key/token types are sharper for the caller.
  return resolved as unknown as Config<K, P, Top, I>;
}
