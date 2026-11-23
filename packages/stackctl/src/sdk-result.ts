import fs from 'node:fs';
import { RESOLVE_ENV_FD } from './env-base';
import { findPassthrough } from './infra/argv';

// How a CLI command hands its result to the SDK function that ran it: the SDK passes
// `--sdk-result`, and the command writes its result as JSON to descriptor 3, which only that
// function opens. On a terminal nobody passes the flag, and nothing is written.

/** The hidden flag the SDK passes. Never listed in `--help`. */
export const SDK_RESULT_FLAG = '--sdk-result';

let requested = false;

/**
 * Takes the flag out of `argv`, so Commander never sees it, and remembers it was there. Only
 * where the SDK puts it: last, with no `--` or `infra docker-compose` before it, whose arguments
 * are the user's own command's; and only with descriptor 3 open for it. Anywhere else it is left
 * for Commander, which turns it away as an unknown option.
 */
export function takeSdkResultFlag(argv: string[]): boolean {
  const last = argv.length - 1;
  if (
    argv[last] === SDK_RESULT_FLAG &&
    !argv.includes('--') &&
    findPassthrough(argv) === -1 &&
    resultChannelOpen()
  ) {
    argv.splice(last, 1);
    requested = true;
  }
  return requested;
}

/**
 * Whether descriptor 3 is the channel an SDK function opened: a socket, as Node opens a child's
 * piped descriptor. Node holds a descriptor 3 of its own in a process started without one,
 * which takes no write.
 */
function resultChannelOpen(): boolean {
  try {
    return fs.fstatSync(RESOLVE_ENV_FD).isSocket();
  } catch {
    return false;
  }
}

/** Whether an SDK function ran this command and waits for its result. */
export function sdkResultRequested(): boolean {
  return requested;
}

/** Writes `value` as the command's result, when an SDK function asked for one. */
export function writeSdkResult(value: unknown): void {
  if (requested) {
    fs.writeSync(RESOLVE_ENV_FD, JSON.stringify(value));
  }
}
