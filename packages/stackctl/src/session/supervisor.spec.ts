import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import primitives from '@dotenvx/primitives';
import chalk from 'chalk';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { STACKCTL_LABEL_COLOR, PACKAGE_PALETTE } from '../colors';
import { type AnyServiceConfig, defineConfig } from '../config';
import { recordWorkspaceEnv } from '../env';
import type { EnvWatch, WatchTarget } from '../env-watch';
import { stripAnsi } from '../format';
import { type HookOutcome, runHook } from '../lifecycle/hooks';
import type { ServiceHooks } from '../lifecycle/service-hooks';
import type { ServiceCallbacks } from '../lifecycle/service-types';
import { COMMAND_END_GRACE_MS } from '../spawn';
import { labelGutter } from './log-layout';
import { LogStore } from './log-store';
import { buildSessionPlan } from './plan';
import { type Clock, Readiness } from './readiness';
import type {
  ProcessExit,
  ProcessState,
  ServiceProcessEvents,
  ServiceProcessOptions,
} from './service-process';
import { type ServiceState, type SupervisedProcess, Supervisor, publicStatus } from './supervisor';
import type { LogLine, SessionPlan } from './types';

const HC = 'http://127.0.0.1:1/health';

/** Every `.env` watch the Supervisor opens: the directories it covers, and whether it was closed. */
const watches = vi.hoisted(
  () => [] as { dirs: string[]; targets: WatchTarget[]; disposed: boolean; ready: Promise<void> }[],
);

vi.mock('../env-watch', async (importOriginal) => {
  const actual = await importOriginal<{
    watchEnvFiles: (opts: { targets: WatchTarget[]; onError?: unknown }) => EnvWatch;
  }>();
  return {
    ...actual,
    watchEnvFiles: (opts: { targets: WatchTarget[] }) => {
      const watch = actual.watchEnvFiles(opts);
      const entry = {
        dirs: opts.targets.map((target) => target.dir),
        targets: opts.targets,
        disposed: false,
        ready: watch.ready,
      };
      watches.push(entry);
      return Object.assign(
        () => {
          entry.disposed = true;
          watch();
        },
        { ready: watch.ready },
      );
    },
  };
});

/** Lets every pending promise callback run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A clock whose time moves only when a test advances it, running due timers in order. */
class FakeClock implements Clock {
  private time = 0;
  private nextId = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    await settle();
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) {
          next = entry;
        }
      }
      if (!next) {
        break;
      }
      this.timers.delete(next[0]);
      this.time = next[1].at;
      next[1].fn();
      await settle();
    }
    this.time = target;
  }
}

let nextPid = 900_000;

/**
 * A process that runs only in the test: it spawns at `start()`, and exits when the test says so
 * (or when killed). `stop()` only asks; the test decides when the stop's exit comes.
 */
class StubProcess extends EventEmitter<ServiceProcessEvents> implements SupervisedProcess {
  state: ProcessState = 'idle';
  pid: number | null = null;
  exitCode: number | null = null;
  stops = 0;
  kills = 0;
  private resolveExit!: (exit: ProcessExit) => void;
  private readonly exited = new Promise<ProcessExit>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(
    readonly opts: ServiceProcessOptions,
    private readonly failSpawn: boolean,
  ) {
    super();
  }

  start(): void {
    this.set('starting');
    if (this.failSpawn) {
      this.line('failed to start: spawn /bin/sh ENOENT', true);
      this.exit({ code: null, signal: null });
      return;
    }
    this.pid = nextPid++;
    this.set('running');
  }

  stop(): Promise<ProcessExit> {
    this.stops++;
    if (this.state === 'running') {
      this.set('stopping');
    }
    return this.exited;
  }

  kill(): void {
    this.kills++;
    this.exit({ code: null, signal: 'SIGKILL' });
  }

  line(text: string, isError = false): void {
    this.opts.onLine(text, isError);
  }

  exit(exit: ProcessExit): void {
    if (this.state === 'exited') {
      return;
    }
    this.exitCode =
      exit.code ?? (exit.signal === 'SIGKILL' ? 137 : exit.signal === 'SIGTERM' ? 143 : 1);
    this.set('exited');
    this.resolveExit(exit);
    this.emit('exit', exit);
  }

  private set(state: ProcessState): void {
    this.state = state;
    this.emit('state', state);
  }
}

type ServicesInput = Record<string, Record<string, unknown>>;

/**
 * Makes `file` a FIFO, so a read of it blocks. `release()` starts a writer that feeds every reader
 * from then on; `close()` stops it, unblocking a write still waiting for a reader.
 */
function holdReads(file: string): { release(): void; close(): void } {
  const made = spawnSync('mkfifo', [file]);
  if (made.status !== 0) {
    throw new Error(`mkfifo ${file} failed: ${String(made.stderr)}`);
  }
  let pumping = false;
  const feed = { done: false };
  const pump = async () => {
    while (!feed.done) {
      try {
        await fs.promises.writeFile(file, 'HELD=1\n');
      } catch {
        /* the reader went away */
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return {
    release() {
      if (!pumping) {
        pumping = true;
        void pump();
      }
    },
    close() {
      feed.done = true;
      if (!pumping) {
        return;
      }
      // A non-blocking reader lets a write waiting on its open go through, and the pump stop.
      try {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        setTimeout(() => fs.closeSync(fd), 100);
      } catch {
        /* gone */
      }
    },
  };
}

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/**
 * A workspace in a temp directory, with a `package.json` per service (a `dev` and a `lint`
 * script, unless `noDev` names it), its config defined, and a Supervisor over the services
 * `selected` (every service by default) with stub processes and a fake clock.
 */
function setup(opts: {
  services: ServicesInput;
  selected?: string[];
  noDev?: string[];
  logTimestamps?: boolean;
  failSpawn?: string[];
  /** The config's `env.decrypt`. */
  decrypt?: boolean;
  /** Files to write before anything reads them, by path relative to the workspace. */
  files?: Record<string, string>;
  /**
   * A file, relative to the workspace, made a FIFO: every read of it waits until `release()`
   * starts feeding it.
   */
  held?: string;
  /** The plan's `cwd`, relative to the workspace, when it isn't the workspace root itself. */
  cwd?: string;
  /** The config's top-level `env`. */
  env?: Record<string, unknown>;
  /** The services' lifecycle hooks. */
  hooks?: ServiceHooks;
  /** Gets `spawn <name>` for every dev process spawned, beside what `hooks` records there. */
  events?: string[];
  /** The session shows the terminal UI. */
  interactive?: boolean;
}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-sup-')));
  for (const [name, service] of Object.entries(opts.services)) {
    const own = (service as { dir?: string }).dir;
    const dir = path.join(root, own ?? path.join('packages', name));
    fs.mkdirSync(dir, { recursive: true });
    const scripts: Record<string, string> = { lint: 'echo lint' };
    if (!opts.noDev?.includes(name)) {
      scripts.dev = `node ${name}.js`;
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, scripts }));
  }
  for (const [file, text] of Object.entries(opts.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const held = opts.held ? holdReads(path.join(root, opts.held)) : null;
  const config = defineConfig({
    workspaceDir: root,
    serviceRootDir: 'packages',
    ...(opts.logTimestamps === undefined ? {} : { logs: { timestamps: opts.logTimestamps } }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
    services: opts.services,
  } as unknown as Parameters<typeof defineConfig>[0]);
  const all = Object.values(config.services) as AnyServiceConfig[];
  const selected = all.filter((s) =>
    (opts.selected ?? Object.keys(opts.services)).includes(s.name),
  );
  const plan: SessionPlan = {
    ...buildSessionPlan(selected.map((s) => s.name)),
    cwd: opts.cwd === undefined ? root : path.join(root, opts.cwd),
    resolvedWorkspaceDir: root,
    envFiles: ['.env'],
    envDecrypt: opts.decrypt,
  };
  const logs = new LogStore({ logFile: path.join(root, 'session.log') });
  const clock = new FakeClock();
  const answers = new Map<string, boolean>();
  const readiness = new Readiness({
    clock,
    probe: (name) => Promise.resolve(answers.get(name) ?? false),
  });
  const procs: StubProcess[] = [];
  const supervisor = new Supervisor({
    plan,
    logs,
    readiness,
    clock,
    hooks: opts.hooks,
    interactive: opts.interactive,
    createProcess: (o) => {
      const proc = new StubProcess(o, opts.failSpawn?.includes(o.name) ?? false);
      procs.push(proc);
      opts.events?.push(`spawn ${o.name}`);
      return proc;
    },
  });
  const transitions: string[] = [];
  supervisor.on('change', () => {
    for (const [name, s] of supervisor.states()) {
      const last = transitions.findLast((t) => t.startsWith(`${name} `));
      if (last !== `${name} ${s.state}`) {
        transitions.push(`${name} ${s.state}`);
      }
    }
  });
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => logs.close());
  cleanups.push(() => supervisor.killEverything());
  // First of all: a reader the pump is blocked on must not outlive the test.
  cleanups.push(() => held?.close());

  const of = (name: string) => procs.filter((p) => p.opts.name === name);
  return {
    root,
    plan,
    logs,
    clock,
    answers,
    readiness,
    supervisor,
    procs,
    /** Lets every read of the `held` file through, from now on. */
    release: () => held?.release(),
    transitions,
    /** The processes spawned for a service, oldest first. */
    of,
    /** The latest process spawned for a service. */
    proc: (name: string) => of(name).at(-1)!,
    state: (name: string): ServiceState | undefined => supervisor.states().get(name)?.state,
    /** Every buffered line as `label text`, colors stripped and the label's padding kept. */
    lines: () =>
      logs
        .getVisibleLines()
        .map((l) => `${labelGutter(l.label, logs.labelWidth)} ${stripAnsi(l.text)}`),
    /** A service's own lines, text only, colors stripped. */
    said: (name: string) =>
      logs
        .getVisibleLines()
        .filter((l) => l.service === name)
        .map((l) => stripAnsi(l.text)),
  };
}

/** Waits until `check` stops throwing. */
const until = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 10 });

/** Runs `fn` with chalk at truecolor, so labels and lines carry their colors. */
async function withColors<T>(fn: () => Promise<T> | T): Promise<T> {
  const level = chalk.level;
  chalk.level = 3;
  try {
    return await fn();
  } finally {
    chalk.level = level;
  }
}

/** A line's label as it is drawn: padded to the store's width now, painted. */
const drawn = (logs: LogStore, line: LogLine) => labelGutter(line.label, logs.labelWidth);

describe('publicStatus', () => {
  test('held services wait, spawning reads running, a crash reads stopped, a failed hook reads failed', () => {
    expect(publicStatus('pending')).toBe('waiting');
    expect(publicStatus('waiting')).toBe('waiting');
    expect(publicStatus('starting')).toBe('running');
    expect(publicStatus('running')).toBe('running');
    expect(publicStatus('restarting')).toBe('restarting');
    expect(publicStatus('stopped')).toBe('stopped');
    expect(publicStatus('crashed')).toBe('stopped');
    expect(publicStatus('failed')).toBe('failed');
  });
});

describe('starting the session', () => {
  test('nothing spawns before the first .env read; the services are pending until then', async () => {
    const t = setup({ services: { api: {}, web: {} } });
    expect(t.state('api')).toBe('pending');
    t.supervisor.launchAll();
    expect(t.procs).toHaveLength(0);
    expect(publicStatus(t.state('api')!)).toBe('waiting');
    await until(() => expect(t.procs).toHaveLength(2));
    expect(t.state('api')).toBe('running');
    expect(t.said('api')).toEqual(['started']);
    expect(t.supervisor.states().get('api')).toEqual({
      state: 'running',
      exitCode: null,
      ready: true,
      pid: t.proc('api').pid,
      hook: null,
    });
  });

  test('the dev command is the script text, run in the service directory with its env', async () => {
    const t = setup({
      services: { api: { port: 21001 } },
      files: { 'packages/api/.env': 'GREETING=hello\n' },
    });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    const { opts } = t.proc('api');
    expect(opts.command).toBe('node api.js');
    expect(opts.cwd).toBe(path.join(t.root, 'packages/api'));
    expect(opts.env.GREETING).toBe('hello');
    expect(opts.env.PORT).toBe('21001');
    expect(opts.env.npm_lifecycle_event).toBe('dev');
    expect(opts.records).toBe(t.supervisor.records);
  });

  test("starts a service with every directory's .env files up to it, the nearest winning", async () => {
    const t = setup({
      services: { api: {} },
      files: {
        '.env': 'A=root\nB=root\nC=root\n',
        'packages/.env': 'B=packages\nC=packages\n',
        'packages/api/.env': 'C=api\n',
      },
    });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    const { env } = t.proc('api').opts;
    expect([env.A, env.B, env.C]).toEqual(['root', 'packages', 'api']);
  });

  test("starts a service with its own env: its vars and files, and no other service's", async () => {
    const t = setup({
      env: { vars: { TOP: 'top', SHARED: 'top' } },
      services: {
        api: {
          env: {
            vars: { SHARED: 'api', MINE: 'api' },
            additionalFiles: [{ file: '.env.api', after: '.env' }],
          },
        },
        web: {},
      },
      files: { '.env.api': 'FROM_API_FILE=1\n' },
    });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(2));
    const api = t.proc('api').opts.env;
    const web = t.proc('web').opts.env;
    expect([api.TOP, api.SHARED, api.MINE, api.FROM_API_FILE]).toEqual(['top', 'api', 'api', '1']);
    expect([web.TOP, web.SHARED, web.MINE, web.FROM_API_FILE]).toEqual(['top', 'top', undefined, undefined]); // oxfmt-ignore
  });

  test("starts a service that doesn't inherit without the config's env", async () => {
    const t = setup({
      env: { vars: { TOP: 'top' }, additionalFiles: [{ file: '.env.shared', after: '.env' }] },
      services: { api: { env: { inherits: false, vars: { MINE: 'api' } } } },
      files: { '.env.shared': 'SHARED_FILE=1\n' },
    });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    const { env } = t.proc('api').opts;
    expect([env.TOP, env.SHARED_FILE, env.MINE]).toEqual([undefined, undefined, 'api']);
  });

  test("keeps the workspace layer the CLI merged into its own env out of a service that doesn't inherit", async () => {
    // What `applyWorkspaceEnv` does in the CLI, before a session starts.
    recordWorkspaceEnv(['STACKCTL_SPEC_TOP']);
    process.env.STACKCTL_SPEC_TOP = 'top';
    try {
      const t = setup({
        env: { vars: { STACKCTL_SPEC_TOP: 'top' } },
        services: { solo: { env: { inherits: false } }, api: {} },
      });
      t.supervisor.launchAll();
      await until(() => expect(t.procs).toHaveLength(2));
      expect(t.proc('solo').opts.env.STACKCTL_SPEC_TOP).toBeUndefined();
      expect(t.proc('api').opts.env.STACKCTL_SPEC_TOP).toBe('top');
    } finally {
      delete process.env.STACKCTL_SPEC_TOP;
      recordWorkspaceEnv([]);
    }
  });

  test('keeps the injected PORT over a PORT set in a directory between', async () => {
    const t = setup({
      services: { api: { port: 21001 } },
      files: { 'packages/.env': 'PORT=9999\n' },
    });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    expect(t.proc('api').opts.env.PORT).toBe('21001');
  });

  test("resolves the .env files from the config's root when the CLI anchored elsewhere", async () => {
    const t = setup({
      services: { api: {} },
      cwd: 'cfg',
      files: { '.env': 'A=root\n', 'cfg/.env': 'A=cfg\n', 'packages/.env': 'B=packages\n' },
    });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    const { env } = t.proc('api').opts;
    expect([env.A, env.B]).toEqual(['root', 'packages']);
  });

  test('autostart false is stopped, not waiting', async () => {
    const t = setup({
      services: { db: { healthcheck: HC }, api: { autostart: false, deps: [{ service: 'db', wait: true }] } }, // oxfmt-ignore
    });
    t.supervisor.launchAll();
    expect(t.state('api')).toBe('stopped');
    await until(() => expect(t.of('db')).toHaveLength(1));
    expect(t.of('api')).toHaveLength(0);
    expect(t.said('api')).toEqual([]);
  });

  test('a warning names what the first .env read waits on after 3 s', async () => {
    const t = setup({ services: { api: {} } });
    await t.clock.advance(3000);
    expect(t.lines().join('\n')).toMatch(
      /\[stackctl\] \[WARN\] waiting to read .+ before starting services; if it is in a cloud-synced folder/,
    );
  });

  test('a service that fails to start is crashed, others unaffected', async () => {
    const t = setup({ services: { broken: {}, api: {}, web: {} }, noDev: ['web'], failSpawn: ['broken'] }); // oxfmt-ignore
    t.supervisor.launchAll();
    expect(t.state('web')).toBe('stopped');
    await until(() => expect(t.state('api')).toBe('running'));
    expect(t.supervisor.states().get('broken')).toEqual({
      state: 'crashed',
      exitCode: 1,
      ready: false,
      pid: null,
      hook: null,
    });
    expect(t.said('broken')).toEqual([
      'started',
      'failed to start: spawn /bin/sh ENOENT',
      'exited with code 1',
    ]);
    expect(t.logs.getVisibleLines().find((l) => l.text.includes('failed'))?.isError).toBe(true);
    expect(t.said('web')).toEqual([]);
    expect(t.of('web')).toHaveLength(0);
  });

  test('an exit by itself keeps its code: 0 is stopped, anything else crashed', async () => {
    const t = setup({ services: { api: {}, web: {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(2));
    t.proc('api').exit({ code: 0, signal: null });
    t.proc('web').exit({ code: null, signal: 'SIGTERM' });
    expect(t.supervisor.states().get('api')).toMatchObject({ state: 'stopped', exitCode: 0 });
    expect(t.supervisor.states().get('web')).toMatchObject({ state: 'crashed', exitCode: 143 });
    expect(t.said('api')).toEqual(['started', 'exited with code 0']);
    expect(t.said('web')).toEqual(['started', 'exited with code 143']);
    // The next start clears the code.
    await t.supervisor.start('api');
    expect(t.supervisor.states().get('api')).toMatchObject({ state: 'running', exitCode: null });
  });
});

describe('waits', () => {
  const services = {
    db: { healthcheck: HC },
    cache: { healthcheck: HC },
    api: { deps: [{ service: 'db', wait: true }] },
  };

  test('waits for deps before starting, released as soon as they are ready', async () => {
    const t = setup({ services });
    t.supervisor.launchAll();
    expect(t.state('api')).toBe('waiting');
    expect(t.said('api')).toEqual(['waiting for db...']);
    await until(() => expect(t.of('db')).toHaveLength(1));
    await t.clock.advance(1000);
    expect(t.of('api')).toHaveLength(0);
    t.answers.set('db', true);
    // The next probe, not a 2 s check, releases it.
    await t.clock.advance(1600);
    expect(t.said('api')).toEqual(['waiting for db...', 'db ready, starting...', 'started']);
    expect(t.state('api')).toBe('running');
  });

  test('released only when every dep it waits on is ready', async () => {
    const t = setup({
      services: { ...services, api: { deps: [{ service: 'db', wait: true }, { service: 'cache', wait: true }] } }, // oxfmt-ignore
    });
    t.supervisor.launchAll();
    expect(t.said('api')).toEqual(['waiting for db, cache...']);
    await until(() => expect(t.of('cache')).toHaveLength(1));
    t.answers.set('db', true);
    await t.clock.advance(5000);
    expect(t.state('api')).toBe('waiting');
    t.answers.set('cache', true);
    await t.clock.advance(2000);
    expect(t.said('api').slice(1)).toEqual(['db, cache ready, starting...', 'started']);
  });

  test('a waited-on service that exits leaves its waiters waiting, and they go once it is ready again', async () => {
    const t = setup({ services });
    t.supervisor.launchAll();
    await until(() => expect(t.of('db')).toHaveLength(1));
    t.proc('db').exit({ code: 1, signal: null });
    expect(t.supervisor.states().get('db')).toMatchObject({ state: 'crashed', exitCode: 1 });
    await t.clock.advance(5000);
    expect(t.state('api')).toBe('waiting');
    expect(t.said('api')).toEqual(['waiting for db...']);
    await t.supervisor.start('db');
    t.answers.set('db', true);
    await t.clock.advance(2000);
    expect(t.state('api')).toBe('running');
  });

  test('a waiter the user stops stays stopped', async () => {
    const t = setup({ services });
    t.supervisor.launchAll();
    await t.supervisor.stop('api');
    expect(t.state('api')).toBe('stopped');
    t.answers.set('db', true);
    await until(() => expect(t.of('db')).toHaveLength(1));
    await t.clock.advance(5000);
    expect(t.state('api')).toBe('stopped');
    expect(t.of('api')).toHaveLength(0);
    expect(t.said('api')).toEqual(['waiting for db...']);
  });

  test('a start or restart of a waiter does nothing: it starts once what it waits for is ready', async () => {
    const t = setup({ services });
    t.supervisor.launchAll();
    await t.supervisor.start('api');
    await t.supervisor.restart('api');
    expect(t.state('api')).toBe('waiting');
    expect(t.of('api')).toHaveLength(0);
    expect(t.said('api')).toEqual(['waiting for db...']);
    await until(() => expect(t.of('db')).toHaveLength(1));
    t.answers.set('db', true);
    await t.clock.advance(1600);
    expect(t.said('api')).toEqual(['waiting for db...', 'db ready, starting...', 'started']);
    expect(t.state('api')).toBe('running');
  });

  test("a service that can't be started stays stopped, silently, even with waits", async () => {
    const t = setup({ services, noDev: ['api'] });
    t.supervisor.launchAll();
    expect(t.state('api')).toBe('stopped');
    await until(() => expect(t.of('db')).toHaveLength(1));
    await t.supervisor.start('api');
    expect(t.state('api')).toBe('stopped');
    expect(t.said('api')).toEqual([]);
  });

  test('a stop drops readiness at once, before the process has exited', async () => {
    const t = setup({ services: { db: { healthcheck: HC } } });
    t.supervisor.launchAll();
    await until(() => expect(t.of('db')).toHaveLength(1));
    t.answers.set('db', true);
    await t.clock.advance(100);
    expect(t.supervisor.states().get('db')?.ready).toBe(true);
    const stopping = t.supervisor.stop('db');
    expect(t.supervisor.states().get('db')).toMatchObject({ state: 'stopped', ready: false });
    expect(t.readiness.isReady('db')).toBe(false);
    t.proc('db').exit({ code: null, signal: 'SIGTERM' });
    await stopping;
  });

  test("stopAll doesn't wait on waiters", async () => {
    const t = setup({ services });
    t.supervisor.launchAll();
    await until(() => expect(t.of('db')).toHaveLength(1));
    const done = t.supervisor.stopAll();
    for (const proc of t.procs) {
      proc.exit({ code: null, signal: 'SIGTERM' });
    }
    await done;
    expect(t.state('api')).toBe('stopped');
    t.answers.set('db', true);
    await t.clock.advance(5000);
    expect(t.of('api')).toHaveLength(0);
  });
});

describe('stop and restart', () => {
  test('a stop logs stopping and stopped, keeps no exit code, and resolves after the exit', async () => {
    const t = setup({ services: { api: {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    let stopped = false;
    const stopping = t.supervisor.stop('api').then(() => {
      stopped = true;
    });
    await settle();
    expect(t.state('api')).toBe('stopped');
    expect(stopped).toBe(false);
    t.proc('api').exit({ code: 143, signal: null });
    await stopping;
    expect(t.said('api')).toEqual(['started', 'stopping...', 'stopped']);
    expect(t.supervisor.states().get('api')).toMatchObject({ exitCode: null, pid: null });
  });

  test('restart goes restarting → running', async () => {
    const t = setup({ services: { api: {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    t.transitions.length = 0;
    const first = t.supervisor.restart('api');
    expect(t.supervisor.restart('api')).toBe(first);
    expect(t.state('api')).toBe('restarting');
    expect(publicStatus(t.state('api')!)).toBe('restarting');
    t.of('api')[0]!.exit({ code: null, signal: 'SIGTERM' });
    await first;
    expect(t.transitions).toEqual(['api restarting', 'api starting', 'api running']);
    expect(t.of('api')).toHaveLength(2);
    expect(t.said('api')).toEqual(['started', 'stopping...', 'stopped', 'started', 'restarted']);
  });

  test('a restart that the shutdown overtakes starts nothing', async () => {
    const t = setup({ services: { api: {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    const restarting = t.supervisor.restart('api');
    const stopping = t.supervisor.stopAll();
    t.proc('api').exit({ code: null, signal: 'SIGTERM' });
    await Promise.all([restarting, stopping]);
    expect(t.of('api')).toHaveLength(1);
    expect(t.state('api')).toBe('stopped');
    expect(t.said('api')).toEqual(['started', 'stopping...']);
  });
});

describe('add', () => {
  test('add starts the service and its deps not yet running', async () => {
    const t = setup({
      services: {
        db: { healthcheck: HC },
        api: { deps: ['db'] },
        worker: {},
        'admin-console': { autostart: false, deps: ['api', 'worker'] },
      },
      selected: ['worker'],
    });
    t.supervisor.launchAll();
    await until(() => expect(t.of('worker')).toHaveLength(1));
    expect(await t.supervisor.add('admin-console')).toBe('done');
    // Deps first, then the service; one level of deps, so db stays out.
    expect([...t.supervisor.states().keys()]).toEqual(['worker', 'api', 'admin-console']);
    expect(t.plan.sortedPackages.map((p) => p.name)).toEqual(['worker', 'api', 'admin-console']);
    expect(t.plan.picked.has('admin-console')).toBe(true);
    expect(t.said('api')).toEqual(['added to the session', 'started']);
    // Started whatever its autostart: it was asked for.
    expect(t.said('admin-console')).toEqual(['added to the session', 'started']);
    expect(t.of('worker')).toHaveLength(1);
    expect(t.said('worker')).toEqual(['started']);
    expect(await t.supervisor.add('worker')).toBe('done');
    expect(await t.supervisor.add('ghost')).toBe('unknown');
    t.supervisor.killEverything();
    expect(await t.supervisor.add('db')).toBe('closing');
  });

  test('an added dep with autostart false stays stopped', async () => {
    const t = setup({
      services: { db: { autostart: false }, api: { deps: ['db'] }, worker: {} },
      selected: ['worker'],
    });
    t.supervisor.launchAll();
    expect(await t.supervisor.add('api')).toBe('done');
    expect(t.state('db')).toBe('stopped');
    expect(t.state('api')).toBe('running');
  });
});

describe('.env changes', () => {
  test('env change restarts only that service', async () => {
    const t = setup({ services: { api: {}, web: {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(2));
    const restart = t.supervisor.envChanged('api');
    t.of('api')[0]!.exit({ code: null, signal: 'SIGTERM' });
    await restart;
    expect(t.said('api')).toEqual([
      'started',
      '.env changed, restarting...',
      'stopping...',
      'stopped',
      'started',
      'restarted',
    ]);
    expect(t.of('web')).toHaveLength(1);
    expect(t.said('web')).toEqual(['started']);
  });

  test('a service that is not running is left alone', async () => {
    const t = setup({ services: { api: {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    const stopping = t.supervisor.stop('api');
    t.proc('api').exit({ code: null, signal: 'SIGTERM' });
    await stopping;
    await t.supervisor.envChanged('api');
    expect(t.of('api')).toHaveLength(1);
  });

  test("editing a service's .env file restarts it with the new values", async () => {
    const t = setup({ services: { api: {}, web: {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(2));
    // The watch reads what the files start as on its own time; an edit it reads as its starting
    // point fires nothing, so each attempt writes a new value until one restarts the service.
    let value = '';
    const stopped = () => t.of('api')[0]!.stops > 0;
    for (let attempt = 1; attempt <= 8 && !stopped(); attempt++) {
      value = `edit-${attempt}`;
      fs.writeFileSync(path.join(t.root, 'packages/api/.env'), `GREETING=${value}\n`);
      for (let waited = 0; waited < 2000 && !stopped(); waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(t.of('api')[0]!.stops).toBe(1);
    t.of('api')[0]!.exit({ code: null, signal: 'SIGTERM' });
    await until(() => expect(t.of('api')).toHaveLength(2));
    expect(t.proc('api').opts.env.GREETING).toBe(value);
    expect(t.of('web')).toHaveLength(1);
  }, 30_000);
});

describe('one-offs', () => {
  test('a script runs through its text, framed by running and finished lines', async () => {
    const t = setup({ services: { api: {} } });
    const run = t.supervisor.runOneOff('api', 'lint');
    await until(() => expect(t.procs).toHaveLength(1));
    const proc = t.proc('api');
    expect(proc.opts.command).toBe('echo lint');
    expect(proc.opts.env.npm_lifecycle_event).toBe('lint');
    proc.line('lint ok');
    proc.exit({ code: 0, signal: null });
    await run;
    expect(t.said('api')).toEqual(['▶ running: lint', 'lint ok', '✔ lint finished']);
    // It never touched the service's state.
    expect(t.state('api')).toBe('pending');
  });

  test('a failure ends with an error line naming its code', async () => {
    const t = setup({ services: { api: {} } });
    const run = t.supervisor.runOneOff('api', { shell: 'exit 2 | cat' });
    await until(() => expect(t.procs).toHaveLength(1));
    expect(t.proc('api').opts.command).toBe('exit 2 | cat');
    expect(t.proc('api').opts.env.npm_lifecycle_event).toBe(process.env.npm_lifecycle_event);
    t.proc('api').exit({ code: 2, signal: null });
    await run;
    const last = t.logs.getVisibleLines().at(-1)!;
    expect(stripAnsi(last.text)).toBe('✘ exit 2 | cat exited with code 2');
    expect(last.isError).toBe(true);
  });

  test('a missing script is a quoted shell command that reports it', async () => {
    const t = setup({ services: { api: {} } });
    void t.supervisor.runOneOff('api', "it's missing");
    await until(() => expect(t.procs).toHaveLength(1));
    const result = spawnSync('/bin/sh', ['-c', t.proc('api').opts.command], { encoding: 'utf8' });
    expect(result.stderr).toBe('Missing script: "it\'s missing"\n');
    expect(result.status).toBe(1);
  });

  test("a stop of its service doesn't stop it; the shutdown does", async () => {
    const t = setup({ services: { api: {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    void t.supervisor.runOneOff('api', 'lint');
    await until(() => expect(t.procs).toHaveLength(2));
    const [dev, oneOff] = t.procs as [StubProcess, StubProcess];
    expect(t.supervisor.groups()).toEqual(new Map([['api', [dev.pid, oneOff.pid]]]));
    const stopping = t.supervisor.stop('api');
    dev.exit({ code: null, signal: 'SIGTERM' });
    await stopping;
    expect(oneOff.stops).toBe(0);
    const all = t.supervisor.stopAll();
    expect(oneOff.stops).toBe(1);
    oneOff.exit({ code: null, signal: 'SIGTERM' });
    await all;
    expect(t.said('api').at(-1)).toBe('stopped');
  });
});

describe('shutdown', () => {
  test('stopAll stops every service in parallel and resolves after all exit', async () => {
    const t = setup({ services: { api: {}, web: {}, worker: {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(3));
    let done = false;
    const stopping = t.supervisor.stopAll().then(() => {
      done = true;
    });
    expect(t.supervisor.stopAll()).toBe(t.supervisor.stopAll());
    // Every process was asked at once, before any had exited.
    expect(t.procs.map((p) => p.stops)).toEqual([1, 1, 1]);
    for (const name of ['api', 'web', 'worker']) {
      expect(t.state(name)).toBe('stopped');
    }
    t.proc('api').exit({ code: null, signal: 'SIGTERM' });
    t.proc('web').exit({ code: null, signal: 'SIGTERM' });
    await settle();
    expect(done).toBe(false);
    t.proc('worker').exit({ code: null, signal: 'SIGKILL' });
    await stopping;
    // No status line for any of them, and nothing starts after.
    expect(t.said('api')).toEqual(['started']);
    expect(t.supervisor.states().get('worker')).toMatchObject({ state: 'stopped', exitCode: null });
    await t.supervisor.start('api');
    await t.supervisor.restart('api');
    await t.supervisor.runOneOff('api', 'lint');
    expect(t.procs).toHaveLength(3);
  });

  test('killEverything during stopAll kills everything still in its grace period', async () => {
    const t = setup({ services: { api: {}, web: {}, worker: {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(3));
    const stopping = t.supervisor.stopAll();
    t.proc('api').exit({ code: null, signal: 'SIGTERM' });
    t.supervisor.killEverything();
    expect(t.procs.map((p) => p.kills)).toEqual([0, 1, 1]);
    await stopping;
    expect(t.supervisor.groups().size).toBe(0);
  });
});

describe('labels and colors', () => {
  test("a service label is padded to the longest label, stackctl's included, and colored by its position", async () => {
    await withColors(async () => {
      const t = setup({ services: { api: {}, 'web-app': {}, worker: {} } });
      t.supervisor.launchAll();
      await until(() => expect(t.procs).toHaveLength(3));
      const labels = new Map(
        t.logs.getVisibleLines().map((l) => [l.service, drawn(t.logs, l)] as const),
      );
      const order = t.plan.sortedPackages.map((p) => p.name);
      for (const name of ['api', 'web-app', 'worker']) {
        const index = order.indexOf(name);
        expect(labels.get(name)).toBe(
          chalk.hex(PACKAGE_PALETTE[index]!)(`[${name.padEnd('stackctl'.length)}]`),
        );
      }
    });
  });

  test('the palette cycles past its last color', async () => {
    await withColors(async () => {
      const names = Array.from({ length: PACKAGE_PALETTE.length + 1 }, (_, i) => `s${String(i).padStart(2, '0')}`); // oxfmt-ignore
      const t = setup({ services: Object.fromEntries(names.map((n) => [n, {}])) });
      t.supervisor.launchAll();
      await until(() => expect(t.procs).toHaveLength(names.length));
      const last = t.plan.sortedPackages.at(-1)!.name;
      const line = t.logs.getVisibleLines().find((l) => l.service === last)!;
      expect(drawn(t.logs, line)).toBe(chalk.hex(PACKAGE_PALETTE[0]!)(`[${last.padEnd(8)}]`));
    });
  });

  test("a service's color is hex, rgb(), ansi256() or a color name; anything else is uncolored", async () => {
    await withColors(async () => {
      const colors: Record<string, string> = {
        a: '#af87ff',
        b: 'af87ff',
        c: '#abc',
        d: 'rgb( 175, 135 ,255 )',
        e: 'ansi256(140)',
        f: 'magentaBright',
        g: 'grey',
        h: 'bold',
        i: 'constructor',
        j: 'rgb(300, 0, 0)',
        k: 'tomato',
      };
      const t = setup({
        services: Object.fromEntries(Object.entries(colors).map(([n, color]) => [n, { color }])),
      });
      t.supervisor.launchAll();
      await until(() => expect(t.procs).toHaveLength(11));
      const labelOf = (name: string) =>
        drawn(
          t.logs,
          t.logs.getVisibleLines().find((l) => l.service === name)!,
        );
      expect(labelOf('a')).toBe(chalk.hex('#af87ff')('[a       ]'));
      expect(labelOf('b')).toBe(chalk.hex('#af87ff')('[b       ]'));
      expect(labelOf('c')).toBe(chalk.hex('#aabbcc')('[c       ]'));
      expect(labelOf('d')).toBe(chalk.rgb(175, 135, 255)('[d       ]'));
      expect(labelOf('e')).toBe(chalk.ansi256(140)('[e       ]'));
      expect(labelOf('f')).toBe(chalk.magentaBright('[f       ]'));
      expect(labelOf('g')).toBe(chalk.grey('[g       ]'));
      for (const name of ['h', 'i', 'j', 'k']) {
        expect(labelOf(name)).toBe(`[${name.padEnd(8)}]`);
      }
    });
  });

  test("an added service takes its position's color, and a longer name re-pads every line", async () => {
    await withColors(async () => {
      const t = setup({ services: { api: {}, 'billing-worker': {} }, selected: ['api'] });
      t.supervisor.launchAll();
      await until(() => expect(t.logs.getVisibleLines().some((l) => l.service === 'api')).toBe(true)); // oxfmt-ignore
      const first = t.logs.getVisibleLines().find((l) => l.service === 'api')!;
      expect(drawn(t.logs, first)).toBe(chalk.hex(PACKAGE_PALETTE[0]!)('[api     ]'));
      await t.supervisor.add('billing-worker');
      const labelOf = (name: string) =>
        drawn(
          t.logs,
          t.logs.getVisibleLines().findLast((l) => l.service === name)!,
        );
      expect(labelOf('billing-worker')).toBe(chalk.hex(PACKAGE_PALETTE[1]!)('[billing-worker]'));
      expect(labelOf('api')).toBe(chalk.hex(PACKAGE_PALETTE[0]!)('[api           ]'));
      expect(drawn(t.logs, first)).toBe(labelOf('api'));
    });
  });

  test("stackctl's labels are gold, and count in the width like the services'", async () => {
    await withColors(() => {
      const gold = chalk.hex(STACKCTL_LABEL_COLOR);
      const wide = setup({ services: { 'payments-worker': {} } });
      wide.supervisor.log.system.warn('shutting down...');
      wide.supervisor.log.control.info({ service: 'payments-worker' }, 'restart');
      const lines = wide.logs.getVisibleLines();
      expect(lines.map((l) => drawn(wide.logs, l))).toEqual([
        gold('[stackctl       ]'),
        gold('[control        ]'),
        gold('[control        ]'),
      ]);
      expect(lines.map((l) => stripAnsi(l.text))).toEqual([
        '[WARN] shutting down...',
        '[INFO] restart',
        '  service: payments-worker',
      ]);
      const narrow = setup({ services: { api: {} } });
      narrow.supervisor.log.system.info('hello');
      narrow.supervisor.log.control.info('quit');
      expect(narrow.logs.getVisibleLines().map((l) => drawn(narrow.logs, l))).toEqual([
        gold('[stackctl]'),
        gold('[control ]'),
      ]);
    });
  });

  test('a control line naming a session service is filed under it; others are not', () => {
    const t = setup({ services: { api: { logs: { timestamps: false } } }, logTimestamps: true });
    t.supervisor.log.control.info({ service: 'api' }, 'stop');
    t.supervisor.log.control.info({ service: 'ghost' }, 'stop');
    t.supervisor.log.control.info({ infraService: 'postgres' }, 'infra reset');
    t.supervisor.log.system.error('boom');
    const lines = t.logs.getVisibleLines();
    expect(lines.map((l) => [l.filterKey, l.service, l.showTs, l.continues])).toEqual([
      ['api', 'api', false, false],
      ['api', 'api', false, true],
      ['control', null, true, false],
      ['control', null, true, true],
      ['control', null, true, false],
      ['control', null, true, true],
      ['system', null, true, false],
    ]);
    expect(lines.map((l) => l.isError)).toEqual([false, false, false, false, false, false, true]);
  });
});

describe('on-screen timestamps', () => {
  async function showTs(opts: { session?: boolean; service?: boolean }) {
    const t = setup({
      services: { api: opts.service === undefined ? {} : { logs: { timestamps: opts.service } } },
      ...(opts.session === undefined ? {} : { logTimestamps: opts.session }),
    });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    t.proc('api').line('hello');
    t.supervisor.log.system.info('note');
    const lines = t.logs.getVisibleLines();
    return {
      service: lines.filter((l) => l.service === 'api').map((l) => l.showTs),
      system: lines.filter((l) => l.filterKey === 'system').map((l) => l.showTs),
    };
  }

  test('lines show their timestamp by default', async () => {
    expect(await showTs({})).toEqual({ service: [true, true], system: [true] });
  });

  test('the session-wide setting turns them off', async () => {
    expect(await showTs({ session: false })).toEqual({ service: [false, false], system: [false] });
  });

  test("a service's own setting overrides the session's", async () => {
    expect(await showTs({ session: false, service: true })).toEqual({
      service: [true, true],
      system: [false],
    });
    expect(await showTs({ session: true, service: false })).toEqual({
      service: [false, false],
      system: [true],
    });
  });

  test('a service that says nothing inherits the session setting', async () => {
    expect(await showTs({ session: true })).toEqual({ service: [true, true], system: [true] });
  });
});

describe('output through the formatter', () => {
  async function running(logs?: { formatter: (line: string) => unknown }) {
    const t = setup({ services: { api: logs ? { logs } : {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    return t;
  }

  test("a service's formatter renders its lines", async () => {
    const t = await running({ formatter: (line) => `<${line}>` });
    t.proc('api').line('hello');
    expect(t.said('api')).toEqual(['started', '<hello>']);
  });

  test("without one, stackctl's default formatter renders structured logs", async () => {
    const t = await running();
    t.proc('api').line('{"level":"info","msg":"listening","port":21001}');
    t.proc('api').line('plain text');
    expect(t.said('api').slice(1)).toEqual(['[INFO] listening', '  port: 21001', 'plain text']);
  });

  test('a formatter that throws, or returns no string, passes the line through', async () => {
    const t = await running({
      formatter: (line) => {
        if (line === 'throw') {
          throw new Error('bad');
        }
        return 42;
      },
    });
    t.proc('api').line('throw');
    t.proc('api').line('number');
    expect(t.said('api').slice(1)).toEqual(['throw', 'number']);
  });

  test('a line passed through is red from stderr and plain from stdout, whatever the formatter', async () => {
    await withColors(async () => {
      for (const t of [await running(), await running({ formatter: (line) => line })]) {
        t.proc('api').line('to stderr', true);
        t.proc('api').line('to stdout', false);
        const [err, out] = t.logs.getVisibleLines().slice(-2);
        expect(err).toMatchObject({ text: chalk.red('to stderr'), isError: true });
        expect(out).toMatchObject({ text: 'to stdout', isError: false });
      }
    });
  });

  test('a different result is used verbatim, colors and all', async () => {
    await withColors(async () => {
      const t = await running({ formatter: (line) => chalk.blue(line) });
      t.proc('api').line('styled', true);
      expect(t.logs.getVisibleLines().at(-1)).toMatchObject({
        text: chalk.blue('styled'),
        isError: true,
      });
    });
  });

  test('a multi-line result is one entry of lines, empty ones dropped, indented or not', async () => {
    const t = await running({ formatter: (line) => `header ${line}\n\nfirst\nsecond\n` });
    t.proc('api').line('x');
    t.supervisor.log.system.info('between');
    t.proc('api').line('y');
    expect(t.said('api').slice(1)).toEqual([
      'header x',
      'first',
      'second',
      'header y',
      'first',
      'second',
    ]);
    // The filter shows or hides the entry whole: a match on its first line shows the rest.
    t.logs.applyFilter({ text: 'header x' });
    expect(t.logs.getVisibleLines().map((l) => stripAnsi(l.text))).toEqual([
      'header x',
      'first',
      'second',
    ]);
  });

  test('a single line joins the entry before it only when it is indented', async () => {
    const t = await running();
    t.proc('api').line('Error: boom');
    t.proc('api').line('    at main (api.js:1:1)');
    t.proc('api').line('next');
    t.logs.applyFilter({ text: 'boom' });
    expect(t.logs.getVisibleLines().map((l) => stripAnsi(l.text))).toEqual([
      'Error: boom',
      '    at main (api.js:1:1)',
    ]);
  });
});

describe('an add during the first .env read', () => {
  /** A session of `api` whose `.env` file holds every read until released; `worker` is addable. */
  function held(worker: Record<string, unknown> = {}) {
    return setup({
      services: { api: {}, worker },
      selected: ['api'],
      held: 'packages/api/.env',
    });
  }

  test('a start meanwhile: one process', async () => {
    const t = held();
    t.supervisor.launchAll();
    const adding = t.supervisor.add('worker');
    await until(() => expect(t.state('worker')).toBe('pending'));
    const starting = t.supervisor.start('worker');
    t.release();
    expect(await adding).toBe('done');
    await starting;
    expect(t.of('worker')).toHaveLength(1);
    expect(t.said('worker')).toEqual(['added to the session', 'started']);
  });

  test('launchAll meanwhile: one process', async () => {
    const t = held();
    const adding = t.supervisor.add('worker');
    await until(() => expect(t.state('worker')).toBe('pending'));
    t.supervisor.launchAll();
    t.release();
    expect(await adding).toBe('done');
    await until(() => expect(t.of('api')).toHaveLength(1));
    expect(t.of('worker')).toHaveLength(1);
    expect(t.said('worker')).toEqual(['added to the session', 'started']);
  });

  test('a restart meanwhile: one process', async () => {
    const t = held();
    t.supervisor.launchAll();
    const adding = t.supervisor.add('worker');
    await until(() => expect(t.state('worker')).toBe('pending'));
    const restarting = t.supervisor.restart('worker');
    t.release();
    expect(await adding).toBe('done');
    await restarting;
    expect(t.of('worker')).toHaveLength(1);
    expect(t.said('worker')).toEqual(['added to the session', 'started', 'restarted']);
  });

  test('a stop meanwhile: none, and it stays stopped', async () => {
    const t = held();
    t.supervisor.launchAll();
    const adding = t.supervisor.add('worker');
    await until(() => expect(t.state('worker')).toBe('pending'));
    await t.supervisor.stop('worker');
    t.release();
    expect(await adding).toBe('done');
    await until(() => expect(t.of('api')).toHaveLength(1));
    expect(t.of('worker')).toHaveLength(0);
    expect(t.state('worker')).toBe('stopped');
  });

  test('before the session launches, the add starts nothing; launchAll starts what it asked for', async () => {
    const t = setup({ services: { api: {}, worker: { autostart: false } }, selected: ['api'] });
    expect(await t.supervisor.add('worker')).toBe('done');
    expect(t.procs).toHaveLength(0);
    expect(t.state('worker')).toBe('pending');
    t.supervisor.launchAll();
    expect(t.of('worker')).toHaveLength(1);
    expect(t.of('api')).toHaveLength(1);
  });
});

describe('one copy at a time', () => {
  test("a start during a stop's grace period waits for the stop, then starts one copy", async () => {
    const t = setup({ services: { api: {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    const old = t.proc('api');
    const stopping = t.supervisor.stop('api');
    const starting = t.supervisor.start('api');
    await settle();
    expect(t.of('api')).toHaveLength(1);
    expect(publicStatus(t.state('api')!)).toBe('waiting');
    old.exit({ code: null, signal: 'SIGTERM' });
    await Promise.all([stopping, starting]);
    expect(t.of('api')).toHaveLength(2);
    expect(t.state('api')).toBe('running');
    expect(t.said('api')).toEqual(['started', 'stopping...', 'stopped', 'started']);
  });

  test("a restart during a stop's grace period waits for the stop, then starts one copy", async () => {
    const t = setup({ services: { api: {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    const old = t.proc('api');
    const stopping = t.supervisor.stop('api');
    const restarting = t.supervisor.restart('api');
    // Past the restart's re-read of the .env files: only the old process's exit holds it now.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(t.of('api')).toHaveLength(1);
    expect(t.state('api')).toBe('restarting');
    old.exit({ code: null, signal: 'SIGTERM' });
    await Promise.all([stopping, restarting]);
    expect(t.of('api')).toHaveLength(2);
    expect(t.state('api')).toBe('running');
    expect(t.said('api')).toEqual(['started', 'stopping...', 'stopped', 'started', 'restarted']);
  });

  test('a stop during a restart wins: nothing starts, and the service ends stopped', async () => {
    const t = setup({ services: { api: {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    const restarting = t.supervisor.restart('api');
    let stopped = false;
    const stopping = t.supervisor.stop('api').then(() => {
      stopped = true;
    });
    expect(t.state('api')).toBe('stopped');
    await settle();
    expect(stopped).toBe(false);
    t.proc('api').exit({ code: null, signal: 'SIGTERM' });
    await Promise.all([restarting, stopping]);
    expect(t.of('api')).toHaveLength(1);
    expect(t.state('api')).toBe('stopped');
    expect(t.said('api')).toEqual(['started', 'stopping...', 'stopped']);
    // A restart asked after it is a restart of its own.
    await t.supervisor.restart('api');
    expect(t.of('api')).toHaveLength(2);
    expect(t.state('api')).toBe('running');
  });

  test('restart, stop, restart in one grace period: the last one wins, with one new copy', async () => {
    const t = setup({ services: { api: {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    const old = t.proc('api');
    const first = t.supervisor.restart('api');
    const stopping = t.supervisor.stop('api');
    const second = t.supervisor.restart('api');
    expect(second).not.toBe(first);
    await settle();
    expect(t.of('api')).toHaveLength(1);
    old.exit({ code: null, signal: 'SIGTERM' });
    await Promise.all([first, stopping, second]);
    expect(t.of('api')).toHaveLength(2);
    expect(t.state('api')).toBe('running');
    expect(t.said('api')).toEqual(['started', 'stopping...', 'stopped', 'started', 'restarted']);
  });

  test('a start a change listener makes as a stop begins waits for the old process', async () => {
    const t = setup({ services: { api: {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(1));
    const old = t.proc('api');
    let started: Promise<void> | undefined;
    t.supervisor.on('change', () => {
      if (!started && t.state('api') === 'stopped') {
        started = t.supervisor.start('api');
      }
    });
    const stopping = t.supervisor.stop('api');
    expect(started).toBeDefined();
    await settle();
    expect(t.of('api')).toHaveLength(1);
    old.exit({ code: null, signal: 'SIGTERM' });
    await Promise.all([stopping, started]);
    expect(t.of('api')).toHaveLength(2);
    expect(t.state('api')).toBe('running');
    expect(t.said('api')).toEqual(['started', 'stopping...', 'stopped', 'started']);
  });

  test('a stop while a restart re-reads the .env files cancels its start', async () => {
    const t = setup({ services: { api: { autostart: false } } });
    t.supervisor.launchAll();
    const restarting = t.supervisor.restart('api');
    expect(t.state('api')).toBe('restarting');
    await t.supervisor.stop('api');
    await restarting;
    expect(t.procs).toHaveLength(0);
    expect(t.state('api')).toBe('stopped');
    expect(t.said('api')).toEqual([]);
  });
});

describe('the .env watch', () => {
  test('rebuilt after an add to cover the new service, and closed when everything stops', async () => {
    const t = setup({ services: { api: {}, worker: {} }, selected: ['api'] });
    const mine = () => watches.filter((w) => w.dirs[0] === t.root);
    t.supervisor.launchAll();
    await until(() => expect(mine()).toHaveLength(1));
    expect(mine()[0]!.dirs).toEqual([
      t.root,
      path.join(t.root, 'packages'),
      path.join(t.root, 'packages/api'),
    ]);
    await t.supervisor.add('worker');
    expect(mine()).toHaveLength(2);
    expect(mine()[0]!.disposed).toBe(true);
    expect(mine()[1]!.dirs).toContain(path.join(t.root, 'packages/worker'));
    expect(mine()[1]!.disposed).toBe(false);
    const stopping = t.supervisor.stopAll();
    expect(mine().map((w) => w.disposed)).toEqual([true, true]);
    for (const proc of t.procs) {
      proc.exit({ code: null, signal: 'SIGTERM' });
    }
    await stopping;
  });

  test('watches each directory once, with every service at or below it', async () => {
    const t = setup({ services: { api: {}, worker: {}, tool: { dir: 'tools/tool' } } });
    const mine = () => watches.filter((w) => w.dirs[0] === t.root);
    t.supervisor.launchAll();
    await until(() => expect(mine()).toHaveLength(1));
    const at = (rel: string) => path.join(t.root, rel);
    expect(mine()[0]!.dirs.toSorted()).toEqual(
      [t.root, at('packages'), at('packages/api'), at('packages/worker'), at('tools'), at('tools/tool')].toSorted(), // oxfmt-ignore
    );
    for (const proc of t.procs) {
      proc.exit({ code: null, signal: 'SIGTERM' });
    }
    await t.supervisor.stopAll();
  });

  test('a change in a directory between restarts the services below it, and no other', async () => {
    const t = setup({ services: { api: {}, worker: {}, tool: { dir: 'tools/tool' } } });
    const mine = () => watches.filter((w) => w.dirs[0] === t.root);
    t.supervisor.launchAll();
    await until(() => expect(mine()).toHaveLength(1));
    await until(() => expect(t.of('tool')).toHaveLength(1));
    const packages = mine()[0]!.targets.find((x) => x.dir === path.join(t.root, 'packages'))!;
    packages.onChange();
    await until(() => expect(t.of('api')[0]!.stops).toBe(1));
    await until(() => expect(t.of('worker')[0]!.stops).toBe(1));
    expect(t.of('tool')[0]!.stops).toBe(0);
  });

  test('a change at the root restarts every service', async () => {
    const t = setup({ services: { api: {}, tool: { dir: 'tools/tool' } } });
    const mine = () => watches.filter((w) => w.dirs[0] === t.root);
    t.supervisor.launchAll();
    await until(() => expect(mine()).toHaveLength(1));
    await until(() => expect(t.of('tool')).toHaveLength(1));
    mine()[0]!
      .targets.find((x) => x.dir === t.root)!
      .onChange();
    await until(() => expect(t.of('api')[0]!.stops).toBe(1));
    await until(() => expect(t.of('tool')[0]!.stops).toBe(1));
  });

  test('editing the .env of a directory between restarts the services below it', async () => {
    const t = setup({ services: { api: {}, worker: {} } });
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    await until(() => expect(t.of('worker')).toHaveLength(1));
    const stopped = () => t.of('api')[0]!.stops > 0 && t.of('worker')[0]!.stops > 0;
    for (let attempt = 1; attempt <= 8 && !stopped(); attempt++) {
      fs.writeFileSync(path.join(t.root, 'packages/.env'), `GREETING=edit-${attempt}\n`);
      for (let waited = 0; waited < 2000 && !stopped(); waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(t.of('api')[0]!.stops).toBe(1);
    expect(t.of('worker')[0]!.stops).toBe(1);
  }, 30_000);

  test('a change to a file only one service looks for restarts that service alone', async () => {
    const t = setup({
      services: {
        api: { env: { additionalFiles: [{ file: '.env.api', after: '.env' }] } },
        web: {},
      },
    });
    const mine = () => watches.filter((w) => w.dirs.includes(t.root));
    t.supervisor.launchAll();
    await until(() => expect(mine()).toHaveLength(1));
    await until(() => expect(t.of('api')).toHaveLength(1));
    await until(() => expect(t.of('web')).toHaveLength(1));
    const atRoot = mine()[0]!.targets.filter((x) => x.dir === t.root);
    // One target for api, which looks for `.env.api` too, and one for web, which doesn't.
    expect(atRoot).toHaveLength(2);
    expect(atRoot.filter((x) => x.filenames.includes('.env.api'))).toHaveLength(1);
    atRoot.find((x) => x.filenames.includes('.env.api'))!.onChange();
    await until(() => expect(t.of('api')[0]!.stops).toBe(1));
    expect(t.of('web')[0]!.stops).toBe(0);
  });

  test("reports one change for a directory's targets firing together, with all their services", async () => {
    const t = setup({
      services: {
        api: { env: { additionalFiles: [{ file: '.env.api', after: '.env' }] } },
        web: {},
      },
    });
    const events: [string, string[]][] = [];
    t.supervisor.on('env-change', (dir, services) => events.push([dir, services]));
    const mine = () => watches.filter((w) => w.dirs.includes(t.root));
    t.supervisor.launchAll();
    await until(() => expect(mine()).toHaveLength(1));
    await until(() => expect(t.of('api')).toHaveLength(1));
    await until(() => expect(t.of('web')).toHaveLength(1));
    for (const target of mine()[0]!.targets.filter((x) => x.dir === t.root)) {
      target.onChange();
    }
    await until(() => expect(events).toHaveLength(1));
    expect(events[0]![0]).toBe('.');
    expect(events[0]![1].toSorted()).toEqual(['api', 'web']);
    await until(() => expect(t.of('api')[0]!.stops).toBe(1));
    await until(() => expect(t.of('web')[0]!.stops).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toHaveLength(1);
  });

  test('editing a file only one service looks for restarts that service alone', async () => {
    const t = setup({
      services: {
        api: { env: { additionalFiles: [{ file: '.env.api', after: '.env' }] } },
        web: {},
      },
      files: { '.env.api': 'A=0\n' },
    });
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    await until(() => expect(t.of('web')).toHaveLength(1));
    const stopped = () => t.of('api')[0]!.stops > 0;
    for (let attempt = 1; attempt <= 8 && !stopped(); attempt++) {
      fs.writeFileSync(path.join(t.root, '.env.api'), `A=${attempt}\n`);
      for (let waited = 0; waited < 2000 && !stopped(); waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(t.of('api')[0]!.stops).toBe(1);
    expect(t.of('web')[0]!.stops).toBe(0);
  }, 30_000);

  test('a change in a directory between restarts a service with its new values', async () => {
    const t = setup({ services: { api: {} }, files: { 'packages/.env': 'MID=before\n' } });
    const mine = () => watches.filter((w) => w.dirs[0] === t.root);
    t.supervisor.launchAll();
    await until(() => expect(mine()).toHaveLength(1));
    await until(() => expect(t.of('api')).toHaveLength(1));
    expect(t.proc('api').opts.env.MID).toBe('before');
    fs.writeFileSync(path.join(t.root, 'packages/.env'), 'MID=after\n');
    mine()[0]!
      .targets.find((x) => x.dir === path.join(t.root, 'packages'))!
      .onChange();
    await until(() => expect(t.of('api')[0]!.stops).toBe(1));
    t.of('api')[0]!.exit({ code: null, signal: 'SIGTERM' });
    await until(() => expect(t.of('api')).toHaveLength(2));
    expect(t.of('api')[1]!.opts.env.MID).toBe('after');
  });

  test("editing an added service's .env file restarts it", async () => {
    const t = setup({ services: { api: {}, worker: {} }, selected: ['api'] });
    t.supervisor.launchAll();
    await t.supervisor.add('worker');
    await until(() => expect(t.of('worker')).toHaveLength(1));
    const stopped = () => t.of('worker')[0]!.stops > 0;
    for (let attempt = 1; attempt <= 8 && !stopped(); attempt++) {
      fs.writeFileSync(path.join(t.root, 'packages/worker/.env'), `GREETING=edit-${attempt}\n`);
      for (let waited = 0; waited < 2000 && !stopped(); waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(t.of('worker')[0]!.stops).toBe(1);
    expect(t.said('worker')).toContain('.env changed, restarting...');
    expect(t.of('api')[0]!.stops).toBe(0);
  }, 30_000);

  test('with env.decrypt, decrypts with .env.keys, and editing it restarts every service', async () => {
    const { publicKey, privateKey } = primitives.keypair();
    const t = setup({
      services: { api: {}, worker: {} },
      decrypt: true,
      files: {
        '.env': `SECRET="${primitives.encrypt(publicKey, 's3cret')}"\n`,
        '.env.keys': `DOTENV_PRIVATE_KEY="${privateKey}"\n`,
      },
    });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(2));
    expect(t.procs.map((proc) => proc.opts.env.SECRET)).toEqual(['s3cret', 's3cret']);
    const stopped = () => t.procs.every((proc) => proc.stops > 0);
    for (let attempt = 1; attempt <= 8 && !stopped(); attempt++) {
      fs.writeFileSync(
        path.join(t.root, '.env.keys'),
        `DOTENV_PRIVATE_KEY="${privateKey}"\n# ${attempt}\n`,
      );
      for (let waited = 0; waited < 2000 && !stopped(); waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(t.of('api')[0]!.stops).toBe(1);
    expect(t.of('worker')[0]!.stops).toBe(1);
  }, 30_000);
});

describe('stackctl-made lines', () => {
  test("a spawn's failure reason skips the service's formatter", async () => {
    const t = setup({
      services: { api: { logs: { formatter: (line: string) => `<${line}>` } } },
      failSpawn: ['api'],
    });
    t.supervisor.launchAll();
    await until(() => expect(t.state('api')).toBe('crashed'));
    expect(t.said('api')).toEqual([
      'started',
      'failed to start: spawn /bin/sh ENOENT',
      'exited with code 1',
    ]);
  });

  test("a one-off whose environment can't be built is framed like any other", async () => {
    const t = setup({ services: { api: {} } });
    Object.defineProperty(t.plan, 'envVars', {
      get() {
        throw new Error('vars broke');
      },
    });
    await t.supervisor.runOneOff('api', 'lint');
    expect(t.said('api')).toEqual([
      '▶ running: lint',
      'failed to start: vars broke',
      '✘ lint exited with code 1',
    ]);
    expect(t.procs).toHaveLength(0);
  });

  test('stopping everything removes its readiness listeners', async () => {
    const t = setup({ services: { api: {} } });
    expect(t.readiness.listenerCount('ready')).toBe(1);
    expect(t.readiness.listenerCount('unready')).toBe(1);
    await t.supervisor.stopAll();
    expect(t.readiness.listenerCount('ready')).toBe(0);
    expect(t.readiness.listenerCount('unready')).toBe(0);
  });
});

describe("an add while it reads the added service's own .env files", () => {
  /**
   * A session of `api` (launched when `launch`) whose first read is done; `worker`'s own `.env`
   * file, which only an add reads, holds every read until released and then reads `HELD=1`.
   */
  async function held(launch: boolean) {
    const t = setup({
      services: { api: {}, worker: {} },
      selected: ['api'],
      held: 'packages/worker/.env',
    });
    const watched = () => watches.some((w) => w.dirs[0] === t.root);
    if (launch) {
      t.supervisor.launchAll();
    }
    // The watch opens once the first read is done.
    await until(() => expect(watched()).toBe(true));
    return t;
  }

  test("a start meanwhile waits for the read, and spawns with the service's .env values", async () => {
    const t = await held(true);
    const adding = t.supervisor.add('worker');
    await until(() => expect(t.state('worker')).toBe('pending'));
    const starting = t.supervisor.start('worker');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(t.of('worker')).toHaveLength(0);
    t.release();
    expect(await adding).toBe('done');
    await starting;
    expect(t.of('worker')).toHaveLength(1);
    expect(t.proc('worker').opts.env.HELD).toBe('1');
    expect(t.said('worker')).toEqual(['added to the session', 'started']);
  });

  test("launchAll meanwhile waits for the read, and spawns with the service's .env values", async () => {
    const t = await held(false);
    const adding = t.supervisor.add('worker');
    await until(() => expect(t.state('worker')).toBe('pending'));
    t.supervisor.launchAll();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(t.of('worker')).toHaveLength(0);
    expect(t.of('api')).toHaveLength(1);
    t.release();
    expect(await adding).toBe('done');
    await until(() => expect(t.of('worker')).toHaveLength(1));
    expect(t.proc('worker').opts.env.HELD).toBe('1');
  });
});

/** A hook call as the stub records it. */
interface HookCall {
  name: string;
  hook: keyof ServiceCallbacks;
  trigger: string;
  data: Record<string, unknown>;
}

/**
 * A {@link ServiceHooks} every service has `beforeStart` and `afterStart` in, recording each call
 * as `name:hook:trigger` into `events` (which `setup` also gets each spawn in), and
 * `name:hook:abandoned` when a start hook is abandoned while it runs. `impl` decides how a call ends:
 * `'done'` unless it says otherwise. The commands of a service's hooks have ended unless
 * `commands` holds a promise for it.
 */
function recordingHooks(
  impl: (call: HookCall) => HookOutcome | void | Promise<HookOutcome | void> = () => {},
  /** The hooks every service has. */
  defined: readonly string[] = ['beforeStart', 'afterStart'],
) {
  const events: string[] = [];
  const calls: HookCall[] = [];
  const commands = new Map<string, Promise<void>>();
  const hooks: ServiceHooks = {
    has: (_name, hook) => defined.includes(hook),
    // The real runner's rule, so the fake abandons (and skips a hook whose budget is spent) as
    // production does: only a hook that is called is recorded.
    run: async (name, hook, trigger, data, budget) => {
      let own: HookOutcome = 'done';
      let running = false;
      const abandoned = () => {
        // A start hook's only: the stop hooks' abandonment is asserted through their lines.
        if (running && !hook.endsWith('Stop')) {
          events.push(`${name}:${hook}:abandoned`);
        }
      };
      budget?.addEventListener('abort', abandoned, { once: true });
      const outcome = await runHook(
        async () => {
          const call = { name, hook, trigger, data };
          events.push(`${name}:${hook}:${trigger}`);
          calls.push(call);
          running = true;
          try {
            own = (await impl(call)) ?? 'done';
          } finally {
            running = false;
          }
        },
        undefined,
        { budget },
      );
      budget?.removeEventListener('abort', abandoned);
      return outcome === 'done' ? own : outcome;
    },
    commandsEnded: (name) => commands.get(name) ?? Promise.resolve(),
  };
  return { hooks, events, calls, commands };
}

/** A promise the test resolves when it likes. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('start hooks', () => {
  test("beforeStart runs before the spawn, afterStart after it, with the start's trigger", async () => {
    const r = recordingHooks();
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() =>
      expect(r.events).toEqual(['api:beforeStart:session', 'spawn api', 'api:afterStart:session']),
    );

    r.events.length = 0;
    const stopping = t.supervisor.stop('api');
    t.proc('api').exit({ code: null, signal: 'SIGTERM' });
    await stopping;
    await t.supervisor.start('api');
    expect(r.events).toEqual(['api:beforeStart:start', 'spawn api', 'api:afterStart:start']);

    r.events.length = 0;
    let old = t.proc('api');
    const restarting = t.supervisor.restart('api');
    old.exit({ code: null, signal: 'SIGTERM' });
    await restarting;
    expect(r.events).toEqual(['api:beforeStart:restart', 'spawn api', 'api:afterStart:restart']);

    r.events.length = 0;
    old = t.proc('api');
    const changed = t.supervisor.envChanged('api');
    old.exit({ code: null, signal: 'SIGTERM' });
    await changed;
    expect(r.events).toEqual(['api:beforeStart:env', 'spawn api', 'api:afterStart:env']);
    expect(t.state('api')).toBe('running');
  });

  test('a service added to a running session starts with the trigger start', async () => {
    const r = recordingHooks();
    const t = setup({
      services: { api: {}, worker: {} },
      selected: ['api'],
      hooks: r.hooks,
      events: r.events,
    });
    t.supervisor.launchAll();
    await until(() => expect(r.events).toHaveLength(3));
    expect(await t.supervisor.add('worker')).toBe('done');
    await until(() =>
      expect(r.events.slice(3)).toEqual([
        'worker:beforeStart:start',
        'spawn worker',
        'worker:afterStart:start',
      ]),
    );
  });

  test('one data object for an operation, a new one for the next', async () => {
    const r = recordingHooks();
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(r.calls).toHaveLength(2));
    for (let i = 0; i < 2; i++) {
      const old = t.proc('api');
      const restarting = t.supervisor.restart('api');
      old.exit({ code: null, signal: 'SIGTERM' });
      await restarting;
    }
    const [, , first, firstAfter, second, secondAfter] = r.calls;
    expect(first!.trigger).toBe('restart');
    expect(firstAfter!.data).toBe(first!.data);
    expect(secondAfter!.data).toBe(second!.data);
    expect(second!.data).not.toBe(first!.data);
  });

  test("launchAll's data reaches every service it launches, one that waited for a dep included", async () => {
    const r = recordingHooks();
    const t = setup({
      services: { db: { healthcheck: HC }, api: { deps: [{ service: 'db', wait: true }] } },
      hooks: r.hooks,
      events: r.events,
    });
    const data = { from: 'session' };
    t.supervisor.launchAll(data);
    await until(() => expect(t.of('db')).toHaveLength(1));
    t.answers.set('db', true);
    await t.clock.advance(1600);
    await until(() => expect(r.calls).toHaveLength(4));
    expect(r.calls.map((c) => `${c.name}:${c.hook}`)).toEqual([
      'db:beforeStart',
      'db:afterStart',
      'api:beforeStart',
      'api:afterStart',
    ]);
    for (const call of r.calls) {
      expect(call.data).toBe(data);
      expect(call.trigger).toBe('session');
    }
  });

  test('a beforeStart that throws spawns nothing: the service is stopped with the reason, and no exit is reported for a process that never ran', async () => {
    const r = recordingHooks(({ hook }) =>
      hook === 'beforeStart' ? { error: 'boom' } : undefined,
    );
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    const exits: unknown[] = [];
    t.supervisor.on('exit', (...args) => exits.push(args));
    t.supervisor.launchAll();
    await until(() => expect(t.state('api')).toBe('crashed'));
    expect(r.events).toEqual(['api:beforeStart:session']);
    expect(t.of('api')).toHaveLength(0);
    expect(t.said('api')).toEqual(['failed to start: beforeStart failed: boom']);
    expect(t.logs.getVisibleLines().find((l) => l.service === 'api')!.isError).toBe(true);
    expect(publicStatus(t.state('api')!)).toBe('stopped');
    expect(t.supervisor.failure('api')).toBe('beforeStart failed: boom');
    expect(t.supervisor.states().get('api')!.exitCode).toBeNull();
    expect(exits).toEqual([]);
  });

  test('the reason a beforeStart left is gone once the service is started again, and it gets ready', async () => {
    let fails = true;
    const r = recordingHooks(({ hook }) => (hook === 'beforeStart' && fails ? { error: 'boom' } : undefined)); // oxfmt-ignore
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(t.supervisor.failure('api')).toBe('beforeStart failed: boom'));
    fails = false;
    await t.supervisor.restart('api');
    expect(t.supervisor.failure('api')).toBeNull();
    expect(t.state('api')).toBe('running');
    await until(() => expect(t.readiness.isReady('api')).toBe(true));
  });

  test.each([
    { screen: 'with no screen', interactive: false, how: 'Run stackctl service restart -s db once it is fixed; a change to stackctl.config.ts needs a new session' }, // oxfmt-ignore
    { screen: 'on the terminal UI', interactive: true, how: 'Once it is fixed, focus db and press r, or run stackctl service restart -s db; a change to stackctl.config.ts needs a new session' }, // oxfmt-ignore
  ])(
    'what waits on a service whose beforeStart failed is told why, and is blocked by it through a chain, $screen',
    async ({ interactive, how }) => {
      const r = recordingHooks(({ name, hook }) => (name === 'db' && hook === 'beforeStart' ? { error: 'boom' } : undefined)); // oxfmt-ignore
      const t = setup({
        services: {
          db: { healthcheck: HC },
          api: { healthcheck: HC, deps: [{ service: 'db', wait: true }] },
          web: { deps: [{ service: 'api', wait: true }] },
        },
        hooks: r.hooks,
        events: r.events,
        interactive,
      });
      t.supervisor.launchAll();
      await until(() => expect(t.supervisor.failure('db')).toBe('beforeStart failed: boom'));
      expect(t.state('api')).toBe('waiting');
      expect(t.said('api').at(-1)).toBe(`db failed to start: beforeStart failed: boom; still waiting for db. ${how}`); // oxfmt-ignore
      const advice = 'Run stackctl service restart -s db once it is fixed; a change to stackctl.config.ts needs a new session'; // oxfmt-ignore
      expect(t.supervisor.blockedBy('api')).toBe(`waiting for db, which failed to start: beforeStart failed: boom. ${advice}`); // oxfmt-ignore
      expect(t.supervisor.blockedBy('web')).toBe(`waiting for api, which waits for db, which failed to start: beforeStart failed: boom. ${advice}`); // oxfmt-ignore
      // The services never started: nothing was spawned.
      expect(t.procs).toHaveLength(0);
    },
  );

  test('an afterStart that throws fails the service and leaves its process running', async () => {
    const r = recordingHooks(({ hook }) => (hook === 'afterStart' ? { error: 'boom' } : undefined));
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(t.state('api')).toBe('failed'));
    expect(t.of('api')).toHaveLength(1);
    expect(t.proc('api').stops).toBe(0);
    expect(t.proc('api').state).toBe('running');
    expect(t.supervisor.states().get('api')!.pid).toBe(t.proc('api').pid);
    expect(t.supervisor.states().get('api')!.ready).toBe(false);
    expect(t.said('api')).toEqual(['started', 'afterStart failed: boom']);
    const failure = t.logs.getVisibleLines().filter((l) => l.service === 'api')[1]!;
    expect(failure.isError).toBe(true);
  });

  test('a stop while beforeStart runs starts nothing; a restart while it runs starts once', async () => {
    {
      const held = gate();
      const r = recordingHooks(({ hook }) => (hook === 'beforeStart' ? held.promise : undefined));
      const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
      t.supervisor.launchAll();
      await until(() => expect(r.events).toEqual(['api:beforeStart:session']));
      expect(t.state('api')).toBe('pending');
      await t.supervisor.stop('api');
      expect(t.state('api')).toBe('stopped');
      held.open();
      await settle();
      expect(t.of('api')).toHaveLength(0);
      expect(t.state('api')).toBe('stopped');
      expect(r.events).toEqual(['api:beforeStart:session', 'api:beforeStart:abandoned']);
    }
    {
      const held = gate();
      const r = recordingHooks(({ hook, trigger }) =>
        hook === 'beforeStart' && trigger === 'session' ? held.promise : undefined,
      );
      const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
      t.supervisor.launchAll();
      await until(() => expect(r.events).toEqual(['api:beforeStart:session']));
      await t.supervisor.restart('api');
      held.open();
      await settle();
      expect(t.of('api')).toHaveLength(1);
      expect(t.state('api')).toBe('running');
      expect(r.events).toEqual([
        'api:beforeStart:session',
        'api:beforeStart:abandoned',
        'api:beforeStart:restart',
        'spawn api',
        'api:afterStart:restart',
      ]);
    }
  });

  test('a .env change while a restart runs afterStart restarts the service again', async () => {
    const held = gate();
    const r = recordingHooks(({ hook, trigger }) =>
      hook === 'afterStart' && trigger === 'restart' ? held.promise : undefined,
    );
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(r.events).toHaveLength(3));
    const first = t.proc('api');
    const restarting = t.supervisor.restart('api');
    first.exit({ code: null, signal: 'SIGTERM' });
    await until(() => expect(r.events.at(-1)).toBe('api:afterStart:restart'));
    const second = t.proc('api');
    const changed = t.supervisor.envChanged('api');
    expect(changed).not.toBe(restarting);
    second.exit({ code: null, signal: 'SIGTERM' });
    held.open();
    await Promise.all([restarting, changed]);
    expect(t.of('api')).toHaveLength(3);
    expect(r.events.slice(3)).toEqual([
      'api:beforeStart:restart',
      'spawn api',
      'api:afterStart:restart',
      'api:afterStart:abandoned',
      'api:beforeStart:env',
      'spawn api',
      'api:afterStart:env',
    ]);
    expect(t.state('api')).toBe('running');
  });

  test('a shutdown while beforeStart runs starts nothing, and runs no hook after it', async () => {
    const held = gate();
    const r = recordingHooks(({ hook }) => (hook === 'beforeStart' ? held.promise : undefined));
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(r.events).toEqual(['api:beforeStart:session']));
    await t.supervisor.stopAll();
    held.open();
    await settle();
    expect(t.of('api')).toHaveLength(0);
    expect(t.state('api')).toBe('stopped');
    expect(r.events).toEqual(['api:beforeStart:session', 'api:beforeStart:abandoned']);
  });

  test('a shutdown at any moment around the end of beforeStart leaves no process behind', async () => {
    // However many microtasks after the hook was called the shutdown lands, a process is either
    // never spawned, or spawned before it and stopped by it.
    for (let depth = 0; depth < 12; depth++) {
      let stop = () => {};
      const r = recordingHooks(({ hook }) => {
        if (hook === 'beforeStart') {
          let chain = Promise.resolve();
          for (let i = 0; i < depth; i++) {
            chain = chain.then(() => {});
          }
          void chain.then(() => stop());
        }
      });
      const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
      stop = () => void t.supervisor.stopAll();
      t.supervisor.launchAll();
      await until(() => expect(r.events).toContain('api:beforeStart:session'));
      await settle();
      const unstopped = t.of('api').filter((p) => p.stops === 0 && p.kills === 0);
      expect({ depth, unstopped: unstopped.length }).toEqual({ depth, unstopped: 0 });
    }
  });

  test("a stop while a restart's beforeStart runs starts nothing, and logs no restarted", async () => {
    const held = gate();
    const r = recordingHooks(({ hook, trigger }) =>
      hook === 'beforeStart' && trigger === 'restart' ? held.promise : undefined,
    );
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(r.events).toHaveLength(3));
    const old = t.proc('api');
    const restarting = t.supervisor.restart('api');
    old.exit({ code: null, signal: 'SIGTERM' });
    await until(() => expect(r.events.at(-1)).toBe('api:beforeStart:restart'));
    expect(t.state('api')).toBe('restarting');
    await t.supervisor.stop('api');
    expect(t.state('api')).toBe('stopped');
    held.open();
    await restarting;
    expect(t.of('api')).toHaveLength(1);
    expect(t.state('api')).toBe('stopped');
    expect(t.said('api')).toEqual([
      'started',
      'stopping...',
      'stopped',
      'beforeStart abandoned: the service was stopped',
    ]);
  });

  test("a restart's beforeStart that throws ends it as a failed start, with no restarted line", async () => {
    const r = recordingHooks(({ hook, trigger }) =>
      hook === 'beforeStart' && trigger === 'restart' ? { error: 'boom' } : undefined,
    );
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    const exits: unknown[] = [];
    t.supervisor.on('exit', (...args) => exits.push(args));
    t.supervisor.launchAll();
    await until(() => expect(r.events).toHaveLength(3));
    const old = t.proc('api');
    const restarting = t.supervisor.restart('api');
    old.exit({ code: null, signal: 'SIGTERM' });
    await restarting;
    expect(t.state('api')).toBe('crashed');
    expect(t.of('api')).toHaveLength(1);
    expect(t.said('api')).toEqual([
      'started',
      'stopping...',
      'stopped',
      'failed to start: beforeStart failed: boom',
    ]);
    expect(t.supervisor.failure('api')).toBe('beforeStart failed: boom');
    expect(exits).toEqual([]);
  });

  test('a .env change restarts a failed service whose process still runs', async () => {
    const r = recordingHooks(({ hook, trigger }) =>
      hook === 'afterStart' && trigger === 'session' ? { error: 'boom' } : undefined,
    );
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(t.state('api')).toBe('failed'));
    const old = t.proc('api');
    const changed = t.supervisor.envChanged('api');
    old.exit({ code: null, signal: 'SIGTERM' });
    await changed;
    expect(t.of('api')).toHaveLength(2);
    expect(r.events.slice(-3)).toEqual(['api:beforeStart:env', 'spawn api', 'api:afterStart:env']);
    expect(t.state('api')).toBe('running');
  });

  test('an edit to the .env file of a failed service whose process runs restarts it', async () => {
    const r = recordingHooks(({ hook, trigger }) =>
      hook === 'afterStart' && trigger === 'session' ? { error: 'boom' } : undefined,
    );
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    const reported: string[][] = [];
    t.supervisor.on('env-change', (_dir, services) => reported.push(services));
    t.supervisor.launchAll();
    await until(() => expect(t.state('api')).toBe('failed'));
    await until(() => expect(watches.some((w) => w.dirs.includes(t.root))).toBe(true));
    const stopped = () => t.of('api')[0]!.stops > 0;
    for (let attempt = 1; attempt <= 8 && !stopped(); attempt++) {
      fs.writeFileSync(path.join(t.root, 'packages/api/.env'), `GREETING=edit-${attempt}\n`);
      for (let waited = 0; waited < 2000 && !stopped(); waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(t.of('api')[0]!.stops).toBe(1);
    expect(reported.at(-1)).toEqual(['api']);
    t.of('api')[0]!.exit({ code: null, signal: 'SIGTERM' });
    await until(() => expect(t.state('api')).toBe('running'));
  }, 30_000);

  test('one add that brings in several services is one operation: they share one data', async () => {
    const r = recordingHooks();
    const t = setup({
      services: { api: {}, db: {}, worker: { deps: [{ service: 'db' }] } },
      selected: ['api'],
      hooks: r.hooks,
      events: r.events,
    });
    t.supervisor.launchAll();
    await until(() => expect(r.calls).toHaveLength(2));
    expect(await t.supervisor.add('worker')).toBe('done');
    await until(() => expect(r.calls).toHaveLength(6));
    const added = r.calls.slice(2);
    expect(added.map((c) => `${c.name}:${c.hook}:${c.trigger}`).sort()).toEqual([
      'db:afterStart:start',
      'db:beforeStart:start',
      'worker:afterStart:start',
      'worker:beforeStart:start',
    ]);
    for (const call of added) {
      expect(call.data).toBe(added[0]!.data);
    }
    expect(added[0]!.data).not.toBe(r.calls[0]!.data);
  });

  test("a hook's lines go under its service's label, red when they are errors", async () => {
    const t = setup({ services: { api: {} } });
    await withColors(() => {
      t.supervisor.hookLine('api', 'seeding', false);
      t.supervisor.hookLine('api', 'seed failed', true);
      t.supervisor.hookLine('nope', 'lost', false);
    });
    const lines = t.logs.getVisibleLines();
    expect(lines.map((l) => [l.service, stripAnsi(l.text), l.isError])).toEqual([
      ['api', 'seeding', false],
      ['api', 'seed failed', true],
    ]);
    expect(lines[1]!.text).not.toBe('seed failed');
  });

  test('a service with no dev command, or autostart false, runs no hook until it is started', async () => {
    const r = recordingHooks();
    const t = setup({
      services: { api: { autostart: false }, lib: {} },
      noDev: ['lib'],
      hooks: r.hooks,
      events: r.events,
    });
    t.supervisor.launchAll();
    await until(() => expect(t.state('api')).toBe('stopped'));
    expect(t.state('lib')).toBe('stopped');
    await t.supervisor.start('lib');
    await t.supervisor.restart('lib');
    expect(r.events).toEqual([]);
    await t.supervisor.start('api');
    expect(r.events).toEqual(['api:beforeStart:start', 'spawn api', 'api:afterStart:start']);
  });
});

describe('afterReady, and ready including the hooks', () => {
  const ALL = ['beforeStart', 'afterStart', 'afterReady'];

  test('afterReady runs once the healthcheck first passes, after afterStart, and the service is ready only when it has finished', async () => {
    const held = gate();
    const r = recordingHooks(
      ({ hook }) => (hook === 'afterReady' ? held.promise.then(() => undefined) : undefined),
      ALL,
    );
    const t = setup({ services: { api: { healthcheck: HC } }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() =>
      expect(r.events).toEqual(['api:beforeStart:session', 'spawn api', 'api:afterStart:session']),
    );
    await t.clock.advance(1000);
    expect(r.events).toHaveLength(3);
    t.answers.set('api', true);
    await t.clock.advance(2000);
    await until(() => expect(r.events.at(-1)).toBe('api:afterReady:session'));
    expect(t.readiness.isHealthy('api')).toBe(true);
    expect(t.readiness.isReady('api')).toBe(false);
    expect(t.supervisor.states().get('api')!.ready).toBe(false);
    held.open();
    await until(() => expect(t.readiness.isReady('api')).toBe(true));
    expect(t.supervisor.states().get('api')!.ready).toBe(true);
    expect(t.state('api')).toBe('running');
  });

  test('with no healthcheck, afterReady runs after afterStart', async () => {
    const held = gate();
    const r = recordingHooks(
      ({ hook }) => (hook === 'afterStart' ? held.promise.then(() => undefined) : undefined),
      ALL,
    );
    const t = setup({ services: { worker: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(r.events.at(-1)).toBe('worker:afterStart:session'));
    // Healthy since its spawn, but its afterStart still runs: nothing more, and not ready.
    expect(t.readiness.isHealthy('worker')).toBe(true);
    expect(t.readiness.isReady('worker')).toBe(false);
    await t.clock.advance(1000);
    expect(r.events.at(-1)).toBe('worker:afterStart:session');
    held.open();
    await until(() => expect(t.readiness.isReady('worker')).toBe(true));
    expect(r.events).toEqual([
      'worker:beforeStart:session',
      'spawn worker',
      'worker:afterStart:session',
      'worker:afterReady:session',
    ]);
  });

  test('with only an afterStart, the service is ready once it has finished', async () => {
    const held = gate();
    const r = recordingHooks(
      ({ hook }) => (hook === 'afterStart' ? held.promise.then(() => undefined) : undefined),
      ['afterStart'],
    );
    const t = setup({ services: { worker: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(r.events).toEqual(['spawn worker', 'worker:afterStart:session']));
    expect(t.readiness.isReady('worker')).toBe(false);
    held.open();
    await until(() => expect(t.readiness.isReady('worker')).toBe(true));
    expect(r.events).toHaveLength(2);
  });

  test('a service with no hook after its spawn is ready on its health alone, as before', async () => {
    const r = recordingHooks(() => undefined, ['beforeStart']);
    const t = setup({ services: { worker: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(r.events).toEqual(['worker:beforeStart:session', 'spawn worker']));
    expect(t.readiness.isReady('worker')).toBe(true);
  });

  test("a dependent waits for the dependency's afterReady", async () => {
    const held = gate();
    const r = recordingHooks(
      ({ name, hook }) =>
        name === 'api' && hook === 'afterReady' ? held.promise.then(() => undefined) : undefined,
      ALL,
    );
    const t = setup({
      services: {
        api: { healthcheck: HC },
        web: { deps: [{ service: 'api', wait: true }] },
      },
      hooks: r.hooks,
      events: r.events,
    });
    t.answers.set('api', true);
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    await t.clock.advance(2000);
    await until(() => expect(r.events.at(-1)).toBe('api:afterReady:session'));
    await t.clock.advance(5000);
    expect(t.state('web')).toBe('waiting');
    expect(r.events).not.toContain('spawn web');
    held.open();
    await until(() => expect(r.events).toContain('spawn web'));
    expect(r.events.indexOf('web:beforeStart:session')).toBeGreaterThan(
      r.events.indexOf('api:afterReady:session'),
    );
  });

  test('an afterReady that throws fails the service, keeps its process, and its dependents stay waiting with the reason', async () => {
    const r = recordingHooks(
      ({ name, hook }) => (name === 'api' && hook === 'afterReady' ? { error: 'boom' } : undefined),
      ALL,
    );
    const t = setup({
      services: {
        api: { healthcheck: HC },
        web: { deps: [{ service: 'api', wait: true }] },
      },
      hooks: r.hooks,
      events: r.events,
    });
    t.answers.set('api', true);
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    await t.clock.advance(2000);
    await until(() => expect(t.state('api')).toBe('failed'));
    await t.clock.advance(5000);
    expect(t.of('api')).toHaveLength(1);
    expect(t.proc('api').stops).toBe(0);
    expect(t.supervisor.states().get('api')!.pid).toBe(t.proc('api').pid);
    expect(t.supervisor.states().get('api')!.ready).toBe(false);
    expect(t.readiness.isHealthy('api')).toBe(true);
    expect(t.readiness.isReady('api')).toBe(false);
    expect(t.said('api')).toEqual(['started', 'afterReady failed: boom']);
    expect(t.logs.getVisibleLines().filter((l) => l.service === 'api')[1]!.isError).toBe(true);
    expect(t.supervisor.failure('api')).toBe('afterReady failed: boom');

    expect(t.state('web')).toBe('waiting');
    expect(t.of('web')).toHaveLength(0);
    expect(t.said('web').some((line) => line.includes('api failed: afterReady failed: boom'))).toBe(
      true,
    );
    expect(t.supervisor.blockedBy('web')).toBe(
      'waiting for api, which failed: afterReady failed: boom. Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session',
    );
    expect(t.supervisor.blockedBy('api')).toBeNull();
  });

  test('a service waiting on a service that waits on a failed one is blocked by the failed one', async () => {
    const r = recordingHooks(
      ({ name, hook }) => (name === 'db' && hook === 'afterReady' ? { error: 'boom' } : undefined),
      ALL,
    );
    const t = setup({
      services: {
        db: { healthcheck: HC },
        api: { healthcheck: HC, deps: [{ service: 'db', wait: true }] },
        web: { healthcheck: HC, deps: [{ service: 'api', wait: true }] },
        admin: { deps: [{ service: 'web', wait: true }] },
      },
      selected: ['db', 'api', 'web'],
      hooks: r.hooks,
      events: r.events,
    });
    t.answers.set('db', true);
    t.supervisor.launchAll();
    await until(() => expect(t.of('db')).toHaveLength(1));
    await t.clock.advance(200);
    await until(() => expect(t.state('db')).toBe('failed'));
    expect(t.state('api')).toBe('waiting');
    expect(t.state('web')).toBe('waiting');
    expect(t.supervisor.blockedBy('api')).toBe(
      'waiting for db, which failed: afterReady failed: boom. Run stackctl service restart -s db once it is fixed; a change to stackctl.config.ts needs a new session',
    );
    expect(t.supervisor.blockedBy('web')).toBe(
      'waiting for api, which waits for db, which failed: afterReady failed: boom. Run stackctl service restart -s db once it is fixed; a change to stackctl.config.ts needs a new session',
    );
    // One more level: each service in between is named.
    expect(await t.supervisor.add('admin')).toBe('done');
    await until(() => expect(t.state('admin')).toBe('waiting'));
    expect(t.supervisor.blockedBy('admin')).toBe(
      'waiting for web, which waits for api, which waits for db, which failed: afterReady failed: boom. Run stackctl service restart -s db once it is fixed; a change to stackctl.config.ts needs a new session',
    );
  });

  test('a service waiting on two failed services gives a sentence for each, each starting with a capital but the first', async () => {
    const r = recordingHooks(
      ({ name, hook }) => (name !== 'web' && hook === 'afterStart' ? { error: `${name} broke` } : undefined), // oxfmt-ignore
      ALL,
    );
    const t = setup({
      services: {
        api: { healthcheck: HC },
        worker: { healthcheck: HC },
        web: {
          deps: [
            { service: 'api', wait: true },
            { service: 'worker', wait: true },
          ],
        },
      },
      hooks: r.hooks,
      events: r.events,
    });
    t.supervisor.launchAll();
    await until(() => expect(t.state('worker')).toBe('failed'));
    await until(() => expect(t.state('api')).toBe('failed'));
    expect(t.supervisor.blockedBy('web')).toBe(
      'waiting for api, which failed: afterStart failed: api broke. Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session. ' +
        'Waiting for worker, which failed: afterStart failed: worker broke. Run stackctl service restart -s worker once it is fixed; a change to stackctl.config.ts needs a new session',
    );
  });

  test('afterReady runs once per start: health lost and regained runs it no second time', async () => {
    const r = recordingHooks(() => undefined, ALL);
    const t = setup({ services: { api: { healthcheck: HC } }, hooks: r.hooks, events: r.events });
    t.answers.set('api', true);
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    await t.clock.advance(200);
    await until(() => expect(t.readiness.isReady('api')).toBe(true));
    t.answers.set('api', false);
    await t.clock.advance(2000);
    expect(t.readiness.isReady('api')).toBe(false);
    t.answers.set('api', true);
    await t.clock.advance(2000);
    expect(t.readiness.isReady('api')).toBe(true);
    expect(r.events.filter((e) => e.startsWith('api:afterReady'))).toEqual([
      'api:afterReady:session',
    ]);

    // A restart is a new start: it runs once more.
    const old = t.proc('api');
    const restarting = t.supervisor.restart('api');
    old.exit({ code: null, signal: 'SIGTERM' });
    await restarting;
    await t.clock.advance(2000);
    await until(() => expect(t.readiness.isReady('api')).toBe(true));
    expect(r.events.filter((e) => e.startsWith('api:afterReady'))).toEqual([
      'api:afterReady:session',
      'api:afterReady:restart',
    ]);
  });

  test("a start resolves once afterStart is done: it doesn't wait for the healthcheck or afterReady", async () => {
    const r = recordingHooks(() => undefined, ALL);
    const t = setup({
      services: { api: { healthcheck: HC, autostart: false } },
      hooks: r.hooks,
      events: r.events,
    });
    t.supervisor.launchAll();
    await t.supervisor.start('api');
    expect(r.events).toEqual(['api:beforeStart:start', 'spawn api', 'api:afterStart:start']);
    expect(t.readiness.isReady('api')).toBe(false);
  });

  test("an afterStart that throws runs no afterReady, and the service's dependents are told why they wait", async () => {
    const r = recordingHooks(
      ({ name, hook }) => (name === 'api' && hook === 'afterStart' ? { error: 'boom' } : undefined),
      ALL,
    );
    const t = setup({
      services: { api: { healthcheck: HC }, web: { deps: [{ service: 'api', wait: true }] } },
      hooks: r.hooks,
      events: r.events,
    });
    t.answers.set('api', true);
    t.supervisor.launchAll();
    await until(() => expect(t.state('api')).toBe('failed'));
    await t.clock.advance(2000);
    expect(r.events.filter((e) => e.startsWith('api:'))).toEqual([
      'api:beforeStart:session',
      'api:afterStart:session',
    ]);
    expect(t.readiness.isHealthy('api')).toBe(true);
    expect(t.readiness.isReady('api')).toBe(false);
    expect(t.state('web')).toBe('waiting');
    expect(t.said('web').some((line) => line.includes('api failed: afterStart failed: boom'))).toBe(
      true,
    );
  });

  test.each([
    {
      screen: 'with no screen',
      interactive: false,
      how: 'Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session',
    },
    {
      screen: 'on the terminal UI',
      interactive: true,
      how: 'Once it is fixed, focus api and press r, or run stackctl service restart -s api; a change to stackctl.config.ts needs a new session',
    },
  ])(
    'a dependent that starts waiting on a service already failed is told why at once, $screen',
    async ({ interactive, how }) => {
      const r = recordingHooks(
        ({ name, hook }) =>
          name === 'api' && hook === 'afterReady' ? { error: 'boom' } : undefined,
        ALL,
      );
      const t = setup({
        services: { api: { healthcheck: HC }, web: { deps: [{ service: 'api', wait: true }] } },
        selected: ['api'],
        hooks: r.hooks,
        events: r.events,
        interactive,
      });
      t.answers.set('api', true);
      t.supervisor.launchAll();
      await until(() => expect(t.of('api')).toHaveLength(1));
      await t.clock.advance(200);
      await until(() => expect(t.state('api')).toBe('failed'));
      expect(await t.supervisor.add('web')).toBe('done');
      await until(() => expect(t.state('web')).toBe('waiting'));
      expect(t.said('web')).toEqual([
        'added to the session',
        'waiting for api...',
        `api failed: afterReady failed: boom; still waiting for api. ${how}`,
      ]);
    },
  );

  test('a restart while afterReady runs abandons it: its late failure touches nothing of the new start', async () => {
    const first = gate();
    let n = 0;
    const r = recordingHooks(({ hook }) => {
      if (hook !== 'afterReady') {
        return undefined;
      }
      n++;
      return n === 1 ? first.promise.then(() => ({ error: 'late' })) : undefined;
    }, ALL);
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(r.events.at(-1)).toBe('api:afterReady:session'));
    const old = t.proc('api');
    const restarting = t.supervisor.restart('api');
    old.exit({ code: null, signal: 'SIGTERM' });
    await until(() => expect(t.of('api')).toHaveLength(2));
    first.open();
    await restarting;
    await until(() => expect(r.events.at(-1)).toBe('api:afterReady:restart'));
    await until(() => expect(t.readiness.isReady('api')).toBe(true));
    expect(t.said('api')).toContain('afterReady abandoned: the service was restarted');
    expect(t.said('api')).not.toContain('afterReady failed: late');
    expect(t.state('api')).toBe('running');
    expect(t.supervisor.failure('api')).toBeNull();
  });

  test("a late afterReady never releases a newer start's hold", async () => {
    const oldRun = gate();
    const newStart = gate();
    let readyRuns = 0;
    const r = recordingHooks(({ hook }) => {
      if (hook === 'afterReady') {
        readyRuns++;
        return readyRuns === 1 ? oldRun.promise.then(() => undefined) : undefined;
      }
      if (hook === 'afterStart' && readyRuns === 1) {
        return newStart.promise.then(() => undefined);
      }
      return undefined;
    }, ALL);
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(r.events.at(-1)).toBe('api:afterReady:session'));
    const old = t.proc('api');
    const restarting = t.supervisor.restart('api');
    old.exit({ code: null, signal: 'SIGTERM' });
    await until(() => expect(r.events.at(-1)).toBe('api:afterStart:restart'));
    // The old afterReady succeeds while the new start's afterStart still runs.
    oldRun.open();
    await t.clock.advance(100);
    expect(t.readiness.isHealthy('api')).toBe(true);
    expect(t.readiness.isReady('api')).toBe(false);
    newStart.open();
    await restarting;
    await until(() => expect(t.readiness.isReady('api')).toBe(true));
    expect(r.events.filter((e) => e.startsWith('api:afterReady'))).toEqual([
      'api:afterReady:session',
      'api:afterReady:abandoned',
      'api:afterReady:restart',
    ]);
  });

  test('a restart of a failed service starts it afresh: its failure is cleared and it gets ready', async () => {
    let fail = true;
    const r = recordingHooks(
      ({ hook }) => (hook === 'afterReady' && fail ? { error: 'boom' } : undefined),
      ALL,
    );
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(t.state('api')).toBe('failed'));
    fail = false;
    const old = t.proc('api');
    const restarting = t.supervisor.restart('api');
    old.exit({ code: null, signal: 'SIGTERM' });
    await restarting;
    await until(() => expect(t.readiness.isReady('api')).toBe(true));
    expect(t.state('api')).toBe('running');
    expect(t.supervisor.failure('api')).toBeNull();
  });

  test('a stop while afterReady waits for health runs no afterReady', async () => {
    const r = recordingHooks(() => undefined, ALL);
    const t = setup({ services: { api: { healthcheck: HC } }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(r.events.at(-1)).toBe('api:afterStart:session'));
    const stopping = t.supervisor.stop('api');
    t.proc('api').exit({ code: null, signal: 'SIGTERM' });
    await stopping;
    t.answers.set('api', true);
    await t.clock.advance(5000);
    expect(r.events.filter((e) => e.startsWith('api:afterReady'))).toEqual([]);
  });

  describe('a stop or restart of a service whose hooks hold its ready', () => {
    /** `api` (healthchecked, its `afterReady` failing the first time) and `web` waiting on it. */
    async function failedApiWithWaiter() {
      let fail = true;
      const r = recordingHooks(
        ({ name, hook }) =>
          name === 'api' && hook === 'afterReady' && fail ? { error: 'boom' } : undefined,
        ALL,
      );
      const t = setup({
        services: { api: { healthcheck: HC }, web: { deps: [{ service: 'api', wait: true }] } },
        hooks: r.hooks,
        events: r.events,
      });
      t.answers.set('api', true);
      t.supervisor.launchAll();
      await until(() => expect(t.of('api')).toHaveLength(1));
      await t.clock.advance(200);
      await until(() => expect(t.state('api')).toBe('failed'));
      fail = false;
      return { t, r };
    }

    test("a restart doesn't release the dependents while the old process still answers", async () => {
      const { t, r } = await failedApiWithWaiter();
      const old = t.proc('api');
      const restarting = t.supervisor.restart('api');
      // The old process is in its grace period, and still answers the healthcheck.
      await t.clock.advance(2000);
      expect(r.events).not.toContain('spawn web');
      expect(t.readiness.isReady('api')).toBe(false);
      // api is no longer failed: web just waits for it.
      expect(t.supervisor.blockedBy('web')).toBeNull();
      // The new process: its afterReady waits for a probe of its own to pass.
      t.answers.set('api', false);
      old.exit({ code: null, signal: 'SIGTERM' });
      await restarting;
      expect(t.of('api')).toHaveLength(2);
      await t.clock.advance(1000);
      expect(r.events).not.toContain('api:afterReady:restart');
      expect(r.events).not.toContain('spawn web');
      t.answers.set('api', true);
      await t.clock.advance(2000);
      await until(() => expect(r.events).toContain('spawn web'));
      expect(r.events.indexOf('api:afterReady:restart')).toBeLessThan(
        r.events.indexOf('spawn web'),
      );
      expect(t.supervisor.blockedBy('web')).toBeNull();
    });

    test("a stop doesn't release the dependents while the old process still answers", async () => {
      const { t, r } = await failedApiWithWaiter();
      const stopping = t.supervisor.stop('api');
      await t.clock.advance(2000);
      expect(r.events).not.toContain('spawn web');
      expect(t.readiness.isReady('api')).toBe(false);
      t.proc('api').exit({ code: null, signal: 'SIGTERM' });
      await stopping;
      await t.clock.advance(2000);
      expect(r.events).not.toContain('spawn web');
      expect(t.state('web')).toBe('waiting');
    });
  });

  test('a shutdown while afterReady runs: no line, no state change after it', async () => {
    const held = gate();
    const r = recordingHooks(
      ({ hook }) =>
        hook === 'afterReady' ? held.promise.then(() => ({ error: 'late' })) : undefined,
      ALL,
    );
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(r.events.at(-1)).toBe('api:afterReady:session'));
    const stopping = t.supervisor.stopAll();
    t.proc('api').exit({ code: null, signal: 'SIGTERM' });
    await stopping;
    const said = t.said('api');
    held.open();
    await t.clock.advance(100);
    await settle();
    expect(t.said('api')).toEqual(said);
    expect(t.state('api')).toBe('stopped');
  });

  test('a process that exits by itself while afterReady runs: the crash stands, nothing is released', async () => {
    const held = gate();
    const r = recordingHooks(
      ({ hook }) => (hook === 'afterReady' ? held.promise.then(() => undefined) : undefined),
      ALL,
    );
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(r.events.at(-1)).toBe('api:afterReady:session'));
    t.proc('api').exit({ code: 1, signal: null });
    await until(() => expect(t.state('api')).toBe('crashed'));
    held.open();
    await settle();
    expect(t.state('api')).toBe('crashed');
    expect(t.readiness.isReady('api')).toBe(false);
  });
});

describe('stop hooks', () => {
  const ALL = ['beforeStart', 'afterStart', 'afterReady', 'beforeStop', 'afterStop'];
  const STOPS = ['beforeStop', 'afterStop'];

  /** Records `stop <name>` in `events` when `proc` is signalled; with `exit`, it exits at once. */
  function recordStop(proc: StubProcess, events: string[], exit = true): void {
    const stop = proc.stop.bind(proc);
    proc.stop = () => {
      events.push(`stop ${proc.opts.name}`);
      const exited = stop();
      if (exit) {
        proc.exit({ code: null, signal: 'SIGTERM' });
      }
      return exited;
    };
  }

  test('a restart runs beforeStop, the stop, afterStop, beforeStart, the spawn, afterStart, afterReady, in that order, with one data', async () => {
    const r = recordingHooks(() => undefined, ALL);
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(r.events.at(-1)).toBe('api:afterReady:session'));
    r.events.length = 0;
    r.calls.length = 0;
    recordStop(t.proc('api'), r.events);
    const data = {};
    await t.supervisor.restart('api', data);
    await until(() => expect(r.events.at(-1)).toBe('api:afterReady:restart'));
    expect(r.events).toEqual([
      'api:beforeStop:restart',
      'stop api',
      'api:afterStop:restart',
      'api:beforeStart:restart',
      'spawn api',
      'api:afterStart:restart',
      'api:afterReady:restart',
    ]);
    expect(r.calls).toHaveLength(5);
    for (const call of r.calls) {
      expect(call.data).toBe(data);
      expect(call.trigger).toBe('restart');
    }
  });

  test('a restart for a .env change runs its stop hooks with the trigger env', async () => {
    const r = recordingHooks(() => undefined, STOPS);
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    recordStop(t.proc('api'), r.events);
    await t.supervisor.envChanged('api');
    expect(r.events).toEqual(['spawn api', 'api:beforeStop:env', 'stop api', 'api:afterStop:env', 'spawn api']); // oxfmt-ignore
    expect(r.calls[0]!.data).toBe(r.calls[1]!.data);
  });

  test('a stop runs beforeStop before the signal and afterStop once the process has exited, with trigger stop', async () => {
    const held = gate();
    const r = recordingHooks(
      ({ hook }) => (hook === 'beforeStop' ? held.promise.then(() => undefined) : undefined),
      STOPS,
    );
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    const proc = t.proc('api');
    recordStop(proc, r.events, false);
    const data = {};
    let stopped = false;
    const stopping = t.supervisor.stop('api', data).then(() => {
      stopped = true;
    });
    await until(() => expect(r.events.at(-1)).toBe('api:beforeStop:stop'));
    await t.clock.advance(1000);
    // The state flips at once; the signal waits for the hook.
    expect(t.state('api')).toBe('stopped');
    expect(proc.stops).toBe(0);
    held.open();
    await until(() => expect(proc.stops).toBe(1));
    await settle();
    expect(r.events).toEqual(['spawn api', 'api:beforeStop:stop', 'stop api']);
    expect(stopped).toBe(false);
    proc.exit({ code: null, signal: 'SIGTERM' });
    await stopping;
    expect(r.events).toEqual(['spawn api', 'api:beforeStop:stop', 'stop api', 'api:afterStop:stop']); // oxfmt-ignore
    expect(r.calls.map((c) => c.data)).toEqual([data, data]);
    expect(r.calls[0]!.data).toBe(data);
    expect(r.calls[1]!.data).toBe(data);
    expect(t.said('api')).toEqual(['started', 'stopping...', 'stopped']);
  });

  test('stop hooks run only for a running process', async () => {
    const r = recordingHooks(() => undefined, STOPS);
    const t = setup({
      services: {
        api: { healthcheck: HC },
        web: { deps: [{ service: 'api', wait: true }] },
        worker: {},
      },
      hooks: r.hooks,
      events: r.events,
    });
    t.supervisor.launchAll();
    await until(() => expect(t.of('worker')).toHaveLength(1));
    // web waits for api, which never gets healthy.
    expect(t.state('web')).toBe('waiting');
    await t.supervisor.stop('web');
    expect(t.state('web')).toBe('stopped');
    // A stopped one.
    await t.supervisor.stop('web');
    // A crashed one.
    t.proc('worker').exit({ code: 1, signal: null });
    expect(t.state('worker')).toBe('crashed');
    await t.supervisor.stop('worker');
    await t.supervisor.restart('worker');
    expect(r.events.filter((e) => !e.startsWith('spawn'))).toEqual([]);
    expect(t.of('worker')).toHaveLength(2);
  });

  test('a service that exits on its own runs no hook', async () => {
    const r = recordingHooks(() => undefined, STOPS);
    const t = setup({ services: { api: {}, worker: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(t.procs).toHaveLength(2));
    t.proc('api').exit({ code: 0, signal: null });
    t.proc('worker').exit({ code: 1, signal: null });
    await t.clock.advance(1000);
    await settle();
    expect(t.state('api')).toBe('stopped');
    expect(t.state('worker')).toBe('crashed');
    expect(r.calls).toEqual([]);
  });

  test('a stop hook that throws is logged as an error and the stop goes ahead', async () => {
    const r = recordingHooks(({ hook }) => ({ error: hook === 'beforeStop' ? 'boom' : 'bang' }), STOPS); // oxfmt-ignore
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    const proc = t.proc('api');
    recordStop(proc, r.events);
    await t.supervisor.stop('api');
    expect(r.events).toEqual(['spawn api', 'api:beforeStop:stop', 'stop api', 'api:afterStop:stop']); // oxfmt-ignore
    expect(t.said('api')).toEqual([
      'started',
      'stopping...',
      'beforeStop failed: boom',
      'stopped',
      'afterStop failed: bang',
    ]);
    const lines = t.logs.getVisibleLines().filter((l) => l.service === 'api');
    expect(lines.filter((l) => l.isError).map((l) => stripAnsi(l.text))).toEqual([
      'beforeStop failed: boom',
      'afterStop failed: bang',
    ]);
    expect(t.state('api')).toBe('stopped');
    expect(proc.stops).toBe(1);
  });

  test('a restart reads restarting at once, before its beforeStop has finished', async () => {
    const held = gate();
    const r = recordingHooks(
      ({ hook }) => (hook === 'beforeStop' ? held.promise.then(() => undefined) : undefined),
      STOPS,
    );
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    recordStop(t.proc('api'), r.events);
    const restarting = t.supervisor.restart('api');
    // Before the hook has begun: a control API's restart answers on this state.
    expect(t.state('api')).toBe('restarting');
    expect(r.events).toEqual(['spawn api']);
    await until(() => expect(r.events.at(-1)).toBe('api:beforeStop:restart'));
    expect(t.said('api')).toEqual(['started', 'stopping...']);
    expect(t.state('api')).toBe('restarting');
    held.open();
    await restarting;
    expect(t.of('api')).toHaveLength(2);
    expect(t.state('api')).toBe('running');
  });

  test("a stop during a restart's beforeStop abandons it and signals the process at once; its afterStop runs, nothing spawns", async () => {
    const held = gate();
    const r = recordingHooks(
      ({ hook }) => (hook === 'beforeStop' ? held.promise.then(() => undefined) : undefined),
      ALL,
    );
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(r.events.at(-1)).toBe('api:afterReady:session'));
    r.events.length = 0;
    recordStop(t.proc('api'), r.events);
    const restarting = t.supervisor.restart('api');
    await until(() => expect(r.events).toEqual(['api:beforeStop:restart']));
    const stopping = t.supervisor.stop('api');
    expect(t.state('api')).toBe('stopped');
    // The hook never settles: the stop goes on without it.
    await Promise.all([restarting, stopping]);
    expect(r.events).toEqual(['api:beforeStop:restart', 'stop api', 'api:afterStop:restart']);
    expect(t.said('api')).toContain('beforeStop abandoned: the stop was asked for again');
    held.open();
    await settle();
    expect(t.of('api')).toHaveLength(1);
    expect(t.state('api')).toBe('stopped');
  });

  test.each(['beforeStop', 'afterStop'])(
    'a start while a stop runs its %s waits for the stop to finish: one process at a time',
    async (during) => {
      const held = gate();
      const r = recordingHooks(
        ({ hook }) => (hook === during ? held.promise.then(() => undefined) : undefined),
        STOPS,
      );
      const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
      t.supervisor.launchAll();
      await until(() => expect(t.of('api')).toHaveLength(1));
      recordStop(t.proc('api'), r.events);
      const stopping = t.supervisor.stop('api');
      await until(() => expect(r.events.at(-1)).toBe(`api:${during}:stop`));
      const starting = t.supervisor.start('api');
      await t.clock.advance(1000);
      await settle();
      expect(t.of('api')).toHaveLength(1);
      held.open();
      await Promise.all([stopping, starting]);
      expect(r.events).toEqual(['spawn api', 'api:beforeStop:stop', 'stop api', 'api:afterStop:stop', 'spawn api']); // oxfmt-ignore
      expect(t.state('api')).toBe('running');
    },
  );

  test.each([
    {
      how: 'stopAll',
      shut: async (t: ReturnType<typeof setup>, proc: StubProcess) => {
        const all = t.supervisor.stopAll();
        proc.exit({ code: null, signal: 'SIGTERM' });
        await all;
      },
      signalled: (proc: StubProcess) => proc.stops,
    },
    {
      how: 'killEverything',
      shut: async (t: ReturnType<typeof setup>) => t.supervisor.killEverything(),
      signalled: (proc: StubProcess) => proc.kills,
    },
  ])(
    'a shutdown ($how) during a beforeStop: the process is signalled at once, and no afterStop runs',
    async ({ shut, signalled }) => {
      const held = gate();
      const r = recordingHooks(
        ({ hook }) => (hook === 'beforeStop' ? held.promise.then(() => undefined) : undefined),
        STOPS,
      );
      const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
      t.supervisor.launchAll();
      await until(() => expect(t.of('api')).toHaveLength(1));
      const proc = t.proc('api');
      const stopping = t.supervisor.stop('api');
      await until(() => expect(r.events.at(-1)).toBe('api:beforeStop:stop'));
      // Resolves with the hook still running.
      await shut(t, proc);
      expect(signalled(proc)).toBe(1);
      const said = t.said('api');
      held.open();
      await stopping;
      await settle();
      expect(r.events).toEqual(['spawn api', 'api:beforeStop:stop']);
      expect(t.said('api')).toEqual(said);
      expect(t.state('api')).toBe('stopped');
    },
  );

  test('a process that exits by itself while its beforeStop runs: no crash, no exit event, and its afterStop runs', async () => {
    const held = gate();
    const r = recordingHooks(
      ({ hook }) => (hook === 'beforeStop' ? held.promise.then(() => undefined) : undefined),
      STOPS,
    );
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    const exits: string[] = [];
    t.supervisor.on('exit', (name) => exits.push(name));
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    const stopping = t.supervisor.stop('api');
    await until(() => expect(r.events.at(-1)).toBe('api:beforeStop:stop'));
    t.proc('api').exit({ code: 1, signal: null });
    await settle();
    expect(t.state('api')).toBe('stopped');
    // Gone: nothing to reach, no pid.
    expect(t.supervisor.hasProcess('api')).toBe(false);
    expect(t.readiness.isHealthy('api')).toBe(false);
    expect(t.supervisor.states().get('api')!.pid).toBeNull();
    held.open();
    await stopping;
    expect(r.events).toEqual(['spawn api', 'api:beforeStop:stop', 'api:afterStop:stop']);
    expect(t.state('api')).toBe('stopped');
    expect(exits).toEqual([]);
  });

  test.each([
    {
      how: 'a stop',
      act: (t: ReturnType<typeof setup>) => t.supervisor.stop('api'),
      state: 'stopped',
    },
    {
      how: 'a restart',
      act: (t: ReturnType<typeof setup>) => t.supervisor.restart('api'),
      state: 'restarting',
    },
  ])(
    'while $how runs its beforeStop, the process can still be reached and its pid is shown, but the service is not ready; from the signal on, neither',
    async ({ act, state }) => {
      const held = gate();
      const r = recordingHooks(
        ({ hook }) => (hook === 'beforeStop' ? held.promise.then(() => undefined) : undefined),
        ['beforeStop'],
      );
      const t = setup({
        services: { api: { healthcheck: HC }, worker: {} },
        hooks: r.hooks,
        events: r.events,
      });
      t.answers.set('api', true);
      t.supervisor.launchAll();
      await until(() => expect(t.of('api')).toHaveLength(1));
      await t.clock.advance(200);
      await until(() => expect(t.readiness.isReady('api')).toBe(true));
      const proc = t.proc('api');
      const pid = proc.pid;
      recordStop(proc, r.events, false);
      const acting = act(t);
      await until(() => expect(r.events.at(-1)).toMatch(/^api:beforeStop:/));
      // The probes go on, and the old process still answers them.
      await t.clock.advance(3000);
      expect(t.state('api')).toBe(state);
      expect(t.supervisor.hasProcess('api')).toBe(true);
      expect(t.readiness.isHealthy('api')).toBe(true);
      expect(t.readiness.isReady('api')).toBe(false);
      expect(t.supervisor.states().get('api')).toMatchObject({ pid, ready: false });
      held.open();
      await until(() => expect(proc.stops).toBe(1));
      expect(t.supervisor.hasProcess('api')).toBe(false);
      expect(t.readiness.isHealthy('api')).toBe(false);
      expect(t.supervisor.states().get('api')!.pid).toBeNull();
      proc.exit({ code: null, signal: 'SIGTERM' });
      await acting;
    },
  );

  test('a service with no healthcheck can be reached while its beforeStop runs', async () => {
    const held = gate();
    const r = recordingHooks(
      ({ hook }) => (hook === 'beforeStop' ? held.promise.then(() => undefined) : undefined),
      ['beforeStop'],
    );
    const t = setup({ services: { worker: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(t.of('worker')).toHaveLength(1));
    const proc = t.proc('worker');
    recordStop(proc, r.events);
    const stopping = t.supervisor.stop('worker');
    await until(() => expect(r.events.at(-1)).toBe('worker:beforeStop:stop'));
    expect(t.readiness.isHealthy('worker')).toBe(true);
    expect(t.readiness.isReady('worker')).toBe(false);
    held.open();
    await stopping;
    expect(t.readiness.isHealthy('worker')).toBe(false);
  });

  test('a stop with only an afterStop signals at once', async () => {
    const r = recordingHooks(() => undefined, ['afterStop']);
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    const proc = t.proc('api');
    const stopping = t.supervisor.stop('api');
    expect(t.supervisor.states().get('api')!.pid).toBeNull();
    await settle();
    expect(proc.stops).toBe(1);
    proc.exit({ code: null, signal: 'SIGTERM' });
    await stopping;
    expect(r.events).toEqual(['spawn api', 'api:afterStop:stop']);
  });

  test("a restart doesn't make the service ready while its beforeStop runs and the old process still answers", async () => {
    const held = gate();
    const r = recordingHooks(
      ({ hook }) => (hook === 'beforeStop' ? held.promise.then(() => undefined) : undefined),
      ['beforeStop'],
    );
    const t = setup({
      services: { api: { healthcheck: HC }, web: { deps: [{ service: 'api', wait: true }] } },
      hooks: r.hooks,
      events: r.events,
    });
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    expect(t.state('web')).toBe('waiting');
    const old = t.proc('api');
    const restarting = t.supervisor.restart('api');
    await until(() => expect(r.events.at(-1)).toBe('api:beforeStop:restart'));
    // The old process answers while its beforeStop runs.
    t.answers.set('api', true);
    await t.clock.advance(3000);
    expect(t.readiness.isReady('api')).toBe(false);
    expect(r.events).not.toContain('spawn web');
    t.answers.set('api', false);
    held.open();
    await until(() => expect(old.stops).toBe(1));
    old.exit({ code: null, signal: 'SIGTERM' });
    await restarting;
    expect(t.of('api')).toHaveLength(2);
    await t.clock.advance(1000);
    expect(r.events).not.toContain('spawn web');
    t.answers.set('api', true);
    await t.clock.advance(2000);
    await until(() => expect(r.events).toContain('spawn web'));
  });
});

describe('a newer request abandons the start hooks still running', () => {
  const ALL = ['beforeStart', 'afterStart', 'afterReady', 'beforeStop', 'afterStop'];
  const STARTS = ['beforeStart', 'afterStart', 'afterReady'];
  /** Never settles: a hook that hangs. */
  const never = new Promise<void>(() => {});

  /** A session whose `api` hangs in `hook` of its first start. */
  async function hungIn(hook: string, defined: readonly string[] = STARTS) {
    const r = recordingHooks((call) => (call.hook === hook && call.trigger === 'session' ? never : undefined), defined); // oxfmt-ignore
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(r.events.at(-1)).toBe(`api:${hook}:session`));
    return { r, t };
  }

  test.each(STARTS)(
    'a stop while %s runs abandons it, with a line, and neither fails the service nor makes it ready',
    async (hook) => {
      const { r, t } = await hungIn(hook);
      const stopping = t.supervisor.stop('api');
      t.of('api').at(-1)?.exit({ code: null, signal: 'SIGTERM' });
      await stopping;
      expect(r.events.at(-1)).toBe(`api:${hook}:abandoned`);
      expect(t.said('api')).toContain(`${hook} abandoned: the service was stopped`);
      expect(t.state('api')).toBe('stopped');
      expect(t.supervisor.failure('api')).toBeNull();
      expect(t.readiness.isReady('api')).toBe(false);
    },
  );

  test("a hook abandoned by a stop that fails later logs nothing: it is no longer the service's", async () => {
    const held = gate();
    const r = recordingHooks(({ hook }) => (hook === 'afterReady' ? held.promise.then(() => ({ error: 'late' })) : undefined), STARTS); // oxfmt-ignore
    const t = setup({ services: { api: {} }, hooks: r.hooks, events: r.events });
    t.supervisor.launchAll();
    await until(() => expect(r.events.at(-1)).toBe('api:afterReady:session'));
    const stopping = t.supervisor.stop('api');
    t.proc('api').exit({ code: null, signal: 'SIGTERM' });
    await stopping;
    const said = t.said('api');
    held.open();
    await settle();
    expect(t.said('api')).toEqual(said);
    expect(said).not.toContain('afterReady failed: late');
  });

  test("a stop's beforeStop begins only once the abandoned afterReady's commands have ended", async () => {
    const { r, t } = await hungIn('afterReady', ALL);
    const ended = gate();
    r.commands.set('api', ended.promise);
    const proc = t.proc('api');
    r.events.length = 0;
    const stopping = t.supervisor.stop('api');
    await settle();
    // Abandoned, and the stop under way, but its own hook waits for the commands to end.
    expect(r.events).toEqual(['api:afterReady:abandoned']);
    expect(t.state('api')).toBe('stopped');
    expect(proc.stops).toBe(0);
    ended.open();
    await until(() => expect(proc.stops).toBe(1));
    proc.exit({ code: null, signal: 'SIGTERM' });
    await stopping;
    expect(r.events).toEqual(['api:afterReady:abandoned', 'api:beforeStop:stop', 'api:afterStop:stop']); // oxfmt-ignore
  });

  test("a restart's new start begins only once the abandoned hook's commands have ended, though its process is stopped at once", async () => {
    const { r, t } = await hungIn('afterStart');
    const ended = gate();
    r.commands.set('api', ended.promise);
    const old = t.proc('api');
    r.events.length = 0;
    const restarting = t.supervisor.restart('api');
    expect(old.stops).toBe(1);
    old.exit({ code: null, signal: 'SIGTERM' });
    // The restart re-reads the `.env` files before it gets here, and nothing marks that read's
    // end: a real wait long enough for it, so a start that didn't wait would have begun.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(r.events).toEqual(['api:afterStart:abandoned']);
    expect(t.said('api')).toContain('afterStart abandoned: the service was restarted');
    r.events.push('commands ended');
    ended.open();
    expect(await restarting).toBe('done');
    expect(r.events.slice(0, 5)).toEqual([
      'api:afterStart:abandoned',
      'commands ended',
      'api:beforeStart:restart',
      'spawn api',
      'api:afterStart:restart',
    ]);
    expect(t.of('api')).toHaveLength(2);
  });

  test('a start after a stop waits for the commands of the beforeStart the stop abandoned', async () => {
    const { r, t } = await hungIn('beforeStart');
    const ended = gate();
    r.commands.set('api', ended.promise);
    const stopping = t.supervisor.stop('api');
    expect(t.state('api')).toBe('stopped');
    r.events.length = 0;
    const starting = t.supervisor.start('api');
    await settle();
    expect(r.events).toEqual([]);
    expect(t.of('api')).toHaveLength(0);
    ended.open();
    await Promise.all([stopping, starting]);
    expect(r.events.slice(0, 3)).toEqual(['api:beforeStart:start', 'spawn api', 'api:afterStart:start']); // oxfmt-ignore
  });

  test('a start after a crash abandons the afterReady of the start before it', async () => {
    const { r, t } = await hungIn('afterReady');
    t.proc('api').exit({ code: 1, signal: null });
    await until(() => expect(t.state('api')).toBe('crashed'));
    r.events.length = 0;
    await t.supervisor.start('api');
    expect(r.events.slice(0, 2)).toEqual(['api:afterReady:abandoned', 'api:beforeStart:start']);
    expect(t.said('api')).toContain('afterReady abandoned: the service was started again');
    expect(t.of('api')).toHaveLength(2);
  });

  test("the shutdown abandons it with a line, and the service's beforeStop waits for its commands within the stop hooks' time", async () => {
    const { r, t } = await hungIn('afterReady', ALL);
    const ended = gate();
    r.commands.set('api', ended.promise);
    r.events.length = 0;
    t.supervisor.beginShutdown();
    expect(r.events).toEqual(['api:afterReady:abandoned']);
    expect(t.said('api')).toContain('afterReady abandoned: the session is quitting');
    const budget = new AbortController();
    const hooks = t.supervisor.runStopHooks('beforeStop', t.supervisor.running(), {}, budget.signal); // oxfmt-ignore
    await settle();
    expect(r.events).toEqual(['api:afterReady:abandoned']);
    ended.open();
    await hooks;
    expect(r.events).toEqual(['api:afterReady:abandoned', 'api:beforeStop:quit']);
  });

  test("commands that never end don't hold the stop: it goes on once their time to end is up", async () => {
    const { r, t } = await hungIn('afterReady', ALL);
    r.commands.set('api', never);
    const proc = t.proc('api');
    r.events.length = 0;
    const stopping = t.supervisor.stop('api');
    await t.clock.advance(COMMAND_END_GRACE_MS);
    expect(proc.stops).toBe(0);
    await t.clock.advance(1_000);
    await until(() => expect(proc.stops).toBe(1));
    proc.exit({ code: null, signal: 'SIGTERM' });
    await stopping;
    expect(r.events).toEqual(['api:afterReady:abandoned', 'api:beforeStop:stop', 'api:afterStop:stop']); // oxfmt-ignore
  });

  test('a second stop while those commands are still ending signals the process at once', async () => {
    const { r, t } = await hungIn('afterReady', ALL);
    r.commands.set('api', never);
    const proc = t.proc('api');
    const first = t.supervisor.stop('api');
    await settle();
    expect(proc.stops).toBe(0);
    const second = t.supervisor.stop('api');
    await until(() => expect(proc.stops).toBe(1));
    proc.exit({ code: null, signal: 'SIGTERM' });
    await until(() => expect(t.said('api')).toContain('beforeStop abandoned: the stop was asked for again')); // oxfmt-ignore
    // Each stop resolves once nothing of the service runs: here, once the commands' time is up.
    await t.clock.advance(COMMAND_END_GRACE_MS + 1_000);
    await Promise.all([first, second]);
  });
});

describe('a beforeStart that writes its own .env file', () => {
  /** The `.env` watch of the supervisor over `root`, once it has read what the files start as. */
  async function watchOf(root: string) {
    const mine = () => watches.filter((w) => w.dirs[0] === root && !w.disposed);
    await until(() => expect(mine()).toHaveLength(1));
    await mine()[0]!.ready;
    return mine()[0]!;
  }

  /**
   * Reports a change in `api`'s directory, as the file watch does a moment after a write, and
   * resolves with what the supervisor made of it: the services it restarts, and whether it took
   * the change for a `beforeStart`'s own.
   */
  async function reportChange(t: { root: string; supervisor: Supervisor }) {
    const watch = await watchOf(t.root);
    const made = new Promise<{ restarts: string[]; byHook: boolean }>((resolve) =>
      t.supervisor.once('env-change', (_dir, restarts, byHook) => resolve({ restarts, byHook })),
    );
    watch.targets.find((target) => target.dir === path.join(t.root, 'packages/api'))!.onChange();
    return made;
  }

  /** A session of `api`, whose only hook is a `beforeStart` that runs `write` with its `.env`. */
  function hooked(write: (file: string, call: HookCall) => void | Promise<void>) {
    let file = '';
    const r = recordingHooks((call) => write(file, call), ['beforeStart']);
    const t = setup({
      services: { api: {} },
      hooks: r.hooks,
      events: r.events,
      files: { 'packages/api/.env': 'GREETING=before\n' },
    });
    file = path.join(t.root, 'packages/api/.env');
    return t;
  }

  test('the spawn gets what it wrote, and the write, reported after the spawn, restarts nothing', async () => {
    const t = hooked((file, { trigger }) => {
      if (trigger === 'restart') {
        fs.writeFileSync(file, 'GREETING=from-hook\n');
      }
    });
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    expect(t.proc('api').opts.env.GREETING).toBe('before');
    const restarting = t.supervisor.restart('api');
    t.proc('api').exit({ code: null, signal: 'SIGTERM' });
    await restarting;
    expect(t.of('api')).toHaveLength(2);
    expect(t.proc('api').opts.env.GREETING).toBe('from-hook');
    expect(await reportChange(t)).toEqual({ restarts: [], byHook: true });
    expect(t.proc('api').stops).toBe(0);
    expect(t.said('api')).not.toContain('.env changed, restarting...');
    expect(t.state('api')).toBe('running');
  });

  test("at the session's start: exactly one process, with what the hook wrote", async () => {
    const t = hooked((file) => fs.writeFileSync(file, 'GREETING=from-hook\n'));
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    expect(t.proc('api').opts.env.GREETING).toBe('from-hook');
    expect(await reportChange(t)).toEqual({ restarts: [], byHook: true });
    expect(t.of('api')).toHaveLength(1);
    expect(t.proc('api').stops).toBe(0);
    expect(t.state('api')).toBe('running');
  });

  test('a write while its beforeStart runs, reported before the hook returns, restarts nothing', async () => {
    let during: { restarts: string[]; byHook: boolean } | undefined;
    const t: ReturnType<typeof hooked> = hooked(async (file) => {
      fs.writeFileSync(file, 'GREETING=from-hook\n');
      // The hook goes on until the watch has reported its write.
      during = await reportChange(t);
    });
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    expect(during).toEqual({ restarts: [], byHook: true });
    expect(t.proc('api').opts.env.GREETING).toBe('from-hook');
    expect(t.proc('api').stops).toBe(0);
  });

  test("a change that is not the hook's restarts the service, and is not taken for the hook's", async () => {
    const t = hooked(() => {});
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    fs.writeFileSync(path.join(t.root, 'packages/api/.env'), 'GREETING=edited\n');
    expect(await reportChange(t)).toEqual({ restarts: ['api'], byHook: false });
  });

  test('an edit after the spawn still restarts it, through the real file watch', async () => {
    const t = hooked((file, { trigger }) => {
      if (trigger === 'restart') {
        fs.writeFileSync(file, 'GREETING=from-hook\n');
      }
    });
    t.supervisor.launchAll();
    await until(() => expect(t.of('api')).toHaveLength(1));
    await watchOf(t.root);
    const restarting = t.supervisor.restart('api');
    t.proc('api').exit({ code: null, signal: 'SIGTERM' });
    await restarting;
    const second = t.proc('api');
    fs.writeFileSync(path.join(t.root, 'packages/api/.env'), 'GREETING=edited\n');
    // A wait on the system's file events: long, so a busy machine doesn't fail it.
    await vi.waitFor(() => expect(second.stops).toBe(1), { timeout: 12_000, interval: 20 });
    expect(t.said('api')).toContain('.env changed, restarting...');
  }, 15_000);
});
