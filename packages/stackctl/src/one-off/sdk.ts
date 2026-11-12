import { spawn } from 'node:child_process';
import { RESOLVE_ENV_FD, assertOutsideCli, rejectUnknownOptions } from '../env-base.js';
import type { OneOffCommandEntry } from '../event-log.js';
import type { OneOffResolution } from './resolve.js';
import { resolverArgs } from './resolver-args.js';
import type { OneOffResult } from './run.js';

// The SDK's `exec()` and `run()`: what `stackctl exec` and `stackctl run` do, from a script. The
// command is resolved by stackctl's CLI in a child process — so this process never imports the
// config — and then run here, by the same runner the CLI uses.

export type { OneOffResult } from './run.js';

/** The options of {@link OneOffOptions}, checked at runtime since a JavaScript caller bypasses the types. */
const ONE_OFF_OPTIONS = ['mode', 'target', 'workspaceDir', 'stdio'];

/** What `exec()` and `run()` both take. */
export type OneOffOptions = {
  /**
   * The mode, selecting the `.env.<mode>` files to load. Default: this process's
   * `STACKCTL_MODE` when set (a process a stackctl started keeps its mode), else `'test'` in CI
   * (`CI` set, and not `false` or `0`), else `'development'`.
   */
  mode?: string;
  /**
   * The target: a service's name or a path, relative to the current directory (or to
   * `workspaceDir` when given). A path inside a service is that service. Omitted, the current
   * directory, or the workspace root with `workspaceDir`.
   */
  target?: string;
  /**
   * The workspace root, the directory holding `stackctl.config.ts`, exactly: no walk-up. Default:
   * the nearest directory at or above the current one with a config.
   */
  workspaceDir?: string;
  /**
   * `'inherit'` gives the command this process's stdout and stderr: each one that is a terminal
   * as it is, so the command sees a terminal, and the others piped through (all of them for a
   * coding agent). `'pipe'` collects the output into the result. Default: `'inherit'`.
   */
  stdio?: 'inherit' | 'pipe';
};

/** `exec()`'s options: a literal command. */
export type ExecOptions = OneOffOptions & {
  /** The program and its arguments, run as given: no shell. */
  command: [string, ...string[]];
};

/** `run()`'s options: one of the target's `package.json` scripts or make targets. */
export type RunOptions = OneOffOptions & {
  /** The script or make target. */
  script: string;
  /** Arguments forwarded to it. */
  args?: string[];
};

/**
 * Runs a literal command in a target's directory, with its environment, as `stackctl exec` does,
 * in a child process. Resolves with its exit code and signal — never exits this process — and
 * rejects only when it can't start: no config, an unknown target, a command not found. SIGTERM
 * and SIGHUP sent to this process reach the command while it runs, and so does SIGINT, unless the
 * command shares this process's terminal (`stdio: 'inherit'` with stdin a TTY), where a Ctrl-C
 * already reached it.
 */
export async function exec(options: ExecOptions): Promise<OneOffResult> {
  assertOutsideCli('exec');
  rejectUnknownOptions('exec', options, [...ONE_OFF_OPTIONS, 'command']);
  const { command } = options;
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error('exec: `command` needs at least the program to run');
  }
  return runResolved(options, ['--exec', '--', ...command], { kind: 'exec', command });
}

/**
 * Runs one of a target's `package.json` scripts or make targets, with its environment, as
 * `stackctl run` does, in a child process. Resolves with its exit code and signal — never exits
 * this process — and rejects only when it can't start: no config, an unknown target, a missing
 * script. SIGTERM and SIGHUP sent to this process reach the script while it runs, and so does
 * SIGINT, unless the script shares this process's terminal (`stdio: 'inherit'` with stdin a TTY),
 * where a Ctrl-C already reached it.
 */
export async function run(options: RunOptions): Promise<OneOffResult> {
  assertOutsideCli('run');
  rejectUnknownOptions('run', options, [...ONE_OFF_OPTIONS, 'script', 'args']);
  if (typeof options.script !== 'string' || options.script === '') {
    throw new Error('run: `script` names the script or make target to run');
  }
  const args = options.args ?? [];
  return runResolved(options, [`--run=${options.script}`, '--', ...args], {
    kind: 'run',
    script: options.script,
    args,
  });
}

/** What `exec()` or `run()` was asked to run, as its event-log lines name it. */
type Asked = { kind: 'exec'; command: string[] } | { kind: 'run'; script: string; args: string[] };

/**
 * Resolves the command in a child CLI and runs it here, writing a `one-off-command` begin and end
 * to the session's event log, as `stackctl exec` and `run` do, with the calling script as `by`.
 */
async function runResolved(
  options: OneOffOptions,
  request: string[],
  asked: Asked,
): Promise<OneOffResult> {
  const args = resolverArgs(options, request);
  const { spec, logDir, root, mode, where } = await resolveInChild(args);
  if (!spec) {
    throw new Error('stackctl: the resolver returned no command');
  }
  // Loaded only now: importing `stackctl` (a config does) mustn't load what runs a command.
  const [{ runOneOff }, { cliEventLog, maskSecrets, sdkBy }, { startedByAgent }] =
    await Promise.all([
      import('./run.js'),
      import('../event-log.js'),
      import('../agent-detection.js'),
    ]);
  const entry = cliEventLog(root, mode).begin<OneOffCommandEntry>(
    {
      type: 'one-off-command',
      kind: asked.kind,
      ...where,
      ...(asked.kind === 'exec'
        ? { command: maskSecrets(asked.command) }
        : { script: asked.script, args: maskSecrets(asked.args) }),
    },
    sdkBy(root, { agent: startedByAgent(), cwd: process.cwd() }),
  );
  try {
    const result = await runOneOff(spec, { stdio: options.stdio ?? 'inherit', logDir });
    entry.end({ ok: result.exitCode === 0, exitCode: result.exitCode, signal: result.signal });
    return result;
  } catch (err) {
    entry.end({ ok: false, exitCode: null, signal: null });
    throw err;
  }
}

/**
 * Runs the CLI's resolver and resolves with what it wrote to {@link RESOLVE_ENV_FD}. It starts in
 * this process's directory and environment, which stackctl reads as a shell's: a variable a
 * stackctl that started this process gave it is dropped. Rejects with what it printed when it
 * fails.
 */
function resolveInChild(args: string[]): Promise<OneOffResolution> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      // What the config prints goes to this process's stderr, never into its stdout — which a
      // caller may be capturing, or parsing.
      stdio: ['ignore', process.stderr, 'pipe', 'pipe'],
    });
    let stderr = '';
    let out = '';
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const result = child.stdio[RESOLVE_ENV_FD] as NodeJS.ReadableStream | null;
    result?.setEncoding('utf8');
    result?.on('data', (chunk: string) => {
      out += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0 || !out) {
        const why = stderr.trim() || `stackctl exited with ${signal ?? `code ${String(code)}`}`;
        reject(new Error(why));
        return;
      }
      // What the config or dotenvx said along the way, as the CLI would have printed it.
      process.stderr.write(stderr);
      try {
        resolve(JSON.parse(out) as OneOffResolution);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
