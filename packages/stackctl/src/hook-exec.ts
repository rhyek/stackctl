import path from 'node:path';
import type { Exec } from './spawn.js';

/** Options for the `exec` a config callback gets, and its provider's tool helper (`compose`). */
export interface HookExecOptions {
  /** Working directory; a relative path resolves against `workspaceDir`, which is the default. */
  cwd?: string;
  /** Extra variables for this one command, merged over the callback's `envs`. */
  env?: Record<string, string>;
  /** Set `false` to get the result of a failing command instead of a rejection. */
  reject?: boolean;
}

/** How a command a config callback ran ended, with what it printed. */
export interface HookExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Where and how a config callback's commands run: what {@link hookExec} closes over. */
export interface HookExecBase {
  /** The directory a command runs in by default, and a relative `cwd` resolves against. */
  dir: string;
  /** The command's environment; a call's `env` is merged over it. */
  env: Record<string, string>;
  /** Receives each line the command prints, as it prints it. */
  onLine: (line: string, isError: boolean) => void;
  /** Runs the command: {@link execLines}, or a stand-in in specs. */
  run: Exec;
}

/**
 * The `exec` a config callback gets: runs `command` in `base.dir` (or `opts.cwd` against it) with
 * `base.env` plus `opts.env`, its output going to `base.onLine`, and resolves with its exit code
 * and output. A non-zero exit rejects with `label` (the command line) and the code, unless
 * `opts.reject` is `false`.
 */
export function hookExec(base: HookExecBase) {
  return async (
    command: string,
    args: string[] = [],
    opts: HookExecOptions = {},
    label = [command, ...args].join(' '),
  ): Promise<HookExecResult> => {
    const result = await base.run(command, args, {
      cwd: path.resolve(base.dir, opts.cwd ?? '.'),
      env: { ...base.env, ...opts.env },
      onLine: base.onLine,
    });
    if (result.exitCode !== 0 && opts.reject !== false) {
      throw new Error(`\`${label}\` exited with code ${String(result.exitCode)}`);
    }
    return result;
  };
}
