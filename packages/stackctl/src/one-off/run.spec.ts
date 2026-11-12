import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { processStartTime } from '../process-info.js';
import { type OneOffSpec, runOneOff } from './run.js';

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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-run-')));
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

const logsIn = (dir: string) => fs.readdirSync(dir).map((name) => path.join(dir, name));

/** A log file's lines, each without its timestamp. */
const logLines = (file: string) =>
  fs
    .readFileSync(file, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => line.replace(/^\S+ \S+ /, ''));

/** What the command wrote to a log file: its lines between the first and the last. */
const bodyOf = (file: string) => `${logLines(file).slice(1, -1).join('\n')}\n`;

/** The file a command run by {@link fdsOf} writes its stdout's and stderr's identity to. */
const fdsFile = () => path.join(tmp, 'fds.json');

/**
 * A command that writes, to {@link fdsFile}, which file each of its stdout and stderr is, and
 * prints nothing: what it was handed, with no output to land in the test runner's.
 */
const fdsOf = (): OneOffSpec =>
  node(`const fs=require('fs');const id=(fd)=>{const s=fs.fstatSync(fd);return s.dev+':'+s.ino};fs.writeFileSync(${JSON.stringify(fdsFile())},JSON.stringify([id(1),id(2)]))`); // oxfmt-ignore

/** Whether the command's stdout and stderr were this process's own: handed over, not piped. */
const handedOver = (): [boolean, boolean] => {
  const [out, err] = JSON.parse(fs.readFileSync(fdsFile(), 'utf8')) as [string, string];
  const id = (fd: number) => {
    const stat = fs.fstatSync(fd);
    return `${stat.dev}:${stat.ino}`;
  };
  return [out === id(1), err === id(2)];
};

describe('runOneOff', () => {
  test('returns the exit code', async () => {
    const result = await runOneOff(node('process.exit(3)'), { stdio: 'pipe', logDir: tmp });
    expect(result).toMatchObject({ exitCode: 3, signal: null });
  });

  test('returns the signal', async () => {
    const result = await runOneOff(node("process.kill(process.pid,'SIGTERM')"), {
      stdio: 'pipe',
      logDir: tmp,
    });
    expect(result).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
  });

  test('pipe captures output', async () => {
    const result = await runOneOff(node("console.log('hi')"), { stdio: 'pipe', logDir: tmp });
    expect(result.stdout).toBe('hi\n');
    expect(result.stderr).toBe('');
  });

  test("runs in the spec's directory, with exactly its environment", async () => {
    const spec = node('console.log(process.cwd()+"|"+String(process.env.ONLY_HERE)+"|"+String(process.env.NOT_GIVEN))'); // oxfmt-ignore
    process.env.NOT_GIVEN = 'leaked';
    try {
      const result = await runOneOff(
        { ...spec, env: { PATH: process.env.PATH, ONLY_HERE: 'yes' } },
        { stdio: 'pipe', logDir: tmp },
      );
      expect(result.stdout).toBe(`${tmp}|yes|undefined\n`);
    } finally {
      delete process.env.NOT_GIVEN;
    }
  });

  test('tees to a log file, between a line naming the command and one saying how it ended', async () => {
    const logDir = path.join(tmp, 'logs');
    await runOneOff(node("console.log('\\u001b[31mhi\\u001b[0m')"), { stdio: 'pipe', logDir });
    const [file] = logsIn(logDir);
    const text = fs.readFileSync(file!, 'utf8');
    expect(text).toMatch(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d .*\n){3}$/);
    expect(logLines(file!)).toEqual([
      `▶ running: ${process.execPath} -e 'console.log('\\''\\u001b[31mhi\\u001b[0m'\\'')' (in ${tmp})`,
      'hi',
      expect.stringMatching(/^✔ finished in \d+\.\d seconds$/),
    ]);
  });

  test("the log's last line says how the command ended", async () => {
    const lastLine = async (js: string) => {
      const logDir = path.join(tmp, `logs-${String(Math.random()).slice(2)}`);
      await runOneOff(node(js), { stdio: 'pipe', logDir });
      return logLines(logsIn(logDir)[0]!).at(-1);
    };
    expect(await lastLine('process.exit(3)')).toMatch(
      /^✘ exited with code 3 after \d+\.\d seconds$/,
    );
    expect(await lastLine("process.kill(process.pid,'SIGTERM')")).toMatch(
      /^✘ ended by SIGTERM after \d+\.\d seconds$/,
    );
  });

  test("a command that can't start is logged", async () => {
    const logDir = path.join(tmp, 'logs');
    const spec = { ...node(''), command: 'stackctl-no-such-command', args: [] };
    await expect(runOneOff(spec, { stdio: 'pipe', logDir })).rejects.toThrow('stackctl-no-such-command'); // oxfmt-ignore
    expect(logLines(logsIn(logDir)[0]!)).toEqual([
      `▶ running: stackctl-no-such-command (in ${tmp})`,
      expect.stringMatching(/^✘ couldn't start: .*stackctl-no-such-command/),
    ]);
  });

  test("the log's first line masks a URL's password", async () => {
    const logDir = path.join(tmp, 'logs');
    await runOneOff({ ...node(''), args: ['-e', '', 'postgres://app:hunter2@db/app'] }, { stdio: 'pipe', logDir }); // oxfmt-ignore
    const [first] = logLines(logsIn(logDir)[0]!);
    expect(first).toContain('postgres://app:***@db/app');
    expect(first).not.toContain('hunter2');
  });

  test('rejects when the command cannot start', async () => {
    const spec = { ...node(''), command: 'stackctl-no-such-command', args: [] };
    await expect(runOneOff(spec, { stdio: 'pipe', logDir: tmp })).rejects.toThrow(
      'stackctl-no-such-command',
    );
  });

  test('forwards SIGINT and removes its listeners', async () => {
    const ready = path.join(tmp, 'ready');
    const before = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((s) => process.listenerCount(s));
    const js = `process.on('SIGINT',()=>process.exit(7));require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1e9)`; // oxfmt-ignore
    const running = runOneOff(node(js), { stdio: 'pipe', logDir: tmp });
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(ready) || fs.readFileSync(ready, 'utf8') === '') {
        if (Date.now() > deadline) {
          throw new Error('the child never got ready');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await keep(Number(fs.readFileSync(ready, 'utf8')));
      process.emit('SIGINT');
      expect(await running).toMatchObject({ exitCode: 7, signal: null });
      expect((['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((s) => process.listenerCount(s))).toEqual(before); // oxfmt-ignore
    } finally {
      // A failure above must leave no child behind, and no listener: it exits, and the call ends.
      await killKept();
      await running.catch(() => {});
    }
  });

  test("doesn't forward SIGINT to a command sharing the terminal, and removes its listeners", async () => {
    const ready = path.join(tmp, 'ready');
    const go = path.join(tmp, 'go');
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const before = signals.map((s) => process.listenerCount(s));
    // Exits 7 if signalled; otherwise 0 once the test says so, by creating `go`.
    const js = `const fs=require('fs');process.on('SIGINT',()=>process.exit(7));fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)}))process.exit(0)},20)`; // oxfmt-ignore
    const running = runOneOff(node(js), {
      stdio: 'inherit',
      logDir: tmp,
      isTerminal: (fd) => fd === 0,
    });
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(ready) || fs.readFileSync(ready, 'utf8') === '') {
        if (Date.now() > deadline) {
          throw new Error('the child never got ready');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await keep(Number(fs.readFileSync(ready, 'utf8')));
      process.emit('SIGINT');
      // Long enough for a forwarded signal to have landed.
      await new Promise((resolve) => setTimeout(resolve, 200));
      fs.writeFileSync(go, '');
      expect(await running).toMatchObject({ exitCode: 0, signal: null });
      expect(signals.map((s) => process.listenerCount(s))).toEqual(before);
    } finally {
      await killKept();
      await running.catch(() => {});
    }
  });

  test('keeps a character split across chunks whole, in the result and the log', async () => {
    const logDir = path.join(tmp, 'logs');
    const result = await runOneOff(node("process.stdout.write('€'.repeat(100000))"), {
      stdio: 'pipe',
      logDir,
    });
    expect(result.stdout).toBe('€'.repeat(100000));
    const [file] = logsIn(logDir);
    expect(bodyOf(file!)).toBe(`${'€'.repeat(100000)}\n`);
  });

  test('many concurrent calls share their listeners: no MaxListenersExceededWarning', async () => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'] as const;
    const before = signals.map((s) => process.listenerCount(s));
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => {
      warnings.push(warning);
    };
    process.on('warning', onWarning);
    try {
      await Promise.all(
        Array.from({ length: 12 }, () =>
          runOneOff(node('setTimeout(()=>{},100)'), { stdio: 'pipe', logDir: tmp }),
        ),
      );
      // A warning is emitted on the next tick.
      await new Promise((resolve) => setImmediate(resolve));
      expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([]);
      expect(signals.map((s) => process.listenerCount(s))).toEqual(before);
    } finally {
      process.off('warning', onWarning);
    }
  });

  test('concurrent exec calls log to separate files', async () => {
    const logDir = path.join(tmp, 'logs');
    const words = ['alpha', 'bravo', 'charlie', 'delta'];
    await Promise.all(
      words.map((word) => runOneOff(node(`console.log('${word}')`), { stdio: 'pipe', logDir })),
    );
    const files = logsIn(logDir);
    expect(files).toHaveLength(4);
    const contents = files.map(bodyOf);
    expect(contents.sort()).toEqual(words.map((word) => `${word}\n`));
  });
});

describe('runOneOff hands a terminal to the command', () => {
  test("with 'inherit', stdout and stderr on a terminal are the command's own", async () => {
    const logDir = path.join(tmp, 'logs');
    await runOneOff(fdsOf(), { stdio: 'inherit', logDir, isTerminal: () => true, agent: false });
    expect(handedOver()).toEqual([true, true]);
    expect(logLines(logsIn(logDir)[0]!)[1]).toBe(
      'stdout and stderr went to the terminal, not to this log',
    );
  });

  test('each stream is decided on its own: a piped stdout stays piped, and logged', async () => {
    const logDir = path.join(tmp, 'logs');
    const spec = node(`${fdsOf().args[1]};console.log('piped')`);
    await runOneOff(spec, { stdio: 'inherit', logDir, isTerminal: (fd) => fd !== 1, agent: false });
    expect(handedOver()).toEqual([false, true]);
    expect(logLines(logsIn(logDir)[0]!).slice(1, -1)).toEqual([
      'stderr went to the terminal, not to this log',
      'piped',
    ]);
  });

  test('a coding agent gets pipes even on a terminal, so its log holds everything', async () => {
    await runOneOff(fdsOf(), {
      stdio: 'inherit',
      logDir: tmp,
      isTerminal: () => true,
      agent: true,
    });
    expect(handedOver()).toEqual([false, false]);
  });

  test("'pipe' collects on a terminal too", async () => {
    const result = await runOneOff(node(`${fdsOf().args[1]};console.log('hi')`), {
      stdio: 'pipe',
      logDir: tmp,
      isTerminal: () => true,
      agent: false,
    });
    expect(handedOver()).toEqual([false, false]);
    expect(result.stdout).toBe('hi\n');
  });
});
