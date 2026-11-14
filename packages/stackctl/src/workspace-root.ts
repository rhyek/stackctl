import fs from 'node:fs';
import path from 'node:path';
import { findPassthrough } from './infra/argv.js';

// Where the workspace is: wherever `stackctl.config.ts` is. Found from the working directory by
// walking up to the nearest one, or named exactly with `--workspace-dir` (no walk-up).

/**
 * Config file names, in discovery order. `stackctl.config.ts` is canonical; the others are
 * runtime-only fallbacks (a `.js`/`.mjs` config works at runtime but carries no inline
 * `declare module` type augmentation).
 */
export const CONFIG_NAMES = [
  'stackctl.config.ts',
  'stackctl.config.mts',
  'stackctl.config.js',
  'stackctl.config.mjs',
];

export function findConfigPath(cwd: string = process.cwd()): string | null {
  for (const name of CONFIG_NAMES) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/** No `stackctl.config.ts` where the workspace was looked for. */
export class WorkspaceNotFoundError extends Error {}

/**
 * The workspace: its root (the realpath of the directory holding the config) and its config file.
 * With `workspaceDir`, that directory exactly; without, the nearest directory at or above `from`
 * (default `process.cwd()`) that holds a config. Throws {@link WorkspaceNotFoundError}.
 */
export function locateWorkspace(opts: { workspaceDir?: string; from?: string }): {
  root: string;
  configPath: string;
} {
  if (opts.workspaceDir !== undefined) {
    const dir = realpath(path.resolve(opts.from ?? process.cwd(), opts.workspaceDir));
    const configPath = findConfigPath(dir);
    if (!configPath) {
      throw new WorkspaceNotFoundError(`No stackctl.config.ts in ${dir}`);
    }
    return { root: dir, configPath };
  }
  const start = realpath(path.resolve(opts.from ?? process.cwd()));
  let dir = start;
  for (;;) {
    const configPath = findConfigPath(dir);
    if (configPath) {
      return { root: dir, configPath };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new WorkspaceNotFoundError(
        `No stackctl.config.ts in ${start} or any directory above it`,
      );
    }
    dir = parent;
  }
}

function realpath(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

// The directory of the config being loaded, which `defineConfig` defaults `workspaceDir` to. On
// `globalThis`, since the config may import another copy of this module than the CLI's (a linked
// `stackctl`).
const CONFIG_DIR = Symbol.for('stackctl.configDir');

/** Records the directory of the config about to be imported. */
export function recordConfigDir(dir: string): void {
  (globalThis as Record<symbol, unknown>)[CONFIG_DIR] = dir;
}

/** The directory of the config being, or last, loaded; `undefined` outside a CLI-loaded config. */
export function recordedConfigDir(): string | undefined {
  return (globalThis as Record<symbol, string | undefined>)[CONFIG_DIR];
}

/** Options that take a value, in `stackctl`'s own argument position. */
const VALUE_OPTIONS = new Set(['-p', '--profile', '--workspace-dir', '-s', '--service']);

/** The end of stackctl's own arguments: a bare `--`, or an `infra <provider>` passthrough. */
function ownArgs(argv: readonly string[]): readonly string[] {
  const passthrough = findPassthrough(argv);
  const end = passthrough === -1 ? argv.indexOf('--') : passthrough;
  return end === -1 ? argv : argv.slice(0, end);
}

/**
 * `--workspace-dir`, read from raw argv like the profile is (the workspace is located before
 * Commander parses). Stops where stackctl's own arguments do. `undefined` when absent.
 */
export function resolveWorkspaceDirArg(argv: readonly string[]): string | undefined {
  const args = ownArgs(argv);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--workspace-dir') {
      const value = args[i + 1];
      if (value === undefined || value === '') {
        throw new Error('--workspace-dir needs a directory');
      }
      return value;
    }
    if (arg.startsWith('--workspace-dir=')) {
      const value = arg.slice('--workspace-dir='.length);
      if (value === '') {
        throw new Error('--workspace-dir needs a directory');
      }
      return value;
    }
  }
  return undefined;
}

/**
 * Whether this invocation needs no config: `init` (it makes one), `help`, `--help` and
 * `--version`. Read from raw argv, where the command is the first word that is no option or
 * option value.
 */
export function needsNoWorkspace(argv: readonly string[]): boolean {
  const { command, helpOrVersion } = readCommand(argv);
  return helpOrVersion || command === 'init' || command === 'help';
}

/**
 * The command raw argv names, the first word that is no option or option value (`undefined` for
 * bare `stackctl`), and whether it asks for help or the version.
 */
export function readCommand(argv: readonly string[]): {
  command: string | undefined;
  helpOrVersion: boolean;
} {
  const args = ownArgs(argv.slice(2));
  let command: string | undefined;
  let helpOrVersion = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-h' || arg === '--help' || arg === '-V' || arg === '--version') {
      helpOrVersion = true;
    } else if (VALUE_OPTIONS.has(arg)) {
      i++;
    } else if (!arg.startsWith('-') && command === undefined) {
      command = arg;
    }
  }
  return { command, helpOrVersion };
}
