import { type ChildProcess, spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { RESOLVE_ENV_FD, assertValidProfile } from '../env-base';
import type { EventBy } from '../event-log';
import { stripAnsi } from '../format';
import { SDK_RESULT_FLAG } from '../sdk-result';

// Running a CLI command from the SDK: in a child process, so the calling process never loads the
// config, and so each behaviour has one implementation, the command's. Nothing here loads more
// than Node itself: a config imports `stackctl`, and these modules are on its path.

/** The options every SDK function that runs a command takes. */
export interface CliTarget {
  /**
   * The profile, as `--profile` takes it. Default: as the CLI resolves it from a shell:
   * `STACKCTL_PROFILE`, else `test` in CI, else `development`.
   */
  profile?: string;
  /**
   * The workspace: the directory holding `stackctl.config.ts`, relative or absolute, as
   * `--workspace-dir` takes it. Default: the nearest directory at or above the current one.
   */
  workspaceDir?: string;
}

/** The options of {@link CliTarget}, which every function that runs a command takes. */
export const CLI_TARGET = ['profile', 'workspaceDir'];

/**
 * The argv that runs the compiled CLI's `command` for `options`: the profile and the workspace
 * as `--profile` and `--workspace-dir`, then the command, then `--sdk-result` unless the command
 * streams its output instead (`result: false`).
 */
export function cliArgs(
  options: CliTarget,
  command: string[],
  opts: { result?: boolean } = {},
): string[] {
  const args = [fileURLToPath(new URL('../cli.js', import.meta.url))];
  if (options.profile !== undefined) {
    args.push(`--profile=${assertValidProfile(options.profile)}`);
  }
  if (options.workspaceDir !== undefined) {
    args.push(`--workspace-dir=${options.workspaceDir}`);
  }
  args.push(...command);
  if (opts.result !== false) {
    args.push(SDK_RESULT_FLAG);
  }
  return args;
}

/** `-s` for each of `services`, then `-t` for each of `tags`: a selection, as the CLI takes it. */
export function selectionArgs(options: { services?: string[]; tags?: string[] }): string[] {
  return [
    ...(options.services ?? []).flatMap((name) => ['-s', name]),
    ...(options.tags ?? []).flatMap((tag) => ['-t', tag]),
  ];
}

/** `flag` and `value`, as the CLI takes an option, or nothing when `value` is unset. */
export function flagArgs(flag: string, value: string | number | undefined): string[] {
  return value === undefined ? [] : [flag, String(value)];
}

/**
 * Who is asking, for the event log of the command an SDK function runs: the Node script that
 * called it, with absolute paths, which the command makes relative to its workspace root.
 */
export async function sdkCallerBy(): Promise<EventBy> {
  // Loaded only now, as in `childEnv`.
  const [{ sdkCaller }, { startedByAgent }] = await Promise.all([
    import('../event-log'),
    import('../agent-detection'),
  ]);
  return sdkCaller({ agent: startedByAgent(), cwd: process.cwd() });
}

/** The child's environment: this process's, with `by` handed on for the event log. */
export async function childEnv(by: EventBy | undefined): Promise<NodeJS.ProcessEnv> {
  if (by === undefined) {
    return process.env;
  }
  // Loaded only now: the event log is a session's, and nothing on a config's path needs it.
  const { EVENT_BY_ENV } = await import('../event-log');
  return { ...process.env, [EVENT_BY_ENV]: JSON.stringify(by) };
}

/**
 * Runs `args` (a script and its arguments) with this Node, and resolves with the JSON it wrote to
 * {@link RESOLVE_ENV_FD} — whatever its exit code, since a command that ran writes its result
 * also when a service failed. With no result it rejects: with what the child printed on stderr,
 * colors stripped, or how it exited. The child's stdout goes to this process's stderr, never its
 * stdout, which a caller may be capturing or parsing; its stderr is collected, and copied to this
 * process's stderr once it has resolved.
 */
export async function runCli<T>(args: string[], opts: { by?: EventBy } = {}): Promise<T> {
  const env = await childEnv(opts.by);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env,
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
      if (!out) {
        const why =
          stripAnsi(stderr).trim() ||
          (code === 0
            ? 'stackctl wrote no result'
            : `stackctl exited with ${signal ?? `code ${String(code)}`}`);
        reject(new Error(why));
        return;
      }
      process.stderr.write(stderr);
      try {
        resolve(JSON.parse(out) as T);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/**
 * Runs `args` with this Node and yields each line it prints on stdout, until it exits. Its stderr
 * is copied to this process's stderr as it comes. A child that ends with a non-zero exit, which
 * this didn't cause, throws: with what it printed on stderr, colors stripped, or how it exited.
 * The child is ended (SIGTERM, by the pid this started) when the loop stops early or `signal`
 * aborts, and that ending is no error.
 */
export async function* streamCli(args: string[], signal?: AbortSignal): AsyncGenerator<string> {
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  let ended = false;
  const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code }));
  });
  const end = () => {
    if (child.exitCode === null && child.signalCode === null) {
      ended = true;
      child.kill('SIGTERM');
    }
  };
  signal?.addEventListener('abort', end, { once: true });
  const lines = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (signal?.aborted) {
        return;
      }
      yield line;
    }
    const { code, error } = await exited;
    if (error) {
      throw error;
    }
    if (code !== 0 && !ended && !signal?.aborted) {
      throw new Error(stripAnsi(stderr).trim() || `stackctl exited with code ${String(code)}`);
    }
  } finally {
    signal?.removeEventListener('abort', end);
    lines.close();
    end();
  }
}
