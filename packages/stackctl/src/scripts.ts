import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AnyServiceConfig } from './config.js';
import { getDevScript } from './config.js';

// A service's scripts (its package.json scripts, or its Makefile's targets) and how to run one.

/** Scripts the commands menu never lists: `dev` is what a session runs as the dev process. */
const MENU_HIDDEN_SCRIPTS = new Set(['dev']);

type PackageJson = { name?: string; version?: string; scripts?: Record<string, string> };

function readPackageJson(pkg: AnyServiceConfig): PackageJson | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(pkg.absoluteDir, 'package.json'), 'utf8'),
    ) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * The raw text of a package.json script, or null when the package has no package.json / no such
 * script (a Makefile package always returns null — its recipe isn't readable this way).
 */
export function getScriptText(pkg: AnyServiceConfig, script: string): string | null {
  return readPackageJson(pkg)?.scripts?.[script] ?? null;
}

/**
 * What runs the package's scripts: `make` for a package with a Makefile and no package.json,
 * `/bin/sh` otherwise.
 */
export function runnerOf(pkg: AnyServiceConfig): 'sh' | 'make' {
  const present = (file: string) => fs.existsSync(path.join(pkg.absoluteDir, file));
  return !present('package.json') && present('Makefile') ? 'make' : 'sh';
}

/** How to spawn a package script or make target: the command, its args, and its environment. */
export interface ExecSpec {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** `node_modules/.bin` of `dir` and of each of its ancestors that has one, nearest first. */
function binDirs(dir: string): string[] {
  const dirs: string[] = [];
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const bin = path.join(current, 'node_modules', '.bin');
    if (fs.statSync(bin, { throwIfNoEntry: false })?.isDirectory()) {
      dirs.push(bin);
    }
    if (path.dirname(current) === current) {
      return dirs;
    }
  }
}

/**
 * How to spawn `script` for a package, with `extraArgs` forwarded to it. Spawn the result with
 * the package's directory as cwd and with its `env` — `env` (the environment the caller would
 * otherwise spawn with) plus whatever the script needs on top.
 *
 * A `package.json` script is run as its own text through `/bin/sh`, with no package manager in
 * between. Most shells replace themselves with a script that is a single command (bash and
 * busybox do; dash stays as its parent), so the spawned process is usually the script itself —
 * which is why a fatal signal can surface either as a signal or as a 128+n exit code; see
 * {@link exitCodeOf}. The package's `node_modules/.bin` and every ancestor's go on `PATH`, and
 * the variables naming the package and script are set for it — over any inherited from a
 * package manager that started stackctl, which describe the workspace root instead.
 */
export function scriptExec(
  pkg: AnyServiceConfig,
  script: string,
  extraArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): ExecSpec {
  if (runnerOf(pkg) === 'make') {
    // make forwards args that follow the target name straight to it.
    return { cmd: 'make', args: [script, ...extraArgs], env };
  }
  const text = getScriptText(pkg, script);
  if (text === null) {
    return {
      cmd: '/bin/sh',
      args: ['-c', 'echo "Missing script: \\"$1\\"" >&2; exit 1', 'sh', script],
      env,
    };
  }
  const packageJson = readPackageJson(pkg);
  return {
    cmd: '/bin/sh',
    // Extra args ride along as positional parameters, so the shell quotes them, not us.
    args: extraArgs.length > 0 ? ['-c', `${text} "$@"`, 'sh', ...extraArgs] : ['-c', text],
    env: {
      ...env,
      PATH: [...binDirs(pkg.absoluteDir), ...(env.PATH ? [env.PATH] : [])].join(path.delimiter),
      // An absent name/version stays `undefined`, which leaves an inherited one out of the child.
      npm_package_name: packageJson?.name,
      npm_package_version: packageJson?.version,
      npm_package_json: path.join(pkg.absoluteDir, 'package.json'),
      npm_lifecycle_event: script,
      npm_lifecycle_script: text,
      INIT_CWD: pkg.absoluteDir,
      PNPM_SCRIPT_SRC_DIR: pkg.absoluteDir,
    },
  };
}

/**
 * The exit code of a finished child process, by shell convention: its own code when it exited,
 * 128 + the signal number when a signal killed it, and 1 when it never ran.
 */
export function exitCodeOf(result: { exitCode?: number; signal?: string }): number {
  if (result.exitCode !== undefined) {
    return result.exitCode;
  }
  const signal = os.constants.signals[result.signal as NodeJS.Signals] as number | undefined;
  return signal === undefined ? 1 : 128 + signal;
}

/** Whether the package has `script`: a make target, or a package.json script that isn't empty. */
export function definesScript(pkg: AnyServiceConfig, script: string): boolean {
  return runnerOf(pkg) === 'make'
    ? makeTargetsOf(pkg).includes(script)
    : (getScriptText(pkg, script) ?? '') !== '';
}

/**
 * Whether stackctl can run this package as a dev process — the single "is it startable?" check
 * (used for the picker and the session's `canDev`). `command: null` opts out explicitly;
 * otherwise the package must expose its dev script/target.
 */
export function definesDevScript(pkg: AnyServiceConfig): boolean {
  return pkg.command !== null && definesScript(pkg, getDevScript(pkg));
}

export function makeTargetsOf(pkg: AnyServiceConfig): string[] {
  try {
    const mk = fs.readFileSync(path.join(pkg.absoluteDir, 'Makefile'), 'utf8');
    // Exclude make's special targets (`.PHONY`, `.DEFAULT`, …) — they start with `.` and aren't
    // runnable targets, so they must not surface as commands.
    return [...mk.matchAll(/^([a-zA-Z0-9_.-]+):/gm)]
      .map((m) => m[1]!)
      .filter((t) => !t.startsWith('.'));
  } catch {
    return [];
  }
}

export function menuCommandsOf(pkg: AnyServiceConfig): string[] {
  const names =
    runnerOf(pkg) === 'make'
      ? makeTargetsOf(pkg)
      : Object.keys(readPackageJson(pkg)?.scripts ?? {});
  // Exclude the scripts the menu hides and this package's configured dev command (run via s/r).
  const devScript = getDevScript(pkg);
  return names.filter((n) => !MENU_HIDDEN_SCRIPTS.has(n) && n !== devScript);
}
