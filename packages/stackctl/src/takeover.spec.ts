import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionStatus } from './control-client.js';
import { preflightTakeover, resolveTakeover, type PreflightDeps } from './takeover.js';

const CONFIG = '/ws/stackctl.config.ts';

// Pinned, so a run from inside a stackctl session of another profile can't change the answers.
beforeEach(() => vi.stubEnv('STACKCTL_PROFILE', 'development'));
afterEach(() => vi.unstubAllEnvs());

function status(over: Partial<SessionStatus> = {}): SessionStatus {
  return {
    pid: 4242,
    sessionId: null,
    configPath: CONFIG,
    profile: 'development',
    profileSource: 'default',
    startedByAgent: false,
    logFile: null,
    services: null,
    ready: null,
    infra: null,
    sessionReady: false,
    config: null,
    reverseProxy: null,
    ...over,
  };
}

describe('resolveTakeover', () => {
  test('kills whenever --kill-others is passed, whoever is involved', () => {
    for (const runningStartedByAgent of [true, false]) {
      for (const selfStartedByAgent of [true, false]) {
        for (const isInteractive of [true, false]) {
          expect(
            resolveTakeover({
              killOthers: true,
              runningStartedByAgent,
              selfStartedByAgent,
              isInteractive,
            }),
          ).toBe('kill');
        }
      }
    }
  });

  test('kills silently when an agent replaces a session an agent started', () => {
    expect(
      resolveTakeover({
        killOthers: false,
        runningStartedByAgent: true,
        selfStartedByAgent: true,
        isInteractive: false,
      }),
    ).toBe('kill');
  });

  test('will not let an agent take over a session a person started', () => {
    expect(
      resolveTakeover({
        killOthers: false,
        runningStartedByAgent: false,
        selfStartedByAgent: true,
        isInteractive: false,
      }),
    ).toBe('error');
  });

  test('will not let a person silently take over an agent session without a terminal', () => {
    expect(
      resolveTakeover({
        killOthers: false,
        runningStartedByAgent: true,
        selfStartedByAgent: false,
        isInteractive: false,
      }),
    ).toBe('error');
  });

  test('asks when there is a terminal to ask in', () => {
    for (const runningStartedByAgent of [true, false]) {
      expect(
        resolveTakeover({
          killOthers: false,
          runningStartedByAgent,
          selfStartedByAgent: false,
          isInteractive: true,
        }),
      ).toBe('prompt');
    }
  });
});

describe('preflightTakeover', () => {
  /**
   * Never the real kill, nor the real check of whether a silent pid is the recorded session
   * (`'unknown'`): a test that expects either stubs it.
   */
  function deps(over: Partial<PreflightDeps> = {}): Partial<PreflightDeps> {
    return {
      stopUnresponsive: async () => {
        throw new Error('must not kill');
      },
      isRecordedSession: async () => 'unknown',
      queryRunning: async () => status(),
      askToQuit: async () => true,
      isInteractive: () => true,
      selfStartedByAgent: () => false,
      ...over,
    };
  }

  describe('a session recorded alive that does not answer as itself', () => {
    const hung = { kind: 'unresponsive', pid: 4242, port: 14082, reason: 'hung' } as const;

    test('refuses, saying it looks hung and what --kill-others would do', async () => {
      const result = await preflightTakeover({
        configPath: CONFIG,
        killOthers: false,
        deps: deps({
          queryRunning: async () => hung,
          stopUnresponsive: async () => {
            throw new Error('must not kill');
          },
        }),
      });
      expect(result).toEqual({
        ok: false,
        message: expect.stringMatching(/pid 4242.*looks hung.*--kill-others/s),
      });
    });

    test('kills it, and proceeds, with --kill-others, once it is confirmed as the session', async () => {
      const killed: number[] = [];
      const checked: unknown[] = [];
      const result = await preflightTakeover({
        configPath: CONFIG,
        killOthers: true,
        cwd: '/ws',
        deps: deps({
          queryRunning: async () => hung,
          isRecordedSession: async (...args) => {
            checked.push(args);
            return 'yes';
          },
          stopUnresponsive: async (session) => {
            killed.push(session.pid);
          },
        }),
      });
      expect(result).toEqual({ ok: true });
      expect(checked).toEqual([['/ws', 'development', 4242]]);
      expect(killed).toEqual([4242]);
    });

    test.each(['no', 'unknown'] as const)(
      "refuses to kill it with --kill-others when the check says '%s', naming its record",
      async (answer) => {
        const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-takeover-')));
        try {
          const result = await preflightTakeover({
            configPath: CONFIG,
            killOthers: true,
            cwd: ws,
            deps: deps({
              queryRunning: async () => hung,
              isRecordedSession: async () => answer,
              stopUnresponsive: async () => {
                throw new Error('must not kill');
              },
            }),
          });
          const record = path.join(ws, 'node_modules', '.stackctl', 'profiles', 'development', 'running.json'); // oxfmt-ignore
          expect(result).toEqual({
            ok: false,
            message:
              "a development session is recorded as running (pid 4242), but stackctl can't confirm " +
              "that process is that session, so it won't kill it. If no development session of " +
              `this workspace is running, delete ${record} and start again.`,
          });
        } finally {
          fs.rmSync(ws, { recursive: true, force: true });
        }
      },
    );

    test('never kills one whose port another session answers on, even with --kill-others', async () => {
      const result = await preflightTakeover({
        configPath: CONFIG,
        killOthers: true,
        deps: deps({
          queryRunning: async () => ({ ...hung, reason: 'mismatch' }) as const,
          isRecordedSession: async () => 'yes',
          stopUnresponsive: async () => {
            throw new Error('must not kill');
          },
        }),
      });
      expect(result).toEqual({
        ok: false,
        message: expect.stringMatching(/pid 4242.*can't confirm that process is that session/),
      });
    });
  });

  test('proceeds when no instance answers', async () => {
    const result = await preflightTakeover({
      configPath: CONFIG,
      killOthers: false,
      deps: deps({
        queryRunning: async () => null,
        isInteractive: () => false,
        askToQuit: async () => {
          throw new Error('must not prompt');
        },
      }),
    });
    expect(result).toEqual({ ok: true });
  });

  test('proceeds without asking when the running instance is a different project', async () => {
    const result = await preflightTakeover({
      configPath: CONFIG,
      killOthers: false,
      deps: deps({
        queryRunning: async () => status({ configPath: '/other/stackctl.config.ts' }),
        isInteractive: () => false,
        askToQuit: async () => {
          throw new Error('must not prompt');
        },
      }),
    });
    expect(result).toEqual({ ok: true });
  });

  test('proceeds when the prompt is accepted', async () => {
    expect(
      await preflightTakeover({
        configPath: CONFIG,
        killOthers: false,
        deps: deps({ askToQuit: async () => true }),
      }),
    ).toEqual({ ok: true });
  });

  test('stops when the prompt is declined', async () => {
    const result = await preflightTakeover({
      configPath: CONFIG,
      killOthers: false,
      deps: deps({ askToQuit: async () => false }),
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/left the running/i);
  });

  test('names --kill-others and warns agents off it when there is no terminal', async () => {
    const result = await preflightTakeover({
      configPath: CONFIG,
      killOthers: false,
      deps: deps({ isInteractive: () => false, selfStartedByAgent: () => true }),
    });
    expect(result.ok).toBe(false);
    const message = !result.ok ? result.message : '';
    expect(message).toContain('--kill-others');
    expect(message).toContain('4242');
    expect(message).toMatch(/ask the user/i);
    expect(message).toMatch(/not started by a coding agent/i);
  });

  test('lets an agent take over another agent session with no terminal and no flag', async () => {
    expect(
      await preflightTakeover({
        configPath: CONFIG,
        killOthers: false,
        deps: deps({
          queryRunning: async () => status({ startedByAgent: true }),
          isInteractive: () => false,
          selfStartedByAgent: () => true,
          askToQuit: async () => {
            throw new Error('must not prompt');
          },
        }),
      }),
    ).toEqual({ ok: true });
  });

  test('treats a pre-0.7.0 instance (no startedByAgent) as human-started', async () => {
    const result = await preflightTakeover({
      configPath: CONFIG,
      killOthers: false,
      deps: deps({
        queryRunning: async () => status({ startedByAgent: false }),
        isInteractive: () => false,
        selfStartedByAgent: () => true,
      }),
    });
    expect(result.ok).toBe(false);
  });

  test("starts alongside this project's session in another profile, asking and quitting nothing", async () => {
    // The hardest case to be let through: a person's session, and no terminal to ask.
    const result = await preflightTakeover({
      configPath: CONFIG,
      profile: 'test',
      killOthers: false,
      deps: deps({
        queryRunning: async () => status({ profile: 'development', startedByAgent: false }),
        isInteractive: () => false,
        selfStartedByAgent: () => true,
        askToQuit: async () => {
          throw new Error('must not prompt');
        },
      }),
    });
    expect(result).toEqual({ ok: true });
  });

  test('names the profile of the session it would quit', async () => {
    const result = await preflightTakeover({
      configPath: CONFIG,
      profile: 'test',
      killOthers: false,
      deps: deps({
        queryRunning: async () => status({ profile: 'test' }),
        isInteractive: () => false,
      }),
    });
    expect(!result.ok && result.message).toMatch(/Another test stackctl session is already running/); // oxfmt-ignore
  });

  test('skips the question entirely with --kill-others', async () => {
    expect(
      await preflightTakeover({
        configPath: CONFIG,
        killOthers: true,
        deps: deps({
          isInteractive: () => false,
          askToQuit: async () => {
            throw new Error('must not prompt');
          },
        }),
      }),
    ).toEqual({ ok: true });
  });

  test('probes the configured apiPort when one is pinned', async () => {
    const seen: Array<number | undefined> = [];
    await preflightTakeover({
      configPath: CONFIG,
      killOthers: true,
      apiPortOverride: 14099,
      deps: deps({
        queryRunning: async (_cwd, port) => {
          seen.push(port);
          return null;
        },
      }),
    });
    expect(seen).toEqual([14099]);
  });
});
