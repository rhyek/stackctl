import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { processStartTime } from './process-info.js';
import {
  formatMemory,
  libprocReader,
  loadLibproc,
  parseProcStat,
  parseProcStatus,
  procReader,
  shouldUpdate,
  treeOf,
  UsageSampler,
  type Libproc,
  type ServiceUsage,
  type UsageReader,
} from './service-usage.js';

const MiB = 2 ** 20;

describe('formatMemory', () => {
  test('whole MiB below 1000, one decimal of GiB to 9.9, whole GiB beyond — never over 4 characters', () => {
    expect(formatMemory(9.4 * MiB)).toBe('9M');
    expect(formatMemory(906 * MiB)).toBe('906M');
    expect(formatMemory(999.4 * MiB)).toBe('999M');
    expect(formatMemory(999.6 * MiB)).toBe('1.0G');
    expect(formatMemory(1004 * MiB)).toBe('1.0G');
    expect(formatMemory(9.94 * 1024 * MiB)).toBe('9.9G');
    expect(formatMemory(9.96 * 1024 * MiB)).toBe('10G');
    expect(formatMemory(123 * 1024 * MiB)).toBe('123G');
    for (const bytes of [0, 1, 999.5 * MiB, 9.95 * 1024 * MiB, 999 * 1024 * MiB]) {
      expect(formatMemory(bytes).length).toBeLessThanOrEqual(4);
    }
  });
});

describe('shouldUpdate', () => {
  test('a first reading always shows', () => {
    expect(shouldUpdate(undefined, 5 * MiB)).toBe(true);
  });

  test('a figure moves once the reading drifts 2% from it, not on every MB', () => {
    expect(shouldUpdate(900 * MiB, 905 * MiB)).toBe(false);
    expect(shouldUpdate(900 * MiB, 919 * MiB)).toBe(true);
    expect(shouldUpdate(900 * MiB, 880 * MiB)).toBe(true);
  });

  test('a drift that would print the same is no change', () => {
    expect(shouldUpdate(4.0 * 1024 * MiB, 4.04 * 1024 * MiB)).toBe(false);
  });
});

describe('/proc parsing', () => {
  test('stat: ppid, pgrp and CPU time, past a comm holding spaces and parentheses', () => {
    const fields = 'S 41 40 40 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 1 0 1000';
    expect(parseProcStat(42, `42 (node (x) y) ${fields}`)).toEqual({
      pid: 42,
      ppid: 41,
      pgid: 40,
      cpuSeconds: 3,
    });
    expect(parseProcStat(42, 'garbage')).toBeNull();
  });

  test('status: RssAnon + VmSwap in bytes; null for a kernel thread', () => {
    const status =
      'Name:\tnode\nVmRSS:\t  9000 kB\nRssAnon:\t  6000 kB\nRssFile:\t 3000 kB\nVmSwap:\t   500 kB\n';
    expect(parseProcStatus(status)).toBe(6500 * 1024);
    expect(parseProcStatus('Name:\tkthreadd\n')).toBeNull();
  });

  test('treeOf: the group, an orphan of it, and a descendant that left it', () => {
    const rows = [
      { pid: 10, ppid: 1, pgid: 10, cpuSeconds: 0 }, // leader
      { pid: 11, ppid: 1, pgid: 10, cpuSeconds: 0 }, // orphan, reparented to init
      { pid: 12, ppid: 11, pgid: 12, cpuSeconds: 0 }, // called setsid
      { pid: 13, ppid: 12, pgid: 12, cpuSeconds: 0 },
      { pid: 20, ppid: 1, pgid: 20, cpuSeconds: 0 }, // another service
    ];
    expect(treeOf([10], rows).sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
    expect(treeOf([99], rows)).toEqual([]);
  });
});

describe('procReader', () => {
  let root: string;
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const writeProc = (pid: number, ppid: number, pgid: number, ticks: number, anonKb: number) => {
    fs.mkdirSync(path.join(root, String(pid)), { recursive: true });
    const stat = `${String(pid)} (node) S ${String(ppid)} ${String(pgid)} 0 0 -1 0 0 0 0 0 ${String(ticks)} 0 0 0`;
    fs.writeFileSync(path.join(root, String(pid), 'stat'), stat);
    fs.writeFileSync(
      path.join(root, String(pid), 'status'),
      `RssAnon:\t${String(anonKb)} kB\nVmSwap:\t0 kB\n`,
    );
  };

  test('sums a service over its tree, and its CPU as a share of a core from the second reading', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-proc-'));
    fs.mkdirSync(path.join(root, 'self'));
    writeProc(10, 1, 10, 100, 1000);
    writeProc(11, 10, 10, 0, 500);
    writeProc(20, 1, 20, 0, 70);
    const reader = procReader(1000, root);
    const groups = new Map([
      ['web', [10]],
      ['api', [20]],
      ['gone', [30]],
    ]);
    const first = reader.read(groups);
    expect(first.get('web')).toEqual({ memory: 1500 * 1024, cpu: null });
    expect(first.get('api')?.memory).toBe(70 * 1024);
    expect(first.has('gone')).toBe(false);

    await new Promise((r) => setTimeout(r, 50));
    writeProc(10, 1, 10, 105, 1000); // +0.05 s of CPU
    const cpu = reader.read(groups).get('web')!.cpu!;
    expect(cpu).toBeGreaterThan(0);
    expect(cpu).toBeLessThanOrEqual(1);
  });
});

/** A libproc over a fixed process table: `pids` is pid → [pgid, ppid, footprint, cpu ticks]. */
function fakeLibproc(pids: Map<number, [number, number, number, number]>): Libproc {
  const write = (buffer: Buffer, list: number[]) => {
    list.forEach((pid, i) => buffer.writeInt32LE(pid, i * 4));
    return list.length;
  };
  return {
    proc_pid_rusage(pid, _flavor, buffer) {
      const p = pids.get(pid);
      if (!p) {
        return -1;
      }
      buffer.writeBigUInt64LE(BigInt(p[3]), 16);
      buffer.writeBigUInt64LE(0n, 24);
      buffer.writeBigUInt64LE(BigInt(p[2]), 72);
      return 0;
    },
    proc_listpgrppids: (pgid, buffer) =>
      write(
        buffer,
        [...pids].filter(([, p]) => p[0] === pgid).map(([pid]) => pid),
      ),
    proc_listchildpids: (ppid, buffer) =>
      write(
        buffer,
        [...pids].filter(([, p]) => p[1] === ppid).map(([pid]) => pid),
      ),
    mach_timebase_info(buffer) {
      buffer.writeUInt32LE(125, 0);
      buffer.writeUInt32LE(3, 4);
      return 0;
    },
  };
}

describe('libprocReader', () => {
  test('walks each group and its descendants, counting a process once', () => {
    const lib = fakeLibproc(
      new Map([
        [10, [10, 1, 100 * MiB, 0]],
        [11, [10, 10, 20 * MiB, 0]],
        [12, [12, 11, 5 * MiB, 0]], // left the group, still a descendant
        [20, [20, 1, 50 * MiB, 0]],
      ]),
    );
    const out = libprocReader(lib).read(
      new Map([
        ['web', [10, 10]], // a group listed twice
        ['api', [20]],
        ['gone', [30]],
      ]),
    );
    expect(out.get('web')?.memory).toBe(125 * MiB);
    expect(out.get('api')?.memory).toBe(50 * MiB);
    expect(out.has('gone')).toBe(false);
  });

  test('CPU time is mach ticks scaled by the timebase', async () => {
    const table = new Map<number, [number, number, number, number]>([[10, [10, 1, MiB, 0]]]);
    const reader = libprocReader(fakeLibproc(table));
    const groups = new Map([['web', [10]]]);
    expect(reader.read(groups).get('web')?.cpu).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    table.set(10, [10, 1, MiB, (0.05 * 1e9 * 3) / 125]); // 0.05 s
    const cpu = reader.read(groups).get('web')!.cpu!;
    expect(cpu).toBeGreaterThan(0.2);
    expect(cpu).toBeLessThan(0.6);
  });
});

describe.runIf(os.platform() === 'darwin')('loadLibproc (macOS)', () => {
  test('reads a live group — members past their exited leader — and prints no ExperimentalWarning', async () => {
    const warn = vi.spyOn(process.stderr, 'write');
    const lib = await loadLibproc();
    expect(lib).not.toBeNull();
    expect(warn.mock.calls.join('')).not.toMatch(/FFI/);

    const sh = spawn('sh', ['-c', 'sleep 30 & sleep 30 & exit 0'], {
      detached: true,
      stdio: 'ignore',
    });
    const pgid = sh.pid!;
    await new Promise((r) => sh.on('exit', r));
    // The group's members, the two sleeps, read while their group is still there to name them,
    // each with its start time: killed after only while each is still that process.
    const members = await Promise.all(
      execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter(([pid, group]) => group === pgid && pid! > 0)
        .map(async ([pid]) => ({ pid: pid!, startedAt: await processStartTime(pid!) })),
    );
    try {
      const out = libprocReader(lib!).read(new Map([['sleepers', [pgid]]]));
      const usage: ServiceUsage | undefined = out.get('sleepers');
      expect(usage?.memory).toBeGreaterThan(0);
    } finally {
      for (const { pid, startedAt } of members) {
        if (startedAt !== null && (await processStartTime(pid)) === startedAt) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }
    }
  });
});

test.runIf(os.platform() !== 'darwin')('loadLibproc: null off macOS', async () => {
  expect(await loadLibproc()).toBeNull();
});

describe('UsageSampler', () => {
  const readerOf = (readings: Map<string, number>[]): UsageReader => ({
    interval: 60_000,
    read: () =>
      new Map(
        [...(readings.shift() ?? new Map())].map(([n, memory]) => [n, { memory, cpu: null }]),
      ),
  });

  test('tells subscribers only when a figure on screen changes, and drops a service that stopped', () => {
    const sampler = new UsageSampler(
      readerOf([
        new Map([['web', 900 * MiB]]),
        new Map([['web', 905 * MiB]]),
        new Map([['web', 950 * MiB]]),
        new Map(),
      ]),
      () => new Map([['web', [10]]]),
    );
    const listener = vi.fn();
    sampler.subscribe(listener);
    sampler.refresh();
    expect(sampler.memoryBytes('web')).toBe(900 * MiB);
    sampler.refresh();
    expect(sampler.memoryBytes('web')).toBe(900 * MiB);
    expect(listener).toHaveBeenCalledTimes(1);
    sampler.refresh();
    expect(sampler.memoryBytes('web')).toBe(950 * MiB);
    sampler.refresh();
    expect(sampler.memoryBytes('web')).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(3);
    sampler.dispose();
  });

  test('infra memory is kept apart from the services, a name in both included', async () => {
    const sampler = new UsageSampler(readerOf([new Map([['db', 10 * MiB]])]), () => new Map(), {
      interval: 60_000,
      read: () => Promise.resolve(new Map([['db', 52 * MiB]])),
    });
    sampler.refresh();
    await sampler.refreshInfra();
    expect(sampler.memoryBytes('db')).toBe(10 * MiB);
    expect(sampler.infraMemoryBytes('db')).toBe(52 * MiB);
    sampler.dispose();
  });

  test('a reading that fails leaves the last figures up', async () => {
    let fail = false;
    const sampler = new UsageSampler(
      {
        interval: 60_000,
        read: () => {
          if (fail) {
            throw new Error('boom');
          }
          return new Map([['web', { memory: 9 * MiB, cpu: null }]]);
        },
      },
      () => new Map(),
      { interval: 60_000, read: () => Promise.reject(new Error('no docker')) },
    );
    sampler.refresh();
    fail = true;
    sampler.refresh();
    await sampler.refreshInfra();
    expect(sampler.memoryBytes('web')).toBe(9 * MiB);
    sampler.dispose();
  });
});
