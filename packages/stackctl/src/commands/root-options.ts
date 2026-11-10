import type { StartOptions } from './default.js';

// `start`'s options — given after `start`, or at the root, which hands them to it — checked by
// the CLI before it loads anything a session needs, so a bad combination fails fast.

/**
 * Why the options can't run together, or `undefined` when they can. Each refusal names the flag
 * that's in the way.
 */
export function rootOptionsRefusal(opts: StartOptions): string | undefined {
  if (opts.ui && opts.headless) {
    return "--ui and --headless can't be combined.";
  }
  if (opts.detach) {
    if (opts.ui) {
      return "--ui and --detach can't be combined.";
    }
    if (opts.service.length === 0 && !opts.lastAnswers) {
      return '--detach needs services to start: pass --service or --last-answers.';
    }
    if (opts.waitTimeout !== undefined && !(opts.waitTimeout > 0)) {
      return '--wait-timeout takes a number of seconds above 0.';
    }
  } else {
    if (opts.waitTimeout !== undefined) {
      return '--wait-timeout is for --detach.';
    }
  }
  return undefined;
}
