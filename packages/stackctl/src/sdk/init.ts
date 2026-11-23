import { assertSdkCall } from '../env-base';
import { cliArgs, runCli } from './cli-child';

/** What `init()` takes. */
export interface InitOptions {
  /** Where to set the project up. Default: the current directory. */
  workspaceDir?: string;
  /** Add a stackctl section to `AGENTS.md` too. */
  agentsMd?: boolean;
}

/**
 * Sets a project up as `stackctl init -y` does: the config if there is none, its place in the
 * root `tsconfig.json`, and the agent guidance; with `agentsMd`, the `AGENTS.md` section too.
 */
export async function init(options: InitOptions = {}): Promise<void> {
  assertSdkCall('init', options, ['workspaceDir', 'agentsMd']);
  const command = ['init', '-y', ...(options.agentsMd ? ['--agents-md'] : [])];
  await runCli(cliArgs({ workspaceDir: options.workspaceDir }, command));
}
