import { describe, expect, test } from 'vitest';
import { agentProfileRefusal } from './agent-profile.js';

const argv = (...args: string[]) => ['node', 'stackctl', ...args];
const agent = { agent: true, forked: false };

describe('agentProfileRefusal', () => {
  test('refuses a coding agent whose profile is the default, or the CI default', () => {
    for (const source of ['default', 'ci'] as const) {
      expect(agentProfileRefusal({ ...agent, source, argv: argv('status') })).toBe(
        'stackctl: a coding agent names the profile on every command, development included: stackctl --profile development status. ' +
          'STACKCTL_PROFILE=<profile> names it too. (Not an agent? Set STACKCTL_STARTED_BY_AGENT=0.)',
      );
    }
  });

  test('takes a profile named by --profile or STACKCTL_PROFILE', () => {
    expect(agentProfileRefusal({ ...agent, source: 'flag', argv: argv('--profile', 'test', 'status') })).toBeUndefined(); // oxfmt-ignore
    expect(agentProfileRefusal({ ...agent, source: 'env', argv: argv('status') })).toBeUndefined();
  });

  test('leaves a person alone', () => {
    expect(agentProfileRefusal({ agent: false, forked: false, source: 'default', argv: argv('status') })).toBeUndefined(); // oxfmt-ignore
  });

  test("leaves alone the session startStack() forks: the suite's code chose its profile", () => {
    expect(agentProfileRefusal({ agent: true, forked: true, source: 'default', argv: argv('start', '--headless') })).toBeUndefined(); // oxfmt-ignore
  });

  test('leaves alone what acts on no profile: init, help and the version', () => {
    for (const args of [['init'], ['help'], ['--help'], ['status', '-h'], ['--version']]) {
      expect(
        agentProfileRefusal({ ...agent, source: 'default', argv: argv(...args) }),
      ).toBeUndefined();
    }
  });

  test('names the command the agent ran in its example, and bare stackctl as start', () => {
    expect(agentProfileRefusal({ ...agent, source: 'default', argv: argv('-s', 'web') })).toContain('stackctl --profile development start'); // oxfmt-ignore
    expect(agentProfileRefusal({ ...agent, source: 'default', argv: argv('service', 'restart', '-s', 'api') })).toContain('stackctl --profile development service'); // oxfmt-ignore
  });
});
