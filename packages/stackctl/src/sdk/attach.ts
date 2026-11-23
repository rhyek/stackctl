import type { WaitedSession } from '../commands/wait';
import { ATTACH_COMMAND, assertSdkCall } from '../env-base';
import type { ServiceName } from '../register';
import { type Stack, stackFrom } from '../stack';
import { CLI_TARGET, type CliTarget, cliArgs, flagArgs, runCli } from './cli-child';

/** What `attach()` takes. */
export interface AttachOptions extends CliTarget {
  /** How long to wait for a session that isn't ready yet, in seconds. Default `300`. */
  waitTimeout?: number;
}

/** What `wait()` takes. */
export interface WaitOptions extends CliTarget {
  /** How long to wait for a session to start and be ready, in seconds. Default `300`. */
  timeout?: number;
}

/**
 * The stack of the session running in the profile now, wherever it was started: the object
 * `startStack()` resolves with, with `session: 'attached'`. Waits for it to be ready, up to
 * `waitTimeout`. Rejects at once when none is running, and when the one recorded doesn't answer.
 * The session doesn't end with this process.
 */
export async function attach<P extends string = ServiceName>(
  options: AttachOptions = {},
): Promise<Stack<P>> {
  assertSdkCall('attach', options, [...CLI_TARGET, 'waitTimeout']);
  const command = [ATTACH_COMMAND, ...flagArgs('--timeout', options.waitTimeout)];
  return stackFrom<P>(await runCli<WaitedSession>(cliArgs(options, command)));
}

/**
 * `stackctl wait`: waits for the profile's session to start, then to be ready, up to `timeout`,
 * and resolves with its stack, as `attach()` does.
 */
export async function wait<P extends string = ServiceName>(
  options: WaitOptions = {},
): Promise<Stack<P>> {
  assertSdkCall('wait', options, [...CLI_TARGET, 'timeout']);
  const command = ['wait', ...flagArgs('--timeout', options.timeout)];
  return stackFrom<P>(await runCli<WaitedSession>(cliArgs(options, command)));
}
