import {
  type AnyServiceConfig,
  type Config,
  getLoadedConfig,
  getRegisteredPackages,
} from '../config.js';
import { envFileNames, workspaceEnvLayer } from '../env.js';
import {
  NoProjectConfigError,
  findConfigPath,
  formatConfigLoadFailure,
  loadConfig,
} from '../load-config.js';

// Loading the workspace's config, for the commands that use it. `--help`, `logs`, `stop`, `reset`
// and `init` never get here, so they neither evaluate the config file nor pay for what it loads.

/**
 * Prints *why* a config file that does exist wouldn't load, and exits 1. Kept separate from the
 * "no config found" message so a broken config never masquerades as a missing one.
 */
export function exitOnConfigLoadFailure(root: string, err: unknown): never {
  console.error(formatConfigLoadFailure(findConfigPath(root) ?? root, err));
  process.exit(1);
}

let workspaceEnvApplied = false;

/**
 * Merges the workspace's environment into stackctl's own `process.env`, once: the same layer
 * everything outside a package is given — the config's own variables, the files, and
 * `env.override` deciding where they beat the shell — so whatever stackctl starts has it. (A
 * later resolution still starts from what the shell handed over, captured when the CLI anchored
 * at the root, so an override that extends a variable — `NODE_OPTIONS=$NODE_OPTIONS --flag` —
 * extends it once.)
 */
export function applyWorkspaceEnv(config: Config<string> | null): void {
  if (workspaceEnvApplied) {
    return;
  }
  workspaceEnvApplied = true;
  Object.assign(
    process.env,
    workspaceEnvLayer({
      cwd: process.cwd(),
      files: config?.envFiles ?? envFileNames(),
      override: config?.envOverride,
      vars: config?.envVars,
    }),
  );
}

/**
 * Loads `stackctl.config.ts` and applies the workspace's environment, printing a clear hint and
 * exiting 1 if there is no config or it won't load.
 */
export async function loadConfigOrExit(): Promise<AnyServiceConfig[]> {
  try {
    const packages = await loadConfig();
    applyWorkspaceEnv(getLoadedConfig());
    return packages;
  } catch (err) {
    if (err instanceof NoProjectConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    exitOnConfigLoadFailure(process.cwd(), err);
  }
}

/** The loaded config, exiting with a hint when the config file registered none. */
export async function loadedConfigOrExit(): Promise<Config<string>> {
  await loadConfigOrExit();
  const config = getLoadedConfig();
  if (!config) {
    console.error(
      `${findConfigPath(process.cwd()) ?? 'stackctl.config.ts'} loaded but registered no config — ` +
        'it must export a `defineConfig(...)` call as its default.',
    );
    process.exit(1);
  }
  return config;
}

/** Exits with a clear message if any of `names` isn't a registered package. */
export function validatePackageNames(names: string[]): void {
  const registered = new Set(getRegisteredPackages().map((p) => p.name));
  const unknown = names.filter((n) => !registered.has(n));
  if (unknown.length > 0) {
    console.error(`Unknown service${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
    process.exit(1);
  }
}
