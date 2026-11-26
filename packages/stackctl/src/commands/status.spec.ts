import { describe, expect, test } from 'vitest';
import type { SessionStatus } from '../control-client';
import type { EventBy, EventLine } from '../event-log';
import { describeBy, formatRows, noSessionLines, recentRows, sessionLines, when } from './status';

const envelope = { profile: 'development', sessionId: 's1', pid: 1 };
const cli: Extract<EventBy, { kind: 'cli' }> = { kind: 'cli', argv: ['infra', 'restart', '-s', 'db'], cwd: '.', agent: false }; // oxfmt-ignore

const lines: EventLine[] = [
  { type: 'session-start', services: ['backend', 'frontend'], headless: true, startedByAgent: false, argv: [], version: '0.4.0', logFile: 'x.log', replaced: null, time: '2026-11-11T11:41:52.000-06:00', ...envelope }, // oxfmt-ignore
  { type: 'infra-command', phase: 'begin', id: 'k3', action: 'restart', requested: ['db'], by: cli, time: '2026-11-11T11:47:05.000-06:00', ...envelope }, // oxfmt-ignore
  { type: 'service-state', service: 'backend', status: 'running', ready: false, previousStatus: 'running', previousReady: true, time: '2026-11-11T11:47:05.300-06:00', ...envelope }, // oxfmt-ignore
  { type: 'infra-command', phase: 'end', id: 'k3', action: 'restart', requested: ['db'], by: cli, ok: true, durationMs: 2012, services: ['db'], results: { db: 'ready' }, time: '2026-11-11T11:47:07.000-06:00', ...envelope }, // oxfmt-ignore
  { type: 'service-command', phase: 'begin', id: 'p8', action: 'restart', service: 'backend', by: { kind: 'control-api', request: 'POST /command/service/restart/backend', userAgent: 'stackctl/0.4.0' }, time: '2026-11-11T11:49:00.000-06:00', ...envelope }, // oxfmt-ignore
];

describe('recentRows', () => {
  test("one row per command, its end's outcome on its begin's row; state lines left out", () => {
    expect(recentRows(lines)).toEqual([
      { time: '2026-11-11T11:41:52.000-06:00', type: 'session-start', what: 'backend, frontend, headless', outcome: '', by: null }, // oxfmt-ignore
      { time: '2026-11-11T11:47:05.000-06:00', type: 'infra-command', what: 'restart db', outcome: 'ok, 2.0s', by: 'cli: infra restart -s db (a person)' }, // oxfmt-ignore
      { time: '2026-11-11T11:49:00.000-06:00', type: 'service-command', what: 'restart backend', outcome: 'no end yet', by: 'control API (stackctl/0.4.0)' }, // oxfmt-ignore
    ]);
  });

  test('skips a line it cannot read, as another version or a cut-off write would leave one', () => {
    const odd = [
      {
        type: 'service-command',
        phase: 'begin',
        id: 'x1',
        action: 'restart',
        service: 'api',
        time: '2026-11-11T11:50:00.000-06:00',
        ...envelope,
      }, // no `by`
      {
        type: 'infra-command',
        phase: 'begin',
        id: 'x2',
        action: 'start',
        by: cli,
        time: '2026-11-11T11:50:01.000-06:00',
        ...envelope,
      }, // no `requested`
      null,
      'a string',
    ] as unknown as EventLine[];
    expect(recentRows([...odd, lines[0]!]).map((row) => row.type)).toEqual(['session-start']);
  });

  test('an infra command whose hook failed says which service reached its state but had a hook fail', () => {
    const hook: EventLine[] = [
      { type: 'infra-command', phase: 'begin', id: 'k4', action: 'stop', requested: ['db'], by: cli, time: '2026-11-11T11:50:05.000-06:00', ...envelope }, // oxfmt-ignore
      { type: 'infra-command', phase: 'end', id: 'k4', action: 'stop', requested: ['db'], by: cli, ok: false, durationMs: 2012, services: ['db', 'redis'], results: { db: 'stopped', redis: 'failed' }, hookErrors: { db: 'beforeStop failed: boom' }, time: '2026-11-11T11:50:07.000-06:00', ...envelope }, // oxfmt-ignore
    ];
    expect(recentRows(hook).map((row) => row.outcome)).toEqual([
      'failed, 2.0s (redis failed; db stopped, but a hook failed)',
    ]);
  });

  test("an infra reset stopped by one service's afterDestroy says whose hook failed, and that the others weren't started", () => {
    const reset: EventLine[] = [
      { type: 'infra-command', phase: 'begin', id: 'k5', action: 'reset', requested: [], by: cli, time: '2026-11-11T11:50:05.000-06:00', ...envelope }, // oxfmt-ignore
      { type: 'infra-command', phase: 'end', id: 'k5', action: 'reset', requested: [], by: cli, ok: false, durationMs: 2012, services: ['db', 'redis'], results: { db: 'destroyed', redis: 'destroyed' }, hookErrors: { db: 'afterDestroy failed: boom' }, notStarted: { redis: 'not started: db failed in afterDestroy' }, time: '2026-11-11T11:50:07.000-06:00', ...envelope }, // oxfmt-ignore
    ];
    expect(recentRows(reset).map((row) => row.outcome)).toEqual([
      'failed, 2.0s (db destroyed, but a hook failed; redis destroyed, not started: db failed in afterDestroy)',
    ]);
  });

  test('a restart a stop cancelled reads cancelled, not failed', () => {
    const by = { kind: 'ui', key: 'r' } as const;
    const restart: EventLine[] = [
      { type: 'service-command', phase: 'begin', id: 'c1', action: 'restart', service: 'api', by, time: '2026-11-11T11:50:05.000-06:00', ...envelope }, // oxfmt-ignore
      { type: 'service-command', phase: 'end', id: 'c1', action: 'restart', service: 'api', by, ok: false, outcome: 'cancelled', durationMs: 212, time: '2026-11-11T11:50:05.212-06:00', ...envelope }, // oxfmt-ignore
      { type: 'service-command', phase: 'begin', id: 'c2', action: 'start', service: 'api', by, time: '2026-11-11T11:50:06.000-06:00', ...envelope }, // oxfmt-ignore
      { type: 'service-command', phase: 'end', id: 'c2', action: 'start', service: 'api', by, ok: false, outcome: 'busy', durationMs: 3, time: '2026-11-11T11:50:06.003-06:00', ...envelope }, // oxfmt-ignore
    ];
    expect(recentRows(restart).map((row) => row.outcome)).toEqual(['cancelled, 212ms', 'failed, 3ms (busy)']); // oxfmt-ignore
  });

  test("a session's end says why its start failed", () => {
    const ended: EventLine[] = [
      { type: 'session-end', cause: 'error', error: 'session beforeStart failed: boom', durationMs: 46, time: '2026-11-11T11:50:05.000-06:00', ...envelope }, // oxfmt-ignore
      { type: 'session-end', cause: 'quit', durationMs: 4000, time: '2026-11-11T11:51:05.000-06:00', ...envelope }, // oxfmt-ignore
    ];
    expect(recentRows(ended).map((row) => row.what)).toEqual([
      'error, after 46ms: session beforeStart failed: boom',
      'quit, after 4.0s',
    ]);
  });

  test('keeps the last ones', () => {
    expect(recentRows(lines, 1).map((r) => r.type)).toEqual(['service-command']);
  });
});

describe('when', () => {
  test('dates a time as today, yesterday, or its day', () => {
    const now = new Date(2026, 10, 11, 12, 0, 0);
    expect(when('2026-11-11T11:47:05.000-06:00', now)).toBe('today 11:47:05');
    expect(when('2026-11-10T23:59:00.000-06:00', now)).toBe('yesterday 23:59:00');
    expect(when('2026-11-02T08:00:00.000-06:00', now)).toBe('2026-11-02 08:00:00');
  });
});

describe('describeBy', () => {
  test('says who asked in a few words', () => {
    expect(describeBy({ kind: 'ui', key: 'r' })).toBe('key r');
    expect(describeBy({ kind: 'control-api', request: 'POST /command/quit', userAgent: 'curl/8.7.1' })).toBe('control API (curl/8.7.1)'); // oxfmt-ignore
    expect(describeBy({ ...cli, agent: true })).toBe('cli: infra restart -s db (an agent)');
    expect(describeBy({ kind: 'sdk', argv: ['scripts/seed.ts', '--rows=10'], cwd: '.', agent: false })).toBe('sdk: node scripts/seed.ts --rows=10 (a person)'); // oxfmt-ignore
    expect(describeBy({ kind: 'session' })).toBe('the session');
  });
});

describe('formatRows', () => {
  test('lines the rows up in columns', () => {
    const now = new Date(2026, 10, 11, 12, 0, 0);
    expect(formatRows(recentRows(lines), now)).toEqual([
      'today 11:41:52  session-start    backend, frontend, headless',
      'today 11:47:05  infra-command    restart db                   ok, 2.0s    by cli: infra restart -s db (a person)', // oxfmt-ignore
      'today 11:49:00  service-command  restart backend              no end yet  by control API (stackctl/0.4.0)', // oxfmt-ignore
    ]);
  });
});

describe('sessionLines', () => {
  test("a failed service shows its hook's error, and so does one waiting for it", () => {
    const status = {
      pid: 4242,
      startedByAgent: false,
      logFile: null,
      services: { api: 'failed', web: 'waiting', worker: 'running', docs: 'stopped' },
      ready: { api: false, web: false, worker: true, docs: false },
      errors: {
        api: 'afterReady failed: boom',
        web: 'waiting for api, which failed: afterReady failed: boom. Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session',
      },
      infra: null,
    } as unknown as SessionStatus;
    expect(sessionLines('development', status, 14001, undefined).slice(1)).toEqual([
      'services  api     failed, not ready: afterReady failed: boom',
      '          web     waiting, not ready: waiting for api, which failed: afterReady failed: boom. Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session', // oxfmt-ignore
      '          worker  running, ready',
      '          docs    stopped',
    ]);
  });

  test('a service shows the hook it still runs, and one whose beforeStart failed shows why it is stopped', () => {
    const status = {
      pid: 4242,
      startedByAgent: false,
      logFile: null,
      services: { api: 'running', web: 'waiting', worker: 'stopped', jobs: 'stopped', docs: 'stopped', mail: 'restarting' }, // oxfmt-ignore
      ready: { api: false, web: false, worker: false, jobs: false, docs: false, mail: false },
      errors: { docs: 'beforeStart failed: boom' },
      serviceHooks: { api: 'afterReady', web: 'beforeStart', worker: 'beforeStop', jobs: 'afterStop', mail: 'beforeStop' }, // oxfmt-ignore
      infra: null,
    } as unknown as SessionStatus;
    expect(sessionLines('development', status, 14001, undefined).slice(1)).toEqual([
      'services  api     running, not ready: its afterReady is still running',
      '          web     waiting, not ready: its beforeStart is still running',
      // Its process still answers until the hook is done: not stopped yet.
      '          worker  stopping: its beforeStop is still running',
      '          jobs    stopped: its afterStop is still running',
      '          docs    stopped: beforeStart failed: boom',
      '          mail    restarting, not ready: its beforeStop is still running',
    ]);
  });

  test.each(['afterStart', 'afterReady'] as const)(
    'a session whose own %s is still to finish says so in its first line',
    (hook) => {
      const status = { pid: 4242, startedByAgent: false, logFile: null, services: {}, ready: {}, errors: {}, sessionStartHooks: hook, infra: null } as unknown as SessionStatus; // oxfmt-ignore
      expect(sessionLines('development', status, 14001, undefined)).toEqual([
        `development session: running, its ${hook} still to finish (pid 4242, control port 14001), started by a person`,
      ]);
      const since = new Date(2020, 0, 2, 3, 4, 5).getTime();
      expect(sessionLines('development', status, 14001, since)[0]).toBe(
        `development session: running since 2020-01-02 03:04:05, its ${hook} still to finish (pid 4242, control port 14001), started by a person`,
      );
    },
  );

  test("a session whose own afterStart or afterReady failed says so in its first line, with the hook's error", () => {
    const status = {
      pid: 4242,
      startedByAgent: false,
      logFile: null,
      services: { api: 'running' },
      ready: { api: true },
      errors: {},
      sessionError: 'session afterReady failed: boom',
      infra: null,
    } as unknown as SessionStatus;
    expect(sessionLines('development', status, 14001, undefined)).toEqual([
      'development session: failed to start: session afterReady failed: boom (pid 4242, control port 14001), started by a person', // oxfmt-ignore
      'services  api  running, ready',
    ]);
  });
});

describe('noSessionLines', () => {
  const now = new Date(2026, 10, 11, 12, 0, 0);
  const start = lines[0]!;

  test('with no session running, says so', () => {
    expect(noSessionLines('development', [], now)).toEqual(['No development session is running.']);
  });

  test("says why the last session's start failed, and when, once it is gone", () => {
    const failed: EventLine[] = [
      start,
      { type: 'session-end', cause: 'error', error: 'session beforeStart failed: boom', durationMs: 46, time: '2026-11-11T11:41:53.000-06:00', ...envelope }, // oxfmt-ignore
    ];
    expect(noSessionLines('development', failed, now)).toEqual([
      'No development session is running.',
      'The last one failed to start (today 11:41:53): session beforeStart failed: boom',
    ]);
  });

  test('a last session that was quit, or killed with no end written, adds nothing', () => {
    const quit: EventLine[] = [start, { type: 'session-end', cause: 'quit', durationMs: 4000, time: '2026-11-11T11:51:05.000-06:00', ...envelope }]; // oxfmt-ignore
    expect(noSessionLines('development', quit, now)).toHaveLength(1);
    expect(noSessionLines('development', [start], now)).toHaveLength(1);
  });
});
