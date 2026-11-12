import { describe, expect, test } from 'vitest';
import { agentModeRefusal } from './agent-mode.js';

const argv = (...args: string[]) => ['node', 'stackctl', ...args];
const agent = { agent: true, forked: false };

describe('agentModeRefusal', () => {
  test('refuses a coding agent whose mode is the default, or the CI default', () => {
    for (const source of ['default', 'ci'] as const) {
      expect(agentModeRefusal({ ...agent, source, argv: argv('status') })).toBe(
        'stackctl: a coding agent names the mode on every command, development included: stackctl --mode development status. ' +
          'STACKCTL_MODE=<mode> names it too. (Not an agent? Set STACKCTL_STARTED_BY_AGENT=0.)',
      );
    }
  });

  test('takes a mode named by --mode or STACKCTL_MODE', () => {
    expect(agentModeRefusal({ ...agent, source: 'flag', argv: argv('--mode', 'test', 'status') })).toBeUndefined(); // oxfmt-ignore
    expect(agentModeRefusal({ ...agent, source: 'env', argv: argv('status') })).toBeUndefined();
  });

  test('leaves a person alone', () => {
    expect(agentModeRefusal({ agent: false, forked: false, source: 'default', argv: argv('status') })).toBeUndefined(); // oxfmt-ignore
  });

  test("leaves alone the session startStack() forks: the suite's code chose its mode", () => {
    expect(agentModeRefusal({ agent: true, forked: true, source: 'default', argv: argv('start', '--headless') })).toBeUndefined(); // oxfmt-ignore
  });

  test('leaves alone what acts on no mode: init, help and the version', () => {
    for (const args of [['init'], ['help'], ['--help'], ['status', '-h'], ['--version']]) {
      expect(
        agentModeRefusal({ ...agent, source: 'default', argv: argv(...args) }),
      ).toBeUndefined();
    }
  });

  test('names the command the agent ran in its example, and bare stackctl as start', () => {
    expect(agentModeRefusal({ ...agent, source: 'default', argv: argv('-s', 'web') })).toContain('stackctl --mode development start'); // oxfmt-ignore
    expect(agentModeRefusal({ ...agent, source: 'default', argv: argv('service', 'restart', '-s', 'api') })).toContain('stackctl --mode development service'); // oxfmt-ignore
  });
});
