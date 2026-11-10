import { z } from 'zod';
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

// The Zod schemas: the config's shape, defaults and validation. They hold no docs. The types a
// config is written against — `ServiceConfigInput` and `DefineConfigOptions` in config.ts — are
// declared by hand, because they carry what a schema can't: the service names `deps` may list, and each callback's context typed from the config's own `tokens`. Every field's JSDoc
// lives there. `config.test-d.ts` checks that those types and these schemas accept the same
// fields, so one can't change without the other.

// A URL anywhere in the config: a literal string, or a callback stackctl invokes once at load
// time with the service's context (`{ envs, tokens, port, service }`). `defineConfig` resolves
// every callback to a string before anything downstream sees it.
export const UrlValueSchema = z.union([
  z.string(),
  z.custom<UrlResolver>((v) => typeof v === 'function'),
]);

export const UrlLinkSchema = z.union([
  UrlValueSchema,
  z.strictObject({ label: z.string(), url: UrlValueSchema }),
]);
export const UrlEntrySchema = z.union([UrlLinkSchema, z.array(UrlLinkSchema)]);
// A `urls` field: the list of entries, or a callback returning it.
export const UrlsSchema = z.union([
  z.array(UrlEntrySchema),
  z.custom<UrlsResolver>((v) => typeof v === 'function'),
]);

/** How long a healthcheck probe may take before it's aborted, when the service doesn't say. */
export const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 1500;

// A `healthcheck`: the URL on its own (string or callback), or an object adding `timeout`.
// Strict so a misspelled `timout` fails at load rather than silently leaving the default in
// place. `defineConfig` normalizes every form to `{ url: string; timeout: number }` before
// anything downstream sees it.
export const HealthcheckSchema = z.union([
  UrlValueSchema,
  z.strictObject({
    url: UrlValueSchema,
    timeout: z.number().int().positive().optional(),
  }),
]);

// `command` options.
export const CommandOptionsSchema = z.strictObject({
  watches: z.boolean().optional(),
});

export const CommandSchema = z
  // `null` = the service has no dev process; stackctl never starts it.
  .union([z.string(), z.tuple([z.string(), CommandOptionsSchema]), z.null()])
  .default('dev')
  .transform((c) =>
    c === null
      ? null
      : typeof c === 'string'
        ? { name: c, watches: true }
        : { name: c[0], watches: c[1].watches ?? true },
  );

// A `port`: a literal, or a callback `defineConfig` resolves to a number before anything
// downstream sees it.
const PortSchema = z.union([z.number(), z.custom<PortResolver>((v) => typeof v === 'function')]);

// The scheme and port of a public address, an origin, or a `buildAddress` URL.
const SchemeSchema = z.enum(['https', 'http']);
const AddressPortSchema = z.int().min(1).max(65535);

// The parts of a `publicOrigin` to set, as written or as its callback returns them. A subdomain's
// and a domain's hostname labels are checked in `defineConfig`.
export const PublicOriginInputSchema = z.strictObject({
  scheme: SchemeSchema.optional(),
  subdomain: z.string().nullable().optional(),
  domain: z.string().optional(),
  port: AddressPortSchema.optional(),
});

// What `buildAddress` takes: the parts of an origin, and a path.
export const BuildAddressOptionsSchema = z.strictObject({
  ...PublicOriginInputSchema.shape,
  path: z.string().optional(),
});

// A `publicOrigin`: the parts to set, or a callback `defineConfig` resolves to them, and checks
// against `PublicOriginInputSchema`, while the config loads.
const PublicOriginSchema = z.union([
  PublicOriginInputSchema,
  z.custom<(ctx: ConfigContext) => PublicOriginInput>((v) => typeof v === 'function'),
]);

// One `deps` entry: a service's name, or `{ service, wait }`.
export const DepEntrySchema = z.union([
  z.string(),
  z.strictObject({ service: z.string(), wait: z.boolean().optional() }),
]);

// All per-service config is flat (no `run` nesting). The service's *name* is the key it's
// declared under in `services` (injected by `defineConfig` after parsing), so it isn't a field
// here; the rest describe how to run/select/link it. Strict, so a misspelled key fails at load
// rather than being stripped.
export const ServiceConfigSchema = z.strictObject({
  relativeDir: z.string().optional(),
  selectable: z.boolean().optional(),
  color: z.string().optional(),
  // Must be parsed, not stripped — it's what a callback's `tokens` is built from.
  tokens: z.record(z.string(), z.string().optional()).optional(),
  // `defineConfig` resolves a callback to a number before anything downstream sees it, so the
  // *resolved* type is still `number | undefined`.
  port: PortSchema.optional(),
  command: CommandSchema,
  autostart: z.boolean().optional(),
  // Both resolved to plain strings by `defineConfig`.
  urls: UrlsSchema.optional(),
  healthcheck: HealthcheckSchema.optional(),
  // Resolved to the origin it gives by `defineConfig`.
  publicOrigin: PublicOriginSchema.optional(),
  // A list, or a callback `defineConfig` resolves to one before anything downstream sees it.
  // Each entry is checked against `DepEntrySchema` then, whichever form produced it.
  deps: z
    .custom<DepInput[] | DepsResolver>((v) => Array.isArray(v) || typeof v === 'function')
    .optional(),
  // `z.custom` validates `formatter` is a function and passes it through untouched, so the exact
  // user callback (not a validating wrapper) reaches the runtime.
  logs: z
    .strictObject({
      timestamps: z.boolean().optional(),
      formatter: z.custom<(line: string) => string>((v) => typeof v === 'function').optional(),
    })
    .optional(),
});

// `reverseProxy.publicAddress`, as written or as its callback returns it. Its domains' hostname
// labels are checked in `defineConfig`.
export const PublicAddressSchema = z.strictObject({
  domain: z.union([z.string(), z.array(z.string()).min(1)]),
  scheme: SchemeSchema,
  port: AddressPortSchema.optional(),
});

// `reverseProxy.tls`, as written or as its callback returns it.
export const ReverseProxyTlsSchema = z.union([
  z.boolean(),
  z.strictObject({ key: z.string().min(1), cert: z.string().min(1) }),
]);

const RouteSubdomainSchema = z.union([z.string(), z.array(z.string()).min(1)]);

// One `reverseProxy.routes` entry: `{ subdomain, service }` or `{ subdomain, paths }`. Its
// subdomains, its globs and the services it names are checked in `defineConfig`.
export const ReverseProxyRouteSchema = z.union([
  z.strictObject({
    subdomain: RouteSubdomainSchema,
    service: z.string().min(1),
    paths: z.never().optional(),
  }),
  z.strictObject({
    subdomain: RouteSubdomainSchema,
    // Any string key passes here: a glob's leading `/` is checked in `defineConfig`.
    paths: z.record(
      z.custom<`/${string}`>((key) => typeof key === 'string'),
      z.string().min(1),
    ),
    service: z.never().optional(),
  }),
]);

// The built-in dev reverse proxy. Strict, so a misspelled field fails at load. `defineConfig`
// resolves the `port`, `publicAddress` and `tls` callbacks, and checks what they return against
// the schemas above, before anything downstream sees them.
export const ReverseProxySchema = z.strictObject({
  port: z.union([z.number(), z.custom<(ctx: ConfigContext) => number>((v) => typeof v === 'function')]), // oxfmt-ignore
  publicAddress: z
    .union([
      PublicAddressSchema,
      z.custom<(ctx: ConfigContext) => PublicAddress>((v) => typeof v === 'function'),
    ])
    .optional(),
  routes: z.array(ReverseProxyRouteSchema).optional(),
  tls: z
    .union([
      ReverseProxyTlsSchema,
      z.custom<(ctx: ConfigContext) => ReverseProxyTls>((v) => typeof v === 'function'),
    ])
    .optional(),
});

// One callback an infra service can attach. Zod only checks it's a function and passes it
// through untouched; its real signature is in infra/types.ts.
const infraCallback = () =>
  z.custom<(...args: never[]) => unknown>((v) => typeof v === 'function').optional();

// Strict throughout: a misspelled callback (`onReady`) must be an error, not a silently ignored key.
export const InfraServiceSchema = z.strictObject({
  // A literal, or a callback `defineConfig` resolves to a boolean while the config loads.
  enabled: z
    .union([z.boolean(), z.custom<(...args: never[]) => unknown>((v) => typeof v === 'function')])
    .optional(),
  // The service's port on the host. Here, not on a provider's options, so every provider has it.
  port: PortSchema.optional(),
  // The service's footer links, and its public origin, as for a service.
  urls: UrlsSchema.optional(),
  publicOrigin: PublicOriginSchema.optional(),
  beforeDestroy: infraCallback(),
  afterDestroy: infraCallback(),
  beforeUp: infraCallback(),
  afterReady: infraCallback(),
});

export const DockerComposeInfraSchema = z.strictObject({
  file: z.string().min(1).optional(),
  readyTimeout: z.number().positive().optional(),
  services: z.record(z.string().min(1), InfraServiceSchema).optional(),
});

// Keyed by provider.
export const InfraSchema = z
  // `true` is shorthand for a provider with nothing to configure: `{}`. Rewritten before the
  // object schema sees it rather than offered as a union alternative, because a union reports a
  // mistake inside the block as a bare "Invalid input" — losing the field's path and message.
  // The parameter's type is what the schema's input type says it accepts.
  .strictObject({
    'docker-compose': z
      .preprocess(
        (value: true | z.input<typeof DockerComposeInfraSchema>) => (value === true ? {} : value),
        DockerComposeInfraSchema,
      )
      .optional(),
  })
  .refine((infra) => Object.values(infra).some((provider) => provider !== undefined), {
    message: 'infra must name a provider',
  });

const EnvFileAnchorSchema = z.enum(['base', 'local', 'mode', 'modeLocal']);
const EnvFileScopeSchema = z.enum(['workspace', 'service']);

// One `env.additionalFiles` entry, as written or as the callback returns it: `{ file, before }` or
// `{ file, after }`. That `file` is a name, not a path, and that no two entries name one file, is
// checked in `defineConfig`.
export const EnvAdditionalFileSchema = z.union([
  z.strictObject({
    file: z.string().min(1),
    before: EnvFileAnchorSchema,
    after: z.never().optional(),
    scope: EnvFileScopeSchema.optional(),
  }),
  z.strictObject({
    file: z.string().min(1),
    after: EnvFileAnchorSchema,
    before: z.never().optional(),
    scope: EnvFileScopeSchema.optional(),
  }),
]);

// The `env` options. Strict, so a misspelled option fails at load.
const EnvOptionsSchema = z.strictObject({
  // The values are checked where a callback's result is, in `defineConfig`, so a bad one
  // is reported the same way — by variable name — whichever form declared it.
  vars: z
    .custom<EnvVars | EnvVarsResolver>(
      (v) => typeof v === 'function' || (typeof v === 'object' && v !== null && !Array.isArray(v)), // oxfmt-ignore
    )
    .optional(),
  override: z.union([z.boolean(), z.array(z.string())]).optional(),
  // A callback's result is checked against `EnvAdditionalFileSchema` in `defineConfig`.
  additionalFiles: z
    .union([
      z.array(EnvAdditionalFileSchema),
      z.custom<EnvAdditionalFilesResolver>((v) => typeof v === 'function'),
    ])
    .optional(),
});

export const DefineConfigSchema = z.strictObject({
  apiPort: z.number().optional(),
  // Keyed by service name; the key becomes the service's `name`.
  services: z.record(z.string().min(1), ServiceConfigSchema),
  serviceRootDir: z.string().optional(),
  urls: UrlsSchema.optional(),
  reverseProxy: ReverseProxySchema.optional(),
  infra: InfraSchema.optional(),
  workspaceDir: z.string().optional(),
  tokens: z.record(z.string(), z.string().optional()).optional(),
  env: z
    .preprocess(
      // The callback on its own is shorthand for `{ vars: callback }`. The parameter's type is
      // what the schema's input type says it accepts.
      (value: EnvVarsResolver | z.input<typeof EnvOptionsSchema>) =>
        typeof value === 'function' ? { vars: value } : value,
      EnvOptionsSchema,
    )
    .optional(),
  logs: z.strictObject({ timestamps: z.boolean().optional() }).optional(),
});
