import fs from 'node:fs';
import path from 'node:path';
import {
  type AnyServiceConfig,
  type Config,
  getLoadedConfig,
  getRegisteredPackages,
  getWorkspaceDir,
} from '../config';
import {
  type SerializedEnvResolution,
  assignedNames,
  envCandidatePaths,
  envDirs,
  envFileNames,
  serviceEnvOptions,
  targetEnvLayer,
  withoutWorkspaceEnv,
} from '../env';
import { labelColorOf } from '../log-colors';
import { scriptExec, definesScript } from '../scripts';
import { selectByTags } from '../tags';
import { type ResolvedTarget, resolveNamedTarget, resolveTarget, serviceTarget } from '../target';
import { sessionTrustFile } from '../trust-file';
import type { OneOffSpec } from './run';

// Resolving a one-off command where the config is loaded: the CLI's own process for `exec` and
// `run`, or the child CLI the SDK's `exec()` and `run()` start for it.

export type { OneOffSpec } from './run';

/** Where a one-off command runs from: the workspace root, and what a relative target is from. */
interface OneOffPlace {
  /** The target: a service's name or a path. Omitted, `base` itself. */
  target?: string;
  /** What a relative target resolves against: the invocation directory, or the root when the workspace was named. */
  base: string;
  /** The workspace root. */
  root: string;
}

/** What a one-off command runs: a literal command (`exec`), or a script or make target (`run`). */
export type OneOffAsk =
  | { kind: 'exec'; command: [string, ...string[]] }
  | { kind: 'run'; script: string; args: string[] };

/** A one-off command to resolve, and where. */
export type OneOffRequest = OneOffPlace & OneOffAsk;

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
    // The config's own root, which its services resolved against: not always `root`, the folder
    // holding the config, when the config points `workspaceDir` elsewhere.
    resolvedWorkspaceDir: getWorkspaceDir(),
    files: config.envFiles ?? envFileNames(),
    override: config.envOverride,
    decrypt: config.envDecrypt,
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
  request: OneOffAsk,
  layer: Record<string, string> = oneOffEnvLayer(target, root),
): OneOffSpec {
  const env: NodeJS.ProcessEnv = { ...withoutWorkspaceEnv(), ...layer };
  if (request.kind === 'exec') {
    const [command, ...args] = request.command;
    return { cwd: target.dir, command, args, env };
  }
  // scriptExec/definesScript key off `.resolvedDir` only, so a minimal view over the target's
  // directory suffices — a service's, or a directory that is none.
  const atDir = { resolvedDir: target.dir } as AnyServiceConfig;
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
  return oneOffSpecFor(resolveOneOffTarget(request), request.root, request);
}

/** The directory a target's `.env` files are walked up from: absolute, as {@link envDirs} takes it. */
function dirOf(target: ResolvedTarget): string {
  switch (target.kind) {
    case 'service':
      return target.service.resolvedDir;
    case 'directory':
      return target.dir;
    case 'root':
      return getWorkspaceDir();
  }
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
  const resolvedWorkspaceDir = getWorkspaceDir();
  const resolvedDir = dirOf(target);
  const candidates = envCandidatePaths({
    resolvedWorkspaceDir,
    resolvedDir,
    files:
      target.kind === 'service'
        ? (serviceEnvOptions(target.service).files ?? config.envFiles)
        : config.envFiles,
  });
  const files = candidates.filter((file) => fs.existsSync(file));
  // The target's own files, as against those of the directories above it. A target at the root
  // has one directory, which is its own.
  const ownDir = envDirs(resolvedWorkspaceDir, resolvedDir).at(-1);
  const own = files.filter((file) => path.dirname(file) === ownDir);
  const env = { ...layer };
  for (const name of ['STACKCTL_PROFILE', 'STACKCTL_CWD', 'STACKCTL_WORKSPACE_DIR'] as const) {
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
 * tees to: the `commands/` folder of the profile's current session.
 */
export interface OneOffResolution extends SerializedEnvResolution {
  spec: OneOffSpec | null;
  logDir: string;
  /** The workspace root and the profile: where the command's event-log lines go. */
  root: string;
  profile: string;
  /** Where the command runs, as its event-log lines name it. */
  where: OneOffWhere;
}

/** Where a one-off command runs, as its event-log lines name it: a service, or a directory. */
export type OneOffWhere = { service: string } | { dir: string };

/**
 * Where a one-off command running in `cwd` runs, for its event-log lines: a service, or a
 * directory.
 */
export function whereOf(root: string, cwd: string): OneOffWhere {
  const service = getRegisteredPackages().find(
    (pkg) => path.resolve(pkg.resolvedDir) === path.resolve(cwd),
  )?.name;
  return service ? { service } : { dir: path.relative(root, cwd) || '.' };
}

/**
 * What the hidden resolver command writes with `--many`: each service's command (`spec: null`
 * for one skipped), and the log directory the commands tee to.
 */
export interface OneOffManyResolution {
  targets: ManyTarget[];
  logDir: string;
  /** The workspace root and the profile: where the commands' event-log lines go. */
  root: string;
  profile: string;
}

/** One command of the many form: where it runs, under what label, and what it runs. */
export interface ManyTarget {
  /** A service's name, or a directory's path relative to the root (`.` for the root). */
  label: string;
  /** Where it runs, as its event-log lines name it. */
  where: OneOffWhere;
  /**
   * A service's {@link labelColorOf label color}, its position counted among the services in
   * this list. None for a directory.
   */
  color?: string;
  /** `null`: skipped, since a tag matched it and it has no such script. */
  spec: OneOffSpec | null;
}

/** The many form of `exec` and `run`: what each command runs, and where. */
export type OneOffManyRequest = OneOffAsk & {
  /** Each `-s` (or the resolver's `--target`), as given. */
  targets: string[];
  /** Each `-t` (or the resolver's `--tag`). */
  tags: string[];
  /** What a relative target resolves against. */
  base: string;
};

/**
 * Resolves the many form of `exec` and `run`: the services and directories `targets` name and
 * the services `tags` select, each with the command it runs. One entry per directory: services
 * in config order, then directories as given. Throws `TargetNotFoundError` for an unknown or
 * empty target, `UnknownTagError` for an unknown tag, and {@link ScriptNotFoundError} for a
 * `run` of a script that a named service or directory lacks, or that none of them has.
 */
export function resolveOneOffMany(request: OneOffManyRequest & { root: string }): ManyTarget[] {
  const { root } = request;
  const services = Object.values(loadedConfig().services);
  const named = request.targets.map((target) =>
    resolveNamedTarget(target, { root, services, base: request.base }),
  );
  const namedServices = new Set<string>();
  const directories = new Map<string, ResolvedTarget>();
  for (const target of named) {
    if (target.kind === 'service') {
      namedServices.add(target.service.name);
    } else {
      directories.set(target.dir, target);
    }
  }
  const selection = selectByTags(
    services,
    { names: [...namedServices], tags: request.tags },
    'service',
  );
  const byName = new Map(services.map((service) => [service.name, service]));
  const entries = [
    ...selection.names.map((name) => ({
      target: serviceTarget(byName.get(name)!),
      tagOnly: selection.fromTagOnly.has(name),
    })),
    ...[...directories.values()].map((target) => ({ target, tagOnly: false })),
  ];

  // The services come first: a service's index is its position among them.
  const many = entries.map(({ target, tagOnly }, index): ManyTarget => {
    let spec: OneOffSpec | null;
    try {
      spec = oneOffSpecFor(target, root, request);
    } catch (err) {
      if (!(err instanceof ScriptNotFoundError) || !tagOnly) {
        throw err;
      }
      spec = null;
    }
    if (target.kind === 'service') {
      const { service } = target;
      return {
        label: service.name,
        where: { service: service.name },
        color: labelColorOf(service.color, index),
        spec,
      };
    }
    const where = whereOf(root, target.dir);
    return { label: 'dir' in where ? where.dir : where.service, where, spec };
  });
  // Only a `run` skips: an `exec` command always has a spec.
  if (request.kind === 'run' && many.length > 0 && many.every((m) => m.spec === null)) {
    const labels = many.map((m) => m.label).join(', ');
    throw new ScriptNotFoundError(
      `No "${request.script}" script or make target found in any of: ${labels}`,
    );
  }
  return many;
}
