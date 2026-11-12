import fs from 'node:fs';
import path from 'node:path';
import { currentMode } from '../env-base.js';
import { EventTail, eventsFilePath, fileSize } from '../event-log.js';

// `stackctl events`: the mode's event log, as it is in the file (JSON Lines, for `jq`), a session
// running or not. Read-only: it never asks the session anything.

/** How often `-f` reads the file for new lines. */
const FOLLOW_MS = 250;

/**
 * Prints the last `lines` entries of the mode's event log (all by default), its path with
 * `--path`, and with `-f` every line added after, until interrupted.
 */
export async function runEvents(opts: {
  lines?: string;
  follow?: boolean;
  path?: boolean;
}): Promise<void> {
  const root = process.cwd();
  const file = eventsFilePath(root, currentMode());
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
  setInterval(() => {
    for (const line of tail.read()) {
      console.log(line);
    }
  }, FOLLOW_MS);
  await new Promise(() => {});
}
