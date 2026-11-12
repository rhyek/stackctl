import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  EVENT_BY_ENV,
  EventLog,
  EventTail,
  commandBy,
  isReadOnlyCompose,
  localTime,
  maskSecrets,
  takeHandedBy,
} from './event-log.js';
import { sessionEventsPath } from './session-files.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-event-log-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const lines = (file: string) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('EventLog', () => {
  test('appends one JSON line per entry: its type and own fields first, the envelope last', () => {
    const log = new EventLog({
      file: sessionEventsPath(root, 'development', '1'),
      mode: 'development',
      sessionId: () => 's1',
    });
    log.write({ type: 'session-state', ready: true });
    const file = sessionEventsPath(root, 'development', '1');
    expect(file).toBe(
      path.join(root, 'node_modules/.stackctl/modes/development/sessions/1/events.jsonl'),
    );
    const [entry] = lines(file);
    expect(Object.keys(entry!)).toEqual(['type', 'ready', 'time', 'mode', 'sessionId', 'pid']);
    expect(entry).toMatchObject({ type: 'session-state', ready: true, mode: 'development', sessionId: 's1', pid: process.pid }); // oxfmt-ignore
  });

  test("keeps the documented wait's grep working: `type` and `ready` side by side", () => {
    const log = new EventLog({
      file: sessionEventsPath(root, 'development', '1'),
      mode: 'development',
      sessionId: () => null,
    });
    log.write({ type: 'session-state', ready: true });
    log.write({ type: 'service-state', service: 'api', status: 'stopped', ready: false, previousStatus: 'running', previousReady: true }); // oxfmt-ignore
    const text = fs.readFileSync(sessionEventsPath(root, 'development', '1'), 'utf8');
    const wait = /"sessionReady":true|"type":"session-state","ready":true|"status":"stopped"/;
    const [first, second] = text.split('\n');
    expect(wait.test(first!)).toBe(true);
    expect(wait.test(second!)).toBe(true);
    // what it was is flat, so a service that *was* stopped doesn't match "status":"stopped"
    log.write({ type: 'service-state', service: 'api', status: 'running', ready: true, previousStatus: 'stopped', previousReady: false }); // oxfmt-ignore
    expect(wait.test(fs.readFileSync(sessionEventsPath(root, 'development', '1'), 'utf8').split('\n')[2]!)).toBe(false); // oxfmt-ignore
  });

  test('never throws, a write it cannot make is dropped', () => {
    fs.writeFileSync(path.join(root, 'node_modules'), 'a file where a directory should be');
    const log = new EventLog({
      file: sessionEventsPath(root, 'development', '1'),
      mode: 'development',
      sessionId: () => null,
    });
    expect(() => log.write({ type: 'session-state', ready: true })).not.toThrow();
  });

  test('tells whoever listens after each line it writes', () => {
    const log = new EventLog({
      file: sessionEventsPath(root, 'development', '1'),
      mode: 'development',
      sessionId: () => null,
    });
    let told = 0;
    log.onWrite(() => (told += 1));
    log.write({ type: 'session-state', ready: false });
    expect(told).toBe(1);
  });

  test('starts a fresh file once it is over its cap, keeping the old one as events.1.jsonl', () => {
    const log = new EventLog({
      file: sessionEventsPath(root, 'test', '1'),
      mode: 'test',
      sessionId: () => null,
      maxBytes: 200,
    });
    for (let i = 0; i < 5; i += 1) {
      log.write({ type: 'session-state', ready: i % 2 === 0 });
    }
    const file = sessionEventsPath(root, 'test', '1');
    expect(fs.existsSync(file.replace(/events\.jsonl$/, 'events.1.jsonl'))).toBe(true);
    expect(fs.statSync(file).size).toBeLessThan(400);
  });
});

describe('EventTail', () => {
  test('hands back whole lines only, keeping a half-written one for next time', () => {
    const file = sessionEventsPath(root, 'development', '1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"type":"a"}\n{"type":');
    const tail = new EventTail(file, 0);
    expect(tail.read()).toEqual(['{"type":"a"}']);
    fs.appendFileSync(file, '"b"}\n');
    expect(tail.read()).toEqual(['{"type":"b"}']);
    expect(tail.read()).toEqual([]);
  });

  test('starts from where it is told, and reads a file smaller than that again from its start', () => {
    const file = sessionEventsPath(root, 'development', '1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"type":"old"}\n');
    const tail = new EventTail(file, fs.statSync(file).size);
    expect(tail.read()).toEqual([]);
    // another writer rotated it
    fs.writeFileSync(file, '{"x":1}\n');
    expect(tail.read()).toEqual(['{"x":1}']);
  });

  test('reads nothing from a file that is not there yet', () => {
    expect(new EventTail(sessionEventsPath(root, 'development', '1'), 0).read()).toEqual([]);
  });
});

describe('maskSecrets', () => {
  test("masks a URL's password and leaves everything else as given", () => {
    expect(maskSecrets(['psql', 'postgres://app:s3cret@localhost:5432/app', '-c', 'select 1'])).toEqual(
      ['psql', 'postgres://app:***@localhost:5432/app', '-c', 'select 1'],
    ); // oxfmt-ignore
    expect(maskSecrets(['curl', 'https://example.test/a@b'])).toEqual(['curl', 'https://example.test/a@b']); // oxfmt-ignore
  });
});

describe('isReadOnlyCompose', () => {
  test("is true for Compose's read-only subcommands, whatever flags come first", () => {
    expect(isReadOnlyCompose(['ps'])).toBe(true);
    expect(isReadOnlyCompose(['logs', '--tail', '50', 'db'])).toBe(true);
    expect(isReadOnlyCompose(['--ansi', 'never', 'ps'])).toBe(false); // a flag's value reads as the subcommand: logged
    expect(isReadOnlyCompose(['restart', 'db'])).toBe(false);
    expect(isReadOnlyCompose(['exec', 'db', 'psql'])).toBe(false);
    expect(isReadOnlyCompose([])).toBe(false);
  });
});

describe('localTime', () => {
  test('is ISO 8601 with the offset, to the ms', () => {
    expect(localTime(new Date())).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
  });
});

describe('commandBy', () => {
  test("is the shell's command, its arguments masked and its directory relative, when no session handed one", () => {
    const by = commandBy('/ws', { agent: true, invocationCwd: '/ws/apps/api', handed: '' });
    expect(by).toEqual({ kind: 'cli', argv: maskSecrets(process.argv.slice(2)), cwd: 'apps/api', agent: true }); // oxfmt-ignore
  });

  test('is what the session handed over, for a command it ran', () => {
    const key = JSON.stringify({ kind: 'ui', key: 'r' });
    expect(commandBy('/ws', { agent: false, invocationCwd: '/ws', handed: key })).toEqual({ kind: 'ui', key: 'r' }); // oxfmt-ignore
  });

  test('takeHandedBy keeps the handed `by` and takes it out of the environment, so nothing the command runs inherits it', () => {
    // oxfmt-ignore
    const env: NodeJS.ProcessEnv = { [EVENT_BY_ENV]: JSON.stringify({ kind: 'ui', key: 'R' }) };
    takeHandedBy(env);
    expect(env[EVENT_BY_ENV]).toBeUndefined();
    expect(commandBy('/ws', { agent: false, invocationCwd: '/ws' })).toEqual({ kind: 'ui', key: 'R' }); // oxfmt-ignore
  });
});
