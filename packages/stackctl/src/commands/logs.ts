import { spawn } from 'node:child_process';
import path from 'node:path';
import { currentMode } from '../env-base.js';
import { connectControlClient } from '../find-session.js';
import { getLogDir, resolveLogFile } from '../log-files.js';
import { readRunning } from '../running.js';

/**
 * `stackctl logs`: print the current session's logfile, follow it, or print its path — the
 * session of the active mode (`--mode`, default `development`).
 *
 * Strictly READ-ONLY: `stackctl logs` must NEVER terminate a running session. It only reads
 * the mode's session record and issues a read-only GET /query/status, then cats/tails a file — it must never
 * go through acquireSession/decideControlPort, which hand off (shut down) an instance.
 */
export async function runLogs(opts: { follow?: boolean; path?: boolean }): Promise<never> {
  if (opts.path && opts.follow) {
    console.error('stackctl logs: --path cannot be combined with -f/--follow.');
    process.exit(1);
  }
  const cwd = process.cwd();
  const running = readRunning(cwd);
  const client = await connectControlClient(cwd);
  const logFile = await resolveLogFile({
    liveLogFile: async () => {
      const status = client ? await client.query.status() : null;
      return typeof status?.logFile === 'string' ? status.logFile : null;
    },
    recordedLogFile: running?.logFile ?? null,
    fallbackDir: running?.logDir ?? getLogDir(),
  });
  if (!logFile) {
    console.error(
      `stackctl logs: no logfile found (no running ${currentMode()} session, and no logs under ${path.relative(cwd, getLogDir()) || getLogDir()}/).`,
    );
    process.exit(1);
  }
  if (opts.path) {
    console.log(logFile);
    process.exit(0);
  }
  // Native os commands, stdio inherited. No SIGINT handler is installed, so Ctrl+C stops only
  // this `cat`/`tail` — the (separate-process) stackctl session is untouched.
  const [bin, binArgs] = opts.follow
    ? (['tail', ['-n', '+1', '-f', logFile]] as const)
    : (['cat', [logFile]] as const);
  const child = spawn(bin, binArgs, { stdio: 'inherit' });
  const exitCode = await new Promise<number>((resolve) => {
    // A signal that ended it (a Ctrl+C on `tail -f`) is a normal way to stop reading.
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 0 : 1)));
    child.on('error', () => resolve(1));
  });
  process.exit(exitCode);
}
