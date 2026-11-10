/**
 * The signals that must end a dev session gracefully rather than killing stackctl outright.
 *
 * `SIGHUP` is the one that matters most, and the one that's easiest to miss. It's what a closing
 * terminal window, a killed tmux pane, or a dropped SSH connection delivers. With no handler Node
 * takes the default disposition and dies immediately: `process.on('exit')` does **not** run, so
 * the session's exit hook never fires and nothing kills the packages. And because packages
 * are spawned `detached: true` — each in its own process group — the terminal's hangup never
 * reaches them either. Detaching, which is what lets stackctl kill a whole `sh → node → node`
 * tree by process group, also shields that tree from the hangup that killed its parent.
 *
 * The result is the entire subtree reparenting to PID 1, one fresh generation of orphans per
 * closed terminal, each still holding its file descriptors and recursive file watches.
 *
 * `SIGKILL` cannot be trapped, so it is deliberately absent here; that case is covered on the next
 * startup by the recorded-child sweep in `session-takeover.ts`.
 */
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGHUP', 'SIGINT', 'SIGTERM'];

/**
 * Routes every {@link SHUTDOWN_SIGNALS} entry to `onShutdown`, returning a disposer that removes
 * the handlers again. `onShutdown` is expected to be idempotent-ish: both runners treat a second
 * call as "the user is impatient" and escalate to a hard kill, which is the desired behavior for a
 * repeated signal too.
 */
export function installShutdownSignals(onShutdown: (signal: NodeJS.Signals) => void): () => void {
  const installed = SHUTDOWN_SIGNALS.map((signal) => {
    const handler = () => onShutdown(signal);
    process.on(signal, handler);
    return { signal, handler };
  });
  return () => {
    for (const { signal, handler } of installed) {
      process.off(signal, handler);
    }
  };
}
