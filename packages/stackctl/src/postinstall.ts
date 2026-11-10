import fs from 'node:fs';
import path from 'node:path';
import { isCI } from './env-base.js';
import { runInit } from './init.js';
import { findConfigPath } from './load-config.js';
import { installMissingSkill, readOwnVersion, refreshSkillIfStale } from './skill.js';

/**
 * stackctl's `postinstall`: keeps the installed agent skill current on every `install`, so a
 * fresh clone (or an upgrade of stackctl) carries the guide matching the version in
 * `node_modules`. A project with no config yet gets `stackctl init --yes` — the config scaffold,
 * the tsconfig reconcile, and the skill; one that has a config gets the skill where it's missing,
 * and an unedited copy an older version wrote refreshed.
 *
 * Runs only for the project that installed stackctl: `INIT_CWD` (set by npm, pnpm, and yarn to
 * the directory the install was run in) must have this very package under its `node_modules`.
 * That rules out stackctl's own workspace, a global install, and an unrelated cwd. Skipped in
 * CI, where nobody reads the skill and stray writes would only dirty a checkout. Never throws —
 * a failed postinstall would fail the install itself, over a file that `stackctl init` can
 * write later.
 *
 * pnpm 10+ runs a dependency's lifecycle scripts only once approved (`pnpm approve-builds`, or
 * `pnpm.onlyBuiltDependencies` in the root `package.json`); until then this is a no-op there and
 * `stackctl init` does the same job by hand.
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
      // Nothing set up yet: the full first-time flow, non-interactive.
      await runInit({ cwd, yes: true });
      return;
    }
    // A copy that is there is refreshed only when an older version wrote it and nobody has edited
    // it since; one of someone's own is never touched. `stackctl init` rewrites them on request.
    const added = installMissingSkill({ cwd, version: opts.version });
    const refreshed = refreshSkillIfStale({ cwd, version: opts.version });
    for (const [verb, files] of [
      ['installed', added],
      ['updated', refreshed],
    ] as const) {
      if (files.length > 0) {
        const where = files.map((file) => path.relative(cwd, file)).join(', ');
        write(`stackctl: ${verb} the agent skill at ${where}`);
      }
    }
  } catch (err) {
    write(
      `stackctl: could not install the agent skill (${err instanceof Error ? err.message : String(err)}); ` +
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
