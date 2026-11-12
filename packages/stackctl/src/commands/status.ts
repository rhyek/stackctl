import fs from 'node:fs';
import path from 'node:path';
import type { SessionStatus } from '../control-client.js';
import { currentMode } from '../env-base.js';
import { type EventBy, type EventLine, currentEventsPath, localTime } from '../event-log.js';
import { findSession } from '../find-session.js';

// `stackctl status`: the mode's session as it is now, and what last acted on it, from its event
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
      return `${line.cause}, after ${duration(line.durationMs)}`;
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
      return line.outcome === 'done' ? base : `${base} (${line.outcome})`;
    case 'infra-command': {
      const failed = Object.entries(line.results ?? {}).filter(([, r]) => r === 'failed').map(([s]) => s); // oxfmt-ignore
      return failed.length > 0 ? `${base} (${failed.join(', ')} failed)` : base;
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

/** The session part of `status`, from `GET /query/status`. */
function sessionLines(
  mode: string,
  status: SessionStatus,
  port: number,
  startedAt: number | undefined,
): string[] {
  const since = startedAt ? ` since ${when(localTime(new Date(startedAt)))}` : '';
  const lines = [
    `${mode} session: running${since} (pid ${String(status.pid)}, control port ${String(port)}), started by ${status.startedByAgent ? 'an agent' : 'a person'}`, // oxfmt-ignore
  ];
  const services = Object.entries(status.services ?? {});
  const name = Math.max(0, ...services.map(([s]) => s.length), ...Object.keys(status.infra ?? {}).map((s) => s.length)); // oxfmt-ignore
  services.forEach(([service, state], i) => {
    const ready = status.ready?.[service] ? 'ready' : 'not ready';
    lines.push(`${i === 0 ? 'services' : ''.padEnd(8)}  ${service.padEnd(name)}  ${String(state)}${state === 'stopped' ? '' : `, ${ready}`}`); // oxfmt-ignore
  });
  Object.entries(status.infra ?? {}).forEach(([service, state], i) => {
    lines.push(`${i === 0 ? 'infra   ' : ''.padEnd(8)}  ${service.padEnd(name)}  ${state}`);
  });
  if (status.logFile) {
    lines.push(`log       ${path.relative(process.cwd(), status.logFile)}`);
  }
  return lines;
}

/**
 * `stackctl status [--json]`: whether the mode's session runs, its services and infra now, and the
 * last commands and lifecycle entries of its event log, dated. Exits 0 either way.
 */
export async function runStatus(opts: { json?: boolean }): Promise<never> {
  const root = process.cwd();
  const mode = currentMode();
  const found = await findSession({ workspaceDir: root, mode });
  const file = currentEventsPath(root, mode);
  const lines = readEventLines(file);
  const status = found.kind === 'running' ? found.status : null;
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          mode,
          running: found.kind === 'running',
          port: found.kind === 'running' ? found.client.port : null,
          unresponsive: found.kind === 'unresponsive' ? { pid: found.pid, reason: found.reason } : null, // oxfmt-ignore
          status,
          eventsFile: file === null ? null : path.relative(root, file),
          recent: lines.filter((l) => !['service-state', 'infra-state', 'session-state'].includes(l.type)).slice(-RECENT * 2), // oxfmt-ignore
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  const out: string[] = [];
  if (found.kind === 'running') {
    out.push(...sessionLines(mode, found.status, found.client.port, found.record?.startedAt));
  } else if (found.kind === 'unresponsive') {
    out.push(`${mode} session: pid ${String(found.pid)} is recorded but doesn't answer (${found.reason})`); // oxfmt-ignore
  } else {
    out.push(`No ${mode} session is running.`);
  }
  out.push(file === null ? 'events    none yet' : `events    ${path.relative(root, file)}${lines.length === 0 ? ' (empty)' : ''}`); // oxfmt-ignore
  const rows = recentRows(lines);
  if (rows.length > 0) {
    out.push('', 'last commands', ...formatRows(rows).map((row) => `  ${row}`));
  }
  console.log(out.join('\n'));
  process.exit(0);
}
