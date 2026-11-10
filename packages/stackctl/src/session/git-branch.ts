import { type FSWatcher, watch } from 'node:fs';
import { execaSync } from 'execa';

/**
 * The checked-out git branch: its name, the short SHA on a detached HEAD, `null` outside a
 * repository. Reads `main` while a demo or screenshot is recorded (`STACKCTL_DEMO_RECORDING`),
 * whatever is checked out.
 */
export function readGitBranch(cwd = process.cwd()): string | null {
  if (process.env.STACKCTL_DEMO_RECORDING) {
    return 'main';
  }
  // `symbolic-ref` names the branch even before its first commit; it fails on a detached HEAD.
  const branch = gitOutput(cwd, 'symbolic-ref', '--short', '-q', 'HEAD');
  return branch ?? gitOutput(cwd, 'rev-parse', '--short', 'HEAD');
}

/** A command's trimmed output, or `null` when it fails or prints nothing. */
function gitOutput(cwd: string, ...args: string[]): string | null {
  try {
    return execaSync('git', args, { cwd }).stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * How long a change of `HEAD` settles before the branch is read again: a checkout writes it once,
 * a rebase once per commit, and the read waits for the last of a burst.
 */
export const GIT_HEAD_SETTLE_MS = 50;

/** A watch on the workspace's checked-out git branch. */
export interface GitBranchWatch {
  /** The branch now: the short SHA on a detached HEAD, `null` outside a repository. */
  readonly branch: string | null;
  stop(): void;
}

/**
 * Reads the git branch now, then again each time the repository's `HEAD` file changes, which is
 * what every checkout, switch, rename of the branch or commit on a detached HEAD writes. It calls
 * `onChange` with each new branch. It watches the directory holding `HEAD`, not the file, because
 * git replaces the file rather than writing to it, and a watch on a file ends with the file it
 * was opened on. The watch doesn't keep the process alive, and one that can't be opened (outside
 * a repository, or the system refuses it) leaves the branch as first read.
 */
export function followGitBranch(
  onChange: (branch: string | null) => void,
  cwd = process.cwd(),
): GitBranchWatch {
  let branch = readGitBranch(cwd);
  let watcher: FSWatcher | null = null;
  let settle: ReturnType<typeof setTimeout> | null = null;
  const reread = () => {
    settle = null;
    const now = readGitBranch(cwd);
    if (now !== branch) {
      branch = now;
      onChange(now);
    }
  };
  const stop = () => {
    watcher?.close();
    watcher = null;
    if (settle) {
      clearTimeout(settle);
      settle = null;
    }
  };
  // The directory `HEAD` lives in: a linked worktree's or a submodule's own, not the main `.git`.
  const gitDir = gitOutput(cwd, 'rev-parse', '--absolute-git-dir');
  if (gitDir !== null) {
    try {
      watcher = watch(gitDir, { persistent: false }, (_event, file) => {
        // A platform that can't name the file reports none: read the branch to be sure.
        if (file !== null && file !== 'HEAD') {
          return;
        }
        settle ??= setTimeout(reread, GIT_HEAD_SETTLE_MS);
        settle.unref();
      });
      // The directory removed, say: the branch stays as last read.
      watcher.on('error', stop);
    } catch {
      watcher = null;
    }
  }
  return {
    get branch() {
      return branch;
    },
    stop,
  };
}
