import { spawn } from 'node:child_process';
import { assertSdkCall, assertStringArrays } from '../env-base';
import {
  CLI_TARGET,
  type CliTarget,
  childEnv,
  cliArgs,
  flagArgs,
  runCli,
  sdkCallerBy,
  selectionArgs,
} from './cli-child';

// The SDK's `infra`: `stackctl infra …` from a script, with no session needed. Each function runs
// the command in a child process and resolves with what it did to each service.

/** Which infra services an `infra` function acts on. */
export interface InfraSelection extends CliTarget {
  /** Infra services, by name. With neither this nor `tags`, every enabled one. */
  services?: string[];
  /** Every enabled infra service with one of these tags, beside `services`. */
  tags?: string[];
}

/** The options of `infra.start`, `infra.restart` and `infra.reset`. */
export interface InfraStartOptions extends InfraSelection {
  /** How long to wait for the services to be ready, in seconds. Default: the config's `readyTimeout`. */
  waitTimeout?: number;
}

/** What an `infra` function did. */
export interface InfraResult {
  /** Every service reached the state the command names, and no lifecycle hook failed. */
  ok: boolean;
  /** One per service the command acted on. */
  results: Array<{
    /** The infra service's name. */
    service: string;
    /**
     * `ready` (start, restart, reset), `stopped`, `destroyed`, or `failed`. A reset that removed
     * the service and stopped there, because an `afterDestroy` failed, leaves it `destroyed`.
     */
    status: 'ready' | 'stopped' | 'destroyed' | 'failed';
    /**
     * Why it failed; with a status other than `failed`, the lifecycle hook that failed around a
     * step that went ahead (a `beforeStop` that threw, the service stopped all the same), or why a
     * reset destroyed the service and didn't start it.
     */
    error?: string;
  }>;
}

/** What `infra.compose()` resolves with. */
export interface InfraComposeResult {
  /** `docker compose`'s exit code. */
  exitCode: number;
  /** With `stdio: 'pipe'`. */
  stdout?: string;
  /** With `stdio: 'pipe'`. */
  stderr?: string;
}

const SELECTION = [...CLI_TARGET, 'services', 'tags'];

/** Checks what a JavaScript caller passed, where the types can't. */
function checkSelection(fn: string, options: InfraStartOptions): void {
  for (const key of ['services', 'tags'] as const) {
    assertStringArrays(fn, options, [key]);
    // On the command line nothing named is every enabled service, and `destroy` the whole
    // project; an array that came out empty must not mean that.
    if (options[key]?.length === 0) {
      throw new Error(`${fn}: \`${key}\` is empty; leave it out to act on every enabled service`);
    }
  }
}

async function runInfraCommand(
  action: 'start' | 'stop' | 'restart' | 'reset' | 'destroy',
  options: InfraStartOptions,
  allowed: string[],
): Promise<InfraResult> {
  const fn = `infra.${action}`;
  assertSdkCall(fn, options, allowed);
  checkSelection(fn, options);
  const command = [
    'infra',
    action,
    ...selectionArgs(options),
    ...flagArgs('--wait-timeout', options.waitTimeout),
  ];
  return runCli<InfraResult>(cliArgs(options, command), { by: await sdkCallerBy() });
}

/** What `infra.compose()` takes. */
export interface InfraComposeOptions extends CliTarget {
  /** `'inherit'` gives the command this process's stdout and stderr; `'pipe'` collects them. */
  stdio?: 'inherit' | 'pipe';
}

function compose(args: string[], options: InfraComposeOptions = {}): Promise<InfraComposeResult> {
  assertSdkCall('infra.compose', options, [...CLI_TARGET, 'stdio']);
  const command = cliArgs(options, ['infra', 'docker-compose', ...args], { result: false });
  return runCompose(command, options.stdio === 'pipe');
}

/** Runs the CLI's passthrough, `args`, its output this process's or collected (`pipe`). */
async function runCompose(args: string[], pipe: boolean): Promise<InfraComposeResult> {
  const env = await childEnv(await sdkCallerBy());
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env,
      stdio: ['inherit', pipe ? 'pipe' : 'inherit', pipe ? 'pipe' : 'inherit'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ exitCode: code ?? 1, ...(pipe ? { stdout, stderr } : {}) });
    });
  });
}

/** `stackctl infra …` from a script. See each function. */
export const infra = {
  /** Starts the services and waits until each is ready, running `afterReady`. */
  start: (options: InfraStartOptions = {}) =>
    runInfraCommand('start', options, [...SELECTION, 'waitTimeout']),
  /** Stops the services and removes their containers, keeping their named volumes. */
  stop: (options: InfraSelection = {}) => runInfraCommand('stop', options, SELECTION),
  /** Stops the services, then starts them: the containers are recreated. */
  restart: (options: InfraStartOptions = {}) =>
    runInfraCommand('restart', options, [...SELECTION, 'waitTimeout']),
  /** Removes the services and their data, then starts them clean. With nothing named, the whole project. */
  reset: (options: InfraStartOptions = {}) =>
    runInfraCommand('reset', options, [...SELECTION, 'waitTimeout']),
  /** Removes the services and their data, starting nothing. With nothing named, the whole project. */
  destroy: (options: InfraSelection = {}) => runInfraCommand('destroy', options, SELECTION),
  /**
   * Runs `docker compose <args>` on this project and profile, as `stackctl infra docker-compose`
   * does. `stdio: 'inherit'` (the default) gives the command this process's stdout and stderr;
   * `'pipe'` collects them.
   */
  compose,
};
