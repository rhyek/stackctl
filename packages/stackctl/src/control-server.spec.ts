import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, afterEach, test, vi } from 'vitest';
import { createControlClient, type SessionEvent, type SessionStartHooks } from './control-client';
import { startControlServer as startServer, type ControlManager } from './control-server';
import { EventLog, type InfraCommandEntry, cliEventLog } from './event-log';
import { sessionId } from './running';
import { sessionEventsPath } from './session-files';
import { waitUntilHealthy } from './stack';

// Its spies are put back after each test, whatever config the suite runs under.
afterEach(() => {
  vi.restoreAllMocks();
});

let server: Awaited<ReturnType<typeof startServer>> | null = null;
let root: string | null = null;
afterEach(async () => {
  vi.unstubAllEnvs();
  await server?.close();
  server = null;
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

/** The server, writing to an event log in a workspace of its own. */
function startControlServer(opts: Omit<Parameters<typeof startServer>[0], 'events'>) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-control-'));
  // The session's folder, the latest, so a command run beside it writes there too.
  fs.mkdirSync(path.dirname(sessionEventsPath(root, 'development', '1')), { recursive: true });
  return startServer({
    ...opts,
    events: new EventLog({
      file: sessionEventsPath(root, 'development', '1'),
      profile: 'development',
      sessionId: () => sessionId(),
    }),
  });
}

/** Lets the server's state tracker write what a change it was told of brings. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** The event log's lines so far. */
const eventLines = () =>
  fs
    .readFileSync(sessionEventsPath(root!, 'development', '1'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

function fakeManager(overrides: Partial<ControlManager> = {}): ControlManager {
  return {
    serviceStatuses: () => ({}),
    getAllReadiness: () => ({}),
    serviceErrors: () => ({}),
    serviceHooks: () => ({}),
    sessionStartHooks: () => 'none',
    sessionError: () => null,
    getConfig: () => null,
    getLogFile: () => '/manager/current.log',
    runPackage: () => Promise.resolve('accepted'),
    getInfraStatuses: () => null,
    runInfra: () => 'accepted',
    quit: () => {},
    logControl: () => {},
    subscribeState: () => () => {},
    ...overrides,
  };
}

/** A port held by a listener of this process, as another session's control API would hold it. */
async function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  return {
    port: (holder.address() as net.AddressInfo).port,
    release: () => new Promise((resolve) => holder.close(() => resolve())),
  };
}

describe('binding its port', () => {
  test('a port taken before the bind is traded for the next one `nextPort` picks', async () => {
    const held = await holdPort();
    const tried: number[][] = [];
    try {
      server = await startControlServer({
        quitHandler: () => {},
        port: held.port,
        nextPort: (ports) => {
          tried.push([...ports]);
          return 0;
        },
      });
      expect(server.port).not.toBe(held.port);
      expect(tried).toEqual([[held.port]]);
      const res = await fetch(`http://127.0.0.1:${server.port}/query/status`);
      expect(res.status).toBe(200);
    } finally {
      await held.release();
    }
  });

  test('gives up after a few ports, all taken', async () => {
    const held = await holdPort();
    const nextPort = vi.fn(() => held.port);
    try {
      await expect(
        startControlServer({ quitHandler: () => {}, port: held.port, nextPort }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(nextPort.mock.calls.length).toBeGreaterThan(0);
      expect(nextPort.mock.calls.length).toBeLessThan(20);
    } finally {
      await held.release();
    }
  });

  test('without `nextPort` (a pinned port), a taken port fails the start', async () => {
    const held = await holdPort();
    try {
      await expect(
        startControlServer({ quitHandler: () => {}, port: held.port }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await held.release();
    }
  });
});

describe('control-server', () => {
  test('GET /query/status serves identity with null services/config before a session is bound', async () => {
    vi.stubEnv('STACKCTL_PROFILE', 'test');
    server = await startControlServer({
      quitHandler: () => {},
      port: 0,
      configPath: '/ws/stackctl.config.ts',
      logFile: '/ws/logs/1.log',
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/query/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pid: process.pid,
      sessionId: sessionId(),
      configPath: '/ws/stackctl.config.ts',
      profile: 'test',
      profileSource: 'env',
      startedByAgent: expect.any(Boolean),
      logFile: '/ws/logs/1.log',
      services: null,
      ready: null,
      errors: null,
      serviceHooks: null,
      infra: null,
      sessionReady: false,
      sessionError: null,
      sessionStartHooks: 'none',
      config: null,
      reverseProxy: null,
    });
  });

  test('GET /query/status reports the dev reverse proxy routes from the start', async () => {
    server = await startControlServer({
      quitHandler: () => {},
      port: 0,
      reverseProxy: {
        port: 4000,
        domain: 'example.test',
        domains: ['example.test', 'example.localhost'],
        routes: [
          { subdomain: ['web', 'www'], service: 'web' },
          { subdomain: ['mail'], service: 'mail' },
          { subdomain: ['*'], paths: { '/docs/**': 'docs', '/**': 'web' } },
        ],
      },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/query/status`);
    expect(res.status).toBe(200);
    // Present before any manager attaches: the routes as `reverseProxy.routes` resolves them,
    // `paths` in its order.
    const body = (await res.json()) as { reverseProxy: { routes: { paths?: object }[] } };
    expect(body.reverseProxy).toEqual({
      port: 4000,
      domain: 'example.test',
      domains: ['example.test', 'example.localhost'],
      routes: [
        { subdomain: ['web', 'www'], service: 'web' },
        { subdomain: ['mail'], service: 'mail' },
        { subdomain: ['*'], paths: { '/docs/**': 'docs', '/**': 'web' } },
      ],
    });
    expect(Object.keys(body.reverseProxy.routes[2]!.paths!)).toEqual(['/docs/**', '/**']);
  });

  test('GET /query/status reflects the session once it is bound (rotation-aware logFile)', async () => {
    vi.stubEnv('STACKCTL_PROFILE', '');
    server = await startControlServer({
      quitHandler: () => {},
      port: 0,
      configPath: '/ws/stackctl.config.ts',
      logFile: '/ws/logs/1.log',
    });
    server.bindSession(
      fakeManager({
        serviceStatuses: () => ({ web: 'running' }),
        getAllReadiness: () => ({ web: true }),
        getConfig: () => ({ packages: [] }),
        getLogFile: () => '/ws/logs/2-rotated.log',
      }),
    );
    const res = await fetch(`http://127.0.0.1:${server.port}/query/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pid: process.pid,
      sessionId: sessionId(),
      configPath: '/ws/stackctl.config.ts',
      profile: 'development',
      profileSource: 'default',
      startedByAgent: expect.any(Boolean),
      logFile: '/ws/logs/2-rotated.log',
      services: { web: 'running' },
      ready: { web: true },
      errors: {},
      serviceHooks: {},
      infra: null,
      sessionReady: true,
      sessionError: null,
      sessionStartHooks: 'none',
      config: { packages: [] },
      reverseProxy: null,
    });
  });

  test('the status says which stop hook a stop of a service still runs', async () => {
    server = await startControlServer({ quitHandler: () => {}, port: 0, configPath: '/ws/c.ts' });
    server.bindSession(
      fakeManager({
        serviceStatuses: () => ({ api: 'stopped', web: 'running' }),
        serviceHooks: () => ({ api: 'beforeStop' }),
      }),
    );
    await settled();
    const status = (await createControlClient(server.port).query.status())!;
    expect(status.serviceHooks).toEqual({ api: 'beforeStop' });
  });

  test('a failed service is reported as failed, never ready, and the session is not ready', async () => {
    server = await startControlServer({ quitHandler: () => {}, port: 0, configPath: '/ws/c.ts' });
    const listeners = new Set<() => void>();
    let statuses: Record<string, string> = { web: 'running', api: 'running' };
    let errors: Record<string, string> = {};
    server.bindSession(
      fakeManager({
        serviceStatuses: () => statuses,
        // `api`'s healthcheck passes; what makes it unready is its failed hook, as the session's
        // readiness reports it.
        getAllReadiness: () => ({ web: true, api: statuses.api === 'running' }),
        serviceErrors: () => errors,
        subscribeState: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      }),
    );
    await settled();
    const client = createControlClient(server.port);
    expect((await client.query.status())!.sessionReady).toBe(true);

    statuses = { web: 'running', api: 'failed' };
    errors = { api: 'afterReady failed: boom' };
    for (const listener of listeners) {
      listener();
    }
    await settled();
    const status = (await client.query.status())!;
    expect(status.services).toEqual({ web: 'running', api: 'failed' });
    expect(status.ready).toEqual({ web: true, api: false });
    expect(status.errors).toEqual({ api: 'afterReady failed: boom' });
    expect(status.sessionReady).toBe(false);
    expect(eventLines().slice(-2)).toMatchObject([
      { type: 'service-state', service: 'api', status: 'failed', ready: false, error: 'afterReady failed: boom', previousStatus: 'running', previousReady: true }, // oxfmt-ignore
      { type: 'session-state', ready: false },
    ]);
    // The snapshot a new client starts from says why, too.
    const events = client.events();
    const { value: snapshot } = await events.next();
    expect(snapshot).toMatchObject({
      type: 'snapshot',
      errors: { api: 'afterReady failed: boom' },
    });
    await events.return(undefined);
  });

  test("a waiting service's line is written when only its reason changes, and a wait already following it fails at once with that reason", async () => {
    server = await startControlServer({ quitHandler: () => {}, port: 0, configPath: '/ws/c.ts' });
    const listeners = new Set<() => void>();
    let statuses: Record<string, string> = { api: 'running', web: 'waiting' };
    let errors: Record<string, string> = {};
    server.bindSession(
      fakeManager({
        serviceStatuses: () => statuses,
        getAllReadiness: () => ({ api: false, web: false }),
        serviceErrors: () => errors,
        subscribeState: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      }),
    );
    await settled();
    // A wait on `web` alone, begun while `api`, which it waits for, has not failed yet.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const waiting = waitUntilHealthy(createControlClient(server.port), ['web'], { deadline: Date.now() + 60_000, timeoutMs: 60_000, logFile: '/s/logs.txt', infra: false, session: false }); // oxfmt-ignore
    let verdict: string | undefined | null = null;
    void waiting.then((v) => (verdict = v));
    await vi.waitFor(() => expect(eventLines().some((l) => l.service === 'web')).toBe(true));
    const before = eventLines().length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(verdict).toBeNull();

    // `api`'s hook fails: `web` stays `waiting` and unready, and only its reason is new.
    const blocked = 'waiting for api, which failed: afterReady failed: boom. Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session'; // oxfmt-ignore
    statuses = { api: 'failed', web: 'waiting' };
    errors = { api: 'afterReady failed: boom', web: blocked };
    listeners.forEach((listener) => listener());
    await settled();
    expect(eventLines().slice(before)).toMatchObject([
      { type: 'service-state', service: 'api', status: 'failed', error: 'afterReady failed: boom', previousStatus: 'running' }, // oxfmt-ignore
      { type: 'service-state', service: 'web', status: 'waiting', ready: false, error: blocked, previousStatus: 'waiting', previousReady: false }, // oxfmt-ignore
    ]);
    expect(await waiting).toBe(`web is ${blocked}. See /s/logs.txt`);
  });

  /** A bound session whose every service is ready, its own start hooks as `hooks` says. */
  async function sessionWithHooks(hooks: { state: SessionStartHooks; error: string | null }) {
    server = await startControlServer({ quitHandler: () => {}, port: 0, configPath: '/ws/c.ts' });
    const listeners = new Set<() => void>();
    server.bindSession(
      fakeManager({
        serviceStatuses: () => ({ api: 'running' }),
        getAllReadiness: () => ({ api: true }),
        sessionStartHooks: () => hooks.state,
        sessionError: () => hooks.error,
        subscribeState: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      }),
    );
    await settled();
    return {
      client: createControlClient(server.port),
      change: async () => {
        listeners.forEach((listener) => listener());
        await settled();
      },
    };
  }

  test("the session is ready only once its own start hooks are done, every service's readiness aside", async () => {
    const hooks = { state: 'afterReady' as SessionStartHooks, error: null };
    const { client, change } = await sessionWithHooks(hooks);
    expect(await client.query.status()).toMatchObject({ sessionReady: false, sessionStartHooks: 'afterReady' }); // oxfmt-ignore
    hooks.state = 'done';
    await change();
    expect(await client.query.status()).toMatchObject({ sessionReady: true, sessionStartHooks: 'done', sessionError: null }); // oxfmt-ignore
    expect(eventLines().at(-1)).toMatchObject({
      type: 'session-state',
      ready: true,
      hooks: 'done',
    });
    expect(eventLines().at(-1)).not.toHaveProperty('error');
  });

  test('a session with no start hook is ready as soon as everything it runs is', async () => {
    const { client } = await sessionWithHooks({ state: 'none', error: null });
    expect(await client.query.status()).toMatchObject({ sessionReady: true, sessionStartHooks: 'none' }); // oxfmt-ignore
  });

  test("the session's start hooks moving on are written on a session-state line, though ready stays false", async () => {
    const hooks = { state: 'afterStart' as SessionStartHooks, error: null };
    const { change } = await sessionWithHooks(hooks);
    hooks.state = 'afterReady';
    await change();
    expect(eventLines().at(-1)).toEqual(expect.objectContaining({ type: 'session-state', ready: false, hooks: 'afterReady' })); // oxfmt-ignore
  });

  test("a session hook's failure is in the status and on a session-state line, though the session was never ready", async () => {
    const hooks = { state: 'afterReady' as SessionStartHooks, error: null as string | null };
    const { client, change } = await sessionWithHooks(hooks);
    hooks.state = 'failed';
    hooks.error = 'session afterReady failed: boom';
    await change();
    expect(await client.query.status()).toMatchObject({ sessionReady: false, sessionStartHooks: 'failed', sessionError: 'session afterReady failed: boom' }); // oxfmt-ignore
    expect(eventLines().at(-1)).toMatchObject({ type: 'session-state', ready: false, hooks: 'failed', error: 'session afterReady failed: boom' }); // oxfmt-ignore
    // A client that starts after it reads it in the snapshot.
    const events = client.events();
    expect((await events.next()).value).toMatchObject({ type: 'snapshot', sessionStartHooks: 'failed', sessionError: 'session afterReady failed: boom' }); // oxfmt-ignore
    await events.return(undefined);
  });

  test("a session hook's failure is written before the services' lines that change with it, as a shutdown stops them", async () => {
    server = await startControlServer({ quitHandler: () => {}, port: 0, configPath: '/ws/c.ts' });
    const listeners = new Set<() => void>();
    let status = 'running';
    let sessionError: string | null = null;
    server.bindSession(
      fakeManager({
        serviceStatuses: () => ({ api: status }),
        getAllReadiness: () => ({ api: status === 'running' }),
        sessionStartHooks: () => 'afterReady',
        sessionError: () => sessionError,
        subscribeState: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      }),
    );
    await settled();
    sessionError = 'session afterReady failed: boom';
    status = 'stopped';
    listeners.forEach((listener) => listener());
    await settled();
    expect(eventLines().slice(-2)).toMatchObject([
      { type: 'session-state', ready: false, error: 'session afterReady failed: boom' },
      { type: 'service-state', service: 'api', status: 'stopped' },
    ]);
  });

  test('trailing slash on /query/status still resolves', async () => {
    server = await startControlServer({ quitHandler: () => {}, port: 0, configPath: '/ws/c.ts' });
    const res = await fetch(`http://127.0.0.1:${server.port}/query/status/`);
    expect(res.status).toBe(200);
  });

  test('removed query subpaths return 404', async () => {
    server = await startControlServer({ quitHandler: () => {}, port: 0, configPath: '/ws/c.ts' });
    server.bindSession(fakeManager());
    const base = `http://127.0.0.1:${server.port}`;
    for (const p of ['/query/pid', '/query/config', '/query/packages', '/query/status/web']) {
      expect((await fetch(`${base}${p}`)).status, p).toBe(404);
    }
  });

  test('POST /command/service/<action>/<name> answers by how the action went', async () => {
    server = await startControlServer({ quitHandler: () => {}, port: 0 });
    const runs: string[] = [];
    server.bindSession(
      fakeManager({
        runPackage: (name, action) => {
          runs.push(`${action} ${name}`);
          if (name === 'worker') {
            return Promise.resolve('waiting');
          }
          if (name !== 'web' && name !== 'api') {
            return Promise.resolve('unknown');
          }
          if (name === 'api') {
            return Promise.resolve(action === 'start' ? 'unavailable' : 'busy');
          }
          return Promise.resolve(action === 'start' || action === 'stop' ? 'done' : 'accepted');
        },
      }),
    );
    const base = `http://127.0.0.1:${server.port}`;
    const post = async (p: string) => {
      const res = await fetch(`${base}${p}`, { method: 'POST' });
      return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
    };
    expect(await post('/command/service/restart/web')).toEqual({ status: 202, body: { ok: true } });
    expect(await post('/command/service/stop/web')).toEqual({ status: 200, body: { ok: true } });
    expect(await post('/command/service/start/web')).toEqual({ status: 200, body: { ok: true } });
    expect(await post('/command/service/stop/api')).toEqual({
      status: 409,
      body: { ok: false, error: 'service "api" is restarting' },
    });
    expect(await post('/command/service/start/api')).toEqual({
      status: 409,
      body: { ok: false, error: 'service "api" has no dev command' },
    });
    expect(await post('/command/service/start/worker')).toEqual({
      status: 409,
      body: { ok: false, error: 'service "worker" is waiting for its dependencies' },
    });
    expect((await post('/command/service/start/nope')).status).toBe(404);
    expect((await post('/command/service/explode/web')).status).toBe(404);
    expect(runs).toEqual([
      'restart web',
      'stop web',
      'start web',
      'stop api',
      'start api',
      'start worker',
      'start nope',
    ]);
  });

  test("hands each command who asked: the request, and the client's User-Agent", async () => {
    server = await startControlServer({ quitHandler: () => {}, port: 0 });
    const asked: unknown[] = [];
    server.bindSession(
      fakeManager({
        runPackage: (_name, _action, by) => {
          asked.push(by);
          return Promise.resolve('accepted');
        },
        runInfra: (_service, _action, by) => {
          asked.push(by);
          return 'accepted';
        },
      }),
    );
    await createControlClient(server.port).command.service.restart('web');
    await fetch(`http://127.0.0.1:${server.port}/command/infra/restart/db`, { method: 'POST', headers: { 'user-agent': 'curl/8.7.1' } }); // oxfmt-ignore
    expect(asked).toEqual([
      { kind: 'control-api', request: 'POST /command/service/restart/web', userAgent: expect.stringMatching(/^stackctl\//) }, // oxfmt-ignore
      { kind: 'control-api', request: 'POST /command/infra/restart/db', userAgent: 'curl/8.7.1' },
    ]);
  });

  test('rebuild is an unknown action', async () => {
    server = await startControlServer({ quitHandler: () => {}, port: 0 });
    const runs: string[] = [];
    server.bindSession(
      fakeManager({
        runPackage: (name, action) => {
          runs.push(`${action} ${name}`);
          return Promise.resolve('accepted');
        },
      }),
    );
    const base = `http://127.0.0.1:${server.port}`;
    const post = async (p: string) => {
      const res = await fetch(`${base}${p}`, { method: 'POST' });
      return { status: res.status, body: (await res.json()) as unknown };
    };
    const rebuild = await post('/command/service/rebuild/web');
    const frobnicate = await post('/command/service/frobnicate/web');
    expect(rebuild.status).toBe(404);
    expect(rebuild.body).toEqual({ ok: false, error: 'unknown service action "rebuild"' });
    expect(frobnicate).toEqual({
      status: 404,
      body: { ok: false, error: 'unknown service action "frobnicate"' },
    });
    expect(runs).toEqual([]);
  });

  test('POST /command/service/start/<name> answers 503 when the session is shutting down', async () => {
    server = await startControlServer({ quitHandler: () => {}, port: 0 });
    server.bindSession(fakeManager({ runPackage: () => Promise.resolve('closing') }));
    const res = await fetch(`http://127.0.0.1:${server.port}/command/service/start/api`, {
      method: 'POST',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'service "api" could not be added: the session is shutting down',
    });
  });

  test('POST /command/service/stop/<name> answers only once the stop is done', async () => {
    server = await startControlServer({ quitHandler: () => {}, port: 0 });
    let finish!: () => void;
    server.bindSession(
      fakeManager({
        runPackage: () =>
          new Promise((resolve) => {
            finish = () => resolve('done');
          }),
      }),
    );
    const answer = fetch(`http://127.0.0.1:${server.port}/command/service/stop/web`, {
      method: 'POST',
    }).then((r) => r.status);
    const early = await Promise.race([
      answer.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 150)),
    ]);
    expect(early).toBe(false);
    finish();
    expect(await answer).toBe(200);
  });

  test('the old /command/restart and /command/rebuild routes are gone', async () => {
    server = await startControlServer({ quitHandler: () => {}, port: 0 });
    server.bindSession(fakeManager());
    const base = `http://127.0.0.1:${server.port}`;
    for (const p of ['/command/restart/web', '/command/rebuild/web']) {
      expect((await fetch(`${base}${p}`, { method: 'POST' })).status, p).toBe(404);
    }
  });

  test('GET /query/status reports the infra services, and POST /command/infra/<action>/<service> runs one', async () => {
    server = await startControlServer({ quitHandler: () => {}, port: 0 });
    const runs: string[] = [];
    const logged: unknown[] = [];
    server.bindSession(
      fakeManager({
        getInfraStatuses: () => ({ db: 'running', cache: 'restarting' }),
        runInfra: (service, action) => {
          runs.push(`${action} ${service}`);
          return service === 'db' ? 'accepted' : service === 'cache' ? 'busy' : 'unknown';
        },
        logControl: (command, attrs) => logged.push({ command, attrs }),
      }),
    );
    const base = `http://127.0.0.1:${server.port}`;
    const status = (await (await fetch(`${base}/query/status`)).json()) as { infra: unknown };
    expect(status.infra).toEqual({ db: 'running', cache: 'restarting' });
    const post = (p: string) => fetch(`${base}${p}`, { method: 'POST' });
    expect((await post('/command/infra/reset/db')).status).toBe(202);
    expect((await post('/command/infra/stop/cache')).status).toBe(409);
    expect((await post('/command/infra/start/mail')).status).toBe(404);
    expect((await post('/command/infra/explode/db')).status).toBe(404);
    expect(runs).toEqual(['reset db', 'stop cache', 'start mail']);
    expect(logged[0]).toEqual({ command: 'infra reset', attrs: { infraService: 'db' } });
  });

  test('mutating commands 503 before the manager attaches', async () => {
    server = await startControlServer({ quitHandler: () => {}, port: 0 });
    const res = await fetch(`http://127.0.0.1:${server.port}/command/service/restart/web`, {
      method: 'POST',
    });
    expect(res.status).toBe(503);
  });

  test('quit works before a session is bound and acks once shutdown releases it', async () => {
    let quit = false;
    // The real shutdown path acks after tearing packages down; a test stub acks inline.
    server = await startControlServer({
      quitHandler: () => {
        quit = true;
        server!.ackQuit();
      },
      port: 0,
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/command/quit`, { method: 'POST' });
    expect(quit).toBe(true);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('holds the /command/quit response open until ackQuit (blocking shutdown)', async () => {
    // quitHandler does NOT ack, so the request must stay pending until we ack explicitly.
    server = await startControlServer({ quitHandler: () => {}, port: 0 });
    const s = server;
    const quitP = fetch(`http://127.0.0.1:${s.port}/command/quit`, { method: 'POST' }).then((r) =>
      r.json(),
    );
    const settledEarly = await Promise.race([
      quitP.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 150)),
    ]);
    expect(settledEarly).toBe(false); // still blocked on the ack
    s.ackQuit();
    expect(await quitP).toEqual({ ok: true });
  });

  test('logs each mutating command with its variables as attrs', async () => {
    const logged: { command: string; attrs?: Record<string, unknown> }[] = [];
    server = await startControlServer({ quitHandler: () => server!.ackQuit(), port: 0 });
    server.bindSession(
      fakeManager({ logControl: (command, attrs) => logged.push({ command, attrs }) }),
    );
    const base = `http://127.0.0.1:${server.port}`;
    await fetch(`${base}/command/service/restart/web`, { method: 'POST' });
    await fetch(`${base}/command/service/stop/api`, { method: 'POST' });
    await fetch(`${base}/command/quit`, { method: 'POST' });
    expect(logged).toEqual([
      { command: 'restart', attrs: { service: 'web' } },
      { command: 'stop', attrs: { service: 'api' } },
      { command: 'quit', attrs: undefined },
    ]);
  });

  test('setQuitHandler swaps which handler /command/quit invokes', async () => {
    let firstCalled = false;
    let secondCalled = false;
    server = await startControlServer({ quitHandler: () => (firstCalled = true), port: 0 });
    server.setQuitHandler(() => {
      secondCalled = true;
      server!.ackQuit();
    });
    await fetch(`http://127.0.0.1:${server.port}/command/quit`, { method: 'POST' });
    expect(secondCalled).toBe(true);
    expect(firstCalled).toBe(false);
  });

  describe('GET /events', () => {
    /** A manager whose state the test sets, and tells the server about, as a real one would. */
    function liveManager() {
      const listeners = new Set<() => void>();
      const state = {
        services: { web: 'running', api: 'waiting' } as Record<string, string>,
        ready: { web: false, api: false } as Record<string, boolean>,
        infra: { db: 'starting' } as Record<string, string>,
      };
      const manager = fakeManager({
        serviceStatuses: () => ({ ...state.services }),
        getAllReadiness: () => ({ ...state.ready }),
        getInfraStatuses: () => ({ ...state.infra }) as never,
        subscribeState: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      });
      const change = (fn: (s: typeof state) => void) => {
        fn(state);
        for (const listener of listeners) {
          listener();
        }
      };
      return { manager, change };
    }

    /** The next `n` events of a stream, skipping heartbeats. */
    async function take(iterator: AsyncIterator<SessionEvent>, n: number) {
      const out: SessionEvent[] = [];
      while (out.length < n) {
        const { value, done } = await iterator.next();
        if (done) {
          break;
        }
        if (value.type !== 'heartbeat') {
          out.push(value);
        }
      }
      return out;
    }

    test('sends the snapshot, then each change as a line of JSON', async () => {
      server = await startControlServer({ quitHandler: () => {}, port: 0, configPath: '/ws/c.ts' });
      const { manager, change } = liveManager();
      server.bindSession(manager);
      await settled();
      const events = createControlClient(server.port).events();

      const [snapshot] = await take(events, 1);
      expect(snapshot).toMatchObject({
        type: 'snapshot',
        pid: process.pid,
        sessionId: sessionId(),
        services: { web: 'running', api: 'waiting' },
        sessionReady: false,
      });

      change((s) => {
        s.ready.web = true;
        s.infra.db = 'running';
      });
      expect(await take(events, 2)).toMatchObject([
        { type: 'service-state', service: 'web', status: 'running', ready: true, previousStatus: 'running', previousReady: false }, // oxfmt-ignore
        { type: 'infra-state', service: 'db', status: 'running', previousStatus: 'starting' },
      ]);

      change((s) => {
        s.services.api = 'running';
        s.ready.api = true;
      });
      expect(await take(events, 2)).toMatchObject([
        { type: 'service-state', service: 'api', status: 'running', ready: true, previousStatus: 'waiting', previousReady: false }, // oxfmt-ignore
        { type: 'session-state', ready: true },
      ]);

      change((s) => {
        s.services.api = 'stopped';
        s.ready.api = false;
        s.ready.web = false;
      });
      expect(await take(events, 3)).toMatchObject([
        { type: 'service-state', service: 'web', status: 'running', ready: false },
        { type: 'service-state', service: 'api', status: 'stopped', ready: false, previousStatus: 'running', previousReady: true }, // oxfmt-ignore
        { type: 'session-state', ready: false },
      ]);
      await events.return(undefined);
    });

    test('writes each change to the event log, with what it was, whether a client listens or not', async () => {
      server = await startControlServer({ quitHandler: () => {}, port: 0, configPath: '/ws/c.ts' });
      const { manager, change } = liveManager();
      server.bindSession(manager);
      await settled();
      change((s) => (s.ready.web = true));
      await settled();
      expect(eventLines()).toMatchObject([
        // as it was when the session bound: nothing before it
        { type: 'service-state', service: 'web', status: 'running', ready: false, previousStatus: null, previousReady: null }, // oxfmt-ignore
        { type: 'service-state', service: 'api', status: 'waiting', ready: false, previousStatus: null, previousReady: null }, // oxfmt-ignore
        { type: 'infra-state', service: 'db', status: 'starting', previousStatus: null },
        { type: 'service-state', service: 'web', status: 'running', ready: true, previousStatus: 'running', previousReady: false, profile: 'development', sessionId: sessionId(), pid: process.pid }, // oxfmt-ignore
      ]);
    });

    test("streams what another process writes to the event log, in the file's order", async () => {
      server = await startControlServer({ quitHandler: () => {}, port: 0, configPath: '/ws/c.ts' });
      const events = createControlClient(server.port).events();
      await take(events, 1);
      // a `stackctl infra restart` run from a terminal: its own process, its own log handle
      cliEventLog(root!, 'development')
        .begin<InfraCommandEntry>(
          { type: 'infra-command', action: 'restart', requested: ['db'] },
          { kind: 'cli', argv: ['infra', 'restart', '-s', 'db'], cwd: '.', agent: false },
        ) // oxfmt-ignore
        .end({ ok: true, services: ['db'], results: { db: 'ready' } });
      expect(await take(events, 2)).toMatchObject([
        { type: 'infra-command', phase: 'begin', action: 'restart', requested: ['db'], by: { kind: 'cli', agent: false } }, // oxfmt-ignore
        { type: 'infra-command', phase: 'end', ok: true, results: { db: 'ready' } },
      ]);
      await events.return(undefined);
    });

    test('says nothing for a change that changes nothing', async () => {
      server = await startControlServer({ quitHandler: () => {}, port: 0, configPath: '/ws/c.ts' });
      const { manager, change } = liveManager();
      server.bindSession(manager);
      await settled();
      const events = createControlClient(server.port).events();
      await take(events, 1);
      change(() => {});
      change((s) => (s.ready.web = true));
      expect(await take(events, 1)).toMatchObject([
        { type: 'service-state', service: 'web', status: 'running', ready: true },
      ]);
      await events.return(undefined);
    });

    test('is a stream of JSON lines a plain HTTP client can read', async () => {
      server = await startControlServer({ quitHandler: () => {}, port: 0, configPath: '/ws/c.ts' });
      const res = await fetch(`http://127.0.0.1:${server.port}/events`);
      expect(res.headers.get('content-type')).toBe('application/x-ndjson');
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const line = new TextDecoder().decode(value);
      expect(line.endsWith('\n')).toBe(true);
      expect(JSON.parse(line)).toMatchObject({ type: 'snapshot', services: null });
      await reader.cancel();
    });

    test('ends every open stream when the server closes, without waiting on its client', async () => {
      server = await startControlServer({ quitHandler: () => {}, port: 0, configPath: '/ws/c.ts' });
      const events = createControlClient(server.port).events();
      await take(events, 1);
      const closing = server.close();
      server = null;
      await closing;
      expect(await events.next()).toEqual({ value: undefined, done: true });
    });
  });
});
