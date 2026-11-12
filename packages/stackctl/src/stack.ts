import { type ChildProcess, fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ControlClient, SessionEvent, SessionServiceStatus } from './control-client.js';
import {
  DETACHED_SESSION_VAR,
  type ModeSource,
  assertOutsideCli,
  rejectUnknownOptions,
} from './env-base.js';
import type { InfraStatus } from './infra/control.js';
import type { ServiceName } from './register.js';

// `startStack()`: a headless session forked as this process's child, for a test suite's setup. It
// runs the CLI rather than stackctl in-process, so the config loads in a process of its own and
// the caller's module state and environment are left alone. The session ends with this process.

/** The options of {@link StartStackOptions}, checked at runtime since a JavaScript caller bypasses the types. */
const START_STACK_OPTIONS = [
  'services',
  'mode',
  'workspaceDir',
  'waitTimeout',
  'logDir',
  'killOthers',
  'env',
];

export interface StartStackOptions<P extends string = ServiceName> {
  /** The services to bring up, as `-s` names them. Their deps and the mode's infra come too. */
  services: P[];
  /** The mode, as `--mode` takes it. Unset, the CLI resolves it as it does from a shell. */
  mode?: string;
  /**
   * The workspace: the directory holding `stackctl.config.ts`, as `--workspace-dir` takes it. Not
   * searched upward from. Default: the nearest directory at or above `process.cwd()` that has one.
   */
  workspaceDir?: string;
  /** How long to wait for everything to be healthy, in seconds. Default 300. */
  waitTimeout?: number;
  /** A session's log directory, as `--log-dir` takes it. */
  logDir?: string;
  /**
   * Quit a session of the mode already running in the workspace, and start this one in its
   * place, as `--kill-others` does. Without it, a running one fails the call.
   */
  killOthers?: boolean;
  /**
   * The environment the session starts with. Default: this process's, without what a package
   * manager script and a test runner add to it (see {@link stackEnvironment}). Given, it is used
   * as it is.
   */
  env?: NodeJS.ProcessEnv;
}

export interface Stack<P extends string = ServiceName> {
  /** Always `started`: a stack's session is the one its call started. */
  session: 'started';
  /** The session's pid. */
  pid: number;
  /** The session's control-API port. */
  port: number;
  mode: string;
  /** Where the session's mode came from: `flag` when `mode` was given. */
  modeSource: ModeSource | null;
  /** The session's logfile. */
  logFile: string | null;
  /**
   * The services the session brought up: the ones asked for, and their deps. One with
   * `autostart: false` is left out: it stays `stopped`, asked for or not.
   */
  services: P[];
  /**
   * Every configured service's origin, selected or not: its public origin (`publicOrigin`), at the
   * host of its route under the dev reverse proxy, `http://localhost:<port>` for one no route
   * names. A service with no `port` has none, and neither does one the proxy reaches only through
   * `'*'` or `paths`.
   */
  origins: Partial<Record<P, string>>;
  /**
   * The dev reverse proxy's canonical domain (`reverseProxy.publicAddress.domain`), or null when
   * the config declares no proxy.
   */
  domain: string | null;
  /** A client for the session's control API. */
  control: ControlClient<P>;
  /** Quits the session, resolving once it has exited. */
  stop(): Promise<void>;
}

/** What a forked session sends its parent over the IPC channel. */
export interface StackMessage {
  type: 'started';
  pid: number;
  /** Its control-API port, listening by now. */
  port: number;
  sessionId: string;
  logFile: string;
  /**
   * What it launches, and so what its parent waits on: the selected services and their deps, less
   * those with `autostart: false`, which stay `stopped`.
   */
  services: string[];
}

/** How long to wait for health when `waitTimeout` doesn't say, in seconds. */
const DEFAULT_WAIT_TIMEOUT_S = 300;

/** How long `stop()` gives a session to exit after its quit, and again after a SIGTERM. */
const STOP_GRACE_MS = 30_000;

/**
 * How long everything must stay ready before the stack counts as up: a service with no healthcheck
 * is ready the moment it runs, before it can have failed.
 */
const SETTLE_MS = 1000;

/** How much of the session's own output an error quotes. */
const OUTPUT_TAIL_LINES = 20;

/**
 * A wait that doesn't keep the process running: the session's child process and channel do that
 * while there is one to wait on.
 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** Progress, on stderr. */
const note = (message: string) => console.error(`stackctl: ${message}`);

/**
 * Brings up a headless session with `services`, as this process's child, and waits until every one
 * of them, and the mode's infra, is healthy; one with `autostart: false` stays `stopped` and isn't
 * waited on. The session ends with this process, however it ends. A session of the mode already
 * running fails the call, unless `killOthers` quits it. Throws stackctl's error, with the log's
 * path, after quitting the session. Can't be called inside stackctl's own process (a config or its
 * callbacks).
 */
export async function startStack<P extends string = ServiceName>(
  options: StartStackOptions<P>,
): Promise<Stack<P>> {
  // A config that started a stack as it loaded would fork a session that loads it again, and so on.
  assertOutsideCli('startStack');
  rejectUnknownOptions('startStack', options, START_STACK_OPTIONS);
  const args = [
    ...(options.mode === undefined ? [] : ['--mode', options.mode]),
    ...(options.workspaceDir === undefined ? [] : ['--workspace-dir', options.workspaceDir]),
    'start',
    '--headless',
    ...options.services.flatMap((name) => ['-s', name]),
    ...(options.killOthers ? ['--kill-others'] : []),
    ...(options.logDir === undefined ? [] : ['--log-dir', options.logDir]),
  ];
  note(`starting a session: ${options.services.join(', ')}`);
  const launched = await launchSession<P>({
    args,
    cwd: process.cwd(),
    env: options.env ?? stackEnvironment(),
    waitTimeout: options.waitTimeout ?? DEFAULT_WAIT_TIMEOUT_S,
    detached: false,
    end: (session) => endChild(session),
  }).catch((error: unknown) => {
    throw error instanceof SessionStartError ? new Error(error.message) : error;
  });
  const { child, control } = launched;
  const stop = () => endChild(launched);
  // From here the session needn't keep this process running: it ends when this process does.
  child.unref();
  child.channel?.unref();
  return { session: 'started', ...launched.ready, control, stop };
}

/** What {@link launchSession}'s session reports once it is healthy: the fields a stack and `start --detach`'s line are built from. */
export interface ReadySession<P extends string = ServiceName> {
  pid: number;
  port: number;
  mode: string;
  modeSource: ModeSource | null;
  logFile: string | null;
  services: P[];
  origins: Partial<Record<P, string>>;
  domain: string | null;
}

/** A session {@link launchSession} forked, as its failure cleanup is handed it. */
export interface ForkedSession {
  child: ChildProcess;
  /** Resolves once the session has exited. */
  exited: Promise<void>;
  /** Whether it has exited. */
  gone: () => boolean;
  /** Its control-API port and pid, once it has said it is up; null before. */
  started: StackMessage | null;
}

/** A session {@link launchSession} brought up: still the caller's child, its channel open. */
export type LaunchedSession<P extends string = ServiceName> = ForkedSession & {
  started: StackMessage;
  control: ControlClient<P>;
  ready: ReadySession<P>;
};

/**
 * Why {@link launchSession}'s session didn't come up, thrown once the session has been ended:
 * `message` is the whole of it, as `startStack()` throws it; `reason`, `logFile` and `outputTail`
 * are its parts.
 */
export class SessionStartError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    /** The session's log, once it has said where it is. */
    readonly logFile: string | null,
    /** The last lines of the session's own output (stdout and stderr). */
    readonly outputTail: string,
    /** The session's pid. */
    readonly pid: number | undefined,
  ) {
    super(message);
  }
}

/**
 * Forks the CLI (`args`) as a headless session and waits until every service it runs, and the
 * mode's infra, is healthy: what `startStack()` and `start --detach` share. The session's output
 * goes to an unlinked file, never this process's stdio. Either way the session ends when its IPC
 * channel closes, as this process does however it ends. `detached` starts it in a process group
 * of its own, and has it stop ending with its channel once it is sent a `release` message
 * (`RELEASE_MESSAGE`), which the caller sends before it lets go.
 *
 * On a failure — it exits while starting, a selected service stops, `waitTimeout` passes, or
 * `signal` aborts — the session is ended (with `end` once it has said it is up, by signals before)
 * and a {@link SessionStartError} is thrown. On success the child is still referenced, and its
 * channel open: what's left is the caller's to let go of.
 */
export async function launchSession<P extends string = ServiceName>(opts: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** In seconds. */
  waitTimeout: number;
  detached: boolean;
  /** How many lines of the session's own output a failure quotes; default 20. */
  outputTailLines?: number;
  signal?: AbortSignal;
  /** Ends a session that has said it is up; it may have exited by then. */
  end: (session: ForkedSession & { started: StackMessage }) => Promise<void>;
}): Promise<LaunchedSession<P>> {
  const { createControlClient } = await import('./control-client.js');
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const timeoutMs = opts.waitTimeout * 1000;
  const deadline = Date.now() + timeoutMs;

  // The session's own output, before its log starts and a crash's: a file, never a pipe, which
  // would fill (and hold the session) once this process stopped reading it.
  const output = openOutput(opts.outputTailLines ?? OUTPUT_TAIL_LINES);
  let child: ChildProcess;
  try {
    child = fork(cli, opts.args, {
      cwd: opts.cwd,
      env: opts.detached ? { ...opts.env, [DETACHED_SESSION_VAR]: '1' } : opts.env,
      // Not this process's flags, a test runner's loaders among them. The cap a session starts
      // itself over with otherwise: a forked one can't, its channel wouldn't survive it.
      execArgv: ['--max-semi-space-size=2'],
      stdio: ['ignore', output.fd, output.fd, 'ipc'],
      detached: opts.detached,
    });
  } finally {
    // The session holds the file from here: nothing is left on the disk whoever outlives whom.
    output.unlink();
  }
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });
  const gone = () => exit !== null;
  const describeExit = () => {
    const e = exit as { code: number | null; signal: NodeJS.Signals | null } | null;
    return e?.signal ? `was killed by ${e.signal}` : `exited with code ${String(e?.code)}`;
  };
  const aborted = new Promise<'aborted'>((resolve) => {
    if (opts.signal?.aborted) {
      resolve('aborted');
    }
    opts.signal?.addEventListener('abort', () => resolve('aborted'), { once: true });
  });

  const started = await Promise.race<StackMessage | 'exited' | 'timeout' | 'aborted'>([
    new Promise((resolve) => child.once('message', (m) => resolve(m as StackMessage))),
    exited.then(() => 'exited' as const),
    sleep(timeoutMs).then(() => 'timeout' as const),
    aborted,
  ]);
  if (started === 'exited') {
    const tail = output.tail();
    output.remove();
    const reason = `stackctl ${describeExit()} before the session was up`;
    throw new SessionStartError(
      `${reason}${tail ? `:\n${tail}` : ''}`,
      reason,
      null,
      tail,
      child.pid,
    );
  }
  if (started === 'timeout' || started === 'aborted') {
    // Not up, so nothing to quit through the control API: a SIGTERM is the session's cue to end
    // at any step before that, and then the signals that follow should it not.
    child.kill('SIGTERM');
    await stopChild(child, exited, gone);
    const tail = output.tail();
    output.remove();
    const reason =
      started === 'aborted'
        ? 'interrupted before the session was up'
        : `the session didn't come up within ${String(timeoutMs / 1000)}s`;
    throw new SessionStartError(`stackctl: ${reason}${tail ? `:\n${tail}` : ''}`, reason, null, tail, child.pid); // oxfmt-ignore
  }

  const session = { child, exited, gone, started };
  const control = createControlClient<P>(started.port);
  const fail = async (error: string): Promise<never> => {
    // Read before the session is ended, which it would then have exited for.
    const reason = gone() ? `the session ${describeExit()} while starting` : error;
    const tail = output.tail();
    output.remove();
    // The failure that matters is the one being thrown; a failed quit is only reported beside it.
    await opts.end(session).catch((quitError: unknown) => console.error(quitError));
    throw new SessionStartError(
      `stackctl: ${reason} (log: ${started.logFile})${tail && gone() ? `:\n${tail}` : ''}`,
      reason,
      started.logFile,
      tail,
      started.pid,
    );
  };
  note(`session up (pid ${String(started.pid)}, control port ${String(started.port)})`);

  const wanted = started.services as P[];
  const verdict = await waitUntilHealthy(control, wanted, {
    deadline,
    exited,
    signal: opts.signal,
    timeoutMs,
    logFile: started.logFile,
  });
  if (verdict !== undefined) {
    return fail(verdict);
  }
  // Up: the session's output is in its log from here on.
  output.remove();

  const status = await control.query.status();
  if (opts.signal?.aborted) {
    return fail('interrupted while starting');
  }
  if (!status?.config) {
    return fail(`the session on port ${String(started.port)} did not report its config`);
  }
  const origins = originsOf<P>(status.config);
  return {
    ...session,
    control,
    ready: {
      pid: started.pid,
      port: started.port,
      mode: status.mode,
      modeSource: status.modeSource,
      logFile: status.logFile,
      services: wanted,
      origins,
      domain: status.reverseProxy?.domain ?? null,
    },
  };
}

/**
 * How `startStack()` ends its session, after a failure or on `stop()`: the quit, then signals until
 * the session has exited.
 */
async function endChild({
  child,
  exited,
  gone,
  started,
}: ForkedSession & { started: StackMessage }) {
  if (gone()) {
    return;
  }
  // Kept running until the session has exited, which `startStack` may have stopped holding it for.
  child.ref();
  child.channel?.ref();
  const { createControlClient } = await import('./control-client.js');
  // A session that exits before it acks has quit all the same.
  await createControlClient(started.port).command.quit();
  await stopChild(child, exited, gone);
}

/**
 * Follows the session's `/events` until every one of `wanted` is ready, and the infra too unless
 * `infra` is false. Returns why it gave up — a service stopped, the session gone or silent, the
 * deadline — or `undefined` once all of it is ready.
 */
export async function waitUntilHealthy<P extends string>(
  control: ControlClient<P>,
  wanted: P[],
  opts: {
    deadline: number;
    /** Settles when the session's process is gone, for a session this process started. */
    exited?: Promise<void>;
    signal?: AbortSignal;
    timeoutMs: number;
    logFile: string;
    /** Whether the infra must be running too; default true. */
    infra?: boolean;
  },
): Promise<string | undefined> {
  const waitsOnInfra = opts.infra ?? true;
  note(`waiting for ${wanted.length > 0 ? wanted.join(', ') : 'the infra'} to be healthy`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, opts.deadline - Date.now()));
  void opts.exited?.then(() => controller.abort());
  opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const services: Partial<Record<string, SessionServiceStatus>> = {};
  const ready: Partial<Record<string, boolean>> = {};
  const infra: Record<string, InfraStatus> = {};
  let attached = false;
  let pending: string[] = [...wanted];
  // Set while everything is ready, to when it has been so for long enough.
  let settled: ReturnType<typeof setTimeout> | undefined;
  let healthy = false;
  try {
    for await (const event of control.events({ signal: controller.signal })) {
      if (!apply(event, { services, ready, infra })) {
        continue;
      }
      attached ||= event.type !== 'snapshot' || event.services !== null;
      if (!attached) {
        continue;
      }
      const stopped = wanted.filter((name) => services[name] === 'stopped');
      if (stopped.length > 0) {
        return `${stopped.join(', ')} stopped while starting; see ${opts.logFile}`;
      }
      pending = [
        ...Object.entries(waitsOnInfra ? infra : {})
          .filter(([, state]) => state !== 'running')
          .map(([name]) => `infra service ${name}`),
        ...wanted.filter((name) => ready[name] !== true),
      ];
      if (pending.length > 0) {
        clearTimeout(settled);
        settled = undefined;
      } else {
        settled ??= setTimeout(() => {
          healthy = true;
          controller.abort();
        }, SETTLE_MS);
      }
    }
  } catch (error) {
    return `lost the session's events: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timer);
    clearTimeout(settled);
    controller.abort();
  }
  if (healthy) {
    note('everything is healthy');
    return undefined;
  }
  if (opts.signal?.aborted) {
    return `interrupted while waiting for ${pending.join(', ')}`;
  }
  return Date.now() >= opts.deadline
    ? `not healthy after ${String(Math.round(opts.timeoutMs / 1000))}s: ${pending.join(', ')}`
    : 'the session ended its events while starting';
}

/** Folds an `/events` line into the state it tracks; false for one that changes nothing (a heartbeat). */
function apply(
  event: SessionEvent,
  state: {
    services: Partial<Record<string, SessionServiceStatus>>;
    ready: Partial<Record<string, boolean>>;
    infra: Record<string, InfraStatus>;
  },
): boolean {
  switch (event.type) {
    case 'snapshot':
      Object.assign(state.services, event.services ?? {});
      Object.assign(state.ready, event.ready ?? {});
      Object.assign(state.infra, event.infra ?? {});
      return true;
    case 'service-state':
      state.services[event.service] = event.status;
      state.ready[event.service] = event.ready;
      return true;
    case 'infra-state':
      state.infra[event.service] = event.status;
      return true;
    default:
      // `session-state`, `heartbeat`, and the event log's commands and lifecycle: no state to fold.
      return false;
  }
}

/** Waits for a child the quit already reached to exit; SIGTERM, then SIGKILL, if it doesn't. */
export async function stopChild(child: ChildProcess, exited: Promise<void>, gone: () => boolean) {
  for (const signal of [null, 'SIGTERM', 'SIGKILL'] as const) {
    if (gone()) {
      return;
    }
    if (signal) {
      child.kill(signal);
    }
    await Promise.race([exited, sleep(STOP_GRACE_MS)]);
  }
  if (!gone()) {
    throw new Error(`the stackctl session (pid ${String(child.pid)}) did not exit`);
  }
}

/** A file for the session's own output, unlinked as soon as the session holds it, read through its descriptor. */
function openOutput(tailLines: number): {
  fd: number;
  unlink: () => void;
  tail: () => string;
  remove: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-stack-'));
  const file = path.join(dir, 'output');
  // Appended to by the session, read here by position: one descriptor for both.
  const fd = fs.openSync(file, 'a+');
  let open = true;
  return {
    fd,
    // Once the session holds it: from then on it is gone from the disk with the last process that
    // has it open, whichever of this process and the session that is, however it ends.
    unlink: () => fs.rmSync(dir, { recursive: true, force: true }),
    tail: () => {
      if (!open) {
        return '';
      }
      try {
        const text = Buffer.alloc(fs.fstatSync(fd).size);
        fs.readSync(fd, text, 0, text.length, 0);
        return text.toString('utf8').trim().split('\n').slice(-tailLines).join('\n');
      } catch {
        return '';
      }
    },
    // The session may keep writing to it; this process lets go of it.
    remove: () => {
      if (open) {
        open = false;
        fs.closeSync(fd);
      }
    },
  };
}

/** The field of a resolved service its origin is. */
interface ServiceOrigin {
  publicOrigin?: string | null;
}

/**
 * Each service's origin in a resolved config, as `startStack()` reports it: its `publicOrigin`,
 * which the config has already settled — `http://localhost:<port>` for a service no route names,
 * and none for one with no `port` or one the dev reverse proxy reaches only through `'*'` or
 * `paths`.
 */
export function originsOf<P extends string = string>(config: unknown): Partial<Record<P, string>> {
  const services = (config as { services?: Record<string, ServiceOrigin> } | null)?.services ?? {};
  const origins: Partial<Record<P, string>> = {};
  for (const [name, service] of Object.entries(services)) {
    if (typeof service.publicOrigin === 'string') {
      origins[name as P] = service.publicOrigin;
    }
  }
  return origins;
}

/** Variables a package manager sets for the scripts it runs, and for the binaries it shims. */
const PACKAGE_MANAGER_VARS = ['INIT_CWD', 'NODE', 'NODE_PATH', 'PNPM_SCRIPT_SRC_DIR'];

/** Variables Vitest sets in its process when `VITEST` is set: its own, and Vite's env. */
const VITEST_VARS = ['NODE_ENV', 'MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL', 'TEST'];

/** Variables Jest sets in its process when `JEST_WORKER_ID` is set. */
const JEST_VARS = ['NODE_ENV', 'JEST_WORKER_ID'];

/**
 * `env` without what a package manager script and a test runner add to it, which would otherwise
 * reach every service of a session started from a test: `npm_*`, `INIT_CWD`, `NODE`, `NODE_PATH`
 * and `PNPM_SCRIPT_SRC_DIR`; under Vitest, `VITEST*`, `NODE_ENV`, `MODE`, `DEV`, `PROD`, `SSR`,
 * `BASE_URL` and `TEST`; under Jest, `JEST_WORKER_ID` and `NODE_ENV`. What an outer stackctl
 * added, the session drops itself.
 */
export function stackEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const drop = new Set(PACKAGE_MANAGER_VARS);
  if (env.VITEST !== undefined) {
    VITEST_VARS.forEach((key) => drop.add(key));
  }
  if (env.JEST_WORKER_ID !== undefined) {
    JEST_VARS.forEach((key) => drop.add(key));
  }
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !drop.has(key) &&
        !key.startsWith('npm_') &&
        !(env.VITEST !== undefined && key.startsWith('VITEST')),
    ),
  );
}
