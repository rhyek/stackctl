import path from 'node:path';

/**
 * The Compose project name for a workspace and mode. `COMPOSE_PROJECT_NAME` from the resolved
 * environment wins; otherwise it is `<workspace directory name>-<mode>`, normalized to Compose's
 * own rule (lowercase letters, digits, dashes and underscores, starting with a letter or digit).
 *
 * The mode is part of the name on purpose: Compose's default is the directory name alone, so two
 * modes would share one project and bringing one up would recreate the other's containers.
 */
export function composeProjectName(opts: {
  envs: Record<string, string>;
  workspaceDir: string;
  mode: string;
}): string {
  const fromEnv = opts.envs.COMPOSE_PROJECT_NAME;
  if (fromEnv) {
    return fromEnv;
  }
  return `${path.basename(path.resolve(opts.workspaceDir))}-${opts.mode}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z0-9]+/, '');
}
