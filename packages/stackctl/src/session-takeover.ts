import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { getRegisteredPackages, getWorkspaceDir } from './config.js';
import { createControlClient, probeInstance } from './control-client.js';
import { currentMode } from './env-base.js';
import {
  canSignal,
  isInsideWorkspace,
  isProcessAlive,
  processCwd,
  processStartTime,
  resolveRealPath,
} from './process-info.js';
import {
  type ChildRecord,
  type RunningState,
  decideControlPort,
  isPortListening,
  readOtherModesRunning,
  readRunning,
  sessionId,
} from './running.js';
import { pruneSessions } from './session-files.js';
import { START_TIME_SLACK_MS } from './session-identity.js';
import { HANDOFF_FORCE_KILL_MS } from './shutdown-timing.js';
import { bounded } from './util.js';

// Taking over from this mode's previous session: the control port and the record, the orphans a
// killed session left, and whatever in the workspace still holds a dev port. Also how a running
// session is ended: asked to quit (or sent SIGTERM), waited for, and its process tree killed if
// it outlives the deadline.
//
// What each part guarantees itself: no kill ever signals this process or walks into its
// descendants. The sweep and the port freeing never touch a live other-mode session's process,
// its group or a group it recorded, neither as a process they pick nor in the trees they kill;
// the port freeing never picks a process outside the workspace or in this process's group. The
// tree kill and the two ways of ending a session do no workspace check of their own: they act on
// the pids their callers give them.

const run = promisify(execFile);

/** How a session asked to end did. */
export type QuitOutcome = 'stopped' | 'force-killed' | 'still-running';

/** How a session is ended: the time it has, and what kills it when the time runs out. */
export interface QuitOptions {
  /** From when it is asked; {@link HANDOFF_FORCE_KILL_MS} unless given. */
  forceKillAfterMs?: number;
  /** Kills `pid`'s process tree; the tree kill (a plain SIGKILL on Windows) unless given. */
  killTree?: (pid: number) => Promise<void>;
}

/** How often a wait for a pid to go checks. */
const POLL_MS = 100;
/** How long a pid has to go after its tree was killed. */
const AFTER_KILL_MS = 2000;

const isWindows = () => process.platform === 'win32';

/** A pid that may be acted on: a positive integer, and not this process. */
const actionable = (pid: number) => Number.isInteger(pid) && pid > 0 && pid !== process.pid;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Waits until `pid` is gone (no longer signalable by this user) or `deadline`; whether it went. */
async function goneBy(pid: number, deadline: number): Promise<boolean> {
  for (;;) {
    if (!canSignal(pid)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(Math.min(POLL_MS, deadline - Date.now()));
  }
}

/** How long `lsof`, `ss` or `ps` may run before it counts as failed (`lsof` can hang on a mount). */
const COMMAND_TIMEOUT_MS = 5000;

/**
 * Runs a command; its stdout, also when it exits non-zero; empty when it can't run or takes
 * longer than {@link COMMAND_TIMEOUT_MS}.
 */
async function stdoutOf(file: string, args: string[]): Promise<string> {
  try {
    return (await run(file, args, { timeout: COMMAND_TIMEOUT_MS })).stdout;
  } catch (err) {
    // `lsof` exits 1 when any one of several selections matched nothing, still listing the rest.
    const { stdout, killed } = err as { stdout?: unknown; killed?: boolean };
    return !killed && typeof stdout === 'string' ? stdout : '';
  }
}

// ---- What the commands print -------------------------------------------------------------------

/** `lsof -t` output, one pid per line; a line that isn't a positive integer is skipped. */
export function pidsFromLsof(out: string): number[] {
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number)
    .filter((pid) => pid > 0);
}

/** `ss -p` output: every `pid=<n>` in it, `pid=0` dropped. */
export function pidsFromSs(out: string): number[] {
  return [...out.matchAll(/\bpid=(\d+)/g)].map((m) => Number(m[1])).filter((pid) => pid > 0);
}

/** A `ps -Ao pid=,<other>=` line: the pid and the other column (its parent, or its group). */
export interface PidPair {
  pid: number;
  other: number;
}

/** `ps -Ao pid=,ppid=` or `ps -Ao pid=,pgid=` output; a line without two integers is skipped. */
export function parsePidPairs(out: string): PidPair[] {
  const pairs: PidPair[] = [];
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) {
      pairs.push({ pid: Number(match[1]), other: Number(match[2]) });
    }
  }
  return pairs;
}

/**
 * `roots` and every descendant of each, by parent pid, from `ps -Ao pid=,ppid=` pairs. The walk
 * never takes a pid `spared` says to spare (this process, unless given), nor goes below it.
 */
export function treeOf(
  roots: number[],
  parents: PidPair[],
  spared: (pid: number) => boolean = (pid) => pid === process.pid,
): number[] {
  const children = new Map<number, number[]>();
  for (const { pid, other } of parents) {
    children.set(other, [...(children.get(other) ?? []), pid]);
  }
  const found = new Set<number>();
  const queue = [...roots];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    if (!spared(pid) && !found.has(pid)) {
      found.add(pid);
      queue.push(...(children.get(pid) ?? []));
    }
  }
  return [...found];
}

/** Each process group's live members, from `ps -Ao pid=,pgid=` pairs. */
export function groupMembers(groups: PidPair[]): Map<number, number[]> {
  const members = new Map<number, number[]>();
  for (const { pid, other } of groups) {
    members.set(other, [...(members.get(other) ?? []), pid]);
  }
  return members;
}

/** The services' dev ports, deduplicated; a service without one (or with a non-number) adds none. */
export function devPorts(ports: ReadonlyArray<number | undefined>): number[] {
  return [...new Set(ports.filter((p): p is number => typeof p === 'number' && !Number.isNaN(p)))];
}

/** What live sessions of this workspace's other modes hold, by mode: their own pids, and groups. */
export interface OtherModes {
  /** Each session's own pid. */
  pids: ReadonlyMap<number, string>;
  /** The groups each recorded as its children, and each session's own group. */
  groups: ReadonlyMap<number, string>;
}

const NO_OTHER_MODES: OtherModes = { pids: new Map(), groups: new Map() };

/**
 * The recorded groups the sweep may take, with their live members: a positive pid that isn't
 * this process's, with a member still running, without this process among them, and not a group
 * (or holding a process) of a live other-mode session. Whether a member is still in the recorded
 * directory is checked after.
 */
export function sweepableGroups(
  children: readonly ChildRecord[],
  groups: PidPair[],
  self: number = process.pid,
  others: OtherModes = NO_OTHER_MODES,
): Array<{ child: ChildRecord; members: number[] }> {
  const members = groupMembers(groups);
  return children.flatMap((child) => {
    const live = members.get(child.pid) ?? [];
    const ok =
      Number.isInteger(child.pid) &&
      child.pid > 0 &&
      child.pid !== self &&
      !others.groups.has(child.pid) &&
      !live.some((pid) => pid === self || others.pids.has(pid));
    return ok && live.length > 0 ? [{ child, members: live }] : [];
  });
}

/** A process listening on a dev port, as port freeing sees it. */
export interface PortHolder {
  pid: number;
  /** Its working directory, real path; `null` when it can't be read. */
  cwd: string | null;
  /** Its process group; `undefined` when it isn't in the table (it exited meanwhile). */
  group: number | undefined;
}

/**
 * Which dev-port holders port freeing kills, and the line for each it leaves: one in the
 * workspace at `root` (a real path) is killed unless it, or its group, is a live other-mode
 * session's, or it is in `ownGroup`, which is left without a word. One outside the workspace, or
 * whose directory can't be read, is another program's.
 */
export function sortHolders(
  holders: readonly PortHolder[],
  ctx: { root: string; ownGroup: number; others: OtherModes },
): { kill: number[]; messages: string[] } {
  const kill: number[] = [];
  const otherMode: string[] = [];
  const foreign: string[] = [];
  for (const { pid, cwd, group } of holders) {
    const inside = cwd !== null && isInsideWorkspace(ctx.root, cwd);
    // The session itself, wherever it runs; a group it holds, in the workspace.
    const mode =
      ctx.others.pids.get(pid) ??
      (inside && group !== undefined ? ctx.others.groups.get(group) : undefined);
    if (mode !== undefined) {
      otherMode.push(`dev port held by this project's ${mode} session (pid ${String(pid)}) — leaving it alone`); // oxfmt-ignore
    } else if (!inside) {
      foreign.push(`dev port held by another program (pid ${String(pid)}) — leaving it alone`);
    } else if (group !== ctx.ownGroup) {
      kill.push(pid);
    }
  }
  return { kill, messages: [...otherMode, ...foreign] };
}

// ---- Killing -----------------------------------------------------------------------------------

const processTable = async (column: 'ppid' | 'pgid') =>
  parsePidPairs(await stdoutOf('ps', ['-Ao', `pid=,${column}=`]));

/** What the live sessions of the workspace's modes other than `mode` hold; see {@link OtherModes}. */
function liveOtherModes(
  root: string,
  mode: string,
  groupOf: ReadonlyMap<number, number>,
): OtherModes {
  const pids = new Map<number, string>();
  const groups = new Map<number, string>();
  for (const [other, state] of readOtherModesRunning(root, mode)) {
    if (!isProcessAlive(state.pid)) {
      continue;
    }
    pids.set(state.pid, other);
    const own = groupOf.get(state.pid);
    if (own !== undefined) {
      groups.set(own, other);
    }
    for (const child of state.children ?? []) {
      groups.set(child.pid, other);
    }
  }
  return { pids, groups };
}

/**
 * SIGKILLs `roots` and every descendant of each, never this process nor anything below it, nor a
 * pid `spared` says to spare, nor anything below that; resolves with the pids signalled. One
 * already gone is skipped. It checks nothing else: the callers choose the roots.
 */
export async function killProcessTrees(
  roots: number[],
  spared: (pid: number) => boolean = () => false,
): Promise<number[]> {
  if (roots.length === 0) {
    return [];
  }
  const killed: number[] = [];
  const walk = treeOf(roots, await processTable('ppid'), (pid) => pid === process.pid || spared(pid)); // oxfmt-ignore
  for (const pid of walk) {
    if (!actionable(pid)) {
      continue;
    }
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      /* gone already */
    }
  }
  return killed;
}

const defaultKillTree = async (pid: number) => {
  if (!isWindows()) {
    await killProcessTrees([pid]);
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone already */
  }
};

/**
 * Whether a pid read to start at `started` when its session was asked to end, and at `now` since,
 * is a new process that was given the number: it started later than the slack `ps`'s whole
 * seconds (and a shifting boot time) allow. Unknown either time, it is taken for the session.
 */
export function startedSince(started: number | null, now: number | null): boolean {
  return started !== null && now !== null && now > started + START_TIME_SLACK_MS;
}

/** A tree walk's spare test for what live other-mode sessions hold, by `groupOf`. */
const othersSpared =
  (others: OtherModes, groupOf: ReadonlyMap<number, number>) =>
  (pid: number): boolean => {
    const group = groupOf.get(pid);
    return others.pids.has(pid) || (group !== undefined && others.groups.has(group));
  };

/**
 * The wait after a session was asked to end: gone by the deadline, or its tree killed. `started`
 * is its start time when it was asked: a pid that started at another time since is a new process
 * that was given the number, and the session counts as gone.
 */
async function settle(
  pid: number,
  started: number | null,
  deadline: number,
  opts: QuitOptions,
): Promise<QuitOutcome> {
  if (await goneBy(pid, deadline)) {
    return 'stopped';
  }
  if (startedSince(started, await processStartTime(pid))) {
    return 'stopped';
  }
  await (opts.killTree ?? defaultKillTree)(pid);
  return (await goneBy(pid, Date.now() + AFTER_KILL_MS)) ? 'force-killed' : 'still-running';
}

/**
 * Ends the session with control port `port` and pid `pid`: asks it to quit (`POST
 * /command/quit`, which answers once its services are down), waits for its pid to go, and kills
 * its process tree if it is still there `forceKillAfterMs` after it was asked. A pid that isn't a
 * positive integer, or is this process's own, is never asked or signalled: `still-running`.
 */
export async function quitSession(
  port: number,
  pid: number,
  opts: QuitOptions = {},
): Promise<QuitOutcome> {
  if (!actionable(pid)) {
    return 'still-running';
  }
  const deadline = Date.now() + (opts.forceKillAfterMs ?? HANDOFF_FORCE_KILL_MS);
  const started = await processStartTime(pid);
  // Whether, and how, it answers doesn't matter: only whether its pid goes.
  await bounded(createControlClient(port).command.quit(), deadline - Date.now());
  return settle(pid, started, deadline, opts);
}

/**
 * {@link quitSession} for a session whose control API doesn't answer as itself: sent SIGTERM
 * instead of the quit, on which a session ends as it does on a quit.
 */
export async function terminateSession(pid: number, opts: QuitOptions = {}): Promise<QuitOutcome> {
  if (!actionable(pid)) {
    return 'still-running';
  }
  const deadline = Date.now() + (opts.forceKillAfterMs ?? HANDOFF_FORCE_KILL_MS);
  const started = await processStartTime(pid);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* the wait sees it gone */
  }
  return settle(pid, started, deadline, opts);
}

// ---- Sweeping and freeing ----------------------------------------------------------------------

/**
 * Kills what `record`, a previous session of `mode` in the workspace at `root`, names that is
 * still running: each recorded process group with a member in or below its recorded directory.
 * Nothing while the recording session is alive (its children are then a live session's); never a
 * group this process is in, nor one a live session of another mode recorded or holds. Resolves
 * with the pids killed. On Windows there is no `ps`: the table is empty, and nothing is swept.
 */
export async function sweepOrphans(
  root: string,
  mode: string,
  record: RunningState | null,
  onStatus: (message: string) => void = () => {},
): Promise<number[]> {
  const children = record?.children ?? [];
  if (!record || children.length === 0 || isProcessAlive(record.pid)) {
    return [];
  }
  const table = await processTable('pgid');
  const groupOf = new Map(table.map(({ pid, other }) => [pid, other]));
  const others = liveOtherModes(root, mode, groupOf);
  const doomed = new Set<number>();
  for (const { child, members } of sweepableGroups(children, table, process.pid, others)) {
    const dir = resolveRealPath(child.cwd);
    const cwds = await Promise.all(members.map(processCwd));
    if (cwds.some((cwd) => cwd !== null && isInsideWorkspace(dir, resolveRealPath(cwd)))) {
      members.forEach((pid) => doomed.add(pid));
    }
  }
  if (doomed.size === 0) {
    return [];
  }
  onStatus(`cleaning up ${String(doomed.size)} orphaned process(es) from a previous session`);
  return killProcessTrees([...doomed], othersSpared(others, groupOf));
}

/** The pids listening on any of `ports`; none when the command fails or doesn't exist. */
async function listeningPids(ports: number[]): Promise<number[]> {
  if (ports.length === 0) {
    return [];
  }
  if (process.platform === 'darwin') {
    const selections = ports.flatMap((p) => ['-i', `:${String(p)}`]);
    return [...new Set(pidsFromLsof(await stdoutOf('lsof', ['-t', '-sTCP:LISTEN', ...selections])))]; // oxfmt-ignore
  }
  const outputs = await Promise.all(
    ports.map((p) => stdoutOf('ss', ['-tlnpH', `sport = :${String(p)}`])),
  );
  return [...new Set(outputs.flatMap(pidsFromSs))];
}

/**
 * Frees `ports`: kills the process tree of each listener whose working directory is in the
 * workspace at `root` (see {@link sortHolders}), saying which it leaves for another mode's session
 * or another program. When the process groups can't be read, it kills nothing and says so.
 */
export async function freeDevPorts(opts: {
  root: string;
  mode: string;
  ports: number[];
  onStatus: (message: string) => void;
}): Promise<void> {
  opts.onStatus('freeing dev ports');
  const pids = (await listeningPids(opts.ports)).filter(actionable);
  if (pids.length === 0) {
    return;
  }
  const groupOf = new Map((await processTable('pgid')).map(({ pid, other }) => [pid, other]));
  // A table that read lists this process: without it, another mode's holders can't be told.
  const ownGroup = groupOf.get(process.pid);
  if (ownGroup === undefined) {
    opts.onStatus("couldn't read process groups — leaving dev ports alone");
    return;
  }
  const holders = await Promise.all(
    pids.map(async (pid) => {
      const cwd = await processCwd(pid);
      return { pid, cwd: cwd === null ? null : resolveRealPath(cwd), group: groupOf.get(pid) };
    }),
  );
  const others = liveOtherModes(opts.root, opts.mode, groupOf);
  const { kill, messages } = sortHolders(holders, { root: resolveRealPath(opts.root), ownGroup, others }); // oxfmt-ignore
  for (const message of messages) {
    opts.onStatus(message);
  }
  await killProcessTrees(kill, othersSpared(others, groupOf));
}

// ---- Acquisition -------------------------------------------------------------------------------

/**
 * Takes over as this mode's session of the loaded config's workspace: decides the control port
 * and writes the session record (quitting this mode's running session on it), sweeps the
 * previous session's orphans, and frees the services' dev ports (neither on Windows). Resolves
 * with the control port. `onStatus` hears each step worth telling.
 */
export async function acquireSession(opts: {
  configPath: string;
  apiPortOverride?: number;
  logFile: string;
  onStatus: (message: string) => void;
}): Promise<number> {
  const root = getWorkspaceDir();
  const mode = currentMode();
  // Read before the port decision rewrites the record, dropping its children.
  const previous = readRunning(root, mode);
  const port = await decideControlPort({
    cwd: root,
    configPath: opts.configPath,
    mode,
    apiPortOverride: opts.apiPortOverride,
    sessionId: sessionId(),
    startedAt: Date.now(),
    logDir: path.dirname(opts.logFile),
    logFile: opts.logFile,
    env: {
      isListening: (p) => isPortListening(p),
      probe: (p) => probeInstance(p),
      shutdown: async (p, pid) => void (await quitSession(p, pid)),
    },
    onStatus: opts.onStatus,
  });
  // The session this one replaces has ended: nothing writes to an old folder any more.
  pruneSessions(root, mode, sessionId());
  if (!isWindows()) {
    await sweepOrphans(root, mode, previous, opts.onStatus);
    const ports = devPorts(getRegisteredPackages().map((pkg) => pkg.port));
    await freeDevPorts({ root, mode, ports, onStatus: opts.onStatus });
  }
  return port;
}
