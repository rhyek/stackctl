import { startedByAgent } from '../agent-detection';
import { guidanceAtStart } from '../agent-guidance';
import { getRegisteredPackages } from '../config';
import { isCI } from '../env-base';
import { resolveSelectedNames } from '../saved-selection';
import { readOwnVersion } from '../skill';
import { loadConfigOrExit, validatePackageNames } from './workspace';

// `stackctl start`, the default command — `stackctl` with no subcommand: a dev session.

/** `start`'s options: the session's. */
export interface StartOptions {
  service: string[];
  /** Declared for --help/validation; the value in force is read from argv by resolveProfile. */
  profile?: string;
  ui?: boolean;
  headless?: boolean;
  lastAnswers: boolean;
  killOthers: boolean;
  /** `--detach`: a headless session that outlives the command, which waits until it is ready. */
  detach?: boolean;
  /** `--wait-timeout`, in seconds: how long `--detach` waits. */
  waitTimeout?: number;
}

/**
 * The package names for a `--headless` session (see `resolveSelectedNames` in lib), exiting
 * with the hint when there are none. An explicit `--package` was validated by the caller; a
 * saved selection is already pruned of names that are no longer packages.
 */
export function resolveSelectedNamesOrExit(
  opts: { service: string[]; lastAnswers: boolean },
  usage: string,
): string[] {
  const result = resolveSelectedNames(opts, usage);
  if ('error' in result) {
    console.error(result.error);
    process.exit(1);
  }
  return result.names;
}

/** Starts the session the options ask for; a session ends by exiting the process. */
export async function runDefaultAction(opts: StartOptions): Promise<void> {
  await loadConfigOrExit();
  // A config may declare none, to set the environment of `exec` and `run` alone.
  if (getRegisteredPackages().length === 0) {
    console.error(
      'stackctl.config.ts declares no services, so there is nothing to start. ' +
        'Run a command with `stackctl exec` or `stackctl run`.',
    );
    process.exit(1);
  }

  // Best-effort: the agent guidance should never block a run. What is installed is kept
  // current; what is missing is offered once, and only to a person about to see the terminal UI.
  try {
    await guidanceAtStart({
      cwd: process.cwd(),
      version: readOwnVersion(),
      interactive:
        !opts.headless &&
        !opts.detach &&
        Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
        !startedByAgent() &&
        !isCI(),
    });
  } catch (err) {
    console.error('stackctl: agent guidance check failed (non-fatal):', err);
  }

  // Validate --package names before mounting/running anything.
  validatePackageNames(opts.service);

  // Only now: the checks above have no use for what a session loads.
  const { runDevSession } = await import('./session');
  await runDevSession(opts);
}
