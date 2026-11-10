import {
  isInsideWorkspace,
  processCwd,
  processStartTime,
  resolveRealPath,
} from './process-info.js';
import { readRunning, runningFilePath } from './running.js';

// Whether a live, silent pid is the session its record names: the one check every path that would
// signal such a pid makes first (`stop`, `reset`, and a takeover with `--kill-others`).

/**
 * How much later than its record's `startedAt` a process may have started and still be the
 * session that wrote it: `ps` gives a start time to the second.
 */
export const START_TIME_SLACK_MS = 1000;

/**
 * Whether `pid`, alive and silent, is the session that wrote `mode`'s record in the workspace at
 * `root`: `yes` when it is in the workspace and started no later than the record says the session
 * did; `no` when it started after that (the system gave the number to another process once the
 * session ended) or is outside the workspace; `unknown` when the record has no start time, or the
 * process's start time or directory can't be read.
 */
export async function isRecordedSession(
  root: string,
  mode: string,
  pid: number,
): Promise<'yes' | 'no' | 'unknown'> {
  const record = readRunning(root, mode);
  const startedAt =
    record?.pid === pid && typeof record.startedAt === 'number' ? record.startedAt : null;
  const [started, cwd] = await Promise.all([processStartTime(pid), processCwd(pid)]);
  if (
    (started !== null && startedAt !== null && started > startedAt + START_TIME_SLACK_MS) ||
    (cwd !== null && !isInsideWorkspace(resolveRealPath(root), resolveRealPath(cwd)))
  ) {
    return 'no';
  }
  return startedAt === null || started === null || cwd === null ? 'unknown' : 'yes';
}

/**
 * How to clear a record whose session can't be confirmed, for the end of a message: `If no <mode>
 * session of this workspace is running, delete <file>`.
 */
export function clearRecordAdvice(root: string, mode: string): string {
  return `If no ${mode} session of this workspace is running, delete ${runningFilePath(root, mode)}`;
}
