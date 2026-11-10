import { describe, expect, test } from 'vitest';
import { execLines } from './exec.js';

const node = process.execPath;
const opts = { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } };

describe('execLines', () => {
  test('streams each stream line by line, in order, including a final unterminated line', async () => {
    const lines: [string, boolean][] = [];
    const result = await execLines(
      node,
      ['-e', 'process.stdout.write("one\\ntwo\\nthree"); process.stderr.write("oops\\n")'],
      { ...opts, onLine: (line, isError) => lines.push([line, isError]) },
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
    const result = await execLines(node, ['-e', 'process.exit(3)'], opts);
    expect(result.exitCode).toBe(3);
  });

  test('reports a command that cannot be spawned as exit 127, with the reason', async () => {
    const result = await execLines('stackctl-no-such-binary', [], opts);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toMatch(/stackctl-no-such-binary/);
  });

  test("gives the child exactly `env`, not this process's environment", async () => {
    process.env.STACKCTL_EXEC_SPEC_LEAK = 'leaked';
    try {
      const result = await execLines(
        node,
        ['-e', 'console.log(process.env.STACKCTL_EXEC_SPEC_LEAK ?? "absent", process.env.GIVEN)'],
        { ...opts, env: { ...opts.env, GIVEN: 'given' } },
      );
      expect(result.stdout.trim()).toBe('absent given');
    } finally {
      delete process.env.STACKCTL_EXEC_SPEC_LEAK;
    }
  });

  test('does not split a line on a carriage return progress update', async () => {
    const lines: string[] = [];
    await execLines(node, ['-e', 'process.stdout.write("a\\r\\nb\\n")'], {
      ...opts,
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['a', 'b']);
  });
});
