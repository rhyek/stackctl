import fs from 'node:fs';
import path from 'node:path';
import { currentMode } from '../env-base.js';
import { EventTail, currentEventsPath, fileSize } from '../event-log.js';

// `stackctl events`: the event log of the mode's current session (the running one, else the
// latest), as it is in the file (JSON Lines, for `jq`). Read-only: it never asks the session
// anything.

/** How often `-f` reads the file for new lines. */
const FOLLOW_MS = 250;

/**
 * Prints the last `lines` entries of the current session's event log (all by default), its path
 * with `--path`, and with `-f` every line added after, until the next session starts.
 */
export async function runEvents(opts: {
  lines?: string;
  follow?: boolean;
  path?: boolean;
}): Promise<void> {
  const root = process.cwd();
  const file = currentEventsPath(root, currentMode());
  if (file === null) {
    console.error(`stackctl events: no ${currentMode()} session has run here yet.`);
    process.exit(opts.path ? 1 : 0);
  }
  if (opts.path) {
    console.log(path.relative(root, file));
    process.exit(0);
  }
  const count = opts.lines === undefined ? Infinity : Number(opts.lines);
  if ((!Number.isInteger(count) || count < 0) && count !== Infinity) {
    console.error(`stackctl events: -n takes a whole number, not "${String(opts.lines)}".`);
    process.exit(1);
  }
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    if (!opts.follow) {
      console.error(`stackctl events: no event log yet at ${path.relative(root, file)}.`);
      process.exit(0);
    }
  }
  const lines = text.split('\n').filter(Boolean);
  for (const line of count === Infinity ? lines : lines.slice(lines.length - count)) {
    console.log(line);
  }
  if (!opts.follow) {
    process.exit(0);
  }
  const tail = new EventTail(file, fileSize(file));
  const timer = setInterval(() => {
    // Checked before reading, so the lines the session got before the next one started are printed.
    const followed = currentEventsPath(root, currentMode()) === file;
    for (const line of tail.read()) {
      console.log(line);
    }
    if (!followed) {
      clearInterval(timer);
      console.error(
        `stackctl events: the ${currentMode()} session exited; run stackctl events -f again to follow the next one.`,
      );
      // Once stdout has taken every line: a pipe on macOS writes asynchronously.
      process.stdout.write('', () => process.exit(0));
    }
  }, FOLLOW_MS);
  await new Promise(() => {});
}
