import chalk from 'chalk';
import { getLoadedConfig } from '../config.js';
import type { InfraAction } from '../infra/control.js';
import { InfraManager } from '../infra/manager.js';
import { createInfraReporter, type InfraReporter } from '../infra/report.js';
import { InfraError } from '../infra/types.js';
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
async function infraExitCode(run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof InfraError) {
      console.error(chalk.red(err.message));
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

/** `stackctl infra <command>`: runs it with the plain reporter, and exits with its code. */
export async function runInfra(command: InfraCommand, services: string[]): Promise<never> {
  const { manager, mode } = await loadInfraOrExit();
  const reporter = createInfraReporter({ mode });
  process.exit(await infraExitCode(() => runInfraCommand(manager, command, services, reporter)));
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
  const { manager } = await loadInfraOrExit();
  process.exit(await infraExitCode(() => manager.passthrough(provider, args, invocationCwd)));
}
