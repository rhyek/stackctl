import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { getStateDir, getDefaultLogFile, resolveLogFile } from './log-files.js';

describe('getStateDir', () => {
  test('getStateDir lives under node_modules/.stackctl', () => {
    expect(getStateDir().replace(/\\/g, '/')).toContain('node_modules/.stackctl');
  });
});

describe('getDefaultLogFile', () => {
  let logs: string;
  beforeAll(() => {
    logs = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-logs-'));
  });
  afterAll(() => fs.rmSync(logs, { recursive: true, force: true }));

  test('names the file by time, process and call', () => {
    const name = path.basename(getDefaultLogFile(logs));
    expect(name).toMatch(new RegExp(`^\\d+-${String(process.pid)}-\\d+\\.txt$`));
  });

  test('gives each call of a process its own name, within the same millisecond too', () => {
    const files = Array.from({ length: 50 }, () => getDefaultLogFile(logs));
    expect(new Set(files).size).toBe(files.length);
  });

  test('creates the directory', () => {
    const nested = path.join(logs, 'a', 'b');
    expect(path.dirname(getDefaultLogFile(nested))).toBe(nested);
    expect(fs.statSync(nested).isDirectory()).toBe(true);
  });
});

describe('resolveLogFile', () => {
  test('prefers the live instance logfile when available', async () => {
    const file = await resolveLogFile({
      liveLogFile: async () => '/live/logs.txt',
      recordedLogFile: '/recorded/logs.txt',
      latestLogFile: '/latest/logs.txt',
      exists: () => true,
    });
    expect(file).toBe('/live/logs.txt');
  });

  test("prefers the record's logFile (when it exists) over the latest session's", async () => {
    const file = await resolveLogFile({
      liveLogFile: async () => null,
      recordedLogFile: '/recorded/logs.txt',
      latestLogFile: '/latest/logs.txt',
      exists: () => true,
    });
    expect(file).toBe('/recorded/logs.txt');
  });

  test("falls back to the latest session's log when the recorded one is gone", async () => {
    const file = await resolveLogFile({
      liveLogFile: async () => null,
      recordedLogFile: '/recorded/logs.txt',
      latestLogFile: '/latest/logs.txt',
      exists: (f) => f === '/latest/logs.txt',
    });
    expect(file).toBe('/latest/logs.txt');
  });

  test('returns null when no session left a log', async () => {
    const file = await resolveLogFile({
      liveLogFile: async () => null,
      latestLogFile: '/latest/logs.txt',
      exists: () => false,
    });
    expect(file).toBeNull();
  });
});
