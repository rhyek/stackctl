import chalk from 'chalk';
import { startedByAgent } from '../agent-detection.js';
import { getLoadedConfig } from '../config.js';
import {
  type ComposeCommandEntry,
  type InfraCommandEntry,
  cliEventLog,
  commandBy,
  isReadOnlyCompose,
  maskSecrets,
} from '../event-log.js';
import type { InfraAction } from '../infra/control.js';
import { InfraManager } from '../infra/manager.js';
import { createInfraReporter, type InfraReporter } from '../infra/report.js';
import { InfraError, type InfraRunSummary } from '../infra/types.js';
import { endCommandsOnSignals } from '../spawn.js';
import { loadConfigOrExit } from './workspace.js';

// `stackctl infra …`: the services the packages need but that aren't packages. Every subcommand
// exits when it's done — none stays up streaming logs — and none goes through session
// acquisition, so a running dev session is never disturbed.

/** The infra manager for the loaded config, exiting with a hint when it declares no `infra`. */
async function loadInfraOrExit(): Promise<{ manager: InfraManager; mode: string }> {
  await loadConfigOrExit();
  const config = getLoadedConfig();
  const manager = config ? await InfraManager.fromConfig(config) : null;
  if (!config || !manager) {
    console.error(
      "No `infra` in the stackctl config — add `infra: { 'docker-compose': true }` to use `stackctl infra`.",
    );
    process.exit(1);
  }
  return { manager, mode: config.envMode };
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

/** What a service that came through a lifecycle command is now. */
const DONE: Record<InfraCommand, 'ready' | 'stopped' | 'destroyed'> = {
  start: 'ready',
  restart: 'ready',
  reset: 'ready',
  stop: 'stopped',
  destroy: 'destroyed',
};

/** The `stackctl infra` lifecycle commands: a session's infra actions, and `destroy`. */
export type InfraCommand = InfraAction | 'destroy';

/** The part of {@link InfraManager} the lifecycle commands drive. */
export type InfraCommandManager = Pick<InfraManager, 'up' | 'down' | 'destroy'>;

/**
 * Runs a lifecycle command on `services` (none: every enabled one; for `destroy`, the whole
 * project) and resolves with its exit code. `restart` is `stop` then `start`: the containers are
 * recreated, picking up a changed compose file, and their data kept. A failed stop starts nothing.
 */
export async function runInfraCommand(
  manager: InfraCommandManager,
  command: InfraCommand,
  services: string[],
  reporter: InfraReporter,
): Promise<number> {
  if (command === 'stop' || command === 'restart') {
    const code = await manager.down(services);
    if (command === 'stop' || code !== 0) {
      return code;
    }
  }
  const run = { services, onEvent: reporter.onEvent };
  if (command === 'destroy') {
    const summary = await manager.destroy(run);
    reporter.finish(summary, 'destroy');
    return summary.ok ? 0 : 1;
  }
  const summary = await manager.up({ ...run, trigger: command });
  reporter.finish(summary, 'up');
  return summary.ok ? 0 : 1;
}

/**
 * `stackctl infra <command>`: runs it with the plain reporter, writes it to the session's event log
 * (`begin`, then `end` with each service's result), and exits with its code.
 */
export async function runInfra(
  command: InfraCommand,
  services: string[],
  invocationCwd: string,
): Promise<never> {
  const { manager, mode } = await loadInfraOrExit();
  // A `kill <pid>` of this command ends the Compose run or migration it is waiting on, too.
  endCommandsOnSignals();
  const root = process.cwd();
  const entry = cliEventLog(root, mode).begin<InfraCommandEntry>(
    { type: 'infra-command', action: command, requested: services },
    commandBy(root, { agent: startedByAgent(), invocationCwd }),
  );
  const plain = createInfraReporter({ mode });
  let summary: InfraRunSummary | null = null;
  let error: string | undefined;
  const reporter: InfraReporter = {
    ...plain,
    finish: (finished, action) => {
      summary = finished;
      plain.finish(finished, action);
    },
  };
  const code = await infraExitCode(
    () => runInfraCommand(manager, command, services, reporter),
    (message) => (error = message),
  );
  const ran = summary as InfraRunSummary | null;
  entry.end({
    ok: code === 0,
    ...(ran
      ? {
          services: ran.services.map((s) => s.service),
          results: Object.fromEntries(ran.services.map((s) => [s.service, s.ok ? DONE[command] : ('failed' as const)])), // oxfmt-ignore
        }
      : {}),
    ...(command === 'destroy' && services.length === 0 ? { everything: true } : {}),
    ...(error !== undefined ? { error } : code !== 0 && !ran ? { error: `exited with code ${String(code)}` } : {}), // oxfmt-ignore
  });
  process.exit(code);
}

/**
 * `infra <provider> …`: the provider's own tool, bound to this project and mode. Runs in the
 * directory stackctl was invoked from, so a relative path in the arguments means what the user
 * typed, and exits with the tool's exit code.
 */
export async function runInfraPassthrough(
  provider: string,
  args: string[],
  invocationCwd: string,
): Promise<never> {
  const { manager, mode } = await loadInfraOrExit();
  // What only reads (`ps`, `logs`) leaves no line.
  const root = process.cwd();
  const entry = isReadOnlyCompose(args)
    ? null
    : cliEventLog(root, mode).begin<ComposeCommandEntry>(
        { type: 'compose-command', args: maskSecrets(args) },
        commandBy(root, { agent: startedByAgent(), invocationCwd }),
      );
  const code = await infraExitCode(() => manager.passthrough(provider, args, invocationCwd));
  entry?.end({ ok: code === 0, exitCode: code });
  process.exit(code);
}
