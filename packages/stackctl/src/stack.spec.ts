import { afterEach, describe, expect, test, vi } from 'vitest';
import { defineConfig } from './config';
import type { ControlClient, SessionEvent } from './control-client';
import { originsOf, stackEnvironment, startStack, startStackArgs, waitUntilHealthy } from './stack';

// Its spies are put back after each test, whatever config the suite runs under.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('originsOf', () => {
  test("lists each service's public origin: its route's, else its port's, and none without either", () => {
    const config = defineConfig({
      serviceRootDir: 'apps',
      reverseProxy: {
        port: 4000,
        publicAddress: { domain: 'example.test', scheme: 'https' },
        routes: [
          { subdomain: 'api', service: 'api' },
          { subdomain: 'app', paths: { '/docs/**': 'docs' } },
          { subdomain: '*', service: 'web' },
        ],
      },
      services: {
        api: { port: 3001 },
        web: { port: 3000 },
        docs: { port: 3002 },
        worker: { port: 3003 },
        lib: {},
      },
    });
    // As the session reports it on `/query/status`: JSON, so an `undefined` is no key at all.
    expect(originsOf(JSON.parse(JSON.stringify(config)))).toEqual({
      api: 'https://api.example.test',
      worker: 'http://localhost:3003',
    });
    expect(originsOf(null)).toEqual({});
  });
});

describe('stackEnvironment', () => {
  const shell = { PATH: '/usr/bin', HOME: '/home/dev', PNPM_HOME: '/home/dev/.pnpm' };

  test('drops what a package manager script adds, and keeps the shell', () => {
    const env = stackEnvironment({
      ...shell,
      INIT_CWD: '/ws',
      NODE: '/usr/bin/node',
      NODE_PATH: '/ws/node_modules/.pnpm/node_modules',
      PNPM_SCRIPT_SRC_DIR: '/ws',
      npm_lifecycle_event: 'test:e2e',
      npm_package_name: 'app',
    });
    expect(env).toEqual(shell);
  });

  test("drops Vitest's and Vite's variables under Vitest", () => {
    const env = stackEnvironment({
      ...shell,
      VITEST: 'true',
      VITEST_POOL_ID: '1',
      NODE_ENV: 'test',
      MODE: 'test',
      DEV: '1',
      PROD: '',
      SSR: '',
      BASE_URL: '/',
      TEST: 'true',
    });
    expect(env).toEqual(shell);
  });

  test("drops Jest's variables under Jest", () => {
    expect(stackEnvironment({ ...shell, JEST_WORKER_ID: '1', NODE_ENV: 'test' })).toEqual(shell);
  });

  test("keeps a shell's NODE_ENV and MODE outside a test runner", () => {
    const env = { ...shell, NODE_ENV: 'development', MODE: 'x' };
    expect(stackEnvironment(env)).toEqual(env);
  });
});

describe('startStack', () => {
  test('tags are passed to the session as -t', () => {
    expect(startStackArgs({ services: ['api'], tags: ['backend', 'jobs'] })).toEqual([
      'start',
      '--headless',
      '-s',
      'api',
      '-t',
      'backend',
      '-t',
      'jobs',
    ]);
    expect(startStackArgs({ tags: ['backend'], profile: 'test', killOthers: true })).toEqual([
      '--profile',
      'test',
      'start',
      '--headless',
      '-t',
      'backend',
      '--kill-others',
    ]);
  });

  test('neither services nor tags throws', async () => {
    const message = 'startStack: `services` or `tags` must name something';
    await expect(startStack({})).rejects.toThrow(message);
    await expect(startStack({ services: [], tags: [] })).rejects.toThrow(message);
  });

  test.each([
    [{ services: 'api' }, 'startStack: `services` takes an array of strings'],
    [{ services: ['api', 3] }, 'startStack: `services` takes an array of strings'],
    [{ tags: 'backend' }, 'startStack: `tags` takes an array of strings'],
    [{ tags: [3] }, 'startStack: `tags` takes an array of strings'],
  ])('a malformed selection throws: %j', async (selection, message) => {
    await expect(startStack(selection as never)).rejects.toThrow(message);
  });
});

describe('waitUntilHealthy', () => {
  /** A session whose `/events` sends `lines`, then stays open until the waiter lets go. */
  const sessionSending = (lines: SessionEvent[], now: Record<string, unknown> = {}) =>
    ({
      // What it answers `GET /query/status` with.
      query: { status: async () => now },
      events: async function* (opts: { signal?: AbortSignal } = {}) {
        yield* lines;
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
          }
          opts.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    }) as unknown as ControlClient;

  const snapshot = (over: Record<string, unknown>) =>
    ({
      type: 'snapshot',
      services: { api: 'running' },
      ready: { api: false },
      errors: {},
      infra: null,
      ...over,
    }) as unknown as SessionEvent;

  const waitFor = (control: ControlClient) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return waitUntilHealthy(control, ['api'], {
      deadline: Date.now() + 300_000,
      timeoutMs: 300_000,
      logFile: '/s/logs.txt',
      infra: false,
    });
  };

  test("gives up at once on a service failed by its hook, with the hook's message", async () => {
    const control = sessionSending([
      snapshot({
        services: { api: 'failed' },
        errors: { api: 'afterReady failed: boom' },
      }),
    ]);
    expect(await waitFor(control)).toBe(
      'api failed: afterReady failed: boom. Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session. See /s/logs.txt',
    );
  });

  test('gives up as soon as a service it waits on fails', async () => {
    const control = sessionSending([
      snapshot({}),
      {
        type: 'service-state',
        service: 'api',
        status: 'failed',
        ready: false,
        error: 'afterStart failed: no DATABASE_URL',
        previousStatus: 'running',
        previousReady: false,
      } as unknown as SessionEvent,
    ]);
    expect(await waitFor(control)).toBe(
      'api failed: afterStart failed: no DATABASE_URL. Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session. See /s/logs.txt',
    );
  });

  /** `waitUntilHealthy` on `api` within 10 s of fake time, for the whole session or not. */
  async function waitOnApi(
    lines: SessionEvent[],
    session: boolean,
    now: Record<string, unknown> = {},
    wanted = ['api'],
  ) {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const verdict = waitUntilHealthy(sessionSending(lines, now), wanted, {
        deadline: Date.now() + 10_000,
        timeoutMs: 10_000,
        logFile: '/s/logs.txt',
        session,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      return await verdict;
    } finally {
      vi.useRealTimers();
    }
  }

  test.each(['afterStart', 'afterReady'] as const)(
    "a wait for the whole session waits for the session's %s, naming it; a wait naming services doesn't",
    async (hook) => {
      const lines = [snapshot({ ready: { api: true }, sessionReady: false, sessionStartHooks: hook })]; // oxfmt-ignore
      expect(await waitOnApi(lines, true)).toBe(`not ready after 10s: the session's ${hook}`);
      expect(await waitOnApi(lines, false)).toBeUndefined();
    },
  );

  test('a wait whose time is up names what each service was held by: the hook it still runs, its dependencies', async () => {
    const lines = [
      snapshot({
        services: { api: 'running', web: 'waiting', worker: 'running' },
        ready: { api: false, web: false, worker: false },
        sessionStartHooks: 'afterReady',
      }),
    ];
    const now = { serviceHooks: { api: 'afterReady' } };
    expect(await waitOnApi(lines, true, now, ['api', 'web', 'worker'])).toBe(
      "not ready after 10s: api (its afterReady is still running), web (waiting for its dependencies), worker, the session's afterReady (it runs once they are ready)",
    );
  });

  test("gives up at once on a service that was never started because its beforeStart failed, with the hook's error", async () => {
    const control = sessionSending([
      snapshot({ services: { api: 'waiting' } }),
      {
        type: 'service-state',
        service: 'api',
        status: 'stopped',
        ready: false,
        error: 'beforeStart failed: no codegen',
        previousStatus: 'waiting',
        previousReady: false,
      } as unknown as SessionEvent,
    ]);
    expect(await waitFor(control)).toBe(
      'api failed to start: beforeStart failed: no codegen. Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session. See /s/logs.txt',
    );
  });

  test('a service held by one the same wait says failed is only said to wait for it: the reason and the advice are given once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const advice = 'Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session'; // oxfmt-ignore
    const control = sessionSending([
      snapshot({
        services: { api: 'stopped', web: 'waiting' },
        ready: { api: false, web: false },
        errors: {
          api: 'beforeStart failed: no codegen',
          web: `waiting for api, which failed to start: beforeStart failed: no codegen. ${advice}`,
        },
      }),
    ]);
    const verdict = await waitUntilHealthy(control, ['api', 'web'], { deadline: Date.now() + 300_000, timeoutMs: 300_000, logFile: '/s/logs.txt', infra: false }); // oxfmt-ignore
    expect(verdict).toBe(`api failed to start: beforeStart failed: no codegen. ${advice}. web is waiting for api. See /s/logs.txt`); // oxfmt-ignore
  });

  test('a service stopped with no reason is still said to have stopped while starting', async () => {
    const control = sessionSending([snapshot({ services: { api: 'stopped' } })]);
    expect(await waitFor(control)).toBe('api stopped while starting; see /s/logs.txt');
  });

  test("gives up with the session's own reason when it ends for a failed start, even before it reported any service", async () => {
    const control = sessionSending([
      // Not attached yet: its `beforeStart` failed before it had services to report.
      snapshot({ services: null, ready: null, errors: null }),
      {
        type: 'session-end',
        cause: 'error',
        error: 'session beforeStart failed: boom',
        durationMs: 40,
      } as unknown as SessionEvent,
    ]);
    expect(await waitFor(control)).toBe('session beforeStart failed: boom. See /s/logs.txt');
  });

  test('a session that ends its events before everything is ready is said to have ended, with its log', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const control = {
      events: async function* () {
        yield snapshot({});
      },
    } as unknown as ControlClient;
    const verdict = await waitUntilHealthy(control, ['api'], { deadline: Date.now() + 300_000, timeoutMs: 300_000, logFile: '/s/logs.txt' }); // oxfmt-ignore
    expect(verdict).toBe('the session ended before everything was ready; see /s/logs.txt');
  });

  test("a wait for the whole session is done once the session's start hooks are", async () => {
    const lines = [
      snapshot({ ready: { api: true }, sessionReady: false, sessionStartHooks: 'afterReady' }),
      { type: 'session-state', ready: true, hooks: 'done' } as unknown as SessionEvent,
    ];
    expect(await waitOnApi(lines, true)).toBeUndefined();
  });

  test("a wait for the whole session doesn't wait for a service outside its set", async () => {
    const lines = [
      snapshot({
        // `extra`, started by hand, never gets ready: the session isn't, the wait's set is.
        services: { api: 'running', extra: 'running' },
        ready: { api: true, extra: false },
        sessionReady: false,
        sessionStartHooks: 'done',
      }),
    ];
    expect(await waitOnApi(lines, true)).toBeUndefined();
  });

  test.each([
    ['none', { sessionStartHooks: 'none' }],
    ['missing, from an older session', {}],
  ])(
    'a wait for the whole session with no start hook (%s) waits on nothing new',
    async (_kind, over) => {
      const lines = [snapshot({ services: { api: 'running', extra: 'running' }, ready: { api: true, extra: false }, sessionReady: false, ...over })]; // oxfmt-ignore
      expect(await waitOnApi(lines, true)).toBeUndefined();
    },
  );

  test('a session-state line without hooks, as an older session writes it, leaves nothing to wait for', async () => {
    const lines = [
      snapshot({ ready: { api: true }, sessionReady: false, sessionStartHooks: 'afterReady' }),
      { type: 'session-state', ready: false } as unknown as SessionEvent,
    ];
    expect(await waitOnApi(lines, true)).toBeUndefined();
  });

  test('a wait for the whole session gives up at once on failed start hooks with no error, as another server may report them', async () => {
    const lines = [snapshot({ ready: { api: true }, sessionStartHooks: 'failed' })];
    expect(await waitOnApi(lines, true)).toBe("the session's start hooks failed. See /s/logs.txt");
  });

  test.each([
    [
      'in the snapshot',
      [snapshot({ ready: { api: true }, sessionError: 'session afterReady failed: boom' })],
    ],
    [
      'once it has stopped its services for it',
      [
        snapshot({
          services: { api: 'stopped' },
          sessionError: 'session afterReady failed: boom',
        }),
      ],
    ],
    [
      'as it happens',
      [
        snapshot({ ready: { api: true } }),
        {
          type: 'session-state',
          ready: false,
          error: 'session afterReady failed: boom',
        } as unknown as SessionEvent,
      ],
    ],
  ] as const)(
    "a wait for the whole session gives up at once when the session's afterReady throws, with its message: %s",
    async (_when, lines) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const control = sessionSending([...lines]);
      const verdict = await waitUntilHealthy(control, ['api'], {
        deadline: Date.now() + 300_000,
        timeoutMs: 300_000,
        logFile: '/s/logs.txt',
      });
      expect(verdict).toBe('session afterReady failed: boom. See /s/logs.txt');
    },
  );

  test('gives up at once on a service waiting for one that failed, naming it and its error', async () => {
    const control = sessionSending([
      snapshot({
        services: { api: 'waiting', db: 'failed' },
        ready: { api: false, db: false },
        errors: {
          api: 'waiting for db, which failed: afterReady failed: boom. Run stackctl service restart -s db once it is fixed; a change to stackctl.config.ts needs a new session',
          db: 'afterReady failed: boom',
        },
      }),
    ]);
    expect(await waitFor(control)).toBe(
      'api is waiting for db, which failed: afterReady failed: boom. Run stackctl service restart -s db once it is fixed; a change to stackctl.config.ts needs a new session. See /s/logs.txt',
    );
  });

  test('gives up as soon as a service it waits on is held by one that failed', async () => {
    const control = sessionSending([
      snapshot({ services: { api: 'waiting' } }),
      {
        type: 'service-state',
        service: 'api',
        status: 'waiting',
        ready: false,
        error:
          'waiting for db, which failed: afterStart failed: x. Run stackctl service restart -s db once it is fixed; a change to stackctl.config.ts needs a new session',
        previousStatus: 'waiting',
        previousReady: false,
      } as unknown as SessionEvent,
    ]);
    expect(await waitFor(control)).toBe(
      'api is waiting for db, which failed: afterStart failed: x. Run stackctl service restart -s db once it is fixed; a change to stackctl.config.ts needs a new session. See /s/logs.txt',
    );
  });
});
