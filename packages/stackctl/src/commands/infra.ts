import chalk from 'chalk';
import { startedByAgent } from '../agent-detection';
import { type Config, getLoadedConfig, infraServicesOf } from '../config';
import {
  type ComposeCommandEntry,
  type InfraCommandEntry,
  cliEventLog,
  commandBy,
  isReadOnlyCompose,
  maskSecrets,
} from '../event-log';
import type { InfraAction } from '../infra/control';
import { InfraManager } from '../infra/manager';
import { createInfraReporter, type InfraReporter } from '../infra/report';
import {
  INFRA_DONE_STATUS,
  InfraError,
  type InfraRunAction,
  type InfraRunSummary,
  type InfraServiceResult,
} from '../infra/types';
import { writeSdkResult } from '../sdk-result';
import type { InfraResult } from '../sdk/infra';
import { endCommandsOnSignals } from '../spawn';
import { type TagSelection, UnknownTagError, selectByTags } from '../tags';
import { loadConfigOrExit } from './workspace';

// `stackctl infra …`: the services the packages need but that aren't packages. Every subcommand
// exits when it's done — none stays up streaming logs — and none goes through session
// acquisition, so a running dev session is never disturbed.

/** The infra manager for the loaded config, exiting with a hint when it declares no `infra`. */
async function loadInfraOrExit(): Promise<{ manager: InfraManager; config: Config<string> }> {
  await loadConfigOrExit();
  const config = getLoadedConfig();
  const manager = config ? await InfraManager.fromConfig(config) : null;
  if (!config || !manager) {
    console.error(
      "No `infra` in the stackctl config — add `infra: { 'docker-compose': true }` to use `stackctl infra`.",
    );
    process.exit(1);
  }
  return { manager, config };
}

/**
 * Runs an infra command to its exit code. An {@link InfraError} is a message for the user —
 * an unknown service, Docker not running — so it prints as one line, not a stack trace.
 */
async function infraExitCode(
  run: () => Promise<number>,
  onError: (message: string) => void = () => {},
): Promise<number> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof InfraError) {
      console.error(chalk.red(err.message));
      onError(err.message);
      return 1;
    }
    throw err;
  }
}

/** The `stackctl infra` lifecycle commands: a session's infra actions, and `destroy`. */
export type InfraCommand = InfraAction | 'destroy';

/** The part of {@link InfraManager} the lifecycle commands drive. */
export type InfraCommandManager = Pick<InfraManager, 'up' | 'down' | 'destroy'>;

/**
 * Runs a lifecycle command on `services` (none: every enabled one; for `destroy`, the whole
 * project) and resolves with its exit code: `0` when every service reached the state the command
 * names and no hook failed, else `1`. `restart` is `stop` then `start`, one run whose hooks share
 * one `data` and see the trigger `restart`: the containers are recreated, picking up a changed
 * compose file, and their named volumes kept. A stop that failed starts nothing; a stop whose
 * hook failed (the services stopped all the same) goes on to the start, and the command exits 1
 * at the end with the hook's error in each service's result.
 * `opts.waitTimeoutS` is how long `start`, `restart` and `reset` wait for the services to be ready.
 */
export async function runInfraCommand(
  manager: InfraCommandManager,
  command: InfraCommand,
  services: string[],
  reporter: InfraReporter,
  opts: { waitTimeoutS?: number } = {},
): Promise<number> {
  // One `data` for the whole command: a restart's stop and start share it.
  const run = { services, onEvent: reporter.onEvent, data: {} };
  let stopped: InfraRunSummary | undefined;
  if (command === 'stop' || command === 'restart') {
    stopped = await manager.down({ ...run, trigger: command });
    const stopFailed = stopped.services.some((s) => !s.ok && !s.hookFailed);
    if (command === 'stop' || stopFailed) {
      reporter.finish(stopped, 'down');
      return stopped.ok ? 0 : 1;
    }
  }
  if (command === 'destroy') {
    const summary = await manager.destroy(run);
    reporter.finish(summary, 'destroy');
    return summary.ok ? 0 : 1;
  }
  const started = await manager.up({
    ...run,
    trigger: command,
    ...(opts.waitTimeoutS === undefined ? {} : { readyTimeoutMs: opts.waitTimeoutS * 1000 }),
  });
  const summary = stopped ? withStopHookErrors(started, stopped) : started;
  reporter.finish(summary, 'up');
  return summary.ok ? 0 : 1;
}

/**
 * A restart's start, with what failed in its stop's hooks: a service that came up is still
 * `hookFailed` with the stop hook's error; one that didn't gets that error after its own.
 */
function withStopHookErrors(started: InfraRunSummary, stopped: InfraRunSummary): InfraRunSummary {
  const hookErrors = new Map(
    stopped.services.filter((s) => s.hookFailed).map((s) => [s.service, s.error ?? '']),
  );
  const services = started.services.map((result) => {
    const hookError = hookErrors.get(result.service);
    if (hookError === undefined) {
      return result;
    }
    return result.ok
      ? { service: result.service, ok: false, error: hookError, hookFailed: true as const }
      : { ...result, error: [result.error, hookError].filter(Boolean).join('\n') };
  });
  return { ok: services.every((s) => s.ok), services };
}

/**
 * The infra services `infra <command>` acts on: the `-s` names, and the services the config names
 * that have a `-t` tag, less a disabled one only a tag picked. A name the config doesn't list is
 * kept, for the provider to check. With neither, `[]`: every enabled service (for `destroy`, the
 * whole project). With tags, never `[]`: when none is left it throws {@link InfraError}, as it
 * does for a tag no configured infra service has.
 */
export function infraSelection(
  names: string[],
  tags: string[],
  configured: readonly { name: string; enabled: boolean; tags: readonly string[] }[],
): string[] {
  if (tags.length === 0) {
    return names;
  }
  let selection: TagSelection;
  try {
    selection = selectByTags(configured, { names, tags }, 'infra service');
  } catch (err) {
    throw err instanceof UnknownTagError ? new InfraError(err.message) : err;
  }
  const disabled = new Set(configured.filter((s) => !s.enabled).map((s) => s.name));
  const selected = selection.names.filter(
    (name) => !selection.fromTagOnly.has(name) || !disabled.has(name),
  );
  if (selected.length === 0) {
    throw new InfraError(`no enabled infra service is tagged ${[...new Set(tags)].join(', ')}`);
  }
  return selected;
}

/**
 * What a run did to each service, as the SDK's `infra.*` resolves it: a service that made it is in
 * the state the run's action names, and so is one that made it but whose hook failed, with the
 * hook's error. One the run left elsewhere is in that state (`destroyed`, for a reset that stopped
 * after its destroy), with why. For a restart whose stop failed, that run is the stop.
 */
export function infraResults(
  summary: InfraRunSummary,
  action: InfraRunAction,
): InfraResult['results'] {
  return summary.services.map((s) => ({
    service: s.service,
    status: s.reached ?? (s.ok || s.hookFailed ? INFRA_DONE_STATUS[action] : 'failed'),
    ...(s.error === undefined ? {} : { error: s.error }),
  }));
}

/**
 * The results an `infra-command` line ends with, from the run's summary: each service's state;
 * for one whose own hook failed around a step that went ahead (`hookFailed`), the hook's error,
 * in `hookErrors`; and for one a reset left destroyed and didn't start because another service's
 * `afterDestroy` failed, why, in `notStarted`.
 */
export function infraEntryResults(
  summary: InfraRunSummary,
  action: InfraRunAction,
): Pick<
  Extract<InfraCommandEntry, { phase: 'end' }>,
  'services' | 'results' | 'hookErrors' | 'notStarted'
> {
  const results = infraResults(summary, action);
  const errorsOf = (keep: (s: InfraServiceResult) => boolean) =>
    Object.fromEntries(summary.services.filter(keep).map((s) => [s.service, s.error ?? '']));
  const hookErrors = errorsOf((s) => s.hookFailed === true);
  const notStarted = errorsOf((s) => s.reached !== undefined && !s.hookFailed);
  return {
    services: results.map((r) => r.service),
    results: Object.fromEntries(results.map((r) => [r.service, r.status])),
    ...(Object.keys(hookErrors).length > 0 ? { hookErrors } : {}),
    ...(Object.keys(notStarted).length > 0 ? { notStarted } : {}),
  };
}

/**
 * `stackctl infra <command>`: runs it with the plain reporter, writes it to the session's event log
 * (`begin`, then `end` with each service's result), and exits with its code.
 */
export async function runInfra(
  command: InfraCommand,
  names: string[],
  tags: string[],
  invocationCwd: string,
  opts: { waitTimeoutS?: number } = {},
): Promise<never> {
  if (opts.waitTimeoutS !== undefined && !(opts.waitTimeoutS > 0)) {
    console.error('--wait-timeout takes a number of seconds above 0.');
    process.exit(1);
  }
  const { manager, config } = await loadInfraOrExit();
  const { profile } = config;
  let services: string[];
  try {
    const configured = infraServicesOf(config).map(({ name, service }) => ({
      name,
      enabled: service.enabled,
      tags: service.tags,
    }));
    services = infraSelection(names, tags, configured);
  } catch (err) {
    if (err instanceof InfraError) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
    throw err;
  }
  // A `kill <pid>` of this command ends the Compose run or migration it is waiting on, too.
  endCommandsOnSignals();
  const root = process.cwd();
  const entry = cliEventLog(root, profile).begin<InfraCommandEntry>(
    { type: 'infra-command', action: command, requested: services },
    commandBy(root, { agent: startedByAgent(), invocationCwd }),
  );
  const plain = createInfraReporter({ profile });
  // A refusal ran nothing, and has no results.
  let results: InfraResult['results'] | undefined;
  let entryResults: ReturnType<typeof infraEntryResults> | undefined;
  let error: string | undefined;
  const reporter: InfraReporter = {
    ...plain,
    finish: (summary, action) => {
      results = infraResults(summary, action);
      entryResults = infraEntryResults(summary, action);
      plain.finish(summary, action);
    },
  };
  const code = await infraExitCode(
    () => runInfraCommand(manager, command, services, reporter, opts),
    (message) => (error = message),
  );
  entry.end({
    ok: code === 0,
    ...entryResults,
    ...(command === 'destroy' && services.length === 0 ? { everything: true } : {}),
    ...(error !== undefined ? { error } : code !== 0 && !results ? { error: `exited with code ${String(code)}` } : {}), // oxfmt-ignore
  });
  // For the SDK's `infra.*`. Without results the call rejects with the refusal's message.
  if (results) {
    writeSdkResult({ ok: code === 0, results });
  }
  process.exit(code);
}

/**
 * `infra <provider> …`: the provider's own tool, bound to this project and profile. Runs in the
 * directory stackctl was invoked from, so a relative path in the arguments means what the user
 * typed, and exits with the tool's exit code.
 */
export async function runInfraPassthrough(
  provider: string,
  args: string[],
  invocationCwd: string,
): Promise<never> {
  const { manager, config } = await loadInfraOrExit();
  // What only reads (`ps`, `logs`) leaves no line.
  const root = process.cwd();
  const entry = isReadOnlyCompose(args)
    ? null
    : cliEventLog(root, config.profile).begin<ComposeCommandEntry>(
        { type: 'compose-command', args: maskSecrets(args) },
        commandBy(root, { agent: startedByAgent(), invocationCwd }),
      );
  const code = await infraExitCode(() => manager.passthrough(provider, args, invocationCwd));
  entry?.end({ ok: code === 0, exitCode: code });
  process.exit(code);
}
