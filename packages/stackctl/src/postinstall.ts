import fs from 'node:fs';
import path from 'node:path';
import { refreshGuidance } from './agent-guidance.js';
import { isCI } from './env-base.js';
import { runInit } from './init.js';
import { findConfigPath } from './load-config.js';
import { readOwnVersion } from './skill.js';

/**
 * stackctl's `postinstall`: keeps the agent guidance already in a project current on every
 * `install`, so an upgrade of stackctl carries the files matching the version in
 * `node_modules`. It installs none of them: an install shouldn't put files in a repo unasked,
 * so a person is offered them at a session's start, and `stackctl init` installs them for a
 * script. A project with no config yet gets `stackctl init --yes` without the guidance: the
 * config scaffold and the tsconfig reconcile.
 *
 * Runs only for the project that installed stackctl: `INIT_CWD` (set by npm, pnpm, and yarn to
 * the directory the install was run in) must have this very package under its `node_modules`.
 * That rules out stackctl's own workspace, a global install, and an unrelated cwd. Skipped in
 * CI, where stray writes would only dirty a checkout. Never throws — a failed postinstall would
 * fail the install itself.
 *
 * pnpm 10+ runs a dependency's lifecycle scripts only once approved (`pnpm approve-builds`, or
 * `pnpm.onlyBuiltDependencies` in the root `package.json`); until then this is a no-op there, and
 * a session's start refreshes the same files.
 */
export async function runPostinstall(opts: {
  /** The installed stackctl package's root (the directory holding its `package.json`). */
  packageDir: string;
  env: Record<string, string | undefined>;
  version: string;
  /** Where to report (a line at most); defaults to stderr. */
  write?: (line: string) => void;
}): Promise<void> {
  const write = opts.write ?? ((line) => process.stderr.write(`${line}\n`));
  try {
    const initCwd = opts.env.INIT_CWD;
    if (!initCwd || isCI(opts.env)) {
      return;
    }
    const cwd = realpathOrNull(initCwd);
    const installed = realpathOrNull(path.join(initCwd, 'node_modules', 'stackctl'));
    if (!cwd || !installed || installed !== realpathOrNull(opts.packageDir)) {
      return;
    }

    if (!findConfigPath(cwd)) {
      // Nothing set up yet: the config and the tsconfig, non-interactive.
      await runInit({ cwd, yes: true, guidance: false });
      return;
    }
    // A file that is there is refreshed only when an older version wrote it and nobody has
    // edited it since; one of someone's own is never touched.
    const refreshed = refreshGuidance({ cwd, version: opts.version });
    if (refreshed.length > 0) {
      const where = refreshed.map((file) => path.relative(cwd, file)).join(', ');
      write(`stackctl: updated the agent guidance at ${where}`);
    }
  } catch (err) {
    write(
      `stackctl: could not update the agent guidance (${err instanceof Error ? err.message : String(err)}); ` +
        'run `stackctl init` to do it by hand.',
    );
  }
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** The package's `postinstall` entry (called by `postinstall.js` at the package root). */
export function main(): Promise<void> {
  return runPostinstall({
    packageDir: path.resolve(import.meta.dirname, '..'),
    env: process.env,
    version: readOwnVersion(),
  });
}
