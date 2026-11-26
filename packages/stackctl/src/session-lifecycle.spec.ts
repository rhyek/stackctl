import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type Config, defineConfig } from './config';
import { type SessionStartContext, runSessionHook } from './session-lifecycle';
import type { Exec, ExecOptions } from './spawn';

let ws: string;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-session-lifecycle-'));
});
const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) {
    release();
  }
  fs.rmSync(ws, { recursive: true, force: true });
});

/**
 * Makes `file` a FIFO, so a read of it doesn't return; the test's end lets a reader still
 * blocked on it go.
 */
function holdReads(file: string): void {
  const made = spawnSync('mkfifo', [file]);
  if (made.status !== 0) {
    throw new Error(`mkfifo ${file} failed: ${String(made.stderr)}`);
  }
  releases.push(() => {
    try {
      // Opens only when a reader waits; what is written ends its read.
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      fs.writeSync(fd, 'HELD=1\n');
      fs.closeSync(fd);
    } catch {
      /* no reader */
    }
  });
}

/** Collects what the hook prints, tagged `err:` for stderr. */
function printer() {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string, isError: boolean) => lines.push(isError ? `err:${line}` : line),
  };
}

describe("runSessionHook('beforeStart')", () => {
  test("is 'none' at once when the config has no hook: no `.env` file is read for it", async () => {
    defineConfig({ workspaceDir: ws, serviceRootDir: 'packages', services: { web: {} } });
    // A read of the workspace's `.env` would never return.
    holdReads(path.join(ws, '.env'));
    expect(await runSessionHook('beforeStart', 'ui', { write: () => {}, data: {} })).toBe('none');
  });

  test("hands the hook the session's mode, profile, workspace, environment and tokens", async () => {
    fs.writeFileSync(path.join(ws, '.env.development'), 'FROM_FILE=yes\n');
    let seen: SessionStartContext<{ domain: string }> | undefined;
    const config: Config<string> = defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      tokens: { domain: 'example.test' },
      services: { web: {} },
      session: { lifecycle: { beforeStart: (ctx) => void (seen = ctx) } },
    });
    await runSessionHook('beforeStart', 'detached', { write: () => {}, data: {} });
    expect(seen).toMatchObject({
      mode: 'detached',
      profile: 'development',
      workspaceDir: ws,
      tokens: { domain: 'example.test' },
      data: {},
    });
    expect(seen?.config).toBe(config);
    expect(seen?.envs.FROM_FILE).toBe('yes');
    expect(seen?.envs.STACKCTL_PROFILE).toBe('development');
  });

  test('prints what it logs and what its commands print, in the workspace', async () => {
    fs.mkdirSync(path.join(ws, 'tools'));
    const ran: string[] = [];
    const exec: Exec = async (command, args, opts) => {
      ran.push(`${command} ${args.join(' ')} @${path.relative(ws, opts.cwd ?? '')}`);
      opts.onLine?.('removed apps/legacy', false);
      opts.onLine?.('nothing else', true);
      return { exitCode: 0, stdout: 'removed apps/legacy\n', stderr: 'nothing else\n' };
    };
    defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      services: { web: {} },
      session: {
        lifecycle: {
          beforeStart: async ({ log, exec: run }) => {
            log('checking the checkout');
            await run('node', ['clean.ts'], { cwd: 'tools' });
          },
        },
      },
    });
    const { lines, write } = printer();
    await runSessionHook('beforeStart', 'headless', { exec, write, data: {} });
    expect(lines).toEqual(['checking the checkout', 'removed apps/legacy', 'err:nothing else']);
    expect(ran).toEqual(['node clean.ts @tools']);
  });

  test('resolves with what the hook threw', async () => {
    defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      services: { web: {} },
      session: {
        lifecycle: {
          beforeStart: () => {
            throw new Error('apps/legacy is not empty');
          },
        },
      },
    });
    await expect(
      runSessionHook('beforeStart', 'ui', { write: () => {}, data: {} }),
    ).resolves.toEqual({
      error: 'apps/legacy is not empty',
    });
  });

  test('hands the hook the `data` it is given', async () => {
    defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      services: { web: {} },
      session: { lifecycle: { beforeStart: ({ data }) => void (data.cleaned = true) } },
    });
    const data = {};
    await runSessionHook('beforeStart', 'ui', { write: () => {}, data });
    expect(data).toEqual({ cleaned: true });
  });
});

describe("runSessionHook('beforeStop' | 'afterStop')", () => {
  test("hands each the session's context and the shutdown's `data`", async () => {
    const seen: [string, Record<string, unknown>][] = [];
    defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      services: { web: {} },
      session: {
        lifecycle: {
          beforeStop: (ctx) => {
            ctx.data.webhook = 'w1';
            seen.push([ctx.mode, ctx.data]);
          },
          afterStop: (ctx) => void seen.push([ctx.mode, ctx.data]),
        },
      },
    });
    const data = {};
    expect(await runSessionHook('beforeStop', 'ui', { write: () => {}, data })).toBe('done');
    expect(await runSessionHook('afterStop', 'ui', { write: () => {}, data })).toBe('done');
    expect(seen).toEqual([
      ['ui', { webhook: 'w1' }],
      ['ui', { webhook: 'w1' }],
    ]);
    expect(seen[1]![1]).toBe(data);
  });

  test("the signal its commands are asked to end by aborts with its budget; the one that kills them, with the session's", async () => {
    const seen: ExecOptions[] = [];
    const exec: Exec = async (_command, _args, opts) => {
      seen.push(opts);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      services: { web: {} },
      session: { lifecycle: { beforeStop: (ctx) => ctx.exec('deregister').then(() => {}) } },
    });
    const budget = new AbortController();
    const hardKill = new AbortController();
    await runSessionHook('beforeStop', 'headless', { write: () => {}, data: {}, exec, budget: budget.signal, signal: hardKill.signal }); // oxfmt-ignore
    await runSessionHook('beforeStop', 'headless', { write: () => {}, data: {}, exec, signal: hardKill.signal }); // oxfmt-ignore
    const [budgeted, unbudgeted] = seen as [ExecOptions, ExecOptions];
    expect(unbudgeted.abandon).toBeUndefined();
    budget.abort();
    expect(budgeted.abandon!.aborted).toBe(true);
    expect(budgeted.signal!.aborted).toBe(false);
    hardKill.abort();
    expect([budgeted.signal!.aborted, unbudgeted.signal!.aborted]).toEqual([true, true]);
  });

  test('a hook whose time is up while its context is still reading the `.env` files is abandoned, and never called', async () => {
    let called = false;
    defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      services: { web: {} },
      session: { lifecycle: { beforeStop: () => void (called = true) } },
    });
    // The read of the workspace's `.env` doesn't return until the test is over.
    holdReads(path.join(ws, '.env'));
    const budget = new AbortController();
    const outcome = runSessionHook('beforeStop', 'ui', { write: () => {}, data: {}, budget: budget.signal }); // oxfmt-ignore
    let settled = false;
    void outcome.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    budget.abort();
    expect(await outcome).toBe('abandoned');
    expect(called).toBe(false);
  });

  test('a budget spent before it began calls nothing, and is abandoned', async () => {
    let called = false;
    defineConfig({
      workspaceDir: ws,
      serviceRootDir: 'packages',
      services: { web: {} },
      session: { lifecycle: { afterStop: () => void (called = true) } },
    });
    const outcome = await runSessionHook('afterStop', 'ui', { write: () => {}, data: {}, budget: AbortSignal.abort() }); // oxfmt-ignore
    expect(outcome).toBe('abandoned');
    expect(called).toBe(false);
  });
});
