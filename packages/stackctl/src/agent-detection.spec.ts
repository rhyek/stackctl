import { describe, test, expect } from 'vitest';
import { AGENT_ENV_VARS, AGENT_OVERRIDE_ENV_VAR, detectAgent } from './agent-detection.js';

describe('detectAgent', () => {
  test('is false for a plain human shell', () => {
    expect(detectAgent({ HOME: '/home/dev', SHELL: '/bin/zsh', TERM: 'xterm-256color' })).toBe(
      false,
    );
  });

  test.each([...AGENT_ENV_VARS])('is true when %s is set', (name) => {
    expect(detectAgent({ [name]: '1' })).toBe(true);
  });

  test('matches on presence, not on value', () => {
    // The real values disagree wildly — CLAUDECODE=1 vs CODEX_SANDBOX=seatbelt vs AGENT=goose.
    expect(detectAgent({ CODEX_SANDBOX: 'seatbelt' })).toBe(true);
    expect(detectAgent({ AGENT: 'goose' })).toBe(true);
    expect(detectAgent({ CLAUDECODE: 'anything-at-all' })).toBe(true);
  });

  test('ignores a variable that is set but empty', () => {
    expect(detectAgent({ CLAUDECODE: '' })).toBe(false);
  });

  test('ignores editor variables that a human shell also carries', () => {
    // An installed AI extension is not an agent at the wheel; treating it as one would let
    // an agent auto-quit a person's session.
    expect(detectAgent({ TERM_PROGRAM: 'vscode', COPILOT_DEBUG_NONCE: 'abc123' })).toBe(false);
  });

  test('lets the override force it off, even under a real agent', () => {
    for (const off of ['0', 'false', 'no', 'NO', 'False']) {
      expect(detectAgent({ CLAUDECODE: '1', [AGENT_OVERRIDE_ENV_VAR]: off })).toBe(false);
    }
  });

  test('lets the override force it on in a bare shell', () => {
    expect(detectAgent({ [AGENT_OVERRIDE_ENV_VAR]: '1' })).toBe(true);
    expect(detectAgent({ [AGENT_OVERRIDE_ENV_VAR]: 'yes' })).toBe(true);
  });

  test('falls through to detection when the override is set but empty', () => {
    expect(detectAgent({ [AGENT_OVERRIDE_ENV_VAR]: '', CLAUDECODE: '1' })).toBe(true);
    expect(detectAgent({ [AGENT_OVERRIDE_ENV_VAR]: '' })).toBe(false);
  });
});
