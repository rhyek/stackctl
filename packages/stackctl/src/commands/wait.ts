import { type AnyServiceConfig, getRegisteredPackages } from '../config.js';
import type { SessionStatus } from '../control-client.js';
import { type FoundSession, findSession, unresponsiveMessage } from '../find-session.js';
import { definesDevScript } from '../scripts.js';
import { waitUntilHealthy } from '../stack.js';
import { findConfigPath } from '../workspace-root.js';
import { type StopTarget, activeTarget } from './stop.js';
import { loadedConfigOrExit } from './workspace.js';

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

/** Runs `wait` against the profile's session; resolves with the exit code. */
export async function runWaitCommand(opts: WaitOptions, ctx: WaitContext): Promise<number> {
  const log = ctx.log ?? ((line: string) => console.log(line));
  const error = ctx.error ?? ((line: string) => console.error(line));
  const seconds = opts.timeout ?? DEFAULT_WAIT_TIMEOUT_S;
  if (!(seconds > 0)) {
    error('--timeout takes a number of seconds above 0.');
    return 1;
  }
  const { profile } = ctx.target;
  const timeoutMs = seconds * 1000;
  const deadline = Date.now() + timeoutMs;

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
      error(
        `stackctl: the ${profile} session ended while starting; see ${seen.logFile ?? 'its log'}`,
      );
      return 1;
    }
    if (Date.now() >= deadline) {
      error(
        found.kind === 'unresponsive'
          ? `stackctl: ${unresponsiveMessage(found, profile)}`
          : `stackctl: no ${profile} session started within ${String(seconds)}s`,
      );
      return 1;
    }
    await sleep(ctx.pollMs ?? POLL_MS);
  }

  const { client, status, record } = found;
  const verdict = await (ctx.wait ?? waitUntilHealthy)(
    client,
    servicesThatStart(status, ctx.services),
    { deadline, timeoutMs, logFile: status.logFile ?? 'the session log', infra: true },
  );
  if (verdict !== undefined) {
    error(`stackctl: ${verdict}`);
    return 1;
  }
  const port = record?.port ?? ctx.apiPort;
  log(
    `${status.profile} session ready: pid ${String(status.pid)}, control API on ${String(port)}, log ${String(status.logFile)}`,
  );
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
