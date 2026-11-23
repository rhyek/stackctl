import { startedByAgent } from '../agent-detection';
import { currentProfile, isNested } from '../env-base';
import { commandBy } from '../event-log';
import { runMany } from '../one-off/many';
import { createManyPrinter, manySummary } from '../one-off/many-print';
import { oneOffRecorder } from '../one-off/record';
import type { OneOffAsk } from '../one-off/resolve';
import { exitCodeOf } from '../scripts';
import { oneOffLogDir } from '../session-files';
import { type OneOffContext, loadManyForOneOff } from './one-off';

// `stackctl exec` and `stackctl run` with `-s` and/or `-t`: the command in several services at
// once.

/** The services the command line asked for: each `-s` as given, each `-t`, and the flag. */
export interface OneOffManySelection {
  targets: string[];
  tags: string[];
  ignoreSiblingError: boolean;
}

/**
 * Writes `text` to `stream`, resolving once it is flushed: a pipe on macOS writes asynchronously.
 */
function flushed(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve) => {
    stream.write(text, () => resolve());
  });
}

/**
 * Runs the command in every selected service at once, each line labelled with its service, then
 * prints a summary on stderr and exits: `0` when every command that ran exited `0`, the single
 * form's code for the signal when this process was sent one, SIGPIPE's when its output's reader
 * closed early, else `1`. What can't start (an unknown service or tag, a named service without
 * the script) is printed, and exits `1` before anything runs. Each command is logged and
 * recorded as a single one is, unless nested.
 */
export async function runOneOffMany(
  command: OneOffAsk,
  selection: OneOffManySelection,
  context: OneOffContext,
): Promise<never> {
  const { root, targets } = await loadManyForOneOff({
    ...command,
    targets: selection.targets,
    tags: selection.tags,
    base: context.base,
  });
  if (command.kind === 'run') {
    for (const target of targets) {
      if (target.spec === null) {
        console.error(`skipping ${target.label}: no "${command.script}" script`);
      }
    }
  }

  const nested = isNested();
  // Each command's two lines in the session's event log, as the single form writes them.
  const record = oneOffRecorder(command, {
    root,
    profile: currentProfile(),
    nested,
    by: commandBy(root, { agent: startedByAgent(), invocationCwd: context.invocationCwd }),
  });

  // A reader that closes early (`| head -2`) is no error: nobody reads the rest, so this exits as
  // a write to a closed pipe ends a program, and the exit hook ends the commands. Anything else
  // a write fails with is rethrown. Never removed: this function ends in an exit.
  const onWriteError = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      process.exit(exitCodeOf({ signal: 'SIGPIPE' }));
    }
    throw err;
  };
  process.stdout.on('error', onWriteError);
  process.stderr.on('error', onWriteError);

  const run = await runMany(targets, {
    stdio: 'inherit',
    ignoreSiblingError: selection.ignoreSiblingError,
    logDir: oneOffLogDir(root, currentProfile()),
    onLine: createManyPrinter(targets, { stdout: process.stdout, stderr: process.stderr, nested }),
    record: (target) => record(target.where),
  });
  await flushed(process.stdout, '');
  await flushed(
    process.stderr,
    manySummary(run.results)
      .map((line) => `${line}\n`)
      .join(''),
  );
  if (run.ok) {
    process.exit(0);
  }
  process.exit(run.interrupted === undefined ? 1 : exitCodeOf({ signal: run.interrupted }));
}
