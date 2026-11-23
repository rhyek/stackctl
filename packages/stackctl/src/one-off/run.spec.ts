import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { processStartTime } from '../process-info';
import { SHUTDOWN_GRACE_MS } from '../shutdown-timing';
import { MANY_GRACE_MS, type OneOffSpec, runOneOff } from './run';

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
      "✘ couldn't start stackctl-no-such-command: not found",
    ]);
  });

  test("a directory that doesn't exist is named, not the command", async () => {
    const logDir = path.join(tmp, 'logs');
    const spec = { ...node(''), cwd: path.join(tmp, 'missing') };
    await expect(runOneOff(spec, { stdio: 'pipe', logDir })).rejects.toThrow(
      `couldn't start ${spec.command}: no directory ${spec.cwd}`,
    );
  });

  test('a last line with no newline is logged, before the end', async () => {
    const logDir = path.join(tmp, 'logs');
    const result = await runOneOff(node("process.stdout.write('one\\ntwo')"), { stdio: 'pipe', logDir }); // oxfmt-ignore
    expect(result.stdout).toBe('one\ntwo');
    expect(logLines(logsIn(logDir)[0]!).slice(1)).toEqual([
      'one',
      'two',
      expect.stringMatching(/^✔ finished in /),
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

describe('runOneOff inside a command stackctl runs', () => {
  /** A command that writes `STACKCTL_NESTED` as it sees it to `file`, and prints nothing. */
  const markerTo = (file: string) =>
    node(
      `require('fs').writeFileSync(${JSON.stringify(file)},String(process.env.STACKCTL_NESTED))`,
    );

  test('outside one, the command it runs is marked, so an exec or run there is nested', async () => {
    const file = path.join(tmp, 'marker');
    await runOneOff(markerTo(file), { stdio: 'pipe', logDir: tmp, nested: false });
    expect(fs.readFileSync(file, 'utf8')).toBe('1');
  });

  test('inside one, the mark goes no further: what the command runs is its own', async () => {
    const file = path.join(tmp, 'marker');
    await runOneOff(markerTo(file), { stdio: 'pipe', logDir: tmp, nested: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('undefined');
  });

  test('inside one, the streams go straight through and no log is written', async () => {
    const logDir = path.join(tmp, 'logs');
    // As an agent's piped command would be, which only the outer command pipes.
    await runOneOff(fdsOf(), {
      stdio: 'inherit',
      logDir,
      isTerminal: () => false,
      agent: true,
      nested: true,
    });
    expect(handedOver()).toEqual([true, true]);
    expect(fs.existsSync(logDir)).toBe(false);
  });

  test("inside one, 'pipe' still collects, and still writes no log", async () => {
    const logDir = path.join(tmp, 'logs');
    const result = await runOneOff(node("console.log('hi')"), {
      stdio: 'pipe',
      logDir,
      nested: true,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'hi\n' });
    expect(fs.existsSync(logDir)).toBe(false);
  });

  test("inside one, a command that can't start still rejects", async () => {
    const spec = { ...node(''), command: 'stackctl-no-such-command', args: [] };
    await expect(runOneOff(spec, { stdio: 'pipe', logDir: tmp, nested: true })).rejects.toThrow(
      'stackctl-no-such-command',
    );
  });
});

describe('runOneOff in the many form', () => {
  /** `sh -c <script>` in the temp directory, with this process's environment. */
  const sh = (script: string): OneOffSpec => ({
    cwd: tmp,
    command: '/bin/sh',
    args: ['-c', script],
    env: { ...process.env },
  });

  /** The file a command writes its pids to, a line ending in a newline, for the test to keep. */
  const pidsFile = () => path.join(tmp, 'pids');

  /** JavaScript that writes the command's pid to {@link pidsFile}. */
  const writePid = () =>
    `require('fs').writeFileSync(${JSON.stringify(pidsFile())},process.pid+'\\n')`;

  /** The pids in {@link pidsFile} once it holds its line, kept; rejects after 5 s. */
  const pidsWritten = async (): Promise<number[]> => {
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(pidsFile()) || !fs.readFileSync(pidsFile(), 'utf8').endsWith('\n')) {
      if (Date.now() > deadline) {
        throw new Error('the command never wrote its pids');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return keepPidsWritten();
  };

  /** Keeps whatever pids {@link pidsFile} holds, should the command outlive its test. */
  const keepPidsWritten = async (): Promise<number[]> => {
    const text = fs.existsSync(pidsFile()) ? fs.readFileSync(pidsFile(), 'utf8') : '';
    const pids = text.split(/\s+/).filter(Boolean).map(Number);
    for (const pid of pids) {
      await keep(pid);
    }
    return pids;
  };

  /** Whether `pid` names a process: a signal 0 reaches it. */
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  };

  /** Resolves once `pid` is gone, its reaping included; rejects after 5 s. */
  const gone = async (pid: number) => {
    const deadline = Date.now() + 5_000;
    while (alive(pid)) {
      if (Date.now() > deadline) {
        throw new Error(`${String(pid)} is still running`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  /** An `onLine` that records each line with its stream. */
  const recorder = () => {
    const lines: ['stdout' | 'stderr', string][] = [];
    const onLine = (stream: 'stdout' | 'stderr', line: string) => {
      lines.push([stream, line]);
    };
    const of = (stream: 'stdout' | 'stderr') =>
      lines.filter(([s]) => s === stream).map(([, line]) => line);
    return { lines, onLine, of };
  };

  test('many: each line goes to onLine with its stream, the last one without a newline too', async () => {
    const { lines, onLine, of } = recorder();
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    let result;
    try {
      result = await runOneOff(node("process.stdout.write('a\\nb');process.stderr.write('c\\n')"), {
        stdio: 'inherit',
        logDir: tmp,
        isTerminal: () => true,
        agent: false,
        many: { onLine, stop: new AbortController().signal },
      });
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(result).toEqual({ exitCode: 0, signal: null });
    // Each stream's lines in order; the two streams interleave as they arrive.
    expect(of('stdout')).toEqual(['a', 'b']);
    expect(of('stderr')).toEqual(['c']);
    expect(lines).toHaveLength(3);
  });

  test("many: with 'pipe', the output is still collected into the result", async () => {
    const result = await runOneOff(node("console.log('hi');console.error('there')"), {
      stdio: 'pipe',
      logDir: tmp,
      many: { stop: new AbortController().signal },
    });
    expect(result).toEqual({ exitCode: 0, signal: null, stdout: 'hi\n', stderr: 'there\n' });
  });

  test('many: the log records the piped lines, as without it', async () => {
    const logDir = path.join(tmp, 'logs');
    await runOneOff(node("console.log('one');console.error('two')"), {
      stdio: 'inherit',
      logDir,
      isTerminal: () => true,
      agent: false,
      many: { onLine: () => {}, stop: new AbortController().signal },
    });
    expect(logLines(logsIn(logDir)[0]!).slice(1, -1).sort()).toEqual(['one', 'two']);
  });

  test('many: stdin is closed', { timeout: 10_000 }, async () => {
    const running = runOneOff(
      node(`${writePid()};process.stdin.resume();process.stdin.on('end',()=>process.exit(0))`),
      {
        stdio: 'pipe',
        logDir: tmp,
        many: { stop: new AbortController().signal, graceMs: 200 },
      },
    );
    try {
      await pidsWritten();
      const at = Date.now();
      expect(await running).toMatchObject({ exitCode: 0, signal: null });
      expect(Date.now() - at).toBeLessThan(2_000);
    } finally {
      await keepPidsWritten();
      await killKept();
      await running.catch(() => {});
    }
  });

  test('many: stop ends the command and its children', { timeout: 10_000 }, async () => {
    const stop = new AbortController();
    const running = runOneOff(sh(`sleep 30 & echo "$$ $!" > '${pidsFile()}'; wait`), {
      stdio: 'pipe',
      logDir: tmp,
      many: { stop: stop.signal, graceMs: 2_000 },
    });
    try {
      const [, sleep] = await pidsWritten();
      const at = Date.now();
      stop.abort();
      expect(await running).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
      expect(Date.now() - at).toBeLessThan(1_500);
      await gone(sleep!);
    } finally {
      await keepPidsWritten();
      await killKept();
      await running.catch(() => {});
    }
  });

  test(
    'many: a command that ignores SIGTERM is killed after the grace',
    { timeout: 10_000 },
    async () => {
      const stop = new AbortController();
      const running = runOneOff(
        node(`process.on('SIGTERM',()=>{});${writePid()};setInterval(()=>{},1e9)`),
        { stdio: 'pipe', logDir: tmp, many: { stop: stop.signal, graceMs: 200 } },
      );
      try {
        await pidsWritten();
        const at = Date.now();
        stop.abort();
        expect(await running).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
        expect(Date.now() - at).toBeLessThan(2_000);
      } finally {
        await keepPidsWritten();
        await killKept();
        await running.catch(() => {});
      }
    },
  );

  test('many: a stop already aborted ends the command at once', { timeout: 10_000 }, async () => {
    const running = runOneOff(node(`${writePid()};setInterval(()=>{},1e9)`), {
      stdio: 'pipe',
      logDir: tmp,
      many: { stop: AbortSignal.abort(), graceMs: 200 },
    });
    // Should it be ignored, the command runs on: its pid, kept below, ends it once the test fails.
    const ended = await Promise.race([
      running,
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    try {
      expect(ended).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
    } finally {
      await keepPidsWritten();
      await killKept();
      await running.catch(() => {});
    }
  });

  test(
    'many: onStopSent is called when stop reaches a running command, once',
    { timeout: 10_000 },
    async () => {
      const stop = new AbortController();
      const onStopSent = vi.fn();
      // It ignores SIGTERM: the stop, a forwarded SIGTERM and the SIGKILL after the grace all
      // reach it.
      const running = runOneOff(
        node(`process.on('SIGTERM',()=>{});${writePid()};setInterval(()=>{},1e9)`),
        { stdio: 'pipe', logDir: tmp, many: { stop: stop.signal, graceMs: 200, onStopSent } },
      );
      try {
        await pidsWritten();
        expect(onStopSent).not.toHaveBeenCalled();
        stop.abort();
        process.emit('SIGTERM');
        expect(await running).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
        expect(onStopSent).toHaveBeenCalledTimes(1);
      } finally {
        await keepPidsWritten();
        await killKept();
        await running.catch(() => {});
      }
    },
  );

  test(
    'many: onStopSent is not called for a command that already ended',
    { timeout: 10_000 },
    async () => {
      const stop = new AbortController();
      const onStopSent = vi.fn();
      // The shell exits at once; the sleep it leaves holds its stdout open, so the run goes on.
      const running = runOneOff(sh(`sleep 30 & echo "$$ $!" > '${pidsFile()}'; exit 0`), {
        stdio: 'pipe',
        logDir: tmp,
        many: { stop: stop.signal, graceMs: 200, onStopSent },
      });
      try {
        const [shell, sleep] = await pidsWritten();
        await gone(shell!);
        stop.abort();
        expect(await running).toMatchObject({ exitCode: 0, signal: null });
        expect(onStopSent).not.toHaveBeenCalled();
        await gone(sleep!);
      } finally {
        await keepPidsWritten();
        await killKept();
        await running.catch(() => {});
      }
    },
  );

  test(
    "many: SIGINT is forwarded even on a terminal: the terminal's doesn't reach its group",
    { timeout: 10_000 },
    async () => {
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
      const before = signals.map((s) => process.listenerCount(s));
      const running = runOneOff(
        node(`process.on('SIGINT',()=>process.exit(7));${writePid()};setInterval(()=>{},1e9)`),
        {
          stdio: 'inherit',
          logDir: tmp,
          isTerminal: (fd) => fd === 0,
          many: { onLine: () => {}, stop: new AbortController().signal, graceMs: 200 },
        },
      );
      try {
        await pidsWritten();
        process.emit('SIGINT');
        expect(await running).toMatchObject({ exitCode: 7, signal: null });
        expect(signals.map((s) => process.listenerCount(s))).toEqual(before);
      } finally {
        await keepPidsWritten();
        await killKept();
        await running.catch(() => {});
      }
    },
  );

  test(
    'many: a forwarded signal is followed by SIGKILL after the grace',
    { timeout: 10_000 },
    async () => {
      const running = runOneOff(
        node(`process.on('SIGTERM',()=>{});${writePid()};setInterval(()=>{},1e9)`),
        { stdio: 'pipe', logDir: tmp, many: { stop: new AbortController().signal, graceMs: 200 } },
      );
      try {
        const [pid] = await pidsWritten();
        const at = Date.now();
        process.emit('SIGTERM');
        expect(await running).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
        expect(Date.now() - at).toBeLessThan(2_000);
        await gone(pid!);
      } finally {
        await keepPidsWritten();
        await killKept();
        await running.catch(() => {});
      }
    },
  );

  test(
    "many: stop after a forwarded signal doesn't restart the grace",
    { timeout: 10_000 },
    async () => {
      const stop = new AbortController();
      const running = runOneOff(
        node(`process.on('SIGTERM',()=>{});${writePid()};setInterval(()=>{},1e9)`),
        { stdio: 'pipe', logDir: tmp, many: { stop: stop.signal, graceMs: 1_000 } },
      );
      try {
        await pidsWritten();
        const at = Date.now();
        process.emit('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 500));
        stop.abort();
        expect(await running).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
        // About 1000 ms after the forwarded signal; a grace restarted by the stop would be 1500.
        expect(Date.now() - at).toBeGreaterThanOrEqual(990);
        expect(Date.now() - at).toBeLessThan(1_400);
      } finally {
        await keepPidsWritten();
        await killKept();
        await running.catch(() => {});
      }
    },
  );

  test(
    'many: stop reaches a descendant that outlives the leader',
    { timeout: 15_000 },
    async () => {
      const stop = new AbortController();
      // A background shell that ignores SIGTERM, holds none of the command's pipes, and writes its
      // pid once its trap is set; the leader sleeps in the foreground.
      const running = runOneOff(
        sh(`sh -c "trap '' TERM; echo \\$\\$ > '${pidsFile()}'; exec sleep 30" >/dev/null 2>&1 & sleep 30`), // oxfmt-ignore
        // A grace longer than the test waits: only a sweep at the leader's end reaches it.
        { stdio: 'pipe', logDir: tmp, many: { stop: stop.signal, graceMs: 10_000 } },
      );
      try {
        const [background] = await pidsWritten();
        stop.abort();
        expect(await running).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
        await gone(background!);
      } finally {
        await keepPidsWritten();
        await killKept();
        await running.catch(() => {});
      }
    },
  );

  test(
    'many: a forwarded SIGINT reaches a background job that ignores it',
    { timeout: 15_000 },
    async () => {
      // A non-interactive shell starts an `&` job with SIGINT ignored.
      const running = runOneOff(
        sh(`sleep 30 >/dev/null 2>&1 & echo "$!" > '${pidsFile()}'; sleep 30`),
        {
          stdio: 'pipe',
          logDir: tmp,
          many: { stop: new AbortController().signal, graceMs: 10_000 },
        },
      );
      try {
        const [background] = await pidsWritten();
        process.emit('SIGINT');
        expect(await running).toMatchObject({ exitCode: null, signal: 'SIGINT' });
        await gone(background!);
      } finally {
        await keepPidsWritten();
        await killKept();
        await running.catch(() => {});
      }
    },
  );

  test(
    'many: a command that ended by itself leaves its background process alone',
    { timeout: 10_000 },
    async () => {
      const running = runOneOff(
        sh(`sleep 30 >/dev/null 2>&1 & echo "$!" > '${pidsFile()}'; exit 0`),
        { stdio: 'pipe', logDir: tmp, many: { stop: new AbortController().signal } },
      );
      try {
        expect(await running).toMatchObject({ exitCode: 0, signal: null });
        const [background] = await keepPidsWritten();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(alive(background!)).toBe(true);
      } finally {
        await keepPidsWritten();
        await killKept();
        await running.catch(() => {});
      }
    },
  );

  test('single form: a forwarded signal arms no SIGKILL', { timeout: 10_000 }, async () => {
    const running = runOneOff(
      node(`process.on('SIGTERM',()=>setTimeout(()=>process.exit(5),500));${writePid()};setInterval(()=>{},1e9)`), // oxfmt-ignore
      { stdio: 'pipe', logDir: tmp },
    );
    try {
      await pidsWritten();
      process.emit('SIGTERM');
      expect(await running).toMatchObject({ exitCode: 5, signal: null });
    } finally {
      await keepPidsWritten();
      await killKept();
      await running.catch(() => {});
    }
  });

  test("MANY_GRACE_MS is under a session's grace", () => {
    expect(MANY_GRACE_MS).toBeLessThan(SHUTDOWN_GRACE_MS);
  });

  test('many: a stop after the command ended does nothing', async () => {
    const stop = new AbortController();
    const result = await runOneOff(node(''), {
      stdio: 'pipe',
      logDir: tmp,
      many: { stop: stop.signal, graceMs: 200 },
    });
    expect(() => stop.abort()).not.toThrow();
    expect(result).toMatchObject({ exitCode: 0, signal: null });
  });

  test('many: nested, the output is still piped to onLine and no log is written', async () => {
    const logDir = path.join(tmp, 'logs');
    const { lines, onLine } = recorder();
    await runOneOff(node(`${fdsOf().args[1]};console.log('hi')`), {
      stdio: 'inherit',
      logDir,
      isTerminal: () => true,
      agent: false,
      nested: true,
      many: { onLine, stop: new AbortController().signal },
    });
    expect(handedOver()).toEqual([false, false]);
    expect(lines).toEqual([['stdout', 'hi']]);
    expect(fs.existsSync(logDir)).toBe(false);
  });
});
