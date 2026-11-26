import { type AnyServiceConfig, getRegisteredPackages } from '../config';
import type { SessionStatus } from '../control-client';
import { currentEventsPath, sessionEndIn } from '../event-log';
import { type FoundSession, findSession, unresponsiveMessage } from '../find-session';
import { definesDevScript } from '../scripts';
import { writeSdkResult } from '../sdk-result';
import { sessionLogPath } from '../session-files';
import { waitUntilHealthy } from '../stack';
import { findConfigPath } from '../workspace-root';
import { when } from './status';
import { type StopTarget, activeTarget, noSessionLine } from './stop';
import { loadedConfigOrExit } from './workspace';

// `stackctl wait`: blocks until the profile's session is ready, the one a script or an agent
// started in the background. It waits for the session to appear, then for what `startStack()` waits
// on: the services it starts and the infra. Read-only: it never starts, stops or asks the session
// anything but its status and events.

/** How long `wait` waits when `--timeout` doesn't say, in seconds. */
export const DEFAULT_WAIT_TIMEOUT_S = 300;

/** How often the session is looked for until it answers with its services. */
const POLL_MS = 200;

export interface WaitOptions {
  /** In seconds. */
  timeout?: number;
  /** Wait for the session to appear (`wait`), or fail at once without one (`attach()`). Default `true`. */
  waitForStart?: boolean;
}

/** What a run finds the session with, and the config's services. */
export interface WaitContext {
  root: string;
  target: StopTarget;
  /** The config's application services. */
  services: AnyServiceConfig[];
  configPath?: string;
  apiPort?: number;
  /** Seams for tests. */
  find?: (opts: Parameters<typeof findSession>[0]) => Promise<FoundSession>;
  wait?: typeof waitUntilHealthy;
  log?: (line: string) => void;
  error?: (line: string) => void;
  pollMs?: number;
  /** When this wait began, in ms: when its process started, unless given. */
  since?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The services of `status` a session starts, so a wait waits on them: those with a dev command
 * and no `autostart: false`, as the session itself picks what `startStack()` waits on.
 */
function servicesThatStart(status: SessionStatus, services: AnyServiceConfig[]): string[] {
  const byName = new Map(services.map((service) => [service.name, service]));
  return Object.keys(status.services ?? {}).filter((name) => {
    const service = byName.get(name);
    return service !== undefined && definesDevScript(service) && service.autostart !== false;
  });
}

/** The profile's latest session, when its start failed: why, when, and its log. */
interface FailedStart {
  error: string;
  /** When it ended, in ms. */
  at: number;
  /** As `status` dates it: `today 11:41:53`. */
  when: string;
  logFile: string;
}

/**
 * How the profile's latest session ended, when no session runs and its start failed: read from
 * its event log, which outlives it. `null` when it ended any other way, or left no end.
 */
function lastFailedStart(root: string, profile: string): FailedStart | null {
  const end = sessionEndIn(currentEventsPath(root, profile));
  if (end?.cause !== 'error') {
    return null;
  }
  return {
    error: end.error ?? 'see its log',
    at: Date.parse(end.time),
    when: when(end.time),
    logFile: end.sessionId === null ? 'its log' : sessionLogPath(root, profile, end.sessionId),
  };
}

/** A ready session, as `wait` and the SDK's `attach()` hand it on. */
export interface WaitedSession {
  pid: number;
  port: number;
  profile: string;
  profileSource: SessionStatus['profileSource'];
  logFile: string | null;
  /** The services it started, and so waited on. */
  services: string[];
  /** The workspace root: the directory holding its config. */
  workspaceDir: string;
}

/**
 * Waits for the profile's session to be ready, as `startStack()` waits: the services it starts,
 * and the infra. With `waitForStart`, first for the session to appear; without, a session not
 * running now is an error at once. Resolves with the session, or the error to print.
 */
export async function awaitSessionReady(
  opts: { timeoutS: number; waitForStart: boolean },
  ctx: WaitContext,
): Promise<{ ready: WaitedSession } | { error: string }> {
  const { profile } = ctx.target;
  const timeoutMs = opts.timeoutS * 1000;
  const deadline = Date.now() + timeoutMs;

  // A session that fails its start is gone at once, leaving why in its event log. One that ended
  // since this wait began is the one it waits for; an earlier one may be an older session, so it
  // is only named if no session comes.
  const since = ctx.since ?? Date.now() - Math.round(process.uptime() * 1000);
  const failedToStart = (failed: FailedStart) =>
    `stackctl: the ${profile} session failed to start: ${failed.error}. See ${failed.logFile}`;
  const lastOne = (failed: FailedStart | null) =>
    failed
      ? `the last one failed to start (${failed.when}): ${failed.error}. See ${failed.logFile}`
      : null;

  // Until the session answers with its services: it may not have written its record yet, nor
  // started its control API, nor brought up its infra.
  let seen: SessionStatus | null = null;
  let found: FoundSession;
  for (;;) {
    found = await (ctx.find ?? findSession)({
      workspaceDir: ctx.root,
      profile,
      configPath: ctx.configPath,
      apiPort: ctx.apiPort,
    });
    if (found.kind === 'running') {
      seen = found.status;
      if (found.status.services !== null) {
        break;
      }
    } else if (found.kind === 'none' && seen !== null) {
      const failed = lastFailedStart(ctx.root, profile);
      return {
        error: failed
          ? failedToStart(failed)
          : `stackctl: the ${profile} session ended while starting; see ${seen.logFile ?? 'its log'}`,
      };
    } else if (found.kind === 'none' && !opts.waitForStart) {
      const last = lastOne(lastFailedStart(ctx.root, profile));
      return { error: `${noSessionLine(ctx.target)}${last ? ` ${last.charAt(0).toUpperCase()}${last.slice(1)}` : ''}` }; // oxfmt-ignore
    } else if (found.kind === 'unresponsive' && !opts.waitForStart) {
      return { error: `stackctl: ${unresponsiveMessage(found, profile)}` };
    } else if (found.kind === 'none') {
      const failed = lastFailedStart(ctx.root, profile);
      if (failed && failed.at >= since) {
        return { error: failedToStart(failed) };
      }
    }
    if (Date.now() >= deadline) {
      const last = found.kind === 'none' ? lastOne(lastFailedStart(ctx.root, profile)) : null;
      return {
        error:
          found.kind === 'unresponsive'
            ? `stackctl: ${unresponsiveMessage(found, profile)}`
            : `stackctl: no ${profile} session started within ${String(opts.timeoutS)}s${last ? `; ${last}` : ''}`,
      };
    }
    await sleep(ctx.pollMs ?? POLL_MS);
  }

  const { client, status, record } = found;
  const services = servicesThatStart(status, ctx.services);
  const verdict = await (ctx.wait ?? waitUntilHealthy)(client, services, {
    deadline,
    timeoutMs,
    logFile: status.logFile ?? 'the session log',
    infra: true,
  });
  if (verdict !== undefined) {
    return { error: `stackctl: ${verdict}` };
  }
  return {
    ready: {
      pid: status.pid,
      port: record?.port ?? client.port,
      profile: status.profile,
      profileSource: status.profileSource,
      logFile: status.logFile,
      services,
      workspaceDir: ctx.root,
    },
  };
}

/** Runs `wait` against the profile's session; resolves with the exit code. */
export async function runWaitCommand(opts: WaitOptions, ctx: WaitContext): Promise<number> {
  const log = ctx.log ?? ((line: string) => console.log(line));
  const error = ctx.error ?? ((line: string) => console.error(line));
  const seconds = opts.timeout ?? DEFAULT_WAIT_TIMEOUT_S;
  if (!(seconds > 0)) {
    error('--timeout takes a number of seconds above 0.');
    return 1;
  }
  const outcome = await awaitSessionReady(
    { timeoutS: seconds, waitForStart: opts.waitForStart ?? true },
    ctx,
  );
  if ('error' in outcome) {
    error(outcome.error);
    return 1;
  }
  const { ready } = outcome;
  log(
    `${ready.profile} session ready: pid ${String(ready.pid)}, control API on ${String(ready.port)}, log ${String(ready.logFile)}`,
  );
  writeSdkResult(ready);
  return 0;
}

/** `stackctl wait`: loads the config, then waits on the profile's session. */
export async function runWait(opts: WaitOptions): Promise<number> {
  const config = await loadedConfigOrExit();
  const root = process.cwd();
  return runWaitCommand(opts, {
    root,
    target: activeTarget(),
    services: getRegisteredPackages(),
    configPath: findConfigPath(root) ?? undefined,
    apiPort: config.apiPort,
  });
}
