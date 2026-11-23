import { type EventBy, type OneOffCommandEntry, cliEventLog, maskSecrets } from '../event-log';
import type { OneOffAsk, OneOffWhere } from './resolve';

// A one-off command's two lines in the session's event log: what the CLI's `exec`/`run` and the
// SDK's `exec()`/`run()` write, in either form.

/** What writes a one-off command's `end` line, once it is done. */
export interface OneOffEntry {
  end(result: { ok: boolean; exitCode: number | null; signal: NodeJS.Signals | null }): void;
}

/**
 * What writes the `begin` line of a command running `ask`, where it runs, to the profile's
 * session event log, as `by`, and returns its {@link OneOffEntry}. Inside a command stackctl runs
 * (`nested`), that command is the one recorded, so nothing is written.
 */
export function oneOffRecorder(
  ask: OneOffAsk,
  log: { root: string; profile: string; nested: boolean; by: EventBy },
): (where: OneOffWhere) => OneOffEntry {
  if (log.nested) {
    return () => ({ end: () => {} });
  }
  const events = cliEventLog(log.root, log.profile);
  const what =
    ask.kind === 'exec'
      ? { command: maskSecrets(ask.command) }
      : { script: ask.script, args: maskSecrets(ask.args) };
  return (where) =>
    events.begin<OneOffCommandEntry>(
      { type: 'one-off-command', kind: ask.kind, ...where, ...what },
      log.by,
    );
}
