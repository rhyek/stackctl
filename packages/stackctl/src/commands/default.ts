import { resolveSelectedNames } from '../saved-selection.js';
import { readOwnVersion, refreshSkillIfStale } from '../skill.js';
import { loadConfigOrExit, validatePackageNames } from './workspace.js';

// `stackctl start`, the default command — `stackctl` with no subcommand: a dev session.

/** `start`'s options: the session's. */
export interface StartOptions {
  service: string[];
  /** Declared for --help/validation; the value in force is read from argv by resolveMode. */
  mode?: string;
  ui?: boolean;
  headless?: boolean;
  lastAnswers: boolean;
  logDir?: string;
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

  // Best-effort: a skill refresh should never block a run. No-ops unless the skill was
  // actually installed (a managed banner in the installed file says so).
  try {
    refreshSkillIfStale({ cwd: process.cwd(), version: readOwnVersion() });
  } catch (err) {
    console.error('stackctl: skill refresh failed (non-fatal):', err);
  }

  // Validate --package names before mounting/running anything.
  validatePackageNames(opts.service);

  // Only now: the checks above have no use for what a session loads.
  const { runDevSession } = await import('./session.js');
  await runDevSession(opts);
}
