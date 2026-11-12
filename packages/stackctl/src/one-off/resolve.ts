import fs from 'node:fs';
import path from 'node:path';
import { type AnyServiceConfig, type Config, getLoadedConfig } from '../config.js';
import { sessionTrustFile } from '../dev-tls.js';
import {
  type SerializedEnvResolution,
  assignedNames,
  envCandidatePaths,
  envFileNames,
  targetEnvLayer,
} from '../env.js';
import { scriptExec, definesScript } from '../scripts.js';
import { type ResolvedTarget, resolveTarget } from '../target.js';
import type { OneOffSpec } from './run.js';

// Resolving a one-off command where the config is loaded: the CLI's own process for `exec` and
// `run`, or the child CLI the SDK's `exec()` and `run()` start for it.

export type { OneOffSpec } from './run.js';

/** Where a one-off command runs from: the workspace root, and what a relative target is from. */
interface OneOffPlace {
  /** The target: a service's name or a path. Omitted, `base` itself. */
  target?: string;
  /** What a relative target resolves against: the invocation directory, or the root when the workspace was named. */
  base: string;
  /** The workspace root. */
  root: string;
}

/** A one-off command to resolve: a literal command (`exec`), or a script or make target (`run`). */
export type OneOffRequest =
  | (OneOffPlace & { kind: 'exec'; command: [string, ...string[]] })
  | (OneOffPlace & { kind: 'run'; script: string; args: string[] });

/** A `run` of a script the target has neither in its `package.json` nor as a make target. */
export class ScriptNotFoundError extends Error {}

function loadedConfig(): Config<string> {
  const config = getLoadedConfig();
  if (!config) {
    throw new Error('stackctl: a one-off command resolves against a loaded config');
  }
  return config;
}

/** The target of a one-off command, among the loaded config's services. */
export function resolveOneOffTarget(place: OneOffPlace): ResolvedTarget {
  return resolveTarget(place.target, {
    root: place.root,
    services: Object.values(loadedConfig().services),
    base: place.base,
  });
}

/**
 * The environment layer a target's command runs with, over the ambient environment: what the
 * session starts its service with, or a directory's or the workspace's own.
 */
export function oneOffEnvLayer(target: ResolvedTarget, root: string): Record<string, string> {
  const config = loadedConfig();
  return targetEnvLayer(target, {
    cwd: root,
    files: config.envFiles ?? envFileNames(),
    override: config.envOverride,
    vars: config.envVars,
    extraCaCerts: sessionTrustFile(root),
  });
}

/**
 * The command a resolved target runs: in its directory, with this process's environment and the
 * target's layer over it. Throws {@link ScriptNotFoundError} for a `run` of a missing script.
 */
export function oneOffSpecFor(
  target: ResolvedTarget,
  root: string,
  request: { kind: 'exec'; command: [string, ...string[]] } | { kind: 'run'; script: string; args: string[] }, // oxfmt-ignore
  layer: Record<string, string> = oneOffEnvLayer(target, root),
): OneOffSpec {
  const env: NodeJS.ProcessEnv = { ...process.env, ...layer };
  if (request.kind === 'exec') {
    const [command, ...args] = request.command;
    return { cwd: target.dir, command, args, env };
  }
  // scriptExec/definesScript key off `.absoluteDir` only, so a minimal view over the target's
  // directory suffices — a service's, or a directory that is none.
  const atDir = { absoluteDir: target.dir } as AnyServiceConfig;
  if (!definesScript(atDir, request.script)) {
    throw new ScriptNotFoundError(
      `No "${request.script}" script or make target found in ${target.dir}`,
    );
  }
  const spec = scriptExec(atDir, request.script, request.args, env);
  return { cwd: target.dir, command: spec.cmd, args: spec.args, env: spec.env };
}

/**
 * Resolves a one-off command against the loaded config: its target, and the command, directory
 * and environment it runs with. Throws `TargetNotFoundError` for an unknown target, and
 * {@link ScriptNotFoundError} for a `run` of a missing script.
 */
export function resolveOneOff(request: OneOffRequest): OneOffSpec {
  const target = resolveOneOffTarget(request);
  return oneOffSpecFor(
    target,
    request.root,
    request.kind === 'exec'
      ? { kind: 'exec', command: request.command }
      : { kind: 'run', script: request.script, args: request.args },
  );
}

/**
 * A target's environment as `resolveEnv()` returns it: its layer with the
 * variables stackctl sets itself, and the files it was resolved from.
 */
export function oneOffEnvResolution(
  target: ResolvedTarget,
  root: string,
  layer: Record<string, string> = oneOffEnvLayer(target, root),
): SerializedEnvResolution {
  const config = loadedConfig();
  const relativeDir =
    target.kind === 'service'
      ? target.service.relativeDir
      : target.kind === 'directory'
        ? target.relativeDir
        : '.';
  const candidates = envCandidatePaths({ cwd: root, relativeDir, files: config.envFiles });
  const files = candidates.filter((file) => fs.existsSync(file));
  // A target at the root has one scope, which is its own.
  const ownDir = path.resolve(root, relativeDir);
  const own = files.filter((file) => path.dirname(file) === ownDir);
  const env = { ...layer };
  for (const name of ['STACKCTL_MODE', 'STACKCTL_CWD', 'STACKCTL_WORKSPACE_DIR'] as const) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return {
    env,
    files,
    candidates,
    packageNames: [...assignedNames(own.map((file) => fs.readFileSync(file, 'utf8')).join('\n'))],
  };
}

/**
 * What the hidden resolver command writes: the command (`null` when asked for an environment
 * only), the target's environment as `resolveEnv` returns it, and the log directory the command
 * tees to: the `commands/` folder of the mode's current session.
 */
export interface OneOffResolution extends SerializedEnvResolution {
  spec: OneOffSpec | null;
  logDir: string;
}
