import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { type GitBranchWatch, readGitBranch, followGitBranch } from './git-branch.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) {
    fn();
  }
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'stackctl-git-branch-')));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Runs git in `cwd` with no user or system config, and returns what it printed. */
function git(cwd: string, ...args: string[]): string {
  const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const identity = ['-c', 'user.name=test', '-c', 'user.email=test@example.test'];
  const result = spawnSync('git', [...identity, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** A repository on `main` with one commit. */
function repo(): string {
  const dir = tempDir();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'first');
  return dir;
}

function watching(cwd: string) {
  const changes: (string | null)[] = [];
  const watch: GitBranchWatch = followGitBranch((branch) => changes.push(branch), cwd);
  cleanups.push(() => watch.stop());
  return { watch, changes };
}

const until = (fn: () => void) => vi.waitFor(fn, { timeout: 5_000, interval: 20 });

/** Long enough for a change of `HEAD` to have been seen and read, were there one. */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 300));

describe('readGitBranch', () => {
  test('the branch, the short SHA on a detached HEAD, null outside a repository', () => {
    const dir = repo();
    expect(readGitBranch(dir)).toBe('main');
    git(dir, 'switch', '-q', '--detach');
    expect(readGitBranch(dir)).toBe(git(dir, 'rev-parse', '--short', 'HEAD'));
    expect(readGitBranch(tempDir())).toBeNull();
  });

  test("outside a repository git's complaint stays off this process's stderr", () => {
    const module = pathToFileURL(path.join(import.meta.dirname, 'git-branch.ts')).href;
    const js = `const { readGitBranch } = await import(${JSON.stringify(module)}); console.log(String(readGitBranch(${JSON.stringify(tempDir())})));`; // oxfmt-ignore
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', js], {
      encoding: 'utf8',
      env: { ...process.env, STACKCTL_DEMO_RECORDING: '' },
    });
    expect({ stdout: result.stdout, stderr: result.stderr }).toEqual({
      stdout: 'null\n',
      stderr: '',
    });
  });

  test('a branch with no commit yet', () => {
    const dir = tempDir();
    git(dir, 'init', '-q', '-b', 'trunk');
    expect(readGitBranch(dir)).toBe('trunk');
  });
});

describe('followGitBranch', () => {
  test('follows a switch to another branch, and back', async () => {
    const dir = repo();
    const { watch, changes } = watching(dir);
    expect(watch.branch).toBe('main');
    git(dir, 'switch', '-q', '-c', 'feature/x');
    await until(() => expect(changes).toEqual(['feature/x']));
    expect(watch.branch).toBe('feature/x');
    git(dir, 'switch', '-q', 'main');
    await until(() => expect(changes).toEqual(['feature/x', 'main']));
  });

  test('follows a rename of the branch and each commit on a detached HEAD', async () => {
    const dir = repo();
    const { watch, changes } = watching(dir);
    git(dir, 'branch', '-m', 'trunk');
    await until(() => expect(watch.branch).toBe('trunk'));
    git(dir, 'switch', '-q', '--detach');
    await until(() => expect(watch.branch).toBe(git(dir, 'rev-parse', '--short', 'HEAD')));
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'second');
    await until(() => expect(watch.branch).toBe(git(dir, 'rev-parse', '--short', 'HEAD')));
    expect(changes).toHaveLength(3);
  });

  test("a commit on the branch, and git's other writes, change nothing", async () => {
    const dir = repo();
    const { changes } = watching(dir);
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'second');
    git(dir, 'tag', 'v1');
    git(dir, 'status');
    await quiet();
    expect(changes).toEqual([]);
  });

  test("a linked worktree follows its own HEAD, not the main checkout's", async () => {
    const dir = repo();
    const linked = path.join(tempDir(), 'linked');
    git(dir, 'worktree', 'add', '-q', '-b', 'side', linked);
    const { watch, changes } = watching(linked);
    expect(watch.branch).toBe('side');
    git(dir, 'switch', '-q', '-c', 'elsewhere');
    await quiet();
    expect(changes).toEqual([]);
    git(linked, 'switch', '-q', '-c', 'side-2');
    await until(() => expect(changes).toEqual(['side-2']));
  });

  test('outside a repository the branch is null and stays so', async () => {
    const { watch, changes } = watching(tempDir());
    expect(watch.branch).toBeNull();
    await quiet();
    expect(changes).toEqual([]);
  });

  test('a stopped watch reports no more changes', async () => {
    const dir = repo();
    const { watch, changes } = watching(dir);
    watch.stop();
    git(dir, 'switch', '-q', '-c', 'feature');
    await quiet();
    expect(changes).toEqual([]);
    expect(watch.branch).toBe('main');
  });
});
