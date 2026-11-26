import { afterAll, beforeAll } from 'vitest';

/**
 * The variables that would make a CLI a spec starts behave as something else than a person's
 * command: a CI run (the profile defaults to `test`, and Ink stops being interactive), and a
 * command stackctl itself runs (it logs nothing and records no event). Deleted, not emptied:
 * `is-in-ci` counts an empty `CI` as CI.
 */
const NOT_A_PERSONS = ['CI', 'CONTINUOUS_INTEGRATION', 'STACKCTL_NESTED'];

/**
 * The environment the specs start the CLI in, whatever runs the suite: `base` as a person's
 * shell would have it (no CI, not a coding agent's command, which must name its profile, and not
 * a command stackctl runs), with `over` on top. A spec about CI or about agents sets those
 * variables itself, through `over`. One helper for every spec that starts the CLI, so none
 * depends on the root `vitest.setup.ts` having run.
 */
export function cliEnv(
  over: Record<string, string | undefined> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, STACKCTL_STARTED_BY_AGENT: '0' };
  for (const name of NOT_A_PERSONS) {
    delete env[name];
  }
  return Object.assign(env, over);
}

/** Makes this process's environment {@link cliEnv}'s, for good: what `vitest.setup.ts` does. */
export function applyCliEnv(): void {
  for (const name of NOT_A_PERSONS) {
    delete process.env[name];
  }
  process.env.STACKCTL_STARTED_BY_AGENT = '0';
}

/**
 * For a spec file whose tests call the SDK in this process (its functions start the CLI with
 * the process's own environment): makes that environment {@link cliEnv}'s before the file's
 * tests, and puts it back after them.
 */
export function withCliEnv(): void {
  const before = new Map<string, string | undefined>();
  beforeAll(() => {
    for (const name of [...NOT_A_PERSONS, 'STACKCTL_STARTED_BY_AGENT']) {
      before.set(name, process.env[name]);
    }
    applyCliEnv();
  });
  afterAll(() => {
    for (const [name, value] of before) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
}
