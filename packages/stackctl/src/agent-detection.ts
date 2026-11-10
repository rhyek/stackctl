/**
 * Whether stackctl was started by a coding agent rather than by a person at a keyboard.
 *
 * Agents run shell commands through a non-interactive child shell, and every mainstream
 * one marks that shell with an environment variable — the same trick `CI=true` plays. No
 * standard exists yet (the `AGENT` proposal is still open), so this is a list, not a rule.
 *
 * The check is **set and non-empty**, never a value match: the values are wildly
 * inconsistent (`CLAUDECODE=1`, `CODEX_SANDBOX=seatbelt`, `AGENT=goose`), and a future
 * version changing its value shouldn't silently turn detection off.
 *
 * Deliberately excluded are variables an *editor* sets while a human drives the terminal —
 * `COPILOT_DEBUG_NONCE`, `TERM_PROGRAM=vscode`, and friends. They say "an AI tool is
 * installed", not "an agent is at the wheel", and a false positive here is the expensive
 * direction: it would let one agent's session auto-kill a *person's* running session, which
 * is the exact thing the takeover prompt exists to prevent.
 */

/** Environment variables that mean "a coding agent is running this command". */
export const AGENT_ENV_VARS = [
  'CLAUDECODE', // Claude Code
  'CURSOR_AGENT', // Cursor
  'GEMINI_CLI', // Gemini CLI
  'CODEX_SANDBOX', // Codex CLI
  'AUGMENT_AGENT', // Augment
  'CLINE_ACTIVE', // Cline
  'OPENCODE_CLIENT', // OpenCode
  'TRAE_AI_SHELL_ID', // TRAE AI
  'AGENT', // Goose, Amp — and the proposed cross-agent standard
  'AI_AGENT', // the `detect-agent` convention
] as const;

/**
 * Forces the answer, whatever the environment says. `0`/`false`/`no` force "not an agent";
 * any other non-empty value forces "agent". The escape hatch for a shell where one of the
 * generic names above (`AGENT`, most likely) is set for an unrelated reason.
 */
export const AGENT_OVERRIDE_ENV_VAR = 'STACKCTL_STARTED_BY_AGENT';

/** Pure form, for tests and for anywhere an explicit environment is on hand. */
export function detectAgent(env: NodeJS.ProcessEnv): boolean {
  const override = env[AGENT_OVERRIDE_ENV_VAR];
  if (override !== undefined && override !== '') {
    return !['0', 'false', 'no'].includes(override.toLowerCase());
  }
  return AGENT_ENV_VARS.some((name) => {
    const value = env[name];
    return value !== undefined && value !== '';
  });
}

/**
 * Snapshotted at import — before any config or `.env` file is loaded — so the answer
 * describes the shell stackctl was launched from and can't be moved by a package's
 * environment.
 */
const STARTED_BY_AGENT = detectAgent(process.env);

/** Whether *this* process was started by a coding agent. */
export function startedByAgent(): boolean {
  return STARTED_BY_AGENT;
}
