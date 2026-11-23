import fs from 'node:fs';
import path from 'node:path';
import type { AnyServiceConfig } from './config';
import { type TagSelection, selectByTags } from './tags';

// What `stackctl exec` and `stackctl run` act on: a target, named by a service or by a directory.
// And what `-s` names on `start` and `service`: a service, by its name or by a path inside it,
// beside the services `-t` tags.

/** A target that is neither a service of the workspace nor a directory inside it. */
export class TargetNotFoundError extends Error {}

/**
 * What a target resolved to. `dir` is a realpath: a service's own directory, whether it was named
 * or reached by a path at any depth, and the directory the path pointed at otherwise.
 */
export type ResolvedTarget =
  | { kind: 'service'; dir: string; service: AnyServiceConfig }
  | { kind: 'directory'; dir: string }
  | { kind: 'root'; dir: string };

/** What a target resolves among. */
interface TargetContext {
  /** The workspace root. */
  root: string;
  services: AnyServiceConfig[];
  /** What a relative path is from. */
  base: string;
}

/**
 * Resolves a target. A service name wins, unless the target starts with `./` or is absolute: a
 * service's key.
 * Otherwise it is a path, from `ctx.base` (the invocation directory, or the root when the
 * workspace was named): the service whose directory is the deepest to hold it, else the root if
 * it is the root, else a plain directory. Paths compare as canonical realpaths, so a symlink on
 * either side resolves, and so does a name typed in another case where the file system folds
 * case. No target is `.`. Throws {@link TargetNotFoundError} for a path that is missing,
 * a file, or outside the workspace.
 */
export function resolveTarget(spec: string | undefined, ctx: TargetContext): ResolvedTarget {
  const typed = spec ?? '.';
  const asPath =
    typed.startsWith('./') || path.isAbsolute(typed) || typed === '.' || typed === '..';
  if (!asPath) {
    const named = ctx.services.find((s) => s.name === typed);
    if (named) {
      return serviceTarget(named);
    }
  }
  const notFound = notFoundError(typed);
  const root = realpath(ctx.root);
  let dir: string;
  try {
    dir = fs.realpathSync.native(path.resolve(ctx.base, typed));
    if (!fs.statSync(dir).isDirectory()) {
      throw notFound;
    }
  } catch {
    throw notFound;
  }
  if (dir !== root && !dir.startsWith(withSep(root))) {
    throw notFound;
  }
  let best: { service: AnyServiceConfig; length: number } | undefined;
  for (const service of ctx.services) {
    const serviceDir = realpath(service.resolvedDir);
    if (
      (dir === serviceDir || dir.startsWith(withSep(serviceDir))) &&
      (best === undefined || serviceDir.length > best.length)
    ) {
      best = { service, length: serviceDir.length };
    }
  }
  if (best) {
    return serviceTarget(best.service);
  }
  if (dir === root) {
    return { kind: 'root', dir };
  }
  return { kind: 'directory', dir };
}

/** A service as a resolved target: in its own directory, canonical. */
export function serviceTarget(service: AnyServiceConfig): ResolvedTarget {
  return { kind: 'service', dir: realpath(service.resolvedDir), service };
}

function notFoundError(typed: string): TargetNotFoundError {
  return new TargetNotFoundError(
    `"${typed}" is neither a service nor a directory in this workspace`,
  );
}

/**
 * Resolves a target given by name, as `-s` gives one: as {@link resolveTarget} does, except
 * that an empty value, which as a path would be the base directory, is no target.
 */
export function resolveNamedTarget(typed: string, ctx: TargetContext): ResolvedTarget {
  if (typed === '') {
    throw notFoundError(typed);
  }
  return resolveTarget(typed, ctx);
}

/**
 * The services `targets` name, by name or by a path inside one: in the order given, none
 * twice. Throws `TargetNotFoundError` for what is neither a service nor a directory (an empty
 * value included), and for a directory that is no service, with
 * `"<typed>" is a directory, not a service`.
 */
export function resolveServiceNames(targets: readonly string[], ctx: TargetContext): string[] {
  const names = new Set<string>();
  for (const typed of targets) {
    const resolved = resolveNamedTarget(typed, ctx);
    if (resolved.kind !== 'service') {
      throw new TargetNotFoundError(`"${typed}" is a directory, not a service`);
    }
    names.add(resolved.service.name);
  }
  return [...names];
}

/**
 * What `-s` and `-t` select together, on a command that acts on services: each `-s` as
 * {@link resolveServiceNames} resolves it, in the order given, and with any tag the union
 * {@link selectByTags} makes of them, in config order. Throws as those two do.
 */
export function resolveServiceSelection(
  selection: { targets: readonly string[]; tags: readonly string[] },
  ctx: TargetContext,
): TagSelection {
  const names = resolveServiceNames(selection.targets, ctx);
  return selection.tags.length === 0
    ? { names, fromTagOnly: new Set() }
    : selectByTags(ctx.services, { names, tags: selection.tags }, 'service');
}

function withSep(dir: string): string {
  return dir.endsWith(path.sep) ? dir : dir + path.sep;
}

/**
 * The canonical path: symlinks resolved, and each name in the case the file system stores it, so
 * `apps/API` and `apps/api` compare equal where the file system folds case (macOS's default).
 * A path that doesn't exist is returned as it is.
 */
function realpath(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}
