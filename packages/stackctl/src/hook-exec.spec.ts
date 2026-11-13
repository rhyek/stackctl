import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { hookExec } from './hook-exec.js';
import { type Exec, type ExecOptions, execLines } from './spawn.js';

/** A `hookExec` over a stand-in runner that records each call and answers with `exitCode`. */
function recorded(exitCode = 0) {
  const calls: { command: string; args: string[]; opts: ExecOptions }[] = [];
  const lines: [string, boolean][] = [];
  const run: Exec = async (command, args, opts) => {
    calls.push({ command, args, opts });
    opts.onLine?.('out', false);
    return { exitCode, stdout: 'out\n', stderr: '' };
  };
  const exec = hookExec({
    dir: '/ws',
    env: { BASE: 'base', SHARED: 'base' },
    onLine: (line, isError) => lines.push([line, isError]),
    run,
  });
  return { exec, calls, lines };
}

describe('hookExec', () => {
  test('runs in the base directory with the base environment, its output to onLine', async () => {
    const { exec, calls, lines } = recorded();
    expect(await exec('pnpm', ['migrate'])).toEqual({ exitCode: 0, stdout: 'out\n', stderr: '' });
    expect(calls).toEqual([
      {
        command: 'pnpm',
        args: ['migrate'],
        opts: { cwd: '/ws', env: { BASE: 'base', SHARED: 'base' }, onLine: expect.any(Function) },
      },
    ]);
    expect(lines).toEqual([['out', false]]);
  });

  test('a relative cwd resolves against the base directory, an absolute one stands', async () => {
    const { exec, calls } = recorded();
    await exec('seed', [], { cwd: 'packages/db' });
    await exec('seed', [], { cwd: '/elsewhere' });
    expect(calls.map((c) => c.opts.cwd)).toEqual([path.resolve('/ws/packages/db'), '/elsewhere']);
  });

  test("a call's env is merged over the base environment", async () => {
    const { exec, calls } = recorded();
    await exec('seed', [], { env: { SHARED: 'call', ONLY: 'call' } });
    expect(calls[0]!.opts.env).toEqual({ BASE: 'base', SHARED: 'call', ONLY: 'call' });
  });

  test('args default to none', async () => {
    const { exec, calls } = recorded();
    await exec('seed');
    expect(calls[0]!.args).toEqual([]);
  });

  test('a non-zero exit rejects with the command line and the code', async () => {
    const { exec } = recorded(4);
    await expect(exec('pnpm', ['migrate', 'deploy'])).rejects.toThrow(
      '`pnpm migrate deploy` exited with code 4',
    );
  });

  test('reject: false resolves with the failing result instead', async () => {
    const { exec } = recorded(4);
    expect((await exec('probe', [], { reject: false })).exitCode).toBe(4);
  });

  test('a label names the command in the rejection', async () => {
    const { exec } = recorded(2);
    await expect(exec('docker', ['compose', '-f', 'x', 'up'], {}, 'docker compose up')).rejects.toThrow(
      '`docker compose up` exited with code 2',
    ); // oxfmt-ignore
  });

  test('over the real runner, a command that cannot start says why in its output, and rejects', async () => {
    const lines: [string, boolean][] = [];
    const exec = hookExec({
      dir: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      onLine: (line, isError) => lines.push([line, isError]),
      run: execLines,
    });
    await expect(exec('stackctl-no-such-binary')).rejects.toThrow('exited with code 127');
    expect(lines).toEqual([["couldn't run stackctl-no-such-binary: not found", true]]);
  });
});
