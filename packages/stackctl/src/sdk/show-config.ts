import type { Config } from '../config';
import { assertSdkCall } from '../env-base';
import { CLI_TARGET, type CliTarget, cliArgs, runCli } from './cli-child';

/**
 * The fully resolved config, as `stackctl show-config` prints it: callbacks run, defaults
 * applied, functions left out. Runs the CLI in a child process, so this process never loads the
 * config. Rejects with the CLI's message when there is no config or it doesn't load.
 */
export async function showConfig(options: CliTarget = {}): Promise<Config<string>> {
  assertSdkCall('showConfig', options, CLI_TARGET);
  return runCli<Config<string>>(cliArgs(options, ['show-config']));
}
