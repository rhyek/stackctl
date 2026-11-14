import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type AnyServiceConfig, defineConfig } from '../config.js';
import type { DevReverseProxyServer } from '../dev-reverse-proxy.js';
import { EventLog } from '../event-log.js';
import { logTimestamp } from '../format.js';
import { sessionEventsPath } from '../session-files.js';
import { createHeadlessPrinter, runHeadless } from './headless.js';
import { LogStore } from './log-store.js';
import { buildSessionPlan } from './plan.js';
import type {
  ProcessExit,
  ProcessState,
  ServiceProcessEvents,
  ServiceProcessOptions,
} from './service-process.js';
import { Session, type SessionSeams } from './session.js';
import type { SupervisedProcess } from './supervisor.js';
import type { LogLine } from './types.js';

// The capture's own lines (baseline `headless-backend.out.txt`, `--headless -s backend` in the
// example, piped) from the proxy's route table on, the labels padded to `stackctl`.
const CAPTURE = `2026-11-08 09:04:50 [stackctl] [INFO] dev reverse proxy listening on 127.0.0.1:21050 — \`*\` is every other host
2026-11-08 09:04:50 [stackctl]   api.localhost: backend :3001
2026-11-08 09:04:50 [stackctl]   mail.localhost: infra service mail :21054
2026-11-08 09:04:50 [stackctl]   app.localhost: frontend :3000
2026-11-08 09:04:50 [stackctl]   */todos/**: backend :3001
2026-11-08 09:04:50 [stackctl]   */**: frontend :3000
2026-11-08 09:04:50 [backend ] started
2026-11-08 09:04:51 [backend ] todo api listening on http://localhost:3001
2026-11-08 09:05:04 [stackctl] [WARN] shutting down...
`;

const STAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /gm;
const unstamped = (text: string) => text.replace(STAMP, '<stamp> ');

/** A writable that keeps what it's given. */
function sink() {
  const out = {
    text: '',
    write: (chunk: string, done?: () => void) => {
      out.text += chunk;
      done?.();
      return true;
    },
  };
  return out;
}

let level = chalk.level;
beforeEach(() => {
  level = chalk.level;
  chalk.level = 0;
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  chalk.level = level;
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A process that runs only in the test: it prints `lines` once spawned, and ends on a stop. */
class StubProcess extends EventEmitter<ServiceProcessEvents> implements SupervisedProcess {
  state: ProcessState = 'idle';
  pid: number | null = null;
  exitCode: number | null = null;

  constructor(
    readonly opts: ServiceProcessOptions,
    private readonly lines: string[],
  ) {
    super();
  }

  start(): void {
    this.pid = 920_000;
    this.state = 'running';
    this.emit('state', 'running');
    for (const line of this.lines) {
      this.opts.onLine(line, false);
    }
  }

  stop(): Promise<ProcessExit> {
    this.kill();
    return Promise.resolve({ code: null, signal: 'SIGTERM' });
  }

  kill(): void {
    if (this.state !== 'exited') {
      this.state = 'exited';
      this.exitCode = 143;
      this.emit('state', 'exited');
      this.emit('exit', { code: null, signal: 'SIGTERM' });
    }
  }
}

/** A workspace with the example's `backend` alone, and a Session over it with stubbed steps. */
function setup(seams: Partial<SessionSeams>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-headless-')));
  const dir = path.join(root, 'apps', 'backend');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'backend', scripts: { dev: 'node index.js' } })); // oxfmt-ignore
  const config = defineConfig({
    workspaceDir: root,
    serviceRootDir: 'apps',
    services: { backend: {} },
  } as unknown as Parameters<typeof defineConfig>[0]);
  const packages = Object.values(config.services) as AnyServiceConfig[];
  const logFile = path.join(root, 'session.log');
  const server = {
    port: 4321,
    bindSession: () => {},
    setQuitHandler: () => {},
    ackQuit: () => {},
    flush: () => {},
    close: () => Promise.resolve(),
  };
  const session = new Session({
    plan: { ...buildSessionPlan(packages.map((p) => p.name)), cwd: root, envFiles: { workspace: ['.env'], service: ['.env'] } }, // oxfmt-ignore
    configPath: path.join(root, 'stackctl.config.ts'),
    logFile,
    forked: false,
    seams: {
      acquire: () => Promise.resolve(4321),
      startProxy: () => Promise.resolve(null),
      startControlServer: () => Promise.resolve(server),
      runInfra: () => Promise.resolve(undefined),
      probe: () => Promise.resolve(true),
      readBranch: () => null,
      signalGroup: () => {},
      installSignals: () => () => {},
      events: new EventLog({
        file: sessionEventsPath(root, 'development', '1'),
        profile: 'development',
        sessionId: () => 'headless-test',
      }),
      ...seams,
    },
  });
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return { session, root };
}

describe('the headless printer', () => {
  test('prints every line with the same prefix as today', async () => {
    const stdout = sink();
    const stderr = sink();
    let exitCode: number | null = null;
    const proxy = {
      port: 21050,
      domain: 'localhost',
      domains: ['localhost'],
      routes: [],
      // What the dev reverse proxy logs when a session is attached to it.
      bindSession: (manager) =>
        manager.systemLog.info(
          {
            'api.localhost': 'backend :3001',
            'mail.localhost': 'infra service mail :21054',
            'app.localhost': 'frontend :3000',
            '*/todos/**': 'backend :3001',
            '*/**': 'frontend :3000',
          },
          'dev reverse proxy listening on 127.0.0.1:21050 — `*` is every other host',
        ),
      markInfraReady: () => {},
      close: () => Promise.resolve(),
    } satisfies DevReverseProxyServer;
    const { session } = setup({
      startProxy: () => Promise.resolve(proxy),
      createProcess: (o) => new StubProcess(o, ['todo api listening on http://localhost:3001']),
    });
    const run = runHeadless(session, { echo: true, stdout, stderr, exit: (code) => (exitCode = code) }); // oxfmt-ignore
    await vi.waitFor(() => expect(stdout.text).toContain('todo api listening'));
    await session.shutdown('signal');
    await run;
    expect(exitCode).toBe(0);
    // The session's first line, which the capture predates, then the capture's.
    expect(unstamped(stdout.text)).toBe(
      `<stamp> [stackctl] [INFO] profile development (default)\n${unstamped(CAPTURE)}`,
    );
    expect(stderr.text).toBe('');
  });

  test('infra progress lines print in order with the log, error lines on stderr', async () => {
    const logs = new LogStore({ logFile: path.join(os.tmpdir(), `stackctl-headless-${process.pid}.log`) }); // oxfmt-ignore
    cleanups.push(() => logs.close());
    const stdout = sink();
    const stderr = sink();
    const printer = createHeadlessPrinter({ logs, echo: true, stdout, stderr });
    logs.addLabels(['infra', 'infra:db']);
    const append = (name: string, text: string, isError = false, filterKey = 'infra') => {
      const line: Omit<LogLine, 'id'> = { service: null, text, isError, at: Date.now(), ts: logTimestamp(), showTs: true, label: { name }, filterKey }; // oxfmt-ignore
      logs.append(line);
    };
    printer.write('▶ infra (development): db');
    append('infra', 'Container example-db-1 Running');
    append('infra:db', 'role "app" does not exist', true);
    // Synchronously after the appends, as infra/report.ts writes.
    printer.write('  db  failed: not healthy');
    append('stackctl', '[ERROR] db: not healthy', true, 'system');
    printer.dispose();
    expect(unstamped(stdout.text)).toBe(
      ['▶ infra (development): db', '<stamp> [infra   ] Container example-db-1 Running', '  db  failed: not healthy', ''].join('\n'), // oxfmt-ignore
    );
    expect(unstamped(stderr.text)).toBe(
      ['<stamp> [infra:db] role "app" does not exist', '<stamp> [stackctl] [ERROR] db: not healthy', ''].join('\n'), // oxfmt-ignore
    );
  });

  test('with echo off only stackctl lines print', () => {
    const logs = new LogStore({ logFile: path.join(os.tmpdir(), `stackctl-headless-echo-${process.pid}.log`) }); // oxfmt-ignore
    cleanups.push(() => logs.close());
    const stdout = sink();
    const stderr = sink();
    const printer = createHeadlessPrinter({ logs, echo: false, stdout, stderr });
    const base = { at: Date.now(), ts: '2026-11-08 09:04:50', showTs: true };
    logs.append({ ...base, service: 'web', text: 'boom', isError: true, label: { name: 'web' }, filterKey: 'web' }); // oxfmt-ignore
    logs.append({ ...base, service: null, text: '[INFO] freeing dev ports', isError: false, label: { name: 'stackctl' }, filterKey: 'system' }); // oxfmt-ignore
    logs.append({ ...base, service: null, text: '[ERROR] port held', isError: true, label: { name: 'stackctl' }, filterKey: 'system' }); // oxfmt-ignore
    printer.dispose();
    expect(stdout.text).toBe('2026-11-08 09:04:50 [stackctl] [INFO] freeing dev ports\n');
    expect(stderr.text).toBe('2026-11-08 09:04:50 [stackctl] [ERROR] port held\n');
  });

  test('a startup failure in headless exits 1 after printing it', async () => {
    const stdout = sink();
    const stderr = sink();
    const { session } = setup({
      acquire: (onStatus) => {
        onStatus('freeing dev ports');
        return Promise.resolve(4321);
      },
      startProxy: () =>
        Promise.reject(new Error('dev reverse proxy port 21050 is already in use by another program.')), // oxfmt-ignore
    });
    const exit = vi.fn<(code: number) => void>();
    await runHeadless(session, { echo: true, stdout, stderr, exit });
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(unstamped(stdout.text)).toBe(
      '<stamp> [stackctl] [INFO] profile development (default)\n<stamp> [stackctl] [INFO] freeing dev ports\n',
    );
    expect(unstamped(stderr.text)).toBe(
      '<stamp> [stackctl] [ERROR] dev reverse proxy port 21050 is already in use by another program.\n',
    );
  });
});
