import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import {
  execLines,
  runCommand,
  type Spawned,
  spawnCommand,
  startFailure,
  streamLines,
} from './spawn.js';

const nodePath = process.execPath;

/** `node -e <js>` with this process's environment. */
const node = (js: string, stdio: 'pipe' | 'ignore' = 'ignore') =>
  spawnCommand(process.execPath, ['-e', js], { env: process.env, stdio: ['ignore', stdio, stdio] });

describe('spawnCommand', () => {
  test('resolves with the exit code', async () => {
    expect(await node('process.exit(3)').done).toEqual({ exitCode: 3, signal: null });
  });

  test('resolves with the signal that ended it', async () => {
    expect(await node("process.kill(process.pid, 'SIGTERM')").done).toEqual({
      exitCode: null,
      signal: 'SIGTERM',
    });
  });

  test('resolves once the pipes are drained: every chunk is read first', async () => {
    const child = node("process.stdout.write('x'.repeat(1_000_000))", 'pipe');
    let read = 0;
    child.stdout!.on('data', (chunk: Buffer) => {
      read += chunk.length;
    });
    await child.done;
    expect(read).toBe(1_000_000);
  });

  test("resolves with the error of a command that can't start, and never rejects", async () => {
    const ended = await spawnCommand('stackctl-no-such-command', [], { env: process.env }).done;
    expect(ended.error?.code).toBe('ENOENT');
    expect(startFailure(ended.error!)).toBe('not found');
  });

  test('finds the program on the PATH of the environment it is given', async () => {
    const env = { PATH: '/nonexistent' };
    const ended = await spawnCommand('node', ['-e', '0'], { env }).done;
    expect(ended.error?.code).toBe('ENOENT');
  });
});

describe('runCommand', () => {
  test('collects both streams and hands over each line, with how it ended', async () => {
    const lines: [string, boolean][] = [];
    const end = await runCommand(nodePath, ['-e', 'console.log("a"); console.error("b"); process.exit(2)'], {
      onLine: (line, isError) => lines.push([line, isError]),
    }).done; // oxfmt-ignore
    expect(end).toEqual({ exitCode: 2, signal: null, stdout: 'a\n', stderr: 'b\n' });
    expect(lines).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  test('collect: false keeps none of the output, and still hands over the lines', async () => {
    const lines: string[] = [];
    const end = await runCommand(nodePath, ['-e', 'console.log("a")'], {
      collect: false,
      onLine: (line) => lines.push(line),
    }).done;
    expect(end).toEqual({ exitCode: 0, signal: null, stdout: '', stderr: '' });
    expect(lines).toEqual(['a']);
  });

  test('feeds input to stdin, then closes it', async () => {
    const input = 'ü 世\n'.repeat(50_000);
    const end = await runCommand(nodePath, ['-e', "process.stdin.on('end', () => process.stdout.write('end')).pipe(process.stdout)"], { input }).done; // oxfmt-ignore
    expect(end.stdout).toBe(`${input}end`);
  });

  test('input to a command that exits without reading it is no error', async () => {
    const end = await runCommand(nodePath, ['-e', 'process.exit(0)'], { input: 'x'.repeat(8_000_000) }).done; // oxfmt-ignore
    expect(end).toMatchObject({ exitCode: 0 });
  });

  test('input to a command that cannot start is no error either', async () => {
    const end = await runCommand('stackctl-no-such-binary', [], { input: 'x'.repeat(1_000_000) }).done; // oxfmt-ignore
    expect(end.error?.code).toBe('ENOENT');
  });

  test('output neither collected nor read still drains: the command is never held up', async () => {
    const end = await runCommand(nodePath, ['-e', "process.stdout.write('x'.repeat(1_000_000)); process.stderr.write('y'.repeat(1_000_000))"], { collect: false }).done; // oxfmt-ignore
    expect(end).toEqual({ exitCode: 0, signal: null, stdout: '', stderr: '' });
  });

  test.each(['SIGTERM', 'SIGHUP'] as const)(
    'with endCommandsOnSignals, a %s to this process alone ends the commands it runs, and it',
    async (signal) => {
      const parent = script(`
        const { endCommandsOnSignals, execLines } = await import(RUNNERS);
        endCommandsOnSignals();
        void execLines(process.execPath, ['-e', 'console.log(process.pid); setInterval(() => {}, 1e9)'], {
          cwd: process.cwd(), env: { PATH: process.env.PATH },
          onLine: (line) => { console.log('child ' + line); setTimeout(() => process.kill(process.pid, '${signal}'), 50); },
        });`);
      const { out, ended } = await readAll(parent);
      const pid = Number(/child (\d+)/.exec(out)![1]);
      try {
        expect(ended).toEqual({ exitCode: signal === 'SIGTERM' ? 143 : 129, signal: null });
        await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
      } finally {
        if (alive(pid)) {
          process.kill(pid, 'SIGKILL');
        }
      }
    },
  );

  test('a detached command outlives this process: it is the caller to end', async () => {
    const parent = script(`
      const { runCommand } = await import(RUNNERS);
      const child = runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { detached: true });
      console.log(child.pid);
      child.unref(); child.stdout.destroy(); child.stderr.destroy();
      setTimeout(() => process.exit(0), 50);`);
    const { out } = await readAll(parent);
    const pid = Number(out.trim());
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(alive(pid)).toBe(true);
    } finally {
      if (alive(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    }
  });
});

// ---- The runners infra uses ----

const RUNNERS = pathToFileURL(path.join(import.meta.dirname, 'spawn.ts')).href;
const plain = { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } };

/** Runs `js` as an ES module in a node child; `RUNNERS` is the runners' module URL. */
function script(js: string) {
  return spawnCommand(
    process.execPath,
    ['--input-type=module', '-e', `const RUNNERS = ${JSON.stringify(RUNNERS)};\n${js}`],
    {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/** Collects a child's stdout, and resolves once it has printed `text`. */
function reading(child: ChildProcess) {
  let out = '';
  child.stdout!.on('data', (chunk: Buffer) => (out += String(chunk)));
  return {
    get out() {
      return out;
    },
    printed: (text: string) => vi.waitFor(() => expect(out).toContain(text), { timeout: 5000 }),
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('execLines', () => {
  test('streams each stream line by line, in order, including a final unterminated line', async () => {
    const lines: [string, boolean][] = [];
    const result = await execLines(
      nodePath,
      ['-e', 'process.stdout.write("one\\ntwo\\nthree"); process.stderr.write("oops\\n")'],
      { ...plain, onLine: (line, isError) => lines.push([line, isError]) },
    );
    expect(lines.filter(([, isError]) => !isError).map(([line]) => line)).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(lines.filter(([, isError]) => isError)).toEqual([['oops', true]]);
    expect(result).toEqual({ exitCode: 0, stdout: 'one\ntwo\nthree', stderr: 'oops\n' });
  });

  test('returns a non-zero exit code instead of throwing', async () => {
    const result = await execLines(nodePath, ['-e', 'process.exit(3)'], plain);
    expect(result.exitCode).toBe(3);
  });

  test('reports a command that cannot be spawned as exit 127, with the reason', async () => {
    const lines: [string, boolean][] = [];
    const result = await execLines('stackctl-no-such-binary', [], {
      ...plain,
      onLine: (line, isError) => lines.push([line, isError]),
    });
    expect(result).toEqual({
      exitCode: 127,
      stdout: '',
      stderr: "couldn't run stackctl-no-such-binary: not found",
    });
    expect(lines).toEqual([["couldn't run stackctl-no-such-binary: not found", true]]);
  });

  test("gives the child exactly `env`, not this process's environment", async () => {
    process.env.STACKCTL_EXEC_SPEC_LEAK = 'leaked';
    try {
      const result = await execLines(
        nodePath,
        ['-e', 'console.log(process.env.STACKCTL_EXEC_SPEC_LEAK ?? "absent", process.env.GIVEN)'],
        { ...plain, env: { ...plain.env, GIVEN: 'given' } },
      );
      expect(result.stdout.trim()).toBe('absent given');
    } finally {
      delete process.env.STACKCTL_EXEC_SPEC_LEAK;
    }
  });

  test('does not split a line on a carriage return progress update', async () => {
    const lines: string[] = [];
    await execLines(nodePath, ['-e', 'process.stdout.write("a\\r\\nb\\n")'], {
      ...plain,
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['a', 'b']);
  });

  test('a command ended by a signal is exit 1, not a success', async () => {
    const result = await execLines(nodePath, ['-e', "process.kill(process.pid, 'SIGTERM')"], plain);
    expect(result.exitCode).toBe(1);
  });

  test('stdin is closed: a command reading it sees its end at once', async () => {
    const result = await execLines(nodePath, ['-e', "process.stdin.on('end', () => console.log('eof')).resume()"], plain); // oxfmt-ignore
    expect(result.stdout).toBe('eof\n');
  });

  test('a directory that does not exist is named, not the command', async () => {
    const result = await execLines(nodePath, ['-e', '0'], {
      ...plain,
      cwd: '/stackctl-no-such-dir',
    });
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('/stackctl-no-such-dir');
    expect(result.stderr).not.toMatch(/not found/);
  });

  test('a command still running when this process exits is ended with it', async () => {
    const parent = script(`
      const { execLines } = await import(RUNNERS);
      void execLines(process.execPath, ['-e', 'console.log(process.pid); setInterval(() => {}, 1e9)'], {
        cwd: process.cwd(), env: { PATH: process.env.PATH },
        onLine: (line) => { console.log('child ' + line); setTimeout(() => process.exit(0), 50); },
      });`);
    const { out } = await readAll(parent);
    const pid = Number(/child (\d+)/.exec(out)![1]);
    try {
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
    } finally {
      if (alive(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    }
  });
});

describe('streamLines', () => {
  test('hands each line over as it arrives, and is done with the exit code', async () => {
    const lines: [string, boolean][] = [];
    const stream = streamLines(nodePath, ['-e', 'console.log("a"); console.error("b"); process.stdout.write("c"); process.exitCode = 4'], {
      ...plain,
      onLine: (line, isError) => lines.push([line, isError]),
    }); // oxfmt-ignore
    expect(await stream.done).toBe(4);
    expect(lines.filter(([, e]) => !e)).toEqual([
      ['a', false],
      ['c', false],
    ]);
    expect(lines.filter(([, e]) => e)).toEqual([['b', true]]);
  });

  test('stop ends the command, and done resolves', async () => {
    const lines: string[] = [];
    const stream = streamLines(nodePath, ['-e', 'console.log("up"); setInterval(() => {}, 1e9)'], {
      ...plain,
      onLine: (line) => lines.push(line),
    });
    await vi.waitFor(() => expect(lines).toEqual(['up']), { timeout: 5000 });
    stream.stop();
    expect(await stream.done).toBe(1);
    stream.stop();
  });

  test('a command that cannot start is done with 127', async () => {
    expect(await streamLines('stackctl-no-such-binary', [], plain).done).toBe(127);
  });

  test('a command still running when this process exits is ended with it', async () => {
    const parent = script(`
      const { streamLines } = await import(RUNNERS);
      streamLines(process.execPath, ['-e', 'console.log(process.pid); setInterval(() => {}, 1e9)'], {
        cwd: process.cwd(), env: { PATH: process.env.PATH },
        onLine: (line) => { console.log('child ' + line); setTimeout(() => process.exit(0), 50); },
      });`);
    const { out } = await readAll(parent);
    const pid = Number(/child (\d+)/.exec(out)![1]);
    try {
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
    } finally {
      if (alive(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    }
  });
});

describe('spawnInherit', () => {
  test('resolves with the exit code', async () => {
    const { out, ended } = await readAll(script(`
      const { spawnInherit } = await import(RUNNERS);
      console.log('code ' + await spawnInherit(process.execPath, ['-e', 'process.exit(6)'], { cwd: process.cwd(), env: { PATH: process.env.PATH } }));`)); // oxfmt-ignore
    expect(ended).toEqual({ exitCode: 0, signal: null });
    expect(out).toBe('code 6\n');
  });

  test('a command that cannot start is 127, with why on stderr', async () => {
    const { out, err } = await readAll(script(`
      const { spawnInherit } = await import(RUNNERS);
      console.log('code ' + await spawnInherit('stackctl-no-such-binary', [], { cwd: process.cwd(), env: { PATH: process.env.PATH } }));`)); // oxfmt-ignore
    expect(out).toBe('code 127\n');
    expect(err).toContain('stackctl-no-such-binary');
  });

  test('while the command runs, SIGINT leaves this process up and SIGTERM is forwarded', async () => {
    const parent = script(`
      const { spawnInherit } = await import(RUNNERS);
      const code = await spawnInherit(process.execPath, ['-e', "process.on('SIGTERM', () => { console.log('child: TERM'); process.exit(5); }); console.log('ready'); setInterval(() => {}, 1e9)"], { cwd: process.cwd(), env: { PATH: process.env.PATH } });
      console.log('parent: ' + code);`); // oxfmt-ignore
    const output = reading(parent);
    await output.printed('ready');
    parent.kill('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(parent.exitCode).toBeNull();
    parent.kill('SIGTERM');
    expect(await parent.done).toEqual({ exitCode: 0, signal: null });
    expect(output.out).toBe('ready\nchild: TERM\nparent: 5\n');
  });
});

/** Waits for a child to end, with all it printed. */
async function readAll(child: Spawned) {
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += String(chunk)));
  child.stderr?.on('data', (chunk: Buffer) => (err += String(chunk)));
  const ended = await child.done;
  return { out, err, ended };
}
