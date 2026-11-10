import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AnyServiceConfig, Config } from './config.js';
import { WorkspaceNotFoundError, locateWorkspace, recordConfigDir } from './workspace-root.js';

export { CONFIG_NAMES, findConfigPath } from './workspace-root.js';

export class NoProjectConfigError extends Error {}

/**
 * The oldest Node stackctl runs on, its `engines.node` floor in package.json: the first 26.x whose
 * HTTP agent checks a kept-alive connection for the upstream's close before reusing it
 * (CVE-2026-105481), which the dev reverse proxy relies on. Far below it, a `stackctl.config.ts`
 * can't be loaded at all (type-stripping was unflagged in 22.18.0).
 */
export const MIN_NODE = '26.12.1';

/**
 * Renders a config file that exists but wouldn't load. Deliberately distinct from "no config
 * found": the file is right there, so what's worth printing is *why* — a syntax error, a config
 * that throws, or a Node too old to import TypeScript at all. That last case only surfaces as a
 * bare `ERR_UNKNOWN_FILE_EXTENSION` that never mentions Node's version, so name the requirement.
 */
export function formatConfigLoadFailure(
  configPath: string,
  err: unknown,
  nodeVersion: string = process.version,
): string {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const lines = [`Failed to load ${configPath}:`, detail];
  if ((err as { code?: unknown } | null | undefined)?.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
    lines.push(
      `\nNode ${nodeVersion} can't import TypeScript — stackctl needs Node >=${MIN_NODE}.`,
    );
  }
  return lines.join('\n');
}

export async function loadConfig(cwd: string = process.cwd()): Promise<AnyServiceConfig[]> {
  let located: ReturnType<typeof locateWorkspace>;
  try {
    located = locateWorkspace({ workspaceDir: cwd });
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) {
      throw new NoProjectConfigError(err.message);
    }
    throw err;
  }
  const { root, configPath } = located;
  // What `defineConfig` defaults its `workspaceDir` to, whichever directory the process is in.
  recordConfigDir(root);
  const mod = (await import(pathToFileURL(configPath).href)) as { default?: Config<string> };
  // `defineConfig` registers packages as a side effect of being imported. (Imported here, not
  // up top, so finding the workspace root — all some commands need — loads no config code.)
  const { getRegisteredPackages } = await import('./config.js');
  const registered = getRegisteredPackages();
  if (registered.length) {
    return registered;
  }
  if (mod.default?.services) {
    return Object.values(mod.default.services);
  }
  throw new Error(
    `config module ${path.basename(configPath)} did not export a defineConfig default`,
  );
}
