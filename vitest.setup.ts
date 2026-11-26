import { applyCliEnv } from './packages/stackctl/src/cli-spec/env.ts';

// The specs, and every CLI they start, run as a person's commands outside CI, whatever runs the
// suite: not a CI run (which defaults stackctl's profile to `test`, and stops Ink being
// interactive), not a coding agent's (whose commands must name the profile, which the specs leave
// to the default), not a command stackctl runs (when the suite runs through `sctl run` or a
// session: an `exec` or `run` there logs nothing and records no event, which the specs check
// for). A spec about CI or about agents sets the variable itself. The specs that start the CLI
// build the same environment themselves (`cliEnv`), so a run that skips this file passes too.
applyCliEnv();
