import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import type { OneOffSpec } from './run.js';

// `stackctl exec` and `run` inside a command stackctl runs (a dev script's
// `sctl exec -- node --watch src/main.ts`): with no log to write and no event to record, nothing is
// left for stackctl to do once the environment is resolved, so the process becomes the command.
// No idle stackctl stays between the session and its service, holding the config's memory.

/**
 * The program `command` runs, as a shell finds it: a path with a `/` resolved against `cwd`, else
 * the first executable file of that name on `PATH` (an empty entry is `cwd`). `null` when there
 * is none.
 */
export function findProgram(
  command: string,
  cwd: string,
  pathVar: string | undefined,
): string | null {
  const candidates = command.includes('/')
    ? [path.resolve(cwd, command)]
    : (pathVar ?? '').split(path.delimiter).map((dir) => path.resolve(cwd, dir, command));
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) {
        fs.accessSync(file, fs.constants.X_OK);
        return file;
      }
    } catch {
      /* not there, or not executable: the next one */
    }
  }
  return null;
}

/** Resolves once `stream` has written out what was written to it: a pipe on macOS writes later. */
const drained = (stream: NodeJS.WriteStream) =>
  new Promise<void>((resolve) => {
    stream.write('', () => resolve());
  });

/**
 * Replaces this process with `spec`'s command, in its directory and with exactly its environment:
 * the same pid, so whoever started stackctl sees the command's exit and signals reach it. Returns
 * only when it can't: no `process.execve` (Windows), a process with an IPC channel (which `execve`
 * would cut), a program not found, or an `execve` that failed. The caller then runs the command
 * as a child, which reports any error as usual.
 */
export async function execInPlace(spec: OneOffSpec): Promise<void> {
  if (typeof process.execve !== 'function' || process.channel) {
    return;
  }
  const file = findProgram(spec.command, spec.cwd, spec.env.PATH);
  if (!file) {
    return;
  }
  await Promise.all([drained(process.stdout), drained(process.stderr)]);
  // What Node changed of this process that a child it spawned would get fresh, put back for the
  // command. A pipe Node opened as a stream is non-blocking, and that would stay: a program that
  // doesn't expect it fails a read or a write with EAGAIN. (A terminal Node reads is a copy of
  // its own, which `execve` closes.)
  for (const stream of [process.stdin, process.stdout, process.stderr]) {
    (stream as { _handle?: { setBlocking?: (blocking: boolean) => number } })._handle?.setBlocking?.(true); // oxfmt-ignore
  }
  // Node ignores SIGPIPE and SIGXFSZ, and an ignored signal stays ignored across `execve`, while
  // a caught one goes back to its default: `yes | head -1` would print "Broken pipe" otherwise.
  // On the way back, the listeners ignore them as Node did.
  for (const signal of ['SIGPIPE', 'SIGXFSZ'] as const) {
    process.on(signal, () => {});
  }
  // The compile cache is written as Node exits, which an `execve` never does.
  module.flushCompileCache();
  const cwd = process.cwd();
  try {
    process.chdir(spec.cwd);
    process.execve(file, [spec.command, ...spec.args], spec.env);
  } catch {
    process.chdir(cwd);
  }
}
