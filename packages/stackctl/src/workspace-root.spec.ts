import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  WorkspaceNotFoundError,
  locateWorkspace,
  needsNoWorkspace,
  resolveWorkspaceDirArg,
} from './workspace-root.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-root-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function workspace(): string {
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(ws, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'stackctl.config.ts'), 'export default {};\n');
  return ws;
}

describe('locateWorkspace', () => {
  test('walks up to the nearest config', () => {
    const ws = workspace();
    const found = locateWorkspace({ from: path.join(ws, 'a', 'b') });
    expect(found.root).toBe(fs.realpathSync(ws));
    expect(found.configPath).toBe(path.join(fs.realpathSync(ws), 'stackctl.config.ts'));
  });

  test('fails with no config above', () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    expect(() => locateWorkspace({ from: empty })).toThrow(
      new WorkspaceNotFoundError(
        `No stackctl.config.ts in ${fs.realpathSync(empty)} or any directory above it`,
      ),
    );
  });

  test('workspaceDir names the root exactly', () => {
    const ws = workspace();
    const sub = path.join(ws, 'a');
    expect(() => locateWorkspace({ workspaceDir: sub })).toThrow(
      `No stackctl.config.ts in ${fs.realpathSync(sub)}`,
    );
  });

  test('workspaceDir from outside', () => {
    const ws = workspace();
    expect(locateWorkspace({ workspaceDir: ws, from: '/' }).root).toBe(fs.realpathSync(ws));
  });

  test('the root is the realpath', () => {
    const ws = workspace();
    const link = path.join(tmp, 'link');
    fs.symlinkSync(ws, link);
    expect(locateWorkspace({ workspaceDir: link }).root).toBe(fs.realpathSync(ws));
  });
});

describe('resolveWorkspaceDirArg', () => {
  test.each([
    [['--workspace-dir', 'x', 'start'], 'x'],
    [['start', '--workspace-dir=y'], 'y'],
    [['exec', '--', 'tool', '--workspace-dir', 'z'], undefined],
    [['start'], undefined],
    [['infra', '--workspace-dir', 'w', 'docker-compose', 'ps'], 'w'],
  ])('%j', (args, expected) => {
    expect(resolveWorkspaceDirArg(['node', 'cli', ...args])).toBe(expected);
  });
});

describe('needsNoWorkspace', () => {
  test.each([
    [['init'], true],
    [['--mode', 'test', 'init', '-y'], true],
    [['--help'], true],
    [['--version'], true],
    [['show-config'], false],
    [['--headless', '-s', 'a'], false],
    [['exec', '--', 'init'], false],
    [['--headless', '-s', 'init'], false],
    [['--service', 'init', 'start'], false],
    [['--log-dir', 'init', 'start'], false],
    [['--workspace-dir', 'init', 'logs'], false],
  ])('%j', (args, expected) => {
    expect(needsNoWorkspace(['node', 'cli', ...args])).toBe(expected);
  });
});
