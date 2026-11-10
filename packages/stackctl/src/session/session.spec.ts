import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { type AnyServiceConfig, defineConfig } from '../config.js';
import type { ControlManager } from '../control-server.js';
import type { DevReverseProxyManager, DevReverseProxyServer } from '../dev-reverse-proxy.js';
import { stripAnsi } from '../format.js';
import { InfraFailedError } from '../infra/session.js';
import type { InfraEvent } from '../infra/types.js';
import type { ServiceGroups, ServiceUsage, UsageReader } from '../service-usage.js';
import { buildSessionPlan } from './plan.js';
import type {
  ProcessExit,
  ProcessState,
  ServiceProcessEvents,
  ServiceProcessOptions,
} from './service-process.js';
import {
  type InfraProgress,
  type ParentChannel,
  Session,
  type SessionSeams,
  tellParent,
} from './session.js';
import type { SupervisedProcess } from './supervisor.js';
import type { SessionInfra, SessionPlan } from './types.js';

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

  private exit(exit: ProcessExit): void {
    if (this.state === 'exited') {
      return;
    }
    this.exitCode = exit.signal === 'SIGKILL' ? 137 : 143;
    this.set('exited');
    this.resolveExit(exit);
    this.emit('exit', exit);
  }

  private set(state: ProcessState): void {
    this.state = state;
    this.emit('state', state);
  }
}

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** Waits until `check` stops throwing. */
const until = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 10 });

/**
 * A workspace in a temp directory with a `package.json` per service, its config defined, and a
 * Session over the services `selected` whose every outside step is a recording stub: `order`
 * lists each step as it begins.
 */
function setup(opts: {
  services: Record<string, Record<string, unknown>>;
  selected?: string[];
  /** The services whose processes don't end on a stop. */
  holdStops?: string[];
  seams?: Partial<SessionSeams>;
  /** A session shown on a screen (the TUI). */
  interactive?: boolean;
  /** Started by `startStack()`. */
  forked?: boolean;
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
  } as unknown as Parameters<typeof defineConfig>[0]);
  const all = Object.values(config.services) as AnyServiceConfig[];
  const selected = all.filter((s) =>
    (opts.selected ?? Object.keys(opts.services)).includes(s.name),
  );
  const logFile = path.join(root, 'session.log');
  const plan: SessionPlan = {
    ...buildSessionPlan(selected.map((s) => s.name)),
    cwd: root,
    envFiles: { workspace: ['.env'], service: ['.env'] },
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
    quitHandler: null as (() => void) | null,
    acks: 0,
    closed: false,
    bindSession(manager: ControlManager) {
      this.attached = manager;
    },
    setQuitHandler(fn: () => void) {
      this.quitHandler = fn;
    },
    ackQuit() {
      this.acks++;
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
    ...opts.seams,
  };
  const session = new Session({ plan, configPath: path.join(root, 'stackctl.config.ts'), logFile, forked: opts.forked ?? false, interactive: opts.interactive, seams }); // oxfmt-ignore
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
      session.logs.getVisibleLines().map((l) => `${stripAnsi(l.label)} ${stripAnsi(l.text)}`),
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
      '[stackctl] [INFO] mode development (default)',
      '[stackctl] [INFO] freeing dev ports',
      '[api] started',
      '[web] started',
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
    expect(`${stripAnsi(failure.label)} ${stripAnsi(failure.text)}`).toBe(`[stackctl] [ERROR] ${message}`); // oxfmt-ignore
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
    t.server.quitHandler!();
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
    void t.session.runPackage('api', 'stop');
    void t.session.runPackage('web', 'stop');
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
    expect(await t.session.runPackage('nope', 'start')).toBe('unknown');
    expect(await t.session.runPackage('extra', 'stop')).toBe('done');
    expect(await t.session.runPackage('extra', 'restart')).toBe('unknown');
    expect(await t.session.runPackage('api', 'restart')).toBe('accepted');
    expect(await t.session.runPackage('api', 'stop')).toBe('busy');
    expect(await t.session.runPackage('extra', 'start')).toBe('done');
    expect(t.session.serviceStatuses()).toHaveProperty('extra');
    expect(t.session.runInfra('db', 'restart')).toBe('unknown');
    t.session.logControl('restart', { service: 'web' });
    expect(t.lines().slice(-2)).toEqual(['[dt:control] [INFO] restart', '[dt:control]   service: web']); // oxfmt-ignore
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
    expect(t.lines()).toEqual(['[web] started']);
    t.session.applyFilter('  ');
    expect(t.lines()).toContain('[api] started');
    t.session.clearLog();
    expect(t.lines()).toEqual([]);

    void t.session.runOneOff('api', { shell: 'echo hi' });
    await until(() => expect(t.procs).toHaveLength(3));
    expect(t.procs[2]!.opts).toMatchObject({ name: 'api', command: 'echo hi' });
    expect(t.lines()).toEqual(['[api] ▶ running: echo hi']);
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
