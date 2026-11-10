import fs from 'node:fs';
import path from 'node:path';
import type { AnyServiceConfig } from './config.js';

// What `stackctl exec` and `stackctl run` act on: a target, named by a service or by a directory.

/** A target that is neither a service of the workspace nor a directory inside it. */
export class TargetNotFoundError extends Error {}

/**
 * What a target resolved to. `dir` is a realpath: a service's own directory, whether it was named
 * or reached by a path at any depth, and the directory the path pointed at otherwise.
 */
export type ResolvedTarget =
  | { kind: 'service'; dir: string; service: AnyServiceConfig }
  | { kind: 'directory'; dir: string; relativeDir: string }
  | { kind: 'root'; dir: string };

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
export function resolveTarget(
  spec: string | undefined,
  ctx: { root: string; services: AnyServiceConfig[]; base: string },
): ResolvedTarget {
  const typed = spec ?? '.';
  const asPath =
    typed.startsWith('./') || path.isAbsolute(typed) || typed === '.' || typed === '..';
  if (!asPath) {
    const named = ctx.services.find((s) => s.name === typed);
    if (named) {
      return { kind: 'service', dir: realpath(named.absoluteDir), service: named };
    }
  }
  const notFound = new TargetNotFoundError(
    `"${typed}" is neither a service nor a directory in this workspace`,
  );
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
    const serviceDir = realpath(service.absoluteDir);
    if (
      (dir === serviceDir || dir.startsWith(withSep(serviceDir))) &&
      (best === undefined || serviceDir.length > best.length)
    ) {
      best = { service, length: serviceDir.length };
    }
  }
  if (best) {
    return { kind: 'service', dir: realpath(best.service.absoluteDir), service: best.service };
  }
  if (dir === root) {
    return { kind: 'root', dir };
  }
  return { kind: 'directory', dir, relativeDir: path.relative(root, dir) };
}

function withSep(dir: string): string {
  return dir.endsWith(path.sep) ? dir : dir + path.sep;
}

/**
 * The canonical path: symlinks resolved, and each name in the case the file system stores it, so
 * `apps/API` and `apps/api` compare equal where the file system folds case (macOS's default).
 */
function realpath(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}
