import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  isInsideWorkspace,
  isProcessAlive,
  parseLsofCwd,
  parseLstart,
  processStartTime,
  resolveRealPath,
} from './process-info.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A pid that was a child of this process and is reaped now. */
const reapedPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

test('lsof -Fn output gives the working directory; empty output, none', () => {
  expect(parseLsofCwd('p123\nfcwd\nn/work/repo/packages/api\n')).toBe('/work/repo/packages/api');
  expect(parseLsofCwd('')).toBeNull();
});

test('a path is inside the root when it is the root or below it', () => {
  expect(isInsideWorkspace('/work/repo', '/work/repo')).toBe(true);
  expect(isInsideWorkspace('/work/repo', '/work/repo/packages/api')).toBe(true);
  expect(isInsideWorkspace('/work/repo', '/work/other')).toBe(false);
  expect(isInsideWorkspace('/work/repo', '/work/repo-two/pkg')).toBe(false);
});

test('isProcessAlive sees this process', () => {
  expect(isProcessAlive(process.pid)).toBe(true);
});

test("isProcessAlive is false for a reaped child's pid, 0 and -1", () => {
  expect(isProcessAlive(reapedPid())).toBe(false);
  expect(isProcessAlive(0)).toBe(false);
  expect(isProcessAlive(-1)).toBe(false);
});

test('parseLstart reads the C-locale start time as UTC', () => {
  expect(parseLstart('Sat Nov  7 20:35:35 2026  \n')).toBe(Date.UTC(2026, 10, 7, 20, 35, 35));
  expect(parseLstart('Mon Jan 12 03:04:05 2026')).toBe(Date.UTC(2026, 0, 12, 3, 4, 5));
});

test('parseLstart reads empty text, a localized date and an ISO date as unknown', () => {
  expect(parseLstart('')).toBeNull();
  expect(parseLstart('Sam Okt  7 20:35:35 2026')).toBeNull();
  expect(parseLstart('2026-11-07T20:35:35Z')).toBeNull();
});

test.runIf(process.platform !== 'win32')(
  'processStartTime of this process is within 2 s of its start',
  async () => {
    const started = Date.now() - process.uptime() * 1000;
    const read = await processStartTime(process.pid);
    expect(read).not.toBeNull();
    expect(Math.abs(read! - started)).toBeLessThan(2000);
  },
);

test('processStartTime is null for a reaped child and for pid 0', async () => {
  expect(await processStartTime(reapedPid())).toBeNull();
  expect(await processStartTime(0)).toBeNull();
});

test("resolveRealPath resolves a symlinked directory to its target's real path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-process-info-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'target'));
  fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'));
  expect(resolveRealPath(path.join(dir, 'link'))).toBe(fs.realpathSync(path.join(dir, 'target')));
});

test("resolveRealPath returns a path it can't resolve unchanged", () => {
  expect(resolveRealPath('/no/such/stackctl/path')).toBe('/no/such/stackctl/path');
});
