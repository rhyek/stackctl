import fs from 'node:fs';
import { startedByAgent } from '../agent-detection.js';
import { createControlClient } from '../control-client.js';
import { type ProfileSource, currentProfile, currentProfileSource } from '../env-base.js';
import { type SessionCommandEntry, cliEventLog, commandBy } from '../event-log.js';
import { type FoundSession, findSession } from '../find-session.js';
import { profileStateDir } from '../log-files.js';
import { canSignal } from '../process-info.js';
import { readRunning, recordedProfiles, runningFilePath } from '../running.js';
import { clearRecordAdvice, isRecordedSession } from '../session-identity.js';
import type { QuitOptions } from '../session-takeover.js';
import { HANDOFF_FORCE_KILL_MS } from '../shutdown-timing.js';
import { findConfigPath } from '../workspace-root.js';

// `stackctl stop` and `stackctl reset`: one profile's session of a workspace, ended the way a
// takeover ends one; `reset` then removes that profile's state. Neither loads the config, and
// neither touches infra.

/** A session `stop` ended, or tried to. */
export interface StoppedSession {
  profile: string;
  pid: number;
  /**
   * `still-running`: it outlived even the kill of its process tree. `unverified`: its record names
   * a live pid that doesn't answer, which couldn't be confirmed as the session's, so it was never
   * signalled. `aliased`: the record is this workspace's live session of another profile, `runsAs`,
   * whose name differs from this one only as a filesystem that ignores case (or Unicode
   * normalization) sees it, so it shares this profile's folder; it was never signalled.
   */
  outcome: 'stopped' | 'force-killed' | 'still-running' | 'unverified' | 'aliased';
  /** For an `aliased` session: the profile it runs in. */
  runsAs?: string;
  /**
   * For an `unverified` session: how to clear its record should no session be running
   * (`If no <profile> session of this workspace is running, delete <file>`).
   */
  advice?: string;
}

/** How a session is ended; the takeover's timeout and kill unless a test says otherwise. */
export type StopOptions = QuitOptions;

/** The profile `stop` and `reset` act on, and where it came from. */
export interface StopTarget {
  profile: string;
  source: ProfileSource;
}

/** The profile this process resolved: what the CLI published. */
export const activeTarget = (): StopTarget => ({
  profile: currentProfile(),
  source: currentProfileSource(),
});

const NONE = { kind: 'none' } as const;

/** What `stop` does with `profile`'s record: a session to end, none, or one it may not signal. */
async function sessionToStop(
  root: string,
  profile: string,
): Promise<
  | FoundSession
  | { kind: 'unverified'; pid: number }
  | { kind: 'aliased'; pid: number; runsAs: string }
> {
  const session = await findSession({ workspaceDir: root, profile });
  // Never signalled, as no session: a record whose port another session answers on (its pid may
  // have been reused, and the process may not be ours), and one whose pid this user may not
  // signal (given to someone else's process). The record stays; `reset` removes it with the
  // directory.
  if (session.kind !== 'unresponsive') {
    return session;
  }
  if (session.reason === 'mismatch') {
    return (await aliasedSession(root, profile, session.port)) ?? NONE;
  }
  if (!canSignal(session.pid)) {
    return NONE;
  }
  // A silent pid is signalled only once it's known to be the session: records outlive crashes
  // and reboots, and their pid can be another process of this user's, in the workspace.
  switch (await isRecordedSession(root, profile, session.pid)) {
    case 'yes':
      return session;
    case 'no':
      return NONE;
    case 'unknown':
      return { kind: 'unverified', pid: session.pid };
  }
}

/**
 * The live session that answers on `port` as the one `profile`'s record names — its pid, its
 * session id, this workspace's config — but in another profile: the record is that session's, read
 * under a name the filesystem doesn't tell from its own (`Test` and `test` on a case-insensitive
 * one). `undefined` for any other answer, a record left by a session whose pid was reused.
 */
async function aliasedSession(
  root: string,
  profile: string,
  port: number,
): Promise<{ kind: 'aliased'; pid: number; runsAs: string } | undefined> {
  const record = readRunning(root, profile);
  const status = await createControlClient(port).query.status();
  const config = findConfigPath(root);
  if (
    !record ||
    !status ||
    config === null ||
    status.pid !== record.pid ||
    status.sessionId !== (record.sessionId ?? null) ||
    realPath(status.configPath) !== realPath(config) ||
    status.profile === profile
  ) {
    return undefined;
  }
  return { kind: 'aliased', pid: status.pid, runsAs: status.profile };
}

/** A path with its symlinks resolved, or as given when it doesn't exist. */
function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Ends the session of `profile` in the workspace at `root`, or resolves `null` when there is none.
 * A session that answers as itself is asked to quit, through the blocking quit a takeover uses; one
 * recorded alive in the workspace that doesn't is sent a SIGTERM, once its start time shows it is
 * the recorded session. Either has the takeover's timeout to exit before its process tree is
 * killed. A record whose process is gone, now belongs to something outside the workspace, or
 * started after the session did, is no session. A silent one that can't be confirmed as the
 * session is reported `unverified` and never signalled.
 */
export async function stopSession(
  root: string,
  profile: string,
  opts: StopOptions = {},
): Promise<StoppedSession | null> {
  const session = await sessionToStop(root, profile);
  if (session.kind === 'none') {
    return null;
  }
  if (session.kind === 'unverified') {
    return unverified(root, profile, session.pid);
  }
  if (session.kind === 'aliased') {
    return { profile, pid: session.pid, outcome: 'aliased', runsAs: session.runsAs };
  }
  // Only now: what kills a process tree loads more than finding there is none to kill.
  const { quitSession, sweepOrphans, terminateSession } = await import('../session-takeover.js');
  const pid = session.kind === 'running' ? session.status.pid : session.pid;
  const outcome =
    session.kind === 'running' && session.record
      ? await quitSession(session.record.port, pid, opts)
      : await terminateSession(pid, opts);
  if (outcome === 'force-killed') {
    // Killed, the session removed nothing: what its record names that outlived its tree is
    // swept as the next session would sweep it, and then the record goes too.
    const record = readRunning(root, profile);
    if (record?.pid === pid) {
      await sweepOrphans(root, profile, record);
      removeRecord(root, profile, pid);
    }
  }
  return { profile, pid, outcome };
}

/** A silent session `stop` couldn't confirm as stackctl's, with how to clear its record. */
function unverified(root: string, profile: string, pid: number): StoppedSession {
  return { profile, pid, outcome: 'unverified', advice: clearRecordAdvice(root, profile) };
}

/** Deletes `profile`'s record when it names `pid`. */
export function removeRecord(root: string, profile: string, pid: number): void {
  const file = runningFilePath(root, profile);
  try {
    if ((JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown }).pid === pid) {
      fs.rmSync(file);
    }
  } catch {
    /* not there, or not a record */
  }
}

/** Whether `stop` left a session that may still run: one it couldn't stop, or didn't signal. */
const mayStillRun = (s: StoppedSession) =>
  s.outcome === 'still-running' || s.outcome === 'unverified' || s.outcome === 'aliased';

/**
 * Ends `profile`'s session (see {@link stopSession}), then removes that profile's state,
 * `node_modules/.stackctl/profiles/<profile>/`: its record, saved selection, trust bundle and
 * default logs. Never touches `tls/`, `debug.log` or another profile's folder. Removes nothing if
 * the session may still be running.
 */
export async function resetProfile(
  root: string,
  profile: string,
  opts: StopOptions = {},
): Promise<{ session: StoppedSession | null; deleted: boolean }> {
  const session = await stopSession(root, profile, opts);
  if (session && mayStillRun(session)) {
    return { session, deleted: false };
  }
  const dir = profileStateDir(root, profile);
  const existed = fs.existsSync(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { session, deleted: existed };
}

/** The line `stop` prints for a session it ended, `timeoutMs` being how long it was given. */
export function stoppedLine(
  { profile, pid, outcome, advice, runsAs }: StoppedSession,
  timeoutMs: number = HANDOFF_FORCE_KILL_MS,
): string {
  const session = `${profile} session (pid ${String(pid)})`;
  switch (outcome) {
    case 'stopped':
      return `stopped ${session}`;
    case 'force-killed':
      return `force-killed ${session}: it didn't exit within ${String(timeoutMs / 1000)}s`;
    case 'still-running':
      return `couldn't stop ${session}: it's still running after its process tree was killed`;
    case 'unverified':
      return `couldn't confirm ${session} is stackctl's; not signalled${advice ? `. ${advice}.` : ''}`;
    case 'aliased':
      return `the ${profile} record is this workspace's ${String(runsAs)} session (pid ${String(pid)}), which shares its folder; not signalled. Name its profile as it runs: stackctl --profile ${String(runsAs)} stop`; // oxfmt-ignore
  }
}

/** Prints the line for the session `stop` ended; `true` when it is gone. */
function report(session: StoppedSession, opts: StopOptions): boolean {
  const line = stoppedLine(session, opts.forceKillAfterMs);
  if (mayStillRun(session)) {
    console.error(line);
    return false;
  }
  console.log(line);
  return true;
}

/** Where a profile not given with `--profile` came from, for the end of a message. */
function sourceHint({ profile, source }: StopTarget): string {
  switch (source) {
    case 'flag':
      return '';
    case 'env':
      return ` (${profile} is from STACKCTL_PROFILE; pass --profile to choose another)`;
    case 'ci':
      return ` (${profile} is the CI default profile; pass --profile to choose another)`;
    case 'default':
      return ` (${profile} is the default profile; pass --profile to choose another)`;
  }
}

/**
 * The line for no session of the profile: `No <profile> stackctl session is running.`, and where it
 * came from.
 */
export const noSessionLine = (target: StopTarget) =>
  `No ${target.profile} stackctl session is running${sourceHint(target)}.`;

/** A line for each other profile's live session, with the command that stops it. */
export async function otherSessionLines(root: string, profile: string): Promise<string[]> {
  const found = await Promise.all(
    recordedProfiles(root)
      .filter((other) => other !== profile)
      .map(async (other) => ({ other, session: await findSession({ workspaceDir: root, profile: other }) })), // oxfmt-ignore
  );
  return found.flatMap(({ other, session }) => {
    const pid =
      session.kind === 'running' ? session.status.pid : session.kind === 'unresponsive' ? session.pid : null; // oxfmt-ignore
    return pid === null
      ? []
      : [`A ${other} session is running (pid ${String(pid)}): stackctl --profile ${other} stop`];
  });
}

/** `stackctl stop`: stops the resolved profile's session; resolves with the exit code. */
export async function runStop(
  root: string,
  opts: StopOptions = {},
  target: StopTarget = activeTarget(),
): Promise<number> {
  const session = await stopSession(root, target.profile, opts);
  if (session) {
    return report(session, opts) ? 0 : 1;
  }
  console.log(noSessionLine(target));
  for (const line of await otherSessionLines(root, target.profile)) {
    console.log(line);
  }
  return 0;
}

/** Why `reset` won't run without `--profile`. */
export const RESET_NEEDS_PROFILE =
  "reset deletes a profile's state: name the profile with --profile (e.g. stackctl --profile development reset)";

/** `stackctl reset`: needs the profile from `--profile`; resolves with the exit code. */
export async function runReset(
  root: string,
  opts: StopOptions = {},
  target: StopTarget = activeTarget(),
  invocationCwd: string = root,
): Promise<number> {
  if (target.source !== 'flag') {
    console.error(RESET_NEEDS_PROFILE);
    return 1;
  }
  const { session, deleted } = await resetProfile(root, target.profile, opts);
  const dir = `node_modules/.stackctl/profiles/${target.profile}/`;
  // The reset took the event log with the rest, so its lines open the new one; one that left the
  // profile's state in place lands in the old.
  const ok = !session || report(session, opts);
  cliEventLog(root, target.profile)
    .begin<SessionCommandEntry>(
      { type: 'session-command', action: 'reset' },
      commandBy(root, { agent: startedByAgent(), invocationCwd }),
    )
    .end({ ok });
  if (!ok && session) {
    console.error(
      session.outcome === 'still-running'
        ? `Left ${dir} in place: the session is still running.`
        : session.outcome === 'aliased'
          ? `Left ${dir} in place: it is the running ${String(session.runsAs)} session's.`
          : `Left ${dir} in place: the recorded session may still be running.`,
    );
    return 1;
  }
  if (!session) {
    console.log(noSessionLine(target));
  }
  console.log(
    deleted
      ? `Removed ${dir}; its event log starts again with this reset.`
      : `Nothing to remove: ${dir} doesn't exist.`,
  );
  return 0;
}
