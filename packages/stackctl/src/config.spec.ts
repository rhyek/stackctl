import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import primitives from '@dotenvx/primitives';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  type AnyServiceConfig,
  type BuildAddressOptions,
  type Config,
  type PublicOriginInput,
  type ReverseProxyInput,
  type ReverseProxyRoute,
  defineConfig,
  proxyKeyAndCert,
  findService,
  getRegisteredPackages,
  getLoadedConfig,
  getWorkspaceDir,
  getDevScript,
  infraServiceDetails,
  proxyHostsFor,
} from './config.js';
import { packageEnvLayer } from './env.js';

/** `defineConfig`'s options as seen with `serviceRootDir` set (so `relativeDir` is optional). */
type RootedOpts = Parameters<
  typeof defineConfig<Record<never, never>, Record<string, unknown>, string, 'packages'>
>[0];

describe('command / autostart', () => {
  test('resolves an omitted command to the `dev` default', () => {
    const packages = Object.values(
      defineConfig({ serviceRootDir: 'packages', services: { svc: {} } }).services,
    );
    expect(packages[0]!.command).toEqual({ name: 'dev', watches: true });
  });

  test('passes `command: null` through (no dev process)', () => {
    const packages = Object.values(
      defineConfig({ serviceRootDir: 'packages', services: { lib: { command: null } } }).services,
    );
    expect(packages[0]!.command).toBeNull();
  });

  test('honors autostart and leaves it undefined (⇒ true) by default', () => {
    const packages = Object.values(
      defineConfig({ serviceRootDir: 'packages', services: { a: { autostart: false }, b: {} } })
        .services,
    );
    expect(packages[0]!.autostart).toBe(false);
    expect(packages[1]!.autostart).toBeUndefined();
  });
});

describe('defineConfig path resolution', () => {
  test('infers relativeDir from serviceRootDir + key, resolving path against cwd', () => {
    const cfg = defineConfig({ serviceRootDir: 'apps', services: { svc: {}, '@scope/x': {} } });
    expect(cfg.services.svc.relativeDir).toBe('apps/svc');
    expect(cfg.services.svc.absoluteDir).toBe(path.resolve(process.cwd(), 'apps/svc'));
    expect(cfg.services['@scope/x'].relativeDir).toBe('apps/@scope/x');
  });

  test('normalizes a trailing slash on serviceRootDir', () => {
    const cfg = defineConfig({ serviceRootDir: 'apps/', services: { svc: {} } });
    expect(cfg.services.svc.relativeDir).toBe('apps/svc');
  });

  test('lets relativeDir override the inferred directory', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: { svc: { relativeDir: 'apps/svc' }, other: {} },
    });
    expect(cfg.services.svc.relativeDir).toBe('apps/svc');
    expect(cfg.services.other.relativeDir).toBe('packages/other');
  });

  test('requires relativeDir when there is no serviceRootDir, naming the package', () => {
    expect(() =>
      // @ts-expect-error relativeDir is required without serviceRootDir
      defineConfig({ services: { svc: { port: 3000 } } }),
    ).toThrow(/svc has no `relativeDir`, and the config sets no `serviceRootDir` to infer it from/);
  });

  test('honors explicit relativeDir and workspaceDir', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: '/repo',
        services: { svc: { relativeDir: 'apps/svc' } },
      }).services,
    );
    expect(packages[0]!.absoluteDir).toBe(path.resolve('/repo', 'apps/svc'));
  });
});

describe('meta defaults', () => {
  test('leaves apiPort undefined when unset (random port chosen at startup)', () => {
    const cfg = defineConfig({ serviceRootDir: 'packages', services: { svc: {} } });
    expect(cfg.apiPort).toBeUndefined();
  });

  test('passes through a pinned apiPort and exposes it via getLoadedConfig', () => {
    const cfg = defineConfig({ serviceRootDir: 'packages', apiPort: 5000, services: { svc: {} } });
    expect(cfg.apiPort).toBe(5000);
    expect(getLoadedConfig()?.apiPort).toBe(5000);
  });

  test("defaults envFiles to the development profile's set", () => {
    const cfg = defineConfig({ serviceRootDir: 'packages', services: { svc: {} } });
    const files = ['.env', '.env.local', '.env.development', '.env.development.local'];
    expect(cfg.envFiles).toEqual({ workspace: files, service: files });
    expect(cfg.profile).toBe('development');
  });

  test('follows STACKCTL_PROFILE for both envFiles and profile', () => {
    process.env.STACKCTL_PROFILE = 'test';
    try {
      const cfg = defineConfig({ serviceRootDir: 'packages', services: { svc: {} } });
      const files = ['.env', '.env.local', '.env.test', '.env.test.local'];
      expect(cfg.envFiles).toEqual({ workspace: files, service: files });
      expect(cfg.profile).toBe('test');
    } finally {
      delete process.env.STACKCTL_PROFILE;
    }
  });

  test('rejects the removed env.files option instead of silently ignoring it', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error - `files` was removed; the schema must say so rather than strip it.
        env: { files: ['.env', '.env.test'] },
        services: { svc: {} },
      }),
    ).toThrow(/Invalid key: Expected never but received "files"/);
  });

  test('carries env.override through to the resolved config', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      env: { override: ['NODE_OPTIONS'] },
      services: { svc: {} },
    });
    expect(cfg.envOverride).toEqual(['NODE_OPTIONS']);
  });

  test('carries env.decrypt through to the resolved config, off unless set', () => {
    const decrypting = (env?: { decrypt: boolean }) =>
      defineConfig({ serviceRootDir: 'packages', env, services: { svc: {} } }).envDecrypt;
    expect(decrypting()).toBe(false);
    expect(decrypting({ decrypt: true })).toBe(true);
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error - `decrypt` is a boolean.
        env: { decrypt: 'yes' },
        services: { svc: {} },
      }),
    ).toThrow('env.decrypt: Invalid type: Expected boolean but received "yes"');
  });

  test('defaults logTimestamps to true', () => {
    const cfg = defineConfig({ serviceRootDir: 'packages', services: { svc: {} } });
    expect(cfg.logTimestamps).toBe(true);
  });

  test('honors a logs.timestamps override', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      logs: { timestamps: false },
      services: { svc: {} },
    });
    expect(cfg.logTimestamps).toBe(false);
  });
});

describe('logs (per-package)', () => {
  test('passes a logs.formatter through unchanged (not a validating wrapper)', () => {
    const fmt = (line: string): string => `[fmt] ${line}`;
    const packages = Object.values(
      defineConfig({ serviceRootDir: 'packages', services: { svc: { logs: { formatter: fmt } } } })
        .services,
    );
    expect(packages[0]!.logs?.formatter).toBe(fmt);
    expect(packages[0]!.logs?.formatter!('hi')).toBe('[fmt] hi');
  });

  test('stores a package-level logs.timestamps override', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        services: { a: { logs: { timestamps: true } }, b: {} },
      }).services,
    );
    expect(packages[0]!.logs?.timestamps).toBe(true);
    expect(packages[1]!.logs).toBeUndefined();
  });

  test('leaves logs undefined when not set', () => {
    const packages = Object.values(
      defineConfig({ serviceRootDir: 'packages', services: { svc: {} } }).services,
    );
    expect(packages[0]!.logs).toBeUndefined();
  });

  test('rejects a non-function logs.formatter', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error logs.formatter must be a function
        services: { svc: { logs: { formatter: 'nope' } } },
      }),
    ).toThrow(/logs\.formatter/);
  });
});

describe('tokens', () => {
  test('merges the package tokens over the config tokens, package winning', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        tokens: { domain: 'example.com', scheme: 'https' },
        services: {
          api: {
            tokens: { region: 'us-east', scheme: 'http' },
            healthcheck: ({ tokens }) => `${tokens.scheme}://${tokens.region}.${tokens.domain}`,
          },
        },
      }).services,
    );
    expect(packages[0]!.healthcheck?.url).toBe('http://us-east.example.com');
  });

  test('keeps one package tokens out of another package', () => {
    const seen: (string | undefined)[] = [];
    defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: { tokens: { region: 'us-east' } },
        web: {
          healthcheck: ({ tokens }) => {
            seen.push((tokens as Record<string, string | undefined>).region);
            return 'http://localhost/health';
          },
        },
      },
    });
    expect(seen).toEqual([undefined]);
  });

  test('gives a package with no tokens of its own just the config tokens', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        tokens: { domain: 'example.com' },
        services: { web: { healthcheck: ({ tokens }) => `https://${tokens.domain}` } },
      }).services,
    );
    expect(packages[0]!.healthcheck?.url).toBe('https://example.com');
  });

  test('hands workspace-wide urls only the config tokens', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.com' },
      urls: [({ tokens }) => `https://status.${tokens.domain}`],
      services: { api: { tokens: { region: 'us-east' } } },
    });
    expect(cfg.urls![0]).toBe('https://status.example.com');
  });

  // The type-level half of the feature. vitest does not typecheck, so these are enforced by
  // `tsc -p packages/stackctl/tsconfig.json` — the `@ts-expect-error`s fail the typecheck if
  // the inference regresses. See docs/config/config-file.md#callbacks.
  // Asserted by tsc, not at run time.
  // oxlint-disable-next-line vitest/expect-expect
  test('types each package tokens from what it declares', () => {
    defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.com' },
      services: {
        api: {
          tokens: { region: 'us-east' },
          // both the config token and this package's own are known keys
          healthcheck: ({ tokens }) => `https://${tokens.region}.${tokens.domain}`,
        },
        web: {
          // @ts-expect-error `region` is the api package's token, not this one's
          urls: [({ tokens }) => `https://${tokens.region}`],
        },
        edge: {
          // @ts-expect-error no token named `nope` anywhere
          healthcheck: ({ tokens }) => `https://${tokens.nope}`,
        },
      },
    });
  });

  // The regression this whole shape exists to prevent: a package that declares NO tokens must
  // not make its siblings' tokens fall back to a permissive record. `P` is constrained to
  // `Record<K, unknown>` (not `Record<K, TokenRecord>`) precisely so the inference survives —
  // TypeScript replaces an inference that fails its constraint with the constraint itself.
  // Asserted by tsc, not at run time.
  // oxlint-disable-next-line vitest/expect-expect
  test('keeps sibling tokens exact when a package omits tokens entirely', () => {
    defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.com' },
      services: {
        // declares tokens, and still gets exact types despite the siblings below
        api: {
          tokens: { region: 'us-east' },
          healthcheck: ({ tokens }) => `https://${tokens.region}.${tokens.domain}`,
        },
        // no `tokens` key at all — not even `{}`
        web: {
          healthcheck: ({ tokens }) => `https://${tokens.domain}`,
        },
        edge: {
          // @ts-expect-error still exact: no fallback to a permissive record
          healthcheck: ({ tokens }) => `https://${tokens.anything}`,
        },
      },
    });
  });

  // Rejected at both layers: a compile error at the declaration (the `@ts-expect-error`) and
  // a load-time error from the schema, for configs that reach `defineConfig` unchecked.
  test('rejects a non-string token value', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: {
          // @ts-expect-error token values must be strings
          api: { tokens: { port: 8080 } },
        },
      }),
    ).toThrow(/tokens\.port/);
  });

  test('type-checks deps against the package keys', () => {
    // The valid direction compiles and loads.
    defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: { healthcheck: 'http://localhost/health' },
        web: { deps: [{ service: 'api', wait: true }] },
      },
    });
    // The invalid direction is a compile error *and* a load-time error.
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: {
          api: {},
          edge: {
            // @ts-expect-error no package named `ghost`
            deps: [{ service: 'ghost', wait: true }],
          },
        },
      }),
    ).toThrow(/deps "ghost"/);
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: {
          api: {},
          edge: {
            // @ts-expect-error no package named `nope`
            deps: ['nope'],
          },
        },
      }),
    ).toThrow(/deps "nope"/);
  });
});

describe('package keys', () => {
  test('rejects an integer-like package name (JS would reorder the keys)', () => {
    expect(() => defineConfig({ serviceRootDir: 'packages', services: { 2: {} } })).toThrow(
      /is a number/,
    );
  });

  test('preserves declaration order of the keys', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: { zebra: {}, alpha: {}, middle: {} },
    });
    expect(Object.keys(cfg.services)).toEqual(['zebra', 'alpha', 'middle']);
  });

  test('exposes each package resolved tokens on the config', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.com' },
      services: { api: { tokens: { region: 'us-east' } }, web: {} },
    });
    expect(cfg.services.api.tokens).toEqual({ domain: 'example.com', region: 'us-east' });
    expect(cfg.services.web.tokens).toEqual({ domain: 'example.com' });
  });
});

describe('url/healthcheck callbacks', () => {
  test('resolves a healthcheck callback with the package port', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        services: {
          core: { port: 3001, healthcheck: ({ port }) => `http://localhost:${port}/health` },
        },
      }).services,
    );
    expect(packages[0]!.healthcheck?.url).toBe('http://localhost:3001/health');
  });

  test('hands the config tokens to a callback (string and object urls)', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        tokens: { domain: 'example.com', proxyport: '8443' },
        services: {
          web: {
            urls: [
              {
                label: 'home',
                url: ({ tokens }) => `https://app.${tokens.domain}:${tokens.proxyport}`,
              },
            ],
          },
        },
      }).services,
    );
    expect(packages[0]!.urls![0]).toEqual({ label: 'home', url: 'https://app.example.com:8443' });
  });

  test('resolves callbacks inside a per-package array (same-line) url entry, keeping its shape', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        tokens: { domain: 'example.com' },
        services: {
          web: {
            port: 3000,
            urls: [
              [
                ({ port }) => `http://localhost:${port}`,
                { label: 'app', url: ({ tokens }) => `https://app.${tokens.domain}` },
              ],
            ],
          },
        },
      }).services,
    );
    expect(packages[0]!.urls![0]).toEqual([
      'http://localhost:3000',
      { label: 'app', url: 'https://app.example.com' },
    ]);
  });

  test('passes a literal string through untouched, `$` and all', () => {
    // Interpolation is gone: a `$port` in a literal is just a character sequence now.
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        services: {
          core: {
            port: 3001,
            healthcheck: 'http://localhost:$port/health',
            urls: ['https://example.test/$name'],
          },
        },
      }).services,
    );
    expect(packages[0]!.healthcheck?.url).toBe('http://localhost:$port/health');
    expect(packages[0]!.urls![0]).toBe('https://example.test/$name');
  });

  test('reports the package and field when a callback returns a non-string', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error a url callback must return a string
        services: { core: { port: 3001, healthcheck: ({ port }) => port } },
      }),
    ).toThrow(/core healthcheck: callback returned 3001/);
  });

  // `port` is typed `number` for callbacks, which the type system can't verify (the one
  // inference channel goes to `tokens`). Reading it on a package that declares none therefore
  // fails at load time, naming the package — rather than interpolating `undefined` into a URL.
  test('throws, naming the package, when a callback reads a port the package has not declared', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: {
          core: {
            healthcheck: ({ port }) => `http://localhost:${port}/health`,
          },
        },
      }),
    ).toThrow(/core: a callback read `port`, but this service declares no `port`/);
  });

  test('leaves a portless package alone when its callbacks never read the port', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { host: 'example.test' },
      services: {
        core: { selectable: true, healthcheck: ({ tokens }) => `https://${tokens.host}/health` },
      },
    });
    expect(cfg.services.core.healthcheck?.url).toBe('https://example.test/health');
    expect(cfg.services.core.port).toBeUndefined();
  });
});

describe('healthcheck', () => {
  const health = (api: RootedOpts['services'][string]) =>
    Object.values(
      // tsc rejects `{ api }` without the cast.
      defineConfig({ serviceRootDir: 'packages', services: { api } as RootedOpts['services'] })
        .services,
    )[0]!.healthcheck;

  test('normalizes a bare URL to `{ url, timeout }` with the default timeout', () => {
    expect(health({ healthcheck: 'http://localhost/health' })).toEqual({
      url: 'http://localhost/health',
      timeout: 1500,
    });
  });

  test('takes the URL and timeout from the object form', () => {
    expect(health({ healthcheck: { url: 'http://localhost/health', timeout: 10_000 } })).toEqual({
      url: 'http://localhost/health',
      timeout: 10_000,
    });
  });

  test('resolves a callback inside the object form, with the package context', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { host: 'api.internal' },
      services: {
        api: {
          port: 4321,
          healthcheck: {
            url: ({ port, tokens }) => `http://${tokens.host}:${port}/health`,
            timeout: 4000,
          },
        },
      },
    });
    expect(cfg.services.api.healthcheck).toEqual({
      url: 'http://api.internal:4321/health',
      timeout: 4000,
    });
  });

  test('defaults the timeout when the object form omits it', () => {
    expect(health({ healthcheck: { url: 'http://localhost/health' } })).toEqual({
      url: 'http://localhost/health',
      timeout: 1500,
    });
  });

  test('names the package and field when a callback in the object form returns a non-string', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error a url callback must return a string
        services: { api: { port: 3001, healthcheck: { url: ({ port }) => port } } },
      }),
    ).toThrow(/api healthcheck: callback returned 3001/);
  });

  test('rejects a misspelled key rather than silently keeping the default', () => {
    expect(
      () =>
        defineConfig({
          serviceRootDir: 'packages',
          // @ts-expect-error `timout` is not a healthcheck option
          services: { api: { healthcheck: { url: 'http://localhost/health', timout: 9000 } } },
        }),
      // The object form's own error, not "expected a URL or an object".
    ).toThrow(
      'invalid stackctl config:\n  - services.api.healthcheck.timout: Invalid key: Expected never but received "timout"',
    );
  });

  test('rejects a non-positive or fractional timeout', () => {
    for (const timeout of [0, -1, 1.5]) {
      expect(() =>
        defineConfig({
          serviceRootDir: 'packages',
          services: { api: { healthcheck: { url: 'http://localhost/health', timeout } } },
        }),
      ).toThrow(/invalid stackctl config/);
    }
  });

  test('satisfies a wait on a healthcheck declared in the object form', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: {
          api: { healthcheck: { url: 'http://localhost/health', timeout: 3000 } },
          web: { deps: [{ service: 'api', wait: true }] },
        },
      }),
    ).not.toThrow();
  });
});

describe('top-level urls', () => {
  test('resolves a callback in a bare-string top-level url', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.com' },
      urls: [({ tokens }) => `https://grafana.${tokens.domain}`],
      services: { svc: {} },
    });
    expect(cfg.urls![0]).toBe('https://grafana.example.com');
  });

  test('resolves a callback in an object top-level url and keeps the label', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.com', proxyport: '8443' },
      urls: [
        {
          label: 'Grafana',
          url: ({ tokens }) => `https://grafana.${tokens.domain}:${tokens.proxyport}`,
        },
      ],
      services: { svc: {} },
    });
    expect(cfg.urls![0]).toEqual({ label: 'Grafana', url: 'https://grafana.example.com:8443' });
  });

  test('resolves callbacks inside a top-level array (same-line) url entry, keeping its shape', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { domain: 'example.com' },
      urls: [
        [
          ({ tokens }) => `https://grafana.${tokens.domain}`,
          { label: 'Logs', url: ({ tokens }) => `https://logs.${tokens.domain}` },
        ],
      ],
      services: { svc: {} },
    });
    expect(cfg.urls![0]).toEqual([
      'https://grafana.example.com',
      { label: 'Logs', url: 'https://logs.example.com' },
    ]);
  });

  test('leaves a literal top-level url verbatim', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      urls: ['https://dashboard.internal'],
      services: { svc: {} },
    });
    expect(cfg.urls![0]).toBe('https://dashboard.internal');
  });

  test('leaves urls undefined when none are given', () => {
    const cfg = defineConfig({ serviceRootDir: 'packages', services: { svc: {} } });
    expect(cfg.urls).toBeUndefined();
  });

  test('throws when a top-level url callback reads a port (those links have no package)', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error a workspace-wide url has no package, so no `port` in its context
        urls: [({ port }) => `http://localhost:${port}`],
        services: { svc: { port: 3001 } },
      }),
    ).toThrow(/those links belong to no service/);
  });
});

describe('command', () => {
  const cmd = (fields: object) =>
    Object.values(
      defineConfig({ serviceRootDir: 'packages', services: { a: { ...fields } } }).services,
    )[0]!.command;

  test('defaults to dev / watches:true when omitted', () => {
    expect(cmd({})).toEqual({ name: 'dev', watches: true });
  });

  test('accepts a bare string (defaults watches:true)', () => {
    expect(cmd({ command: 'start' })).toEqual({ name: 'start', watches: true });
  });

  test('a tuple keeps watches:false', () => {
    expect(cmd({ command: ['start', { watches: false }] })).toEqual({
      name: 'start',
      watches: false,
    });
  });

  test('an empty options object defaults to watches:true', () => {
    expect(cmd({ command: ['start', {}] })).toEqual({ name: 'start', watches: true });
  });

  test('rejects command builds and cleans', () => {
    for (const key of ['builds', 'cleans']) {
      expect(() => cmd({ command: ['dev', { watches: true, [key]: true }] })).toThrow(
        new RegExp(
          `services\\.a\\.command\\.1\\.${key}: Invalid key: Expected never but received "${key}"`,
        ),
      );
    }
  });

  test('rejects a command with more than a name and its options', () => {
    expect(() => cmd({ command: ['dev', {}, 'extra'] })).toThrow(
      'services.a.command.2: Invalid type: Expected never but received "extra"',
    );
  });

  test('getDevScript returns the configured command name, else dev', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        services: { a: { command: 'start' }, b: {}, c: {} },
      }).services,
    );
    expect(getDevScript(packages[0]!)).toBe('start');
    expect(getDevScript(packages[1]!)).toBe('dev');
    expect(getDevScript(packages[2]!)).toBe('dev');
  });
});

describe('validation', () => {
  const define = (opts: unknown) => () => defineConfig(opts as Parameters<typeof defineConfig>[0]);

  test('rejects a number that is Infinity or NaN', () => {
    for (const port of [Infinity, NaN]) {
      expect(define({ serviceRootDir: 'packages', apiPort: port, services: {} })).toThrow(
        'invalid stackctl config:\n  - apiPort: Invalid',
      );
      expect(define({ serviceRootDir: 'packages', services: { api: { port } } })).toThrow(
        'invalid stackctl config:\n  - services.api.port: Invalid',
      );
    }
  });

  test('rejects the object form of `deps`', () => {
    for (const deps of [{ runtime: ['lib'] }, { build: ['lib'] }]) {
      expect(define({ serviceRootDir: 'packages', services: { lib: {}, api: { deps } } })).toThrow(
        'services.api.deps: Invalid type: Expected (Array | Function) but received Object',
      );
    }
  });

  test('rejects a removed service key', () => {
    for (const [key, value] of [
      ['waitFor', ['api']],
      ['tsconfig', 'x.json'],
      ['subdomain', 'api'],
      ['shortName', 'w'],
    ] as const) {
      expect(
        define({ serviceRootDir: 'packages', services: { api: {}, web: { [key]: value } } }),
      ).toThrow(
        new RegExp(`services\\.web\\.${key}: Invalid key: Expected never but received "${key}"`),
      );
    }
  });

  test('rejects an unknown top-level key', () => {
    expect(define({ services: {}, packages: {} })).toThrow(
      /Invalid key: Expected never but received "packages"/,
    );
  });

  test('rejects a key once listed as renamed', () => {
    const error = (() => {
      try {
        defineConfig({
          services: { web: { relativeDir: 'web', port: 3000 } },
          reverseProxy: {
            port: 4000,
            publicAddress: { domain: 'localhost', scheme: 'http', port: 4000 },
            defaultPackage: 'web',
          },
        } as unknown as Parameters<typeof defineConfig>[0]);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    expect(error).toMatch(
      /reverseProxy\.defaultPackage: Invalid key: Expected never but received "defaultPackage"/,
    );
    expect(error).not.toMatch(/spelled|renamed|was removed/);
  });

  test('throws when a wait targets a package without a healthcheck', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: { a: { deps: [{ service: 'b', wait: true }] }, b: {} },
      }),
    ).toThrow('a waits for "b" (deps), but that service has no `healthcheck` to wait on.');
  });

  test('a dep without `wait` needs no healthcheck', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: { a: { deps: ['b', { service: 'c' }] }, b: {}, c: {} },
    });
    expect(cfg.services.a.deps).toEqual([
      { service: 'b', wait: false },
      { service: 'c', wait: false },
    ]);
  });

  test('throws when a dep names a missing package, naming it', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error also a compile error — the load-time check is the backstop
        services: { a: { deps: ['ghost'] } },
      }),
    ).toThrow(/a has deps "ghost" but no such service exists/);
  });

  test('accepts deps that name real packages', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        services: { a: { deps: ['b'] }, b: {} },
      }).services,
    );
    expect(packages[0]!.deps).toEqual([{ service: 'b', wait: false }]);
  });
});

describe('deps as a callback', () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-deps-'));
    fs.mkdirSync(path.join(ws, 'packages/api'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    delete process.env.STACKCTL_PROFILE;
  });

  /**
   * The config a profile-keyed callback gives in `profile`: `api` needs `codegen` outside `test`.
   */
  function inMode(profile: string) {
    process.env.STACKCTL_PROFILE = profile;
    return defineConfig({
      serviceRootDir: 'packages',
      workspaceDir: ws,
      services: {
        api: { deps: ({ profile }) => (profile === 'test' ? ['gateway'] : ['codegen', 'gateway']) },
        codegen: {},
        gateway: {},
      },
    });
  }

  test("gets the session's profile and the service's resolved envs and tokens", () => {
    process.env.STACKCTL_PROFILE = 'test';
    fs.writeFileSync(path.join(ws, 'packages/api/.env.test'), 'GATEWAY=on\n');
    const seen: unknown[] = [];
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      workspaceDir: ws,
      tokens: { region: 'eu' },
      services: {
        api: {
          deps: ({ profile, envs, tokens }) => {
            seen.push({ profile, gateway: envs.GATEWAY, region: tokens.region });
            return envs.GATEWAY === 'on' ? [{ service: 'gateway', wait: true }] : [];
          },
        },
        gateway: { healthcheck: 'http://localhost:21050/' },
      },
    });
    expect(seen).toEqual([{ profile: 'test', gateway: 'on', region: 'eu' }]);
    expect(cfg.services.api.deps).toEqual([{ service: 'gateway', wait: true }]);
  });

  test('resolves to the profile it runs in', () => {
    expect(inMode('development').services.api.deps).toEqual([
      { service: 'codegen', wait: false },
      { service: 'gateway', wait: false },
    ]);
    expect(inMode('test').services.api.deps).toEqual([{ service: 'gateway', wait: false }]);
  });

  test('a name it returns that is no service fails at load, as the array form does', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        // @ts-expect-error also a compile error — the load-time check is the backstop
        services: { api: { deps: () => ['ghost'] } },
      }),
    ).toThrow(/api has deps "ghost" but no such service exists/);
  });

  test('a wait it returns on a service with no healthcheck fails at load', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { deps: () => [{ service: 'gateway', wait: true }] }, gateway: {} },
      }),
    ).toThrow('api waits for "gateway" (deps), but that service has no `healthcheck` to wait on.');
  });

  test('one that throws fails with the error and the service name', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: {
          api: {
            deps: () => {
              throw new Error('GATEWAY_URL is not set');
            },
          },
        },
      }),
    ).toThrow('api: the `deps` callback threw: GATEWAY_URL is not set');
  });

  test('a malformed entry fails at its path, from the array form and the callback alike', () => {
    const entry = { service: 'gateway', wiat: true };
    for (const deps of [[entry], () => [entry]]) {
      expect(() =>
        defineConfig({
          serviceRootDir: 'packages',
          workspaceDir: ws,
          // `as never`: a config that reaches stackctl unchecked (plain JS).
          services: { api: { deps: deps as never }, gateway: {} },
        }),
      ).toThrow('services.api.deps.0.wiat: Invalid key: Expected never but received "wiat"');
    }
  });

  test('one that returns no array fails, naming the service', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        // @ts-expect-error the callback must return the entries
        services: { api: { deps: () => 'gateway' }, gateway: {} },
      }),
    ).toThrow('api: the `deps` callback returned gateway, not an array');
  });
});

describe('registry + findService', () => {
  test('populates the registry on define and looks packages up by name', () => {
    defineConfig({ serviceRootDir: 'packages', services: { alpha: {}, beta: {} } });
    expect(getRegisteredPackages().map((p) => p.name)).toEqual(
      expect.arrayContaining(['alpha', 'beta']),
    );
    expect(findService('alpha').name).toBe('alpha');
  });

  test('throws for an unknown package', () => {
    defineConfig({ serviceRootDir: 'packages', services: { alpha: {} } });
    expect(() => findService('nope')).toThrow(/nope/);
  });
});

describe('port callback', () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-port-'));
    fs.mkdirSync(path.join(ws, 'packages/api'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    delete process.env.STACKCTL_TEST_PORT;
  });

  test('resolves the port from a workspace-scope env file', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'BACKEND_PORT=4321\n');
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { port: ({ envs }) => Number(envs.BACKEND_PORT) } },
      }).services,
    );
    expect(packages[0]!.port).toBe(4321);
  });

  test('resolves the port from process.env when no file defines it', () => {
    process.env.STACKCTL_TEST_PORT = '5555';
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { port: ({ envs }) => Number(envs.STACKCTL_TEST_PORT) } },
      }).services,
    );
    expect(packages[0]!.port).toBe(5555);
  });

  test('lets an ambient var win over an env file of the same name', () => {
    process.env.STACKCTL_TEST_PORT = '5555';
    fs.writeFileSync(path.join(ws, '.env.development'), 'STACKCTL_TEST_PORT=6666\n');
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { port: ({ envs }) => Number(envs.STACKCTL_TEST_PORT) } },
      }).services,
    );
    expect(packages[0]!.port).toBe(5555);
  });

  test('lets env.override hand the file the win back', () => {
    process.env.STACKCTL_TEST_PORT = '5555';
    fs.writeFileSync(path.join(ws, '.env.development'), 'STACKCTL_TEST_PORT=6666\n');
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        env: { override: ['STACKCTL_TEST_PORT'] },
        services: { api: { port: ({ envs }) => Number(envs.STACKCTL_TEST_PORT) } },
      }).services,
    );
    expect(packages[0]!.port).toBe(6666);
  });

  test('decrypts an encrypted value for the callbacks with env.decrypt, and only then', () => {
    const { publicKey, privateKey } = primitives.keypair();
    fs.writeFileSync(
      path.join(ws, '.env.development'),
      `BACKEND_PORT="${primitives.encrypt(publicKey, '4321')}"\n`,
    );
    fs.writeFileSync(path.join(ws, '.env.keys'), `DOTENV_PRIVATE_KEY="${privateKey}"\n`);
    const port = (decrypt: boolean) =>
      Object.values(
        defineConfig({
          serviceRootDir: 'packages',
          workspaceDir: ws,
          env: { decrypt },
          services: { api: { port: ({ envs }) => Number(envs.BACKEND_PORT) || 1 } },
        }).services,
      )[0]!.port;
    expect(port(true)).toBe(4321);
    expect(port(false)).toBe(1);
  });

  test('lets a package-scope env file override the workspace-scope one', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'BACKEND_PORT=4321\n');
    fs.writeFileSync(path.join(ws, 'packages/api/.env.development'), 'BACKEND_PORT=7777\n');
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { port: ({ envs }) => Number(envs.BACKEND_PORT) } },
      }).services,
    );
    expect(packages[0]!.port).toBe(7777);
  });

  test('reads the profile-specific file for the active profile', () => {
    process.env.STACKCTL_PROFILE = 'test';
    try {
      fs.writeFileSync(path.join(ws, '.env.test'), 'BACKEND_PORT=8888\n');
      fs.writeFileSync(path.join(ws, '.env.development'), 'BACKEND_PORT=4321\n');
      const packages = Object.values(
        defineConfig({
          serviceRootDir: 'packages',
          workspaceDir: ws,
          services: { api: { port: ({ envs }) => Number(envs.BACKEND_PORT) } },
        }).services,
      );
      expect(packages[0]!.port).toBe(8888);
    } finally {
      delete process.env.STACKCTL_PROFILE;
    }
  });

  test('feeds the resolved port into the healthcheck/urls callbacks', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'BACKEND_PORT=4321\n');
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: {
          api: {
            port: ({ envs }) => Number(envs.BACKEND_PORT),
            healthcheck: ({ port }) => `http://localhost:${port}/health`,
            urls: [({ port }) => `http://localhost:${port}/todos`],
          },
        },
      }).services,
    );
    expect(packages[0]!.healthcheck?.url).toBe('http://localhost:4321/health');
    expect(packages[0]!.urls).toEqual(['http://localhost:4321/todos']);
  });

  test('hands the same resolved env to a healthcheck callback', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'PUBLIC_HOST=api.internal\n');
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: {
          api: { port: 3001, healthcheck: ({ envs }) => `http://${envs.PUBLIC_HOST}/health` },
        },
      }).services,
    );
    expect(packages[0]!.healthcheck?.url).toBe('http://api.internal/health');
  });

  test('treats an undefined return as no port', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { port: () => undefined } },
      }).services,
    );
    expect(packages[0]!.port).toBeUndefined();
  });

  test('throws when a callback returns NaN, naming the package and the env files', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'OTHER=1\n');
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { port: ({ envs }) => Number(envs.BACKEND_PORT) } },
      }),
    ).toThrow(/api: port callback returned NaN[\s\S]*\.env\.development/);
  });

  test('says so when no env file was found at all', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { port: ({ envs }) => Number(envs.BACKEND_PORT) } },
      }),
    ).toThrow(/no env files were found/);
  });

  test('still accepts a literal numeric port', () => {
    const packages = Object.values(
      defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: ws,
        services: { api: { port: 3001, healthcheck: 'http://localhost:3001/health' } },
      }).services,
    );
    expect(packages[0]!.port).toBe(3001);
    expect(packages[0]!.healthcheck?.url).toBe('http://localhost:3001/health');
  });
});

describe('getWorkspaceDir', () => {
  test('reports the root package paths resolved against, not the config file directory', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-ws-')));
    defineConfig({ serviceRootDir: 'packages', workspaceDir: dir, services: { svc: {} } });
    try {
      // What decides whether a port holder belongs to this workspace — a config living in a
      // subdirectory can point `workspaceDir` somewhere else entirely.
      expect(getWorkspaceDir()).toBe(path.resolve(dir));
      expect(getRegisteredPackages()[0]!.absoluteDir).toBe(path.join(dir, 'packages/svc'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('defaults to the process cwd', () => {
    defineConfig({ serviceRootDir: 'packages', services: { svc: {} } });
    expect(getWorkspaceDir()).toBe(path.resolve(process.cwd()));
  });
});

// `reverseProxy.routes`: an ordered list of host rules, like a Kubernetes ingress. stackctl checks
// each entry, settles its `subdomain` as a list, and gives each service it names a route (and a
// public origin) or none. How a request is matched against the list is in dev-reverse-proxy.spec.
describe('reverseProxy.routes', () => {
  /** A proxy on 4000 whose public address is example.test over plain http, on that same port. */
  const at = { port: 4000, publicAddress: { domain: 'example.test', scheme: 'http', port: 4000 } } as const; // oxfmt-ignore
  /** Loads a config the types would reject, for its load-time error. */
  const load = (opts: unknown) => () => defineConfig(opts as never) as unknown as Config<string>;
  /** A config of `routes` over `web`, `api` and `docs` (each with a port) and portless `lib`. */
  const withRoutes = (routes: unknown, more: Record<string, unknown> = {}) =>
    load({
      serviceRootDir: 'packages',
      reverseProxy: { ...at, routes },
      services: { web: { port: 3000 }, api: { port: 3001 }, docs: { port: 3002 }, lib: {} },
      ...more,
    });

  test('resolves each subdomain as a list, keeps the order of entries and of paths, and defaults to none', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        ...at,
        routes: [
          { subdomain: 'api', service: 'api' },
          { subdomain: ['admin', 'backoffice'], service: 'web' },
          { subdomain: 'app', paths: { '/docs/**': 'docs', '/**': 'web' } },
          { subdomain: '*', paths: { '/z/**': 'docs', '/api/**': 'api', '/**': 'web' } },
        ],
      },
      services: { web: { port: 3000 }, api: { port: 3001 }, docs: { port: 3002 } },
    });
    // What show-config prints: the same list the config wrote, `subdomain` always a list.
    expect(JSON.parse(JSON.stringify(cfg.reverseProxy!.routes))).toEqual([
      { subdomain: ['api'], service: 'api' },
      { subdomain: ['admin', 'backoffice'], service: 'web' },
      { subdomain: ['app'], paths: { '/docs/**': 'docs', '/**': 'web' } },
      { subdomain: ['*'], paths: { '/z/**': 'docs', '/api/**': 'api', '/**': 'web' } },
    ]);
    expect(Object.keys(cfg.reverseProxy!.routes[3]!.paths!)).toEqual(['/z/**', '/api/**', '/**']);
    expect(
      defineConfig({
        serviceRootDir: 'packages',
        reverseProxy: at,
        services: { web: { port: 3000 } },
      }).reverseProxy!.routes,
    ).toEqual([]);
  });

  test('takes multi-label subdomains and the 63-character label limit', () => {
    expect(
      withRoutes([{ subdomain: ['v2.api', 'a'.repeat(63)], service: 'api' }])().reverseProxy!
        .routes,
    ).toEqual([{ subdomain: ['v2.api', 'a'.repeat(63)], service: 'api' }]);
  });

  test('lets several `service` entries name one service', () => {
    const cfg = withRoutes([
      { subdomain: 'api', service: 'api' },
      { subdomain: 'legacy-api', service: 'api' },
    ])();
    expect(cfg.services.api!.publicOrigin).toBe('http://api.example.test:4000');
    expect(proxyHostsFor(cfg, cfg.services.api!)).toEqual(['api.example.test', 'legacy-api.example.test']); // oxfmt-ignore
  });

  describe('rejects', () => {
    test('an entry with both `service` and `paths`, or neither', () => {
      expect(withRoutes([{ subdomain: 'api', service: 'api', paths: { '/**': 'web' } }])).toThrow(
        'invalid stackctl config:\n  - reverseProxy.routes.0.paths: Invalid type: Expected never but received Object', // oxfmt-ignore
      );
      expect(withRoutes([{ subdomain: 'api' }])).toThrow(
        'invalid stackctl config:\n  - reverseProxy.routes.0.service: Invalid key: Expected "service" but received undefined',
      );
    });

    test('an entry that is no object, or has an unknown key', () => {
      expect(withRoutes(['api'])).toThrow(
        'reverseProxy.routes.0: Invalid type: Expected Object but received "api"',
      );
      expect(withRoutes([{ subdomain: 'api', service: 'api', host: 'x' }])).toThrow(
        'invalid stackctl config:\n  - reverseProxy.routes.0.host: Invalid key: Expected never but received "host"',
      );
      expect(
        load({
          serviceRootDir: 'packages',
          reverseProxy: { ...at, routes: { api: 'api' } },
          services: {},
        }),
      ).toThrow('reverseProxy.routes: Invalid type: Expected Array but received Object');
    });

    test("'*' before the last entry", () => {
      expect(
        withRoutes([
          { subdomain: '*', service: 'web' },
          { subdomain: 'api', service: 'api' },
        ]),
      ).toThrow("reverseProxy.routes[0] is '*', but is not the last entry");
    });

    test("'*' beside other subdomains, and '*' inside a name", () => {
      expect(withRoutes([{ subdomain: ['api', '*'], service: 'api' }])).toThrow(
        "reverseProxy.routes[0].subdomain[1] is '*' beside other subdomains",
      );
      for (const name of ['*.api', 'api.*', 'a*']) {
        expect(withRoutes([{ subdomain: name, service: 'api' }])).toThrow(
          `reverseProxy.routes[0].subdomain ${JSON.stringify(name)} is not a subdomain`,
        );
      }
    });

    test.each([
      '',
      ' api',
      'Api',
      '-api',
      'api-',
      'api_v2',
      'a..b',
      '.api',
      'api.',
      'a'.repeat(64),
    ])('the subdomain %j, naming the field', (name) => {
      expect(withRoutes([{ subdomain: ['web', name], service: 'web' }])).toThrow(
        `reverseProxy.routes[0].subdomain[1] ${JSON.stringify(name)} is not a subdomain`,
      );
    });

    test('an empty subdomain list, and a subdomain that is no string', () => {
      expect(withRoutes([{ subdomain: [], service: 'api' }])).toThrow(
        'reverseProxy.routes.0.subdomain: Invalid length: Expected >=1 but received 0',
      );
      expect(withRoutes([{ subdomain: true, service: 'api' }])).toThrow(
        'reverseProxy.routes.0.subdomain: Invalid type: Expected (string | Array) but received true',
      );
    });

    test('the same subdomain in two entries, or twice in one, naming both', () => {
      expect(
        withRoutes([
          { subdomain: ['api', 'app'], service: 'api' },
          { subdomain: 'app', paths: { '/**': 'web' } },
        ]),
      ).toThrow('reverseProxy.routes[0] and reverseProxy.routes[1] both list the subdomain "app"'); // oxfmt-ignore
      expect(withRoutes([{ subdomain: ['api', 'api'], service: 'api' }])).toThrow(
        'reverseProxy.routes[0].subdomain lists "api" twice',
      );
      expect(
        withRoutes([
          { subdomain: '*', service: 'web' },
          { subdomain: '*', service: 'api' },
        ]),
      ).toThrow("reverseProxy.routes[0] is '*'");
    });

    test('a glob that does not start with `/`, and an empty `paths`', () => {
      for (const glob of ['docs/**', '**', '*.js']) {
        expect(withRoutes([{ subdomain: '*', paths: { [glob]: 'docs' } }])).toThrow(
          `reverseProxy.routes[0].paths: ${JSON.stringify(glob)} does not start with \`/\``,
        );
      }
      expect(withRoutes([{ subdomain: '*', paths: {} }])).toThrow(
        'reverseProxy.routes[0].paths is empty',
      );
    });

    test('a target that names no service or infra service, as `service` or in `paths`', () => {
      const infra = { infra: { 'docker-compose': { services: { mail: { port: 8025 } } } } };
      expect(withRoutes([{ subdomain: 'api', service: 'apy' }], infra)).toThrow(
        'reverseProxy.routes[0].service is "apy", but no service or infra service is named that',
      );
      expect(withRoutes([{ subdomain: '*', paths: { '/docs/**': 'dcos' } }])).toThrow(
        'reverseProxy.routes[0].paths["/docs/**"] is "dcos", but no service or infra service is named that', // oxfmt-ignore
      );
    });

    test('a target with no port, as `service` or in `paths`', () => {
      expect(withRoutes([{ subdomain: 'lib', service: 'lib' }])).toThrow(
        'reverseProxy.routes[0].service is "lib", which has no `port`', // oxfmt-ignore
      );
      expect(withRoutes([{ subdomain: 'app', paths: { '/lib/**': 'lib' } }])).toThrow(
        'reverseProxy.routes[0].paths["/lib/**"] is "lib", which has no `port`',
      );
    });

    test('an unknown key', () => {
      const base = { serviceRootDir: 'packages', reverseProxy: at };
      expect(
        load({ ...base, services: { api: { port: 3000, proxy: { subdomain: 'api' } } } }),
      ).toThrow(
        // oxfmt-ignore
        /services\.api\.proxy: Invalid key: Expected never but received "proxy"/,
      );
      expect(
        load({ ...base, services: {}, infra: { 'docker-compose': { services: { mail: { port: 8025, proxy: { subdomain: 'mail' } } } } } }), // oxfmt-ignore
      ).toThrow(
        /infra\.docker-compose\.services\.mail\.proxy: Invalid key: Expected never but received "proxy"/,
      );
      expect(
        load({ ...base, reverseProxy: { ...at, paths: { '/docs': 'docs' } }, services: {} }),
      ).toThrow(
        // oxfmt-ignore
        /reverseProxy\.paths: Invalid key: Expected never but received "paths"/,
      );
      expect(
        load({ ...base, reverseProxy: { ...at, defaultService: 'web' }, services: {} }),
      ).toThrow(
        /reverseProxy\.defaultService: Invalid key: Expected never but received "defaultService"/,
      );
      expect(load({ ...base, reverseProxy: { ...at, https: true }, services: {} })).toThrow(
        /reverseProxy\.https: Invalid key: Expected never but received "https"/,
      );
      expect(
        load({ ...base, reverseProxy: { port: 4000, publicAddress: { domain: 'example.test', scheme: 'https', https: true } }, services: {} }), // oxfmt-ignore
      ).toThrow('invalid stackctl config:\n  - reverseProxy.publicAddress.https: Invalid key: Expected never but received "https"'); // oxfmt-ignore
    });
  });

  test('rejects an application service and an infra service sharing a name, routed or not', () => {
    const shared = (reverseProxy?: unknown) =>
      load({
        serviceRootDir: 'packages',
        ...(reverseProxy === undefined ? {} : { reverseProxy }),
        services: { mail: { port: 3000 } },
        infra: { 'docker-compose': { services: { mail: { port: 8025 } } } },
      });
    const message = '"mail" is both a service and an infra service';
    expect(shared()).toThrow(message);
    expect(shared({ ...at, routes: [{ subdomain: 'mail', service: 'mail' }] })).toThrow(message);
  });

  describe('an infra service as a target', () => {
    const withMail = (mail: Record<string, unknown>, routes: unknown) =>
      load({
        serviceRootDir: 'packages',
        reverseProxy: { ...at, routes },
        services: { web: { port: 3000 } },
        infra: { 'docker-compose': { services: { mail } } },
      });

    test('is reached at its subdomain, with a public origin and a route', () => {
      const seen: unknown[] = [];
      const cfg = withMail(
        {
          port: 8025,
          urls: [({ service }: { service: unknown }) => (seen.push(service), '/inbox')],
        },
        [{ subdomain: 'mail', service: 'mail' }],
      )();
      const mail = cfg.infra!['docker-compose']!.services.mail!;
      expect(mail.publicOrigin).toBe('http://mail.example.test:4000');
      expect(mail.urls).toEqual(['http://mail.example.test:4000/inbox']);
      expect(seen).toEqual([
        { name: 'mail', kind: 'infra', port: 8025, route: { host: 'mail.example.test', subdomain: 'mail' }, publicOrigin: 'http://mail.example.test:4000' }, // oxfmt-ignore
      ]);
    });

    test('has no origin when reached only by path, and a path in its urls fails', () => {
      const cfg = withMail({ port: 8025, urls: ['http://localhost:8025'] }, [{ subdomain: '*', paths: { '/mail/**': 'mail', '/**': 'web' } }])(); // oxfmt-ignore
      expect(cfg.infra!['docker-compose']!.services.mail!.publicOrigin).toBeUndefined();
      expect(
        withMail({ port: 8025, urls: ['/inbox'] }, [
          { subdomain: '*', paths: { '/mail/**': 'mail' } },
        ]),
      ).toThrow(
        // oxfmt-ignore
        'infra service "mail" urls: "/inbox" is a path, but this service has no public origin to base it on',
      );
    });

    test('needs a port, in every profile, and a port callback must return one', () => {
      const routes = [{ subdomain: 'mail', service: 'mail' }];
      expect(withMail({}, routes)).toThrow(
        'reverseProxy.routes routes to infra service "mail", which declares no `port`',
      );
      expect(withMail({ enabled: false }, routes)).toThrow(
        'reverseProxy.routes routes to infra service "mail", which declares no `port`',
      );
      expect(withMail({ port: () => undefined }, routes)).toThrow(
        'reverseProxy.routes routes to infra service "mail", whose `port` callback returned no port',
      );
    });

    test('disabled in this profile: still a valid target, with no port, route or origin', () => {
      const cfg = withMail({ enabled: false, port: () => { throw new Error('not run'); } }, [{ subdomain: 'mail', service: 'mail' }])(); // oxfmt-ignore
      const mail = cfg.infra!['docker-compose']!.services.mail!;
      expect(mail.port).toBeUndefined();
      expect(mail.publicOrigin).toBeUndefined();
    });
  });

  describe('public origins', () => {
    test('come from the first `service` entry that names the service, and its first subdomain', () => {
      const cfg = withRoutes([
        { subdomain: ['api', 'api-legacy'], service: 'api' },
        { subdomain: 'v2', service: 'api' },
        { subdomain: 'app', paths: { '/api/**': 'api', '/**': 'web' } },
      ])();
      expect(cfg.services.api!.publicOrigin).toBe('http://api.example.test:4000');
    });

    test("an explicit entry wins over a '*' one, wherever each is", () => {
      const cfg = withRoutes([
        { subdomain: 'app', service: 'web' },
        { subdomain: '*', service: 'web' },
      ])();
      expect(cfg.services.web!.publicOrigin).toBe('http://app.example.test:4000');
    });

    test("a service reached only through '*' or `paths` has none: no PUBLIC_ORIGIN, and no route", () => {
      const seen: unknown[] = [];
      const cfg = defineConfig({
        serviceRootDir: 'packages',
        reverseProxy: {
          ...at,
          routes: [
            { subdomain: 'app', paths: { '/docs/**': 'docs' } },
            { subdomain: '*', service: 'web' },
          ],
        },
        services: {
          web: {
            port: 3000,
            urls: [({ service }) => (seen.push(service), 'https://example.test')],
          },
          docs: { port: 3002, healthcheck: '/health' },
          worker: { port: 3003 },
        },
      });
      expect(cfg.services.web.publicOrigin).toBeUndefined();
      expect(cfg.services.docs.publicOrigin).toBeUndefined();
      expect(seen).toEqual([{ name: 'web', kind: 'service', port: 3000, route: null, publicOrigin: undefined }]); // oxfmt-ignore
      expect(packageEnvLayer(cfg.services.web, { cwd: os.tmpdir() })).not.toHaveProperty('PUBLIC_ORIGIN'); // oxfmt-ignore
      expect(packageEnvLayer(cfg.services.web, { cwd: os.tmpdir() })).toMatchObject({
        PORT: '3000',
      });
      // Healthchecks are unaffected: still the service on loopback.
      expect(cfg.services.docs.healthcheck?.url).toBe('http://localhost:3002/health');
      // A service in no route keeps its own port, as without a proxy.
      expect(cfg.services.worker.publicOrigin).toBe('http://localhost:3003');
    });

    test('a path in the urls of such a service fails at load; a full URL and buildAddress work', () => {
      for (const url of ['/docs', '', 'docs']) {
        expect(
          withRoutes([{ subdomain: '*', paths: { '/docs/**': 'docs' } }], {
            services: { docs: { port: 3002, urls: [url] } },
          }),
        ).toThrow(
          `docs urls: ${JSON.stringify(url)} is a path, but this service has no public origin to base it on: \`reverseProxy.routes\` reaches it only through '*' or \`paths\`, which give it no host of its own. Give it one with \`publicOrigin: { subdomain }\`, build the link with \`buildAddress({ subdomain, path })\`, or write the full URL.`, // oxfmt-ignore
        );
      }
      const cfg = defineConfig({
        serviceRootDir: 'packages',
        reverseProxy: { ...at, routes: [{ subdomain: '*', paths: { '/docs/**': 'docs' } }] },
        services: {
          docs: {
            port: 3002,
            urls: [
              'https://example.test/docs',
              ({ buildAddress }) => buildAddress({ subdomain: 'app', path: '/docs' }),
            ],
          },
        },
      });
      expect(cfg.services.docs.urls).toEqual(['https://example.test/docs', 'http://app.example.test:4000/docs']); // oxfmt-ignore
    });

    test('without a reverseProxy, every service keeps http://localhost:<port>', () => {
      const cfg = defineConfig({ serviceRootDir: 'packages', services: { web: { port: 3000 } } });
      expect(cfg.services.web.publicOrigin).toBe('http://localhost:3000');
    });
  });

  test('hands a callback the route, or null', () => {
    const seen: unknown[] = [];
    defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: at,
      services: { core: { port: 3001, urls: [({ service }) => (seen.push(service), '')] } },
    });
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { ...at, routes: [{ subdomain: ['api', 'api-legacy'], service: 'api' }] },
      services: {
        api: {
          port: 3000,
          urls: [({ service }) => `https://${service.route!.subdomain}.example.test`],
          healthcheck: ({ service }) => (
            seen.push(service),
            `https://${service.route!.host}/health`
          ),
        },
      },
    });
    expect(cfg.services.api.urls).toEqual(['https://api.example.test']);
    expect(seen).toEqual([
      { name: 'core', kind: 'service', port: 3001, route: null, publicOrigin: 'http://localhost:3001' }, // oxfmt-ignore
      { name: 'api', kind: 'service', port: 3000, route: { host: 'api.example.test', subdomain: 'api' }, publicOrigin: 'http://api.example.test:4000' }, // oxfmt-ignore
    ]);
  });

  test('hands a `port` callback the service it is for, and nothing resolved yet', () => {
    const seen: unknown[] = [];
    defineConfig({
      serviceRootDir: 'packages',
      services: { api: { port: ({ service }) => (seen.push(service), 3000) } },
    });
    expect(seen).toEqual([{ name: 'api', kind: 'service' }]);
  });

  test('offers no service to workspace-wide urls', () => {
    const seen: unknown[] = [];
    defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: at,
      urls: [
        // @ts-expect-error workspace-wide links belong to no service
        ({ service }) => {
          seen.push(service);
          return 'https://example.test';
        },
      ],
      services: { api: { port: 3000 } },
    });
    expect(seen).toEqual([undefined]);
  });

  test("proxyHostsFor lists a service's `service` entries' hosts, never '*' or `paths` ones", () => {
    const cfg = withRoutes([
      { subdomain: ['web', 'www'], service: 'web' },
      { subdomain: 'app', paths: { '/api/**': 'api' } },
      { subdomain: '*', service: 'api' },
    ])();
    expect(proxyHostsFor(cfg, cfg.services.web!)).toEqual(['web.example.test', 'www.example.test']);
    expect(proxyHostsFor(cfg, cfg.services.api!)).toEqual([]);
    expect(proxyHostsFor(null, cfg.services.web!)).toEqual([]);
  });
});

describe('reverseProxy', () => {
  // `web` at `web.<domain>`, unless the proxy given routes otherwise.
  const withProxy = (
    proxy: NonNullable<RootedOpts['reverseProxy']>,
    services: RootedOpts['services'] = { web: { port: 3000 } },
  ) =>
    defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { routes: [{ subdomain: 'web', service: 'web' }], ...proxy },
      services,
    });
  /** A proxy on 4000 whose public address is `domain` over plain http, on that same port. */
  const at = (domain: string | string[]) => ({ port: 4000, publicAddress: { domain, scheme: 'http' as const, port: 4000 } }); // oxfmt-ignore

  test('is absent from the resolved config when the block is omitted', () => {
    expect(
      defineConfig({ serviceRootDir: 'packages', services: { web: {} } }).reverseProxy,
    ).toBeUndefined();
  });

  test('parses literals; tls is off unless the config says', () => {
    const cfg = withProxy(at('example.test'));
    expect(cfg.reverseProxy).toEqual({
      port: 4000,
      publicAddress: {
        domain: 'example.test',
        domains: ['example.test'],
        scheme: 'http',
        port: 4000,
      },
      routes: [{ subdomain: ['web'], service: 'web' }],
      tls: false,
    });
  });

  test('resolves port and publicAddress callbacks over the workspace context', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { tld: 'test' },
      reverseProxy: {
        port: ({ envs }) => Number(envs.STACKCTL_SPEC_PROXY_PORT ?? '4100'),
        publicAddress: ({ tokens }) => ({
          domain: `example.${tokens.tld}`,
          scheme: 'https',
          port: 8443,
        }),
        routes: [{ subdomain: 'web', service: 'web' }],
      },
      services: { web: { port: 3000 } },
    });
    expect(cfg.reverseProxy).toMatchObject({
      port: 4100,
      publicAddress: {
        domain: 'example.test',
        domains: ['example.test'],
        scheme: 'https',
        port: 8443,
      },
    });
    expect(cfg.services.web.publicOrigin).toBe('https://web.example.test:8443');
  });

  test('rejects a port callback returning NaN, naming the field and the env files loaded', () => {
    expect(() => withProxy({ ...at('example.test'), port: () => Number('nope') })).toThrow(
      /reverseProxy\.port: callback returned NaN[\s\S]*env files/,
    );
  });

  test('rejects a publicAddress callback returning an empty domain, naming the field', () => {
    expect(() =>
      withProxy({ port: 4000, publicAddress: () => ({ domain: '', scheme: 'http' }) }),
    ).toThrow(
      /reverseProxy\.publicAddress\.domain "" is not a lowercase hostname\n {2}\(returned by its callback\)\n {2}.*env files/,
    );
  });

  test('rejects a publicAddress callback returning something unusable, naming the field', () => {
    const run = (value: unknown) => () =>
      withProxy({ port: 4000, publicAddress: (() => value) as () => never });
    expect(run(undefined)).toThrow(
      /^invalid stackctl config:\n {2}- reverseProxy\.publicAddress: Invalid type: Expected Object but received undefined\n {2}\(returned by its callback\)\n {2}.*env files/,
    );
    expect(run({ domain: 'example.test' })).toThrow(
      'reverseProxy.publicAddress.scheme: Invalid key: Expected "scheme" but received undefined',
    );
    expect(run({ domain: 'example.test', scheme: 'ftp' })).toThrow(
      'reverseProxy.publicAddress.scheme: Invalid type: Expected ("https" | "http") but received "ftp"',
    );
    expect(run({ domain: 'example.test', scheme: 'https', port: Number('') + 0.5 })).toThrow(
      'reverseProxy.publicAddress.port: Invalid integer: Received 0.5',
    );
    expect(run({ domain: 'example.test', scheme: 'https', https: true })).toThrow(
      'reverseProxy.publicAddress.https: Invalid key: Expected never but received "https"',
    );
  });

  test('rejects a literal publicAddress missing a field, or with an unknown one', () => {
    expect(() =>
      // @ts-expect-error `scheme` is required
      withProxy({ port: 4000, publicAddress: { domain: 'example.test' } }),
    ).toThrow(/reverseProxy\.publicAddress/);
    expect(() =>
      // @ts-expect-error `domain` is required
      withProxy({ port: 4000, publicAddress: { scheme: 'https' } }),
    ).toThrow(/reverseProxy\.publicAddress/);
    expect(() =>
      // @ts-expect-error `publicAddress` takes `domain`, `scheme` and `port`
      withProxy({ port: 4000, publicAddress: { domain: 'a.test', scheme: 'https', path: '/' } }),
    ).toThrow(/reverseProxy\.publicAddress/);
    expect(() =>
      // @ts-expect-error `https` is no field: the scheme is `scheme`
      withProxy({ port: 4000, publicAddress: { domain: 'example.test', https: true } }),
    ).toThrow(
      'invalid stackctl config:\n  - reverseProxy.publicAddress.https: Invalid key: Expected never but received "https"',
    );
    expect(() =>
      // @ts-expect-error `scheme` is 'https' or 'http'
      withProxy({ port: 4000, publicAddress: { domain: 'example.test', scheme: 'ftp' } }),
    ).toThrow(/reverseProxy\.publicAddress/);
  });

  test.each(['Example.test', 'example_test', '-example.test', 'example-.test', 'ex ample.test'])(
    'rejects the domain %j as not a lowercase hostname',
    (domain) => {
      expect(() => withProxy(at(domain))).toThrow(
        /reverseProxy\.publicAddress\.domain .* is not a lowercase hostname/,
      );
    },
  );

  // An array's first entry is the canonical domain, the rest aliases: every derived URL uses the
  // canonical one, and the entries must not overlap, so a Host falls under at most one.
  describe('publicAddress.domain as an array', () => {
    test('resolves the first entry as domain and keeps the full list in domains', () => {
      const cfg = withProxy(at(['example.test', 'example.localhost']));
      expect(cfg.reverseProxy).toEqual({
        port: 4000,
        publicAddress: {
          domain: 'example.test',
          domains: ['example.test', 'example.localhost'],
          scheme: 'http',
          port: 4000,
        },
        routes: [{ subdomain: ['web'], service: 'web' }],
        tls: false,
      });
      expect(cfg.services.web!.publicOrigin).toBe('http://web.example.test:4000');
    });

    test('accepts an array from the callback', () => {
      const cfg = defineConfig({
        serviceRootDir: 'packages',
        tokens: { tld: 'test' },
        reverseProxy: {
          port: 4000,
          publicAddress: ({ tokens }) => ({ domain: [`example.${tokens.tld}`, 'example.localhost'], scheme: 'http' }), // oxfmt-ignore
        },
        services: { web: { port: 3000 } },
      });
      expect(cfg.reverseProxy!.publicAddress).toMatchObject({
        domain: 'example.test',
        domains: ['example.test', 'example.localhost'],
      });
    });

    test('builds the public origin from the canonical entry only', () => {
      expect(withProxy(at(['localhost', 'example.test']))).toMatchObject({
        services: { web: { publicOrigin: 'http://web.localhost:4000' } },
      });
      expect(withProxy(at(['example.test', 'localhost']))).toMatchObject({
        services: { web: { publicOrigin: 'http://web.example.test:4000' } },
      });
    });

    test('rejects an empty array, literal or from the callback', () => {
      const tooSmall = 'reverseProxy.publicAddress.domain: Invalid length: Expected >=1 but received 0'; // oxfmt-ignore
      expect(() => withProxy(at([]))).toThrow(tooSmall);
      expect(() =>
        withProxy({ port: 4000, publicAddress: () => ({ domain: [], scheme: 'http' }) }),
      ).toThrow(tooSmall);
    });

    test('rejects an entry that is not a lowercase hostname, naming its index', () => {
      expect(() => withProxy(at(['example.test', 'Example.local']))).toThrow(
        /reverseProxy\.publicAddress\.domain\[1\] "Example\.local" is not a lowercase hostname/,
      );
      expect(() =>
        withProxy({
          port: 4000,
          publicAddress: () => ({ domain: ['example.test', ''], scheme: 'http' }),
        }),
      ).toThrow(/reverseProxy\.publicAddress\.domain\[1\] "" is not a lowercase hostname/);
    });

    test('rejects an entry listed twice', () => {
      expect(() => withProxy(at(['example.test', 'example.localhost', 'example.test']))).toThrow(
        /reverseProxy\.publicAddress\.domain lists "example\.test" twice \(entries 0 and 2\)/,
      );
    });

    test.each([[['example.test', 'dev.example.test']], [['dev.example.test', 'example.test']]])(
      'rejects entries where one is under the other: %j',
      (domain) => {
        expect(() => withProxy(at(domain))).toThrow(
          /reverseProxy\.publicAddress\.domain entries "dev\.example\.test" and "example\.test" overlap/,
        );
      },
    );

    test('allows entries that share a string suffix but not a label', () => {
      expect(
        withProxy(at(['example.test', 'myexample.test'])).reverseProxy?.publicAddress.domains,
      ).toEqual(['example.test', 'myexample.test']);
    });
  });

  test('rejects an unknown key in the block', () => {
    expect(() =>
      // @ts-expect-error `enabled` is not a field — presence of the block is what enables it
      withProxy({ ...at('example.test'), enabled: true }),
    ).toThrow(/Invalid key: Expected never but received "enabled"/);
  });

  test("rejects a proxy port equal to a package's port", () => {
    expect(() => withProxy({ ...at('example.test'), port: 3000 })).toThrow(
      /reverseProxy\.port 3000 is also web's port/,
    );
  });

  test('adds no footer link of its own: urls hold only what the config lists', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        ...at('example.test'),
        routes: [
          { subdomain: ['web', 'www'], service: 'web' },
          { subdomain: 'api', service: 'api' },
        ],
      },
      services: {
        web: { port: 3000, urls: [({ port }) => `http://localhost:${port}`] },
        api: { port: 3001 },
        worker: { port: 3002 },
        lib: {},
      },
    });
    expect(cfg.services.web.urls).toEqual(['http://localhost:3000']);
    expect(cfg.services.api.urls).toBeUndefined();
    expect(cfg.services.worker.urls).toBeUndefined();
    expect(cfg.services.lib.urls).toBeUndefined();
    // The public origin is still there for a `''` entry (and PUBLIC_ORIGIN) to build on.
    expect(cfg.services.web.publicOrigin).toBe('http://web.example.test:4000');
  });

  test('bases path urls on the public origin, its port included', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { ...at('example.test'), routes: [{ subdomain: 'web', service: 'web' }] },
      services: { web: { port: 3000, urls: ['/'] } },
    });
    expect(cfg.services.web.publicOrigin).toBe('http://web.example.test:4000');
    expect(cfg.services.web.urls).toEqual(['http://web.example.test:4000']);
  });

  test("exposes every service's public origin: the public address when routed, else its own port", () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        ...at('example.test'),
        routes: [{ subdomain: ['web', 'www'], service: 'web' }],
      },
      services: {
        web: { port: 3000 },
        worker: { port: 3002 },
        lib: {},
      },
    });
    expect(cfg.services.web.publicOrigin).toBe('http://web.example.test:4000');
    expect(cfg.services.worker.publicOrigin).toBe('http://localhost:3002');
    expect(cfg.services.lib.publicOrigin).toBeUndefined();
    const noProxy = defineConfig({ serviceRootDir: 'packages', services: { web: { port: 3000 } } });
    expect(noProxy.services.web.publicOrigin).toBe('http://localhost:3000');
  });

  test('gives a service reached at an alias domain the canonical domain as its public origin', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { ...at(['example.test', 'example.localhost']), routes: [{ subdomain: 'www', service: 'landing' }] }, // oxfmt-ignore
      services: { landing: { port: 3000, urls: ['', '/pricing'] } },
    });
    expect(cfg.services.landing.publicOrigin).toBe('http://www.example.test:4000');
    expect(cfg.services.landing.urls).toEqual([
      'http://www.example.test:4000',
      'http://www.example.test:4000/pricing',
    ]);
    expect(packageEnvLayer(cfg.services.landing, { cwd: os.tmpdir() })).toMatchObject({
      PORT: '3000',
      PUBLIC_ORIGIN: 'http://www.example.test:4000',
    });
  });

  test('injects PUBLIC_ORIGIN next to PORT, and an explicit .env PUBLIC_ORIGIN wins', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-origin-')));
    try {
      fs.mkdirSync(path.join(dir, 'packages/web'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'packages/api'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'packages/api/.env'), 'PUBLIC_ORIGIN=https://api.override\n');
      const cfg = defineConfig({
        serviceRootDir: 'packages',
        workspaceDir: dir,
        reverseProxy: {
          port: 4000,
          publicAddress: { domain: 'example.test', scheme: 'https' },
          routes: [
            { subdomain: 'web', service: 'web' },
            { subdomain: 'api', service: 'api' },
          ],
        },
        services: { web: { port: 3000 }, api: { port: 3001 } },
      });
      const layer = (pkg: AnyServiceConfig) => packageEnvLayer(pkg, { cwd: dir });
      expect(layer(cfg.services.web)).toMatchObject({
        PORT: '3000',
        PUBLIC_ORIGIN: 'https://web.example.test',
      });
      expect(layer(cfg.services.api)).toMatchObject({
        PORT: '3001',
        PUBLIC_ORIGIN: 'https://api.override',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a config still writing the top-level `publicOrigin` callback fails as an unknown key', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error `publicOrigin` is not a top-level option
        publicOrigin: () => 'https://web.example.test',
        services: { web: { port: 3000 } },
      }),
    ).toThrow(/publicOrigin: Invalid key: Expected never but received "publicOrigin"/);
  });
});

// The public address when the config gives none: the proxy itself, at `localhost`.
describe('reverseProxy.publicAddress omitted', () => {
  test('is localhost, http, on the proxy port', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000, routes: [{ subdomain: 'web', service: 'web' }] }, // oxfmt-ignore
      services: { web: { port: 3000 } },
    });
    expect(cfg.reverseProxy).toEqual({
      port: 4000,
      publicAddress: { domain: 'localhost', domains: ['localhost'], scheme: 'http', port: 4000 },
      routes: [{ subdomain: ['web'], service: 'web' }],
      tls: false,
    });
    expect(cfg.services.web.publicOrigin).toBe('http://web.localhost:4000');
  });

  test('is https when the proxy does TLS itself, still on the proxy port', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000, tls: true, routes: [{ subdomain: 'web', service: 'web' }] }, // oxfmt-ignore
      services: { web: { port: 3000 } },
    });
    expect(cfg.reverseProxy!.publicAddress).toEqual({
      domain: 'localhost',
      domains: ['localhost'],
      scheme: 'https',
      port: 4000,
    });
    expect(cfg.services.web.publicOrigin).toBe('https://web.localhost:4000');
  });

  test("prints no port when the proxy's is the scheme's default", () => {
    const tls = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 443, tls: true, routes: [{ subdomain: 'web', service: 'web' }] }, // oxfmt-ignore
      services: { web: { port: 3000 } },
    });
    expect(tls.reverseProxy!.publicAddress.port).toBeUndefined();
    expect(tls.services.web.publicOrigin).toBe('https://web.localhost');
    const plain = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 80, routes: [{ subdomain: 'web', service: 'web' }] }, // oxfmt-ignore
      services: { web: { port: 3000 } },
    });
    expect(plain.services.web.publicOrigin).toBe('http://web.localhost');
    // 80 is no default for https, nor 443 for http.
    const tlsOn80 = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 80, tls: true, routes: [{ subdomain: 'web', service: 'web' }] }, // oxfmt-ignore
      services: { web: { port: 3000 } },
    });
    expect(tlsOn80.services.web.publicOrigin).toBe('https://web.localhost:80');
  });
});

// `publicAddress` given: domain and scheme from it, the port only when it isn't the default.
describe('reverseProxy.publicAddress given', () => {
  const routed = (publicAddress: NonNullable<RootedOpts['reverseProxy']>['publicAddress']) =>
    defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        publicAddress,
        routes: [
          { subdomain: ['web', 'www'], service: 'web' },
          { subdomain: 'mail', service: 'mail' },
          { subdomain: '*', service: 'landing' },
        ],
      },
      infra: { 'docker-compose': { services: { mail: { port: 8025 }, db: { port: 5432 } } } },
      services: {
        web: { port: 3000, urls: ['/a'], healthcheck: '/health' },
        landing: { port: 3001 },
        worker: { port: 3002 },
        lib: {},
      },
    });

  test('without a port, is the scheme default: no port in any generated URL', () => {
    const cfg = routed({ domain: 'example.test', scheme: 'https' });
    expect(cfg.reverseProxy!.publicAddress.port).toBeUndefined();
    expect(cfg.services.web.publicOrigin).toBe('https://web.example.test');
    expect(cfg.services.web.urls).toEqual(['https://web.example.test/a']);
    // Reached only through '*': no host of its own.
    expect(cfg.services.landing.publicOrigin).toBeUndefined();
    const mail = cfg.infra!['docker-compose']!.services.mail!;
    expect(mail.publicOrigin).toBe('https://mail.example.test');
  });

  test('a port equal to the scheme default is dropped, 443 for https and 80 for http', () => {
    expect(routed({ domain: 'example.test', scheme: 'https', port: 443 }).services.web.publicOrigin).toBe('https://web.example.test'); // oxfmt-ignore
    expect(routed({ domain: 'example.test', scheme: 'http', port: 80 }).services.web.publicOrigin).toBe('http://web.example.test'); // oxfmt-ignore
    expect(routed({ domain: 'example.test', scheme: 'https', port: 443 }).reverseProxy!.publicAddress.port).toBeUndefined(); // oxfmt-ignore
  });

  test('any other port is kept, whatever the proxy listens on', () => {
    const cfg = routed({ domain: 'example.test', scheme: 'https', port: 8443 });
    expect(cfg.reverseProxy!.port).toBe(4000);
    expect(cfg.services.web.publicOrigin).toBe('https://web.example.test:8443');
    expect(routed({ domain: 'example.test', scheme: 'http', port: 443 }).services.web.publicOrigin).toBe('http://web.example.test:443'); // oxfmt-ignore
  });

  test('an unrouted service is itself on loopback, an unrouted infra service has none', () => {
    const cfg = routed({ domain: 'example.test', scheme: 'https' });
    expect(cfg.services.worker.publicOrigin).toBe('http://localhost:3002');
    expect(cfg.services.lib.publicOrigin).toBeUndefined();
    expect(cfg.infra!['docker-compose']!.services.db!.publicOrigin).toBeUndefined();
  });

  test('never moves the healthcheck, which probes the service on loopback', () => {
    const cfg = routed({ domain: 'example.test', scheme: 'https' });
    expect(cfg.services.web.healthcheck?.url).toBe('http://localhost:3000/health');
  });

  test('routes the aliases: every host under every domain', () => {
    const cfg = routed({ domain: ['example.test', 'example.localhost'], scheme: 'https' });
    expect(proxyHostsFor(cfg, cfg.services.web)).toEqual(['web.example.test', 'www.example.test']);
    expect(cfg.reverseProxy!.publicAddress.domains).toEqual(['example.test', 'example.localhost']);
  });
});

// What a `urls`/`healthcheck` callback (and an infra callback, and the workspace-wide `urls`) gets
// as `buildAddress`: a URL from the service's public origin, or from the proxy's address.
describe('buildAddress', () => {
  type BuildAddress = (opts?: BuildAddressOptions) => string;
  /** The `buildAddress` a `'*'`-only `web` gets: it has no origin, so it starts from the proxy's. */
  const seen = (publicAddress?: NonNullable<RootedOpts['reverseProxy']>['publicAddress']) => {
    let made: BuildAddress | undefined;
    defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000, ...(publicAddress && { publicAddress }), routes: [{ subdomain: '*', service: 'web' }] }, // oxfmt-ignore
      services: { web: { port: 3000, urls: [({ buildAddress }) => ((made = buildAddress), 'https://x.test')] } }, // oxfmt-ignore
    });
    return made!;
  };
  /** The `buildAddress` `web` gets, given its own config. */
  const of = (opts: {
    reverseProxy?: RootedOpts['reverseProxy'];
    web?: RootedOpts['services'][string];
  }) => {
    // oxfmt-ignore
    let made: BuildAddress | undefined;
    defineConfig({
      serviceRootDir: 'packages',
      ...(opts.reverseProxy && { reverseProxy: opts.reverseProxy }),
      services: { web: { port: 3000, ...opts.web, urls: [({ buildAddress }) => ((made = buildAddress), 'https://x.test')] } }, // oxfmt-ignore
    } as RootedOpts);
    return made!;
  };
  const proxy = <N extends string = 'web'>(routes: ReverseProxyRoute<N>[] = [{ subdomain: 'web', service: 'web' as N }]) => ({ port: 4000, publicAddress: { domain: 'example.test', scheme: 'https' as const, port: 8443 }, routes }); // oxfmt-ignore

  test('with no origin, starts from the proxy: the bare domain, a subdomain and a path', () => {
    const buildAddress = seen({ domain: 'example.test', scheme: 'https' });
    expect(buildAddress()).toBe('https://example.test');
    expect(buildAddress({})).toBe('https://example.test');
    expect(buildAddress({ subdomain: 'app' })).toBe('https://app.example.test');
    expect(buildAddress({ path: '/x' })).toBe('https://example.test/x');
    expect(buildAddress({ subdomain: 'app', path: '/x' })).toBe('https://app.example.test/x');
    expect(buildAddress({ subdomain: 'app', path: 'x' })).toBe('https://app.example.test/x');
    expect(buildAddress({ subdomain: 'v2.app' })).toBe('https://v2.app.example.test');
  });

  test('uses the same rule as the public origins: the port unless it is the default', () => {
    expect(seen({ domain: 'example.test', scheme: 'https', port: 8443 })({ subdomain: 'app' })).toBe('https://app.example.test:8443'); // oxfmt-ignore
    expect(seen({ domain: 'example.test', scheme: 'http', port: 80 })()).toBe('http://example.test'); // oxfmt-ignore
    // Omitted: localhost, the proxy's own port.
    expect(seen()({ subdomain: 'app', path: '/x' })).toBe('http://app.localhost:4000/x');
  });

  test("defaults to the service's origin: its route's, its override, or http://localhost:<port>", () => {
    const routed = of({ reverseProxy: proxy() });
    expect(routed()).toBe('https://web.example.test:8443');
    expect(routed({ path: '/x' })).toBe('https://web.example.test:8443/x');
    // The override is the origin, so it is the default too.
    expect(of({ reverseProxy: proxy(), web: { publicOrigin: { subdomain: 'app' } } })()).toBe('https://app.example.test:8443'); // oxfmt-ignore
    // A service in no route has `http://localhost:<port>` for its origin, proxy or not.
    expect(of({ reverseProxy: proxy([]) })()).toBe('http://localhost:3000');
    expect(of({ reverseProxy: proxy([]) })({ subdomain: 'app' })).toBe('http://app.localhost:3000');
    expect(of({})()).toBe('http://localhost:3000');
    expect(of({})({ subdomain: 'app', path: '/x' })).toBe('http://app.localhost:3000/x');
  });

  test('each option replaces one part of the origin, and the rest stay', () => {
    const buildAddress = of({ reverseProxy: proxy() });
    expect(buildAddress({ scheme: 'http' })).toBe('http://web.example.test:8443');
    expect(buildAddress({ subdomain: 'admin' })).toBe('https://admin.example.test:8443');
    expect(buildAddress({ subdomain: null })).toBe('https://example.test:8443');
    expect(buildAddress({ domain: 'example.com' })).toBe('https://web.example.com:8443');
    expect(buildAddress({ port: 9443 })).toBe('https://web.example.test:9443');
    expect(buildAddress({ port: 443 })).toBe('https://web.example.test');
    expect(buildAddress({ scheme: 'http', subdomain: null, domain: 'example.com', port: 8080, path: '/a' })).toBe('http://example.com:8080/a'); // oxfmt-ignore
    // A default port stays the scheme's default when only the scheme changes.
    const onDefault = of({ reverseProxy: { ...proxy(), publicAddress: { domain: 'example.test', scheme: 'https' } } }); // oxfmt-ignore
    expect(onDefault({ scheme: 'http' })).toBe('http://web.example.test');
  });

  test('urls may be a callback returning the list: one entry per line, paths based on the service', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000, publicAddress: { domain: 'example.test', scheme: 'https' } },
      services: {
        web: {
          port: 3000,
          urls: ({ buildAddress }) => [
            ...['app', 'web'].map((subdomain) => buildAddress({ subdomain })),
            { label: 'docs', url: '/docs' },
            ['/a', 'https://other.test/x'],
          ],
        },
      },
    });
    // web has no route of its own, so its origin, and its paths, stay on loopback.
    expect(cfg.services.web.urls).toEqual([
      'http://app.localhost:3000',
      'http://web.localhost:3000',
      { label: 'docs', url: 'http://localhost:3000/docs' },
      ['http://localhost:3000/a', 'https://other.test/x'],
    ]);
  });

  test('an infra service with no origin, and the workspace-wide urls, start from the proxy', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000, publicAddress: { domain: 'example.test', scheme: 'https' } },
      infra: {
        'docker-compose': {
          services: { mail: { port: 8025, urls: ({ buildAddress }) => [buildAddress({ subdomain: 'mail' })] } }, // oxfmt-ignore
        },
      },
      urls: ({ buildAddress }) => [
        buildAddress(),
        buildAddress({ subdomain: 'status', path: '/x' }),
      ],
      services: { web: { port: 3000 } },
    });
    expect(cfg.infra!['docker-compose']!.services.mail!.urls).toEqual([
      'https://mail.example.test',
    ]);
    expect(cfg.urls).toEqual(['https://example.test', 'https://status.example.test/x']);
  });

  test('without a reverseProxy, the workspace-wide urls start from http://localhost, with no port', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      urls: [({ buildAddress }) => buildAddress(), ({ buildAddress }) => buildAddress({ subdomain: 'status', port: 8080 })], // oxfmt-ignore
      infra: { 'docker-compose': { services: { mail: { port: 8025, urls: [({ buildAddress }) => buildAddress({ path: '/inbox' })] } } } }, // oxfmt-ignore
      services: { web: { port: 3000 } },
    });
    expect(cfg.urls).toEqual(['http://localhost', 'http://status.localhost:8080']);
    expect(cfg.infra!['docker-compose']!.services.mail!.urls).toEqual(['http://localhost:8025/inbox']); // oxfmt-ignore
  });

  test('a urls callback that returns something other than a list of links fails at load', () => {
    const load = (urls: unknown) => () =>
      defineConfig({
        serviceRootDir: 'packages',
        services: { web: { port: 3000, urls: urls as () => string[] } },
      });
    expect(load(() => 'https://a.test')).toThrow(/web urls: callback returned "https:\/\/a.test", not a list of links/);
    expect(load(() => ['/a', 42])).toThrow(/web urls: callback returned \["\/a",42\]/);
    expect(load(() => [() => '/a'])).toThrow(/not a list of links/);
  }); // oxfmt-ignore

  test('is handed to a healthcheck callback, and builds what it is asked for', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: proxy(),
      services: {
        web: { port: 3000, healthcheck: ({ buildAddress }) => buildAddress({ subdomain: null, path: '/up' }) }, // oxfmt-ignore
      },
    });
    expect(cfg.services.web.healthcheck?.url).toBe('https://example.test:8443/up');
  });

  test('is a function in every callback, with a reverseProxy and without, and has no `reverseProxy` beside it', () => {
    const got: unknown[] = [];
    for (const withProxy of [true, false]) {
      defineConfig({
        serviceRootDir: 'packages',
        ...(withProxy && { reverseProxy: { port: 4000 } }),
        urls: [(ctx) => (got.push(ctx), 'https://x.test')],
        infra: { 'docker-compose': { services: { mail: { port: 8025, urls: [(ctx) => (got.push(ctx), 'https://x.test')] } } } }, // oxfmt-ignore
        services: {
          web: {
            port: 3000,
            urls: (ctx) => (got.push(ctx), []),
            healthcheck: (ctx) => (got.push(ctx), '/health'),
          },
        },
      } as RootedOpts);
    }
    expect(got).toHaveLength(8);
    for (const ctx of got) {
      expect(typeof (ctx as { buildAddress: unknown }).buildAddress).toBe('function');
      expect(ctx).not.toHaveProperty('reverseProxy');
    }
  });

  test.each([
    [{ subdomain: 'App' }, 'services.web buildAddress.subdomain "App" is not lowercase hostname labels'], // oxfmt-ignore
    [{ subdomain: '' }, 'services.web buildAddress.subdomain "" is not lowercase hostname labels'],
    [
      { subdomain: '*' },
      'services.web buildAddress.subdomain "*" is not lowercase hostname labels',
    ],
    [{ domain: 'Example.test' }, 'services.web buildAddress.domain "Example.test" is not a lowercase hostname'], // oxfmt-ignore
    [{ port: 0 }, 'services.web buildAddress.port: Invalid value: Expected >=1 but received 0'],
    [
      { port: 65536 },
      'services.web buildAddress.port: Invalid value: Expected <=65535 but received 65536',
    ],
    [{ port: 1.5 }, 'services.web buildAddress.port: Invalid integer: Received 1.5'],
    [{ scheme: 'ftp' }, 'services.web buildAddress.scheme: Invalid type: Expected ("https" | "http") but received "ftp"'], // oxfmt-ignore
    [{ path: 42 }, 'services.web buildAddress.path: Invalid type: Expected string but received 42'],
    [{ https: true }, 'invalid stackctl config:\n  - services.web buildAddress.https: Invalid key: Expected never but received "https"'], // oxfmt-ignore
  ])('rejects %j, naming the service and the field', (opts, message) => {
    expect(() => seen()(opts as BuildAddressOptions)).toThrow(message);
  });

  test('an infra or workspace-wide one names its owner in an error', () => {
    const load = (opts: Partial<RootedOpts>) => () =>
      defineConfig({ serviceRootDir: 'packages', services: {}, ...opts } as RootedOpts);
    expect(load({ urls: [({ buildAddress }) => buildAddress({ subdomain: 'A' })] })).toThrow('urls buildAddress.subdomain "A" is not lowercase hostname labels'); // oxfmt-ignore
    expect(load({ infra: { 'docker-compose': { services: { mail: { port: 8025, urls: [({ buildAddress }) => buildAddress({ port: -1 })] } } } } })).toThrow('infra.docker-compose.services.mail buildAddress.port: Invalid value: Expected >=1 but received -1'); // oxfmt-ignore
  });

  test('stays off the resolved config, which show-config prints and the control API serves', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000 },
      services: { web: { port: 3000 } },
    });
    expect(JSON.stringify(cfg)).not.toContain('buildAddress');
  });
});

// A service's own `publicOrigin`: the parts of its origin it sets. It shapes URLs, never routing.
describe('publicOrigin', () => {
  const at = { port: 4000, publicAddress: { domain: 'example.test', scheme: 'https' } } as const;

  test("gives a '*'- or paths-only service an origin, PUBLIC_ORIGIN and path urls, routing unchanged", () => {
    const routes = [
      { subdomain: 'www', paths: { '/docs/**': 'docs' } },
      { subdomain: '*', service: 'web' },
    ] satisfies ReverseProxyRoute<'web' | 'docs'>[];
    const plain = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { ...at, routes: routes },
      services: { web: { port: 3000 }, docs: { port: 3002 } },
    });
    const seen: unknown[] = [];
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { ...at, routes: routes },
      services: {
        web: {
          port: 3000,
          publicOrigin: { subdomain: 'app' },
          urls: ['', '/todos', ({ service, buildAddress }) => (seen.push(service), buildAddress({ path: '/x' }))], // oxfmt-ignore
          healthcheck: '/health',
        },
        docs: { port: 3002, publicOrigin: { subdomain: 'www' }, urls: ['/docs'] },
      },
    });
    expect(cfg.services.web.publicOrigin).toBe('https://app.example.test');
    expect(cfg.services.web.urls).toEqual(['https://app.example.test', 'https://app.example.test/todos', 'https://app.example.test/x']); // oxfmt-ignore
    expect(cfg.services.docs.urls).toEqual(['https://www.example.test/docs']);
    expect(packageEnvLayer(cfg.services.web, { cwd: os.tmpdir() })).toMatchObject({ PUBLIC_ORIGIN: 'https://app.example.test' }); // oxfmt-ignore
    expect(seen).toEqual([{ name: 'web', kind: 'service', port: 3000, route: null, publicOrigin: 'https://app.example.test' }]); // oxfmt-ignore
    // Routing is untouched: the same routes, no host of its own, and the healthcheck on loopback.
    expect(cfg.reverseProxy).toEqual(plain.reverseProxy);
    expect(proxyHostsFor(cfg, cfg.services.web)).toEqual([]);
    expect(cfg.services.web.healthcheck?.url).toBe('http://localhost:3000/health');
  });

  test("replaces a routed service's subdomain, not its route", () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { ...at, routes: [{ subdomain: ['web', 'www'], service: 'web' }] },
      services: {
        web: { port: 3000, publicOrigin: { subdomain: 'app' }, urls: [({ service }) => `https://${service.route!.host}`] }, // oxfmt-ignore
      },
    });
    expect(cfg.services.web.publicOrigin).toBe('https://app.example.test');
    expect(cfg.services.web.urls).toEqual(['https://web.example.test']);
    expect(proxyHostsFor(cfg, cfg.services.web)).toEqual(['web.example.test', 'www.example.test']);
  });

  test.each([
    [{ scheme: 'http' }, 'http://web.example.test'],
    [{ domain: 'example.com' }, 'https://web.example.com'],
    [{ port: 8443 }, 'https://web.example.test:8443'],
    [{ port: 443 }, 'https://web.example.test'],
    [{ subdomain: null }, 'https://example.test'],
    [{ subdomain: 'v2.app' }, 'https://v2.app.example.test'],
    [{}, 'https://web.example.test'],
  ] as const)('%j replaces that part alone: %s', (publicOrigin, origin) => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { ...at, routes: [{ subdomain: 'web', service: 'web' }] },
      services: { web: { port: 3000, publicOrigin } },
    });
    expect(cfg.services.web.publicOrigin).toBe(origin);
  });

  test("a service in no route builds on the proxy's address, not on its own port", () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { ...at, routes: [] },
      services: { web: { port: 3000, publicOrigin: { port: 3000 } } },
    });
    expect(cfg.services.web.publicOrigin).toBe('https://example.test:3000');
  });

  test("a callback gets the service's own envs and tokens", () => {
    const seen: unknown[] = [];
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      tokens: { tld: 'test' },
      reverseProxy: { ...at, routes: [{ subdomain: '*', service: 'web' }] },
      services: {
        web: {
          port: 3000,
          tokens: { sub: 'app' },
          publicOrigin: (ctx) => {
            seen.push(Object.keys(ctx).sort());
            return { subdomain: ctx.tokens.sub, domain: `example.${ctx.tokens.tld}`, port: 8443 };
          },
          urls: ['/x'],
        },
      },
    });
    expect(seen).toEqual([['envs', 'tokens']]);
    expect(cfg.services.web.publicOrigin).toBe('https://app.example.test:8443');
    expect(cfg.services.web.urls).toEqual(['https://app.example.test:8443/x']);
  });

  test('without a reverseProxy, replaces parts of http://localhost:<port>', () => {
    const origin = (publicOrigin: RootedOpts['services'][string]['publicOrigin'], port: { port?: number } = { port: 3000 }) => // oxfmt-ignore
      defineConfig({ serviceRootDir: 'packages', services: { web: { ...port, publicOrigin, urls: ['/x'] } } }).services.web; // oxfmt-ignore
    expect(origin({ subdomain: 'app' }).publicOrigin).toBe('http://app.localhost:3000');
    expect(origin({ port: 8080 }).publicOrigin).toBe('http://localhost:8080');
    expect(origin({ scheme: 'https', domain: 'example.test', port: 443 }).publicOrigin).toBe('https://example.test'); // oxfmt-ignore
    // A service with no port has no origin of its own, but an override still gives one.
    expect(origin({ subdomain: 'app' }, {}).publicOrigin).toBe('http://app.localhost');
    expect(origin({ subdomain: 'app' }, {}).urls).toEqual(['http://app.localhost/x']);
  });

  test('an infra service with no route gets an origin, its urls paths based on it; a disabled one runs no callback', () => {
    let called = false;
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { ...at, routes: [] },
      infra: {
        'docker-compose': {
          services: {
            mail: { port: 8025, publicOrigin: { subdomain: 'mail' }, urls: ['', '/inbox'] },
            off: { enabled: false, port: 9000, publicOrigin: () => ((called = true), {}) },
          },
        },
      },
      services: { web: { port: 3000 } },
    });
    const services = cfg.infra!['docker-compose']!.services;
    expect(services.mail!.publicOrigin).toBe('https://mail.example.test');
    expect(services.mail!.urls).toEqual(['https://mail.example.test', 'https://mail.example.test/inbox']); // oxfmt-ignore
    expect(infraServiceDetails('mail', services.mail).publicOrigin).toBe(
      'https://mail.example.test',
    );
    expect(services.off!.publicOrigin).toBeUndefined();
    expect(called).toBe(false);
  });

  test('rejects a literal with an unknown key, by its path', () => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        // @ts-expect-error `https` is no field: the scheme is `scheme`
        services: { web: { port: 3000, publicOrigin: { https: true } } },
      }),
    ).toThrow(
      /services\.web\.publicOrigin\.https: Invalid key: Expected never but received "https"/,
    );
  });

  test.each([
    [{ subdomain: 'App' }, 'services.web.publicOrigin.subdomain "App" is not lowercase hostname labels'], // oxfmt-ignore
    [
      { subdomain: '*' },
      'services.web.publicOrigin.subdomain "*" is not lowercase hostname labels',
    ],
    [{ domain: 'example_test' }, 'services.web.publicOrigin.domain "example_test" is not a lowercase hostname'], // oxfmt-ignore
    [{ port: 0 }, 'services.web.publicOrigin.port: Invalid value: Expected >=1 but received 0'],
    [{ port: 3000.5 }, 'services.web.publicOrigin.port: Invalid integer: Received 3000.5'],
  ])('rejects %j, naming the service and the field', (publicOrigin, message) => {
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        services: { web: { port: 3000, publicOrigin } },
      }),
    ).toThrow(message);
  });

  test("checks a callback's result the same way, and names the infra service", () => {
    const web = (result: unknown) => () =>
      defineConfig({
        serviceRootDir: 'packages',
        services: { web: { port: 3000, publicOrigin: () => result as PublicOriginInput } },
      });
    expect(web({ scheme: 'ftp' })).toThrow('invalid stackctl config:\n  - services.web.publicOrigin.scheme: Invalid type: Expected ("https" | "http") but received "ftp"\n  (returned by its callback)'); // oxfmt-ignore
    expect(web('app')).toThrow('services.web.publicOrigin: Invalid type: Expected Object but received "app"'); // oxfmt-ignore
    expect(web({ https: true })).toThrow(
      'services.web.publicOrigin.https: Invalid key: Expected never but received "https"',
    );
    expect(web({ subdomain: 'App' })).toThrow('services.web.publicOrigin.subdomain "App" is not lowercase hostname labels\n  (returned by its callback)'); // oxfmt-ignore
    expect(() =>
      defineConfig({
        serviceRootDir: 'packages',
        infra: { 'docker-compose': { services: { mail: { port: 8025, publicOrigin: { subdomain: 'Mail' } } } } }, // oxfmt-ignore
        services: {},
      }),
    ).toThrow('infra.docker-compose.services.mail.publicOrigin.subdomain "Mail" is not lowercase hostname labels'); // oxfmt-ignore
  });
});

// `reverseProxy.tls`: the proxy serves TLS itself.
describe('reverseProxy.tls', () => {
  test('makes the default origin https, on the proxy port', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        tls: true,
        routes: [
          { subdomain: 'web', service: 'web' },
          { subdomain: 'landing', service: 'landing' },
        ],
      },
      services: {
        web: { port: 3000, urls: ['/x'] },
        landing: { port: 3001 },
        worker: { port: 3002 },
      },
    });
    expect(cfg.reverseProxy!.tls).toBe('self-signed');
    expect(cfg.services.web.publicOrigin).toBe('https://web.localhost:4000');
    expect(cfg.services.web.urls).toEqual(['https://web.localhost:4000/x']);
    expect(cfg.services.landing.publicOrigin).toBe('https://landing.localhost:4000');
    // Not routed: the service itself, which speaks plain HTTP.
    expect(cfg.services.worker.publicOrigin).toBe('http://localhost:3002');
  });

  test('leaves a given publicAddress alone: its scheme is what browsers use', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000, tls: true, publicAddress: { domain: 'example.test', scheme: 'http' }, routes: [{ subdomain: 'web', service: 'web' }] }, // oxfmt-ignore
      services: { web: { port: 3000 } },
    });
    expect(cfg.reverseProxy!.tls).toBe('self-signed');
    expect(cfg.services.web.publicOrigin).toBe('http://web.example.test');
  });

  test('takes a key and cert as written, from a literal or a callback', () => {
    const literal = withTls({ key: 'tls/key.pem', cert: 'tls/cert.pem' });
    expect(literal.reverseProxy!.tls).toBe('own');
    expect(proxyKeyAndCert(literal.reverseProxy!)).toEqual({ key: 'tls/key.pem', cert: 'tls/cert.pem' }); // oxfmt-ignore
    const fromCallback = withTls(({ tokens }) => ({
      key: `${tokens.dir}/k`,
      cert: `${tokens.dir}/c`,
    }));
    expect(proxyKeyAndCert(fromCallback.reverseProxy!)).toEqual({ key: 'certs/k', cert: 'certs/c' }); // oxfmt-ignore
    expect(withTls(() => false).reverseProxy!.tls).toBe(false);
    expect(proxyKeyAndCert(withTls(true).reverseProxy!)).toBeUndefined();
  });

  test('keeps a key given as text out of the resolved config, which show-config prints', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n';
    const cfg = withTls({ key, cert: 'cert.pem' });
    expect(JSON.stringify(cfg)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(cfg)).not.toContain('cert.pem');
    expect(proxyKeyAndCert(cfg.reverseProxy!)?.key).toBe(key);
  });

  test.each([
    [
      'a string',
      () => 'yes',
      'reverseProxy.tls: Invalid type: Expected (boolean | Object) but received "yes"',
    ],
    ['an empty key', () => ({ key: '', cert: 'c' }), 'reverseProxy.tls.key: Invalid length: Expected >=1 but received 0'], // oxfmt-ignore
    ['an extra key', () => ({ key: 'k', cert: 'c', ca: 'x' }), 'reverseProxy.tls.ca: Invalid key: Expected never but received "ca"'], // oxfmt-ignore
  ])('rejects a callback returning %s, naming the field', (_, tls, message) => {
    expect(() => withTls(tls as never)).toThrow(`invalid stackctl config:\n  - ${message}\n  (returned by its callback)\n`); // oxfmt-ignore
  });

  test('rejects a literal key without a cert', () => {
    expect(() => withTls({ key: 'k' } as never)).toThrow(/reverseProxy\.tls/);
  });

  function withTls(tls: ReverseProxyInput<{ dir: string }>['tls']) {
    return defineConfig({
      serviceRootDir: 'packages',
      tokens: { dir: 'certs' },
      reverseProxy: { port: 4000, tls, routes: [{ subdomain: 'web', service: 'web' }] }, // oxfmt-ignore
      services: { web: { port: 3000 } },
    });
  }
});

// A `urls` entry may be a path: resolved against the package's public origin under the dev
// reverse proxy, else against `http://localhost:<port>` — one link either way, never both.
describe('path urls', () => {
  test('resolve against http://localhost:<port> without a proxy', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: { api: { port: 3001, urls: ['/todos', { label: 'health', url: '/health' }] } },
    });
    expect(cfg.services.api.urls).toEqual([
      'http://localhost:3001/todos',
      { label: 'health', url: 'http://localhost:3001/health' },
    ]);
  });

  test('resolve against the public origin under the proxy, and only that', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        publicAddress: { domain: 'myproject.example.test', scheme: 'http', port: 4000 },
        routes: [{ subdomain: 'api', service: 'api' }],
      },
      services: {
        api: {
          port: 3001,
          urls: ['/todos', [{ label: 'a', url: '/a' }, '/b']],
        },
      },
    });
    expect(cfg.services.api.urls).toEqual([
      'http://api.myproject.example.test:4000/todos',
      [
        { label: 'a', url: 'http://api.myproject.example.test:4000/a' },
        'http://api.myproject.example.test:4000/b',
      ],
    ]);
  });

  test('fall back to localhost for a package the proxy does not route', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000 },
      services: { worker: { port: 3002, urls: ['/metrics'] } },
    });
    expect(cfg.services.worker.urls).toEqual(['http://localhost:3002/metrics']);
  });

  test('a callback may return a path too', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: { api: { port: 3001, urls: [({ tokens }) => `/${tokens.section ?? 'todos'}`] } },
    });
    expect(cfg.services.api.urls).toEqual(['http://localhost:3001/todos']);
  });

  test('leave absolute urls alone', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: { port: 4000, routes: [{ subdomain: 'api', service: 'api' }] },
      services: {
        api: { port: 3001, urls: ['https://status.example.test'] },
      },
    });
    expect(cfg.services.api.urls).toEqual(['https://status.example.test']);
  });

  test('reject a path on a package with no port to base it on, naming both', () => {
    expect(() =>
      defineConfig({ serviceRootDir: 'packages', services: { docs: { urls: ['/index.html'] } } }),
    ).toThrow(/docs urls: "\/index\.html" is a path, but this service declares no `port`/);
  });

  test('reject a path in the workspace-wide urls', () => {
    expect(() =>
      defineConfig({ serviceRootDir: 'packages', urls: ['/status'], services: { api: {} } }),
    ).toThrow(/top-level url: "\/status" is a path, but workspace-wide urls belong to no service/);
  });
});

// A path `healthcheck` always resolves against the package itself on loopback — never the public
// origin, since stackctl's own proxy holds requests until this very probe passes. The resolved
// `url` is what the status probe polls.
describe('path healthchecks', () => {
  test('resolve against http://localhost:<port>, bare and in the object form', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: { port: 3001, healthcheck: '/health' },
        web: { port: 3000, healthcheck: { url: '/', timeout: 5000 } },
      },
    });
    expect(cfg.services.api.healthcheck).toEqual({ url: 'http://localhost:3001/health', timeout: 1500 }); // oxfmt-ignore
    expect(cfg.services.web.healthcheck).toEqual({ url: 'http://localhost:3000', timeout: 5000 });
  });

  test('ignore the public origin even for a package the proxy routes', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        publicAddress: { domain: 'myproject.example.test', scheme: 'http', port: 4000 },
        routes: [{ subdomain: 'api', service: 'api' }],
      },
      services: {
        api: { port: 3001, healthcheck: '/health', urls: ['/todos'] },
      },
    });
    expect(cfg.services.api.healthcheck?.url).toBe('http://localhost:3001/health');
    expect(cfg.services.api.urls).toContain('http://api.myproject.example.test:4000/todos');
  });

  test('a callback may return a path too', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: { api: { port: 3001, healthcheck: () => '/ready' } },
    });
    expect(cfg.services.api.healthcheck?.url).toBe('http://localhost:3001/ready');
  });

  test('reject a path on a package with no port, naming both', () => {
    expect(() =>
      defineConfig({ serviceRootDir: 'packages', services: { docs: { healthcheck: '/' } } }),
    ).toThrow(/docs healthcheck: "\/" is a path, but this service declares no `port`/);
  });
});

// A relative path may be written with or without the leading slash; both forms resolve alike.
describe('paths without a leading slash', () => {
  test('urls: `todos` is `/todos`', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        publicAddress: { domain: 'myproject.example.test', scheme: 'http', port: 4000 },
        routes: [{ subdomain: 'api', service: 'api' }],
      },
      services: {
        api: {
          port: 3001,
          urls: ['todos', { label: 'x', url: 'a/b?c=1' }],
        },
        worker: { port: 3002, urls: ['metrics'] },
      },
    });
    expect(cfg.services.api.urls).toEqual([
      'http://api.myproject.example.test:4000/todos',
      { label: 'x', url: 'http://api.myproject.example.test:4000/a/b?c=1' },
    ]);
    expect(cfg.services.worker.urls).toEqual(['http://localhost:3002/metrics']);
  });

  test("'' is the origin itself, with no trailing slash", () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        publicAddress: { domain: 'myproject.example.test', scheme: 'http', port: 4000 },
        routes: [{ subdomain: 'api', service: 'api' }],
      },
      services: {
        api: { port: 3001, urls: [''], healthcheck: '' },
        worker: { port: 3002, urls: [{ label: 'root', url: '' }] },
      },
    });
    expect(cfg.services.api.urls).toEqual(['http://api.myproject.example.test:4000']);
    expect(cfg.services.api.healthcheck?.url).toBe('http://localhost:3001');
    expect(cfg.services.worker.urls).toEqual([{ label: 'root', url: 'http://localhost:3002' }]);
  });

  test('healthcheck: `health` is `/health`', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: { api: { port: 3001, healthcheck: 'health' } },
    });
    expect(cfg.services.api.healthcheck?.url).toBe('http://localhost:3001/health');
  });

  test('anything with a scheme is left alone', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: { port: 3001, healthcheck: 'HTTP://127.0.0.1:3001/health', urls: ['ws://localhost:3001/socket'] }, // oxfmt-ignore
      },
    });
    expect(cfg.services.api.healthcheck?.url).toBe('HTTP://127.0.0.1:3001/health');
    expect(cfg.services.api.urls).toEqual(['ws://localhost:3001/socket']);
  });
});

// A path's trailing slash is dropped, so `/todos/` is `/todos` and `/` is `''` — the origin.
describe('paths with a trailing slash', () => {
  test('urls: `/todos/` is `/todos`, with or without the proxy', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        publicAddress: { domain: 'myproject.example.test', scheme: 'http', port: 4000 },
        routes: [{ subdomain: 'api', service: 'api' }],
      },
      services: {
        api: {
          port: 3001,
          urls: ['/todos/', { label: 'x', url: 'a/b/' }],
        },
        worker: { port: 3002, urls: ['/metrics/', ['jobs/', '/queues//']] },
      },
    });
    expect(cfg.services.api.urls).toEqual([
      'http://api.myproject.example.test:4000/todos',
      { label: 'x', url: 'http://api.myproject.example.test:4000/a/b' },
    ]);
    expect(cfg.services.worker.urls).toEqual([
      'http://localhost:3002/metrics',
      ['http://localhost:3002/jobs', 'http://localhost:3002/queues'],
    ]);
  });

  test("urls: `/` is `''`, the origin itself", () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      reverseProxy: {
        port: 4000,
        publicAddress: { domain: 'myproject.example.test', scheme: 'http', port: 4000 },
        routes: [{ subdomain: 'api', service: 'api' }],
      },
      services: {
        api: { port: 3001, urls: ['/'] },
        worker: { port: 3002, urls: ['/', '//'] },
      },
    });
    expect(cfg.services.api.urls).toEqual(['http://api.myproject.example.test:4000']);
    expect(cfg.services.worker.urls).toEqual(['http://localhost:3002', 'http://localhost:3002']);
  });

  test('healthcheck: `/health/` is `/health`, and `/` the origin', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: { port: 3001, healthcheck: '/health/' },
        web: { port: 3000, healthcheck: '/' },
        worker: { port: 3002, healthcheck: () => 'ready/' },
      },
    });
    expect(cfg.services.api.healthcheck?.url).toBe('http://localhost:3001/health');
    expect(cfg.services.web.healthcheck?.url).toBe('http://localhost:3000');
    expect(cfg.services.worker.healthcheck?.url).toBe('http://localhost:3002/ready');
  });

  test('only the path loses its slash, never a query or fragment', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: { port: 3001, urls: ['/a/b/?c=1', '/login?next=/', '/docs/#intro/', '/?tab=/'] },
      },
    });
    expect(cfg.services.api.urls).toEqual([
      'http://localhost:3001/a/b?c=1',
      'http://localhost:3001/login?next=/',
      'http://localhost:3001/docs#intro/',
      'http://localhost:3001?tab=/',
    ]);
  });

  test('an absolute url keeps its trailing slash', () => {
    const cfg = defineConfig({
      serviceRootDir: 'packages',
      services: {
        api: { port: 3001, healthcheck: 'http://127.0.0.1:3001/health/', urls: ['https://status.example.test/'] }, // oxfmt-ignore
      },
    });
    expect(cfg.services.api.healthcheck?.url).toBe('http://127.0.0.1:3001/health/');
    expect(cfg.services.api.urls).toEqual(['https://status.example.test/']);
  });
});

describe('infra', () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-infra-'));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  const withInfra = (infra: unknown) =>
    defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      infra: infra as RootedOpts['infra'],
      services: { web: {} },
    }) as unknown as Config<string>;

  test('is absent from the resolved config when the block is omitted', () => {
    expect(
      defineConfig({ serviceRootDir: 'packages', services: { web: {} } }).infra,
    ).toBeUndefined();
  });

  test('an empty docker-compose block is a complete config, with defaults applied', () => {
    const cfg = withInfra({ 'docker-compose': {} });
    expect(cfg.infra).toEqual({
      'docker-compose': {
        file: undefined,
        projectName: `${path.basename(ws).toLowerCase()}-development`,
        readyTimeout: 300_000,
        services: {},
      },
    });
  });

  test('`true` for a provider is the same as an empty block', () => {
    expect(withInfra({ 'docker-compose': true }).infra).toEqual(
      withInfra({ 'docker-compose': {} }).infra,
    );
    expect(() => withInfra({ 'docker-compose': false })).toThrow(/infra/);
  });

  test('rejects an infra block naming no provider', () => {
    expect(() => withInfra({})).toThrow('infra: infra must name a provider');
  });

  test('rejects an unknown provider and an unknown service field', () => {
    expect(() => withInfra({ podman: {} })).toThrow(/infra/);
    expect(() => withInfra({ 'docker-compose': { services: { db: { onStarted() {} } } } })).toThrow(
      /infra/,
    );
  });

  test('rejects a callback that is not a function', () => {
    expect(() =>
      withInfra({ 'docker-compose': { services: { db: { afterReady: 'migrate' } } } }),
    ).toThrow(
      'infra.docker-compose.services.db.afterReady: Invalid type: Expected Function but received "migrate"',
    );
  });

  test('rejects a non-positive readyTimeout', () => {
    expect(() => withInfra({ 'docker-compose': { readyTimeout: 0 } })).toThrow(/readyTimeout/);
  });

  test('resolves `file` to an absolute path under the workspace', () => {
    const cfg = withInfra({ 'docker-compose': { file: './infra/compose.yaml', readyTimeout: 5 } });
    expect(cfg.infra?.['docker-compose']).toMatchObject({
      file: path.join(ws, 'infra', 'compose.yaml'),
      readyTimeout: 5,
    });
  });

  test('takes the project name from COMPOSE_PROJECT_NAME in a workspace .env file', () => {
    fs.writeFileSync(path.join(ws, '.env'), 'COMPOSE_PROJECT_NAME=from-env-file\n');
    expect(withInfra({ 'docker-compose': {} }).infra?.['docker-compose']?.projectName).toBe(
      'from-env-file',
    );
  });

  test('keeps the callbacks by identity, and JSON drops them', () => {
    const afterReady = async () => {};
    const cfg = withInfra({ 'docker-compose': { services: { db: { afterReady } } } });
    expect(cfg.infra?.['docker-compose']?.services.db?.afterReady).toBe(afterReady);
    expect(JSON.parse(JSON.stringify(cfg)).infra['docker-compose'].services).toEqual({
      db: { enabled: true },
    });
  });

  test('enabled defaults to true, takes a literal, and resolves a callback over profile, envs and tokens', () => {
    fs.writeFileSync(path.join(ws, '.env'), 'TRACING_KEY=abc\n');
    const seen: unknown[] = [];
    const cfg = defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      tokens: { region: 'eu' },
      infra: {
        'docker-compose': {
          services: {
            db: {},
            emulator: { enabled: false },
            tracing: {
              enabled: ({ profile, envs, tokens }) => {
                seen.push({ profile, region: tokens.region });
                return profile !== 'test' && Boolean(envs.TRACING_KEY);
              },
            },
            mailer: { enabled: ({ envs }) => Boolean(envs.STACKCTL_SPEC_NO_SUCH_VAR) },
          },
        },
      },
      services: { web: {} },
    });
    const services = cfg.infra!['docker-compose']!.services;
    expect(services.db!.enabled).toBe(true);
    expect(services.emulator!.enabled).toBe(false);
    expect(services.tracing!.enabled).toBe(true);
    expect(services.mailer!.enabled).toBe(false);
    expect(seen).toEqual([{ profile: 'development', region: 'eu' }]);
  });

  test('rejects an enabled callback that does not return a boolean, naming the service', () => {
    expect(() =>
      withInfra({ 'docker-compose': { services: { tracing: { enabled: () => 'yes' } } } }),
    ).toThrow(/infra[\s\S]*enabled[\s\S]*"tracing"[\s\S]*"yes"[\s\S]*boolean/);
    expect(() =>
      withInfra({ 'docker-compose': { services: { tracing: { enabled: 'yes' } } } }),
    ).toThrow(/enabled/);
  });
});

// An infra service's `port`, and the route `reverseProxy.routes` gives it: on the service type
// every provider shares, resolved over the workspace context, and checked against the packages and
// the dev reverse proxy.
describe('infra service port and route', () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-infra-proxy-'));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  type Services = NonNullable<
    Exclude<NonNullable<RootedOpts['infra']>['docker-compose'], true | undefined>['services']
  >;
  type Routes = NonNullable<NonNullable<RootedOpts['reverseProxy']>['routes']>;
  /** `web` at `web.<domain>`, and `mail` at `mail.<domain>`, when the config names them. */
  const defaultRoutes = (services: Services): Routes => [
    { subdomain: 'web', service: 'web' },
    ...('mail' in services ? [{ subdomain: 'mail', service: 'mail' }] : []),
  ];
  // Under a dev reverse proxy (`example.test`, port 4000) unless `noProxy`, which also leaves
  // `web` unrouted.
  const withServices = (
    services: Services,
    opts: Partial<Pick<RootedOpts, 'reverseProxy' | 'services'>> & { noProxy?: true; routes?: Routes } = {}, // oxfmt-ignore
  ) => {
    const base = {
      workspaceDir: ws,
      serviceRootDir: 'packages' as const,
      infra: { 'docker-compose': { services } },
    };
    return opts.noProxy
      ? defineConfig({ ...base, services: { web: { port: 3000 } } } as never) as unknown as Config<string> // oxfmt-ignore
      : defineConfig({
          ...base,
          reverseProxy: { routes: opts.routes ?? defaultRoutes(services), ...(opts.reverseProxy ?? proxied.reverseProxy) }, // oxfmt-ignore
          services: opts.services ?? { web: { port: 3000 } },
        });
  };
  const proxied = {
    reverseProxy: {
      port: 4000,
      publicAddress: { domain: 'example.test', scheme: 'http' as const, port: 4000 },
    },
  };

  test('resolves a literal port, a port callback over envs and tokens, and the route', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'MAIL_UI_PORT=8025\n');
    const seen: unknown[] = [];
    const cfg = defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      tokens: { tld: 'test' },
      reverseProxy: {
        port: 4000,
        publicAddress: { domain: 'example.test', scheme: 'http', port: 4000 },
        routes: [
          { subdomain: 'mail', service: 'mail' },
          { subdomain: ['s3', 'files'], service: 'store' },
          { subdomain: 'web', service: 'web' },
        ],
      },
      infra: {
        'docker-compose': {
          services: {
            mail: {
              port: ({ envs, tokens }) => {
                seen.push(tokens.tld);
                return Number(envs.MAIL_UI_PORT);
              },
            },
            store: { port: 9000 },
            db: { port: 5432 },
          },
        },
      },
      services: { web: { port: 3000 } },
    });
    const services = cfg.infra!['docker-compose']!.services;
    expect(seen).toEqual(['test']);
    expect(services.mail).toMatchObject({
      enabled: true,
      port: 8025,
      publicOrigin: 'http://mail.example.test:4000',
    });
    // The first subdomain makes the origin; the rest route too.
    expect(services.store).toMatchObject({
      port: 9000,
      publicOrigin: 'http://s3.example.test:4000',
    });
    expect(services.db).toMatchObject({ port: 5432, publicOrigin: undefined });
    // What show-config prints and outside tooling reads.
    expect(JSON.parse(JSON.stringify(cfg)).infra['docker-compose'].services.mail).toEqual({
      enabled: true,
      port: 8025,
      publicOrigin: 'http://mail.example.test:4000',
    });
  });

  test('has no public origin without a reverseProxy', () => {
    const mail = withServices({ mail: { port: 8025 } }, { noProxy: true }).infra!['docker-compose']!
      .services.mail!;
    expect(mail).toMatchObject({ port: 8025, publicOrigin: undefined });
  });

  test('uses the proxy port in the public origin', () => {
    const cfg = withServices({ mail: { port: 8025 } }, { reverseProxy: { port: 4000 } });
    expect(cfg.infra!['docker-compose']!.services.mail!.publicOrigin).toBe(
      'http://mail.localhost:4000',
    );
  });

  test('resolves `urls` like a package: paths on the public origin, labels and absolute urls kept', () => {
    const services = withServices(
      {
        mail: { port: 8025, urls: ['', { label: 'inbox', url: '/inbox' }] },
        store: { port: 9000, urls: [['https://console.example.test', '/minio']] },
        db: { port: 5432 },
      },
      proxied,
    ).infra!['docker-compose']!.services;
    expect(services.mail!.urls).toEqual([
      'http://mail.example.test:4000',
      { label: 'inbox', url: 'http://mail.example.test:4000/inbox' },
    ]);
    // In no route: a path is based on the service's port on loopback.
    expect(services.store!.urls).toEqual([
      ['https://console.example.test', 'http://localhost:9000/minio'],
    ]);
    // No `urls`, no links: stackctl adds none of its own.
    expect(services.db!.urls).toBeUndefined();
  });

  test('a `urls` callback gets the workspace context and the service, resolved', () => {
    const seen: unknown[] = [];
    withServices(
      {
        mail: {
          port: 8025,
          urls: [
            (ctx) => {
              seen.push({
                port: ctx.port,
                service: ctx.service,
                profile: ctx.envs.STACKCTL_PROFILE,
              });
              return '/';
            },
          ],
        },
      },
      { ...proxied, routes: [{ subdomain: ['mail', 'smtp'], service: 'mail' }] },
    );
    expect(seen).toEqual([
      {
        port: 8025,
        service: {
          name: 'mail',
          kind: 'infra',
          port: 8025,
          route: { host: 'mail.example.test', subdomain: 'mail' },
          publicOrigin: 'http://mail.example.test:4000',
        },
        profile: 'development',
      },
    ]);
  });

  test('the infra callbacks get the same service its `urls` callbacks did', () => {
    const cfg = withServices({ mail: { port: 8025 } });
    expect(infraServiceDetails('mail', cfg.infra!['docker-compose']!.services.mail)).toEqual({
      name: 'mail',
      kind: 'infra',
      port: 8025,
      route: { host: 'mail.example.test', subdomain: 'mail' },
      publicOrigin: 'http://mail.example.test:4000',
    });
    const unrouted = withServices({ db: { port: 5432 } });
    expect(infraServiceDetails('db', unrouted.infra!['docker-compose']!.services.db)).toMatchObject(
      {
        route: null,
        publicOrigin: undefined,
      },
    );
  });

  test('`port` and `enabled` callbacks get the service they are for', () => {
    const seen: unknown[] = [];
    withServices({
      mail: {
        enabled: ({ service }) => (seen.push(['enabled', service]), true),
        port: ({ service }) => (seen.push(['port', service]), 8025),
      },
    });
    const service = { name: 'mail', kind: 'infra' };
    expect(seen).toEqual([
      ['enabled', service],
      ['port', service],
    ]);
  });

  test("rejects a path in a service's `urls` when it has no port, naming the service", () => {
    expect(() => withServices({ db: { urls: ['/'] } })).toThrow(
      /infra service "db" urls: "\/" is a path, but this service declares no `port`/,
    );
    expect(() =>
      withServices({ db: { urls: [({ port }) => `http://localhost:${port}`] } }),
    ).toThrow(
      /infra service "db" urls: a callback read `port`, but this service declares no `port`/,
    );
  });

  test("doesn't resolve a disabled service's `urls`", () => {
    let calls = 0;
    const db = withServices({
      db: {
        enabled: false,
        urls: [
          () => {
            calls += 1;
            return '/';
          },
        ],
      },
    }).infra!['docker-compose']!.services.db!;
    expect(calls).toBe(0);
    expect(db.urls).toBeUndefined();
  });

  test("a service switched off for the profile gets no public origin, and its port callback doesn't run", () => {
    let calls = 0;
    const cfg = withServices(
      {
        mail: {
          enabled: false,
          port: () => {
            calls += 1;
            return Number(undefined);
          },
        },
      },
      proxied,
    );
    expect(calls).toBe(0);
    expect(cfg.infra!['docker-compose']!.services.mail).toMatchObject({
      enabled: false,
      port: undefined,
      publicOrigin: undefined,
    });
    expect(infraServiceDetails('mail', cfg.infra!['docker-compose']!.services.mail)).toMatchObject({
      route: null,
    });
  });

  test('rejects a port callback returning NaN, naming the service and the env files loaded', () => {
    expect(() => withServices({ mail: { port: () => Number(undefined) } })).toThrow(
      /infra service "mail": port callback returned NaN[\s\S]*env files/,
    );
  });

  test("rejects a service port equal to the proxy's, naming the service", () => {
    expect(() => withServices({ mail: { port: 4000 } }, proxied)).toThrow(
      /reverseProxy\.port 4000 is also infra service "mail"'s port/,
    );
  });

  test("rejects a service port equal to a package's, naming both — with or without a proxy", () => {
    expect(() => withServices({ mail: { port: 3000 } })).toThrow(
      /infra service "mail" has port 3000, which is also the service web's/,
    );
    // A service in no route still claims its port on the host, under no proxy too.
    expect(() => withServices({ db: { port: 3000 } }, { noProxy: true })).toThrow(
      /infra service "db" has port 3000, which is also the service web's/,
    );
  });

  test('rejects two services on one port, naming both', () => {
    expect(() => withServices({ a: { port: 9000 }, b: { port: 9000 } })).toThrow(
      /infra service "b" has port 9000, which is also infra service "a"'s/,
    );
  });

  test('ignores a disabled service in the port checks: it claims no port', () => {
    expect(
      withServices({ mail: { enabled: false, port: 3000 } }, proxied).infra!['docker-compose']!
        .services.mail!.enabled,
    ).toBe(false);
  });
});

describe('env vars', () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-env-vars-'));
    fs.mkdirSync(path.join(ws, 'packages/api'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    delete process.env.STACKCTL_TEST_AMBIENT;
  });

  const base = () => ({ serviceRootDir: 'packages' as const, workspaceDir: ws });

  test('stores a literal env.vars record on the resolved config', () => {
    const cfg = defineConfig({
      ...base(),
      env: { vars: { DATA_DIR: '/srv/data' } },
      services: { api: {} },
    });
    expect(cfg.envVars).toEqual({ DATA_DIR: '/srv/data' });
  });

  test('is undefined on a config that declares none', () => {
    const cfg = defineConfig({ ...base(), env: { override: true }, services: { api: {} } });
    expect(cfg.envVars).toBeUndefined();
  });

  test('hands an env.vars callback the workspace env and the top-level tokens', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'REGION=eu\n');
    process.env.STACKCTL_TEST_AMBIENT = 'from-shell';
    const cfg = defineConfig({
      ...base(),
      tokens: { tier: 'dev' },
      env: {
        vars: ({ envs, tokens }) => ({
          BUCKET: `${tokens.tier}-${String(envs.REGION)}-${String(envs.STACKCTL_TEST_AMBIENT)}`,
        }),
      },
      services: { api: {} },
    });
    expect(cfg.envVars).toEqual({ BUCKET: 'dev-eu-from-shell' });
  });

  test('takes the callback itself as `env`, shorthand for `env.vars`', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'REGION=eu\n');
    const cfg = defineConfig({
      ...base(),
      env: ({ envs }) => ({ BUCKET: `dev-${String(envs.REGION)}` }),
      services: { api: {} },
    });
    expect(cfg.envVars).toEqual({ BUCKET: 'dev-eu' });
    expect(cfg.envOverride).toBeUndefined();
  });

  test('keeps env.override next to env.vars', () => {
    const cfg = defineConfig({
      ...base(),
      env: { vars: { DATA_DIR: '/srv/data' }, override: ['NODE_OPTIONS'] },
      services: { api: {} },
    });
    expect(cfg.envOverride).toEqual(['NODE_OPTIONS']);
  });

  test('drops a variable whose value is undefined', () => {
    const cfg = defineConfig({
      ...base(),
      env: ({ envs }) => ({ KEPT: 'yes', DROPPED: envs.STACKCTL_SPEC_NO_SUCH_VAR }),
      services: { api: {} },
    });
    expect(cfg.envVars).toEqual({ KEPT: 'yes' });
  });

  test('rejects a callback value that is not a string, naming the variable and the env files', () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'DB_PORT=5432\n');
    expect(() =>
      defineConfig({
        ...base(),
        // @ts-expect-error - a variable's value must be a string (or undefined).
        env: ({ envs }) => ({ DB_PORT: Number(envs.DB_PORT) }),
        services: { api: {} },
      }),
    ).toThrow(
      /env\.vars: DB_PORT is 5432 \(a number\) — an environment variable must be a string[\s\S]*env files loaded: .*\.env\.development/,
    );
  });

  test('rejects a literal value that is not a string, naming the variable', () => {
    expect(() =>
      defineConfig({
        ...base(),
        // @ts-expect-error - a variable's value must be a string (or undefined).
        env: { vars: { DB_PORT: 5432 } },
        services: { api: {} },
      }),
    ).toThrow(
      /env\.vars: DB_PORT is 5432 \(a number\) — an environment variable must be a string$/,
    );
  });

  test('rejects an env.vars that is neither a record nor a callback', () => {
    expect(() =>
      defineConfig({
        ...base(),
        // @ts-expect-error - `vars` is a record of variables or a callback.
        env: { vars: 'DATA_DIR=/srv/data' },
        services: { api: {} },
      }),
    ).toThrow(
      'env.vars: Invalid type: Expected (Object | Function) but received "DATA_DIR=/srv/data"',
    );
  });

  test('rejects a callback that returns a promise rather than a record', () => {
    expect(() =>
      defineConfig({
        ...base(),
        // @ts-expect-error - callbacks are synchronous.
        env: async () => ({ DATA_DIR: '/srv/data' }),
        services: { api: {} },
      }),
    ).toThrow(
      /env\.vars: callback returned \[object Promise\] \(expected an object of variables\)/,
    );
  });

  test('rejects a name no .env file could carry', () => {
    expect(() =>
      defineConfig({
        ...base(),
        env: { vars: { 'DATA DIR': '/srv/data' } },
        services: { api: {} },
      }),
    ).toThrow(/env\.vars: "DATA DIR" is not a valid environment variable name/);
  });

  describe('with no stackctl CLI around the config', () => {
    const names = ['STACKCTL_PROFILE', 'STACKCTL_CWD', 'STACKCTL_WORKSPACE_DIR'] as const;
    let before: (string | undefined)[];

    beforeEach(() => {
      before = names.map((name) => process.env[name]);
      for (const name of names) {
        delete process.env[name];
      }
    });

    afterEach(() => {
      names.forEach((name, i) => {
        if (before[i] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = before[i];
        }
      });
    });

    test('still hands a callback the variables stackctl sets', () => {
      const cfg = defineConfig({
        ...base(),
        env: ({ envs }) => ({
          SEEN: [envs.STACKCTL_PROFILE, envs.STACKCTL_CWD, envs.STACKCTL_WORKSPACE_DIR].join('|'),
        }),
        services: {
          api: { urls: [({ envs }) => `file://${String(envs.STACKCTL_WORKSPACE_DIR)}`] },
        },
      });
      expect(cfg.envVars).toEqual({ SEEN: `development|${process.cwd()}|${path.resolve(ws)}` });
      expect(cfg.services.api.urls).toEqual([`file://${path.resolve(ws)}`]);
    });

    test('leaves the ones the environment already has as they are', () => {
      process.env.STACKCTL_WORKSPACE_DIR = '/from/the/cli';
      const cfg = defineConfig({
        ...base(),
        env: ({ envs }) => ({ SEEN: envs.STACKCTL_WORKSPACE_DIR }),
        services: { api: {} },
      });
      expect(cfg.envVars).toEqual({ SEEN: '/from/the/cli' });
    });
  });

  test('rejects a callback that returns no record', () => {
    expect(() =>
      defineConfig({
        ...base(),
        // @ts-expect-error - the callback must return a record of variables.
        env: () => 'DATA_DIR=/srv/data',
        services: { api: {} },
      }),
    ).toThrow(/env\.vars: callback returned "DATA_DIR=\/srv\/data" \(expected an object/);
  });

  test("puts the variables in every later callback's envs", () => {
    const seen: Record<string, string | undefined> = {};
    const cfg = defineConfig({
      ...base(),
      env: { vars: { BASE_PORT: '4100', HOST: 'dev.example' } },
      reverseProxy: {
        port: ({ envs }) => Number(envs.BASE_PORT) + 50,
        publicAddress: ({ envs }) => ({ domain: envs.HOST!, scheme: 'http' }),
      },
      urls: [({ envs }) => `https://docs.${envs.HOST!}`],
      infra: {
        'docker-compose': {
          services: {
            db: {
              enabled: ({ envs }) => {
                seen.infra = envs.HOST;
                return true;
              },
            },
          },
        },
      },
      services: {
        api: {
          port: ({ envs }) => Number(envs.BASE_PORT),
          urls: [({ envs, port }) => `http://${envs.HOST!}:${String(port)}`],
        },
      },
    });
    expect(cfg.reverseProxy).toMatchObject({
      port: 4150,
      publicAddress: { domain: 'dev.example' },
    });
    expect(cfg.urls).toEqual(['https://docs.dev.example']);
    expect(cfg.services.api.port).toBe(4100);
    expect(cfg.services.api.urls).toEqual(['http://dev.example:4100']);
    expect(seen.infra).toBe('dev.example');
  });

  test("loses to an env file in a later callback: the workspace's, then the package's", () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'REGION=eu\nBACKEND_PORT=6666\n');
    fs.writeFileSync(path.join(ws, 'packages/api/.env.development'), 'BACKEND_PORT=7777\n');
    const seen: Record<string, string | undefined> = {};
    const cfg = defineConfig({
      ...base(),
      env: { vars: { BACKEND_PORT: '4321', REGION: 'us', TIER: 'dev' } },
      urls: [({ envs }) => `https://${envs.REGION!}.example:${envs.BACKEND_PORT!}`],
      services: {
        api: {
          port: ({ envs }) => {
            seen.region = envs.REGION;
            seen.tier = envs.TIER;
            return Number(envs.BACKEND_PORT);
          },
        },
      },
    });
    expect(cfg.urls).toEqual(['https://eu.example:6666']);
    expect(cfg.services.api.port).toBe(7777);
    expect(seen).toEqual({ region: 'eu', tier: 'dev' });
  });

  test('loses to the ambient environment in a later callback, unless env.override names it', () => {
    process.env.STACKCTL_TEST_AMBIENT = 'from-shell';
    const seenBy = (override?: string[]) => {
      let seen: string | undefined;
      defineConfig({
        ...base(),
        env: { vars: { STACKCTL_TEST_AMBIENT: 'from-config' }, override },
        services: {
          api: {
            port: ({ envs }) => {
              seen = envs.STACKCTL_TEST_AMBIENT;
              return 4321;
            },
          },
        },
      });
      return seen;
    };
    expect(seenBy()).toBe('from-shell');
    expect(seenBy(['STACKCTL_TEST_AMBIENT'])).toBe('from-config');
  });

  test("expands an env file's reference to a variable, for a later callback", () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'API_URL=http://${HOST}:4100\n');
    const cfg = defineConfig({
      ...base(),
      env: { vars: { HOST: 'dev.example' } },
      urls: [({ envs }) => envs.API_URL!],
      services: { api: {} },
    });
    expect(cfg.urls).toEqual(['http://dev.example:4100']);
  });

  test('names the compose project from a variable it sets', () => {
    const cfg = defineConfig({
      ...base(),
      env: { vars: { COMPOSE_PROJECT_NAME: 'pinned' } },
      infra: { 'docker-compose': true },
      services: { api: {} },
    });
    expect(cfg.infra?.['docker-compose']?.projectName).toBe('pinned');
  });

  test('still rejects an unknown key next to env.vars', () => {
    expect(() =>
      defineConfig({
        ...base(),
        // @ts-expect-error - `files` was removed; the schema must say so rather than strip it.
        env: { vars: { DATA_DIR: '/srv/data' }, files: ['.env'] },
        services: { api: {} },
      }),
    ).toThrow(/Invalid key: Expected never but received "files"/);
  });
});

describe('env.additionalFiles', () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-env-files-'));
    fs.mkdirSync(path.join(ws, 'packages/api'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    delete process.env.STACKCTL_PROFILE;
  });

  const base = () => ({ serviceRootDir: 'packages' as const, workspaceDir: ws });
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(ws, rel), text);

  test("places the files among stackctl's own on the resolved config, per scope", () => {
    const cfg = defineConfig({
      ...base(),
      env: {
        additionalFiles: [
          { file: '.env.development.pre', before: 'profile' },
          { file: '.env.secrets', after: 'profileLocal', scope: 'service' },
        ],
      },
      services: { api: {} },
    });
    expect(cfg.envFiles).toEqual({
      workspace: [
        '.env',
        '.env.local',
        '.env.development.pre',
        '.env.development',
        '.env.development.local',
      ],
      service: [
        '.env',
        '.env.local',
        '.env.development.pre',
        '.env.development',
        '.env.development.local',
        '.env.secrets',
      ],
    });
  });

  test('calls a callback with the active profile', () => {
    process.env.STACKCTL_PROFILE = 'test';
    const profiles: string[] = [];
    const cfg = defineConfig({
      ...base(),
      env: {
        additionalFiles: ({ profile }) => {
          profiles.push(profile);
          return [{ file: `.env.${profile}.pre`, before: 'profile' }];
        },
      },
      services: { api: {} },
    });
    expect(profiles).toEqual(['test']);
    expect(cfg.envFiles.workspace).toEqual([
      '.env',
      '.env.local',
      '.env.test.pre',
      '.env.test',
      '.env.test.local',
    ]);
  });

  test("gives a port callback a value derived from an additional file's input", () => {
    write('.env.development.pre', 'API_PORT=21000\n');
    write('.env.development.pre.local', 'API_PORT=21010\n');
    write('.env.development', 'PORT_OF_API=${API_PORT}\n');
    const cfg = defineConfig({
      ...base(),
      env: {
        additionalFiles: ({ profile }) => [
          { file: `.env.${profile}.pre`, before: 'profile' },
          { file: `.env.${profile}.pre.local`, before: 'profile' },
        ],
      },
      services: { api: { port: ({ envs }) => Number(envs.PORT_OF_API) } },
    });
    expect(cfg.services.api.port).toBe(21010);
  });

  test("hands env.vars' callback the additional files' values", () => {
    write('.env.local.extra', 'REGION=eu\n');
    const cfg = defineConfig({
      ...base(),
      env: {
        additionalFiles: [{ file: '.env.local.extra', after: 'local' }],
        vars: ({ envs }) => ({ BUCKET: `dev-${String(envs.REGION)}` }),
      },
      services: { api: {} },
    });
    expect(cfg.envVars).toEqual({ BUCKET: 'dev-eu' });
  });

  test("gives a service's environment the files, under the config's env.override", () => {
    write('.env.development.pre', 'STACKCTL_SPEC_PINNED=from-file\n');
    process.env.STACKCTL_SPEC_PINNED = 'from-shell';
    try {
      const cfg = defineConfig({
        ...base(),
        env: {
          additionalFiles: [{ file: '.env.development.pre', before: 'profile' }],
          override: ['STACKCTL_SPEC_PINNED'],
        },
        services: { api: {} },
      });
      const layer = packageEnvLayer(cfg.services.api, {
        cwd: ws,
        files: cfg.envFiles,
        override: cfg.envOverride,
      });
      expect(layer.STACKCTL_SPEC_PINNED).toBe('from-file');
    } finally {
      delete process.env.STACKCTL_SPEC_PINNED;
    }
  });

  describe('rejects, naming the entry,', () => {
    const load = (additionalFiles: unknown) => () =>
      defineConfig({
        ...base(),
        // Checked at runtime: these are what a plain-JS config, or a cast, could pass.
        env: { additionalFiles: additionalFiles as [] },
        services: { api: {} },
      });

    const invalid = (issue: string) => `invalid stackctl config:\n  - env.additionalFiles.${issue}`;

    test('an entry with both before and after, or neither', () => {
      expect(load([{ file: '.env.x', before: 'profile', after: 'local' }])).toThrow(
        invalid('0.after: Invalid type: Expected never but received "local"'),
      );
      expect(load([{ file: '.env.ok', before: 'profile' }, { file: '.env.x' }])).toThrow(
        invalid('1.before: Invalid key: Expected "before" but received undefined'),
      );
    });

    test('an unknown anchor', () => {
      expect(load([{ file: '.env.x', after: '.env.local' }])).toThrow(
        invalid('0.after: Invalid type: Expected ("base" | "local" | "profile" | "profileLocal") but received ".env.local"'), // oxfmt-ignore
      );
    });

    test('an empty file', () => {
      expect(load([{ file: '', before: 'profile' }])).toThrow(
        'env.additionalFiles.0.file: Invalid length: Expected >=1 but received 0',
      );
    });

    test.each(['/etc/.env', '../.env.x', 'config/.env.x', '..', '.'])('the path %j', (file) => {
      expect(load([{ file, before: 'profile' }])).toThrow(
        `env.additionalFiles[0] (${JSON.stringify(file)}): \`file\` must be a filename in the scope's directory, not a path`,
      );
    });

    test("one of stackctl's own files", () => {
      expect(load([{ file: '.env.development', after: 'local' }])).toThrow(
        `env.additionalFiles[0] (".env.development"): ".env.development" is one of stackctl's own files for profile "development", which load anyway`,
      );
    });

    test('a file another entry lists at a scope they share', () => {
      expect(
        load([
          { file: '.env.x', before: 'profile', scope: 'service' },
          { file: '.env.x', after: 'profileLocal' },
        ]),
      ).toThrow('env.additionalFiles[1] (".env.x"): already listed as env.additionalFiles[0]');
    });

    test('an unknown key or scope', () => {
      expect(load([{ file: '.env.x', befor: 'profile' }])).toThrow(
        invalid('0.befor: Invalid key: Expected never but received "befor"'),
      );
      expect(load([{ file: '.env.x', before: 'profile', scope: 'root' }])).toThrow(
        invalid('0.scope: Invalid type: Expected ("workspace" | "service") but received "root"'),
      );
    });

    test('an entry from a callback, by its index, with the profile it was called for', () => {
      expect(load(() => [{ file: '.env.x', before: 'profile', befor: 'x' }])).toThrow(
        'invalid stackctl config:\n  - env.additionalFiles.0.befor: Invalid key: Expected never but received "befor"\n  (returned by the env.additionalFiles callback for profile "development")', // oxfmt-ignore
      );
      expect(
        load(() => [
          { file: '.env.ok', before: 'profile' },
          { file: '.env.x', before: 'nope' },
        ]),
      ).toThrow(
        'env.additionalFiles.1.before: Invalid type: Expected ("base" | "local" | "profile" | "profileLocal") but received "nope"\n  (returned by the env.additionalFiles callback for profile "development")', // oxfmt-ignore
      );
      expect(load(() => [{ file: 'a/.env.x', before: 'profile' }])).toThrow(
        'env.additionalFiles[0] ("a/.env.x"): `file` must be a filename in the scope\'s directory, not a path\n  (returned by the env.additionalFiles callback for profile "development")', // oxfmt-ignore
      );
    });

    test('a callback that returns no array', () => {
      expect(load(async () => [])).toThrow(
        'env.additionalFiles: Invalid type: Expected Array but received Promise',
      );
    });
  });

  test('allows one file at each scope, listed twice', () => {
    const cfg = defineConfig({
      ...base(),
      env: {
        additionalFiles: [
          { file: '.env.x', before: 'profile', scope: 'workspace' },
          { file: '.env.x', after: 'profileLocal', scope: 'service' },
        ],
      },
      services: { api: {} },
    });
    expect(cfg.envFiles.workspace).toContain('.env.x');
    expect(cfg.envFiles.service.at(-1)).toBe('.env.x');
  });
});
