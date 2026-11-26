import { getEventListeners } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import type { Config } from '../config';
import type { ExecOptions } from '../spawn';
import { ABORTED, lifecycleContext, raceAbort, runHook, type HookScope } from './hooks';

function scopeOf(over: Partial<HookScope> = {}): HookScope {
  return {
    config: {} as Config<string>,
    profile: 'development' as HookScope['profile'],
    workspaceDir: '/ws',
    tokens: {},
    envs: {},
    dir: '/ws',
    write: () => {},
    data: {},
    ...over,
  };
}

test('lifecycleContext: log writes one line per line of the message', () => {
  const write = vi.fn();
  lifecycleContext(scopeOf({ write })).log('a\nb');
  expect(write.mock.calls).toEqual([
    ['a', false],
    ['b', false],
  ]);
});

test("lifecycleContext: exec runs in dir, a relative cwd against it, with envs and the call's env on top", async () => {
  const seen: ExecOptions[] = [];
  const run = async (_c: string, _a: string[], opts: ExecOptions) => {
    seen.push(opts);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const ctx = lifecycleContext(scopeOf({ dir: '/ws', envs: { A: '1', B: '1' }, run }));
  await ctx.exec('x', [], { cwd: 'sub', env: { A: '2' } });
  expect(seen[0]!.cwd).toBe('/ws/sub');
  expect(seen[0]!.env).toEqual({ A: '2', B: '1' });
});

test('lifecycleContext: exec hands its runner the signal that kills a command and the one that asks it to end', async () => {
  const seen: ExecOptions[] = [];
  const run = async (_c: string, _a: string[], opts: ExecOptions) => {
    seen.push(opts);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const signal = new AbortController().signal;
  const abandon = new AbortController().signal;
  await lifecycleContext(scopeOf({ run, signal, abandon })).exec('x');
  expect(seen[0]!.signal).toBe(signal);
  expect(seen[0]!.abandon).toBe(abandon);
});

test('lifecycleContext: each command exec starts is handed to onCommand, settled at its end even when it fails', async () => {
  let end!: () => void;
  const run = () =>
    new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      end = () => resolve({ exitCode: 3, stdout: '', stderr: '' });
    });
  const commands: Promise<void>[] = [];
  const ctx = lifecycleContext(scopeOf({ run, onCommand: (ended) => commands.push(ended) }));
  const failing = ctx.exec('x').catch((err: unknown) => (err as Error).message);
  expect(commands).toHaveLength(1);
  let settled = false;
  void commands[0]!.then(() => (settled = true));
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  end();
  expect(await failing).toBe('`x` exited with code 3');
  await commands[0];
  expect(settled).toBe(true);
});

test("lifecycleContext: data is the scope's object", () => {
  const scope = scopeOf();
  expect(lifecycleContext(scope).data).toBe(scope.data);
});

test("runHook: 'none' without a hook, 'done' when it resolves, the message when it throws", async () => {
  expect(await runHook(undefined, {})).toBe('none');
  expect(await runHook(async () => {}, {})).toBe('done');
  expect(
    await runHook(() => {
      throw new Error('boom');
    }, {}),
  ).toEqual({ error: 'boom' });
});

test("runHook: 'abandoned' once the budget aborts, and a late rejection is swallowed", async () => {
  const unhandled = vi.fn();
  process.once('unhandledRejection', unhandled);
  const budget = new AbortController();
  let reject!: (err: Error) => void;
  const outcome = runHook(() => new Promise<void>((_, r) => (reject = r)), {}, { budget: budget.signal }); // oxfmt-ignore
  budget.abort();
  expect(await outcome).toBe('abandoned');
  reject(new Error('late'));
  await new Promise((resolve) => setImmediate(resolve));
  process.off('unhandledRejection', unhandled);
  expect(unhandled).not.toHaveBeenCalled();
});

test("runHook: a budget spent already calls nothing, and is 'abandoned'", async () => {
  const hook = vi.fn();
  expect(await runHook(hook, {}, { budget: AbortSignal.abort() })).toBe('abandoned');
  expect(hook).not.toHaveBeenCalled();
});

describe('raceAbort', () => {
  test("is the promise's value when it settles first", async () => {
    expect(await raceAbort(Promise.resolve('value'), new AbortController().signal)).toBe('value');
  });

  test('is ABORTED once the signal aborts first, and a later rejection is consumed', async () => {
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);
    const controller = new AbortController();
    let reject!: (err: Error) => void;
    const late = new Promise<never>((_, r) => (reject = r));
    const raced = raceAbort(late, controller.signal);
    controller.abort();
    expect(await raced).toBe(ABORTED);
    reject(new Error('late'));
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  test('is ABORTED at once for a signal aborted already, even with the value ready', async () => {
    expect(await raceAbort(Promise.resolve('value'), AbortSignal.abort())).toBe(ABORTED);
  });

  test('a rejection is consumed when the signal had aborted already', async () => {
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);
    expect(await raceAbort(Promise.reject(new Error('late')), AbortSignal.abort())).toBe(ABORTED);
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  test('leaves no listener on the signal once the promise wins: a long-lived signal collects none', async () => {
    const { signal } = new AbortController();
    await raceAbort(Promise.resolve(1), signal);
    await raceAbort(Promise.reject(new Error('boom')), signal).catch(() => {});
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  test("rejects with the promise's error when it rejects first", async () => {
    const raced = raceAbort(Promise.reject(new Error('boom')), new AbortController().signal);
    await expect(raced).rejects.toThrow('boom');
  });
});
