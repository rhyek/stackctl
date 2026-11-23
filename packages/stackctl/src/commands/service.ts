import { type AnyServiceConfig, getLoadedConfig, getRegisteredPackages } from '../config';
import type { ControlClient, SessionStatus } from '../control-client';
import { type FoundSession, findSession, unresponsiveMessage } from '../find-session';
import { definesDevScript } from '../scripts';
import { writeSdkResult } from '../sdk-result';
import { waitUntilHealthy } from '../stack';
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
): string {
  const was = before?.[name];
  switch (action) {
    case 'stop':
      return was === undefined || was === 'stopped'
        ? `${name} is already stopped`
        : `stopped ${name}`;
    case 'start':
      return was === 'running' ? `${name} is already running` : `started ${name}`;
    case 'restart':
      return `restarting ${name}`;
  }
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
  const acted: string[] = [];
  const results = new Map<string, ServiceResult>();
  const done = action === 'stop' ? 'stopped' : 'running';
  let failed = false;
  for (const name of names) {
    if (await client.command.service[action](name)) {
      acted.push(name);
      results.set(name, { service: name, status: done });
      log(actedLine(action, name, before));
    } else {
      failed = true;
      const why =
        before?.[name] === 'waiting'
          ? `couldn't ${action} ${name}: it is waiting for its dependencies, and starts once they're ready`
          : `couldn't ${action} ${name}: it is restarting, or the session is shutting down`;
      results.set(name, { service: name, status: 'failed', error: why });
      error(why);
    }
  }

  if (action !== 'stop' && acted.length > 0) {
    const timeoutMs = (opts.waitTimeout ?? DEFAULT_SERVICE_WAIT_TIMEOUT_S) * 1000;
    const verdict = await (ctx.wait ?? waitUntilHealthy)(client, acted, {
      deadline: Date.now() + timeoutMs,
      timeoutMs,
      logFile: found.status.logFile ?? 'the session log',
      infra: false,
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
