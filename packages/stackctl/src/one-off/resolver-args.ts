import { fileURLToPath } from 'node:url';
import { RESOLVE_ONE_OFF_COMMAND, assertValidMode } from '../env-base.js';

// How the SDK's `exec()`/`run()` and `resolveEnv()` invoke the CLI's hidden resolver. Imports
// nothing heavy: `resolveEnv` is on a config's path.

/** The options every caller of the resolver shares. */
export interface ResolverTarget {
  mode?: string;
  target?: string;
  workspaceDir?: string;
}

/**
 * The argv that runs the compiled CLI's resolver for `options`, then `request`: `--exec -- …`,
 * `--run=<script> -- …`, or nothing for the environment only.
 */
export function resolverArgs(options: ResolverTarget, request: string[] = []): string[] {
  const args = [fileURLToPath(new URL('../cli.js', import.meta.url))];
  // Unset, the mode is left to the CLI, which reads it as it would from a shell.
  if (options.mode !== undefined) {
    args.push(`--mode=${assertValidMode(options.mode)}`);
  }
  if (options.workspaceDir !== undefined) {
    args.push(`--workspace-dir=${options.workspaceDir}`);
  }
  args.push(RESOLVE_ONE_OFF_COMMAND);
  if (options.target !== undefined) {
    args.push(`--target=${options.target}`);
  }
  args.push(...request);
  return args;
}
