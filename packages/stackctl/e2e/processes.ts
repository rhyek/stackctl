/**
 * Starting the CLI as a plain child process (headless runs, `start --detach`, `stop`), the
 * environment every CLI the suite starts gets, and the cleanup that makes sure no test leaves a
 * process behind.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  isInsideWorkspace,
  processCwd,
  processStartTime,
  resolveRealPath,
} from '../src/process-info.js';
import { cliPath } from './cli.js';

/** How a process ended: its exit code, or the signal that ended it. */
export interface Exit {
  code: number | null;
  signal: string | null;
}

/**
 * Variables a CI runner, a package manager, Vitest or an enclosing stackctl session sets, none of
 * which the CLI under test may see: `CI` (or any `CI_*`) makes Ink non-interactive and the profile
 * `test`, and a `STACKCTL_*` variable would point it at another session's profile or workspace.
 */
const DROP = new Set([
  'CI',
  'CONTINUOUS_INTEGRATION',
  'NODE_ENV',
  'MODE',
  'DEV',
  'PROD',
  'SSR',
  'BASE_URL',
  'TEST',
  'INIT_CWD',
  'NODE',
  'NODE_PATH',
  'PNPM_SCRIPT_SRC_DIR',
]);

/**
 * The environment of every CLI the suite starts: this process's, less {@link DROP} and the
 * `npm_*`, `VITEST*`, `STACKCTL_*` and `CI_*` variables, plus `extra`. `STACKCTL_STARTED_BY_AGENT=0` makes
 * a run under a coding agent behave as one in CI does. `E2E_OWNER_PID` is this test process: a
 * fixture service exits on its own once it's gone (see `fixture.ts`).
 */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !DROP.has(key) && !/^(npm_|VITEST|STACKCTL_|CI_)/.test(key)) {
      env[key] = value;
    }
  }
  return {
    ...env,
    STACKCTL_STARTED_BY_AGENT: '0',
    E2E_OWNER_PID: String(process.pid),
    ...extra,
  };
}

/** Resolves once `predicate` holds, checking every 50 ms; rejects with `describe()` after `timeout`. */
export async function until(
  predicate: () => boolean | Promise<boolean>,
  timeout: number,
  describe: () => string,
): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(timeout)} ms: ${describe()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A process the suite started, known by its pid and the start time read while it surely was it. */
export interface Owned {
  pid: number;
  startedAt: number | null;
}

/** Sends `signal` to `owned` (to its process group with `group`), only while it is still that process. */
export async function signalOwned(
  owned: Owned,
  signal: NodeJS.Signals,
  group = false,
): Promise<void> {
  if (owned.startedAt === null || (await processStartTime(owned.pid)) !== owned.startedAt) {
    return;
  }
  try {
    process.kill(group ? -owned.pid : owned.pid, signal);
  } catch {
    /* gone */
  }
}

/**
 * A CLI run as a plain child process, its stdout and stderr collected. `close()` ends it if a test
 * didn't: SIGTERM (the CLI's own graceful shutdown, which stops its services), then SIGKILL.
 */
export class CliProcess {
  readonly child: ChildProcess;
  readonly owned: Owned;
  stdout = '';
  stderr = '';
  exit: Exit | null = null;
  readonly exited: Promise<Exit>;

  private constructor(child: ChildProcess, owned: Owned) {
    this.child = child;
    this.owned = owned;
    child.stdout!.on('data', (chunk: Buffer) => (this.stdout += chunk.toString()));
    child.stderr!.on('data', (chunk: Buffer) => (this.stderr += chunk.toString()));
    this.exited = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        this.exit = { code, signal };
        resolve(this.exit);
      });
    });
  }

  static async start(
    args: string[],
    opts: { cwd: string; env?: Record<string, string> },
  ): Promise<CliProcess> {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: opts.cwd,
      env: childEnv(opts.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid!;
    const proc = new CliProcess(child, { pid, startedAt: await processStartTime(pid) });
    live.add(proc);
    void proc.exited.then(() => live.delete(proc));
    return proc;
  }

  /** Waits for `needle` in stdout; rejects with what was printed after `timeout`. */
  async waitForOutput(needle: string | RegExp, timeout = 30_000): Promise<void> {
    await until(
      () => (typeof needle === 'string' ? this.stdout.includes(needle) : needle.test(this.stdout)),
      timeout,
      () =>
        `${String(needle)} never printed\n--- stdout:\n${this.stdout}\n--- stderr:\n${this.stderr}`,
    );
  }

  async waitForExit(timeout = 30_000): Promise<Exit> {
    await until(
      () => this.exit !== null,
      timeout,
      () => `the CLI never exited\n--- stdout:\n${this.stdout}\n--- stderr:\n${this.stderr}`,
    );
    return this.exit!;
  }

  async close(): Promise<void> {
    if (this.exit) {
      return;
    }
    await signalOwned(this.owned, 'SIGTERM');
    await this.waitForExit(15_000).catch(async () => {
      await signalOwned(this.owned, 'SIGKILL', true);
    });
  }
}

/** Runs the CLI to its exit, as {@link CliProcess} does. */
export async function runCli(
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; timeout?: number },
): Promise<CliProcess> {
  const proc = await CliProcess.start(args, opts);
  await proc.waitForExit(opts.timeout ?? 60_000);
  return proc;
}

/** Everything still running that the suite started, ended by {@link closeAll}. */
const live = new Set<{ close(): Promise<void> }>();

/** Registers a process for {@link closeAll}; returns the function that unregisters it. */
export function track(proc: { close(): Promise<void> }): () => void {
  live.add(proc);
  return () => live.delete(proc);
}

/** Ends every process the suite started and still runs (see {@link CliProcess.close}). */
export async function closeAll(): Promise<void> {
  await Promise.all([...live].map((proc) => proc.close()));
  live.clear();
}

/**
 * Kills every fixture service of `workspace` still running: a fixture service writes its pid into
 * `<workspace>/.e2e-pids/` as it starts and removes it as it exits. Only a process whose working
 * directory is inside the workspace is killed, so a pid reused since can't take another process
 * with it. Resolves with the services it had to kill.
 */
export async function killStrayServices(workspace: string): Promise<string[]> {
  const dir = path.join(workspace, '.e2e-pids');
  const killed: string[] = [];
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const pid = Number(fs.readFileSync(path.join(dir, file), 'utf8'));
    const cwd = await processCwd(pid);
    if (cwd !== null && isInsideWorkspace(resolveRealPath(workspace), resolveRealPath(cwd))) {
      try {
        process.kill(pid, 'SIGKILL');
        killed.push(file);
      } catch {
        /* gone */
      }
    }
    fs.rmSync(path.join(dir, file), { force: true });
  }
  return killed;
}

/** The ports of `ports` something listens on (on 127.0.0.1). */
export async function listening(ports: number[]): Promise<number[]> {
  const open = await Promise.all(
    ports.map(
      (port) =>
        new Promise<boolean>((resolve) => {
          const socket = net.connect({ host: '127.0.0.1', port });
          socket.setTimeout(1000);
          socket.once('connect', () => {
            socket.destroy();
            resolve(true);
          });
          socket.once('error', () => resolve(false));
          socket.once('timeout', () => {
            socket.destroy();
            resolve(false);
          });
        }),
    ),
  );
  return ports.filter((_, i) => open[i]);
}
