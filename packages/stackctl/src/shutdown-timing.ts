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
 * How long each of a shutdown's two hook steps may take: the `beforeStop` hooks (the session's,
 * then every running service's) before the stop, and the `afterStop` hooks after it. A hook still
 * running when its step's budget is spent is abandoned, its commands ended, and the shutdown
 * goes on.
 */
export const STOP_HOOK_BUDGET_MS = 5_000;

/**
 * The margin the stop itself gets over the per-package grace, for the final SIGKILL sweep: the
 * stop step is bounded by `SHUTDOWN_GRACE_MS + STOP_SWEEP_MARGIN_MS`, kept strictly above the
 * grace so that bound never preempts the graceful wait.
 */
export const STOP_SWEEP_MARGIN_MS = 5_000;

/**
 * What a graceful shutdown's three bounded steps add up to: the `beforeStop` hooks, the stop (the
 * grace plus its sweep margin), the `afterStop` hooks. Nothing enforces it as a whole; each step
 * is bounded on its own. It is the figure the clients derive their timeouts from: a blocking
 * `POST /command/quit` is acknowledged once packages are torn down, so the ack arrives within it.
 */
export const SHUTDOWN_TIMEOUT_MS =
  SHUTDOWN_GRACE_MS + 2 * STOP_HOOK_BUDGET_MS + STOP_SWEEP_MARGIN_MS;

/**
 * Client-side timeout for a **blocking** `POST /command/quit`: the target holds
 * the response open until its packages are torn down and its stop hooks have run (within
 * `SHUTDOWN_TIMEOUT_MS`, what its bounded steps add up to), so the caller waits a touch longer
 * to receive the ack rather than giving up early.
 */
export const QUIT_REQUEST_TIMEOUT_MS = SHUTDOWN_TIMEOUT_MS + 1_000;

/**
 * The control client's default timeout for `POST /command/service/stop/<name>`, which the target
 * answers once the service's process has exited (within `SHUTDOWN_GRACE_MS`, or just after the
 * SIGKILL that ends it) and its `beforeStop` and `afterStop` have finished. Kept above the grace
 * so a service taking all of it still gets its answer; the hooks have no time limit, so a caller
 * that waits for them passes its own signal, as `stackctl service stop` does.
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
 * never force-killed mid-cleanup; only one whose steps overran their bounds is.
 */
export const HANDOFF_FORCE_KILL_MS = SHUTDOWN_TIMEOUT_MS + 3_000;
