import { type AnyServiceConfig, getLoadedConfig, getRegisteredPackages } from '../config.js';
import type { ControlClient, SessionStatus } from '../control-client.js';
import { type FoundSession, findSession, unresponsiveMessage } from '../find-session.js';
import { definesDevScript } from '../scripts.js';
import { waitUntilHealthy } from '../stack.js';
import { findConfigPath } from '../workspace-root.js';
import { type StopTarget, activeTarget, noSessionLine, otherSessionLines } from './stop.js';
import { loadedConfigOrExit } from './workspace.js';

// `stackctl service start|stop|restart -s <name>…`: drives application services of the mode's
// running session through its control API. It never starts a session of its own.

export type ServiceCommand = 'start' | 'stop' | 'restart';

/** How long `start` and `restart` wait for the services to be ready when `--wait-timeout` doesn't say, in seconds. */
export const DEFAULT_SERVICE_WAIT_TIMEOUT_S = 300;

export interface ServiceCommandOptions {
  /** The `-s` names, in the order given. */
  services: string[];
  /** Seconds `start` and `restart` wait for the services to be ready. */
  waitTimeout?: number;
}

/** What a run checks names against and finds the session with. */
export interface ServiceCommandContext {
  root: string;
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
    return `service ${action} needs at least one service: stackctl service ${action} -s <name>`;
  }
  const infra = names.filter((name) => known.infra.includes(name));
  if (infra.length > 0) {
    return `${infra.join(', ')} ${infra.length > 1 ? 'are infra services' : 'is an infra service'}: service ${action} takes application services only`;
  }
  const byName = new Map(known.services.map((service) => [service.name, service]));
  const unknown = names.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    return `Unknown service${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`;
  }
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

/** Runs `service <action>` against the mode's session; resolves with the exit code. */
export async function runServiceCommand(
  action: ServiceCommand,
  opts: ServiceCommandOptions,
  ctx: ServiceCommandContext,
): Promise<number> {
  const log = ctx.log ?? ((line: string) => console.log(line));
  const error = ctx.error ?? ((line: string) => console.error(line));
  const names = [...new Set(opts.services)];
  const refusal = serviceRefusal(action, names, ctx, opts.waitTimeout);
  if (refusal) {
    error(refusal);
    return 1;
  }

  const { mode } = ctx.target;
  const found = await (ctx.find ?? findSession)({
    workspaceDir: ctx.root,
    mode,
    configPath: ctx.configPath,
    apiPort: ctx.apiPort,
  });
  if (found.kind === 'unresponsive') {
    error(unresponsiveMessage(found, mode));
    return 1;
  }
  if (found.kind === 'none') {
    error(noSessionLine(ctx.target));
    for (const line of await otherSessionLines(ctx.root, mode)) {
      error(line);
    }
    return 1;
  }

  const client: ControlClient = found.client;
  const before = found.status.services;
  const acted: string[] = [];
  let failed = false;
  for (const name of names) {
    if (await client.command.service[action](name)) {
      acted.push(name);
      log(actedLine(action, name, before));
    } else {
      failed = true;
      error(`couldn't ${action} ${name}: it is restarting, or the session is shutting down`);
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
      error(`stackctl: ${verdict}`);
      return 1;
    }
  }
  return failed ? 1 : 0;
}

/** The infra services' names in the loaded config. */
function infraNames(): string[] {
  return Object.keys(getLoadedConfig()?.infra?.['docker-compose']?.services ?? {});
}

/** `stackctl service <action>`: loads the config, then runs against the mode's session. */
export async function runService(
  action: ServiceCommand,
  opts: ServiceCommandOptions,
): Promise<number> {
  const config = await loadedConfigOrExit();
  const root = process.cwd();
  return runServiceCommand(action, opts, {
    root,
    target: activeTarget(),
    services: getRegisteredPackages(),
    infra: infraNames(),
    configPath: findConfigPath(root) ?? undefined,
    apiPort: config.apiPort,
  });
}
