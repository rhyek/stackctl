import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// What can be told about a process from outside it, with nothing a light command can't load.

const execFileAsync = promisify(execFile);

export function parseLsofCwd(out: string): string | null {
  const line = out.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

/** `true` when `target` is `root` itself or sits underneath it. */
export function isInsideWorkspace(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * `realpath`, falling back to the path as given when it can't be resolved (already gone, or not
 * ours to read). Every cwd comparison below goes through this: the kernel reports a process's cwd
 * fully resolved (`/proc/<pid>/cwd`, `lsof -d cwd`), while the paths stackctl derives from its own
 * config keep whatever symlinks the user typed — so `~/dev` and `/Volumes/Data/dev` are the same
 * directory that never compares equal.
 */
export function resolveRealPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** `true` while `pid` still exists. `EPERM` means it's alive but not ours to signal. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Working directory of a live process, or null if it's gone / can't be inspected. */
export async function processCwd(pid: number): Promise<string | null> {
  if (os.platform() === 'linux') {
    try {
      return await fs.promises.readlink(`/proc/${String(pid)}/cwd`);
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    return parseLsofCwd(stdout);
  } catch {
    return null; // gone, not ours to inspect, or no lsof
  }
}

/**
 * `true` while `pid` exists and this process may signal it. `EPERM` reads as `false`: the number
 * belongs to another user's process now, never a session of this user's.
 */
export function canSignal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A process's start time from `ps -o lstart=` run in UTC and the C locale (`Sat Nov  7 20:35:35
 * 2026`), in ms since the epoch; `null` for anything else.
 */
export function parseLstart(out: string): number | null {
  const match = /^\w{3} +(\w{3}) +(\d{1,2}) +(\d{2}):(\d{2}):(\d{2}) +(\d{4})$/.exec(out.trim());
  const month = match ? MONTHS.indexOf(match[1]!) : -1;
  if (!match || month === -1) {
    return null;
  }
  const [, , day, hours, minutes, seconds, year] = match.map(Number);
  return Date.UTC(year!, month, day, hours, minutes, seconds);
}

/**
 * When a live process started, in ms since the epoch, to the second (rounded down); `null` when
 * it's gone or can't be told. From `ps -o lstart=`, which macOS and Linux both have, read in UTC
 * so no local-time ambiguity (a DST change) gets into it.
 */
export async function processStartTime(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' },
    });
    return parseLstart(stdout);
  } catch {
    return null; // gone, or no ps
  }
}
