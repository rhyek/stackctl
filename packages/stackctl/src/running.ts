import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { currentProfile } from './env-base.js';
import { profileStateDir, stateDirOf } from './log-files.js';

/**
 * Random control-API port range: `14000`–`14099` (100 ports). Kept below the OS ephemeral
 * range (Linux 32768+, macOS 49152+) and above the usual app dev-server ports, so a picked
 * port neither collides with app servers nor gets grabbed as a transient outbound port.
 */
export const CONTROL_PORT_MIN = 14000;
export const CONTROL_PORT_COUNT = 100;

/**
 * A package process stackctl spawned. Recorded so the *next* session can clean up after a
 * stackctl that died without running any shutdown path (SIGKILL, a crashed terminal emulator, a
 * hard machine sleep). Each is spawned `detached: true`, so its pid doubles as its process-group
 * id and `kill(-pid)` reaches the whole `node → node → …` tree beneath it.
 */
export interface ChildRecord {
  pid: number;
  /**
   * The package directory the process was spawned in. Re-checked against the live process before
   * any cross-session kill: pids are recycled, and a stale record must never be able to kill an
   * unrelated process that happens to have inherited the number.
   */
  cwd: string;
}

/**
 * Persisted at `node_modules/.stackctl/profiles/<profile>/running.json`: the control-API port +
 * owner pid of this workspace's session in that profile. A workspace runs one session per profile,
 * so each profile has its own record — a `test` session never reads, overwrites, or takes over
 * `development`'s.
 */
export interface RunningState {
  port: number;
  pid: number;
  /**
   * The session's id, when it started in ms since the epoch, reported on its `/query/status` as
   * well: a live pid whose control API answers with another id (or none) is not this record's
   * session. An older stackctl wrote a UUID here, or nothing.
   */
  sessionId?: string;
  /**
   * When the session wrote this record, in ms since the epoch: after its process started, and
   * before the system could give its pid to another process. A live pid that started later isn't
   * this record's session. Absent from records an earlier stackctl wrote.
   */
  startedAt?: number;
  /**
   * Package processes this session currently has running, maintained as they start and exit.
   * Only ever consumed by a *later* session sweeping orphans — a live session tracks its own
   * children in memory.
   */
  children?: ChildRecord[];
  /**
   * Absolute path to the session's folder, `profiles/<profile>/sessions/<id>/`. Omitted by callers
   * that don't run a session (e.g. tests).
   */
  logDir?: string;
  /**
   * Absolute path to the session's log, `logDir`'s `logs.txt`, as a live session also reports it
   * on `/query/status`. Omitted by callers that don't run a session.
   */
  logFile?: string;
}

/** Identity of a live stackctl instance, as reported by its `/query/status` endpoint. */
export interface InstanceInfo {
  pid: number;
  /** Absolute path to the `stackctl.config.*` that instance was started with. */
  configPath: string;
  /** The profile that instance runs in. */
  profile: string;
}

let ownSessionId: string | undefined;

/**
 * Set by `stackctl start --detach` on the session it starts, to the id that session takes, so it
 * knows where the session's log is before the session says.
 */
export const SESSION_ID_ENV = 'STACKCTL_SESSION_ID';

/**
 * Takes `SESSION_ID_ENV` out of `env`, as this process's session id: the session's services, and
 * any stackctl they run, must not take it as theirs. The CLI calls it first thing.
 */
export function takeHandedSessionId(env: NodeJS.ProcessEnv = process.env): void {
  const handed = env[SESSION_ID_ENV];
  delete env[SESSION_ID_ENV];
  if (handed !== undefined && /^\d+$/.test(handed)) {
    ownSessionId ??= handed;
  }
}

/**
 * This process's session id: when it started, in ms since the epoch, made on first use and then
 * the same for the life of the process. It names the session's folder (`sessions/<id>/`).
 */
export function sessionId(): string {
  ownSessionId ??= String(Date.now());
  return ownSessionId;
}

/**
 * The session record of `profile` (the active one unless given): `profiles/<profile>/running.json`.
 */
export function runningFilePath(cwd: string, profile: string = currentProfile()): string {
  return path.join(profileStateDir(cwd, profile), 'running.json');
}

function parseRunning(file: string): RunningState | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as RunningState;
    if (typeof s.port === 'number' && typeof s.pid === 'number') {
      return s;
    }
    return null;
  } catch {
    return null;
  }
}

/** The profiles of the workspace at `cwd` that have a folder under `profiles/`, sorted. */
export function recordedProfiles(cwd: string): string[] {
  try {
    return fs
      .readdirSync(path.join(stateDirOf(cwd), 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function readRunning(cwd: string, profile: string = currentProfile()): RunningState | null {
  return parseRunning(runningFilePath(cwd, profile));
}

export function writeRunning(
  cwd: string,
  state: RunningState,
  profile: string = currentProfile(),
): void {
  const file = runningFilePath(cwd, profile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

/** Deletes this profile's session record when it is this process's own (its `pid` is ours). */
export function removeOwnRunning(cwd: string, profile: string = currentProfile()): void {
  const file = runningFilePath(cwd, profile);
  if (parseRunning(file)?.pid !== process.pid) {
    return;
  }
  try {
    fs.rmSync(file);
  } catch {
    /* gone already */
  }
}

let removeOnExitInstalled = false;

/**
 * Deletes this process's session record as it exits, by any path that runs exit handlers: a
 * record outliving its session would name a pid the system may give to something else.
 */
function removeRunningOnExit(cwd: string, profile: string): void {
  if (removeOnExitInstalled) {
    return;
  }
  removeOnExitInstalled = true;
  process.once('exit', () => removeOwnRunning(cwd, profile));
}

/**
 * Merges `patch` into this profile's session record — but only when the current process owns it
 * (its recorded `pid` is ours), so a session that's already been handed off to a newer one can't
 * clobber the newer session's record. No-op when there's no (owned) file. Best-effort.
 */
export function updateRunning(cwd: string, patch: Partial<RunningState>): void {
  const current = readRunning(cwd);
  if (!current || current.pid !== process.pid) {
    return;
  }
  writeRunning(cwd, { ...current, ...patch });
}

/**
 * The records of this workspace's *other* profiles, by profile — what a starting session must keep
 * its hands off: their packages are another live session's, never this one's orphans.
 */
export function readOtherProfilesRunning(
  cwd: string,
  profile: string = currentProfile(),
): Map<string, RunningState> {
  const out = new Map<string, RunningState>();
  for (const other of recordedProfiles(cwd)) {
    const state = other === profile ? null : readRunning(cwd, other);
    if (state) {
      out.set(other, state);
    }
  }
  return out;
}

/** A random port in the control range, avoiding any in `exclude`. */
export function pickRandomPort(exclude: number[] = []): number {
  const ex = new Set(exclude);
  const avail: number[] = [];
  for (let p = CONTROL_PORT_MIN; p < CONTROL_PORT_MIN + CONTROL_PORT_COUNT; p++) {
    if (!ex.has(p)) {
      avail.push(p);
    }
  }
  if (avail.length === 0) {
    return CONTROL_PORT_MIN + Math.floor(Math.random() * CONTROL_PORT_COUNT);
  }
  return avail[Math.floor(Math.random() * avail.length)]!;
}

/** `true` if something is accepting TCP connections on `127.0.0.1:port`. */
export function isPortListening(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (v: boolean) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => resolve(false));
  });
}

/**
 * Network side effects used by {@link decideControlPort}; injected so the decision logic is
 * testable. The real `probe`/`shutdown` implementations live in `control-client.ts` /
 * `session-takeover.ts` (they speak the control-API HTTP protocol).
 */
export interface PortEnv {
  isListening(port: number): Promise<boolean>;
  probe(port: number): Promise<InstanceInfo | null>;
  shutdown(port: number, pid: number): Promise<void>;
}

/**
 * Decides which port this session's control API should bind, and records it in this profile's
 * `profiles/<profile>/running.json`. See the module for the full protocol; in short:
 *
 * - Explicit `apiPortOverride` → use that fixed port; hand off (shut down) only this
 *   workspace's session in the same profile already on it, never a foreign one — and fail when
 *   it's this workspace's session in another profile, which may not be quit.
 * - Otherwise start from the recorded port (or a fresh random one) and, if it's occupied:
 *   hand off + reuse when it's this workspace's session in the same profile, or relocate to a new
 *   random port when it's anything else (another profile's session, a different workspace, a
 *   non-stackctl listener). A free port is used as-is.
 */
export async function decideControlPort(opts: {
  cwd: string;
  /** Absolute path to this session's own `stackctl.config.*`. */
  configPath: string;
  /** This session's profile; only a session in the same one is handed off. */
  profile?: string;
  apiPortOverride?: number;
  pid?: number;
  /** This session's id, recorded beside its pid; see {@link RunningState.sessionId}. */
  sessionId?: string;
  /** When this session started, recorded beside its pid; see {@link RunningState.startedAt}. */
  startedAt?: number;
  /** This session's folder; recorded in the session record as `logDir`. */
  logDir?: string;
  /** This session's log; recorded in the session record as `logFile`. */
  logFile?: string;
  env: PortEnv;
  onStatus?: (message: string) => void;
}): Promise<number> {
  const pid = opts.pid ?? process.pid;
  const profile = opts.profile ?? currentProfile();
  const onStatus = opts.onStatus ?? (() => {});
  const sameProject = (info: InstanceInfo | null) => info?.configPath === opts.configPath;
  const finalize = (port: number): number => {
    // An option left undefined is dropped by JSON.stringify, so it's simply omitted when unset.
    writeRunning(
      opts.cwd,
      {
        port,
        pid,
        sessionId: opts.sessionId,
        startedAt: opts.startedAt,
        logDir: opts.logDir,
        logFile: opts.logFile,
      },
      profile,
    );
    if (pid === process.pid) {
      removeRunningOnExit(opts.cwd, profile);
    }
    return port;
  };

  if (opts.apiPortOverride != null) {
    const info = await opts.env.probe(opts.apiPortOverride);
    if (info && sameProject(info) && info.profile !== profile) {
      throw new Error(
        `apiPort ${String(opts.apiPortOverride)} is in use by this project's ${info.profile} session ` +
          `(pid ${String(info.pid)}), which a ${profile} session runs alongside rather than replacing. ` +
          'A fixed `apiPort` serves one profile at a time: stop that session, or drop `apiPort` so each ' +
          'session picks its own.',
      );
    }
    if (info && sameProject(info)) {
      onStatus('closing previous session');
      await opts.env.shutdown(opts.apiPortOverride, info.pid);
    }
    return finalize(opts.apiPortOverride);
  }

  const state = readRunning(opts.cwd, profile);
  let candidate = state?.port ?? pickRandomPort();
  const tried = new Set<number>();
  for (let i = 0; i < CONTROL_PORT_COUNT; i++) {
    tried.add(candidate);
    if (!(await opts.env.isListening(candidate))) {
      return finalize(candidate);
    }

    const info = await opts.env.probe(candidate);
    if (info && sameProject(info) && info.profile === profile) {
      // Authorized upstream by the takeover preflight (see `takeover.ts`), which reads the
      // same recorded port this loop starts from. The one case it can't have seen: a
      // deleted record while an instance still runs, where the random start has a
      // ~1-in-100 chance of landing on it anyway and handing off unasked.
      onStatus('closing previous session');
      await opts.env.shutdown(candidate, info.pid);
      return finalize(candidate);
    }
    // This project's session in another profile, a different workspace's instance, or a
    // non-stackctl listener — leave it alone and relocate.
    candidate = pickRandomPort([...tried]);
  }
  return finalize(candidate);
}
