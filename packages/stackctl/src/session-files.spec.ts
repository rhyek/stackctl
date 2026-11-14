import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { writeRunning } from './running.js';
import {
  SESSION_RETENTION_MS,
  currentSessionId,
  isSessionId,
  newestSessionId,
  pruneSessions,
  sessionDirOf,
  sessionEventsPath,
  sessionLogPath,
  writeTargetSessionId,
} from './session-files.js';

let root: string;
const PROFILE = 'development';
const sessionsOf = () =>
  path.join(root, 'node_modules', '.stackctl', 'profiles', PROFILE, 'sessions');
const makeSession = (id: string) =>
  fs.mkdirSync(sessionDirOf(root, PROFILE, id), { recursive: true });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-sessions-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('the folder layout', () => {
  test("puts a session's log and events in profiles/<profile>/sessions/<id>/", () => {
    expect(sessionLogPath(root, PROFILE, '1794447587632')).toBe(path.join(sessionsOf(), '1794447587632', 'logs.txt')); // oxfmt-ignore
    expect(sessionEventsPath(root, PROFILE, '1794447587632')).toBe(path.join(sessionsOf(), '1794447587632', 'events.jsonl')); // oxfmt-ignore
  });

  test('takes only a run of digits as a session id', () => {
    expect(isSessionId('1794447587632')).toBe(true);
    expect(isSessionId('a20d4bad-8bdf-45ec-8388-562f43124103')).toBe(false);
    expect(isSessionId('')).toBe(false);
    expect(isSessionId('../1')).toBe(false);
  });
});

describe('newestSessionId', () => {
  test('is null with no sessions folder', () => {
    expect(newestSessionId(root, PROFILE)).toBeNull();
  });

  test('is the latest start, compared as numbers, ignoring anything not a session', () => {
    makeSession('999');
    makeSession('1000');
    makeSession('notes');
    fs.writeFileSync(path.join(sessionsOf(), '2000'), 'a file, not a folder');
    expect(newestSessionId(root, PROFILE)).toBe('1000');
  });
});

describe('currentSessionId', () => {
  test("is the running session's when it is alive and has a folder name for an id", () => {
    makeSession('1000');
    makeSession('2000');
    writeRunning(root, { port: 14001, pid: process.pid, sessionId: '1000' }, PROFILE);
    expect(currentSessionId(root, PROFILE)).toBe('1000');
  });

  test('is the newest folder when no session runs', () => {
    makeSession('1000');
    makeSession('2000');
    expect(currentSessionId(root, PROFILE)).toBe('2000');
  });

  test("is the newest folder when the running session's id names no folder (an older stackctl's)", () => {
    makeSession('1000');
    writeRunning(root, { port: 14001, pid: process.pid, sessionId: 'a20d4bad-8bdf-45ec' }, PROFILE);
    expect(currentSessionId(root, PROFILE)).toBe('1000');
  });

  test('is null with no session and no folder', () => {
    expect(currentSessionId(root, PROFILE)).toBeNull();
  });
});

describe('writeTargetSessionId', () => {
  test('is the current session when there is one', () => {
    makeSession('1000');
    expect(writeTargetSessionId(root, PROFILE, 5000)).toBe('1000');
  });

  test('is a new one named by the time when there is none', () => {
    expect(writeTargetSessionId(root, PROFILE, 5000)).toBe('5000');
  });
});

describe('pruneSessions', () => {
  const now = 100 * SESSION_RETENTION_MS;

  test('deletes the sessions that started more than 7 days ago, and keeps the rest', () => {
    const old = String(now - SESSION_RETENTION_MS - 1);
    const recent = String(now - SESSION_RETENTION_MS + 1);
    makeSession(old);
    makeSession(recent);
    pruneSessions(root, PROFILE, String(now), now);
    expect(fs.readdirSync(sessionsOf()).sort()).toEqual([recent]);
  });

  test('never deletes the session it is told to keep', () => {
    const own = String(now - 2 * SESSION_RETENTION_MS);
    makeSession(own);
    pruneSessions(root, PROFILE, own, now);
    expect(fs.readdirSync(sessionsOf())).toEqual([own]);
  });

  test("leaves alone what isn't a session folder", () => {
    fs.mkdirSync(path.join(sessionsOf(), 'notes'), { recursive: true });
    pruneSessions(root, PROFILE, String(now), now);
    expect(fs.readdirSync(sessionsOf())).toEqual(['notes']);
  });

  test("removes the files an older stackctl kept beside the profile's state", () => {
    const profileDir = path.dirname(sessionsOf());
    fs.mkdirSync(path.join(profileDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'logs', '1-2-1.log'), 'old');
    fs.writeFileSync(path.join(profileDir, 'events.log'), '{}\n');
    fs.writeFileSync(path.join(profileDir, 'events.1.log'), '{}\n');
    fs.writeFileSync(path.join(profileDir, 'running.json'), '{}');
    pruneSessions(root, PROFILE, String(now), now);
    expect(fs.readdirSync(profileDir).sort()).toEqual(['running.json']);
  });
});
