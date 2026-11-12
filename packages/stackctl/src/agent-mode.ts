import type { ModeSource } from './env-base.js';
import { needsNoWorkspace, readCommand } from './workspace-root.js';

// A coding agent names the mode of every command it runs, `development` included: a default
// is how an agent ends up running the tests against the development database, or restarting a
// person's session when it meant its own test one.

/**
 * Why this invocation is refused, or `undefined` when it may run: a coding agent's command whose
 * mode is the default or the CI default, rather than named by `--mode` or `STACKCTL_MODE`.
 *
 * - A stackctl another one started inherits `STACKCTL_MODE`, so it counts as named.
 * - The session `startStack()` forks (`forked`, it has an IPC channel) runs in the mode the
 *   suite's code chose, so it is left alone.
 * - `init`, help and the version act on no mode.
 */
export function agentModeRefusal(opts: {
  agent: boolean;
  source: ModeSource;
  forked: boolean;
  argv: readonly string[];
}): string | undefined {
  if (!opts.agent || opts.forked || opts.source === 'flag' || opts.source === 'env') {
    return undefined;
  }
  if (needsNoWorkspace(opts.argv)) {
    return undefined;
  }
  const command = readCommand(opts.argv).command ?? 'start';
  return (
    `stackctl: a coding agent names the mode on every command, development included: stackctl --mode development ${command}. ` +
    'STACKCTL_MODE=<mode> names it too. (Not an agent? Set STACKCTL_STARTED_BY_AGENT=0.)'
  );
}
