import fs from 'node:fs';
import { proxyTlsFor } from '../dev-tls.js';
import { RESOLVE_ENV_FD } from '../env.js';
import { getLogDir } from '../log-files.js';
import {
  type OneOffResolution,
  type OneOffSpec,
  ScriptNotFoundError,
  oneOffEnvLayer,
  oneOffEnvResolution,
  oneOffSpecFor,
  resolveOneOff,
  resolveOneOffTarget,
} from '../one-off/resolve.js';
import { CommandStartError, runOneOff } from '../one-off/run.js';
import { exitCodeOf } from '../scripts.js';
import { type ResolvedTarget, TargetNotFoundError } from '../target.js';
import { loadedConfigOrExit } from './workspace.js';

// `stackctl exec` and `stackctl run`: thin wrappers over the one-off resolver and runner the
// SDK's `exec()` and `run()` use too. And the hidden command those two resolve through.

/** Where `exec` and `run` were invoked, and their own options. */
export interface OneOffContext {
  /** The directory stackctl was invoked in: what a relative target resolves against. */
  invocationCwd: string;
  /** Whether `--workspace-dir` was given: a relative target then resolves against the root. */
  workspaceDirGiven: boolean;
  /** The `--log-dir` override, if any. */
  logDir?: string;
}

/** A one-off command as the command line gave it. */
export type OneOffCommand =
  | { kind: 'exec'; target?: string; command: [string, ...string[]] }
  | { kind: 'run'; target?: string; script: string; args: string[] };

/**
 * Loads the config — once — with the workspace's environment, and the proxy's self-signed
 * certificates, made now if no session has yet: a test runner started here trusts the
 * `https://` origins of the stack it starts. Returns the workspace root, where the CLI anchored.
 */
async function loadForOneOff(): Promise<string> {
  const config = await loadedConfigOrExit();
  const root = process.cwd();
  if (config.reverseProxy?.tls === 'self-signed') {
    await proxyTlsFor(config, root);
  }
  return root;
}

/** Prints what a one-off command can't start for, and exits 1; rethrows anything else. */
function exitOnOneOffError(err: unknown): never {
  if (
    err instanceof TargetNotFoundError ||
    err instanceof ScriptNotFoundError ||
    err instanceof CommandStartError
  ) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

/**
 * `stackctl exec [target] -- <command…>` and `stackctl run [target] <script> [-- <args…>]`: runs
 * the command to completion and exits with its exit code. No preamble: they are meant to be
 * composable, so their output is only the command's own (still teed to a logfile, which
 * `stackctl logs --path` can point at).
 */
export async function runOneOffCommand(
  command: OneOffCommand,
  context: OneOffContext,
): Promise<never> {
  const root = await loadForOneOff();
  const base = context.workspaceDirGiven ? root : context.invocationCwd;
  let spec: OneOffSpec;
  try {
    spec = resolveOneOff({ ...command, root, base });
  } catch (err) {
    exitOnOneOffError(err);
  }
  try {
    const result = await runOneOff(spec, { stdio: 'inherit', logDir: context.logDir });
    process.exit(
      exitCodeOf({ exitCode: result.exitCode ?? undefined, signal: result.signal ?? undefined }),
    );
  } catch (err) {
    exitOnOneOffError(err);
  }
}

/** What the hidden resolver command is asked for. */
export interface ResolveOneOffRequest extends OneOffContext {
  /** The target, as `exec`/`run` take it. */
  target?: string;
  /** `exec`'s command, `run`'s script and arguments, or neither for an environment only. */
  request:
    | { kind: 'exec'; command: [string, ...string[]] }
    | { kind: 'run'; script: string; args: string[] }
    | { kind: 'env' };
}

/**
 * `stackctl __resolve-one-off`, which the SDK's `exec()`/`run()` and `resolveEnv()` run, so
 * their own process never imports the config: the command `exec` or `run` would run,
 * its target's environment and the files it came from, and the log directory, written as
 * JSON to {@link RESOLVE_ENV_FD} — so nothing the config prints can mix into it.
 */
export async function printOneOffResolution(opts: ResolveOneOffRequest): Promise<never> {
  const root = await loadForOneOff();
  const base = opts.workspaceDirGiven ? root : opts.invocationCwd;
  let target: ResolvedTarget;
  try {
    target = resolveOneOffTarget({ target: opts.target, root, base });
  } catch (err) {
    exitOnOneOffError(err);
  }
  const layer = oneOffEnvLayer(target, root);
  let spec: OneOffSpec | null = null;
  if (opts.request.kind !== 'env') {
    try {
      spec = oneOffSpecFor(target, root, opts.request, layer);
    } catch (err) {
      exitOnOneOffError(err);
    }
  }
  const result: OneOffResolution = {
    spec,
    ...oneOffEnvResolution(target, root, layer),
    logDir: getLogDir(),
  };
  fs.writeSync(RESOLVE_ENV_FD, JSON.stringify(result));
  process.exit(0);
}
