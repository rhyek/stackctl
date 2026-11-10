import chalk from 'chalk';
import { getLoadedConfig } from '../config.js';
import { InfraManager } from '../infra/manager.js';
import type { InfraRunRequest } from '../infra/provider.js';
import { createInfraReporter } from '../infra/report.js';
import { InfraError, type InfraRunSummary } from '../infra/types.js';
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

/** `infra up` / `infra destroy`: run it with the plain reporter, exit 0 only if every service made it. */
export async function runInfraAction(
  action: 'up' | 'destroy',
  req: Pick<InfraRunRequest, 'services' | 'reset'>,
): Promise<never> {
  const { manager, mode } = await loadInfraOrExit();
  const reporter = createInfraReporter({ mode });
  process.exit(
    await infraExitCode(async () => {
      const run = { ...req, onEvent: reporter.onEvent };
      const summary: InfraRunSummary =
        action === 'up' ? await manager.up(run) : await manager.destroy(run);
      reporter.finish(summary, action);
      return summary.ok ? 0 : 1;
    }),
  );
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

/** `infra down`: stop and remove the containers, keeping their data. */
export async function runInfraDown(services: string[]): Promise<never> {
  const { manager } = await loadInfraOrExit();
  process.exit(await infraExitCode(() => manager.down(services)));
}
