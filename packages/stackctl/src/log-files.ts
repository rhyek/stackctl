import fs from 'node:fs';
import path from 'node:path';
import { currentProfile } from './env-base.js';

// Where a workspace's stackctl state and session logs live, and which logfile is the current
// one. Kept free of the config and of anything that spawns, so `stackctl logs` loads only this.

/**
 * stackctl's state directory in the workspace at `root`, `node_modules/.stackctl/`: the shared
 * `tls/` and `debug.log`, and a folder per profile under `profiles/`. Not created.
 */
export function stateDirOf(root: string): string {
  return path.join(root, 'node_modules', '.stackctl');
}

/**
 * A profile's own state, `node_modules/.stackctl/profiles/<profile>/`: its session record, saved
 * selection, trust bundle and a folder per session (`sessions/`). Not created. `reset` deletes it
 * whole.
 */
export function profileStateDir(root: string, profile: string = currentProfile()): string {
  return path.join(stateDirOf(root), 'profiles', profile);
}

/** stackctl's per-workspace state directory, `node_modules/.stackctl/` (created if needed). */
export function getStateDir(): string {
  const dir = stateDirOf(process.cwd());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** How many log file names this process has handed out: see {@link getDefaultLogFile}. */
let logFilesNamed = 0;

/**
 * A fresh log file path inside `dir` (created if needed), named `<timestamp>-<pid>-<n>.txt`, `n`
 * counting this process's calls, so several one-off commands running at once never share one.
 */
export function getDefaultLogFile(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  logFilesNamed += 1;
  return path.join(
    dir,
    `${String(Date.now())}-${String(process.pid)}-${String(logFilesNamed)}.txt`,
  );
}

/**
 * How a logfile path is shown to the user: relative to stackctl's working directory
 * (falling back to the path itself when it *is* the cwd). Shared by the footer and the
 * exit line so a session reports one and the same string throughout.
 */
export function displayLogFile(file: string): string {
  return path.relative(process.cwd(), file) || file;
}

/**
 * Picks the logfile `stackctl logs` should show, in order of precedence:
 *
 * 1. the running session's logfile, when it can be queried;
 * 2. the logfile recorded in the profile's session record (`recordedLogFile`), when it still
 * exists;
 * 3. the latest session's (`latestLogFile`), when it exists.
 *
 * Returns null when none yields one. Purely read-only — it never touches the running session.
 */
export async function resolveLogFile(opts: {
  /** Asks the live instance for its current logfile; resolves null if there's no live answer. */
  liveLogFile: () => Promise<string | null>;
  /** The logfile recorded in the profile's session record. */
  recordedLogFile?: string | null;
  /** The latest session's log, whether or not it exists. */
  latestLogFile?: string | null;
  /** Injectable for tests; defaults to `fs.existsSync`. */
  exists?: (file: string) => boolean;
}): Promise<string | null> {
  const live = await opts.liveLogFile();
  if (live) {
    return live;
  }
  const exists = opts.exists ?? fs.existsSync;
  for (const file of [opts.recordedLogFile, opts.latestLogFile]) {
    if (file && exists(file)) {
      return file;
    }
  }
  return null;
}
