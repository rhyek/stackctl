import { describe, expect, test, vi } from 'vitest';
import type { Session } from '../session/session.js';
import { type ActionDeps, guard, logError, runEffects } from './actions.js';

/** A session double: what the effects call, recorded in order. */
function fakeSession(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const errors: string[] = [];
  const session = {
    systemLog: { error: (message: string) => errors.push(message) },
    getSnapshot: () => ({ phase: 'running' }),
    shutdown: vi.fn((reason: string) => {
      calls.push(`shutdown ${reason}`);
      return Promise.resolve();
    }),
    requestQuit: vi.fn((by: { key: string }, reason: string) => {
      calls.push(`shutdown ${reason} by ${by.key}`);
      return Promise.resolve();
    }),
    runPackage: vi.fn((name: string, action: string, by: { key: string }) => {
      calls.push(`${action} ${name} by ${by.key}`);
      return Promise.resolve('busy');
    }),
    runInfra: vi.fn((name: string, action: string, by: { key: string }) => {
      calls.push(`infra ${action} ${name} by ${by.key}`);
      return 'busy';
    }),
    clearLog: vi.fn(() => calls.push('clear')),
    ...over,
  };
  return { session: session as unknown as Session, calls, errors };
}

function deps(session: Session, calls: string[]): ActionDeps {
  return {
    session,
    toasts: { notify: () => 1, dismiss: () => {}, dismissNewestSticky: () => false },
    selection: { clear: () => false, flashCopy: () => {} },
    viewport: { scrollPages: () => {}, scrollToTop: () => {}, scrollToBottom: () => {} },
    confirmToasts: { quit: null, reset: null },
    releaseMouse: () => calls.push('release mouse'),
    hardExit: (code) => calls.push(`hard exit ${String(code)}`),
  };
}

/** Lets the microtasks a rejection's handler runs on settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('guard', () => {
  test('a throw is logged as a stackctl error line and goes no further', () => {
    const { session, errors } = fakeSession();
    expect(() =>
      guard(session, 'restart api', () => {
        throw new Error('boom');
      }),
    ).not.toThrow();
    expect(errors).toEqual(['restart api failed: boom']);
  });

  test('a rejection is logged, not left unhandled', async () => {
    const { session, errors } = fakeSession();
    guard(session, 'run build for web', () => Promise.reject(new Error('spawn failed')));
    await settle();
    expect(errors).toEqual(['run build for web failed: spawn failed']);
  });

  test('logging into a closed log throws nothing', () => {
    const { session } = fakeSession({
      systemLog: {
        error: () => {
          throw new Error('closed');
        },
      },
    });
    expect(() => logError(session, 'clear the log', new Error('x'))).not.toThrow();
  });
});

describe('runEffects', () => {
  test('a failing effect is logged and the next one still runs', async () => {
    const { session, calls, errors } = fakeSession({
      runPackage: () => Promise.reject(new Error('gone')),
      clearLog: () => {
        throw new Error('full disk');
      },
    });
    runEffects(
      [
        { type: 'restart', entry: { kind: 'app', name: 'api' } },
        { type: 'clear-log' },
        { type: 'stop', entry: { kind: 'infra', name: 'db' } },
      ],
      deps(session, calls),
    );
    await settle();
    expect(calls).toEqual(['infra stop db by s']);
    expect(errors).toEqual(['clear the log failed: full disk', 'restart api failed: gone']);
  });

  test('a busy answer is not an error: nothing is logged', async () => {
    const { session, calls, errors } = fakeSession();
    runEffects(
      [
        { type: 'stop', entry: { kind: 'app', name: 'api' } },
        { type: 'restart', entry: { kind: 'infra', name: 'db' } },
      ],
      deps(session, calls),
    );
    await settle();
    expect(calls).toEqual(['stop api by s', 'infra restart db by r']);
    expect(errors).toEqual([]);
  });

  test("tells the session which key asked, for the event log's `by`", () => {
    const { session, calls } = fakeSession();
    runEffects(
      [
        { type: 'restart', entry: { kind: 'app', name: 'api' } },
        { type: 'stop', entry: { kind: 'infra', name: 'db' } },
        { type: 'reset-infra', target: 'db' },
      ],
      deps(session, calls),
    );
    expect(calls).toEqual(['restart api by r', 'infra stop db by s', 'infra reset db by R']);
  });

  test('the shutdown releases the mouse first; the second request is the hard kill', () => {
    const first = fakeSession();
    runEffects([{ type: 'shutdown' }], deps(first.session, first.calls));
    expect(first.calls).toEqual(['release mouse', 'shutdown user by ^c']);

    const second = fakeSession({ getSnapshot: () => ({ phase: 'stopping' }) });
    runEffects([{ type: 'shutdown' }], deps(second.session, second.calls));
    expect(second.calls).toEqual(['shutdown user', 'hard exit 1']);
  });
});
