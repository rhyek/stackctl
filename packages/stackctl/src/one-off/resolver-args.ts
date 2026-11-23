import { fileURLToPath } from 'node:url';
import { RESOLVE_ONE_OFF_COMMAND, assertValidProfile } from '../env-base';

// How the SDK's `exec()`/`run()` and `resolveEnv()` invoke the CLI's hidden resolver. Imports
// nothing heavy: `resolveEnv` is on a config's path.

/** The options every caller of the resolver shares. */
export interface ResolverTarget {
  profile?: string;
  /** One service, or with an array the many form. */
  service?: string | readonly string[];
  /** The many form, with or beside `service`. */
  tags?: readonly string[];
  workspaceDir?: string;
}

/**
 * The argv that runs the compiled CLI's resolver for `options`, then `request`: `--exec -- …`,
 * `--run=<script> -- …`, or nothing for the environment only. A `service` array or `tags` is
 * the many form: `--many`, each value as a `--target` and each tag as a `--tag`.
 */
export function resolverArgs(options: ResolverTarget, request: string[] = []): string[] {
  const args = [fileURLToPath(new URL('../cli.js', import.meta.url))];
  // Unset, the profile is left to the CLI, which reads it as it would from a shell.
  if (options.profile !== undefined) {
    args.push(`--profile=${assertValidProfile(options.profile)}`);
  }
  if (options.workspaceDir !== undefined) {
    args.push(`--workspace-dir=${options.workspaceDir}`);
  }
  args.push(RESOLVE_ONE_OFF_COMMAND);
  if (Array.isArray(options.service) || options.tags !== undefined) {
    args.push('--many');
    const services = options.service === undefined ? [] : [options.service].flat();
    args.push(...services.map((service) => `--target=${service}`));
    args.push(...(options.tags ?? []).map((tag) => `--tag=${tag}`));
  } else if (typeof options.service === 'string') {
    args.push(`--target=${options.service}`);
  }
  args.push(...request);
  return args;
}
