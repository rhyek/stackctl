import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { currentMode } from '../env-base.js';
import { connectControlClient } from '../find-session.js';
import { resolveLogFile } from '../log-files.js';
import { readRunning } from '../running.js';
import { currentSessionId, newestSessionId, sessionLogPath } from '../session-files.js';

/**
 * `stackctl logs`: print the current session's logfile, follow it, or print its path — the
 * running session of the active mode (`--mode`, default `development`), else its latest one.
 *
 * Strictly READ-ONLY: `stackctl logs` must NEVER terminate a running session. It only reads
 * the mode's session record and issues a read-only GET /query/status, then reads a file — it must never
 * go through acquireSession/decideControlPort, which hand off (shut down) an instance.
 */
export async function runLogs(opts: { follow?: boolean; path?: boolean }): Promise<never> {
  if (opts.path && opts.follow) {
    console.error('stackctl logs: --path cannot be combined with -f/--follow.');
    process.exit(1);
  }
  const cwd = process.cwd();
  const running = readRunning(cwd);
  const mode = currentMode();
  const latest = newestSessionId(cwd, mode);
  const client = await connectControlClient(cwd);
  const logFile = await resolveLogFile({
    liveLogFile: async () => {
      const status = client ? await client.query.status() : null;
      return typeof status?.logFile === 'string' ? status.logFile : null;
    },
    recordedLogFile: running?.logFile ?? null,
    latestLogFile: latest === null ? null : sessionLogPath(cwd, mode, latest),
  });
  if (!logFile) {
    console.error(`stackctl logs: no ${mode} session has run here yet.`);
    process.exit(1);
  }
  if (opts.path) {
    console.log(logFile);
    process.exit(0);
  }
  if (opts.follow) {
    return follow(logFile, () => currentSessionId(cwd, mode));
  }
  // A native `cat`, stdio inherited. No SIGINT handler is installed, so Ctrl+C stops only this
  // `cat`; the (separate-process) stackctl session is untouched.
  const child = spawn('cat', [logFile], { stdio: 'inherit' });
  const exitCode = await new Promise<number>((resolve) => {
    // A signal that ended it (a Ctrl+C) is a normal way to stop reading.
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 0 : 1)));
    child.on('error', () => resolve(1));
  });
  process.exit(exitCode);
}

/** How often `-f` reads the file for new bytes. */
const FOLLOW_MS = 250;

/**
 * Prints `file`, then what is added to it, until `session()` names another session than it did
 * at the start: the next one has started, and its lines go to its own log. Ctrl+C stops it too.
 */
async function follow(file: string, session: () => string | null): Promise<never> {
  const followed = session();
  // `stackctl logs -f | head` closing the pipe is a normal way to stop reading.
  process.stdout.on('error', () => process.exit(0));
  let offset = 0;
  const print = () => {
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return;
    }
    try {
      const { size } = fs.fstatSync(fd);
      if (size < offset) {
        offset = 0;
      }
      while (offset < size) {
        const chunk = Buffer.alloc(Math.min(size - offset, 1024 * 1024));
        const read = fs.readSync(fd, chunk, 0, chunk.length, offset);
        if (read === 0) {
          break;
        }
        process.stdout.write(chunk.subarray(0, read));
        offset += read;
      }
    } finally {
      fs.closeSync(fd);
    }
  };
  print();
  const timer = setInterval(() => {
    // Checked before reading, so the lines the session got before the next one started are printed.
    const moved = session() !== followed;
    print();
    if (moved) {
      clearInterval(timer);
      console.error(`stackctl logs: the ${currentMode()} session exited; run stackctl logs -f again to follow the next one.`); // oxfmt-ignore
      // Once stdout has taken every line: a pipe on macOS writes asynchronously.
      process.stdout.write('', () => process.exit(0));
    }
  }, FOLLOW_MS);
  return new Promise<never>(() => {});
}
