import * as v from 'valibot';
import type {
  ConfigContext,
  DepInput,
  DepsResolver,
  EnvAdditionalFilesResolver,
  EnvVars,
  EnvVarsResolver,
  PortResolver,
  PublicAddress,
  PublicOriginInput,
  ReverseProxyTls,
  UrlResolver,
  UrlsResolver,
} from './config.js';

// The valibot schemas: the config's shape, defaults and validation. They hold no docs. The types a
// config is written against — `ServiceConfigInput` and `DefineConfigOptions` in config.ts — are
// declared by hand, because they carry what a schema can't: the service names `deps` may list, and each callback's context typed from the config's own `tokens`. Every field's JSDoc
// lives there. `config.test-d.ts` checks that those types and these schemas accept the same
// fields, so one can't change without the other.

/**
 * A callback: only checked to be a function, and passed through untouched, so the exact user
 * callback (not a validating wrapper) reaches the runtime. Typed as `T`, its real signature.
 */
const callback = <T extends (...args: never[]) => unknown>() =>
  v.function() as unknown as v.GenericSchema<T>;

/** A number, `Infinity` and `NaN` excluded. */
const finiteNumber = () => v.pipe(v.number(), v.finite());

/** A string of at least one character. */
const nonEmptyString = () => v.pipe(v.string(), v.minLength(1));

// A URL anywhere in the config: a literal string, or a callback stackctl invokes once at load
// time with the service's context (`{ envs, tokens, port, service }`). `defineConfig` resolves
// every callback to a string before anything downstream sees it.
export const UrlValueSchema = v.union([v.string(), callback<UrlResolver>()]);

export const UrlLinkSchema = v.union([
  UrlValueSchema,
  v.strictObject({ label: v.string(), url: UrlValueSchema }),
]);
export const UrlEntrySchema = v.union([UrlLinkSchema, v.array(UrlLinkSchema)]);
// A `urls` field: the list of entries, or a callback returning it.
export const UrlsSchema = v.union([v.array(UrlEntrySchema), callback<UrlsResolver>()]);

/** How long a healthcheck probe may take before it's aborted, when the service doesn't say. */
export const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 1500;

// A `healthcheck`: the URL on its own (string or callback), or an object adding `timeout`.
// Strict so a misspelled `timout` fails at load rather than silently leaving the default in
// place. `defineConfig` normalizes every form to `{ url: string; timeout: number }` before
// anything downstream sees it.
export const HealthcheckSchema = v.union([
  UrlValueSchema,
  v.strictObject({
    url: UrlValueSchema,
    timeout: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0))),
  }),
]);

// `command` options.
export const CommandOptionsSchema = v.strictObject({
  watches: v.optional(v.boolean()),
});

export const CommandSchema = v.pipe(
  // `null` = the service has no dev process; stackctl never starts it.
  v.optional(v.union([v.string(), v.strictTuple([v.string(), CommandOptionsSchema]), v.null()]), 'dev'), // oxfmt-ignore
  v.transform((c) =>
    c === null
      ? null
      : typeof c === 'string'
        ? { name: c, watches: true }
        : { name: c[0], watches: c[1].watches ?? true },
  ),
);

// A `port`: a literal, or a callback `defineConfig` resolves to a number before anything
// downstream sees it.
const PortSchema = v.union([finiteNumber(), callback<PortResolver>()]);

// The scheme and port of a public address, an origin, or a `buildAddress` URL.
const SchemeSchema = v.picklist(['https', 'http']);
const AddressPortSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535));

// The parts of a `publicOrigin` to set, as written or as its callback returns them. A subdomain's
// and a domain's hostname labels are checked in `defineConfig`.
export const PublicOriginInputSchema = v.strictObject({
  scheme: v.optional(SchemeSchema),
  subdomain: v.optional(v.nullable(v.string())),
  domain: v.optional(v.string()),
  port: v.optional(AddressPortSchema),
});

// What `buildAddress` takes: the parts of an origin, and a path.
export const BuildAddressOptionsSchema = v.strictObject({
  ...PublicOriginInputSchema.entries,
  path: v.optional(v.string()),
});

// A `publicOrigin`: the parts to set, or a callback `defineConfig` resolves to them, and checks
// against `PublicOriginInputSchema`, while the config loads.
const PublicOriginSchema = v.union([
  PublicOriginInputSchema,
  callback<(ctx: ConfigContext) => PublicOriginInput>(),
]);

// One `deps` entry: a service's name, or `{ service, wait }`.
export const DepEntrySchema = v.union([
  v.string(),
  v.strictObject({ service: v.string(), wait: v.optional(v.boolean()) }),
]);

// All per-service config is flat (no `run` nesting). The service's *name* is the key it's
// declared under in `services` (injected by `defineConfig` after parsing), so it isn't a field
// here; the rest describe how to run/select/link it. Strict, so a misspelled key fails at load
// rather than being stripped.
export const ServiceConfigSchema = v.strictObject({
  relativeDir: v.optional(v.string()),
  selectable: v.optional(v.boolean()),
  color: v.optional(v.string()),
  // Must be parsed, not stripped — it's what a callback's `tokens` is built from.
  tokens: v.optional(v.record(v.string(), v.optional(v.string()))),
  // `defineConfig` resolves a callback to a number before anything downstream sees it, so the
  // *resolved* type is still `number | undefined`.
  port: v.optional(PortSchema),
  command: CommandSchema,
  autostart: v.optional(v.boolean()),
  // Both resolved to plain strings by `defineConfig`.
  urls: v.optional(UrlsSchema),
  healthcheck: v.optional(HealthcheckSchema),
  // Resolved to the origin it gives by `defineConfig`.
  publicOrigin: v.optional(PublicOriginSchema),
  // A list, or a callback `defineConfig` resolves to one before anything downstream sees it.
  // Each entry is checked against `DepEntrySchema` then, whichever form produced it.
  deps: v.optional(
    v.union([v.array(v.unknown()), callback<DepsResolver>()]) as v.GenericSchema<
      DepInput[] | DepsResolver
    >,
  ),
  logs: v.optional(
    v.strictObject({
      timestamps: v.optional(v.boolean()),
      formatter: v.optional(callback<(line: string) => string>()),
    }),
  ),
});

// `reverseProxy.publicAddress`, as written or as its callback returns it. Its domains' hostname
// labels are checked in `defineConfig`.
export const PublicAddressSchema = v.strictObject({
  domain: v.union([v.string(), v.pipe(v.array(v.string()), v.minLength(1))]),
  scheme: SchemeSchema,
  port: v.optional(AddressPortSchema),
});

// `reverseProxy.tls`, as written or as its callback returns it.
export const ReverseProxyTlsSchema = v.union([
  v.boolean(),
  v.strictObject({ key: nonEmptyString(), cert: nonEmptyString() }),
]);

const RouteSubdomainSchema = v.union([v.string(), v.pipe(v.array(v.string()), v.minLength(1))]);

// One `reverseProxy.routes` entry: `{ subdomain, service }` or `{ subdomain, paths }`. Its
// subdomains, its globs and the services it names are checked in `defineConfig`.
export const ReverseProxyRouteSchema = v.union([
  v.strictObject({
    subdomain: RouteSubdomainSchema,
    service: nonEmptyString(),
    paths: v.optional(v.never()),
  }),
  v.strictObject({
    subdomain: RouteSubdomainSchema,
    // Any string key passes here: a glob's leading `/` is checked in `defineConfig`. Typed by
    // hand, since valibot types a record keyed by a template literal as partial.
    paths: v.record(v.string(), nonEmptyString()) as v.GenericSchema<Record<`/${string}`, string>>,
    service: v.optional(v.never()),
  }),
]);

// The built-in dev reverse proxy. Strict, so a misspelled field fails at load. `defineConfig`
// resolves the `port`, `publicAddress` and `tls` callbacks, and checks what they return against
// the schemas above, before anything downstream sees them.
export const ReverseProxySchema = v.strictObject({
  port: v.union([finiteNumber(), callback<(ctx: ConfigContext) => number>()]),
  publicAddress: v.optional(
    v.union([PublicAddressSchema, callback<(ctx: ConfigContext) => PublicAddress>()]),
  ),
  routes: v.optional(v.array(ReverseProxyRouteSchema)),
  tls: v.optional(
    v.union([ReverseProxyTlsSchema, callback<(ctx: ConfigContext) => ReverseProxyTls>()]),
  ),
});

// One callback an infra service can attach. Its real signature is in infra/types.ts.
const infraCallback = () => v.optional(callback<(...args: never[]) => unknown>());

// Strict throughout: a misspelled callback (`onReady`) must be an error, not a silently ignored key.
export const InfraServiceSchema = v.strictObject({
  // A literal, or a callback `defineConfig` resolves to a boolean while the config loads.
  enabled: v.optional(v.union([v.boolean(), callback<(...args: never[]) => unknown>()])),
  // The service's port on the host. Here, not on a provider's options, so every provider has it.
  port: v.optional(PortSchema),
  // The service's footer links, and its public origin, as for a service.
  urls: v.optional(UrlsSchema),
  publicOrigin: v.optional(PublicOriginSchema),
  beforeDestroy: infraCallback(),
  afterDestroy: infraCallback(),
  beforeStart: infraCallback(),
  afterReady: infraCallback(),
});

export const DockerComposeInfraSchema = v.strictObject({
  file: v.optional(nonEmptyString()),
  readyTimeout: v.optional(v.pipe(finiteNumber(), v.gtValue(0))),
  services: v.optional(v.record(nonEmptyString(), InfraServiceSchema)),
});

// Keyed by provider.
export const InfraSchema = v.pipe(
  v.strictObject({
    // `true` is shorthand for a provider with nothing to configure: `{}`.
    'docker-compose': v.optional(
      v.pipe(
        v.union([v.literal(true), DockerComposeInfraSchema]),
        v.transform((provider) => (provider === true ? {} : provider)),
      ),
    ),
  }),
  v.check(
    (infra) => Object.values(infra).some((provider) => provider !== undefined),
    'infra must name a provider',
  ),
);

const EnvFileAnchorSchema = v.picklist(['base', 'local', 'profile', 'profileLocal']);
const EnvFileScopeSchema = v.picklist(['workspace', 'service']);

// One `env.additionalFiles` entry, as written or as the callback returns it: `{ file, before }` or
// `{ file, after }`. That `file` is a name, not a path, and that no two entries name one file, is
// checked in `defineConfig`.
export const EnvAdditionalFileSchema = v.union([
  v.strictObject({
    file: nonEmptyString(),
    before: EnvFileAnchorSchema,
    after: v.optional(v.never()),
    scope: v.optional(EnvFileScopeSchema),
  }),
  v.strictObject({
    file: nonEmptyString(),
    after: EnvFileAnchorSchema,
    before: v.optional(v.never()),
    scope: v.optional(EnvFileScopeSchema),
  }),
]);

// The `env` options. Strict, so a misspelled option fails at load.
const EnvOptionsSchema = v.strictObject({
  // The values are checked where a callback's result is, in `defineConfig`, so a bad one
  // is reported the same way — by variable name — whichever form declared it. So is that the
  // record is a plain object, an array not.
  vars: v.optional(
    v.union([v.record(v.string(), v.unknown()), callback<EnvVarsResolver>()]) as v.GenericSchema<
      EnvVars | EnvVarsResolver
    >,
  ),
  override: v.optional(v.union([v.boolean(), v.array(v.string())])),
  // A callback's result is checked against `EnvAdditionalFileSchema` in `defineConfig`.
  additionalFiles: v.optional(
    v.union([v.array(EnvAdditionalFileSchema), callback<EnvAdditionalFilesResolver>()]),
  ),
  decrypt: v.optional(v.boolean()),
});

export const DefineConfigSchema = v.strictObject({
  apiPort: v.optional(finiteNumber()),
  // Keyed by service name; the key becomes the service's `name`.
  services: v.record(nonEmptyString(), ServiceConfigSchema),
  serviceRootDir: v.optional(v.string()),
  urls: v.optional(UrlsSchema),
  reverseProxy: v.optional(ReverseProxySchema),
  infra: v.optional(InfraSchema),
  workspaceDir: v.optional(v.string()),
  tokens: v.optional(v.record(v.string(), v.optional(v.string()))),
  env: v.optional(
    v.pipe(
      // The callback on its own is shorthand for `{ vars: callback }`.
      v.union([callback<EnvVarsResolver>(), EnvOptionsSchema]),
      v.transform((env) => (typeof env === 'function' ? { vars: env } : env)),
    ),
  ),
  logs: v.optional(v.strictObject({ timestamps: v.optional(v.boolean()) })),
});
