import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, afterEach, test, vi } from 'vitest';
import { createControlClient, type SessionEvent } from './control-client.js';
import { startControlServer as startServer, type ControlManager } from './control-server.js';
import { EventLog, type InfraCommandEntry, cliEventLog, eventsFilePath } from './event-log.js';
import { sessionId } from './running.js';

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
  return startServer({
    ...opts,
    events: new EventLog({ root, mode: 'development', sessionId: () => sessionId() }),
  });
}

/** Lets the server's state tracker write what a change it was told of brings. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** The event log's lines so far. */
const eventLines = () =>
  fs
    .readFileSync(eventsFilePath(root!, 'development'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

function fakeManager(overrides: Partial<ControlManager> = {}): ControlManager {
  return {
    serviceStatuses: () => ({}),
    getAllReadiness: () => ({}),
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

describe('control-server', () => {
  test('GET /query/status serves identity with null services/config before a session is bound', async () => {
    vi.stubEnv('STACKCTL_MODE', 'test');
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
      mode: 'test',
      modeSource: 'env',
      startedByAgent: expect.any(Boolean),
      logFile: '/ws/logs/1.log',
      services: null,
      ready: null,
      infra: null,
      sessionReady: false,
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
    vi.stubEnv('STACKCTL_MODE', '');
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
      mode: 'development',
      modeSource: 'default',
      startedByAgent: expect.any(Boolean),
      logFile: '/ws/logs/2-rotated.log',
      services: { web: 'running' },
      ready: { web: true },
      infra: null,
      sessionReady: true,
      config: { packages: [] },
      reverseProxy: null,
    });
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
    expect((await post('/command/service/start/nope')).status).toBe(404);
    expect((await post('/command/service/explode/web')).status).toBe(404);
    expect(runs).toEqual([
      'restart web',
      'stop web',
      'start web',
      'stop api',
      'start api',
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
        { type: 'service-state', service: 'web', status: 'running', ready: true, previousStatus: 'running', previousReady: false, mode: 'development', sessionId: sessionId(), pid: process.pid }, // oxfmt-ignore
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
