import fs from 'node:fs';
import path from 'node:path';
import type { SessionStatus } from '../control-client';
import { currentProfile } from '../env-base';
import { type EventBy, type EventLine, currentEventsPath, localTime } from '../event-log';
import { findSession } from '../find-session';
import { sdkResultRequested, writeSdkResult } from '../sdk-result';

// `stackctl status`: the profile's session as it is now, and what last acted on it, from its event
// log. Strictly read-only, like `logs`: it reads the session record and asks `GET /query/status`,
// and never goes through session acquisition, which would hand off (end) a running session.

/** How many commands and lifecycle entries `status` shows. */
const RECENT = 10;

/** The event log's lines, oldest first; the ones that don't parse are skipped. */
export function readEventLines(file: string | null): EventLine[] {
  let text: string;
  try {
    text = fs.readFileSync(file ?? '', 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    try {
      return line ? [JSON.parse(line) as EventLine] : [];
    } catch {
      return [];
    }
  });
}

/** One row of `status`'s list: when, what, how it went, and who asked. */
export interface EventRow {
  time: string;
  type: string;
  what: string;
  outcome: string;
  by: string | null;
}

/**
 * The commands and lifecycle entries of `lines`, the last `count`, each command's `begin` and
 * `end` as one row: state lines are what `status` shows above them.
 */
export function recentRows(lines: EventLine[], count = RECENT): EventRow[] {
  const rows: EventRow[] = [];
  const byId = new Map<string, EventRow>();
  const add = (line: EventLine): void => {
    if (
      line.type === 'service-state' ||
      line.type === 'infra-state' ||
      line.type === 'session-state'
    ) {
      return;
    }
    if ('phase' in line) {
      const open = byId.get(line.id);
      if (line.phase === 'end' && open) {
        open.outcome = outcomeOf(line);
        return;
      }
      const row = { time: line.time, type: line.type, what: whatOf(line), outcome: line.phase === 'end' ? outcomeOf(line) : 'no end yet', by: describeBy(line.by) }; // oxfmt-ignore
      byId.set(line.id, row);
      rows.push(row);
      return;
    }
    rows.push({ time: line.time, type: line.type, what: whatOf(line), outcome: '', by: null });
  };
  for (const line of lines) {
    // A line this version can't word (another version's, a cut-off write) is skipped, like a
    // type it doesn't know: the log outlives the stackctl that wrote it.
    try {
      add(line);
    } catch {
      continue;
    }
  }
  return rows.slice(-count);
}

function whatOf(line: EventLine): string {
  switch (line.type) {
    case 'service-command':
      return `${line.action} ${line.service}`;
    case 'infra-command':
      return `${line.action} ${line.requested.length > 0 ? line.requested.join(', ') : 'every service'}`;
    case 'compose-command':
      return `docker-compose ${line.args.join(' ')}`;
    case 'one-off-command': {
      const where = line.service ?? line.dir ?? '.';
      return line.kind === 'run'
        ? `run ${line.script ?? ''}${line.args && line.args.length > 0 ? ` ${line.args.join(' ')}` : ''} in ${where}`
        : `exec ${(line.command ?? []).join(' ')} in ${where}`;
    }
    case 'session-command':
      return line.action;
    case 'session-start':
      return `${line.services.join(', ')}${line.headless ? ', headless' : ''}`;
    case 'session-end':
      return `${line.cause}, after ${duration(line.durationMs)}${line.error === undefined ? '' : `: ${line.error}`}`;
    case 'service-exit':
      return `${line.service} exited ${line.signal ? `on ${line.signal}` : `with code ${String(line.exitCode)}`}`;
    case 'env-change':
      return `.env in ${line.dir}: restarts ${line.services.join(', ') || 'nothing running'}`;
    default:
      return '';
  }
}

function outcomeOf(line: Extract<EventLine, { phase: 'end' }>): string {
  const base = `${line.ok ? 'ok' : 'failed'}, ${duration(line.durationMs)}`;
  switch (line.type) {
    case 'service-command':
      // A restart a stop (or the shutdown) came before: asked for, then called off, not a failure.
      if (line.outcome === 'cancelled') {
        return `cancelled, ${duration(line.durationMs)}`;
      }
      return line.outcome === 'done' ? base : `${base} (${line.outcome})`;
    case 'infra-command': {
      const failed = Object.entries(line.results ?? {}).filter(([, r]) => r === 'failed').map(([s]) => s); // oxfmt-ignore
      const hooks = Object.keys(line.hookErrors ?? {}).map((s) => `${s} ${String(line.results?.[s])}, but a hook failed`); // oxfmt-ignore
      const notStarted = Object.entries(line.notStarted ?? {}).map(([s, why]) => `${s} ${String(line.results?.[s])}, ${why}`); // oxfmt-ignore
      const notes = [...(failed.length > 0 ? [`${failed.join(', ')} failed`] : []), ...hooks, ...notStarted]; // oxfmt-ignore
      return notes.length > 0 ? `${base} (${notes.join('; ')})` : base;
    }
    case 'compose-command':
    case 'one-off-command':
      return line.exitCode === 0 || line.exitCode === null ? base : `${base} (exit ${String(line.exitCode)})`; // oxfmt-ignore
    default:
      return base;
  }
}

/** Who asked, in a few words: `key r`, `control API (curl/8.7.1)`, `cli: infra restart -s db (a person)`. */
export function describeBy(by: EventBy): string {
  switch (by.kind) {
    case 'ui':
      return `key ${by.key}`;
    case 'control-api':
      return `control API${by.userAgent ? ` (${by.userAgent})` : ''}`;
    case 'cli':
      return `cli: ${by.argv.join(' ')} (${by.agent ? 'an agent' : 'a person'})`;
    case 'sdk':
      return `sdk: node ${by.argv.join(' ')} (${by.agent ? 'an agent' : 'a person'})`;
    case 'session':
      return 'the session';
  }
}

function duration(ms: number): string {
  if (ms < 1000) {
    return `${String(ms)}ms`;
  }
  const s = ms / 1000;
  return s < 60
    ? `${s.toFixed(1)}s`
    : `${String(Math.floor(s / 60))}m${String(Math.round(s % 60))}s`;
}

/** `time` (the log's ISO 8601) as `today 11:47:05`, `yesterday …`, or `2026-11-09 …`. */
export function when(time: string, now = new Date()): string {
  const day = time.slice(0, 10);
  const clock = time.slice(11, 19);
  const iso = (d: Date) =>
    `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; // oxfmt-ignore
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return `${day === iso(now) ? 'today' : day === iso(yesterday) ? 'yesterday' : day} ${clock}`;
}

/** `rows`, as `status` lists them: aligned columns, one row each. */
export function formatRows(rows: EventRow[], now = new Date()): string[] {
  const width = (pick: (row: EventRow) => string) => Math.max(0, ...rows.map((r) => pick(r).length)); // oxfmt-ignore
  const at = rows.map((r) => when(r.time, now));
  const w = { at: Math.max(...at.map((a) => a.length)), type: width((r) => r.type), what: width((r) => r.what), outcome: width((r) => r.outcome) }; // oxfmt-ignore
  return rows.map((row, i) =>
    [at[i]!.padEnd(w.at), row.type.padEnd(w.type), row.what.padEnd(w.what), row.outcome.padEnd(w.outcome), row.by ? `by ${row.by}` : ''] // oxfmt-ignore
      .join('  ')
      .trimEnd(),
  );
}

/**
 * The session part of `status`, from `GET /query/status`: a service that can't get ready because
 * a start hook failed (its own, or one it waits for) shows why, one that still runs a hook of
 * its own shows which, and so does a session whose own `afterStart` or `afterReady` failed or is
 * still to finish.
 */
export function sessionLines(
  profile: string,
  status: SessionStatus,
  port: number,
  startedAt: number | undefined,
): string[] {
  const at = startedAt ? when(localTime(new Date(startedAt))) : null;
  const ids = `pid ${String(status.pid)}, control port ${String(port)}`;
  const by = `started by ${status.startedByAgent ? 'an agent' : 'a person'}`;
  const pending = status.sessionStartHooks === 'afterStart' || status.sessionStartHooks === 'afterReady'; // oxfmt-ignore
  // A session whose start failed once it was up still runs, until it is quit.
  const lines = [
    status.sessionError
      ? `${profile} session: failed to start: ${status.sessionError} (${ids}${at ? `, up since ${at}` : ''}), ${by}` // oxfmt-ignore
      : `${profile} session: running${at ? ` since ${at}` : ''}${pending ? `, its ${status.sessionStartHooks} still to finish` : ''} (${ids}), ${by}`, // oxfmt-ignore
  ];
  const services = Object.entries(status.services ?? {});
  const name = Math.max(0, ...services.map(([s]) => s.length), ...Object.keys(status.infra ?? {}).map((s) => s.length)); // oxfmt-ignore
  services.forEach(([service, state], i) => {
    const ready = status.ready?.[service] ? 'ready' : 'not ready';
    const error = status.errors?.[service];
    const hook = status.serviceHooks?.[service];
    // Stopped already, as the session has it, but its process runs until its `beforeStop` is done.
    const word = state === 'stopped' && hook === 'beforeStop' ? 'stopping' : String(state);
    const why = error !== undefined ? `: ${error}` : hook !== undefined ? `: its ${hook} is still running` : ''; // oxfmt-ignore
    lines.push(`${i === 0 ? 'services' : ''.padEnd(8)}  ${service.padEnd(name)}  ${word}${state === 'stopped' ? '' : `, ${ready}`}${why}`); // oxfmt-ignore
  });
  Object.entries(status.infra ?? {}).forEach(([service, state], i) => {
    lines.push(`${i === 0 ? 'infra   ' : ''.padEnd(8)}  ${service.padEnd(name)}  ${state}`);
  });
  if (status.logFile) {
    lines.push(`log       ${path.relative(process.cwd(), status.logFile)}`);
  }
  return lines;
}

/** Why the session `lines` are the event log of failed to start, if that is how it ended. */
function failedStart(lines: EventLine[]): Extract<EventLine, { type: 'session-end' }> | null {
  const end = lines.findLast((line) => line.type === 'session-end');
  return end?.type === 'session-end' && end.cause === 'error' ? end : null;
}

/**
 * What `status` says with no session running, from the latest session's event log (`lines`): that
 * none runs, and, when the latest one's start failed, why and when.
 */
export function noSessionLines(profile: string, lines: EventLine[], now = new Date()): string[] {
  const failed = failedStart(lines);
  return [
    `No ${profile} session is running.`,
    ...(failed
      ? [
          `The last one failed to start (${when(failed.time, now)}): ${failed.error ?? 'see its log'}`,
        ]
      : []),
  ];
}

/** What `stackctl status --json` prints, and the SDK's `status()` resolves with. */
export interface StatusReport {
  /** The profile. */
  profile: string;
  /** Whether a session of the profile is running and answering. */
  running: boolean;
  /** Its control API's port, or `null`. */
  port: number | null;
  /** A recorded session that doesn't answer, or `null`. */
  unresponsive: { pid: number; reason: 'hung' | 'mismatch' } | null;
  /** What the running session reports, or `null`. */
  status: SessionStatus | null;
  /**
   * Why the latest session's start failed, when none is running and that is how it ended; else
   * `null`.
   */
  lastSessionError: string | null;
  /** The event log's path, relative to the workspace, or `null` before any session ran. */
  eventsFile: string | null;
  /** The last commands and lifecycle entries of the event log. */
  recent: EventLine[];
}

/**
 * `stackctl status [--json]`: whether the profile's session runs, its services and infra now, and
 * the last commands and lifecycle entries of its event log, dated. Exits 0 either way.
 */
export async function runStatus(opts: { json?: boolean }): Promise<never> {
  const root = process.cwd();
  const profile = currentProfile();
  const found = await findSession({ workspaceDir: root, profile });
  const file = currentEventsPath(root, profile);
  const lines = readEventLines(file);
  const report: StatusReport = {
    profile,
    running: found.kind === 'running',
    port: found.kind === 'running' ? found.client.port : null,
    unresponsive: found.kind === 'unresponsive' ? { pid: found.pid, reason: found.reason } : null,
    status: found.kind === 'running' ? found.status : null,
    lastSessionError: found.kind === 'none' ? (failedStart(lines)?.error ?? null) : null,
    eventsFile: file === null ? null : path.relative(root, file),
    recent: lines.filter((l) => !['service-state', 'infra-state', 'session-state'].includes(l.type)).slice(-RECENT * 2), // oxfmt-ignore
  };
  if (sdkResultRequested()) {
    writeSdkResult(report);
    process.exit(0);
  }
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }
  const out: string[] = [];
  if (found.kind === 'running') {
    out.push(...sessionLines(profile, found.status, found.client.port, found.record?.startedAt));
  } else if (found.kind === 'unresponsive') {
    out.push(`${profile} session: pid ${String(found.pid)} is recorded but doesn't answer (${found.reason})`); // oxfmt-ignore
  } else {
    out.push(...noSessionLines(profile, lines));
  }
  out.push(file === null ? 'events    none yet' : `events    ${path.relative(root, file)}${lines.length === 0 ? ' (empty)' : ''}`); // oxfmt-ignore
  const rows = recentRows(lines);
  if (rows.length > 0) {
    out.push('', 'last commands', ...formatRows(rows).map((row) => `  ${row}`));
  }
  console.log(out.join('\n'));
  process.exit(0);
}
