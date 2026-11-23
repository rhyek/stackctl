import fs from 'node:fs';
import type { ServiceResult } from '../commands/service';
import type { StatusReport } from '../commands/status';
import { assertSdkCall, assertStringArrays } from '../env-base';
import type { EventLine } from '../event-log';
import {
  CLI_TARGET,
  type CliTarget,
  cliArgs,
  flagArgs,
  runCli,
  sdkCallerBy,
  selectionArgs,
  streamCli,
} from './cli-child';

// The SDK's forms of the commands that act on a profile's session — `stop`, `status`, `events`,
// `logs`, `reset` and `service` — which need no session of their own: each runs the command in a
// child process, as the command line does, whether a session is running or not.

export type { ServiceResult } from '../commands/service';
export type { StatusReport } from '../commands/status';

/** Which application services a `service` method of a stack acts on. */
export interface StackServiceOptions {
  /** Services, by name or by a path. */
  services?: string[];
  /** Every service with one of these tags, beside `services`. */
  tags?: string[];
}

/** The options of a stack's `service.start` and `service.restart`. */
export interface StackServiceStartOptions extends StackServiceOptions {
  /** How long to wait for the services to be ready, in seconds. Default `300`. */
  waitTimeout?: number;
}

/** Which application services a `service` function acts on, and in which workspace. */
export interface ServiceSelection extends CliTarget, StackServiceOptions {}

/** The options of `service.start` and `service.restart`. */
export interface ServiceStartOptions extends CliTarget, StackServiceStartOptions {}

/** What `events()` takes. */
export interface EventsOptions extends CliTarget {
  /** Keep only the last this many lines. */
  lines?: number;
}

/** What `events()` and `logs()` take to follow the session's files. */
export interface FollowOptions extends CliTarget {
  /** Yield the lines as they are written, until the next session starts. */
  follow: true;
  /** Ends the iterator when it aborts. */
  signal?: AbortSignal;
}

/** What `logs()` resolves with. */
export interface LogsResult {
  /** The log file's path. */
  path: string;
  /** What it holds. */
  text: string;
}

/** What `resetProfile()` takes. */
export interface ResetProfileOptions {
  /** The profile whose session to stop and whose state to delete. */
  profile: string;
  /** The workspace: the directory holding `stackctl.config.ts`, relative or absolute. */
  workspaceDir?: string;
}

/** What a `service` function did. */
export interface ServiceCommandResult {
  /** Every service reached the state the command names. */
  ok: boolean;
  /** One per service the command acted on. */
  results: ServiceResult[];
}

/**
 * Stops the profile's session, as `stackctl stop` does, and resolves once it has exited:
 * `stopped: false` when none was running. Rejects when it may still be running.
 */
export async function stop(options: CliTarget = {}): Promise<{ stopped: boolean }> {
  assertSdkCall('stop', options, CLI_TARGET);
  return runCli(cliArgs(options, ['stop']));
}

/** The profile's session now, and the last commands that acted on it, as `stackctl status --json`. */
export async function status(options: CliTarget = {}): Promise<StatusReport> {
  assertSdkCall('status', options, CLI_TARGET);
  return runCli(cliArgs(options, ['status']));
}

/**
 * The session's event log, parsed: the running session's, else the latest one's; `[]` before
 * any session ran. `lines` keeps the last that many. With `follow: true`, an async iterable of
 * the lines, the ones already there first, ending when the next session starts or `signal`
 * aborts; breaking out of the loop ends it too.
 */
export function events(options?: EventsOptions): Promise<EventLine[]>;
export function events(options: FollowOptions): AsyncIterable<EventLine>;
export function events(
  options: CliTarget & { lines?: number; follow?: boolean; signal?: AbortSignal } = {},
): Promise<EventLine[]> | AsyncIterable<EventLine> {
  if (options.follow === true) {
    assertSdkCall('events', options, [...CLI_TARGET, 'follow', 'signal']);
    return parsed(streamCli(cliArgs(options, ['events', '-f'], { result: false }), options.signal));
  }
  return (async () => {
    assertSdkCall('events', options, [...CLI_TARGET, 'lines']);
    const command = ['events', ...flagArgs('-n', options.lines)];
    const { lines } = await runCli<{ lines: EventLine[] }>(cliArgs(options, command));
    return lines;
  })();
}

async function* parsed(lines: AsyncIterable<string>): AsyncGenerator<EventLine> {
  for await (const line of lines) {
    yield JSON.parse(line) as EventLine;
  }
}

/**
 * The session's log, as `stackctl logs` prints it: the running session's, else the latest one's,
 * with its path. Rejects before any session ran. With `follow: true`, an async iterable of its
 * lines, ending when the next session starts or `signal` aborts.
 */
export function logs(options?: CliTarget): Promise<LogsResult>;
export function logs(options: FollowOptions): AsyncIterable<string>;
export function logs(
  options: CliTarget & { follow?: boolean; signal?: AbortSignal } = {},
): Promise<LogsResult> | AsyncIterable<string> {
  if (options.follow === true) {
    assertSdkCall('logs', options, [...CLI_TARGET, 'follow', 'signal']);
    return streamCli(cliArgs(options, ['logs', '-f'], { result: false }), options.signal);
  }
  return (async () => {
    assertSdkCall('logs', options, CLI_TARGET);
    const { path } = await runCli<{ path: string }>(cliArgs(options, ['logs', '--path']));
    return { path, text: fs.readFileSync(path, 'utf8') };
  })();
}

/**
 * Stops the profile's session, then deletes the profile's state, as `stackctl reset` does.
 * `profile` is required, as `--profile` is there.
 */
export async function resetProfile(options: ResetProfileOptions): Promise<void> {
  assertSdkCall('resetProfile', options, CLI_TARGET);
  if (typeof options.profile !== 'string' || options.profile === '') {
    throw new Error('resetProfile: `profile` names the profile whose state to delete');
  }
  await runCli(cliArgs(options, ['reset']), { by: await sdkCallerBy() });
}

async function runService(
  action: 'start' | 'stop' | 'restart',
  options: ServiceStartOptions,
  allowed: string[],
): Promise<ServiceCommandResult> {
  const fn = `service.${action}`;
  assertSdkCall(fn, options, allowed);
  assertStringArrays(fn, options, ['services', 'tags']);
  const command = [
    'service',
    action,
    ...selectionArgs(options),
    ...flagArgs('--wait-timeout', options.waitTimeout),
  ];
  return runCli<ServiceCommandResult>(cliArgs(options, command));
}

const SELECTION = [...CLI_TARGET, 'services', 'tags'];

/**
 * `stackctl service …` from a script: application services in the profile's running session.
 * Each rejects when no session is running, or the selection is refused.
 */
export const service = {
  /** Starts the services, adding any the session lacks, and waits until they are ready. */
  start: (options: ServiceStartOptions) =>
    runService('start', options, [...SELECTION, 'waitTimeout']),
  /** Stops the services. */
  stop: (options: ServiceSelection) => runService('stop', options, SELECTION),
  /** Restarts the services and waits until they are ready. */
  restart: (options: ServiceStartOptions) =>
    runService('restart', options, [...SELECTION, 'waitTimeout']),
};
