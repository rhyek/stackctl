import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { processStartTime } from '../process-info';
import { runMany } from './many';
import type { ManyTarget } from './resolve';
import type { OneOffSpec } from './run';

let tmp: string;
/**
 * Children a test started that may outlive a failed assertion, by pid and the start time read
 * while each was surely the test's.
 */
const started: { pid: number; startedAt: number }[] = [];

/** Keeps `pid`, a child of this process, to be killed should it outlive the test. */
async function keep(pid: number): Promise<void> {
  const startedAt = await processStartTime(pid);
  if (startedAt !== null) {
    started.push({ pid, startedAt });
  }
}

/** SIGKILLs every child kept, each only while its pid is still that process: the same start time. */
async function killKept(): Promise<void> {
  for (const { pid, startedAt } of started.splice(0)) {
    if (pid > 0 && (await processStartTime(pid)) === startedAt) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-many-')));
});
afterEach(async () => {
  await killKept();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** `node -e <js>` in the temp directory, with this process's environment. */
const node = (js: string): OneOffSpec => ({
  cwd: tmp,
  command: process.execPath,
  args: ['-e', js],
  env: { ...process.env },
});

/** A command that exits with `code` after `ms`. */
const exitAfter = (code: number, ms = 0) => node(`setTimeout(()=>process.exit(${code}),${ms})`);

/** The file the command labelled `label` writes its pid to. */
const pidFile = (label: string) => path.join(tmp, `${label}.pid`);

/** `sleep 30` that first writes its pid to {@link pidFile}: `exec` keeps the shell's pid. */
const sleeper = (label: string): OneOffSpec => ({
  cwd: tmp,
  command: '/bin/sh',
  args: ['-c', `echo $$ > '${pidFile(label)}'; exec sleep 30`],
  env: { ...process.env },
});

/**
 * The pid `label`'s command wrote, kept while `running` is still pending, so while the command is
 * surely still the test's; `null` when the run ends first, the command never having written it.
 */
async function pidWhileRunning(label: string, running: Promise<unknown>): Promise<number | null> {
  const run = { settled: false };
  running.then(
    () => (run.settled = true),
    () => (run.settled = true),
  );
  const file = pidFile(label);
  const deadline = Date.now() + 5_000;
  while (!run.settled && Date.now() < deadline) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').endsWith('\n')) {
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      await keep(pid);
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

/** Whether `pid` names a process: a signal 0 reaches it. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Resolves once `pid` is gone, its reaping included; rejects after 2 s. */
async function gone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (alive(pid)) {
    if (Date.now() > deadline) {
      throw new Error(`${String(pid)} is still running`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const target = (label: string, spec: OneOffSpec | null): ManyTarget => ({
  label,
  where: { service: label },
  spec,
});

/** The options every case starts from: printed nowhere, a short grace. */
const opts = () => ({
  stdio: 'inherit' as const,
  ignoreSiblingError: false,
  logDir: path.join(tmp, 'logs'),
  onLine: () => {},
  graceMs: 200,
});

describe('runMany', () => {
  test("every command runs, results in the targets' order", async () => {
    const run = await runMany(
      [target('a', exitAfter(0, 300)), target('b', exitAfter(0)), target('c', exitAfter(0, 100))],
      opts(),
    );
    expect(run.ok).toBe(true);
    expect(run.interrupted).toBeUndefined();
    expect(run.results.map((r) => [r.service, r.status, r.exitCode])).toEqual([
      ['a', 'ok', 0],
      ['b', 'ok', 0],
      ['c', 'ok', 0],
    ]);
    expect(run.results[0]!.ms).toBeGreaterThanOrEqual(250);
  });

  test('the first failure stops the rest', { timeout: 10_000 }, async () => {
    const at = Date.now();
    const running = runMany([target('a', exitAfter(1, 100)), target('b', sleeper('b'))], opts());
    const sleep = await pidWhileRunning('b', running);
    expect(sleep).not.toBeNull();
    const run = await running;
    expect(run.ok).toBe(false);
    expect(run.results.map((r) => r.status)).toEqual(['failed', 'stopped']);
    expect(run.results[0]).toMatchObject({ exitCode: 1, signal: null });
    expect(run.results[1]).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
    expect(Date.now() - at).toBeLessThan(5_000);
    await gone(sleep!);
  });

  test(
    'two commands that fail by themselves are both failed, whichever settles second',
    { timeout: 20_000 },
    async () => {
      // Each shell exits at once, and a sleep it leaves holds its stdout open: each command
      // settles half a second later, the second after the first's failure has aborted the stop,
      // though that stop reached no shell still running. Neither is stopped.
      const failsLate = (code: number): OneOffSpec => ({
        cwd: tmp,
        command: '/bin/sh',
        args: ['-c', `sleep 0.5 & exit ${String(code)}`],
        env: { ...process.env },
      });
      for (let i = 0; i < 3; i++) {
        const run = await runMany([target('a', failsLate(1)), target('b', failsLate(2))], opts());
        expect(run.results.map((r) => [r.status, r.exitCode])).toEqual([
          ['failed', 1],
          ['failed', 2],
        ]);
      }
    },
  );

  test('ignoreSiblingError: every command runs to its end', { timeout: 10_000 }, async () => {
    const run = await runMany([target('a', exitAfter(1)), target('b', exitAfter(0, 300))], {
      ...opts(),
      ignoreSiblingError: true,
    });
    expect(run.ok).toBe(false);
    expect(run.results.map((r) => r.status)).toEqual(['failed', 'ok']);
  });

  test('a command that finished before the failure stays ok', { timeout: 10_000 }, async () => {
    const run = await runMany([target('a', exitAfter(0)), target('b', exitAfter(1, 300))], opts());
    expect(run.results.map((r) => r.status)).toEqual(['ok', 'failed']);
  });

  test(
    "a program that isn't there is a failed result with its error, and stops the rest",
    { timeout: 10_000 },
    async () => {
      const missing: OneOffSpec = {
        cwd: tmp,
        command: 'stackctl-no-such-program',
        args: [],
        env: { ...process.env },
      };
      const running = runMany([target('a', missing), target('b', sleeper('b'))], opts());
      // `a` may fail before `b` has written its pid: then it is stopped before it gets to.
      const sleep = await pidWhileRunning('b', running);
      const run = await running;
      expect(run.ok).toBe(false);
      expect(run.results.map((r) => r.status)).toEqual(['failed', 'stopped']);
      expect(run.results[0]).toMatchObject({
        exitCode: null,
        signal: null,
        error: "couldn't start stackctl-no-such-program: not found",
      });
      if (sleep !== null) {
        await gone(sleep);
      }
    },
  );

  test(
    'a throw from record stops the others, and the run rejects once they have ended',
    { timeout: 10_000 },
    async () => {
      const at = Date.now();
      const running = runMany([target('a', sleeper('a')), target('b', exitAfter(0))], {
        ...opts(),
        record: (t) => {
          if (t.label === 'b') {
            throw new Error('event log unwritable');
          }
          return { end: () => {} };
        },
      });
      const sleep = await pidWhileRunning('a', running);
      await expect(running).rejects.toThrow('event log unwritable');
      expect(Date.now() - at).toBeLessThan(5_000);
      if (sleep !== null) {
        await gone(sleep);
      }
    },
  );

  test("a skipped target is in the results and doesn't make it fail", async () => {
    const run = await runMany([target('a', null), target('b', exitAfter(0))], opts());
    expect(run.ok).toBe(true);
    expect(run.results).toEqual([
      { service: 'a', status: 'skipped', exitCode: null, signal: null, ms: 0 },
      expect.objectContaining({ service: 'b', status: 'ok', exitCode: 0 }),
    ]);
  });

  test("stdio pipe: each target's output is in its own result, and onLine isn't called", async () => {
    const onLine = vi.fn();
    const run = await runMany(
      [
        target('a', node("console.log('out a');console.error('err a')")),
        target('b', node("console.log('out b')")),
      ],
      { ...opts(), stdio: 'pipe', onLine },
    );
    expect(onLine).not.toHaveBeenCalled();
    expect(run.results.map((r) => [r.stdout, r.stderr])).toEqual([
      ['out a\n', 'err a\n'],
      ['out b\n', ''],
    ]);
  });

  test('lines from two commands arriving interleaved each reach onLine whole', async () => {
    // Each line goes out in two writes a tick apart, so the other command's land in between.
    const printer = (name: string) =>
      node(`let i=0;const next=()=>{if(i===200)return;process.stdout.write('${name} ');setImmediate(()=>{process.stdout.write(String(i++)+'\\n');setImmediate(next)})};next()`); // oxfmt-ignore
    const lines: [string, string][] = [];
    const run = await runMany([target('a', printer('a')), target('b', printer('b'))], {
      ...opts(),
      onLine: (t, _stream, line) => lines.push([t.label, line]),
    });
    expect(run.ok).toBe(true);
    expect(lines).toHaveLength(400);
    // They did interleave: both commands' lines among the first half.
    expect(new Set(lines.slice(0, 200).map(([label]) => label))).toEqual(new Set(['a', 'b']));
    for (const [label, line] of lines) {
      expect(line).toMatch(/^(a|b) \d+$/);
      expect(line.startsWith(`${label} `)).toBe(true);
    }
  });

  test(
    'a throw from onLine stops the others, and the run rejects with it once they have ended',
    { timeout: 10_000 },
    async () => {
      const at = Date.now();
      const running = runMany(
        [target('a', node("setTimeout(()=>console.log('x'),200)")), target('b', sleeper('b'))],
        {
          ...opts(),
          onLine: () => {
            throw new Error('broken printer');
          },
        },
      );
      const sleep = await pidWhileRunning('b', running);
      expect(sleep).not.toBeNull();
      await expect(running).rejects.toThrow('broken printer');
      expect(Date.now() - at).toBeLessThan(5_000);
      await gone(sleep!);
    },
  );

  test('record is called once per command that started, and its end gets the exit', async () => {
    const calls: string[] = [];
    const ends: unknown[] = [];
    const run = await runMany(
      [target('a', exitAfter(0)), target('b', exitAfter(3)), target('c', null)],
      {
        ...opts(),
        ignoreSiblingError: true,
        record: (t) => {
          calls.push(t.label);
          return { end: (result) => ends.push([t.label, result]) };
        },
      },
    );
    expect(run.results.map((r) => r.status)).toEqual(['ok', 'failed', 'skipped']);
    expect(calls).toEqual(['a', 'b']);
    expect(ends).toHaveLength(2);
    expect(ends).toEqual(
      expect.arrayContaining([
        ['a', { ok: true, exitCode: 0, signal: null }],
        ['b', { ok: false, exitCode: 3, signal: null }],
      ]),
    );
  });

  test.each([false, true])(
    'a signal sent to this process stops every command, and none is failed (ignoreSiblingError: %s)',
    { timeout: 10_000 },
    async (ignoreSiblingError) => {
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
      const before = signals.map((s) => process.listenerCount(s));
      const running = runMany([target('a', sleeper('a')), target('b', sleeper('b'))], {
        ...opts(),
        ignoreSiblingError,
      });
      const sleeps = [await pidWhileRunning('a', running), await pidWhileRunning('b', running)];
      // Sent whatever came of the pids, so the run ends either way.
      process.emit('SIGTERM');
      const run = await running;
      expect(sleeps).not.toContain(null);
      expect(run.interrupted).toBe('SIGTERM');
      expect(run.ok).toBe(false);
      expect(run.results.map((r) => r.status)).toEqual(['stopped', 'stopped']);
      expect(signals.map((s) => process.listenerCount(s))).toEqual(before);
      for (const pid of sleeps) {
        await gone(pid!);
      }
    },
  );
});
