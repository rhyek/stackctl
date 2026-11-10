/**
 * Start a session over with a small young generation (`--max-semi-space-size`) unless it already
 * has one.
 *
 * V8 sizes its young generation by how fast a process allocates, up to 64 MB a semi-space, and
 * keeps the memory once it has it. A session allocates steadily (every frame of the TUI, every log
 * line), so it would hold well over a hundred megabytes of young generation for a few megabytes of
 * live objects. Capped at {@link SEMI_SPACE_MB}, a session's footprint stays near what it holds,
 * at the cost of more, and shorter, young-generation collections.
 *
 * V8 reads the flag only as the process starts, so setting it from here (`v8.setFlagsFromString`)
 * does nothing. Instead the process runs itself again with it: `process.execve` replaces the
 * program in place, keeping the pid and the terminal. Where there is no `execve` (Windows, Node.js
 * before 23.11), a session runs without the cap.
 *
 * Starting over costs a Node.js startup, some 40 ms, which is nothing to a session and a good part
 * of a one-off command's run, so only sessions do it. What this module records as it loads, before
 * `cli.ts`'s own code changes either, is the environment and working directory the process was
 * started with, and the process starts over from those.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Young-generation semi-space size, in MB. */
const SEMI_SPACE_MB = 2;

const FLAG = '--max-semi-space-size';

const startEnv = { ...process.env };
const startCwd = process.cwd();

/**
 * The environment and working directory the process was started with, before `cli.ts` changed
 * either: what `start --detach` starts its session from, so the session resolves its mode, and
 * its ambient environment, as this invocation did.
 */
export function startState(): { env: NodeJS.ProcessEnv; cwd: string } {
  return { env: { ...startEnv }, cwd: startCwd };
}

/** Whether `argv1` is this build's `cli.js`: only the CLI starts itself over, never an importer. */
function isCliEntry(argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false;
  }
  try {
    return (
      fs.realpathSync(argv1) ===
      fs.realpathSync(fileURLToPath(new URL('./cli.js', import.meta.url)))
    );
  } catch {
    return false;
  }
}

/** The argv to start stackctl over with, or `null` when it should run as it is. */
export function relaunchArgv(
  execPath: string,
  execArgv: readonly string[],
  argv: readonly string[],
  nodeOptions: string | undefined,
): string[] | null {
  // A cap already given — stackctl's own, after starting over, or one the user chose — stands.
  if (execArgv.some((arg) => arg.startsWith(FLAG)) || nodeOptions?.includes(FLAG)) {
    return null;
  }
  return [execPath, `${FLAG}=${SEMI_SPACE_MB}`, ...execArgv, ...argv.slice(1)];
}

/**
 * Start the process over with the cap, as it was started, when it has none. Returns only when it
 * doesn't: the cap was there, or the process can't start over.
 */
export function relaunchWithCappedYoungGeneration(): void {
  if (typeof process.execve !== 'function' || !isCliEntry(process.argv[1])) {
    return;
  }
  // A process forked with an IPC channel (`startStack()`'s session) would lose it: the channel's
  // descriptor doesn't survive `execve`. Such a parent passes the flag itself.
  if (process.channel) {
    return;
  }
  const argv = relaunchArgv(
    process.execPath,
    process.execArgv,
    process.argv,
    startEnv.NODE_OPTIONS,
  );
  if (!argv) {
    return;
  }
  const cwd = process.cwd();
  try {
    process.chdir(startCwd);
    process.execve(process.execPath, argv, startEnv);
  } catch {
    // Run without the cap.
    process.chdir(cwd);
  }
}
