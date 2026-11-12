import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { STACKCTL_LABEL_COLOR, PACKAGE_PALETTE } from '../colors.js';
import { type AnyServiceConfig, defineConfig } from '../config.js';
import type { EnvWatch, WatchTarget } from '../env-watch.js';
import { stripAnsi } from '../format.js';
import { labelGutter } from './log-layout.js';
import { LogStore } from './log-store.js';
import { buildSessionPlan } from './plan.js';
import { type Clock, Readiness } from './readiness.js';
import type {
  ProcessExit,
  ProcessState,
  ServiceProcessEvents,
  ServiceProcessOptions,
} from './service-process.js';
import {
  type ServiceState,
  type SupervisedProcess,
  Supervisor,
  publicStatus,
} from './supervisor.js';
import type { LogLine, SessionPlan } from './types.js';

const HC = 'http://127.0.0.1:1/health';

/** Every `.env` watch the Supervisor opens: the directories it covers, and whether it was closed. */
const watches = vi.hoisted(() => [] as { dirs: string[]; disposed: boolean }[]);

vi.mock('../env-watch.js', async (importOriginal) => {
  const actual = await importOriginal<{
    watchEnvFiles: (opts: { targets: WatchTarget[]; onError?: unknown }) => EnvWatch;
  }>();
  return {
    ...actual,
    watchEnvFiles: (opts: { targets: WatchTarget[] }) => {
      const watch = actual.watchEnvFiles(opts);
      const entry = { dirs: opts.targets.map((target) => target.dir), disposed: false };
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
  /** Files to write before anything reads them, by path relative to the workspace. */
  files?: Record<string, string>;
  /**
   * A file, relative to the workspace, made a FIFO: every read of it waits until `release()`
   * starts feeding it.
   */
  held?: string;
}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-sup-')));
  for (const name of Object.keys(opts.services)) {
    const dir = path.join(root, 'packages', name);
    fs.mkdirSync(dir, { recursive: true });
    const scripts: Record<string, string> = { lint: 'echo lint' };
    if (!opts.noDev?.includes(name)) {
      scripts.dev = `node ${name}.js`;
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, scripts }));
  }
  for (const [file, text] of Object.entries(opts.files ?? {})) {
    fs.writeFileSync(path.join(root, file), text);
  }
  const held = opts.held ? holdReads(path.join(root, opts.held)) : null;
  const config = defineConfig({
    workspaceDir: root,
    serviceRootDir: 'packages',
    ...(opts.logTimestamps === undefined ? {} : { logs: { timestamps: opts.logTimestamps } }),
    services: opts.services,
  } as unknown as Parameters<typeof defineConfig>[0]);
  const all = Object.values(config.services) as AnyServiceConfig[];
  const selected = all.filter((s) =>
    (opts.selected ?? Object.keys(opts.services)).includes(s.name),
  );
  const plan: SessionPlan = {
    ...buildSessionPlan(selected.map((s) => s.name)),
    cwd: root,
    envFiles: { workspace: ['.env'], service: ['.env'] },
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
    createProcess: (o) => {
      const proc = new StubProcess(o, opts.failSpawn?.includes(o.name) ?? false);
      procs.push(proc);
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
  test('held services wait, spawning reads running, a crash reads stopped', () => {
    expect(publicStatus('pending')).toBe('waiting');
    expect(publicStatus('waiting')).toBe('waiting');
    expect(publicStatus('starting')).toBe('running');
    expect(publicStatus('running')).toBe('running');
    expect(publicStatus('restarting')).toBe('restarting');
    expect(publicStatus('stopped')).toBe('stopped');
    expect(publicStatus('crashed')).toBe('stopped');
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
    expect(mine()[0]!.dirs).toEqual([t.root, path.join(t.root, 'packages/api')]);
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
