/** What a thrown value says: an error's message, anything else as a string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The CLI's last resort for a command that rejects: prints what was thrown on stderr as one line,
 * an error as `Error: <message>` without its stack, and exits with its own `exitCode` when it
 * carries a non-zero one, else 1.
 */
export function exitOnFatalError(err: unknown): never {
  console.error(String(err));
  const code = (err as { exitCode?: unknown } | null)?.exitCode;
  process.exit(typeof code === 'number' && Number.isInteger(code) && code !== 0 ? code : 1);
}
