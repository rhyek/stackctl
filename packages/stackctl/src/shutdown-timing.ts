/**
 * Shutdown timing constants, shared by the process manager (which owns the
 * per-package grace), the runners (which bound the whole graceful shutdown), the
 * control client, and the session handoff. Kept in one place so the derived
 * relationships below stay in lockstep instead of drifting as separate literals.
 */

/**
 * Per-package grace: after SIGTERM (a stop, a restart, or a full shutdown), how
 * long to wait for a process group to exit on its own before escalating to
 * SIGKILL.
 */
export const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Upper bound on how long a runner's graceful shutdown may take before it exits
 * anyway, so a second Ctrl+C never blocks on a stuck child. Derived from the
 * per-package grace plus a margin for `shutdownAll`'s final SIGKILL sweep — kept
 * strictly above `SHUTDOWN_GRACE_MS` so this safety net never preempts the
 * graceful wait. A blocking `POST /command/quit` is acknowledged once packages
 * are torn down, so the ack arrives within this bound.
 */
export const SHUTDOWN_TIMEOUT_MS = SHUTDOWN_GRACE_MS + 5_000;

/**
 * Client-side timeout for a **blocking** `POST /command/quit`: the target holds
 * the response open until its packages are torn down (up to `SHUTDOWN_TIMEOUT_MS`),
 * so the caller must wait a touch longer than the target's own bound to receive
 * the ack rather than giving up early.
 */
export const QUIT_REQUEST_TIMEOUT_MS = SHUTDOWN_TIMEOUT_MS + 1_000;

/**
 * Client-side timeout for `POST /command/service/stop/<name>`, which the target answers once
 * the service's process has exited: within `SHUTDOWN_GRACE_MS`, or just after the SIGKILL that
 * ends it. Kept above the grace so a service taking all of it still gets its answer.
 */
export const SERVICE_STOP_REQUEST_TIMEOUT_MS = SHUTDOWN_GRACE_MS + 2_000;

/**
 * Client-side timeout for `POST /command/service/start/<name>`, which the target answers once
 * the service has started — which can take a while when the start adds it to the session.
 */
export const SERVICE_START_REQUEST_TIMEOUT_MS = 300_000;

/**
 * How long a handoff waits — measured from when it first asked the old instance
 * to quit — for that instance's process to actually vanish before force-killing
 * its tree. Sits above `SHUTDOWN_TIMEOUT_MS` so an instance taking its full
 * graceful window (plus the moment it needs to close its server and exit) is
 * never force-killed mid-cleanup; only one that overruns its own safety net is.
 */
export const HANDOFF_FORCE_KILL_MS = SHUTDOWN_TIMEOUT_MS + 3_000;
