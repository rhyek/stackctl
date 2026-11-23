import { assertSdkCall, isNested, isStringArray } from '../env-base';
import { runCli } from '../sdk/cli-child';
import type { OneOffAsk, OneOffManyResolution, OneOffResolution } from './resolve';
import { resolverArgs } from './resolver-args';
import type { OneOffResult } from './run';

// The SDK's `exec()` and `run()`: what `stackctl exec` and `stackctl run` do, from a script. The
// command is resolved by stackctl's CLI in a child process — so this process never imports the
// config — and then run here, by the same runner the CLI uses.

export type { OneOffResult } from './run';

/**
 * The options of `exec()` and `run()`, in either form: checked at runtime since a JavaScript
 * caller bypasses the types.
 */
const ONE_OFF_OPTIONS = [
  'profile',
  'service',
  'tags',
  'ignoreSiblingError',
  'workspaceDir',
  'stdio',
];

/** What `exec()` and `run()` both take in the single form: one service, or none. */
export type OneOffOptions = {
  /**
   * The profile, selecting the `.env.<profile>` files to load. Default: this process's
   * `STACKCTL_PROFILE` when set (a process a stackctl started keeps its profile), else `'test'` in
   * CI (`CI` set, and not `false` or `0`), else `'development'`.
   */
  profile?: string;
  /**
   * A service, by its name or by a path, relative to the current directory (or to
   * `workspaceDir` when given). A path inside a service is that service; a directory that
   * belongs to no service runs with the workspace's environment. Omitted, the current directory,
   * or the workspace root with `workspaceDir`. An array runs the command in several services:
   * see {@link OneOffManyOptions}.
   */
  service?: string;
  /** Only in the many form: see {@link OneOffManyOptions}. */
  tags?: never;
  /** Only in the many form: see {@link OneOffManyOptions}. */
  ignoreSiblingError?: never;
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

/** What the many form of `exec()` and `run()` takes besides the services: the same for both. */
type OneOffManyCommonOptions = {
  /**
   * The profile, selecting the `.env.<profile>` files to load. Default: this process's
   * `STACKCTL_PROFILE` when set (a process a stackctl started keeps its profile), else `'test'` in
   * CI (`CI` set, and not `false` or `0`), else `'development'`.
   */
  profile?: string;
  /**
   * The workspace root, the directory holding `stackctl.config.ts`, exactly: no walk-up. Default:
   * the nearest directory at or above the current one with a config. A relative `service` path
   * resolves against it.
   */
  workspaceDir?: string;
  /**
   * `'inherit'` prints each line of every command on this process's stdout or stderr, as it
   * came, date-stamped and labelled with its service. `'pipe'` prints nothing and collects each
   * service's output into its result. Default: `'inherit'`.
   */
  stdio?: 'inherit' | 'pipe';
  /**
   * Run every command to its end, whatever the others do. Default: `false`, the first failure
   * stops the others.
   */
  ignoreSiblingError?: boolean;
};

/**
 * The many form of `exec()` and `run()`: the command in several services at once, each in its
 * directory with its environment. A `service` array, `tags`, or both: in config order, none twice,
 * then the directories that belong to no service, as given.
 */
export type OneOffManyOptions = OneOffManyCommonOptions &
  (
    | {
        /**
         * Services, each by its name or by a path as in the single form. A directory that belongs
         * to no service is accepted. One name is still the many form.
         */
        service: string[];
        /** Every service with one of these tags, beside `service`. */
        tags?: string[];
      }
    | {
        /** Every service with one of these tags. */
        tags: string[];
        /** A service, or several, beside the tagged ones: each by its name or by a path. */
        service?: string | string[];
      }
  );

/** `exec()`'s options: a literal command. */
export type ExecOptions = OneOffOptions & {
  /** The program and its arguments, run as given: no shell. */
  command: [string, ...string[]];
};

/** `exec()`'s options in the many form: a literal command, in each service. */
export type ExecManyOptions = OneOffManyOptions & {
  /** The program and its arguments, run as given in each service: no shell. */
  command: [string, ...string[]];
};

/** `run()`'s options: one of the service's `package.json` scripts or make targets. */
export type RunOptions = OneOffOptions & {
  /** The script or make target. */
  script: string;
  /** Arguments forwarded to it. */
  args?: string[];
};

/** `run()`'s options in the many form: a script or make target, in each service that has it. */
export type RunManyOptions = OneOffManyOptions & {
  /**
   * The script or make target. A service a tag matched that lacks it is skipped; a named one
   * that lacks it, or none having it, rejects.
   */
  script: string;
  /** Arguments forwarded to it. */
  args?: string[];
};

/** What the many form of `exec()` and `run()` resolves with: every service's result. */
export type OneOffManyResult = {
  /** Every command that ran exited 0. */
  ok: boolean;
  /** One per service, in config order, then the directories as given. */
  results: Array<{
    /** The service's name, or for a directory in no service, its path from the root. */
    service: string;
    /**
     * `failed`: it ended with a non-zero exit, or by a signal, by itself, or couldn't start.
     * `stopped`: stackctl stopped it, since another one failed or this process was sent a
     * signal. `skipped`: no such script.
     */
    status: 'ok' | 'failed' | 'stopped' | 'skipped';
    /** The command's exit code, or `null` when a signal ended it or it never ran. */
    exitCode: number | null;
    /** The signal that ended it, else `null`. */
    signal: NodeJS.Signals | null;
    /** Why it couldn't start. */
    error?: string;
    /** With `stdio: 'pipe'`: what it printed on stdout. */
    stdout?: string;
    /** With `stdio: 'pipe'`: what it printed on stderr. */
    stderr?: string;
  }>;
};

/**
 * Runs a literal command in a service's directory, with its environment, as `stackctl exec` does,
 * in a child process. Resolves with its exit code and signal — never exits this process — and
 * rejects only when it can't start: no config, an unknown service, a command not found. SIGTERM
 * and SIGHUP sent to this process reach the command while it runs, and so does SIGINT, unless the
 * command shares this process's terminal (`stdio: 'inherit'` with stdin a TTY), where a Ctrl-C
 * already reached it.
 */
export function exec(options: ExecOptions): Promise<OneOffResult>;
/**
 * Runs a literal command in several services at once, each in its directory with its
 * environment, as `stackctl exec -s … -t …` does. Resolves with every service's result — a
 * command that can't start is a `failed` one, with its `error` — and rejects only when nothing
 * can start: no config, an unknown service or tag. The first failure stops the others, unless
 * `ignoreSiblingError`. Signals sent to this process reach every command.
 */
export function exec(options: ExecManyOptions): Promise<OneOffManyResult>;
export async function exec(
  options: ExecOptions | ExecManyOptions,
): Promise<OneOffResult | OneOffManyResult> {
  assertSdkCall('exec', options, [...ONE_OFF_OPTIONS, 'command']);
  const { command } = options;
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error('exec: `command` needs at least the program to run');
  }
  const request = ['--exec', '--', ...command];
  const asked: OneOffAsk = { kind: 'exec', command };
  return isManyForm('exec', options)
    ? runManyResolved(options as ExecManyOptions, request, asked)
    : runResolved(options as ExecOptions, request, asked);
}

/**
 * Runs one of a service's `package.json` scripts or make targets, with its environment, as
 * `stackctl run` does, in a child process. Resolves with its exit code and signal — never exits
 * this process — and rejects only when it can't start: no config, an unknown service, a missing
 * script. SIGTERM and SIGHUP sent to this process reach the script while it runs, and so does
 * SIGINT, unless the script shares this process's terminal (`stdio: 'inherit'` with stdin a TTY),
 * where a Ctrl-C already reached it.
 */
export function run(options: RunOptions): Promise<OneOffResult>;
/**
 * Runs a script or make target in several services at once, each with its environment, as
 * `stackctl run -s … -t …` does. Resolves with every service's result, a service a tag matched
 * that lacks the script `skipped`, and rejects only when nothing can start: no config, an
 * unknown service or tag, a named service without the script, a script none of them has. The
 * first failure stops the others, unless `ignoreSiblingError`. Signals sent to this process
 * reach every command.
 */
export function run(options: RunManyOptions): Promise<OneOffManyResult>;
export async function run(
  options: RunOptions | RunManyOptions,
): Promise<OneOffResult | OneOffManyResult> {
  assertSdkCall('run', options, [...ONE_OFF_OPTIONS, 'script', 'args']);
  if (typeof options.script !== 'string' || options.script === '') {
    throw new Error('run: `script` names the script or make target to run');
  }
  const args = options.args ?? [];
  const request = [`--run=${options.script}`, '--', ...args];
  const asked: OneOffAsk = { kind: 'run', script: options.script, args };
  return isManyForm('run', options)
    ? runManyResolved(options as RunManyOptions, request, asked)
    : runResolved(options as RunOptions, request, asked);
}

/**
 * Whether `options` are the many form (a `service` array, or `tags`), checking what the types
 * would have: a malformed `service` or `tags`, an empty `service` value (which would be the
 * current directory), `ignoreSiblingError` in the single form or not a boolean, and the many
 * form naming nothing.
 */
function isManyForm(
  fn: 'exec' | 'run',
  options: { service?: unknown; tags?: unknown; ignoreSiblingError?: unknown },
): boolean {
  const { service, tags } = options;
  if (service !== undefined && typeof service !== 'string' && !isStringArray(service)) {
    throw new Error(`${fn}: \`service\` takes a string or an array of strings`);
  }
  if (tags !== undefined && !isStringArray(tags)) {
    throw new Error(`${fn}: \`tags\` takes an array of strings`);
  }
  const services = service === undefined ? [] : [service].flat();
  if (services.includes('')) {
    throw new Error(`${fn}: \`service\` can't be an empty string`);
  }
  const many = Array.isArray(service) || tags !== undefined;
  if (!many) {
    if (options.ignoreSiblingError !== undefined) {
      throw new Error(`${fn}: \`ignoreSiblingError\` needs several services or \`tags\``);
    }
    return false;
  }
  if (options.ignoreSiblingError !== undefined && typeof options.ignoreSiblingError !== 'boolean') {
    throw new Error(`${fn}: \`ignoreSiblingError\` takes a boolean`);
  }
  if (services.length + (tags?.length ?? 0) === 0) {
    throw new Error(`${fn}: the many form needs a service or a tag`);
  }
  return true;
}

/**
 * Resolves the command in a child CLI and runs it here, writing a `one-off-command` begin and end
 * to the session's event log, as `stackctl exec` and `run` do, with the calling script as `by`.
 */
async function runResolved(
  options: OneOffOptions,
  request: string[],
  asked: OneOffAsk,
): Promise<OneOffResult> {
  const args = resolverArgs(options, request);
  const { spec, logDir, root, profile, where } = await runCli<OneOffResolution>(args);
  if (!spec) {
    throw new Error('stackctl: the resolver returned no command');
  }
  // Loaded only now: importing `stackctl` (a config does) mustn't load what runs a command.
  const [{ runOneOff }, record] = await Promise.all([
    import('./run'),
    recorderFor(asked, root, profile),
  ]);
  const entry = record(where);
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
 * Resolves the command for every service in a child CLI and runs them all here, at once, writing
 * each one's `one-off-command` begin and end to the session's event log, as the many form of
 * `stackctl exec` and `run` does, with the calling script as `by`. Prints no summary.
 */
async function runManyResolved(
  options: OneOffManyOptions,
  request: string[],
  asked: OneOffAsk,
): Promise<OneOffManyResult> {
  const args = resolverArgs(options, request);
  const { targets, logDir, root, profile } = await runCli<OneOffManyResolution>(args);
  // Loaded only now, as for one command.
  const [{ runMany }, { createManyPrinter }, record] = await Promise.all([
    import('./many'),
    import('./many-print'),
    recorderFor(asked, root, profile),
  ]);
  const stdio = options.stdio ?? 'inherit';
  const run = await runMany(targets, {
    stdio,
    ignoreSiblingError: options.ignoreSiblingError === true,
    logDir,
    ...(stdio === 'inherit' && {
      onLine: createManyPrinter(targets, {
        stdout: process.stdout,
        stderr: process.stderr,
        nested: isNested(),
      }),
    }),
    record: (target) => record(target.where),
  });
  return {
    ok: run.ok,
    // How long each ran is for the command line's summary only.
    results: run.results.map(({ ms: _ms, ...result }) => result),
  };
}

/**
 * What writes the event-log lines of `asked`'s commands, as `stackctl exec` and `run` do, with
 * the calling script as `by`. Loaded only when a command runs.
 */
async function recorderFor(asked: OneOffAsk, root: string, profile: string) {
  const [{ oneOffRecorder }, { sdkBy }, { startedByAgent }] = await Promise.all([
    import('./record'),
    import('../event-log'),
    import('../agent-detection'),
  ]);
  return oneOffRecorder(asked, {
    root,
    profile,
    nested: isNested(),
    by: sdkBy(root, { agent: startedByAgent(), cwd: process.cwd() }),
  });
}
