import fs from 'node:fs';
import path from 'node:path';
import { currentMode } from './env-base.js';

// Where a workspace's stackctl state and session logs live, and which logfile is the current
// one. Kept free of the config and of anything that spawns, so `stackctl logs` loads only this.

/**
 * stackctl's state directory in the workspace at `root`, `node_modules/.stackctl/`: the shared
 * `tls/` and `debug.log`, and a folder per mode under `modes/`. Not created.
 */
export function stateDirOf(root: string): string {
  return path.join(root, 'node_modules', '.stackctl');
}

/**
 * A mode's own state, `node_modules/.stackctl/modes/<mode>/`: its session record, saved selection,
 * trust bundle, default logs and event log. Not created. `reset` deletes it whole.
 */
export function modeStateDir(root: string, mode: string = currentMode()): string {
  return path.join(stateDirOf(root), 'modes', mode);
}

/** stackctl's per-workspace state directory, `node_modules/.stackctl/` (created if needed). */
export function getStateDir(): string {
  const dir = stateDirOf(process.cwd());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Default directory for the active mode's timestamped session logs:
 * `node_modules/.stackctl/modes/<mode>/logs/`. Each mode has its own, as each runs its own session.
 */
export function getLogDir(): string {
  return path.join(modeStateDir(process.cwd()), 'logs');
}

/** How many log file names this process has handed out: see {@link getDefaultLogFile}. */
let logFilesNamed = 0;

/**
 * A fresh log file path inside `dir` (created if needed), named
 * `<timestamp>-<pid>-<n>.log`, `n` counting this process's calls. Each run — each in-session
 * rotation, and each of several one-off commands running at once — gets a unique name, so no
 * log is ever overwritten. Pass `dir` to choose the location (e.g. the `--log-dir` override, or
 * the current logfile's dir when rotating); defaults to `getLogDir()`.
 */
export function getDefaultLogFile(dir: string = getLogDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  logFilesNamed += 1;
  return path.join(
    dir,
    `${String(Date.now())}-${String(process.pid)}-${String(logFilesNamed)}.log`,
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
 * The most recently modified `*.log` file in `dir` (absolute path), or null when `dir` is
 * missing or holds no logfiles. Used by `stackctl logs` to locate the current session's log
 * when a live instance can't be queried for it.
 */
export function pickNewestLog(dir: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith('.log')) {
      continue;
    }
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile() && (!newest || st.mtimeMs > newest.mtimeMs)) {
        newest = { path: full, mtimeMs: st.mtimeMs };
      }
    } catch {
      /* raced away between readdir and stat — skip */
    }
  }
  return newest?.path ?? null;
}

/**
 * Picks the logfile `stackctl logs` should show, in order of precedence:
 *
 * 1. the running instance's current (rotation-aware) logfile, when it can be queried;
 * 2. the logfile recorded in the mode's session record (`recordedLogFile`), when it still exists — more
 *    precise than scanning the dir, since a stray `stackctl exec` log could be newer;
 * 3. the newest `*.log` in `fallbackDir`.
 *
 * Returns null when none yields one. Purely read-only — it never touches the running session.
 */
export async function resolveLogFile(opts: {
  /** Asks the live instance for its current logfile; resolves null if there's no live answer. */
  liveLogFile: () => Promise<string | null>;
  /** The logfile recorded in the mode's session record, used when there's no live answer and it still exists. */
  recordedLogFile?: string | null;
  /** Directory searched for the newest `*.log` as a last resort. */
  fallbackDir: string;
  /** Injectable for tests; defaults to {@link pickNewestLog}. */
  newestLog?: (dir: string) => string | null;
  /** Injectable for tests; defaults to `fs.existsSync`. */
  exists?: (file: string) => boolean;
}): Promise<string | null> {
  const live = await opts.liveLogFile();
  if (live) {
    return live;
  }
  const exists = opts.exists ?? fs.existsSync;
  if (opts.recordedLogFile && exists(opts.recordedLogFile)) {
    return opts.recordedLogFile;
  }
  return (opts.newestLog ?? pickNewestLog)(opts.fallbackDir);
}
