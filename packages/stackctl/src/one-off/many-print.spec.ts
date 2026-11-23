import chalk from 'chalk';
import { afterEach, describe, expect, test } from 'vitest';
import { stripAnsi } from '../format';
import type { ManyOutcome } from './many';
import { createManyPrinter, manySummary } from './many-print';
import type { ManyTarget } from './resolve';

const spec = { cwd: '/repo', command: 'true', args: [], env: {} };

const api: ManyTarget = { label: 'api', where: { service: 'api' }, color: '#1FC5DA', spec };
const worker: ManyTarget = {
  label: 'worker',
  where: { service: 'worker' },
  color: 'red',
  spec,
};
const tools: ManyTarget = { label: 'tools', where: { dir: 'tools' }, spec };

/** Streams that keep each write, and a printer over them. */
function printerFor(targets: ManyTarget[], nested = false) {
  const writes = { stdout: [] as string[], stderr: [] as string[] };
  const out = {
    stdout: { write: (text: string) => writes.stdout.push(text) },
    stderr: { write: (text: string) => writes.stderr.push(text) },
    nested,
  };
  return { print: createManyPrinter(targets, out), writes };
}

describe('createManyPrinter', () => {
  const level = chalk.level;
  afterEach(() => {
    chalk.level = level;
  });

  test('a line is its date stamp, its label padded to the widest, then the text', () => {
    const { print, writes } = printerFor([api, worker]);
    print(api, 'stdout', 'listening');
    print(worker, 'stdout', 'done');
    expect(writes.stdout.map(stripAnsi)).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[api {3}\] listening\n$/),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[worker\] done\n$/),
    ]);
    expect(writes.stderr).toEqual([]);
  });

  test('stderr lines go to stderr', () => {
    const { print, writes } = printerFor([api, worker]);
    print(worker, 'stderr', 'warn: slow');
    expect(writes.stdout).toEqual([]);
    expect(writes.stderr.map(stripAnsi)).toEqual([
      expect.stringMatching(/\[worker\] warn: slow\n$/),
    ]);
  });

  test('nested: no date stamp', () => {
    const { print, writes } = printerFor([api, worker], true);
    print(api, 'stdout', 'listening');
    expect(writes.stdout.map(stripAnsi)).toEqual(['[api   ] listening\n']);
  });

  test("a service's label wears its color, a directory's none", () => {
    chalk.level = 3;
    const { print, writes } = printerFor([api, worker, tools], true);
    print(api, 'stdout', 'x');
    print(worker, 'stdout', 'x');
    print(tools, 'stdout', 'x');
    expect(writes.stdout).toEqual([
      `${chalk.hex('#1FC5DA')('[api   ]')} x\n`,
      `${chalk.red('[worker]')} x\n`,
      '[tools ] x\n',
    ]);
  });
});

describe('manySummary', () => {
  const outcome = (o: Partial<ManyOutcome> & Pick<ManyOutcome, 'service' | 'status'>) => ({
    exitCode: null,
    signal: null,
    ms: 0,
    ...o,
  });

  test('the summary counts each status and gives each target a line', () => {
    const lines = manySummary([
      outcome({ service: 'api', status: 'ok', exitCode: 0, ms: 1_200 }),
      outcome({ service: 'web', status: 'failed', exitCode: 1, ms: 300 }),
      outcome({ service: 'worker', status: 'stopped', signal: 'SIGTERM', ms: 400 }),
      outcome({ service: 'tools', status: 'skipped' }),
      outcome({ service: 'docs', status: 'ok', exitCode: 0, ms: 2_000 }),
    ]);
    expect(lines[0]).toBe('stackctl: 2 ok, 1 failed, 1 stopped, 1 skipped');
    expect(lines).toHaveLength(6);
    expect(lines.find((line) => line.includes('web'))).toContain('exit 1');
    expect(lines.slice(1)).toEqual([
      '  api     ok       1.2 seconds',
      '  web     failed   exit 1, 0.3 seconds',
      '  worker  stopped  0.4 seconds',
      '  tools   skipped  no such script',
      '  docs    ok       2.0 seconds',
    ]);
  });

  test("a failed one names its signal, or the error of one that couldn't start", () => {
    const lines = manySummary([
      outcome({ service: 'api', status: 'failed', signal: 'SIGSEGV', ms: 100 }),
      outcome({ service: 'web', status: 'failed', error: "couldn't start nope: not found" }),
    ]);
    expect(lines).toEqual([
      'stackctl: 2 failed',
      '  api  failed  SIGSEGV, 0.1 seconds',
      "  web  failed  couldn't start nope: not found",
    ]);
  });
});
