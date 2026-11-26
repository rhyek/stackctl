// What stackctl tells a developer to do about a service one of its start hooks failed. One wording,
// wherever it is said: the log, the status, a wait, the dev reverse proxy's page.

/** The command that restarts `service` in the running session. */
export function restartCommand(service: string): string {
  return `stackctl service restart -s ${service}`;
}

/**
 * What every such advice ends with: a running session keeps the config it loaded, hooks included,
 * so a restart of the service runs the hook as it was when the session started.
 */
export const CONFIG_CHANGE_NOTE = 'a change to stackctl.config.ts needs a new session';

/**
 * How to retry `service` once what failed its hook is fixed, as a sentence without its period:
 * `Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a
 * new session`. The command sits mid-sentence, so a copy of it carries no punctuation.
 */
export function retryAdvice(service: string): string {
  return `Run ${restartCommand(service)} once it is fixed; ${CONFIG_CHANGE_NOTE}`;
}
