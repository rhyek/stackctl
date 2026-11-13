import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { isProcessAlive } from '../process-info.js';
import { readRunning, writeRunning } from '../running.js';
import {
  ChildRecords,
  type ProcessExit,
  type ProcessState,
  ServiceProcess,
} from './service-process.js';

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A `/bin/sh` command that runs `src` as node, with node replacing the shell whatever `sh` is. */
const node = (src: string) => `exec ${quote(process.execPath)} -e ${quote(src)}`;

interface Line {
  text: string;
  isError: boolean;
}

const spawned: ServiceProcess[] = [];
const strays: number[] = [];

// A workspace root with no session record: the specs' spawns are recorded in memory only.
const recordsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-sp-'));
const records = new ChildRecords(recordsRoot);

afterAll(() => {
  fs.rmSync(recordsRoot, { recursive: true, force: true });
});

afterEach(() => {
  for (const proc of spawned.splice(0)) {
    if (proc.pid !== null) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

function run(
  command: string,
  opts: {
    graceMs?: number;
    cwd?: string;
    onLine?: (line: Line) => void;
    start?: boolean;
  } = {},
) {
  const lines: Line[] = [];
  const states: ProcessState[] = [];
  const proc = new ServiceProcess({
    name: 'web',
    command,
    cwd: opts.cwd ?? process.cwd(),
    env: process.env,
    graceMs: opts.graceMs,
    onLine: (text, isError) => {
      lines.push({ text, isError });
      opts.onLine?.({ text, isError });
    },
    records,
  });
  spawned.push(proc);
  proc.on('state', (s) => states.push(s));
  const exited = new Promise<{ exit: ProcessExit; linesAtExit: number }>((resolve) => {
    proc.once('exit', (exit) => resolve({ exit, linesAtExit: lines.length }));
  });
  if (opts.start !== false) {
    proc.start();
  }
  return { proc, lines, states, exited };
}

/** Resolves with the first line `match` accepts. */
function lineMatching(proc: ReturnType<typeof run>, match: (text: string) => boolean) {
  return new Promise<string>((resolve) => {
    const seen = proc.lines.find((l) => match(l.text));
    if (seen) {
      resolve(seen.text);
      return;
    }
    const timer = setInterval(() => {
      const line = proc.lines.find((l) => match(l.text));
      if (line) {
        clearInterval(timer);
        resolve(line.text);
      }
    }, 10);
  });
}

async function waitDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

describe('ServiceProcess', () => {
  test('splits stdout and stderr into lines, including a final unterminated line', async () => {
    const p = run(
      node(`
        process.stdout.write('one\\ntwo\\n\\nthree');
        process.stderr.write('err one\\n');
        setTimeout(() => {
          process.stdout.write(' continued\\npar');
          setTimeout(() => process.stdout.write('tial\\nlast'), 20);
        }, 20);
      `),
    );
    const { exit, linesAtExit } = await p.exited;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(p.proc.exitCode).toBe(0);
    expect(p.lines.filter((l) => !l.isError).map((l) => l.text)).toEqual([
      'one',
      'two',
      'three continued',
      'partial',
      'last',
    ]);
    expect(p.lines.filter((l) => l.isError).map((l) => l.text)).toEqual(['err one']);
    // Every line is out before the exit is reported.
    expect(linesAtExit).toBe(p.lines.length);
  });

  test('marks the command, so an exec or run it starts is part of it', async () => {
    const p = run(node('console.log(String(process.env.STACKCTL_NESTED))'));
    await p.exited;
    expect(p.lines.map((l) => l.text)).toEqual(['1']);
  });

  test('removes title sequences and keeps a carriage return', async () => {
    const p = run(
      node(`process.stdout.write('\\x1b]0;title\\x07a\\r\\n\\x1b]2;only\\x07\\nb\\n')`),
    );
    await p.exited;
    expect(p.lines.map((l) => l.text)).toEqual(['a\r', 'b']);
  });

  test('stop sends SIGTERM to the whole group', async () => {
    const p = run(
      node(`
        const { spawn } = process.getBuiltinModule('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        console.log('grandchild ' + child.pid);
        setInterval(() => {}, 1000);
      `),
    );
    const grandchild = Number(
      (await lineMatching(p, (t) => t.startsWith('grandchild '))).split(' ')[1],
    );
    strays.push(grandchild);
    const exit = await p.proc.stop();
    expect(exit).toEqual({ code: null, signal: 'SIGTERM' });
    expect(p.proc.exitCode).toBe(143);
    expect(await waitDead(grandchild)).toBe(true);
  });

  test('stop escalates to SIGKILL after the grace period', async () => {
    const p = run(
      node(`
        process.on('SIGTERM', () => {});
        console.log('armed');
        setInterval(() => {}, 1000);
      `),
      { graceMs: 300 },
    );
    await lineMatching(p, (t) => t === 'armed');
    const began = Date.now();
    const exit = await p.proc.stop();
    expect(Date.now() - began).toBeGreaterThanOrEqual(280);
    expect(exit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(p.proc.exitCode).toBe(137);
  });

  test('kill during a stop ends it without waiting out the grace period', async () => {
    const p = run(
      node(`
        process.on('SIGTERM', () => {});
        console.log('armed');
        setInterval(() => {}, 1000);
      `),
    );
    await lineMatching(p, (t) => t === 'armed');
    const began = Date.now();
    const stopping = p.proc.stop();
    expect(p.proc.stop()).toBe(stopping);
    p.proc.kill();
    expect(await stopping).toEqual({ code: null, signal: 'SIGKILL' });
    expect(Date.now() - began).toBeLessThan(5000);
  });

  test('a command that does not exist exits with the reason as a line', async () => {
    const p = run('stackctl-no-such-command-x1');
    const { exit } = await p.exited;
    expect(exit.code).toBe(127);
    expect(p.proc.exitCode).toBe(127);
    expect(p.lines.some((l) => l.isError && l.text.includes('stackctl-no-such-command-x1'))).toBe(
      true,
    );
  });

  test('a spawn that fails outright exits with code 1 and the reason as a line', async () => {
    const missing = path.join(
      os.tmpdir(),
      `stackctl-missing-${String(process.pid)}-${String(Date.now())}`,
    );
    const p = run(node('0'), { cwd: missing });
    const { exit } = await p.exited;
    expect(exit).toEqual({ code: null, signal: null });
    expect(p.proc.exitCode).toBe(1);
    expect(p.proc.pid).toBeNull();
    expect(p.proc.state).toBe('exited');
    expect(p.lines).toEqual([
      { text: `failed to start: directory not found: ${missing}`, isError: true },
    ]);
  });

  test('states go idle → starting → running → stopping → exited', async () => {
    const proc = new ServiceProcess({
      name: 'web',
      command: node(`console.log('up'); setInterval(() => {}, 1000)`),
      cwd: process.cwd(),
      env: process.env,
      onLine: () => {},
      records,
    });
    spawned.push(proc);
    expect(proc.state).toBe('idle');
    const states: ProcessState[] = [];
    proc.on('state', (s) => states.push(s));
    const running = new Promise<void>((resolve) => {
      proc.on('state', (s) => s === 'running' && resolve());
    });
    proc.start();
    await running;
    expect(proc.pid).toEqual(expect.any(Number));
    expect(proc.exitCode).toBeNull();
    await proc.stop();
    expect(states).toEqual(['starting', 'running', 'stopping', 'exited']);
    expect(proc.state).toBe('exited');
  });

  test('the exit is reported promptly when a group member keeps the pipes open', async () => {
    const p = run(
      node(`
        const { spawn } = process.getBuiltinModule('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
        console.log('grandchild ' + child.pid);
        child.unref();
      `),
    );
    const grandchild = Number(
      (await lineMatching(p, (t) => t.startsWith('grandchild '))).split(' ')[1],
    );
    strays.push(grandchild);
    const began = Date.now();
    const { exit } = await p.exited;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(Date.now() - began).toBeLessThan(1000);
    expect(isProcessAlive(grandchild)).toBe(true);
  });

  test('a partial line shows once its pipe has been quiet, while the process runs', async () => {
    const p = run(
      node(`process.stdout.write('Listening (no newline)'); setInterval(() => {}, 1000)`),
    );
    const began = Date.now();
    await lineMatching(p, (t) => t === 'Listening (no newline)');
    // Generous: the bound covers node's own startup under a loaded suite. The child never exits,
    // so the line arriving while it runs is the point.
    expect(Date.now() - began).toBeLessThan(1500);
    expect(p.proc.state).toBe('running');
  });

  test('a character split across two reads arrives whole', async () => {
    const p = run(
      node(`
        const bytes = Buffer.from('€uro\\n');
        let i = 0;
        const timer = setInterval(() => {
          process.stdout.write(bytes.subarray(i, i + 1));
          if (++i === bytes.length) clearInterval(timer);
        }, 20);
      `),
    );
    await p.exited;
    expect(p.lines).toEqual([{ text: '€uro', isError: false }]);
  });

  test('a partial line over 64 KiB is passed on while the process keeps writing', async () => {
    const p = run(
      node(`
        process.stdout.write('x'.repeat(70000));
        setInterval(() => process.stdout.write('y'), 20);
      `),
    );
    const line = await lineMatching(p, (t) => t.length > 64 * 1024);
    expect(line).toMatch(/^x{70000}y*$/);
    expect(p.proc.state).toBe('running');
  });

  test('records its process group in the session child records', async () => {
    const p = run(node('0'));
    await p.exited;
    expect(records.records).toContainEqual({ pid: p.proc.pid, cwd: process.cwd() });
  });

  test('a listener that throws neither stalls the stop nor silences the others', async () => {
    const heard: string[] = [];
    const p = run(node(`console.log('up'); setInterval(() => {}, 1000)`), {
      onLine: () => {
        throw new Error('onLine');
      },
    });
    p.proc.on('state', (s) => {
      if (s === 'exited') {
        throw new Error('state');
      }
    });
    p.proc.on('exit', () => {
      throw new Error('exit');
    });
    p.proc.on('exit', () => heard.push('exit'));
    await lineMatching(p, (t) => t === 'up');
    expect(await p.proc.stop()).toEqual({ code: null, signal: 'SIGTERM' });
    await p.exited;
    expect(heard).toEqual(['exit']);
    expect(p.states.at(-1)).toBe('exited');
  });

  test('stop and kill before start do nothing', async () => {
    const p = run(node('0'), { start: false });
    expect(await p.proc.stop()).toEqual({ code: null, signal: null });
    p.proc.kill();
    expect(p.proc.state).toBe('idle');
    expect(p.states).toEqual([]);
  });

  test('a stop before the spawn has completed ends the process', async () => {
    const p = run(node('setInterval(() => {}, 1000)'));
    expect(p.proc.state).toBe('starting');
    expect(await p.proc.stop()).toEqual({ code: null, signal: 'SIGTERM' });
    expect(p.states).toEqual(['starting', 'stopping', 'exited']);
    expect(p.proc.exitCode).toBe(143);
  });

  test('a kill before the spawn has completed ends the process', async () => {
    const p = run(node('setInterval(() => {}, 1000)'));
    p.proc.kill();
    const { exit } = await p.exited;
    expect(exit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(p.states).toEqual(['starting', 'stopping', 'exited']);
  });

  test('stop and kill after the exit send nothing and change nothing', async () => {
    const p = run(node('0'));
    await p.exited;
    const states = [...p.states];
    expect(await p.proc.stop()).toEqual({ code: 0, signal: null });
    p.proc.kill();
    expect(p.proc.state).toBe('exited');
    expect(p.proc.exitCode).toBe(0);
    expect(p.states).toEqual(states);
  });

  test('once the process has exited, stop and kill leave the rest of its group alone', async () => {
    const p = run(
      node(`
        const { spawn } = process.getBuiltinModule('node:child_process');
        const child = spawn(
          process.execPath,
          ['-e', "process.on('SIGTERM', () => console.log('grandchild got SIGTERM')); console.log('grandchild ' + process.pid); setInterval(() => {}, 1000)"],
          { stdio: 'inherit' },
        );
        child.unref();
        setTimeout(() => process.exit(0), 300);
      `),
    );
    const grandchild = Number(
      (await lineMatching(p, (t) => t.startsWith('grandchild '))).split(' ')[1],
    );
    strays.push(grandchild);
    const leader = p.proc.pid!;
    // The process has been reaped, and its pipes (held by the grandchild) are still draining.
    while (isProcessAlive(leader)) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const stopped = p.proc.stop();
    p.proc.kill();
    expect(await stopped).toEqual({ code: 0, signal: null });
    await new Promise((r) => setTimeout(r, 200));
    expect(p.lines.map((l) => l.text)).not.toContain('grandchild got SIGTERM');
    expect(isProcessAlive(grandchild)).toBe(true);
  });
});

describe('ChildRecords', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  /** The pid of a process group that has already ended. */
  async function deadGroup(): Promise<number> {
    const child = spawn(process.execPath, ['-e', '0'], { detached: true, stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    return child.pid!;
  }

  test('rewrites the session record it owns, dropping a dead group first over the bound', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-records-'));
    writeRunning(root, { port: 1, pid: process.pid });
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    try {
      const records = new ChildRecords(root, 2);
      const dead = await deadGroup();
      records.add(live.pid!, '/srv/web');
      records.add(dead, '/srv/api');
      expect(readRunning(root)?.children).toEqual([
        { pid: live.pid, cwd: '/srv/web' },
        { pid: dead, cwd: '/srv/api' },
      ]);
      // Over the bound: the dead group goes, though the live one is older.
      records.add(424242, '/srv/worker');
      expect(readRunning(root)?.children).toEqual([
        { pid: live.pid, cwd: '/srv/web' },
        { pid: 424242, cwd: '/srv/worker' },
      ]);
    } finally {
      process.kill(-live.pid!, 'SIGKILL');
    }
  });

  test('drops every record whose group has ended on each add, under the bound too', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-records-'));
    writeRunning(root, { port: 1, pid: process.pid });
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    // A wrapper that exits at once, leaving a member of its group running.
    const wrapper = spawn('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 &'], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise((resolve) => wrapper.once('exit', resolve));
    try {
      const records = new ChildRecords(root);
      records.add(await deadGroup(), '/srv/api');
      records.add(await deadGroup(), '/srv/worker');
      records.add(wrapper.pid!, '/srv/admin');
      records.add(live.pid!, '/srv/web');
      expect(readRunning(root)?.children).toEqual([
        { pid: wrapper.pid, cwd: '/srv/admin' },
        { pid: live.pid, cwd: '/srv/web' },
      ]);
    } finally {
      process.kill(-live.pid!, 'SIGKILL');
      process.kill(-wrapper.pid!, 'SIGKILL');
    }
  });

  test('leaves a record it does not own alone', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-records-'));
    writeRunning(root, { port: 1, pid: 1 });
    new ChildRecords(root).add(4242, '/srv/web');
    expect(readRunning(root)?.children).toBeUndefined();
  });
});
