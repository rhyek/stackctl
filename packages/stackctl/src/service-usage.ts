import fs from 'node:fs';
import os from 'node:os';
import { callEach } from './util.js';

// How much memory and CPU each service uses — the memory shown in the footer. On macOS the memory is
// what Activity Monitor shows; on Linux its nearest equivalent. Each is summed over everything a
// service runs.
//
// A service is a set of process groups: every service command, build and one-off command is spawned
// detached, so its pid is also its group id (see `Supervisor.groups`). A group's
// processes are its members — which outlive the leader: an orphaned `esbuild`, a `node` a wrapper
// script left behind — plus their descendants, which catches a child that called `setsid`.
//
// - macOS: libproc through `node:ffi`. `proc_listpgrppids` and `proc_listchildpids` walk the tree,
//   `proc_pid_rusage` reads `ri_phys_footprint` and the CPU times — a few µs per process, so every
//   second. (`ps` RSS leaves out compressed pages, most of a long-running dev server's memory: 49 MB
//   against a 904 MB footprint, measured on a Vite server. `/usr/bin/footprint` reads the right figure
//   but walks every memory region, ~25 ms of CPU for one such server.)
// - Linux: `/proc/<pid>/stat` for the tree and the CPU times, `RssAnon + VmSwap` from
//   `/proc/<pid>/status`: private memory, resident or swapped out (zram included) and, like a
//   footprint, no clean file pages. `smaps_rollup` would be ~300× the cost.

/** Each service's process groups, by service name. */
export type ServiceGroups = ReadonlyMap<string, readonly number[]>;

export interface ServiceUsage {
  /** Bytes, summed over the service's processes. */
  memory: number;
  /**
   * CPU used since the previous reading, as a share of one core (`1.5` is a core and a half); null on
   * the first reading, which only sets the baseline.
   */
  cpu: number | null;
}

export interface UsageReader {
  /** How often to read, in ms. */
  readonly interval: number;
  /** Usage per service. A service with no live process is left out. */
  read(groups: ServiceGroups): Map<string, ServiceUsage>;
}

/** One process as a reader sees it: its footprint and its CPU time so far, in seconds. */
interface ProcessUsage {
  memory: number;
  cpuSeconds: number;
}

/**
 * Sums each service's processes, and turns their CPU time into a share of a core since the last call.
 * The CPU is counted per process: one that exited took its time with it, and one that's new since the
 * last call counts all of its time, having started since.
 */
class UsageAccumulator {
  private previous: Map<number, number> | null = null;
  private previousAt = 0;

  sum(
    groups: ServiceGroups,
    pidsOf: (pgids: readonly number[]) => Iterable<number>,
    usageOf: (pid: number) => ProcessUsage | null,
  ): Map<string, ServiceUsage> {
    const now = performance.now();
    const elapsed = (now - this.previousAt) / 1000;
    const seen = new Map<number, number>();
    const out = new Map<string, ServiceUsage>();
    for (const [name, pgids] of groups) {
      let memory = 0;
      let cpuSeconds = 0;
      let live = false;
      for (const pid of pidsOf(pgids)) {
        const usage = seen.has(pid) ? null : usageOf(pid);
        if (!usage) {
          continue; // exited, not ours, or already counted under another group
        }
        live = true;
        memory += usage.memory;
        seen.set(pid, usage.cpuSeconds);
        cpuSeconds += Math.max(0, usage.cpuSeconds - (this.previous?.get(pid) ?? 0));
      }
      if (live) {
        out.set(name, {
          memory,
          cpu: this.previous && elapsed > 0 ? cpuSeconds / elapsed : null,
        });
      }
    }
    this.previous = seen;
    this.previousAt = now;
    return out;
  }
}

// ---------------------------------------------------------------------------
// macOS through node:ffi
// ---------------------------------------------------------------------------

/** `RUSAGE_INFO_V0` and its layout (`sys/resource.h`): a 16-byte uuid, then `uint64_t`s. */
const RUSAGE_INFO_V0 = 0;
const RUSAGE_INFO_V0_SIZE = 96;
const USER_TIME_OFFSET = 16;
const SYSTEM_TIME_OFFSET = 24;
const PHYS_FOOTPRINT_OFFSET = 72;
/** Room for this many pids in one `proc_list*pids` call; a group or a child list is far smaller. */
const PID_CAPACITY = 4096;

export interface Libproc {
  proc_pid_rusage(pid: number, flavor: number, buffer: Buffer): number;
  proc_listpgrppids(pgid: number, buffer: Buffer, size: number): number;
  proc_listchildpids(ppid: number, buffer: Buffer, size: number): number;
  mach_timebase_info(buffer: Buffer): number;
}

/**
 * libproc through `node:ffi`, or null where it isn't there to use: not macOS, an FFI turned off
 * (`--no-experimental-ffi`) or restricted (the permission model without `--allow-ffi`), or calls
 * that don't answer as they should. The module's one-time
 * ExperimentalWarning is kept off the screen: printed under the fullscreen TUI, it would garble it.
 */
export async function loadLibproc(): Promise<Libproc | null> {
  if (os.platform() !== 'darwin') {
    return null;
  }
  // Kept only to put back as it was; it's called through the bound copy below.
  // oxlint-disable-next-line typescript/unbound-method
  const original = process.emitWarning;
  const emitWarning = original.bind(process);
  let ffi: typeof import('node:ffi');
  try {
    process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
      const message = typeof warning === 'string' ? warning : warning.message;
      if (!/\bFFI\b/.test(message)) {
        (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
      }
    } as typeof process.emitWarning;
    ffi = await import('node:ffi');
  } catch {
    return null;
  } finally {
    process.emitWarning = original;
  }
  try {
    const { functions } = ffi.dlopen('/usr/lib/libSystem.B.dylib', {
      proc_pid_rusage: { arguments: ['int32', 'int32', 'pointer'], return: 'int32' },
      proc_listpgrppids: { arguments: ['int32', 'pointer', 'int32'], return: 'int32' },
      proc_listchildpids: { arguments: ['int32', 'pointer', 'int32'], return: 'int32' },
      mach_timebase_info: { arguments: ['pointer'], return: 'int32' },
    });
    const lib = functions as unknown as Libproc;
    // Trusted only once it reads this process's own footprint.
    const buffer = Buffer.alloc(RUSAGE_INFO_V0_SIZE);
    if (lib.proc_pid_rusage(process.pid, RUSAGE_INFO_V0, buffer) !== 0) {
      return null;
    }
    return buffer.readBigUInt64LE(PHYS_FOOTPRINT_OFFSET) > 0n ? lib : null;
  } catch {
    return null;
  }
}

export function libprocReader(lib: Libproc, interval = 1000): UsageReader {
  const pids = Buffer.alloc(PID_CAPACITY * 4);
  const usage = Buffer.alloc(RUSAGE_INFO_V0_SIZE);
  // `ri_user_time` and `ri_system_time` are mach ticks, not ns: 125/3 ns each on Apple silicon.
  const timebase = Buffer.alloc(8);
  lib.mach_timebase_info(timebase);
  const secondsPerTick = timebase.readUInt32LE(0) / timebase.readUInt32LE(4) / 1e9;
  const list = (fn: 'proc_listpgrppids' | 'proc_listchildpids', id: number): number[] => {
    const n = Math.min(Math.max(lib[fn](id, pids, pids.length), 0), PID_CAPACITY);
    // Copied out of the shared buffer before the next call fills it again.
    return Array.from({ length: n }, (_, i) => pids.readInt32LE(i * 4)).filter((pid) => pid > 0);
  };
  // Each pid once: the groups' members, then, depth first, the children of each.
  const tree = function* (pgids: readonly number[]): Iterable<number> {
    const visited = new Set<number>();
    const pending = pgids.flatMap((pgid) => list('proc_listpgrppids', pgid));
    for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
      if (visited.has(pid)) {
        continue;
      }
      visited.add(pid);
      yield pid;
      pending.push(...list('proc_listchildpids', pid));
    }
  };
  const usageOf = (pid: number): ProcessUsage | null => {
    if (lib.proc_pid_rusage(pid, RUSAGE_INFO_V0, usage) !== 0) {
      return null;
    }
    const ticks =
      usage.readBigUInt64LE(USER_TIME_OFFSET) + usage.readBigUInt64LE(SYSTEM_TIME_OFFSET);
    return {
      memory: Number(usage.readBigUInt64LE(PHYS_FOOTPRINT_OFFSET)),
      cpuSeconds: Number(ticks) * secondsPerTick,
    };
  };
  const accumulator = new UsageAccumulator();
  return { interval, read: (groups) => accumulator.sum(groups, tree, usageOf) };
}

// ---------------------------------------------------------------------------
// Linux through /proc
// ---------------------------------------------------------------------------

/**
 * Clock ticks per second in `/proc/<pid>/stat` (`USER_HZ`, what `sysconf(_SC_CLK_TCK)` returns): 100
 * on every architecture Linux runs Node on, and Node has no `sysconf` to ask.
 */
const CLOCK_TICKS = 100;

export interface ProcStat {
  pid: number;
  ppid: number;
  pgid: number;
  cpuSeconds: number;
}

/** `/proc/<pid>/stat`: the fields after `comm`, which is in parentheses and may hold anything. */
export function parseProcStat(pid: number, text: string): ProcStat | null {
  const close = text.lastIndexOf(')');
  if (close < 0) {
    return null;
  }
  // From field 3 on: state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime
  const fields = text.slice(close + 2).split(' ');
  const [ppid, pgid, utime, stime] = [fields[1], fields[2], fields[11], fields[12]].map(Number);
  if ([ppid, pgid, utime, stime].some((n) => n === undefined || Number.isNaN(n))) {
    return null;
  }
  return { pid, ppid: ppid!, pgid: pgid!, cpuSeconds: (utime! + stime!) / CLOCK_TICKS };
}

/** `RssAnon + VmSwap` from `/proc/<pid>/status`, in bytes; null without them (a kernel thread). */
export function parseProcStatus(text: string): number | null {
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const anon = kb('RssAnon');
  return anon === null ? null : (anon + (kb('VmSwap') ?? 0)) * 1024;
}

/** Every pid in the groups `pgids`, and every descendant of one. */
export function treeOf(pgids: readonly number[], rows: readonly ProcStat[]): number[] {
  const children = new Map<number, number[]>();
  for (const r of rows) {
    const list = children.get(r.ppid);
    if (list) {
      list.push(r.pid);
    } else {
      children.set(r.ppid, [r.pid]);
    }
  }
  const wanted = new Set(pgids);
  const found = new Set<number>();
  const stack = rows.filter((r) => wanted.has(r.pgid)).map((r) => r.pid);
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    if (!found.has(pid)) {
      found.add(pid);
      stack.push(...(children.get(pid) ?? []));
    }
  }
  return [...found];
}

function readProc(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null; // exited
  }
}

export function procReader(interval = 1000, root = '/proc'): UsageReader {
  const accumulator = new UsageAccumulator();
  return {
    interval,
    read(groups) {
      const rows = new Map<number, ProcStat>();
      for (const entry of fs.readdirSync(root)) {
        const pid = Number(entry);
        if (Number.isInteger(pid) && pid > 0) {
          const stat = readProc(`${root}/${entry}/stat`);
          const row = stat === null ? null : parseProcStat(pid, stat);
          if (row) {
            rows.set(pid, row);
          }
        }
      }
      const table = [...rows.values()];
      return accumulator.sum(
        groups,
        (pgids) => treeOf(pgids, table),
        (pid) => {
          const status = readProc(`${root}/${String(pid)}/status`);
          const memory = status === null ? null : parseProcStatus(status);
          return memory === null ? null : { memory, cpuSeconds: rows.get(pid)!.cpuSeconds };
        },
      );
    },
  };
}

/** The reader for this machine, or null on anything but macOS and Linux. */
export async function createUsageReader(): Promise<UsageReader | null> {
  switch (os.platform()) {
    case 'darwin': {
      const lib = await loadLibproc();
      return lib ? libprocReader(lib) : null;
    }
    case 'linux':
      return procReader();
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Binary units, as Activity Monitor counts them (its "MB" is MiB), in at most four characters:
 * `9M`, `906M`, `1.0G`, `9.9G`, `12G`.
 */
export function formatMemory(bytes: number): string {
  const mib = bytes / 2 ** 20;
  if (Math.round(mib) < 1000) {
    return `${String(Math.round(mib))}M`;
  }
  const gib = mib / 1024;
  return gib < 9.95 ? `${gib.toFixed(1)}G` : `${String(Math.round(gib))}G`;
}

/**
 * A figure on screen moves only once the reading has drifted 2% from it: a busy dev server's footprint
 * changes by a few MB every second, and each change is a repaint.
 */
const MIN_CHANGE = 0.02;

export function shouldUpdate(shown: number | undefined, next: number): boolean {
  if (shown === undefined) {
    return true;
  }
  return Math.abs(next - shown) >= shown * MIN_CHANGE && formatMemory(next) !== formatMemory(shown);
}

export interface InfraMemorySource {
  /** How often to read, in ms. */
  readonly interval: number;
  /** Bytes per infra service; one that isn't running is left out. */
  read(): Promise<Map<string, number>>;
}

/**
 * Samples every service's usage on its reader's interval, and the infra services' memory on theirs,
 * and tells subscribers when a figure on screen changes. Reads never overlap: a tick that finds the
 * last one still running is skipped. Lives only as long as a screen shows it.
 */
export class UsageSampler {
  /** Memory as shown, which lags the reading by up to {@link MIN_CHANGE}. */
  private readonly shown = new Map<string, number>();
  private readonly shownInfra = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readingInfra = false;
  private disposed = false;

  private readonly reader: UsageReader;
  private readonly groups: () => ServiceGroups;
  private readonly infra: InfraMemorySource | null;

  constructor(
    reader: UsageReader,
    groups: () => ServiceGroups,
    infra: InfraMemorySource | null = null,
  ) {
    this.reader = reader;
    this.groups = groups;
    this.infra = infra;
  }

  start(): void {
    this.timers.push(setInterval(() => this.refresh(), this.reader.interval));
    if (this.infra) {
      this.timers.push(setInterval(() => void this.refreshInfra(), this.infra.interval));
    }
    for (const timer of this.timers) {
      timer.unref();
    }
    this.refresh();
    void this.refreshInfra();
  }

  /** Reads the services now. */
  refresh(): void {
    if (this.disposed) {
      return;
    }
    let reading: Map<string, ServiceUsage>;
    try {
      reading = this.reader.read(this.groups());
    } catch {
      return; // a failed reading leaves the last figures up
    }
    this.apply(this.shown, new Map([...reading].map(([name, u]) => [name, u.memory])));
  }

  async refreshInfra(): Promise<void> {
    if (!this.infra || this.readingInfra || this.disposed) {
      return;
    }
    this.readingInfra = true;
    try {
      this.apply(this.shownInfra, await this.infra.read());
    } catch {
      /* as above */
    } finally {
      this.readingInfra = false;
    }
  }

  private apply(shown: Map<string, number>, next: Map<string, number>): void {
    if (this.disposed) {
      return;
    }
    let changed = false;
    for (const name of shown.keys()) {
      if (!next.has(name)) {
        shown.delete(name);
        changed = true;
      }
    }
    for (const [name, bytes] of next) {
      if (shouldUpdate(shown.get(name), bytes)) {
        shown.set(name, bytes);
        changed = true;
      }
    }
    if (changed) {
      callEach(this.listeners, undefined);
    }
  }

  /**
   * A service's memory as shown, in bytes; undefined before its first reading and while it isn't
   * running.
   */
  memoryBytes(name: string): number | undefined {
    return this.shown.get(name);
  }

  /** An infra service's memory as shown, in bytes; undefined before its first reading. */
  infraMemoryBytes(name: string): number | undefined {
    return this.shownInfra.get(name);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.listeners.clear();
  }
}
