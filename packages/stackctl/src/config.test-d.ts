/**
 * Type-level tests for `defineConfig`'s inference. Run with `pnpm test:types`.
 *
 * These assert **specific types**, not merely "this line errors" — a `@ts-expect-error` passes
 * for any reason at all, which once hid a bug here (a token-typo assertion was passing only
 * because the value was `string | undefined`, not because the key was unknown).
 *
 * `expectTypeOf` is erased at runtime, so the surrounding `defineConfig` calls still execute;
 * that's deliberate, since it keeps the assertions on the real inference path. Note the
 * type-only form `expectTypeOf<(typeof ctx)['port']>()` for a package with no `port` — the
 * value form would *read* `port` and throw at load time by design.
 */
import { describe, test, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import type {
  BuildAddressOptionsSchema,
  DefineConfigSchema,
  EnvAdditionalFileSchema,
  PublicAddressSchema,
  PublicOriginInputSchema,
  ReverseProxyRouteSchema,
  ReverseProxyTlsSchema,
  ServiceConfigSchema,
} from './config-schema.js';
import {
  defineConfig,
  type Config,
  type ConfigContext,
  type DefineConfigOptions,
  type BuildAddressOptions,
  type PublicAddress,
  type PublicOriginInput,
  type ResolvedPublicAddress,
  type ReverseProxyTls,
  type ReverseProxyInput,
  type ReverseProxyRoute,
  type ReverseProxyServiceRoute,
  type ReverseProxyPathsRoute,
  type ResolvedReverseProxyRoute,
  type ResolvedReverseProxyServiceRoute,
  type ResolvedReverseProxyPathsRoute,
  type ServiceConfigInput,
  type ServiceContext,
  type ServiceInput,
  type TokenRecord,
  type CommandOptions,
  type ResolvedServiceConfig,
  type ResolvedReverseProxy,
  type DepInput,
  type DepsContext,
  type ResolvedDep,
  type ServiceDetails,
  type ServiceIdentity,
  type ServiceRoute,
  type UrlEntry,
  type WorkspaceUrlsContext,
} from './config.js';
import type { EnvAdditionalFile, EnvFileOrder, Envs, Mode } from './env.js';
import {
  resolveEnv,
  type ControlClient,
  type ExecOptions,
  type OneOffResult,
  type RunOptions,
  type ServiceAction,
  type SessionServiceStatus,
  type StartStackOptions,
} from './index.js';
import type {
  InfraCallbackContext,
  InfraEnabledContext,
  InfraReadyContext,
  InfraRunResult,
  InfraServiceInput,
  InfraServicesInput,
  ResolvedInfra,
  ResolvedInfraService,
} from './infra/types.js';
import type {
  InfraServiceName,
  InfraServiceNameIn,
  ServiceName,
  ServiceNameIn,
} from './register.js';

describe('per-package tokens', () => {
  test('gives each package the config tokens plus its own, and nothing from a sibling', () => {
    defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.test', proto: 'https' },
      services: {
        api: {
          tokens: { region: 'us-east', proto: 'http' },
          healthcheck: (ctx) => {
            expectTypeOf(ctx.tokens).toHaveProperty('domain');
            expectTypeOf(ctx.tokens).toHaveProperty('region');
            // the package's own value overrides the config's — and is not `never`
            expectTypeOf(ctx.tokens.proto).toEqualTypeOf<string>();
            expectTypeOf(ctx.tokens.domain).toEqualTypeOf<'example.test'>();
            expectTypeOf(ctx.tokens.region).toEqualTypeOf<string>();
            return 'http://localhost/health';
          },
        },
        // declares no tokens: sees the config's exactly, and NOT api's
        web: {
          healthcheck: (ctx) => {
            expectTypeOf(ctx.tokens).toHaveProperty('domain');
            expectTypeOf(ctx.tokens).not.toHaveProperty('region');
            // not overridden here, so it keeps the config's literal
            expectTypeOf(ctx.tokens.proto).toEqualTypeOf<'https'>();
            return 'http://localhost/health';
          },
        },
      },
    });
  });

  test('exposes each package resolved tokens on the returned config', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.test' },
      services: { api: { tokens: { region: 'us-east' } }, web: {} },
    });
    expectTypeOf(config.services.api.tokens).toHaveProperty('region');
    expectTypeOf(config.services.web.tokens).not.toHaveProperty('region');
    expectTypeOf(config.services.api.tokens.domain).toEqualTypeOf<'example.test'>();
    expectTypeOf(config.services).toHaveProperty('web');
    expectTypeOf(config.services).not.toHaveProperty('ghost');
  });
});

describe('package names', () => {
  test('narrows every name reference to the keys of `packages`', () => {
    type Opts = Parameters<
      typeof defineConfig<
        Record<never, never>,
        { api: unknown; web: unknown; worker: unknown },
        'api' | 'web' | 'worker'
      >
    >[0];
    type Names = 'api' | 'web' | 'worker';

    // the exact union, not just "some string" — this is what regressed in 0.7.0 before
    type Deps = Opts['services']['api']['deps'];
    expectTypeOf<Extract<Deps, unknown[]>>().toEqualTypeOf<DepInput<Names>[]>();
    // the callback form returns the same entries, checked against the same names
    expectTypeOf<ReturnType<Extract<Deps, (...args: never[]) => unknown>>>().toEqualTypeOf<
      DepInput<Names>[]
    >();
  });

  test('types the resolved package name as its own key', () => {
    const config = defineConfig({ serviceRootDir: 'packages', services: { api: {}, web: {} } });
    expectTypeOf(config.services.api.name).toEqualTypeOf<'api'>();
    expectTypeOf(config.services.web.name).toEqualTypeOf<'web'>();
  });
});

describe('port', () => {
  test('hands callbacks a plain `number`, never `number | undefined`', () => {
    defineConfig({
      serviceRootDir: 'packages',
      services: {
        literal: {
          port: 3000,
          healthcheck: (ctx) => {
            expectTypeOf(ctx.port).toEqualTypeOf<number>();
            return `http://localhost:${ctx.port}/health`;
          },
          urls: [
            (ctx) => {
              expectTypeOf(ctx.port).toEqualTypeOf<number>();
              return `http://localhost:${ctx.port}`;
            },
          ],
        },
        derived: {
          port: ({ envs }) => Number(envs.DERIVED_PORT),
          healthcheck: (ctx) => {
            expectTypeOf(ctx.port).toEqualTypeOf<number>();
            return `http://localhost:${ctx.port}/health`;
          },
        },
        // no `port` declared: still typed `number` (unverifiable at the type level), and
        // reading it throws at load time — so assert the type without touching the value.
        portless: {
          healthcheck: (ctx) => {
            expectTypeOf<(typeof ctx)['port']>().toEqualTypeOf<number>();
            return 'http://localhost/health';
          },
        },
      },
    });
  });

  test('offers no port to a `port` callback or to workspace-wide urls', () => {
    defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.test' },
      urls: [
        (ctx) => {
          // workspace-wide links belong to no package
          expectTypeOf(ctx).not.toHaveProperty('port');
          expectTypeOf(ctx.tokens.domain).toEqualTypeOf<'example.test'>();
          return `https://${ctx.tokens.domain}`;
        },
      ],
      services: {
        api: {
          // a port callback can't see the port it is computing
          port: (ctx) => {
            expectTypeOf(ctx).not.toHaveProperty('port');
            return Number(ctx.envs.API_PORT);
          },
        },
      },
    });
  });

  test('keeps the resolved port optional on the config, where it really can be absent', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      services: { api: { port: 3001 }, lib: {} },
    });
    expectTypeOf(config.services.api.port).toEqualTypeOf<number | undefined>();
    expectTypeOf(config.services.lib.port).toEqualTypeOf<number | undefined>();
  });
});

describe('envs', () => {
  test('is a plain string record in every callback', () => {
    defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: {
          port: ({ envs }) => {
            expectTypeOf(envs).toEqualTypeOf<Envs>();
            return Number(envs.PORT);
          },
        },
      },
    });
  });
});

describe('key narrowing survives a config of nothing but callbacks', () => {
  // Regression guard. A package literal made up only of callbacks is context-sensitive, and
  // TypeScript skips it in the pass that registers its key — so with the reverse-mapped type
  // alone, a config where EVERY package declared only callbacks inferred no keys and the name
  // union silently widened to `string`, dropping the `waitFor`/`deps` checks. The
  // `& Record<K, unknown>` channel in `DefineConfigOptions` is what fixes it; each assertion
  // below demands the exact key union, so a regression fails loudly instead of quietly widening.

  test('a single package with only a port callback and a healthcheck callback', () => {
    const c = defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: {
          port: ({ envs }) => Number(envs.API_PORT),
          healthcheck: ({ port }) => `http://localhost:${port}/health`,
        },
      },
    });
    expectTypeOf(c.services.api.name).toEqualTypeOf<'api'>();
  });

  test('a urls-only package', () => {
    const c = defineConfig({
      serviceRootDir: 'packages',
      services: { api: { urls: [({ port }) => `http://localhost:${port}`] } },
    });
    expectTypeOf(c.services.api.name).toEqualTypeOf<'api'>();
  });

  test('several packages, every one of them callbacks only', () => {
    const c = defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: { healthcheck: ({ port }) => `http://localhost:${port}/health` },
        web: { healthcheck: ({ port }) => `http://localhost:${port}/` },
      },
    });
    expectTypeOf(c.services.api.name).toEqualTypeOf<'api'>();
    expectTypeOf(c.services.web.name).toEqualTypeOf<'web'>();
    // and the name references are still checked against those keys
    expectTypeOf<
      Extract<
        Parameters<
          typeof defineConfig<Record<never, never>, { api: unknown; web: unknown }, 'api' | 'web'>
        >[0]['services']['api']['deps'],
        unknown[]
      >
    >().toEqualTypeOf<DepInput<'api' | 'web'>[]>();
  });

  test('still narrows when only some packages are callbacks only', () => {
    const c = defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: { healthcheck: ({ port }) => `http://localhost:${port}/health` },
        lib: { selectable: false },
      },
    });
    expectTypeOf(c.services.api.name).toEqualTypeOf<'api'>();
    expectTypeOf(c.services.lib.name).toEqualTypeOf<'lib'>();
  });
});

describe('reverseProxy.routes', () => {
  test('an entry is `subdomain` and `service`, or `subdomain` and `paths`', () => {
    expectTypeOf<ReverseProxyRoute<'api'>>().toEqualTypeOf<
      ReverseProxyServiceRoute<'api'> | ReverseProxyPathsRoute<'api'>
    >();
    expectTypeOf<ReverseProxyServiceRoute['subdomain']>().toEqualTypeOf<string | string[]>();
    expectTypeOf<ReverseProxyPathsRoute<'api'>['paths']>().toEqualTypeOf<Record<`/${string}`, 'api'>>(); // oxfmt-ignore
    // Each variant rules the other's key out.
    expectTypeOf<ReverseProxyServiceRoute['paths']>().toEqualTypeOf<undefined>();
    expectTypeOf<ReverseProxyPathsRoute['service']>().toEqualTypeOf<undefined>();
    expectTypeOf<{ subdomain: 'api'; service: 'api' }>().toExtend<ReverseProxyRoute<'api'>>();
    expectTypeOf<{ subdomain: '*'; paths: { '/**': 'api' } }>().toExtend<ReverseProxyRoute<'api'>>(); // oxfmt-ignore
    expectTypeOf<{ subdomain: ['app', 'www']; paths: { '/**': 'api' } }>().toExtend<ReverseProxyRoute<'api'>>(); // oxfmt-ignore
    // Neither is no entry.
    expectTypeOf<{ subdomain: 'api' }>().not.toExtend<ReverseProxyRoute<'api'>>();
  });

  test('an entry with both `service` and `paths` does not compile', () => {
    defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        routes: [
          // @ts-expect-error -- an entry gives `service` or `paths`, never both (TS2322)
          { subdomain: 'api', service: 'api', paths: { '/**': 'api' } },
        ],
      },
      services: { api: { port: 3000 } },
    });
    expectTypeOf<{ subdomain: 'api'; service: 'api'; paths: { '/**': 'api' } }>().not.toExtend<ReverseProxyRoute<'api'>>(); // oxfmt-ignore
  });

  test('targets are the service names and the infra service names, inline', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      tokens: { tld: 'test' },
      reverseProxy: {
        port: 4000,
        routes: [
          { subdomain: 'api', service: 'api' },
          { subdomain: 'mail', service: 'mailpit' },
          { subdomain: '*', paths: { '/files/**': 'store', '/**': 'web' } },
        ],
      },
      infra: {
        'docker-compose': {
          services: {
            mailpit: { port: (ctx) => Number(ctx.envs.MAIL_UI_PORT), urls: [({ port }) => `/${String(port)}`] }, // oxfmt-ignore
            store: { port: 9000, afterReady: async (ctx) => void ctx.service.route },
          },
        },
      },
      services: {
        api: {
          port: 3000,
          tokens: { region: 'local' },
          healthcheck: (ctx) => {
            expectTypeOf(ctx.tokens.region).toEqualTypeOf<string>();
            expectTypeOf(ctx.tokens.tld).toEqualTypeOf<'test'>();
            expectTypeOf(ctx.port).toEqualTypeOf<number>();
            return '/health';
          },
        },
        web: { port: 3001, urls: [({ port }) => `http://localhost:${String(port)}`] },
      },
    });
    // The inference the routes ride on is untouched: names, tokens, the callback `port`.
    expectTypeOf<keyof typeof config.services>().toEqualTypeOf<'api' | 'web'>();
    expectTypeOf(config.services.api.tokens.region).toEqualTypeOf<string>();
    expectTypeOf<keyof NonNullable<NonNullable<typeof config.infra>['docker-compose']>['services']>().toEqualTypeOf<'mailpit' | 'store'>(); // oxfmt-ignore
    type Opts = Parameters<
      typeof defineConfig<Record<never, never>, { web: unknown; api: unknown }, 'web' | 'api', 'packages', 'mail'> // oxfmt-ignore
    >[0];
    expectTypeOf<NonNullable<NonNullable<Opts['reverseProxy']>['routes']>[number]>().toEqualTypeOf<
      ReverseProxyRoute<'web' | 'api' | 'mail'>
    >();
  });

  test('a name from an infra map written apart is a target too', () => {
    const infraServices = {
      mailpit: { port: 8025 },
      store: {},
    } satisfies InfraServicesInput;
    defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        routes: [
          { subdomain: 'mail', service: 'mailpit' },
          { subdomain: '*', paths: { '/files/**': 'store', '/**': 'web' } },
        ],
      },
      infra: { 'docker-compose': { services: infraServices } },
      services: { web: { port: 3000 } },
    });
  });

  test('a misspelled target does not compile, as `service` or in `paths`', () => {
    defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        routes: [
          // @ts-expect-error -- 'mailpt' is neither a service nor an infra service (TS2322)
          { subdomain: 'mail', service: 'mailpt' },
        ],
      },
      infra: { 'docker-compose': { services: { mailpit: { port: 8025 } } } },
      services: { web: { port: 3000 } },
    });
    defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        // @ts-expect-error -- 'wbe' is no service (TS2322)
        routes: [{ subdomain: '*', paths: { '/**': 'wbe' } }],
      },
      infra: { 'docker-compose': { services: { mailpit: { port: 8025 } } } },
      services: { web: { port: 3000 } },
    });
    // Without infra, only the service names.
    type Opts = Parameters<
      typeof defineConfig<Record<never, never>, { web: unknown }, 'web', 'packages'>
    >[0];
    expectTypeOf<NonNullable<NonNullable<Opts['reverseProxy']>['routes']>[number]>().toEqualTypeOf<
      ReverseProxyRoute<'web'>
    >();
  });

  test('a list written apart is `ReverseProxyRoute<…>[]`, and fits `routes`', () => {
    const routes = [
      { subdomain: 'api', service: 'api' },
      { subdomain: 'mail', service: 'mailpit' },
      { subdomain: '*', paths: { '/**': 'web' } },
    ] satisfies ReverseProxyRoute<'api' | 'web' | 'mailpit'>[];
    const annotated: ReverseProxyRoute<'api' | 'web' | 'mailpit'>[] = routes;
    const config = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000, routes },
      infra: { 'docker-compose': { services: { mailpit: { port: 8025 } } } },
      services: { api: { port: 3000 }, web: { port: 3001 } },
    });
    defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000, routes: annotated },
      infra: { 'docker-compose': { services: { mailpit: { port: 8025 } } } },
      services: { api: { port: 3000 }, web: { port: 3001 } },
    });
    expectTypeOf<keyof typeof config.services>().toEqualTypeOf<'api' | 'web'>();
    // @ts-expect-error -- 'wbe' is not one of the names (TS2322)
    void ([{ subdomain: 'x', service: 'wbe' }] satisfies ReverseProxyRoute<'api' | 'web'>[]);
  });

  test('resolve with `subdomain` a list; the route and its kinds are typed', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000, routes: [{ subdomain: 'api', service: 'api' }] },
      services: { api: { port: 3000 } },
    });
    expectTypeOf(config.reverseProxy!.routes).toEqualTypeOf<ResolvedReverseProxyRoute[]>();
    expectTypeOf<ResolvedReverseProxyRoute>().toEqualTypeOf<
      ResolvedReverseProxyServiceRoute | ResolvedReverseProxyPathsRoute
    >();
    expectTypeOf<ResolvedReverseProxyServiceRoute>().toEqualTypeOf<{
      subdomain: string[];
      service: string;
      paths?: never;
    }>();
    expectTypeOf<ResolvedReverseProxyPathsRoute>().toEqualTypeOf<{
      subdomain: string[];
      paths: Record<string, string>;
      service?: never;
    }>();
    // The callbacks' route: its host and subdomain, or null.
    expectTypeOf<ServiceDetails['route']>().toEqualTypeOf<ServiceRoute | null>();
    expectTypeOf<ServiceRoute>().toEqualTypeOf<{ host: string; subdomain: string }>();
    expectTypeOf<ServiceDetails>().not.toHaveProperty('proxy');
  });

  test('the removed keys are no longer fields', () => {
    expectTypeOf<ServiceConfigInput>().not.toHaveProperty('proxy');
    expectTypeOf<InfraServiceInput>().not.toHaveProperty('proxy');
    expectTypeOf<ResolvedServiceConfig<string>>().not.toHaveProperty('proxy');
    expectTypeOf<ResolvedInfraService>().not.toHaveProperty('proxy');
    expectTypeOf<ReverseProxyInput>().not.toHaveProperty('paths');
    expectTypeOf<ReverseProxyInput>().not.toHaveProperty('defaultService');
    expectTypeOf<ReverseProxyInput>().not.toHaveProperty('https');
    expectTypeOf<ReverseProxyInput>().toHaveProperty('tls');
  });

  test('the typed names: `ServiceName` and `InfraServiceName`, each its own kind, read from `Register`', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      infra: { 'docker-compose': { services: { mailpit: { port: 8025 }, db: {} } } },
      services: { api: {}, web: {} },
    });
    type Registered = {
      serviceConfigs: typeof config.services;
      infraServices: typeof config.infra;
    };
    expectTypeOf<ServiceNameIn<Registered>>().toEqualTypeOf<'api' | 'web'>();
    expectTypeOf<InfraServiceNameIn<Registered>>().toEqualTypeOf<'mailpit' | 'db'>();
    // A routes list checked against both, as `ReverseProxyRoute`'s default is once registered.
    type Route = ReverseProxyRoute<ServiceNameIn<Registered> | InfraServiceNameIn<Registered>>;
    expectTypeOf<{ subdomain: 'api'; service: 'api' }>().toExtend<Route>();
    expectTypeOf<{ subdomain: 'mail'; service: 'mailpit' }>().toExtend<Route>();
    expectTypeOf<{ subdomain: '*'; paths: { '/db/**': 'db'; '/**': 'web' } }>().toExtend<Route>();
    expectTypeOf<{ subdomain: 'x'; service: 'mailpt' }>().not.toExtend<Route>();
    // Unregistered (as here), each is any name, and so is the default.
    expectTypeOf<ServiceName>().toEqualTypeOf<string>();
    expectTypeOf<InfraServiceName>().toEqualTypeOf<string>();
    expectTypeOf<ReverseProxyRoute['service']>().toEqualTypeOf<string | undefined>();
    // A config without infra registers no infra names.
    const bare = defineConfig({ serviceRootDir: 'packages', services: { api: {} } });
    expectTypeOf<InfraServiceNameIn<{ infraServices: typeof bare.infra }>>().toEqualTypeOf<never>();
  });

  test('hands a callback the service, resolved; workspace-wide urls get none', () => {
    defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000, routes: [{ subdomain: ['api', 'api-legacy'], service: 'api' }] },
      urls: [
        (ctx) => {
          expectTypeOf(ctx).not.toHaveProperty('service');
          return 'https://example.test';
        },
      ],
      services: {
        api: {
          healthcheck: (ctx) => {
            expectTypeOf(ctx.service).toEqualTypeOf<ServiceDetails>();
            expectTypeOf(ctx.service.route).toEqualTypeOf<ServiceRoute | null>();
            expectTypeOf(ctx.service.port).toEqualTypeOf<number | undefined>();
            expectTypeOf(ctx.service.publicOrigin).toEqualTypeOf<string | undefined>();
            expectTypeOf(ctx).not.toHaveProperty('subdomain');
            return `https://${ctx.service.route!.host}/health`;
          },
          urls: [({ service }) => `${service.publicOrigin!}/docs`],
          // a port callback gets which service it is for, and nothing resolved yet
          port: (ctx) => {
            expectTypeOf(ctx.service).toEqualTypeOf<ServiceIdentity>();
            expectTypeOf(ctx.service).not.toHaveProperty('shortName');
            expectTypeOf(ctx).not.toHaveProperty('port');
            return 3000;
          },
        },
      },
    });
  });

  test('the services are under `services`: a `packages` key is not part of the config', () => {
    defineConfig({
      serviceRootDir: 'apps',
      services: {},
      // @ts-expect-error the application services go under `services`
      packages: { api: {} },
    });
  });
});

describe('infra service port and route', () => {
  test('a port callback gets the workspace context; both resolve on the service', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      tokens: { tld: 'test' },
      reverseProxy: {
        port: 4000,
        routes: [
          { subdomain: 'mail', service: 'mail' },
          { subdomain: ['s3', 'files'], service: 'store' },
        ],
      },
      infra: {
        'docker-compose': {
          services: {
            mail: {
              port: (ctx) => {
                expectTypeOf(ctx.envs).toEqualTypeOf<Envs>();
                expectTypeOf(ctx.tokens.tld).toEqualTypeOf<'test'>();
                // nothing about the service is resolved yet: which one it is, alone
                expectTypeOf(ctx).not.toHaveProperty('port');
                expectTypeOf(ctx.service).toEqualTypeOf<ServiceIdentity>();
                return Number(ctx.envs.MAIL_UI_PORT);
              },
            },
            store: { port: 9000 },
          },
        },
      },
      services: { web: {} },
    });
    const service = config.infra!['docker-compose']!.services.mail;
    expectTypeOf(service.port).toEqualTypeOf<number | undefined>();
    expectTypeOf(service.publicOrigin).toEqualTypeOf<string | undefined>();
    expectTypeOf<ResolvedInfraService['port']>().toEqualTypeOf<number | undefined>();
  });

  test("a `urls` callback gets the service's port and the service; the resolved urls are entries", () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      tokens: { tld: 'test' },
      infra: {
        'docker-compose': {
          services: {
            mail: {
              port: 8025,
              urls: [
                (ctx) => {
                  expectTypeOf(ctx.port).toEqualTypeOf<number>();
                  expectTypeOf(ctx.service).toEqualTypeOf<ServiceDetails>();
                  expectTypeOf(ctx.tokens.tld).toEqualTypeOf<'test'>();
                  return '/';
                },
                { label: 'inbox', url: '/inbox' },
              ],
            },
          },
        },
      },
      services: { web: {} },
    });
    expectTypeOf(config.infra!['docker-compose']!.services.mail!.urls).toEqualTypeOf<
      UrlEntry[] | undefined
    >();
  });

  test('a service has no `shortName`', () => {
    defineConfig({
      serviceRootDir: 'packages',
      services: {
        // @ts-expect-error `shortName` is not a service field
        web: { shortName: 'w' },
      },
    });
  });
});

describe('reverseProxy', () => {
  test('types the block on the options, with callbacks over the workspace context', () => {
    defineConfig({
      serviceRootDir: 'packages',
      tokens: { tld: 'test' },
      reverseProxy: {
        port: (ctx) => {
          expectTypeOf(ctx.envs).toEqualTypeOf<Envs>();
          expectTypeOf(ctx.tokens.tld).toEqualTypeOf<'test'>();
          expectTypeOf(ctx).not.toHaveProperty('port');
          expectTypeOf(ctx).not.toHaveProperty('service');
          return Number(ctx.envs.REVERSE_PROXY_PORT);
        },
        publicAddress: (ctx) => {
          expectTypeOf(ctx.tokens.tld).toEqualTypeOf<'test'>();
          expectTypeOf(ctx).not.toHaveProperty('service');
          return { domain: `example.${ctx.tokens.tld}`, scheme: 'https' };
        },
        tls: (ctx) => {
          expectTypeOf(ctx.tokens.tld).toEqualTypeOf<'test'>();
          return { key: `key.${ctx.tokens.tld}`, cert: 'cert.pem' };
        },
        routes: [{ subdomain: 'web', service: 'web' }],
      },
      services: { web: { port: 3000 } },
    });
    type Opts = Parameters<
      typeof defineConfig<Record<never, never>, { web: unknown; api: unknown }, 'web' | 'api'>
    >[0];
    type Proxy = NonNullable<Opts['reverseProxy']>;
    // No infra: the routes name the services alone.
    expectTypeOf<Proxy['routes']>().toEqualTypeOf<ReverseProxyRoute<'web' | 'api'>[] | undefined>();
    expectTypeOf<Proxy['tls']>().toEqualTypeOf<
      ReverseProxyTls | ((ctx: ConfigContext<Record<never, never>>) => ReverseProxyTls) | undefined
    >();
    expectTypeOf<Proxy['publicAddress']>().toEqualTypeOf<
      PublicAddress | ((ctx: ConfigContext<Record<never, never>>) => PublicAddress) | undefined
    >();
  });

  test('keeps the service names narrowed with routes naming them, and a callback reading the proxy', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000, routes: [{ subdomain: '*', paths: { '/docs/**': 'docs', '/**': 'web' } }] }, // oxfmt-ignore
      services: {
        web: { port: 3000, urls: [({ buildAddress }) => buildAddress()] },
        docs: { port: 3001 },
      },
    });
    expectTypeOf<keyof typeof config.services>().toEqualTypeOf<'web' | 'docs'>();
  });

  test('exposes the resolved block on the returned config', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000, publicAddress: { domain: 'example.test', scheme: 'http' }, routes: [{ subdomain: 'web', service: 'web' }] }, // oxfmt-ignore
      services: { web: { port: 3000 } },
    });
    expectTypeOf(config.reverseProxy).toEqualTypeOf<ResolvedReverseProxy | undefined>();
    expectTypeOf(config.reverseProxy!.port).toEqualTypeOf<number>();
    expectTypeOf(config.reverseProxy!.tls).toEqualTypeOf<false | 'self-signed' | 'own'>();
    expectTypeOf(config.reverseProxy!.publicAddress).toEqualTypeOf<ResolvedPublicAddress>();
    expectTypeOf<ResolvedPublicAddress>().toEqualTypeOf<{
      domain: string;
      domains: string[];
      scheme: 'https' | 'http';
      port: number | undefined;
    }>();
    expectTypeOf<keyof ResolvedReverseProxy>().toEqualTypeOf<
      'port' | 'publicAddress' | 'routes' | 'tls'
    >();
    expectTypeOf(config.services.web.publicOrigin).toEqualTypeOf<string | undefined>();
  });

  test('still refuses an unknown key in reverseProxy, and in publicAddress', () => {
    defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        // @ts-expect-error -- the domain is `publicAddress.domain`
        domain: 'example.test',
      },
      services: { web: { port: 3000 } },
    });
    defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        // @ts-expect-error -- `publicAddress` takes `domain`, `scheme` and `port`: no `https`
        publicAddress: { domain: 'example.test', scheme: 'https', https: true },
      },
      services: { web: { port: 3000 } },
    });
  });

  test('there is no top-level publicOrigin callback', () => {
    type Opts = DefineConfigOptions<TokenRecord, Record<string, unknown>, string, string>;
    expectTypeOf<Opts>().not.toHaveProperty('publicOrigin');
    expectTypeOf<Opts>().toHaveProperty('reverseProxy');
  });
});

describe('reverseProxy publicAddress', () => {
  test('is optional; domain and scheme are required, port optional', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000 },
      services: { web: { port: 3000 } },
    });
    expectTypeOf(config.reverseProxy!.publicAddress.domain).toEqualTypeOf<string>();
    expectTypeOf<PublicAddress>().toEqualTypeOf<{
      domain: string | string[];
      scheme: 'https' | 'http';
      port?: number;
    }>();
    expectTypeOf<PublicAddress['scheme']>().toEqualTypeOf<'https' | 'http'>();
    expectTypeOf<{ domain: string }>().not.toExtend<PublicAddress>();
    expectTypeOf<{ scheme: 'https' }>().not.toExtend<PublicAddress>();
    expectTypeOf<{ domain: string; scheme: 'ftp' }>().not.toExtend<PublicAddress>();
    expectTypeOf<PublicAddress>().not.toHaveProperty('https');
    expectTypeOf<ResolvedPublicAddress>().not.toHaveProperty('https');
  });

  test('takes an array of domains, literal or from the callback; resolves to the canonical one plus the list', () => {
    const literal = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        publicAddress: { domain: ['example.test', 'example.localhost'], scheme: 'https' },
      },
      services: { web: { port: 3000 } },
    });
    expectTypeOf(literal.reverseProxy!.publicAddress.domain).toEqualTypeOf<string>();
    expectTypeOf(literal.reverseProxy!.publicAddress.domains).toEqualTypeOf<string[]>();
    defineConfig({
      serviceRootDir: 'packages',
      tokens: { tld: 'test' },
      reverseProxy: {
        port: 4000,
        publicAddress: (ctx) => ({
          domain: [`example.${ctx.tokens.tld}`, 'example.localhost'],
          scheme: 'https',
          port: 8443,
        }),
      },
      services: { web: { port: 3000 } },
    });
  });
});

describe('the callbacks’ buildAddress', () => {
  type BuildAddress = (opts?: BuildAddressOptions) => string;

  test('takes scheme, subdomain (or null), domain, port and path, all optional', () => {
    expectTypeOf<BuildAddressOptions>().toEqualTypeOf<{
      scheme?: 'https' | 'http';
      subdomain?: string | null;
      domain?: string;
      port?: number;
      path?: string;
    }>();
  });

  test('is there, typed and never null, in every callback of a config with a reverseProxy', () => {
    defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        routes: [
          { subdomain: 'mail', service: 'mail' },
          { subdomain: '*', service: 'web' },
        ],
      },
      urls: [
        (ctx) => {
          expectTypeOf(ctx.envs).toEqualTypeOf<Envs>();
          expectTypeOf(ctx.buildAddress).toEqualTypeOf<BuildAddress>();
          expectTypeOf(ctx).not.toHaveProperty('reverseProxy');
          expectTypeOf(ctx).not.toHaveProperty('service');
          return ctx.buildAddress({ subdomain: 'status' });
        },
      ],
      infra: {
        'docker-compose': {
          services: {
            mail: {
              port: 8025,
              urls: [
                (ctx) => {
                  expectTypeOf(ctx.buildAddress).toEqualTypeOf<BuildAddress>();
                  expectTypeOf(ctx).not.toHaveProperty('reverseProxy');
                  return ctx.buildAddress({ subdomain: 'mail' });
                },
              ],
              afterReady: (ctx) => {
                expectTypeOf(ctx.buildAddress).toEqualTypeOf<BuildAddress>();
                expectTypeOf(ctx).not.toHaveProperty('reverseProxy');
              },
              beforeStart: (ctx) => {
                expectTypeOf(ctx.buildAddress).toEqualTypeOf<BuildAddress>();
                expectTypeOf(ctx).not.toHaveProperty('reverseProxy');
              },
            },
          },
        },
      },
      services: {
        web: {
          port: 3000,
          // Written out: a callback a nested generic call (`.map`) returns is checked before the
          // config's type parameters are inferred, so it gets none of their types, `tokens` included.
          urls: [
            ({ buildAddress }) => buildAddress({ subdomain: 'admin' }),
            ({ buildAddress }) => buildAddress({ subdomain: null, path: '/x' }),
            { label: 'docs', url: ({ buildAddress }) => buildAddress({ scheme: 'http', port: 8080 }) }, // oxfmt-ignore
          ],
          healthcheck: (ctx) => {
            expectTypeOf(ctx.buildAddress).parameters.toEqualTypeOf<[opts?: BuildAddressOptions]>();
            expectTypeOf(ctx.buildAddress).returns.toEqualTypeOf<string>();
            expectTypeOf(ctx).not.toHaveProperty('reverseProxy');
            return '/health';
          },
        },
        // `urls` as a callback: typed like a callback in the list, and a `.map` inside it is too.
        app: {
          port: 3001,
          urls: (ctx) => {
            expectTypeOf(ctx.buildAddress).toEqualTypeOf<BuildAddress>();
            expectTypeOf(ctx.port).toEqualTypeOf<number>();
            return ['app', 'web'].map((subdomain) => ctx.buildAddress({ subdomain }));
          },
        },
      },
    });
  });

  test('is there, typed the same, in a config without one', () => {
    defineConfig({
      serviceRootDir: 'packages',
      urls: [({ buildAddress }) => buildAddress()],
      infra: {
        'docker-compose': {
          services: {
            db: {
              urls: [(ctx) => (expectTypeOf(ctx.buildAddress).toEqualTypeOf<BuildAddress>(), '/')],
              afterReady: (ctx) => {
                expectTypeOf(ctx.buildAddress).toEqualTypeOf<BuildAddress>();
              },
            },
          },
        },
      },
      services: {
        web: {
          port: 3000,
          urls: [
            (ctx) => {
              expectTypeOf(ctx.buildAddress).toEqualTypeOf<BuildAddress>();
              return '/';
            },
          ],
          healthcheck: (ctx) => (expectTypeOf(ctx.buildAddress).toEqualTypeOf<BuildAddress>(), '/'),
        },
        app: {
          port: 3001,
          urls: (ctx) => {
            expectTypeOf(ctx.buildAddress).toEqualTypeOf<BuildAddress>();
            return ['/'];
          },
        },
      },
    });
  });

  test('is on the bare types too, and no `reverseProxy` is', () => {
    const part = {
      urls: [({ buildAddress }) => buildAddress({ subdomain: 'docs' })],
    } satisfies ServiceInput;
    expectTypeOf<ServiceContext['buildAddress']>().toEqualTypeOf<BuildAddress>();
    expectTypeOf<WorkspaceUrlsContext['buildAddress']>().toEqualTypeOf<BuildAddress>();
    expectTypeOf<InfraCallbackContext['buildAddress']>().toEqualTypeOf<BuildAddress>();
    expectTypeOf<InfraReadyContext['buildAddress']>().toEqualTypeOf<BuildAddress>();
    expectTypeOf<ServiceContext>().not.toHaveProperty('reverseProxy');
    expectTypeOf<WorkspaceUrlsContext>().not.toHaveProperty('reverseProxy');
    expectTypeOf<InfraCallbackContext>().not.toHaveProperty('reverseProxy');
    expectTypeOf<InfraReadyContext>().not.toHaveProperty('reverseProxy');
    // Such a part fits a config with a proxy, and one without.
    defineConfig({ serviceRootDir: 'apps', reverseProxy: { port: 4000 }, services: { web: part } });
    defineConfig({ serviceRootDir: 'apps', services: { web: part } });
  });

  test('rejects an option it does not take', () => {
    defineConfig({
      serviceRootDir: 'packages',
      services: {
        web: {
          port: 3000,
          // @ts-expect-error -- `scheme` is 'https' or 'http' (TS2322)
          urls: [({ buildAddress }) => buildAddress({ scheme: 'ftp' })],
        },
      },
    });
    expectTypeOf<{ https: true }>().not.toExtend<BuildAddressOptions>();
  });
});

describe('publicOrigin', () => {
  test('takes scheme, subdomain (or null), domain and port, all optional', () => {
    expectTypeOf<PublicOriginInput>().toEqualTypeOf<{
      scheme?: 'https' | 'http';
      subdomain?: string | null;
      domain?: string;
      port?: number;
    }>();
    expectTypeOf<PublicOriginInput>().not.toHaveProperty('path');
  });

  test("is the parts, or a callback over the service's own envs and tokens", () => {
    defineConfig({
      serviceRootDir: 'packages',
      tokens: { tld: 'test' },
      reverseProxy: { port: 4000, routes: [{ subdomain: '*', service: 'web' }] },
      infra: {
        'docker-compose': {
          services: {
            mail: {
              port: 8025,
              publicOrigin: (ctx) => {
                expectTypeOf(ctx).toEqualTypeOf<ConfigContext<{ readonly tld: 'test' }>>();
                return { subdomain: 'mail' };
              },
            },
          },
        },
      },
      services: {
        web: {
          port: 3000,
          tokens: { sub: 'app' },
          publicOrigin: (ctx) => {
            expectTypeOf(ctx.envs).toEqualTypeOf<Envs>();
            expectTypeOf(ctx.tokens.sub).toEqualTypeOf<string>();
            expectTypeOf(ctx.tokens.tld).toEqualTypeOf<'test'>();
            expectTypeOf(ctx).not.toHaveProperty('port');
            expectTypeOf(ctx).not.toHaveProperty('buildAddress');
            return { subdomain: ctx.tokens.sub };
          },
        },
        api: { port: 3001, publicOrigin: { scheme: 'http', subdomain: null, domain: 'example.test', port: 8080 } }, // oxfmt-ignore
      },
    });
    type ServiceOrigin = NonNullable<ServiceInput['publicOrigin']>;
    expectTypeOf<PublicOriginInput>().toExtend<ServiceOrigin>();
    expectTypeOf<(ctx: ConfigContext) => PublicOriginInput>().toExtend<ServiceOrigin>();
    expectTypeOf<Exclude<ServiceOrigin, PublicOriginInput>>().returns.toEqualTypeOf<PublicOriginInput>(); // oxfmt-ignore
    expectTypeOf<InfraServiceInput['publicOrigin']>().toEqualTypeOf<
      PublicOriginInput | ((ctx: ConfigContext) => PublicOriginInput) | undefined
    >();
  });

  test('resolves to a string on the service, an infra service too', () => {
    expectTypeOf<ResolvedServiceConfig<string>['publicOrigin']>().toEqualTypeOf<string | undefined>(); // oxfmt-ignore
    expectTypeOf<ResolvedInfraService['publicOrigin']>().toEqualTypeOf<string | undefined>();
  });

  test('rejects a field it does not take', () => {
    defineConfig({
      serviceRootDir: 'packages',
      services: {
        // @ts-expect-error -- `publicOrigin` takes no `path` (TS2353)
        web: { port: 3000, publicOrigin: { subdomain: 'app', path: '/x' } },
      },
    });
    expectTypeOf<{ scheme: 'ftp' }>().not.toExtend<PublicOriginInput>();
  });
});

describe('deps as a callback', () => {
  test('receives the mode and the service context, typed from its tokens', () => {
    defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.test' },
      services: {
        api: {
          tokens: { region: 'us-east' },
          deps: (ctx) => {
            expectTypeOf(ctx).toExtend<DepsContext<{ domain: string; region: string }>>();
            expectTypeOf(ctx.tokens.domain).toEqualTypeOf<'example.test'>();
            expectTypeOf(ctx.mode).toEqualTypeOf<Mode>();
            expectTypeOf(ctx.envs).toEqualTypeOf<Envs>();
            expectTypeOf(ctx.tokens.region).toEqualTypeOf<string>();
            return ctx.mode === 'test' ? ['gateway'] : ['codegen', { service: 'gateway' }];
          },
        },
        codegen: {},
        gateway: {},
      },
    });
  });

  test('returns entries checked against the service names', () => {
    defineConfig({
      serviceRootDir: 'packages',
      services: {
        // @ts-expect-error `ghost` is not a service
        api: { deps: () => ['ghost'] },
        gateway: {},
      },
    });
  });
});

describe('the removed build surface', () => {
  test('a command takes only `watches`', () => {
    expectTypeOf<CommandOptions>().toEqualTypeOf<{ watches?: boolean }>();
  });

  test('a service declares no build dep and no tsconfig', () => {
    expectTypeOf<ResolvedServiceConfig<'api' | 'web'>['deps']>().toEqualTypeOf<
      ResolvedDep<'api' | 'web'>[] | undefined
    >();
    expectTypeOf<ResolvedServiceConfig<string>>().not.toHaveProperty('tsconfig');
    expectTypeOf<ServiceConfigInput>().not.toHaveProperty('tsconfig');
    expectTypeOf<ServiceConfigInput>().not.toHaveProperty('subdomain');
  });

  test('a resolved command is its name and `watches`', () => {
    type Resolved = NonNullable<ResolvedServiceConfig<string>['command']>;
    expectTypeOf<Resolved>().toEqualTypeOf<{ name: string; watches: boolean }>();
  });

  test('`ServiceType` is not exported', () => {
    // @ts-expect-error stackctl no longer exports `ServiceType`
    type Gone = import('./index.js').ServiceType;
    expectTypeOf<Gone>().toBeAny();
  });
});

describe('serviceRootDir', () => {
  test('makes relativeDir optional when set, required otherwise', () => {
    type WithRoot = Parameters<
      typeof defineConfig<Record<never, never>, { api: unknown }, 'api', 'packages'>
    >[0]['services']['api'];
    type WithoutRoot = Parameters<
      typeof defineConfig<Record<never, never>, { api: unknown }, 'api'>
    >[0]['services']['api'];
    expectTypeOf<Pick<WithRoot, 'relativeDir'>>().toEqualTypeOf<{ relativeDir?: string }>();
    expectTypeOf<Pick<WithoutRoot, 'relativeDir'>>().toEqualTypeOf<{ relativeDir: string }>();
  });

  test('infers from a literal serviceRootDir, and the resolved relativeDir is always a string', () => {
    const config = defineConfig({ serviceRootDir: 'packages', services: { api: {} } });
    expectTypeOf(config.services.api.relativeDir).toEqualTypeOf<string>();
    expectTypeOf(config.serviceRootDir).toEqualTypeOf<string | undefined>();
  });
});

describe('infra callbacks', () => {
  test("type the context from the config's own tokens", () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.test' },
      infra: {
        'docker-compose': {
          services: {
            db: {
              afterReady: async (ctx) => {
                expectTypeOf(ctx.envs).toEqualTypeOf<Envs>();
                expectTypeOf(ctx.tokens.domain).toEqualTypeOf<'example.test'>();
                expectTypeOf(ctx.tokens).not.toHaveProperty('region');
                expectTypeOf(ctx.reset).toEqualTypeOf<boolean>();
                expectTypeOf(ctx.fresh).toEqualTypeOf<boolean>();
                expectTypeOf(ctx.service).toEqualTypeOf<ServiceDetails>();
                expectTypeOf(ctx.workspaceDir).toEqualTypeOf<string>();
                expectTypeOf(ctx.compose).returns.toEqualTypeOf<Promise<InfraRunResult>>();
                expectTypeOf(ctx.exec).returns.toEqualTypeOf<Promise<InfraRunResult>>();
                expectTypeOf(ctx).not.toHaveProperty('run');
                expectTypeOf(ctx.log).parameters.toEqualTypeOf<[message: string]>();
              },
              // a synchronous callback is fine too
              beforeStart: (ctx) => {
                expectTypeOf(ctx.mode).toEqualTypeOf<Mode>();
                // only afterReady knows: before the start there is nothing to be fresh yet
                expectTypeOf(ctx).not.toHaveProperty('fresh');
              },
              enabled: (ctx) => {
                expectTypeOf(ctx.mode).toEqualTypeOf<Mode>();
                expectTypeOf(ctx.envs).toEqualTypeOf<Envs>();
                expectTypeOf(ctx.tokens.domain).toEqualTypeOf<'example.test'>();
                // decided when the config loads: no service to act on, nothing to run
                expectTypeOf(ctx).not.toHaveProperty('compose');
                return ctx.mode !== 'test';
              },
            },
          },
        },
      },
      services: { web: {} },
    });
    expectTypeOf(config.infra).toExtend<ResolvedInfra | undefined>();
  });
});

describe('Mode', () => {
  test('suggests the usual names without closing the set: any string is a mode', () => {
    expectTypeOf<'development'>().toExtend<Mode>();
    expectTypeOf<'test'>().toExtend<Mode>();
    expectTypeOf<'staging'>().toExtend<Mode>();
    expectTypeOf<string>().toExtend<Mode>();
    expectTypeOf<Mode>().toExtend<string>();
    // …and it has not collapsed into plain `string`, which is what would drop the suggestions.
    expectTypeOf<Mode>().not.toEqualTypeOf<string>();
  });
});

describe('shorthands', () => {
  test('a provider takes true for {}', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      infra: { 'docker-compose': true },
      reverseProxy: { port: 4000 },
      services: { web: { port: 3000 } },
    });
    // No services named: no infra names either.
    expectTypeOf(config.infra).toEqualTypeOf<ResolvedInfra<never> | undefined>();
  });
});

describe('env', () => {
  test('types the shorthand callback over the workspace context', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      tokens: { tier: 'dev' },
      env: (ctx) => {
        expectTypeOf(ctx.envs).toEqualTypeOf<Envs>();
        // the variables stackctl sets are known by name, so an editor offers them
        expectTypeOf(ctx.envs.STACKCTL_MODE).toEqualTypeOf<Mode>();
        expectTypeOf(ctx.envs.STACKCTL_CWD).toEqualTypeOf<string>();
        expectTypeOf(ctx.envs.STACKCTL_WORKSPACE_DIR).toEqualTypeOf<string>();
        // any other name is still there to read, and may be unset
        expectTypeOf(ctx.envs.ANYTHING_ELSE).toEqualTypeOf<string | undefined>();
        expectTypeOf(ctx.tokens.tier).toEqualTypeOf<'dev'>();
        expectTypeOf(ctx).not.toHaveProperty('port');
        expectTypeOf(ctx).not.toHaveProperty('service');
        return { DATA_DIR: `/srv/${ctx.tokens.tier}`, MAYBE: ctx.envs.MAYBE };
      },
      services: {
        api: { deps: [{ service: 'web', wait: true }] },
        web: { healthcheck: 'http://localhost/health' },
      },
    });
    // The callback is context-sensitive; it must not cost the package names their narrowing.
    expectTypeOf(config.services).toHaveProperty('api');
    expectTypeOf(config.services).not.toHaveProperty('ghost');
  });

  test('types env.vars the same way, next to override', () => {
    defineConfig({
      serviceRootDir: 'packages',
      tokens: { tier: 'dev' },
      env: {
        vars: (ctx) => {
          expectTypeOf(ctx.envs).toEqualTypeOf<Envs>();
          expectTypeOf(ctx.tokens.tier).toEqualTypeOf<'dev'>();
          return { DATA_DIR: '/srv/data' };
        },
        override: ['NODE_OPTIONS'],
      },
      services: { api: {} },
    });
  });

  test('accepts a record, an undefined value included, and only strings otherwise', () => {
    type Opts = Parameters<typeof defineConfig<Record<never, never>, { api: unknown }>>[0];
    type Vars = Exclude<NonNullable<Opts['env']>, (...args: never[]) => unknown>['vars'];
    expectTypeOf<{ A: string; B: undefined }>().toExtend<Vars>();
    expectTypeOf<{ A: number }>().not.toExtend<Vars>();
    expectTypeOf<(ctx: { envs: Record<string, string> }) => { A: number }>().not.toExtend<Vars>();
  });

  test('exposes the resolved variables on the returned config', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      env: { vars: { DATA_DIR: '/srv/data' } },
      services: { api: {} },
    });
    expectTypeOf(config.envVars).toEqualTypeOf<Record<string, string> | undefined>();
  });

  test('hands an env.additionalFiles callback the mode, and gives back the file order', () => {
    const config = defineConfig({
      serviceRootDir: 'packages',
      env: {
        additionalFiles: (ctx) => {
          expectTypeOf(ctx.mode).toEqualTypeOf<Mode>();
          expectTypeOf(ctx).not.toHaveProperty('envs');
          return [{ file: `.env.${ctx.mode}.pre`, before: 'mode' }];
        },
      },
      services: { api: {} },
    });
    expectTypeOf(config.envFiles).toEqualTypeOf<EnvFileOrder>();
  });

  test('takes an additional file before or after one of the named anchors, never both', () => {
    expectTypeOf<{ file: string; before: 'mode' }>().toExtend<EnvAdditionalFile>();
    expectTypeOf<{ file: string; after: 'modeLocal'; scope: 'service' }>().toExtend<EnvAdditionalFile>(); // oxfmt-ignore
    expectTypeOf<{ file: string; before: 'mode'; after: 'local' }>().not.toExtend<EnvAdditionalFile>(); // oxfmt-ignore
    expectTypeOf<{ file: string }>().not.toExtend<EnvAdditionalFile>();
    expectTypeOf<{ file: string; before: '.env.local' }>().not.toExtend<EnvAdditionalFile>();
    expectTypeOf<{ file: string; before: 'mode'; scope: 'root' }>().not.toExtend<EnvAdditionalFile>(); // oxfmt-ignore
    type Opts = Parameters<typeof defineConfig<Record<never, never>, { api: unknown }>>[0];
    type Files = Exclude<
      NonNullable<Opts['env']>,
      (...args: never[]) => unknown
    >['additionalFiles'];
    expectTypeOf<EnvAdditionalFile[]>().toExtend<Files>();
    expectTypeOf<(ctx: { mode: Mode }) => EnvAdditionalFile[]>().toExtend<Files>();
    expectTypeOf<{ file: string; before: 'nope' }[]>().not.toExtend<Files>();
  });
});

// What a type accepts, with every function reduced to `'function'`. The input types give a
// callback a context typed from the config's own `tokens`; the schemas can only say "a function
// goes here", so that is all the comparison below can check of a callback.
type Shape<T> = T extends (...args: never[]) => unknown
  ? 'function'
  : T extends object
    ? { [K in keyof T]: Shape<T[K]> }
    : T;

// The input types at their widest — any service names, any tokens, with `serviceRootDir` set so
// `relativeDir` is optional, as the schema has it.
type WidestService = ServiceConfigInput<TokenRecord, TokenRecord, string, string>;
type WidestConfig = DefineConfigOptions<TokenRecord, Record<string, TokenRecord>, string, string>;
type SchemaService = z.input<typeof ServiceConfigSchema>;
type SchemaConfig = z.input<typeof DefineConfigSchema>;

describe('the input types and the schemas', () => {
  test('accept the same service fields', () => {
    expectTypeOf<Shape<Omit<WidestService, 'command'>>>().toEqualTypeOf<
      Shape<Omit<SchemaService, 'command'>>
    >();
  });

  test('accept the same top-level fields', () => {
    expectTypeOf<Shape<Omit<WidestConfig, 'services'>>>().toEqualTypeOf<
      Shape<Omit<SchemaConfig, 'services'>>
    >();
    expectTypeOf<keyof WidestConfig['services']>().toEqualTypeOf<keyof SchemaConfig['services']>();
  });

  // The structures a callback can return, or `buildAddress` takes, are checked against these
  // schemas at resolution as well as in the config.
  test('accept the same structures a callback returns', () => {
    expectTypeOf<z.input<typeof PublicAddressSchema>>().toEqualTypeOf<PublicAddress>();
    expectTypeOf<z.input<typeof PublicOriginInputSchema>>().toEqualTypeOf<PublicOriginInput>();
    expectTypeOf<z.input<typeof BuildAddressOptionsSchema>>().toEqualTypeOf<BuildAddressOptions>();
    expectTypeOf<z.input<typeof ReverseProxyTlsSchema>>().toEqualTypeOf<ReverseProxyTls>();
    expectTypeOf<z.input<typeof EnvAdditionalFileSchema>>().toEqualTypeOf<EnvAdditionalFile>();
    expectTypeOf<z.input<typeof ReverseProxyRouteSchema>>().toEqualTypeOf<ReverseProxyRoute>();
  });

  // Every command the input type accepts must pass the schema's shape.
  test('accept a command only in a form the schema takes', () => {
    expectTypeOf<WidestService['command']>().toExtend<SchemaService['command']>();
  });

  // The resolved type gives back some fields as the schema resolves them, and the rest settled by
  // `defineConfig` (callbacks run, `relativeDir` inferred). The first kind must match the schema's
  // output, and no schema field may be missing from it.
  test('give back the fields the schema resolves as it resolves them', () => {
    type FromSchema = 'selectable' | 'color' | 'autostart' | 'command' | 'logs';
    expectTypeOf<Pick<ResolvedServiceConfig<string>, FromSchema>>().toEqualTypeOf<
      Pick<z.output<typeof ServiceConfigSchema>, FromSchema>
    >();
    expectTypeOf<
      Exclude<keyof z.output<typeof ServiceConfigSchema>, keyof ResolvedServiceConfig<string>>
    >().toEqualTypeOf<never>();
  });
});

describe('infra hook context', () => {
  test('the command helper is named exec, with no run', () => {
    expectTypeOf<InfraReadyContext>().toHaveProperty('exec');
    expectTypeOf<InfraReadyContext>().not.toHaveProperty('run');
  });

  test("every hook gets the session's mode and the resolved config", () => {
    expectTypeOf<InfraCallbackContext['mode']>().toEqualTypeOf<Mode>();
    expectTypeOf<InfraCallbackContext['config']>().toEqualTypeOf<Config<string>>();
    expectTypeOf<InfraReadyContext['mode']>().toEqualTypeOf<Mode>();
    expectTypeOf<InfraReadyContext['config']>().toEqualTypeOf<Config<string>>();
    void ({
      beforeStart: ({ config, mode }) => {
        expectTypeOf(config.envMode).toEqualTypeOf<Mode>();
        expectTypeOf(mode).toEqualTypeOf<Mode>();
      },
      afterReady: ({ config }) => {
        expectTypeOf(config.services).toHaveProperty('anything');
      },
    } satisfies InfraServiceInput);
  });

  test('enabled gets the mode but no config: it runs while the config is still resolving', () => {
    expectTypeOf<InfraEnabledContext['mode']>().toEqualTypeOf<Mode>();
    expectTypeOf<InfraEnabledContext>().not.toHaveProperty('config');
  });
});

describe('resolveEnv', () => {
  test('takes only mode, target and workspaceDir', () => {
    expectTypeOf<NonNullable<Parameters<typeof resolveEnv>[0]>>().toEqualTypeOf<{
      mode?: string;
      target?: string;
      workspaceDir?: string;
    }>();
  });

  test('takes no argument at all', () => {
    expectTypeOf(resolveEnv).toBeCallableWith();
  });

  test('rejects a removed option, by name', () => {
    // @ts-expect-error `cwd` is not an option of resolveEnv
    resolveEnv({ cwd: '.' });
  });
});

describe('the SDK one-off types', () => {
  type OneOffOptions = {
    mode?: string;
    target?: string;
    workspaceDir?: string;
    stdio?: 'inherit' | 'pipe';
  };

  test('ExecOptions is the shared options and a command', () => {
    expectTypeOf<ExecOptions>().toEqualTypeOf<OneOffOptions & { command: [string, ...string[]] }>();
  });

  test('RunOptions is the shared options, a script and its arguments', () => {
    expectTypeOf<RunOptions>().toEqualTypeOf<OneOffOptions & { script: string; args?: string[] }>();
  });

  test('OneOffResult carries the exit, and the output only when piped', () => {
    expectTypeOf<OneOffResult>().toEqualTypeOf<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stdout?: string;
      stderr?: string;
    }>();
  });
});

describe('startStack', () => {
  test('takes workspaceDir, and no cwd', () => {
    expectTypeOf<StartStackOptions>().toHaveProperty('workspaceDir');
    expectTypeOf<StartStackOptions>().not.toHaveProperty('cwd');
  });
});

describe('the control API has no rebuild', () => {
  test('ServiceAction is start, stop and restart', () => {
    expectTypeOf<Extract<ServiceAction, 'rebuild'>>().toBeNever();
    expectTypeOf<ServiceAction>().toEqualTypeOf<'start' | 'stop' | 'restart'>();
  });

  test("SessionServiceStatus has no 'rebuilding'", () => {
    expectTypeOf<Extract<SessionServiceStatus, 'rebuilding'>>().toBeNever();
  });

  test("the control client's service commands have no rebuild", () => {
    expectTypeOf<ControlClient['command']['service']>().not.toHaveProperty('rebuild');
  });
});

describe('config split across files', () => {
  // A config's parts written apart from `defineConfig`, as a file of their own would export them,
  // checked with `satisfies`: names and callbacks are checked where the part is written, and the
  // part keeps its own literal type, so `defineConfig` infers from it as from an inline block.
  const tokens = { region: 'local' } as const;
  type Names = 'api' | 'worker';

  const queue = {
    afterReady: async (ctx) => {
      expectTypeOf(ctx).toEqualTypeOf<InfraReadyContext<typeof tokens>>();
      expectTypeOf(ctx.tokens.region).toEqualTypeOf<'local'>();
    },
  } satisfies InfraServiceInput<typeof tokens>;
  const infraServices = {
    db: {},
    queue,
    cache: {
      enabled: (ctx) => {
        expectTypeOf(ctx.mode).toEqualTypeOf<Mode>();
        return ctx.mode !== 'test';
      },
    },
  } satisfies InfraServicesInput<typeof tokens>;
  const api = { command: 'dev', deps: ['worker'] } satisfies ServiceInput<Names>;

  test('the parts are the types a config takes', () => {
    expectTypeOf<InfraServicesInput>().toEqualTypeOf<Record<string, InfraServiceInput>>();
    expectTypeOf<ServiceInput<Names>>().toEqualTypeOf<
      ServiceConfigInput<unknown, TokenRecord, Names, string>
    >();
    expectTypeOf<ReverseProxyRoute<Names>[]>().toExtend<
      NonNullable<ReverseProxyInput<TokenRecord, Names>['routes']>
    >();
    // `relativeDir` is left to `defineConfig`, which knows whether `serviceRootDir` infers it.
    expectTypeOf<ServiceInput>().toHaveProperty('relativeDir').toEqualTypeOf<string | undefined>();
  });

  test('parts checked with satisfies keep the inference of an inline config', () => {
    const config = defineConfig({
      serviceRootDir: 'apps',
      tokens,
      services: { api, worker: { command: 'dev' } },
      infra: { 'docker-compose': { services: infraServices } },
      reverseProxy: {
        port: 21060,
        publicAddress: { domain: 'example.localhost', scheme: 'http' },
        routes: [
          { subdomain: '*', paths: { '/graphql/**': 'api', '/queue/**': 'queue' } },
        ] satisfies ReverseProxyRoute<Names | 'queue'>[],
      },
    });
    const inline = defineConfig({
      serviceRootDir: 'apps',
      tokens,
      services: { api: { command: 'dev', deps: ['worker'] }, worker: { command: 'dev' } },
    });
    expectTypeOf(config.services.api).toEqualTypeOf<typeof inline.services.api>();
    // No `reverseProxy`: the part fits all the same.
    defineConfig({ services: { db: { relativeDir: 'db' } }, infra: { 'docker-compose': { services: infraServices } } }); // oxfmt-ignore
  });

  test('an annotation widens a part: its keys, which the routes are checked against, are lost', () => {
    // Why the docs say `satisfies`: annotated, the map's keys are any string, so the infra names
    // `reverseProxy.routes` may name are too, and a misspelled one compiles.
    const annotated: InfraServicesInput<typeof tokens> = infraServices;
    const widened = defineConfig({
      serviceRootDir: 'apps',
      services: { web: {} },
      infra: { 'docker-compose': { services: annotated } },
    });
    expectTypeOf<keyof NonNullable<NonNullable<typeof widened.infra>['docker-compose']>['services']>().toEqualTypeOf<string>(); // oxfmt-ignore
    const kept = defineConfig({
      serviceRootDir: 'apps',
      services: { web: {} },
      infra: { 'docker-compose': { services: infraServices } },
    });
    expectTypeOf<keyof NonNullable<NonNullable<typeof kept.infra>['docker-compose']>['services']>().toEqualTypeOf<'db' | 'queue' | 'cache'>(); // oxfmt-ignore
  });

  test('a misspelled name fails where the part is written', () => {
    // @ts-expect-error -- 'wrker' is not one of `Names` (TS2820), the only error on this line.
    void ({ command: 'dev', deps: ['wrker'] } satisfies ServiceInput<Names>);
    // @ts-expect-error -- `afterReadyy` is not an infra service option (TS2561).
    void ({ afterReadyy: async () => {} } satisfies InfraServiceInput);
  });
});
