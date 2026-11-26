import { type AnyServiceConfig, getLoadedConfig, getRegisteredPackages } from '../config';
import type { ControlClient, SessionStatus } from '../control-client';
import { type FoundSession, findSession, unresponsiveMessage } from '../find-session';
import { retryAdvice } from '../retry-advice';
import { definesDevScript } from '../scripts';
import { writeSdkResult } from '../sdk-result';
import { pendingNames, waitUntilHealthy } from '../stack';
import { UnknownTagError } from '../tags';
import { TargetNotFoundError, resolveServiceSelection } from '../target';
import { findConfigPath } from '../workspace-root';
import { type StopTarget, activeTarget, noSessionLine, otherSessionLines } from './stop';
import { loadedConfigOrExit } from './workspace';

// `stackctl service start|stop|restart -s <name>…`: drives application services of the profile's
// running session through its control API. It never starts a session of its own.

export type ServiceCommand = 'start' | 'stop' | 'restart';

/** How long `start` and `restart` wait for the services to be ready when `--wait-timeout` doesn't say, in seconds. */
export const DEFAULT_SERVICE_WAIT_TIMEOUT_S = 300;

export interface ServiceCommandOptions {
  /** The `-s` values, names or paths, in the order given. */
  services: string[];
  /** The `-t` tags: every application service that has one is acted on too. */
  tags: string[];
  /** Seconds `start` and `restart` wait for the services to be ready. */
  waitTimeout?: number;
}

/** What a run checks names against and finds the session with. */
export interface ServiceCommandContext {
  root: string;
  /** What a relative `-s` path resolves against. */
  base: string;
  target: StopTarget;
  /** The config's application services. */
  services: AnyServiceConfig[];
  /** The config's infra services' names. */
  infra: string[];
  configPath?: string;
  apiPort?: number;
  /** Seams for tests. */
  find?: (opts: Parameters<typeof findSession>[0]) => Promise<FoundSession>;
  wait?: typeof waitUntilHealthy;
  /** How often a stop that is taking a while asks the session what it still runs; 1 s unless given. */
  pollMs?: number;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Called with what happened to each service, once the command acted on the session. */
  onResults?: (results: ServiceResult[]) => void;
}

/** What a `service` command did to one service: the SDK's `service.*` resolve with these. */
export interface ServiceResult {
  /** The service's name. */
  service: string;
  /** `running` once started or restarted and ready, `stopped`, or `failed`. */
  status: 'running' | 'stopped' | 'failed';
  /** Why it failed. */
  error?: string;
}

/** Why `service <action>` turns these names away, as infra services, or `undefined`. */
function infraRefusal(
  action: ServiceCommand,
  names: readonly string[],
  infraNames: string[],
): string | undefined {
  const infra = names.filter((name) => infraNames.includes(name));
  if (infra.length > 0) {
    return `${infra.join(', ')} ${infra.length > 1 ? 'are infra services' : 'is an infra service'}: service ${action} takes application services only`;
  }
  return undefined;
}

/**
 * The services `service <action>` acts on: the `-s` values as service names, and the services
 * with a `-t` tag, less one that only a tag picked and that `start` or `restart` would refuse
 * for having no dev command; or why there are none to act on.
 */
function selectServices(
  action: ServiceCommand,
  opts: ServiceCommandOptions,
  ctx: ServiceCommandContext,
): { names: string[] } | { refusal: string } {
  // As typed first: an infra service's name is neither a service nor a directory.
  const infra = infraRefusal(action, [...new Set(opts.services)], ctx.infra);
  if (infra) {
    return { refusal: infra };
  }
  let names: string[];
  try {
    const selection = resolveServiceSelection({ targets: opts.services, tags: opts.tags }, ctx);
    if (opts.tags.length === 0) {
      return { names: selection.names };
    }
    const byName = new Map(ctx.services.map((service) => [service.name, service]));
    names = selection.names.filter(
      (name) =>
        action === 'stop' ||
        !selection.fromTagOnly.has(name) ||
        definesDevScript(byName.get(name)!),
    );
  } catch (err) {
    if (err instanceof TargetNotFoundError || err instanceof UnknownTagError) {
      return { refusal: err.message };
    }
    throw err;
  }
  if (names.length === 0) {
    return {
      refusal: `no service tagged ${[...new Set(opts.tags)].join(', ')} has a dev command`,
    };
  }
  return { names };
}

/** Why `service <action>` can't run with these names and wait, or `undefined` when it can. */
export function serviceRefusal(
  action: ServiceCommand,
  names: string[],
  known: { services: AnyServiceConfig[]; infra: string[] },
  waitTimeout?: number,
): string | undefined {
  if (waitTimeout !== undefined && !(waitTimeout > 0)) {
    return '--wait-timeout takes a number of seconds above 0.';
  }
  if (names.length === 0) {
    return `service ${action} needs at least one service: stackctl service ${action} -s <name>, or -t <tag>`;
  }
  const infra = infraRefusal(action, names, known.infra);
  if (infra) {
    return infra;
  }
  const byName = new Map(known.services.map((service) => [service.name, service]));
  if (action !== 'stop') {
    const commandless = names.filter((name) => !definesDevScript(byName.get(name)!));
    if (commandless.length > 0) {
      return `${commandless.join(', ')} ${commandless.length > 1 ? 'have' : 'has'} no dev command, so can't be ${action === 'start' ? 'started' : 'restarted'}`;
    }
  }
  return undefined;
}

/** The line for a service an action has reached, by what the session said of it before. */
function actedLine(
  action: ServiceCommand,
  name: string,
  before: SessionStatus['services'],
  hooks: SessionStatus['serviceHooks'],
): string {
  const was = before?.[name];
  switch (action) {
    case 'stop': {
      // A hook of its own still ran (a start's, or an earlier stop's): this stop abandoned it.
      const hook = hooks?.[name];
      if (hook) {
        return `stopped ${name}: its ${hook} was still running, and was abandoned`;
      }
      return was === undefined || was === 'stopped'
        ? `${name} is already stopped`
        : `stopped ${name}`;
    }
    case 'start':
      return was === 'running' ? `${name} is already running` : `started ${name}`;
    case 'restart':
      return `restarting ${name}`;
  }
}

/** How often a stop that is taking a while asks the session which hook it still runs. */
const STOP_POLL_MS = 1_000;

/** How many of those questions in a row may go unanswered before the stop is given up on. */
const STOP_UNANSWERED = 5;

/**
 * Stops `name` and waits for it, however long its stop hooks take: they have no time limit.
 * While one still runs, one line names it and says how to abandon it. Resolves with whether the
 * session said the stop is done; `false` when it stopped answering.
 */
async function stopAndWait(
  client: ControlClient,
  name: string,
  log: (line: string) => void,
  pollMs: number,
): Promise<boolean> {
  const giveUp = new AbortController();
  const stop = { done: false };
  const stopped = client.command.service.stop(name, { signal: giveUp.signal }).finally(() => {
    stop.done = true;
  });
  const watch = async () => {
    let told = false;
    let unanswered = 0;
    while (!stop.done) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
      if (stop.done) {
        return;
      }
      const now = await client.query.status().catch(() => null);
      if (stop.done) {
        return;
      }
      if (!now) {
        if (++unanswered >= STOP_UNANSWERED) {
          giveUp.abort();
          return;
        }
        continue;
      }
      unanswered = 0;
      const hook = now.serviceHooks?.[name];
      if (!told && (hook === 'beforeStop' || hook === 'afterStop')) {
        told = true;
        log(
          `${name}'s ${hook} is still running: the stop goes on once it has finished. ` +
            `To abandon the hook, stop the service again: stackctl service stop -s ${name}`,
        );
      }
    }
  };
  void watch();
  return stopped;
}

/** Runs `service <action>` against the profile's session; resolves with the exit code. */
export async function runServiceCommand(
  action: ServiceCommand,
  opts: ServiceCommandOptions,
  ctx: ServiceCommandContext,
): Promise<number> {
  const log = ctx.log ?? ((line: string) => console.log(line));
  const error = ctx.error ?? ((line: string) => console.error(line));
  const selection = selectServices(action, opts, ctx);
  if ('refusal' in selection) {
    error(selection.refusal);
    return 1;
  }
  const { names } = selection;
  const refusal = serviceRefusal(action, names, ctx, opts.waitTimeout);
  if (refusal) {
    error(refusal);
    return 1;
  }

  const { profile } = ctx.target;
  const found = await (ctx.find ?? findSession)({
    workspaceDir: ctx.root,
    profile,
    configPath: ctx.configPath,
    apiPort: ctx.apiPort,
  });
  if (found.kind === 'unresponsive') {
    error(unresponsiveMessage(found, profile));
    return 1;
  }
  if (found.kind === 'none') {
    error(noSessionLine(ctx.target));
    for (const line of await otherSessionLines(ctx.root, profile)) {
      error(line);
    }
    return 1;
  }

  const client: ControlClient = found.client;
  const before = found.status.services;
  const errors = found.status.errors ?? {};
  const hooks = found.status.serviceHooks ?? {};
  const acted: string[] = [];
  const results = new Map<string, ServiceResult>();
  const done = action === 'stop' ? 'stopped' : 'running';
  // One deadline for the whole of a start or restart: the requests and the wait for ready.
  const timeoutMs = (opts.waitTimeout ?? DEFAULT_SERVICE_WAIT_TIMEOUT_S) * 1000;
  const deadline = Date.now() + timeoutMs;
  let failed = false;
  const fail = (name: string, why: string) => {
    failed = true;
    results.set(name, { service: name, status: 'failed', error: why });
    error(why);
  };
  for (const name of names) {
    if (action === 'start' && before?.[name] === 'failed') {
      // Its process runs, but a start hook failed: a start would do nothing, and it never gets
      // ready until it is restarted.
      fail(name, `${name} is running, but failed: ${errors[name] ?? 'its afterStart or afterReady failed'}. ${retryAdvice(name)}.`); // oxfmt-ignore
      continue;
    }
    let sent: boolean;
    // A start's request is given what is left of the deadline: aborted means its time was up.
    let timeUp: AbortSignal | undefined;
    if (action === 'stop') {
      sent = await stopAndWait(client, name, log, ctx.pollMs ?? STOP_POLL_MS);
    } else if (action === 'start') {
      const hook = hooks[name];
      if (hook === 'beforeStop' || hook === 'afterStop') {
        // A stop of it still runs that hook: the start waits its turn.
        log(`waiting for ${name}'s ${hook} to finish`);
      }
      const left = Math.max(1, deadline - Date.now());
      timeUp = AbortSignal.timeout(left);
      sent = await client.command.service.start(name, { signal: timeUp });
    } else {
      sent = await client.command.service.restart(name);
    }
    if (sent) {
      if (action === 'start') {
        // A start whose `beforeStart` failed started nothing: the session says why.
        const now = await client.query.status().catch(() => null);
        const why = now?.services?.[name] === 'stopped' ? now.errors?.[name] : undefined;
        if (why !== undefined) {
          fail(name, `${name} failed to start: ${why}. ${retryAdvice(name)}.`);
          continue;
        }
      }
      acted.push(name);
      results.set(name, { service: name, status: done });
      log(actedLine(action, name, before, hooks));
      continue;
    }
    if (timeUp?.aborted) {
      // No answer in the time it was given: what it still waits for, as the session has it now.
      const now = await client.query.status().catch(() => null);
      const waiting = pendingNames({ infra: [], services: [name], session: null }, now?.services ?? {}, now?.serviceHooks ?? {}); // oxfmt-ignore
      const why = `not ready after ${String(timeoutMs / 1000)}s: ${waiting.join(', ')}`;
      failed = true;
      results.set(name, { service: name, status: 'failed', error: why });
      error(`stackctl: ${why}`);
      continue;
    }
    const blocked = before?.[name] === 'waiting' ? errors[name] : undefined;
    fail(
      name,
      blocked !== undefined
        ? `couldn't ${action} ${name}: it is ${blocked}`
        : before?.[name] === 'waiting'
          ? `couldn't ${action} ${name}: it is waiting for its dependencies, and starts once they're ready`
          : action === 'start'
            ? `couldn't start ${name}: it is restarting, or the session is shutting down`
            : action === 'stop'
              ? `couldn't stop ${name}: the session stopped answering; it may be shutting down`
              : `couldn't restart ${name}: the session is shutting down, or didn't answer in time`,
    );
  }

  if (action !== 'stop' && acted.length > 0) {
    const verdict = await (ctx.wait ?? waitUntilHealthy)(client, acted, {
      deadline,
      timeoutMs,
      logFile: found.status.logFile ?? 'the session log',
      infra: false,
      // The services named, not the session's own afterReady.
      session: false,
    });
    if (verdict !== undefined) {
      // The verdict is the set's; a service that did get ready is still `running`.
      let ready: Partial<Record<string, boolean>> = {};
      try {
        ready = (await client.query.status())?.ready ?? {};
      } catch {
        // No reading: every service waited on counts as not ready.
      }
      for (const name of acted) {
        if (ready[name] !== true) {
          results.set(name, { service: name, status: 'failed', error: verdict });
        }
      }
      failed = true;
      error(`stackctl: ${verdict}`);
    }
  }
  ctx.onResults?.(names.map((name) => results.get(name)!));
  return failed ? 1 : 0;
}

/** The infra services' names in the loaded config. */
function infraNames(): string[] {
  return Object.keys(getLoadedConfig()?.infra?.['docker-compose']?.services ?? {});
}

/**
 * `stackctl service <action>`: loads the config, then runs against the profile's session. A
 * relative `-s` path resolves against `where.targetBase`.
 */
export async function runService(
  action: ServiceCommand,
  opts: ServiceCommandOptions,
  where: { targetBase: string },
): Promise<number> {
  const config = await loadedConfigOrExit();
  const root = process.cwd();
  let results: ServiceResult[] | null = null;
  const code = await runServiceCommand(action, opts, {
    root,
    base: where.targetBase,
    target: activeTarget(),
    services: getRegisteredPackages(),
    infra: infraNames(),
    configPath: findConfigPath(root) ?? undefined,
    apiPort: config.apiPort,
    onResults: (r) => (results = r),
  });
  // For the SDK's `service.*`: what happened to each service. A refusal, or no session, has
  // none, so the call rejects with what was printed.
  if (results !== null) {
    writeSdkResult({ ok: code === 0, results });
  }
  return code;
}
