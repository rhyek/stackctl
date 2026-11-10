import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  getStateDir,
  getDefaultLogFile,
  getLogDir,
  pickNewestLog,
  resolveLogFile,
} from './log-files.js';

describe('getStateDir', () => {
  test('getStateDir lives under node_modules/.stackctl', () => {
    expect(getStateDir().replace(/\\/g, '/')).toContain('node_modules/.stackctl');
  });
});

describe('getLogDir', () => {
  test("is the mode's own logs/, under modes/<mode>/", () => {
    vi.stubEnv('STACKCTL_MODE', 'test');
    expect(getLogDir()).toBe(path.join(process.cwd(), 'node_modules', '.stackctl', 'modes', 'test', 'logs')); // oxfmt-ignore
    vi.unstubAllEnvs();
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
    expect(name).toMatch(new RegExp(`^\\d+-${String(process.pid)}-\\d+\\.log$`));
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

describe('pickNewestLog', () => {
  let logs: string;
  beforeAll(() => {
    logs = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-logs-'));
  });
  afterAll(() => fs.rmSync(logs, { recursive: true, force: true }));

  test('returns the most recently modified *.log by mtime', () => {
    const older = path.join(logs, '1.log');
    const newer = path.join(logs, '2.log');
    fs.writeFileSync(older, 'a');
    fs.writeFileSync(newer, 'b');
    fs.utimesSync(older, new Date(1_000), new Date(1_000));
    fs.utimesSync(newer, new Date(2_000), new Date(2_000));
    expect(pickNewestLog(logs)).toBe(newer);
  });

  test('ignores non-.log files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-logs-'));
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
    expect(pickNewestLog(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns null for a missing directory', () => {
    expect(pickNewestLog(path.join(logs, 'does-not-exist'))).toBeNull();
  });
});

describe('resolveLogFile', () => {
  test('prefers the live instance logfile when available', async () => {
    const file = await resolveLogFile({
      liveLogFile: async () => '/live/current.log',
      fallbackDir: '/logs',
      newestLog: () => '/logs/fallback.log',
    });
    expect(file).toBe('/live/current.log');
  });

  test('prefers the recorded running.json logFile (when it exists) over scanning the dir', async () => {
    const file = await resolveLogFile({
      liveLogFile: async () => null,
      recordedLogFile: '/logs/recorded.log',
      fallbackDir: '/logs',
      newestLog: () => '/logs/newest.log',
      exists: () => true,
    });
    expect(file).toBe('/logs/recorded.log');
  });

  test('skips the recorded logFile when it no longer exists, falling back to newest in dir', async () => {
    const file = await resolveLogFile({
      liveLogFile: async () => null,
      recordedLogFile: '/logs/gone.log',
      fallbackDir: '/logs',
      newestLog: () => '/logs/newest.log',
      exists: () => false,
    });
    expect(file).toBe('/logs/newest.log');
  });

  test('falls back to the newest logfile in the dir when no live answer', async () => {
    const file = await resolveLogFile({
      liveLogFile: async () => null,
      fallbackDir: '/logs',
      newestLog: (dir) => `${dir}/newest.log`,
    });
    expect(file).toBe('/logs/newest.log');
  });

  test('returns null when neither the instance nor the dir yields a logfile', async () => {
    const file = await resolveLogFile({
      liveLogFile: async () => null,
      fallbackDir: '/logs',
      newestLog: () => null,
    });
    expect(file).toBeNull();
  });
});
