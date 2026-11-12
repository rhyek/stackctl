import { describe, expect, test } from 'vitest';
import type { EventBy, EventLine } from '../event-log.js';
import { describeBy, formatRows, recentRows, when } from './status.js';

const envelope = { mode: 'development', sessionId: 's1', pid: 1 };
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
