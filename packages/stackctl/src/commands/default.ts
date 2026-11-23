import { startedByAgent } from '../agent-detection';
import { guidanceAtStart } from '../agent-guidance';
import { getRegisteredPackages } from '../config';
import { isCI } from '../env-base';
import { resolveSelectedNames } from '../saved-selection';
import { readOwnVersion } from '../skill';
import { UnknownTagError } from '../tags';
import { TargetNotFoundError, resolveServiceSelection } from '../target';
import { loadConfigOrExit } from './workspace';

// `stackctl start`, the default command — `stackctl` with no subcommand: a dev session.

/** `start`'s options: the session's. */
export interface StartOptions {
  /** The `-s` values: names or paths as typed, then the service names they resolve to. */
  service: string[];
  /** The `-t` tags: every service that has one joins `service`. */
  tag: string[];
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
 * The service names for a `--headless` session (see `resolveSelectedNames`), exiting with the
 * hint when there are none. `-s` and `-t` were resolved by the caller; a saved selection is
 * already pruned of names that are no longer services.
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

/**
 * Starts the session the options ask for; a session ends by exiting the process. A relative `-s`
 * path resolves against `where.targetBase`.
 */
export async function runDefaultAction(
  opts: StartOptions,
  where: { targetBase: string },
): Promise<void> {
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

  // `-s` and `-t` become service names before anything is mounted or run. A tagged service with
  // no dev command stays in: the session leaves it unstarted, as it does a picked one.
  try {
    opts.service = resolveServiceSelection(
      { targets: opts.service, tags: opts.tag },
      { root: process.cwd(), services: getRegisteredPackages(), base: where.targetBase },
    ).names;
  } catch (err) {
    if (err instanceof TargetNotFoundError || err instanceof UnknownTagError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  // Only now: the checks above have no use for what a session loads.
  const { runDevSession } = await import('./session');
  await runDevSession(opts);
}
