import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { type AnyServiceConfig, defineConfig } from '../config';
import type { ControlManager } from '../control-server';
import type { DevReverseProxyManager, DevReverseProxyServer } from '../dev-reverse-proxy';
import { EventLog, type EventBy } from '../event-log';
import { stripAnsi } from '../format';
import { InfraFailedError } from '../infra/session';
import type { InfraEvent } from '../infra/types';
import { runHook } from '../lifecycle/hooks';
import { readRunning, writeRunning } from '../running';
import type { ServiceGroups, ServiceUsage, UsageReader } from '../service-usage';
import { sessionEventsPath } from '../session-files';
import { STOP_HOOK_BUDGET_MS } from '../shutdown-timing';
import type { Exec } from '../spawn';
import { runHeadless } from './headless';
import { labelGutter } from './log-layout';
import { buildSessionPlan } from './plan';
import type {
  ProcessExit,
  ProcessState,
  ServiceProcessEvents,
  ServiceProcessOptions,
} from './service-process';
import {
  type InfraProgress,
  type ParentChannel,
  Session,
  type SessionSeams,
  tellParent,
} from './session';
import type { SupervisedProcess, Supervisor } from './supervisor';
import type { SessionInfra, SessionPlan } from './types';

// Its spies are put back after each test, whatever config the suite runs under.
afterEach(() => {
  vi.restoreAllMocks();
});

let nextPid = 910_000;

/** A process that runs only in the test. A stop ends it at once, unless the test holds stops. */
class StubProcess extends EventEmitter<ServiceProcessEvents> implements SupervisedProcess {
  state: ProcessState = 'idle';
  pid: number | null = null;
  exitCode: number | null = null;
  kills = 0;
  private resolveExit!: (exit: ProcessExit) => void;
  private readonly exited = new Promise<ProcessExit>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(
    readonly opts: ServiceProcessOptions,
    private readonly holdStops: boolean,
  ) {
    super();
  }

  start(): void {
    this.pid = nextPid++;
    this.set('running');
  }

  stop(): Promise<ProcessExit> {
    this.set('stopping');
    if (!this.holdStops) {
      this.exit({ code: null, signal: 'SIGTERM' });
    }
    return this.exited;
  }

  kill(): void {
    this.kills++;
    this.exit({ code: null, signal: 'SIGKILL' });
  }

  /** Exits on its own, with `code`: a crash nothing asked for. */
  crash(code: number): void {
    this.exit({ code, signal: null });
  }

  private exit(exit: ProcessExit): void {
    if (this.state === 'exited') {
      return;
    }
    this.exitCode = exit.code ?? (exit.signal === 'SIGKILL' ? 137 : 143);
    this.set('exited');
    this.resolveExit(exit);
    this.emit('exit', exit);
  }

  private set(state: ProcessState): void {
    this.state = state;
    this.emit('state', state);
  }
}

/** Who asked, as a test's control API request would say. */
const BY = { kind: 'control-api', request: 'POST /command/test', userAgent: null } as const;

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** Waits until `check` stops throwing. */
const until = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 10 });

/** Lets every pending promise callback run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A workspace in a temp directory with a `package.json` per service, its config defined, and a
 * Session over the services `selected` whose every outside step is a recording stub: `order`
 * lists each step as it begins.
 */
function setup(opts: {
  services: Record<string, Record<string, unknown>>;
  selected?: string[];
  /** The config's `infra`, as written. */
  infra?: Record<string, unknown>;
  /** The config's `session`, as written: which hooks it has (a `runSessionHook` seam runs them). */
  session?: Record<string, unknown>;
  /** The services whose processes don't end on a stop. */
  holdStops?: string[];
  seams?: Partial<SessionSeams>;
  /** A session shown on a screen (the TUI). */
  interactive?: boolean;
  /** Started by `startStack()`. */
  forked?: boolean;
  /** Started by `start --detach`. */
  detached?: boolean;
  /** The config's `apiPort`: a pinned control port. */
  apiPort?: number;
}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-session-')));
  for (const name of Object.keys(opts.services)) {
    const dir = path.join(root, 'packages', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, scripts: { dev: `node ${name}.js` } }),
    );
  }
  const config = defineConfig({
    workspaceDir: root,
    serviceRootDir: 'packages',
    services: opts.services,
    ...(opts.infra ? { infra: opts.infra } : {}),
    ...(opts.session ? { session: opts.session } : {}),
    ...(opts.apiPort === undefined ? {} : { apiPort: opts.apiPort }),
  } as unknown as Parameters<typeof defineConfig>[0]);
  const all = Object.values(config.services) as AnyServiceConfig[];
  const selected = all.filter((s) =>
    (opts.selected ?? Object.keys(opts.services)).includes(s.name),
  );
  const logFile = path.join(root, 'session.log');
  const plan: SessionPlan = {
    ...buildSessionPlan(selected.map((s) => s.name)),
    cwd: root,
    resolvedWorkspaceDir: root,
    envFiles: ['.env'],
  };

  const order: string[] = [];
  const procs: StubProcess[] = [];
  const signalled: [number, NodeJS.Signals][] = [];
  const proxy = {
    port: 0,
    domain: 'localhost',
    domains: ['localhost'],
    routes: [],
    attached: null as DevReverseProxyManager | null,
    closed: false,
    bindSession(manager: DevReverseProxyManager) {
      this.attached = manager;
    },
    markInfraReady() {
      order.push('markInfraReady');
    },
    close() {
      this.closed = true;
      return Promise.resolve();
    },
  } satisfies DevReverseProxyServer & Record<string, unknown>;
  const server = {
    port: 4321,
    /** The port the session asked it to listen on. */
    askedFor: null as number | null,
    attached: null as ControlManager | null,
    quitHandler: null as ((by: EventBy) => void) | null,
    acks: 0,
    flushes: 0,
    closed: false,
    bindSession(manager: ControlManager) {
      this.attached = manager;
    },
    setQuitHandler(fn: (by: EventBy) => void) {
      this.quitHandler = fn;
    },
    ackQuit() {
      this.acks++;
    },
    flush() {
      this.flushes++;
    },
    close() {
      this.closed = true;
      return Promise.resolve();
    },
  };
  const seams: SessionSeams = {
    acquire: (onStatus) => {
      order.push('takeover');
      onStatus('freeing dev ports');
      return Promise.resolve(4321);
    },
    startProxy: () => {
      order.push('proxy');
      return Promise.resolve(proxy);
    },
    startControlServer: (o) => {
      order.push('control server');
      server.quitHandler = o.quitHandler;
      server.askedFor = o.port;
      return Promise.resolve(server);
    },
    runInfra: () => {
      order.push('infra');
      return Promise.resolve(undefined);
    },
    createProcess: (o) => {
      order.push(`spawn ${o.name}`);
      const proc = new StubProcess(o, opts.holdStops?.includes(o.name) ?? false);
      procs.push(proc);
      return proc;
    },
    probe: () => Promise.resolve(true),
    readBranch: () => 'main',
    watchBranch: () => ({ branch: 'main', stop: () => {} }),
    signalGroup: (pid, signal) => signalled.push([pid, signal]),
    installSignals: () => () => {},
    events: new EventLog({
      file: sessionEventsPath(root, 'development', '1'),
      profile: 'development',
      sessionId: () => 'session-test',
    }),
    ...opts.seams,
  };
  const session = new Session({ plan, configPath: path.join(root, 'stackctl.config.ts'), logFile, forked: opts.forked ?? false, detached: opts.detached, interactive: opts.interactive, seams }); // oxfmt-ignore
  const progress: InfraProgress[] = [];
  session.subscribeInfra((p) => progress.push(p));
  let closedCode: number | null = null;
  void session.closed.then((code) => {
    closedCode = code;
  });
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanups.push(async () => {
    if (closedCode === null) {
      void session.shutdown('signal');
      void session.shutdown('signal');
      await session.closed;
    }
  });
  return {
    root,
    plan,
    session,
    order,
    procs,
    proxy,
    server,
    signalled,
    progress,
    closedCode: () => closedCode,
    /** Every buffered line as `label text`, colors stripped and the label's padding kept. */
    lines: () =>
      session.logs
        .getVisibleLines()
        .map((l) => `${labelGutter(l.label, session.logs.labelWidth)} ${stripAnsi(l.text)}`),
  };
}

describe('startup', () => {
  test('startup order is takeover, proxy, control server, infra, services', async () => {
    const t = setup({ services: { api: {}, web: {} } });
    expect(t.session.getSnapshot().phase).toBe('starting');
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(2));
    expect(t.order).toEqual([
      'takeover',
      'proxy',
      'control server',
      'infra',
      'markInfraReady',
      'spawn api',
      'spawn web',
    ]);
    expect(t.server.attached).toBe(t.session);
    expect(t.proxy.attached).toBe(t.session);
    expect(t.session.getSnapshot().phase).toBe('running');
    expect(t.lines()).toEqual([
      '[stackctl] [INFO] profile development (default)',
      '[stackctl] [INFO] freeing dev ports',
      '[api     ] started',
      '[web     ] started',
    ]);
  });

  test('each dep not picked gets a line saying why it runs', async () => {
    const t = setup({
      services: { api: {}, web: { deps: [{ service: 'api' }] } },
      selected: ['web'],
    });
    await t.session.start();
    expect(t.lines()[1]).toBe('[stackctl] [INFO] api: runtime dep of web');
  });

  test("every label is padded to one width: the services', and infra's from the config and the provider", async () => {
    let finish!: (infra: SessionInfra) => void;
    const t = setup({
      services: { backend: {}, frontend: {} },
      infra: { 'docker-compose': { services: { db: {}, mail: {} } } },
      seams: {
        runInfra: (onEvent) => {
          // `queue` is in the compose file only: the provider names it with the targets.
          onEvent({ type: 'targets', provider: 'docker-compose', action: 'up', services: ['db', 'mail', 'queue'] }); // oxfmt-ignore
          onEvent({ type: 'output', line: 'Container db Started', isError: false });
          onEvent({ type: 'output', service: 'db', line: 'migrated', isError: false });
          onEvent({ type: 'output', service: 'queue', line: 'listening', isError: false });
          return new Promise((resolve) => (finish = resolve));
        },
      },
    });
    // Before infra starts, the width is the config's: `infra:mail`.
    expect(t.session.logs.labelWidth).toBe('infra:mail'.length);
    void t.session.start();
    await until(() => expect(t.lines()).toContain('[infra:queue] listening'));
    // Every line so far is drawn at the new width, the ones from before `queue` was known too.
    const labels = t.lines().map((line) => line.slice(0, line.indexOf(']') + 1));
    expect(new Set(labels.map((l) => l.length))).toEqual(new Set(['[infra:queue]'.length]));
    expect(labels).toEqual(
      expect.arrayContaining(['[stackctl   ]', '[infra      ]', '[infra:db   ]']),
    );
    finish({ services: [] });
  });

  test('app services are pending until infra is ready, and bind nothing before', async () => {
    let finish!: (infra: SessionInfra) => void;
    const t = setup({
      services: { api: {} },
      seams: {
        runInfra: (onEvent) => {
          onEvent({ type: 'targets', provider: 'docker-compose', action: 'up', services: ['db'] });
          onEvent({ type: 'output', service: 'db', line: 'migrated', isError: false });
          onEvent({ type: 'status', service: 'db', status: 'starting', detail: 'waiting for healthy' }); // oxfmt-ignore
          return new Promise((resolve) => (finish = resolve));
        },
      },
    });
    void t.session.start();
    await until(() => expect(t.session.getSnapshot().infra).toHaveLength(1));
    const starting = t.session.getSnapshot();
    expect(starting.services.map((s) => s.state)).toEqual(['pending']);
    expect(starting.infra[0]).toMatchObject({ name: 'db', state: 'starting', detail: 'waiting for healthy' }); // oxfmt-ignore
    expect(t.server.attached).toBeNull();
    expect(t.lines()).toContain('[infra:db] migrated');
    expect(t.progress.map((p) => p.type)).toEqual(['targets', 'status']);

    finish({ services: [{ provider: 'docker-compose', name: 'db' }] });
    await until(() => expect(t.procs).toHaveLength(1));
    expect(t.session.getInfraStatuses()).toEqual({ db: 'running' });
    expect(t.progress.at(-1)).toEqual({ type: 'finished', summary: { ok: true, services: [] } });
  });

  test("the session's beforeStart runs after the takeover and before the infra, its lines in the log", async () => {
    let mode: string | undefined;
    const t = setup({
      services: { api: {} },
      seams: {
        runSessionHook: async (_hook, m, write) => {
          mode = m;
          t.order.push('beforeStart');
          write('removed apps/legacy', false);
          return 'done';
        },
      },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    expect(t.order.slice(0, 5)).toEqual(['takeover', 'proxy', 'control server', 'beforeStart', 'infra']); // oxfmt-ignore
    expect(mode).toBe('headless');
    expect(t.lines()).toContain('[session ] removed apps/legacy');
  });

  test("the session's beforeStart and its infra startup share one `data`", async () => {
    let written: unknown;
    let read: unknown;
    const t = setup({
      services: { api: {} },
      seams: {
        runSessionHook: async (_hook, _mode, _write, data) => {
          data.cleaned = true;
          written = data;
          return 'done';
        },
        runInfra: async (_onEvent, data) => {
          read = data;
          return undefined;
        },
      },
    });
    await t.session.start();
    expect(read).toBe(written);
    expect(read).toEqual({ cleaned: true });
  });

  test("the session's beforeStart and its services' start hooks share one `data`; a service's hook logs under its label", async () => {
    let written: unknown;
    let seen: unknown;
    const t = setup({
      services: {
        api: {
          lifecycle: {
            beforeStart: (ctx: { data: Record<string, unknown>; log: (m: string) => void }) => {
              seen = ctx.data;
              ctx.log('seeding the database');
            },
          },
        },
      },
      seams: {
        runSessionHook: async (_hook, _mode, _write, data) => {
          data.cleaned = true;
          written = data;
          return 'done';
        },
      },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    expect(seen).toBe(written);
    expect(t.lines()).toContain('[api     ] seeding the database');
  });

  test("a service's hooks get the environment its dev process gets, PORT and its dev script's variables included", async () => {
    let envs: Record<string, string | undefined> | undefined;
    const t = setup({
      services: {
        api: {
          port: 21_091,
          lifecycle: {
            beforeStart: (ctx: { envs: Record<string, string | undefined> }) => {
              envs = ctx.envs;
            },
          },
        },
      },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    const spawned = t.procs[0]!.opts.env;
    expect(envs!.PORT).toBe('21091');
    expect(envs!.npm_lifecycle_event).toBe('dev');
    expect(envs!.INIT_CWD).toBe(spawned.INIT_CWD);
    expect(envs!.PATH).toBe(spawned.PATH);
  });

  test('isReachable is true while its beforeStop runs, and false once its process is signalled', async () => {
    const hook = deferred<void>();
    const t = setup({
      services: { api: { lifecycle: { beforeStop: () => hook.promise } } },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    await until(() => expect(t.session.isReachable('api')).toBe(true));
    const proc = t.procs[0]!;
    const stopping = t.session.runPackage('api', 'stop', BY);
    await until(() => expect(t.session.getStatus('api')).toBe('stopped'));
    // The hook runs: the process is up, and the proxy may still reach it.
    expect(proc.state).toBe('running');
    expect(t.session.isReachable('api')).toBe(true);
    expect(t.session.getAllReadiness()).toEqual({ api: false });
    hook.resolve();
    expect(await stopping).toBe('done');
    expect(proc.state).toBe('exited');
    expect(t.session.isReachable('api')).toBe(false);
  });

  test('a stop is accepted while a restart runs its beforeStop: it wins, and nothing starts', async () => {
    const hook = deferred<void>();
    const t = setup({
      services: { api: { lifecycle: { beforeStop: () => hook.promise } } },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    expect(await t.session.runPackage('api', 'restart', BY)).toBe('accepted');
    expect(t.session.getStatus('api')).toBe('restarting');
    // A start while it restarts is still refused; a stop is not.
    expect(await t.session.runPackage('api', 'start', BY)).toBe('busy');
    const stopping = t.session.runPackage('api', 'stop', BY);
    await until(() => expect(t.session.getStatus('api')).toBe('stopped'));
    hook.resolve();
    expect(await stopping).toBe('done');
    await settle();
    expect(t.procs).toHaveLength(1);
    expect(t.session.getStatus('api')).toBe('stopped');
  });

  test("a service is reachable while its afterReady runs, not ready; once it throws, it is failed with the hook's message", async () => {
    const hook = deferred<void>();
    const t = setup({
      services: {
        api: {
          lifecycle: {
            afterReady: async () => {
              await hook.promise;
              throw new Error('boom');
            },
          },
        },
      },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    await until(() => expect(t.session.isReachable('api')).toBe(true));
    expect(t.session.getAllReadiness()).toEqual({ api: false });
    expect(t.session.getStatus('api')).toBe('running');
    expect(t.session.serviceErrors()).toEqual({});
    hook.resolve();
    await until(() => expect(t.session.getStatus('api')).toBe('failed'));
    expect(t.session.isReachable('api')).toBe(true);
    expect(t.session.getAllReadiness()).toEqual({ api: false });
    expect(t.session.serviceErrors()).toEqual({ api: 'afterReady failed: boom' });
  });

  test('a beforeStart that throws fails the start: no infra, no services', async () => {
    const t = setup({
      services: { api: {} },
      seams: {
        runSessionHook: async () => ({ error: 'apps/legacy is not empty' }),
      },
    });
    await t.session.start();
    expect(t.order).toEqual(['takeover', 'proxy', 'control server']);
    expect(t.session.getSnapshot().failure).toEqual({
      message: 'session beforeStart failed: apps/legacy is not empty',
    });
    // Under the session's own label, like its other hooks, and as the start's error.
    expect(t.lines()).toContain('[session ] beforeStart failed: apps/legacy is not empty');
    expect(t.lines()).toContain('[stackctl] [ERROR] session beforeStart failed: apps/legacy is not empty'); // oxfmt-ignore
    await t.session.shutdown('startup-failed');
    expect(await t.session.closed).toBe(1);
    expect(t.procs).toHaveLength(0);
    // The reason outlives the session: its last line in the event log has it.
    const end = fs.readFileSync(sessionEventsPath(t.root, 'development', '1'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).at(-1); // oxfmt-ignore
    expect(end).toMatchObject({ type: 'session-end', cause: 'error', error: 'session beforeStart failed: apps/legacy is not empty' }); // oxfmt-ignore
  });

  test("afterStart runs once the infra is ready and the services are launched, with the start's data", async () => {
    const datas: unknown[] = [];
    let atCall: { docs: string | undefined; ready: Record<string, boolean> } | undefined;
    const t = setup({
      // `docs` turns `stopped` the moment the services are launched: before, it is `pending`.
      services: { api: {}, docs: { autostart: false } },
      session: { lifecycle: { afterStart: () => {} } },
      seams: {
        runSessionHook: async (hook, _mode, _write, data) => {
          t.order.push(hook);
          datas.push(data);
          const docs = t.session.getSnapshot().services.find((s) => s.name === 'docs')?.state;
          atCall = { docs, ready: t.session.getAllReadiness() };
          return 'done';
        },
        runInfra: async (_onEvent, data) => {
          t.order.push('infra');
          datas.push(data);
          return undefined;
        },
      },
    });
    await t.session.start();
    expect(t.order).toEqual(['takeover', 'proxy', 'control server', 'beforeStart', 'infra', 'markInfraReady', 'afterStart']); // oxfmt-ignore
    // Launched, not waited for.
    expect(atCall).toEqual({ docs: 'stopped', ready: { api: false, docs: false } });
    await until(() => expect(t.procs).toHaveLength(1));
    expect(datas).toHaveLength(3);
    expect(datas[2]).toBe(datas[0]);
    expect(datas[1]).toBe(datas[0]);
  });

  test('afterReady runs once, when the session first becomes ready, and the session reports ready only when it has finished', async () => {
    const hook = deferred<void>();
    const calls: string[] = [];
    let readyAtCall: Record<string, boolean> | undefined;
    const t = setup({
      services: { api: {}, web: {} },
      session: { lifecycle: { afterReady: () => {} } },
      seams: {
        runSessionHook: async (name) => {
          calls.push(name);
          if (name === 'afterReady') {
            readyAtCall = t.session.getAllReadiness();
            await hook.promise;
          }
          return 'done';
        },
      },
    });
    await t.session.start();
    await until(() => expect(calls).toContain('afterReady'));
    expect(readyAtCall).toEqual({ api: true, web: true });
    expect(t.session.sessionStartHooks()).toBe('afterReady');
    hook.resolve();
    await until(() => expect(t.session.sessionStartHooks()).toBe('done'));
    // A restart makes the session ready again, but the hook ran for the session's start only.
    expect(await t.session.runPackage('api', 'restart', BY)).toBe('accepted');
    await until(() => expect(t.procs).toHaveLength(3));
    await until(() => expect(t.session.getAllReadiness()).toEqual({ api: true, web: true }));
    expect(calls.filter((name) => name === 'afterReady')).toHaveLength(1);
    expect(t.session.sessionStartHooks()).toBe('done');
  });

  test('afterReady waits for afterStart to finish, even once every service is ready', async () => {
    const afterStart = deferred<void>();
    const calls: string[] = [];
    const t = setup({
      services: { api: {} },
      session: { lifecycle: { afterStart: () => {}, afterReady: () => {} } },
      seams: {
        runSessionHook: async (name) => {
          calls.push(name);
          if (name === 'afterStart') {
            await afterStart.promise;
          }
          return 'done';
        },
      },
    });
    void t.session.start();
    await until(() => expect(t.session.getAllReadiness()).toEqual({ api: true }));
    await until(() => expect(calls).toEqual(['beforeStart', 'afterStart']));
    expect(t.session.sessionStartHooks()).toBe('afterStart');
    afterStart.resolve();
    await until(() => expect(calls).toEqual(['beforeStart', 'afterStart', 'afterReady']));
    await until(() => expect(t.session.sessionStartHooks()).toBe('done'));
  });

  test.each(['afterStart', 'afterReady'] as const)(
    'a throw in afterStart or afterReady fails the start: %s',
    async (hook) => {
      const t = setup({
        services: { api: {} },
        session: { lifecycle: { [hook]: () => {} } },
        seams: {
          runSessionHook: async (name) => (name === hook ? { error: 'boom' } : 'done'),
        },
      });
      await t.session.start();
      await until(() => expect(t.session.getSnapshot().phase).toBe('failed'));
      const message = `session ${hook} failed: boom`;
      expect(t.session.getSnapshot().failure).toEqual({ message });
      expect(t.lines()).toContain(`[stackctl] [ERROR] ${message}`);
      expect(t.lines()).toContain(`[session ] ${hook} failed: boom`);
      expect(t.session.sessionError()).toBe(message);
      expect(t.session.sessionStartHooks()).toBe('failed');
      // What runs keeps running, until the session is quit.
      await until(() => expect(t.procs.map((p) => p.state)).toEqual(['running']));
    },
  );

  test.each(['afterStart', 'afterReady'] as const)(
    'a headless session whose %s throws shuts everything down and exits 1',
    async (hook) => {
      const t = setup({
        services: { api: {} },
        session: { lifecycle: { [hook]: () => {} } },
        seams: {
          runSessionHook: async (name) => {
            if (name !== hook) {
              return 'done';
            }
            // Once its service runs, so the shutdown has something to stop.
            await until(() => expect(t.procs.map((p) => p.state)).toEqual(['running']));
            return { error: 'boom' };
          },
        },
      });
      const out = { write: (_chunk: string, done?: () => void) => (done?.(), true) };
      let exitCode: number | undefined;
      await runHeadless(t.session, { echo: false, stdout: out, stderr: out, exit: (code) => (exitCode = code) }); // oxfmt-ignore
      expect(exitCode).toBe(1);
      expect(await t.session.closed).toBe(1);
      expect(t.lines()).toContain(`[stackctl] [ERROR] session ${hook} failed: boom`);
      expect(t.procs.map((p) => p.state)).toEqual(['exited']);
    },
  );

  test("a session with no start hook reports them as none from the start, whatever the terminal UI's memory reader does", async () => {
    const t = setup({
      services: { api: {} },
      interactive: true,
      // The terminal UI's memory reader, never loaded.
      seams: { usageReader: () => new Promise<never>(() => {}) },
    });
    expect(t.session.sessionStartHooks()).toBe('none');
    void t.session.start();
    await until(() => expect(t.session.getAllReadiness()).toEqual({ api: true }));
    expect(t.session.sessionStartHooks()).toBe('none');
  });

  test("the session's afterReady doesn't wait for the terminal UI's memory reader", async () => {
    const t = setup({
      services: { api: {} },
      interactive: true,
      session: { lifecycle: { afterStart: () => {}, afterReady: () => {} } },
      seams: {
        usageReader: () => new Promise<never>(() => {}),
        runSessionHook: async () => 'done',
      },
    });
    void t.session.start();
    await until(() => expect(t.session.sessionStartHooks()).toBe('done'));
  });

  test('a shutdown before the session is first ready means its afterReady never runs', async () => {
    const calls: string[] = [];
    const t = setup({
      services: { api: { healthcheck: 'http://127.0.0.1:1/health' } },
      session: { lifecycle: { afterReady: () => {} } },
      seams: {
        probe: () => Promise.resolve(false),
        runSessionHook: async (name) => (calls.push(name), 'done'),
      },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    await t.session.shutdown('quit');
    expect(await t.session.closed).toBe(0);
    expect(calls).not.toContain('afterReady');
  });

  test.each(['afterStart', 'afterReady'] as const)(
    "a shutdown isn't held by a %s still running, and its late failure changes nothing",
    async (hook) => {
      const held = deferred<void>();
      const calls: string[] = [];
      const t = setup({
        services: { api: {} },
        session: { lifecycle: { [hook]: () => {} } },
        seams: {
          runSessionHook: async (name) => {
            calls.push(name);
            if (name !== hook) {
              return 'done';
            }
            await held.promise;
            return { error: 'boom' };
          },
        },
      });
      void t.session.start();
      // The hook is running when the shutdown begins.
      await until(() => expect(calls).toContain(hook));
      await until(() => expect(t.procs.map((p) => p.state)).toEqual(['running']));
      // Settled with the hook still running: nothing waits for it.
      await t.session.shutdown('quit');
      expect(await t.session.closed).toBe(0);
      held.resolve();
      await settle();
      expect(t.session.getSnapshot().failure).toBeUndefined();
      expect(t.session.sessionError()).toBeNull();
      expect(t.session.sessionStartHooks()).toBe(hook);
      expect(t.lines().join('\n')).not.toContain('failed: boom');
    },
  );

  test.each([
    [{ interactive: true }, 'ui'],
    [{ forked: true, detached: true }, 'detached'],
    [{ forked: true }, 'headless'],
  ] as const)('a session %o runs its beforeStart as %s', async (kind, expected) => {
    let mode: string | undefined;
    const t = setup({ services: { api: {} }, ...kind, seams: { runSessionHook: async (_hook, m) => ((mode = m), 'done') } }); // oxfmt-ignore
    await t.session.start();
    expect(mode).toBe(expected);
  });

  test('a proxy port held elsewhere fails startup and starts nothing after it', async () => {
    const message =
      'dev reverse proxy port 21050 is already in use by another program. Free it, or change `reverseProxy.port` in stackctl.config.ts.'; // oxfmt-ignore
    const t = setup({
      services: { api: {} },
      seams: {
        startProxy: () => {
          t.order.push('proxy');
          return Promise.reject(new Error(message));
        },
      },
    });
    await t.session.start();
    expect(t.order).toEqual(['takeover', 'proxy']);
    const snapshot = t.session.getSnapshot();
    expect(snapshot.phase).toBe('failed');
    expect(snapshot.failure).toEqual({ message });
    const failure = t.session.logs.getVisibleLines().at(-1)!;
    expect(failure.isError).toBe(true);
    expect(`${labelGutter(failure.label, t.session.logs.labelWidth)} ${stripAnsi(failure.text)}`).toBe(`[stackctl] [ERROR] ${message}`); // oxfmt-ignore
    // Quitting after a failed startup exits 1.
    await t.session.shutdown('startup-failed');
    expect(await t.session.closed).toBe(1);
    expect(t.procs).toHaveLength(0);
  });

  test('infra never healthy fails startup', async () => {
    const t = setup({
      services: { api: {} },
      seams: {
        runInfra: (onEvent) => {
          t.order.push('infra');
          const events: InfraEvent[] = [
            { type: 'targets', provider: 'docker-compose', action: 'up', services: ['db'] },
            { type: 'output', service: 'db', line: 'role "app" does not exist', isError: true },
            { type: 'status', service: 'db', status: 'failed', detail: 'not healthy after 300s' },
          ];
          events.forEach(onEvent);
          const summary = { ok: false, services: [{ service: 'db', ok: false, error: 'not healthy after 300s' }] }; // oxfmt-ignore
          return Promise.reject(
            new InfraFailedError(summary, [{ service: 'db', text: 'role "app" does not exist', isError: true }]), // oxfmt-ignore
          );
        },
      },
    });
    await t.session.start();
    const snapshot = t.session.getSnapshot();
    expect(snapshot.phase).toBe('failed');
    expect(snapshot.failure?.message).toBe(
      'db: not healthy after 300s\n    role "app" does not exist',
    );
    expect(snapshot.infra[0]).toMatchObject({ name: 'db', state: 'failed' });
    expect(t.lines().slice(-3)).toEqual([
      '[infra:db] role "app" does not exist',
      '[stackctl] [ERROR] db: not healthy after 300s',
      '[stackctl]       role "app" does not exist',
    ]);
    expect(t.progress.at(-1)).toMatchObject({ type: 'finished', summary: { ok: false } });
    expect(t.order).not.toContain('markInfraReady');
    expect(t.server.attached).toBeNull();
    expect(t.procs).toHaveLength(0);
    // Quitting the failed session closes what came up before the failure.
    await t.session.shutdown('startup-failed');
    expect(await t.session.closed).toBe(1);
    expect(t.proxy.closed).toBe(true);
    expect(t.server.closed).toBe(true);
  });

  test('a control server that fails to listen fails startup, and the proxy is closed', async () => {
    const t = setup({
      services: { api: {} },
      seams: { startControlServer: () => Promise.reject(new Error('listen EADDRINUSE: 127.0.0.1:4321')) }, // oxfmt-ignore
    });
    await t.session.start();
    expect(t.session.getSnapshot().failure).toEqual({ message: 'listen EADDRINUSE: 127.0.0.1:4321' }); // oxfmt-ignore
    expect(t.proxy.closed).toBe(false);
    await t.session.shutdown('startup-failed');
    expect(await t.session.closed).toBe(1);
    expect(t.proxy.closed).toBe(true);
    expect(t.order).not.toContain('infra');
  });
});

describe('the control port', () => {
  test('a random port lost before the bind: the record and the proxy follow the bound one', async () => {
    let nextPort: ((tried: number[]) => number) | undefined;
    let restartPort: (() => number) | undefined;
    const t = setup({
      services: { api: {} },
      seams: {
        acquire: () => Promise.resolve(4321),
        randomPort: (exclude = []) => (exclude.includes(14055) ? 14056 : 14055),
        startProxy: (controlPort) => {
          restartPort = controlPort;
          return Promise.resolve(null);
        },
        startControlServer: (o) => {
          nextPort = o.nextPort;
          t.server.port = 14055;
          return Promise.resolve(t.server);
        },
      },
    });
    writeRunning(t.root, { port: 4321, pid: process.pid });
    await t.session.start();
    expect(nextPort?.([4321])).toBe(14055);
    expect(nextPort?.([4321, 14055])).toBe(14056);
    expect(readRunning(t.root)?.port).toBe(14055);
    expect(restartPort?.()).toBe(14055);
  });

  test('a pinned `apiPort` is never traded: no `nextPort`', async () => {
    let asked: { port: number; nextPort?: unknown } | undefined;
    const t = setup({
      services: { api: {} },
      apiPort: 4321,
      seams: {
        startControlServer: (o) => {
          asked = o;
          return Promise.resolve(t.server);
        },
      },
    });
    await t.session.start();
    expect(asked?.port).toBe(4321);
    expect(asked?.nextPort).toBeUndefined();
  });
});

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Whether `promise` has settled within 100 ms, time for a shutdown with nothing to stop. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 100));
  return settled;
}

describe('a shutdown during a startup step waits for it, then closes what it produced', () => {
  test('during the takeover', async () => {
    const port = deferred<number>();
    const t = setup({
      services: { api: {} },
      seams: {
        acquire: () => {
          t.order.push('takeover');
          return port.promise;
        },
      },
    });
    void t.session.start();
    await until(() => expect(t.order).toEqual(['takeover']));
    void t.session.shutdown('signal');
    expect(await hasSettled(t.session.closed)).toBe(false);
    port.resolve(4321);
    expect(await t.session.closed).toBe(0);
    expect(t.order).toEqual(['takeover']);
  });

  test('during the proxy start', async () => {
    const proxy = deferred<void>();
    const t = setup({
      services: { api: {} },
      seams: {
        startProxy: async () => {
          t.order.push('proxy');
          await proxy.promise;
          return t.proxy;
        },
      },
    });
    void t.session.start();
    await until(() => expect(t.order).toContain('proxy'));
    void t.session.shutdown('signal');
    expect(await hasSettled(t.session.closed)).toBe(false);
    proxy.resolve();
    expect(await t.session.closed).toBe(0);
    expect(t.proxy.closed).toBe(true);
    expect(t.order).not.toContain('control server');
  });

  test('during the control server start', async () => {
    const listening = deferred<void>();
    const t = setup({
      services: { api: {} },
      seams: {
        startControlServer: async () => {
          t.order.push('control server');
          await listening.promise;
          return t.server;
        },
      },
    });
    void t.session.start();
    await until(() => expect(t.order).toContain('control server'));
    void t.session.shutdown('signal');
    expect(await hasSettled(t.session.closed)).toBe(false);
    listening.resolve();
    expect(await t.session.closed).toBe(0);
    expect(t.server.closed).toBe(true);
    expect(t.proxy.closed).toBe(true);
    expect(t.order).not.toContain('infra');
  });
});

describe('signals (ruling S2-R28)', () => {
  test('a signal during the takeover runs the one shutdown path, after the takeover settles', async () => {
    let onSignal: (() => void) | undefined;
    let released = 0;
    let finish!: (port: number) => void;
    const t = setup({
      services: { api: {} },
      seams: {
        installSignals: (fn) => {
          onSignal = fn;
          return () => released++;
        },
        acquire: () => new Promise((resolve) => (finish = resolve)),
      },
    });
    void t.session.start();
    await until(() => expect(onSignal).toBeDefined());
    onSignal!();
    expect(t.session.getSnapshot().phase).toBe('stopping');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.closedCode()).toBeNull();
    finish(4321);
    expect(await t.session.closed).toBe(0);
    expect(t.order).toEqual([]);
    expect(t.procs).toHaveLength(0);
    expect(released).toBe(1);
  });

  test('the signals are installed before anything starts', async () => {
    const order: string[] = [];
    const t = setup({
      services: { api: {} },
      seams: {
        installSignals: () => {
          order.push('signals');
          return () => {};
        },
        acquire: () => {
          order.push('takeover');
          return Promise.resolve(4321);
        },
      },
    });
    await t.session.start();
    expect(order).toEqual(['signals', 'takeover']);
  });
});

describe('shutdown', () => {
  test('shutdown during startup stops what started', async () => {
    const t = setup({
      services: { api: {} },
      // Infra that never finishes coming up.
      seams: {
        runInfra: () => {
          t.order.push('infra');
          return new Promise(() => {});
        },
      },
    });
    void t.session.start();
    await until(() => expect(t.server.quitHandler).not.toBeNull());
    await until(() => expect(t.order).toContain('infra'));
    // `/command/quit` runs the one shutdown path, without waiting for infra.
    t.server.quitHandler!({
      kind: 'control-api',
      request: 'POST /command/quit',
      userAgent: 'curl/8.7.1',
    });
    expect(await t.session.closed).toBe(0);
    expect(t.session.getSnapshot().phase).toBe('stopping');
    expect(t.server.acks).toBe(1);
    expect(t.server.closed).toBe(true);
    expect(t.proxy.closed).toBe(true);
    expect(t.procs).toHaveLength(0);
    expect(t.session.getSnapshot().services.map((s) => s.state)).toEqual(['stopped']);
    // Nothing to wait on: no shutdown line.
    expect(t.lines()).not.toContain('[stackctl] [WARN] shutting down...');
  });

  test('an infra action still running is sent SIGTERM by process group, and waited on', async () => {
    const action = [process.execPath, '-e', "console.log('action ' + process.pid); setInterval(() => {}, 1e9)", '--']; // oxfmt-ignore
    const t = setup({
      services: { api: {} },
      seams: {
        runInfra: () => Promise.resolve({ services: [{ provider: 'docker-compose', name: 'db' }] }),
        infraCli: action,
        // Recorded, and sent: the action has to end for the shutdown to finish waiting.
        signalGroup: (pid, signal) => {
          t.signalled.push([pid, signal]);
          try {
            process.kill(-pid, signal);
          } catch {
            /* gone */
          }
        },
      },
    });
    await t.session.start();
    expect(t.session.runInfra('db', 'restart', BY)).toBe('accepted');
    let pid = 0;
    await until(() => {
      pid = Number(/action (\d+)/.exec(t.lines().join('\n'))?.[1] ?? 0);
      expect(pid).toBeGreaterThan(0);
    });
    await t.session.shutdown('user');
    expect(t.signalled).toContainEqual([pid, 'SIGTERM']);
    expect(() => process.kill(pid, 0)).toThrow('ESRCH');
    expect(t.lines()).toContain('[stackctl] [WARN] shutting down...');
    // A shutdown logs no end line for what it waited on.
    expect(t.lines().filter((line) => line.includes('exited with code'))).toEqual([]);
  });

  test('writes what acts on it to the event log: its start, each command and who asked, the quit, its end', async () => {
    const t = setup({ services: { api: {}, web: {} } });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(2));
    expect(await t.session.runPackage('api', 'stop', BY)).toBe('done');
    const curl = { kind: 'control-api', request: 'POST /command/quit', userAgent: 'curl/8.7.1' } as const; // oxfmt-ignore
    t.server.quitHandler!(curl);
    expect(await t.session.closed).toBe(0);
    const lines = fs
      .readFileSync(sessionEventsPath(t.root, 'development', '1'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((l) => [l.type, l.phase ?? null])).toEqual([
      ['session-start', null],
      ['service-command', 'begin'],
      ['service-command', 'end'],
      ['session-command', 'begin'],
      ['session-command', 'end'],
      ['session-end', null],
    ]);
    expect(lines[0]).toMatchObject({ services: ['api', 'web'], headless: true, replaced: null, sessionId: 'session-test' }); // oxfmt-ignore
    expect(lines[2]).toMatchObject({ action: 'stop', service: 'api', by: BY, ok: true, outcome: 'done' }); // oxfmt-ignore
    expect(lines[3]).toMatchObject({ action: 'quit', by: curl });
    expect(lines[5]).toMatchObject({ cause: 'quit' });
    expect(lines[5]).not.toHaveProperty('error');
    // written before the server closed, and flushed to its streams
    expect(t.server.flushes).toBeGreaterThan(0);
  });

  test('writes a service whose process exits on its own, with how', async () => {
    const t = setup({ services: { api: {} } });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    t.procs[0]!.crash(3);
    await until(() => expect(fs.readFileSync(sessionEventsPath(t.root, 'development', '1'), 'utf8')).toContain('service-exit')); // oxfmt-ignore
    const exit = fs.readFileSync(sessionEventsPath(t.root, 'development', '1'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.type === 'service-exit'); // oxfmt-ignore
    expect(exit).toMatchObject({ type: 'service-exit', service: 'api', exitCode: 3, signal: null });
  });

  test("writes a `.env` change, but not what a service's own beforeStart wrote", async () => {
    const t = setup({ services: { api: {} } });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    const supervisor = (t.session as unknown as { supervisor: Supervisor }).supervisor;
    supervisor.emit('env-change', 'packages/api', [], true);
    supervisor.emit('env-change', 'packages/api', ['api'], false);
    const changes = fs.readFileSync(sessionEventsPath(t.root, 'development', '1'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.type === 'env-change'); // oxfmt-ignore
    expect(changes).toMatchObject([{ dir: 'packages/api', services: ['api'] }]);
  });

  test('a shutdown stops every process, then SIGKILLs the groups they led', async () => {
    const t = setup({ services: { api: {}, web: {} } });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(2));
    const pids = t.procs.map((p) => p.pid);
    await t.session.shutdown('signal');
    expect(await t.session.closed).toBe(0);
    expect(t.procs.map((p) => p.state)).toEqual(['exited', 'exited']);
    expect(t.signalled).toEqual(pids.map((pid) => [pid, 'SIGKILL']));
    expect(t.lines()).toContain('[stackctl] [WARN] shutting down...');
    expect(t.lines().filter((l) => l.includes('stopped') || l.includes('exited'))).toEqual([]);
  });

  test('shutdown twice escalates to kill', async () => {
    const t = setup({ services: { api: {}, web: {} }, holdStops: ['api'] });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(2));
    const [api, web] = t.procs as [StubProcess, StubProcess];
    const first = t.session.shutdown('signal');
    await until(() => expect(api.state).toBe('stopping'));
    // web's leader is gone, but members of its group may not be.
    expect(web.state).toBe('exited');
    expect(api.kills).toBe(0);
    expect(t.signalled).toEqual([]);
    void t.session.shutdown('signal');
    expect(api.kills).toBe(1);
    expect(t.lines()).toContain('[stackctl] [WARN] asked to quit again: killing every process now'); // oxfmt-ignore
    expect(t.signalled).toEqual(
      expect.arrayContaining([
        [api.pid, 'SIGKILL'],
        [web.pid, 'SIGKILL'],
      ]),
    );
    expect(await t.session.closed).toBe(1);
    await first;
  });

  test('a call once the shutdown is done does nothing', async () => {
    const t = setup({ services: { api: {} } });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    await t.session.shutdown('signal');
    expect(await t.session.closed).toBe(0);
    const sent = t.signalled.length;
    await t.session.shutdown('signal');
    expect(t.signalled).toHaveLength(sent);
    expect(t.procs[0]!.kills).toBe(0);
  });

  test("a shutdown during the session's beforeStart doesn't wait for it, and drops what it prints after", async () => {
    let write!: (line: string, isError: boolean) => void;
    const t = setup({
      services: { api: {} },
      // A hook that never finishes: its own commands end with the process.
      seams: {
        runSessionHook: (_hook, _mode, w) => {
          write = w;
          t.order.push('beforeStart');
          return new Promise(() => {});
        },
      },
    });
    void t.session.start();
    await until(() => expect(t.order).toContain('beforeStart'));
    write('pruning', false);
    void t.session.shutdown('signal');
    expect(await t.session.closed).toBe(0);
    write('pruned', false);
    expect(t.lines()).toContain('[session ] pruning');
    expect(t.lines()).not.toContain('[session ] pruned');
    expect(t.order).not.toContain('infra');
  });

  test('infra that comes up after a shutdown reports nothing more', async () => {
    const infra = deferred<SessionInfra>();
    const t = setup({ services: { api: {} }, seams: { runInfra: () => infra.promise } });
    void t.session.start();
    await until(() => expect(t.server.quitHandler).not.toBeNull());
    await t.session.shutdown('signal');
    infra.resolve({ services: [{ provider: 'docker-compose', name: 'db' }] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.progress).toEqual([]);
    expect(t.procs).toHaveLength(0);
  });
});

describe("the shutdown's stop hooks", () => {
  type StopCtx = { trigger: string; data: Record<string, unknown> };
  type ExecCtx = { exec: (command: string, args?: string[]) => Promise<unknown> };

  /** Records `stop <name>` in `events` when `proc` is signalled. */
  function recordStop(proc: StubProcess, events: string[]): void {
    const stop = proc.stop.bind(proc);
    proc.stop = () => {
      events.push(`stop ${proc.opts.name}`);
      return stop();
    };
  }

  /** A service's `beforeStop` and `afterStop` that record `<name>:<hook>:<trigger>` and `data`. */
  function recording(name: string, events: string[], datas: unknown[]) {
    const hook = (which: string) => (ctx: StopCtx) => {
      events.push(`${name}:${which}:${ctx.trigger}`);
      datas.push(ctx.data);
    };
    return { lifecycle: { beforeStop: hook('beforeStop'), afterStop: hook('afterStop') } };
  }

  /** The session's stop hooks, declared: a `runSessionHook` seam runs them in their place. */
  const SESSION_STOP_HOOKS = { lifecycle: { beforeStop: () => {}, afterStop: () => {} } };

  /** A long-running command a hook runs, through the real `exec`. */
  const forever: [string, string[]] = [process.execPath, ['-e', 'setInterval(() => {}, 1e9)']];

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a shutdown runs the session's beforeStop, the services' beforeStop, the stop, the services' afterStop, the session's afterStop", async () => {
    const events: string[] = [];
    const datas: unknown[] = [];
    const t = setup({
      session: SESSION_STOP_HOOKS,
      services: { api: recording('api', events, datas), web: recording('web', events, datas) },
      seams: {
        runSessionHook: async (hook, _mode, _write, data) => {
          if (hook !== 'beforeStart') {
            events.push(`session:${hook}`);
            datas.push(data);
          }
          return 'done';
        },
      },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(2));
    t.procs.forEach((proc) => recordStop(proc, events));
    await t.session.shutdown('signal');
    expect(await t.session.closed).toBe(0);
    expect(events).toEqual([
      'session:beforeStop',
      'api:beforeStop:quit',
      'web:beforeStop:quit',
      'stop api',
      'stop web',
      'api:afterStop:quit',
      'web:afterStop:quit',
      'session:afterStop',
    ]);
    expect(datas).toHaveLength(6);
    expect(new Set(datas).size).toBe(1);
  });

  describe("the session's stop hooks run only once its beforeStart step was passed", () => {
    /** A runSessionHook seam recording each hook it is asked for; beforeStart answers `start`. */
    function sessionHooks(start: () => Promise<'done' | { error: string }>) {
      const asked: string[] = [];
      const runSessionHook: SessionSeams['runSessionHook'] = (hook) => {
        asked.push(hook);
        return hook === 'beforeStart' ? start() : Promise.resolve('done');
      };
      return { asked, runSessionHook };
    }

    test('a shutdown during the takeover', async () => {
      const port = deferred<number>();
      const s = sessionHooks(async () => 'done');
      const t = setup({
        services: { api: {} },
        session: SESSION_STOP_HOOKS,
        seams: { acquire: () => port.promise, runSessionHook: s.runSessionHook },
      });
      const starting = t.session.start();
      void t.session.shutdown('signal');
      port.resolve(4321);
      await starting;
      expect(await t.session.closed).toBe(0);
      expect(s.asked).toEqual([]);
    });

    test('a shutdown during beforeStart', async () => {
      const s = sessionHooks(() => new Promise(() => {}));
      const t = setup({
        services: { api: {} },
        session: SESSION_STOP_HOOKS,
        seams: { runSessionHook: s.runSessionHook },
      });
      void t.session.start();
      await until(() => expect(s.asked).toEqual(['beforeStart']));
      await t.session.shutdown('signal');
      expect(await t.session.closed).toBe(0);
      expect(s.asked).toEqual(['beforeStart']);
    });

    test('a shutdown after beforeStart threw', async () => {
      const s = sessionHooks(async () => ({ error: 'apps/legacy is not empty' }));
      const t = setup({
        services: { api: {} },
        session: SESSION_STOP_HOOKS,
        seams: { runSessionHook: s.runSessionHook },
      });
      await t.session.start();
      expect(t.session.getSnapshot().phase).toBe('failed');
      await t.session.shutdown('startup-failed');
      expect(await t.session.closed).toBe(1);
      expect(s.asked).toEqual(['beforeStart']);
    });

    test('a shutdown after beforeStart finished runs both', async () => {
      const s = sessionHooks(async () => 'done');
      const t = setup({
        services: { api: {} },
        session: SESSION_STOP_HOOKS,
        seams: { runSessionHook: s.runSessionHook },
      });
      await t.session.start();
      await t.session.shutdown('signal');
      expect(s.asked).toEqual(['beforeStart', 'beforeStop', 'afterStop']);
    });
  });

  test("a session with no stop hook of its own is asked for none, though its services' stop hooks run", async () => {
    const asked: string[] = [];
    const ran: string[] = [];
    const t = setup({
      services: {
        api: {
          lifecycle: {
            beforeStop: () => void ran.push('api beforeStop'),
            afterStop: () => void ran.push('api afterStop'),
          },
        },
      },
      seams: {
        runSessionHook: async (hook) => {
          asked.push(hook);
          return 'none';
        },
      },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    await t.session.shutdown('signal');
    expect(await t.session.closed).toBe(0);
    expect(ran).toEqual(['api beforeStop', 'api afterStop']);
    expect(asked).toEqual(['beforeStart']);
  });

  test('a beforeStop still running after 5 s is abandoned and the services still get their full grace', async () => {
    const t = setup({
      services: { api: { lifecycle: { beforeStop: () => new Promise<void>(() => {}) } } },
      holdStops: ['api'],
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    const proc = t.procs[0]!;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const shutting = t.session.shutdown('signal');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(proc.state).toBe('running');
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.state).toBe('stopping');
    expect(t.lines()).toContain('[api     ] beforeStop abandoned: the 5 s for stop hooks ran out');
    // The stop is bounded on its own: the grace and its sweep margin, none of it spent on the hook.
    await vi.advanceTimersByTimeAsync(14_999);
    expect(t.closedCode()).toBeNull();
    // As the grace's SIGKILL would.
    proc.kill();
    await shutting;
    expect(await t.session.closed).toBe(0);
  });

  test("a session's beforeStop that takes the 5 s leaves none to the services': theirs are skipped, with a line", async () => {
    let afterStops = 0;
    const t = setup({
      session: SESSION_STOP_HOOKS,
      services: {
        api: {
          lifecycle: {
            beforeStop: () => {
              throw new Error('never called');
            },
            afterStop: () => void afterStops++,
          },
        },
      },
      seams: {
        // Settles only when its budget ends, as a hung hook does.
        runSessionHook: async (hook, _mode, _write, _data, budget) =>
          hook === 'beforeStop'
            ? runHook(() => new Promise<void>(() => {}), {}, { budget })
            : 'done',
      },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const shutting = t.session.shutdown('signal');
    await vi.advanceTimersByTimeAsync(5_000);
    await shutting;
    expect(t.lines()).toEqual(
      expect.arrayContaining([
        '[session ] beforeStop abandoned: the 5 s for stop hooks ran out',
        '[api     ] beforeStop skipped: the 5 s for stop hooks ran out',
      ]),
    );
    // The after step has its own 5 s.
    expect(afterStops).toBe(1);
  });

  test('a second quit request during a stop hook kills everything at once and skips the hooks left', async () => {
    let command: Promise<unknown> | undefined;
    const asked: string[] = [];
    const t = setup({
      session: SESSION_STOP_HOOKS,
      services: {
        api: {
          lifecycle: {
            beforeStop: (ctx: ExecCtx) => {
              command = ctx.exec(...forever);
              return command.then(() => {});
            },
            afterStop: () => void asked.push('api:afterStop'),
          },
        },
      },
      seams: {
        runSessionHook: async (hook) => {
          asked.push(`session:${hook}`);
          return 'done';
        },
      },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    void t.session.shutdown('signal');
    await until(() => expect(command).toBeDefined());
    void t.session.shutdown('signal');
    expect(await t.session.closed).toBe(1);
    expect(t.session.hardKilled).toBe(true);
    expect(t.procs[0]!.kills).toBe(1);
    // The hook's command is killed with everything else.
    await expect(command).rejects.toThrow('exited with code 1');
    await settle();
    expect(asked).toEqual(['session:beforeStart', 'session:beforeStop']);
    expect(t.lines().filter((line) => line.includes('abandoned'))).toEqual([]);
  });

  test("a second quit during the session's own beforeStop abandons it at once, and nothing after it runs", async () => {
    let budget: AbortSignal | undefined;
    const asked: string[] = [];
    const t = setup({
      session: SESSION_STOP_HOOKS,
      services: { api: recording('api', asked, []) },
      seams: {
        runSessionHook: async (hook, _mode, _write, _data, b) => {
          asked.push(`session:${hook}`);
          if (hook !== 'beforeStop') {
            return 'done';
          }
          budget = b;
          // Hung: it settles only when its budget aborts, as the real runner's hooks do.
          return runHook(() => new Promise<void>(() => {}), {}, { budget: b });
        },
      },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    void t.session.shutdown('signal');
    await until(() => expect(budget).toBeDefined());
    expect(budget!.aborted).toBe(false);
    void t.session.shutdown('signal');
    expect(budget!.aborted).toBe(true);
    expect(await t.session.closed).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(asked).toEqual(['session:beforeStart', 'session:beforeStop']);
    expect(t.lines().filter((line) => /abandoned|skipped/.test(line))).toEqual([]);
  });

  test("services' afterStop that take the 5 s leave none to the session's: it is skipped, with a line", async () => {
    const asked: string[] = [];
    const t = setup({
      session: SESSION_STOP_HOOKS,
      services: { api: { lifecycle: { afterStop: () => new Promise<void>(() => {}) } } },
      seams: {
        runSessionHook: async (hook) => {
          asked.push(hook);
          return 'done';
        },
      },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const shutting = t.session.shutdown('signal');
    await vi.advanceTimersByTimeAsync(5_000);
    await shutting;
    expect(t.lines()).toEqual(
      expect.arrayContaining([
        '[api     ] afterStop abandoned: the 5 s for stop hooks ran out',
        '[session ] afterStop skipped: the 5 s for stop hooks ran out',
      ]),
    );
    expect(asked).toEqual(['beforeStart', 'beforeStop']);
  });

  test("a stop the shutdown overtakes has its beforeStop, begun with no time limit, abandoned at the step's 5 s", async () => {
    let commands = 0;
    const t = setup({
      services: {
        api: {
          lifecycle: {
            beforeStop: () => {
              commands++;
              return new Promise<void>(() => {});
            },
          },
        },
      },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    const proc = t.procs[0]!;
    const stopping = t.session.runPackage('api', 'stop', BY);
    await until(() => expect(commands).toBe(1));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const shutting = t.session.shutdown('signal');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(proc.state).toBe('running');
    await vi.advanceTimersByTimeAsync(1);
    await shutting;
    expect(proc.state).toBe('exited');
    expect(await stopping).toBe('done');
    // Its own hook, once: the shutdown runs no `beforeStop` of its own for it.
    expect(commands).toBe(1);
    expect(t.lines()).toContain('[api     ] beforeStop abandoned: the 5 s for stop hooks ran out');
  });

  test("the session's beforeStart's commands are killed once the shutdown is done", async () => {
    let signal: AbortSignal | undefined;
    const t = setup({
      services: { api: {} },
      seams: {
        runSessionHook: (_hook, _mode, _write, _data, _budget, s) => {
          signal = s;
          return new Promise(() => {});
        },
      },
    });
    void t.session.start();
    await until(() => expect(signal).toBeDefined());
    await t.session.shutdown('signal');
    expect(signal!.aborted).toBe(true);
    expect(await t.session.closed).toBe(0);
  });

  test("the session's beforeStart's commands are killed by a hard kill", async () => {
    const signals: AbortSignal[] = [];
    const t = setup({
      services: { api: {} },
      seams: {
        runSessionHook: (hook, _mode, _write, _data, _budget, signal) => {
          signals.push(signal!);
          return hook === 'beforeStart' ? new Promise(() => {}) : Promise.resolve('done');
        },
      },
    });
    void t.session.start();
    await until(() => expect(signals).toHaveLength(1));
    void t.session.shutdown('signal');
    expect(signals[0]!.aborted).toBe(false);
    void t.session.shutdown('signal');
    expect(signals[0]!.aborted).toBe(true);
    expect(await t.session.closed).toBe(1);
  });

  test("the infra startup's hook commands are asked to end as a shutdown begins, and killed by a hard kill, through the session's own infra step", async () => {
    // Docker as the infra step reads it: one service, `db`, running; any other command (the
    // hook's) runs until its signal aborts.
    const signals: (AbortSignal | undefined)[] = [];
    const asked: (AbortSignal | undefined)[] = [];
    const exec: Exec = (command, args, opts) => {
      if (command !== 'docker') {
        signals.push(opts.signal);
        asked.push(opts.abandon);
        return new Promise((resolve) => {
          opts.signal?.addEventListener('abort', () =>
            resolve({ exitCode: 137, stdout: '', stderr: '' }),
          );
        });
      }
      const sub = args.slice(3).join(' ');
      const stdout =
        sub === 'config --services'
          ? 'db\n'
          : sub.startsWith('ps ')
            ? JSON.stringify({ Service: 'db', State: 'running' })
            : sub === 'config --format json'
              ? '{}'
              : '';
      return Promise.resolve({ exitCode: 0, stdout, stderr: '' });
    };
    const t = setup({
      services: { api: {} },
      infra: {
        'docker-compose': {
          services: {
            db: {
              lifecycle: {
                afterReady: async ({ exec: run }: { exec: (c: string) => Promise<unknown> }) => {
                  await run('migrate');
                },
              },
            },
          },
        },
      },
      seams: { runInfra: undefined, infraDeps: { exec, connectControl: async () => undefined } },
    });
    void t.session.start();
    await until(() => expect(signals).toHaveLength(1));
    expect(asked[0]!.aborted).toBe(false);
    void t.session.shutdown('signal');
    // Asked to end as the shutdown begins; killed only by the second request.
    expect(asked[0]!.aborted).toBe(true);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(false);
    void t.session.shutdown('signal');
    expect(signals[0]!.aborted).toBe(true);
    expect(await t.session.closed).toBe(1);
  });

  test.each(['beforeStart', 'afterStart', 'afterReady'] as const)(
    "a shutdown abandons the session's %s still running, with a line under [session]",
    async (hung) => {
      const budgets = new Map<string, AbortSignal | undefined>();
      const t = setup({
        services: { api: {} },
        session: { lifecycle: { [hung]: async () => {} } },
        seams: {
          runSessionHook: (hook, _mode, _write, _data, budget) => {
            budgets.set(hook, budget);
            return hook === hung ? new Promise(() => {}) : Promise.resolve('done');
          },
        },
      });
      void t.session.start();
      await until(() => expect(budgets.has(hung)).toBe(true));
      expect(budgets.get(hung)!.aborted).toBe(false);
      void t.session.shutdown('signal');
      expect(budgets.get(hung)!.aborted).toBe(true);
      expect(await t.session.closed).toBe(0);
      expect(t.lines()).toContain(`[session ] ${hung} abandoned: the session is quitting`);
    },
  );

  test("the session's beforeStop waits for the commands of the start hook the shutdown abandoned", async () => {
    let ended!: () => void;
    const order: string[] = [];
    const t = setup({
      services: { api: {} },
      session: { lifecycle: { afterStart: async () => {}, beforeStop: async () => {} } },
      seams: {
        runSessionHook: (hook, _mode, _write, _data, _budget, _signal, onCommand) => {
          order.push(hook);
          if (hook !== 'afterStart') {
            return Promise.resolve('done');
          }
          // A command the hook runs, which ends when the test says.
          onCommand?.(new Promise<void>((resolve) => (ended = resolve)));
          return new Promise(() => {});
        },
      },
    });
    void t.session.start();
    await until(() => expect(order).toContain('afterStart'));
    void t.session.shutdown('signal');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).not.toContain('beforeStop');
    ended();
    await until(() => expect(order).toContain('beforeStop'));
    expect(await t.session.closed).toBe(0);
  });

  test('with no stop hooks a shutdown sets no budget timer', async () => {
    const t = setup({ services: { api: {}, web: {} } });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(2));
    // Real timers, spied: a spy over fake ones would be restored to the fake after the test.
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const shutting = t.session.shutdown('signal');
    // Up to its first await the shutdown has been through its `beforeStop` step, where the step's
    // budget timer would have been set: none is, so none can be waited on.
    expect(timers.mock.calls.filter(([, ms]) => ms === STOP_HOOK_BUDGET_MS)).toEqual([]);
    timers.mockRestore();
    await shutting;
    expect(await t.session.closed).toBe(0);
  });

  test('with quick stop hooks a shutdown waits on no timer either: the budget is set, then cleared', async () => {
    const events: string[] = [];
    const t = setup({
      session: SESSION_STOP_HOOKS,
      services: { api: recording('api', events, []) },
      seams: { runSessionHook: async () => 'done' },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const shutting = t.session.shutdown('signal');
    // The step's budget timer is set (the case above sees none), and cleared once its hooks end.
    expect(vi.getTimerCount()).toBe(1);
    await shutting;
    expect(await t.session.closed).toBe(0);
    expect(events).toEqual(['api:beforeStop:quit', 'api:afterStop:quit']);
  });

  test("a stop hook's failure at the shutdown is an error line under its service, and the session's under [session]", async () => {
    const t = setup({
      session: SESSION_STOP_HOOKS,
      services: {
        api: {
          lifecycle: {
            beforeStop: () => {
              throw new Error('webhook gone');
            },
            afterStop: () => Promise.reject(new Error('tidy failed')),
          },
        },
      },
      seams: {
        runSessionHook: async (hook) => (hook === 'afterStop' ? { error: 'no lock' } : 'done'),
      },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    await t.session.shutdown('signal');
    expect(t.lines()).toEqual(
      expect.arrayContaining([
        '[api     ] beforeStop failed: webhook gone',
        '[api     ] afterStop failed: tidy failed',
        '[session ] afterStop failed: no lock',
      ]),
    );
    const errors = t.session.logs.getVisibleLines().filter((l) => l.isError).map((l) => stripAnsi(l.text)); // oxfmt-ignore
    expect(errors).toEqual(['beforeStop failed: webhook gone', 'afterStop failed: tidy failed', 'afterStop failed: no lock']); // oxfmt-ignore
  });

  test('a stop the shutdown overtakes keeps its beforeStop, and the shutdown runs its afterStop once', async () => {
    const gate = deferred<void>();
    const calls: [string, string, unknown][] = [];
    const t = setup({
      services: {
        api: {
          lifecycle: {
            beforeStop: async (ctx: StopCtx) => {
              calls.push(['beforeStop', ctx.trigger, ctx.data]);
              await gate.promise;
            },
            afterStop: (ctx: StopCtx) => void calls.push(['afterStop', ctx.trigger, ctx.data]),
          },
        },
        web: recording('web', [], []),
      },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(2));
    const stopping = t.session.runPackage('api', 'stop', BY);
    await until(() => expect(calls).toHaveLength(1));
    const shutting = t.session.shutdown('signal');
    gate.resolve();
    await shutting;
    expect(await stopping).toBe('done');
    expect(calls.map(([hook, trigger]) => `${hook}:${trigger}`)).toEqual(['beforeStop:stop', 'afterStop:stop']); // oxfmt-ignore
    // One stop: one `data`, its own.
    expect(calls[1]![2]).toBe(calls[0]![2]);
  });

  test("a stop's afterStop already running when the shutdown begins is waited for, not run again", async () => {
    const gate = deferred<void>();
    let afterStops = 0;
    const t = setup({
      services: {
        api: {
          lifecycle: {
            afterStop: async () => {
              afterStops++;
              await gate.promise;
            },
          },
        },
      },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    const stopping = t.session.runPackage('api', 'stop', BY);
    await until(() => expect(afterStops).toBe(1));
    const shutting = t.session.shutdown('signal');
    await settle();
    expect(t.closedCode()).toBeNull();
    gate.resolve();
    await shutting;
    await stopping;
    expect(afterStops).toBe(1);
  });

  test("a hook's command a start hook left running is killed once the shutdown is done", async () => {
    let command: Promise<unknown> | undefined;
    const t = setup({
      services: {
        api: {
          lifecycle: {
            beforeStart: (ctx: ExecCtx) => {
              command = ctx.exec(...forever);
              return command.then(() => {});
            },
          },
        },
      },
    });
    await t.session.start();
    await until(() => expect(command).toBeDefined());
    await t.session.shutdown('signal');
    expect(await t.session.closed).toBe(0);
    await expect(command).rejects.toThrow('exited with code 1');
  });
});

describe('a second stop while a stop hook runs', () => {
  type ExecCtx = { exec: (command: string, args?: string[]) => Promise<unknown> };
  const forever: [string, string[]] = [process.execPath, ['-e', 'setInterval(() => {}, 1e9)']];

  test.each(['stop', 'restart'] as const)(
    "abandons a %s's beforeStop that never settles, killing its command, and signals the process at once",
    async (first) => {
      let command: Promise<unknown> | undefined;
      const t = setup({
        services: {
          api: {
            lifecycle: {
              beforeStop: (ctx: ExecCtx) => {
                command = ctx.exec(...forever);
                return command.then(() => {});
              },
            },
          },
        },
      });
      await t.session.start();
      await until(() => expect(t.procs).toHaveLength(1));
      const proc = t.procs[0]!;
      void t.session.runPackage('api', first, BY);
      await until(() => expect(command).toBeDefined());
      expect(proc.state).toBe('running');
      // The screen's `s` reads stop meanwhile.
      await until(() => expect(t.session.getSnapshot().services[0]!.stopping).toBe(true));
      // And the control API's status names the hook, for `stackctl service stop` to say so.
      expect(t.session.serviceHooks()).toEqual({ api: 'beforeStop' });
      expect(await t.session.runPackage('api', 'stop', BY)).toBe('done');
      expect(t.session.getSnapshot().services[0]!.stopping).toBeUndefined();
      expect(t.session.serviceHooks()).toEqual({});
      expect(proc.state).toBe('exited');
      await expect(command).rejects.toThrow('exited with code 1');
      expect(t.lines()).toContain('[api     ] beforeStop abandoned: the stop was asked for again');
      await settle();
      // Nothing starts after it.
      expect(t.procs).toHaveLength(1);
      expect(t.session.getStatus('api')).toBe('stopped');
    },
  );

  test('abandons an afterStop that never settles', async () => {
    let afterStops = 0;
    const t = setup({
      services: {
        api: {
          lifecycle: {
            afterStop: () => {
              afterStops++;
              return new Promise<void>(() => {});
            },
          },
        },
      },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    const first = t.session.runPackage('api', 'stop', BY);
    await until(() => expect(afterStops).toBe(1));
    expect(await t.session.runPackage('api', 'stop', BY)).toBe('done');
    expect(await first).toBe('done');
    expect(afterStops).toBe(1);
    expect(t.lines()).toContain('[api     ] afterStop abandoned: the stop was asked for again');
  });

  test('a restart a stop cancels is written to the event log as cancelled, not done', async () => {
    const gate = deferred<void>();
    const t = setup({
      services: { api: { lifecycle: { beforeStop: () => gate.promise } } },
    });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    expect(await t.session.runPackage('api', 'restart', BY)).toBe('accepted');
    await until(() => expect(t.session.getStatus('api')).toBe('restarting'));
    expect(await t.session.runPackage('api', 'stop', BY)).toBe('done');
    gate.resolve();
    const restartEnd = () =>
      fs
        .readFileSync(sessionEventsPath(t.root, 'development', '1'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((l) => l.type === 'service-command' && l.action === 'restart' && l.phase === 'end');
    await until(() => expect(restartEnd()).toBeDefined());
    expect(restartEnd()).toMatchObject({ ok: false, outcome: 'cancelled' });
  });
});

describe('snapshot', () => {
  test('snapshot changes notify subscribers once per microtask', async () => {
    const t = setup({ services: { api: {}, web: {} } });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(2));
    await Promise.resolve();
    const before = t.session.getSnapshot();
    expect(t.session.getSnapshot()).toBe(before);
    let calls = 0;
    t.session.subscribe(() => calls++);
    void t.session.runPackage('api', 'stop', BY);
    void t.session.runPackage('web', 'stop', BY);
    expect(calls).toBe(0);
    await Promise.resolve();
    expect(calls).toBe(1);
    const after = t.session.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.services.map((s) => [s.name, s.state, s.exitCode])).toEqual([
      ['api', 'stopped', null],
      ['web', 'stopped', null],
    ]);
  });

  test('the control API sees public statuses and readiness, and outcomes per action', async () => {
    const t = setup({ services: { api: {}, web: {}, extra: {} }, selected: ['api', 'web'] });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(2));
    await until(() => expect(t.session.getAllReadiness()).toEqual({ api: true, web: true }));
    expect(t.session.serviceStatuses()).toEqual({ api: 'running', web: 'running' });
    expect(t.session.getStatus('nope')).toBeNull();
    expect(await t.session.runPackage('nope', 'start', BY)).toBe('unknown');
    expect(await t.session.runPackage('extra', 'stop', BY)).toBe('done');
    expect(await t.session.runPackage('extra', 'restart', BY)).toBe('unknown');
    expect(await t.session.runPackage('api', 'restart', BY)).toBe('accepted');
    expect(await t.session.runPackage('api', 'start', BY)).toBe('busy');
    // A stop always goes through: the latest request wins.
    expect(await t.session.runPackage('api', 'stop', BY)).toBe('done');
    expect(await t.session.runPackage('extra', 'start', BY)).toBe('done');
    expect(t.session.serviceStatuses()).toHaveProperty('extra');
    expect(t.session.runInfra('db', 'restart', BY)).toBe('unknown');
    t.session.logControl('restart', { service: 'web' });
    expect(t.lines().slice(-2)).toEqual(['[control ] [INFO] restart', '[control ]   service: web']); // oxfmt-ignore
  });

  test('a start or restart of a service waiting for its deps is refused as waiting; a stop is not', async () => {
    const t = setup({
      services: {
        api: { healthcheck: 'http://127.0.0.1:1/health' },
        web: { deps: [{ service: 'api', wait: true }] },
      },
      seams: { probe: () => Promise.resolve(false) },
    });
    await t.session.start();
    await until(() => expect(t.session.serviceStatuses()).toEqual({ api: 'running', web: 'waiting' })); // oxfmt-ignore
    expect(await t.session.runPackage('web', 'start', BY)).toBe('waiting');
    expect(await t.session.runPackage('web', 'restart', BY)).toBe('waiting');
    expect(t.procs).toHaveLength(1);
    expect(await t.session.runPackage('web', 'stop', BY)).toBe('done');
    expect(t.session.serviceStatuses()).toEqual({ api: 'running', web: 'stopped' });
  });
});

describe('git branch', () => {
  test('an interactive session shows each new branch, and a switch stops nothing', async () => {
    let branch = 'main';
    let onChange: (branch: string | null) => void = () => {};
    let stopped = false;
    const watchBranch = (fn: typeof onChange) => {
      onChange = fn;
      return { get branch() { return branch; }, stop: () => void (stopped = true) }; // oxfmt-ignore
    };
    const t = setup({ services: { api: {} }, interactive: true, seams: { watchBranch, usageReader: () => Promise.resolve(null) } }); // oxfmt-ignore
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    expect(t.session.getSnapshot().workspace).toEqual({ name: path.basename(t.root), branch: 'main' }); // oxfmt-ignore
    let notified = 0;
    t.session.subscribe(() => notified++);
    branch = 'feature';
    onChange('feature');
    await until(() => expect(notified).toBe(1));
    expect(t.session.getSnapshot().workspace.branch).toBe('feature');
    expect(t.session.getSnapshot().phase).toBe('running');
    expect(t.closedCode()).toBeNull();
    expect(t.lines().join('\n')).not.toContain('branch');
    void t.session.shutdown('user');
    expect(await t.session.closed).toBe(0);
    expect(stopped).toBe(true);
  });

  test('a headless session reads the branch once and watches nothing', async () => {
    const watchBranch = vi.fn(() => ({ branch: 'main', stop: () => {} }));
    const t = setup({ services: { api: {} }, seams: { watchBranch } });
    await t.session.start();
    expect(t.session.getSnapshot().workspace.branch).toBe('main');
    expect(watchBranch).not.toHaveBeenCalled();
  });
});

describe("the run screen's session", () => {
  test('an acquisition that fails falls back to a random control port, and headless fails', async () => {
    const failing = { acquire: () => Promise.reject(new Error('record unreadable')) };
    const tui = setup({ services: { api: {} }, interactive: true, seams: { ...failing, randomPort: () => 14077, usageReader: () => Promise.resolve(null) } }); // oxfmt-ignore
    await tui.session.start();
    expect(tui.session.getSnapshot().phase).toBe('running');
    expect(tui.server.askedFor).toBe(14077);
    expect(tui.lines()).toContain('[stackctl] [WARN] couldn\'t settle the session record (record unreadable); using control port 14077'); // oxfmt-ignore

    const headless = setup({ services: { api: {} }, seams: failing });
    await headless.session.start();
    expect(headless.session.getSnapshot()).toMatchObject({ phase: 'failed', failure: { message: 'record unreadable' } }); // oxfmt-ignore
  });

  test('memory is sampled into the snapshot, and a sample that changes no figure notifies nothing', async () => {
    const MiB = 2 ** 20;
    let readings = new Map<string, number>();
    const groupsSeen: ServiceGroups[] = [];
    const reader: UsageReader = {
      interval: 10,
      read: (groups) => {
        groupsSeen.push(groups);
        return new Map<string, ServiceUsage>(
          [...readings].filter(([name]) => groups.has(name)).map(([name, memory]) => [name, { memory, cpu: null }]), // oxfmt-ignore
        );
      },
    };
    const t = setup({
      services: { api: {} },
      interactive: true,
      seams: {
        usageReader: () => Promise.resolve(reader),
        runInfra: () =>
          Promise.resolve({
            services: [{ provider: 'docker-compose', name: 'db' }],
            readMemory: () => Promise.resolve(new Map([['db', 23 * MiB]])),
          }),
      },
    });
    readings = new Map([['api', 64 * MiB]]);
    await t.session.start();
    await until(() => expect(t.session.getSnapshot().services[0]!.memory).toBe(64 * MiB));
    expect(t.session.getSnapshot().infra[0]!.memory).toBe(23 * MiB);
    expect(groupsSeen.at(-1)!.get('api')).toEqual([t.procs[0]!.pid]);

    let calls = 0;
    t.session.subscribe(() => calls++);
    readings = new Map([['api', 64.5 * MiB]]); // under 2%: the figure on screen stays
    const reads = groupsSeen.length;
    await until(() => expect(groupsSeen.length).toBeGreaterThan(reads + 3));
    expect(calls).toBe(0);
    readings = new Map([['api', 80 * MiB]]);
    await until(() => expect(t.session.getSnapshot().services[0]!.memory).toBe(80 * MiB));
    expect(calls).toBeGreaterThan(0);

    await t.session.shutdown('user');
    const after = groupsSeen.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(groupsSeen.length).toBe(after);
  });

  test('a headless session samples nothing', async () => {
    const usageReader = vi.fn(() => Promise.resolve(null));
    const t = setup({ services: { api: {} }, seams: { usageReader } });
    await t.session.start();
    expect(usageReader).not.toHaveBeenCalled();
    expect(t.session.getSnapshot().services[0]).not.toHaveProperty('memory');
  });

  test("an infra entry's startup step is cleared once it is healthy", async () => {
    let finish!: (infra: SessionInfra) => void;
    let emit!: (event: InfraEvent) => void;
    const t = setup({
      services: { api: {} },
      seams: {
        runInfra: (onEvent) => {
          emit = onEvent;
          onEvent({ type: 'targets', provider: 'docker-compose', action: 'up', services: ['db'] });
          onEvent({ type: 'status', service: 'db', status: 'starting', detail: 'waiting for healthy' }); // oxfmt-ignore
          return new Promise((resolve) => (finish = resolve));
        },
      },
    });
    void t.session.start();
    await until(() => expect(t.session.getSnapshot().infra[0]?.detail).toBe('waiting for healthy'));
    emit({ type: 'status', service: 'db', status: 'ready', detail: 'afterReady' });
    await Promise.resolve();
    expect(t.session.getSnapshot().infra[0]).toMatchObject({ state: 'running' });
    expect(t.session.getSnapshot().infra[0]).not.toHaveProperty('detail');
    finish({ services: [{ provider: 'docker-compose', name: 'db' }] });
  });

  test('the branch is known before start, for the first frame', async () => {
    const t = setup({ services: { api: {} }, seams: { readBranch: () => 'main' } });
    expect(t.session.getSnapshot().workspace.branch).toBe('main');
    await t.session.start();
    expect(t.session.getSnapshot().workspace.branch).toBe('main');
  });

  test('clear, filter and one-offs pass through', async () => {
    const t = setup({ services: { api: {}, web: {} } });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(2));

    t.session.applyFilter('web');
    expect(t.lines()).toEqual(['[web     ] started']);
    t.session.applyFilter('  ');
    expect(t.lines()).toContain('[api     ] started');
    t.session.clearLog();
    expect(t.lines()).toEqual([]);

    void t.session.runOneOff('api', { shell: 'echo hi' }, BY);
    await until(() => expect(t.procs).toHaveLength(3));
    expect(t.procs[2]!.opts).toMatchObject({ name: 'api', command: 'echo hi' });
    expect(t.lines()).toEqual(['[api     ] ▶ running: echo hi']);
    expect(t.session.commands).toBe(t.plan.menuCommands);
  });

  test('hardKilled says whether a second request killed everything', async () => {
    const t = setup({ services: { api: {} }, holdStops: ['api'] });
    await t.session.start();
    await until(() => expect(t.procs).toHaveLength(1));
    void t.session.shutdown('user');
    expect(t.session.hardKilled).toBe(false);
    void t.session.shutdown('user');
    expect(t.session.hardKilled).toBe(true);
    expect(await t.session.closed).toBe(1);
  });
});

describe("a forked session's handshake", () => {
  test('it tells its parent once the control server listens', async () => {
    const sent: unknown[] = [];
    const parentChannel: ParentChannel = {
      connected: true,
      send: (message, callback) => {
        sent.push(message);
        callback(null);
        return true;
      },
    };
    const t = setup({ services: { api: {} }, forked: true, seams: { parentChannel } });
    await t.session.start();
    expect(sent).toEqual([expect.objectContaining({ type: 'started', port: 4321, services: ['api'] })]); // oxfmt-ignore
  });

  test('a picked autostart: false service is not one to wait on: it stays stopped (S3-R14)', async () => {
    const sent: unknown[] = [];
    const parentChannel: ParentChannel = {
      connected: true,
      send: (message, callback) => {
        sent.push(message);
        callback(null);
        return true;
      },
    };
    const t = setup({
      services: { api: {}, admin: { autostart: false } },
      forked: true,
      seams: { parentChannel },
    });
    await t.session.start();
    expect(sent).toEqual([expect.objectContaining({ type: 'started', services: ['api'] })]);
    expect(t.session.serviceStatuses()).toMatchObject({ admin: 'stopped' });
  });

  test('a parent gone before it is no failure: the session starts as usual', async () => {
    const closed = () =>
      Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
    const channels: ParentChannel[] = [
      { connected: false, send: () => { throw closed(); } }, // oxfmt-ignore
      { connected: true, send: () => { throw closed(); } }, // oxfmt-ignore
      { connected: true, send: (_m, callback) => (callback(closed()), false) },
      {},
    ];
    for (const parentChannel of channels) {
      const t = setup({ services: { api: {} }, forked: true, seams: { parentChannel } });
      await t.session.start();
      expect(t.session.getSnapshot().phase).toBe('running');
    }
  });

  test('tellParent sends nothing over a disconnected channel', () => {
    const send = vi.fn(() => true);
    tellParent({ connected: false, send }, { type: 'started', pid: 1, port: 1, sessionId: 's', logFile: 'f', services: [] }); // oxfmt-ignore
    expect(send).not.toHaveBeenCalled();
  });
});
