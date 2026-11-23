import fs from 'node:fs';
import { startedByAgent } from '../agent-detection';
import { RESOLVE_ENV_FD } from '../env';
import { currentProfile, isNested } from '../env-base';
import { commandBy } from '../event-log';
import { oneOffRecorder } from '../one-off/record';
import {
  type ManyTarget,
  type OneOffAsk,
  type OneOffManyRequest,
  type OneOffManyResolution,
  type OneOffResolution,
  type OneOffSpec,
  ScriptNotFoundError,
  oneOffEnvLayer,
  oneOffEnvResolution,
  oneOffSpecFor,
  resolveOneOff,
  resolveOneOffMany,
  resolveOneOffTarget,
  whereOf,
} from '../one-off/resolve';
import { CommandStartError, runOneOff } from '../one-off/run';
import { exitCodeOf } from '../scripts';
import { oneOffLogDir } from '../session-files';
import { UnknownTagError } from '../tags';
import { type ResolvedTarget, TargetNotFoundError } from '../target';
import { loadedConfigOrExit } from './workspace';

// `stackctl exec` and `stackctl run`: thin wrappers over the one-off resolver and runner the
// SDK's `exec()` and `run()` use too. And the hidden command those two resolve through.

/** Where `exec` and `run` were invoked. */
export interface OneOffContext {
  /** The directory stackctl was invoked in. */
  invocationCwd: string;
  /**
   * What a relative target resolves against: the invocation directory, or the root when
   * `--workspace-dir` was given.
   */
  base: string;
}

/** A one-off command as the command line gave it: what it runs, and in which target. */
export type OneOffCommand = OneOffAsk & { target?: string };

/**
 * Loads the config — once — with the workspace's environment, and the proxy's self-signed
 * certificates, made now if no session has yet: a test runner started here trusts the
 * `https://` origins of the stack it starts. Returns the workspace root, where the CLI anchored.
 */
export async function loadForOneOff(): Promise<string> {
  const config = await loadedConfigOrExit();
  const root = process.cwd();
  if (config.reverseProxy?.tls === 'self-signed') {
    // Loaded only here: the TLS module is a good part of a one-off command's start.
    const { proxyTlsFor } = await import('../dev-tls');
    await proxyTlsFor(config, root);
  }
  return root;
}

/** Prints what a one-off command can't start for, and exits 1; rethrows anything else. */
export function exitOnOneOffError(err: unknown): never {
  if (
    err instanceof TargetNotFoundError ||
    err instanceof UnknownTagError ||
    err instanceof ScriptNotFoundError ||
    err instanceof CommandStartError
  ) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

/**
 * `stackctl exec [service] -- <command…>` and `stackctl run [service] <script> [-- <args…>]`: runs
 * the command to completion and exits with its exit code. No preamble: they are meant to be
 * composable, so their output is only the command's own (still teed to a logfile, which
 * `stackctl logs --path` can point at).
 */
export async function runOneOffCommand(
  command: OneOffCommand,
  context: OneOffContext,
): Promise<never> {
  const root = await loadForOneOff();
  let spec: OneOffSpec;
  try {
    spec = resolveOneOff({ ...command, root, base: context.base });
  } catch (err) {
    exitOnOneOffError(err);
  }
  // Inside a command stackctl runs, which logs and records it, nothing is left to do: this process
  // becomes the command. Returns only when it can't, and the command runs as a child instead.
  if (isNested()) {
    const { execInPlace } = await import('../one-off/in-place');
    await execInPlace(spec);
  }
  // Written to the session's event log: the service (or directory) it ran in, what it ran, its
  // exit. Its log goes in the same session's folder.
  const entry = oneOffRecorder(command, {
    root,
    profile: currentProfile(),
    nested: isNested(),
    by: commandBy(root, { agent: startedByAgent(), invocationCwd: context.invocationCwd }),
  })(whereOf(root, spec.cwd));
  try {
    const result = await runOneOff(spec, {
      stdio: 'inherit',
      logDir: oneOffLogDir(root, currentProfile()),
    });
    entry.end({ ok: result.exitCode === 0, exitCode: result.exitCode, signal: result.signal });
    process.exit(
      exitCodeOf({ exitCode: result.exitCode ?? undefined, signal: result.signal ?? undefined }),
    );
  } catch (err) {
    entry.end({ ok: false, exitCode: null, signal: null });
    exitOnOneOffError(err);
  }
}

/** What the hidden resolver command is asked for. */
export interface ResolveOneOffRequest {
  /** The target, as `exec`/`run` take it. */
  target?: string;
  /** What a relative target resolves against. */
  base: string;
  /** `exec`'s command, `run`'s script and arguments, or neither for an environment only. */
  request: OneOffAsk | { kind: 'env' };
}

/**
 * `stackctl __resolve-one-off`, which the SDK's `exec()`/`run()` and `resolveEnv()` run, so
 * their own process never imports the config: the command `exec` or `run` would run,
 * its target's environment and the files it came from, and the log directory, written as
 * JSON to {@link RESOLVE_ENV_FD} — so nothing the config prints can mix into it.
 */
export async function printOneOffResolution(opts: ResolveOneOffRequest): Promise<never> {
  const root = await loadForOneOff();
  let target: ResolvedTarget;
  try {
    target = resolveOneOffTarget({ target: opts.target, root, base: opts.base });
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
    logDir: oneOffLogDir(root, currentProfile()),
    root,
    profile: currentProfile(),
    where: whereOf(root, spec?.cwd ?? target.dir),
  };
  fs.writeSync(RESOLVE_ENV_FD, JSON.stringify(result));
  process.exit(0);
}

/**
 * Loads the config as {@link loadForOneOff} does, and resolves the many form's commands
 * ({@link resolveOneOffMany}). What can't start (an unknown service or tag, a named service
 * without the script) is printed, and exits 1.
 */
export async function loadManyForOneOff(
  request: OneOffManyRequest,
): Promise<{ root: string; targets: ManyTarget[] }> {
  const root = await loadForOneOff();
  try {
    return { root, targets: resolveOneOffMany({ ...request, root }) };
  } catch (err) {
    exitOnOneOffError(err);
  }
}

/**
 * `stackctl __resolve-one-off --many`, which the many form of the SDK's `exec()`/`run()` runs:
 * each service's command, as the many form of `exec` or `run` would run it, and the log
 * directory, written as JSON to {@link RESOLVE_ENV_FD}. What can't start is printed, and exits 1.
 */
export async function printOneOffManyResolution(request: OneOffManyRequest): Promise<never> {
  const { root, targets } = await loadManyForOneOff(request);
  const result: OneOffManyResolution = {
    targets,
    logDir: oneOffLogDir(root, currentProfile()),
    root,
    profile: currentProfile(),
  };
  fs.writeSync(RESOLVE_ENV_FD, JSON.stringify(result));
  process.exit(0);
}
