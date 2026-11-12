# Exiting stackctl

How a stackctl session shuts down, in the TUI and headless. This is a **contributor** document.
Two hard requirements drive the design:

1. **No lingering processes.** Every child dev process, one-off and infra action, and the control
   server, proxy and watchers, must be torn down before the process exits — whether the exit was
   asked for by the keyboard, a signal or the control API.
2. **Leave a trace.** The TUI runs in the terminal's alternate screen, which is restored to its
   pre-launch state on exit — so without help, stackctl would vanish without evidence it ran. The
   session is bookended with a line on the primary screen before it takes over and one after it
   tears down.

Related: the rendering model (alternate screen, why the shutdown frame collapses, the root
`overflow: hidden`) is in [`./rendering.md`](./rendering.md).

## Who owns what

- **`Session.shutdown(reason)`** (`session/session.ts`) is **the one shutdown path**. It stops the
  processes, closes the proxy, acknowledges a held `/command/quit`, closes the control server and
  the logfile, and settles `session.closed` with the exit code. TUI, headless and `startStack()`
  all end through it.
- **The screen** (`tui/shutdown.ts`, `tui/RunScreen.tsx`) never shuts anything down itself. It
  follows the session's snapshot: when the phase turns `stopping`, from any trigger, it releases
  the mouse and collapses; when `closed` settles, it unmounts Ink (or hard-exits).
- **The app shell** (`tui/App.tsx`, `tui/app-exit.ts`) writes the bookend lines and exits the
  process once Ink has unmounted.
- **Headless** (`session/headless.ts` `runHeadless`) awaits `closed` and exits with its code.

## Exit triggers

| Trigger                                   | Path                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Ctrl+C, or a click on `^c quit`**       | `keymap` → `ui-state` `quit`: while the phase is `running`, the first press arms a 2 s confirmation (`QUIT_CONFIRM_MS`) and its toast; a second within it emits `shutdown` → `actions.ts` → `session.requestQuit({ kind: 'ui', key: '^c' }, 'user')`, which writes the quit's `begin` line and runs `shutdown('user')` |
| **Ctrl+C during startup or after a failed startup** | `ui-state` `quit` with the phase not `running`: `shutdown` at once, no confirmation                                          |
| **`SIGHUP` / `SIGINT` / `SIGTERM`**       | `installShutdownSignals`, installed at the very start of `Session.start()` (before the takeover) → `shutdown('signal')`                |
| **Control API `/command/quit`**           | the control server's `quitHandler`, with the request as `by` → `requestQuit(by, 'quit')`; the response is held until the session acks it |
| **Headless startup failure**              | `runHeadless` sees the phase `failed` after `start()` → `shutdown('startup-failed')`                                                   |
| **A second request while shutting down**  | any of the above re-entering `shutdown()` → the hard kill (below)                                                                     |

Only the keystroke in a running session asks twice: a signal or a quit request shuts down at
once, as does a quit during startup or after a startup failure.

**Before a session exists.** The takeover question is asked (clack) in `commands/session.ts`
before Ink mounts, and a refusal exits there. While the picker is up there is no session: `App`
installs signal handlers that just unmount Ink, Ctrl+C in the picker unmounts it too, and
`finish` prints the exit line and exits 0. Those handlers are removed in the commit that mounts
the run screen, before its session installs its own.

## The graceful sequence: `Session.shutdown`

In order:

1. **Re-entry.** If the shutdown is already done, return. If one is in progress, this is the
   second request: unless the reason is `startup-failed` (a follow-up, never an escalation),
   `killEverything()` — SIGKILL to every process group the session has, those still in their
   grace period included (`waitedGroups`, filled at step 3 so a leader that has already exited
   still has its group reached) — and settle `closed` with **1** at once.
2. **Mark closing.** `closing = true`, the phase `stopping`, a snapshot notification. From here
   nothing new spawns: every spawn path in `Supervisor` and `InfraControl.run` checks its closing
   flag, so a restart awaiting its stop, a control-API start, or an infra action's next step
   can't start a process after the sweep. The branch watch and the memory sampler stop.
3. **Collect the groups.** The supervisor's process groups and the infra control's living
   commands (`takeLiving()`); `[stackctl] [WARN] shutting down...` when there is anything to wait
   on.
4. **Stop the children**, bounded: SIGTERM to the infra commands' groups, then
   `bounded(Promise.all([supervisor.stopAll(), bounded(infra, SHUTDOWN_GRACE_MS)]),
   SHUTDOWN_TIMEOUT_MS)`. `stopAll()` SIGTERMs each service's group, waits up to
   `SHUTDOWN_GRACE_MS` (10 s), then SIGKILLs; a stop already under way is waited out with the rest.
   The outer `SHUTDOWN_TIMEOUT_MS` (15 s) is kept above the grace, so a stuck child can't hang the
   exit but the graceful wait still runs in full (constants in `shutdown-timing.ts`).
5. **Sweep the groups** with SIGKILL: a quick leader can leave members of its group behind.
6. **Let a startup step under way settle.** A shutdown during startup waits for the step in
   flight (takeover, proxy, control server — not infra), bounded by that step's own deadlines, and
   closes what it produced below.
7. **Close the proxy** (bounded by `CLOSE_STEP_MS`).
8. **Write the end to the event log**: a quit's `end` line, then `session-end`, and
   `server.flush()` sends them to the open `/events` streams before they close.
9. **Ack a held quit, then close the control server.** `server.ackQuit()` answers a blocking
   `POST /command/quit` with `200` now that the services are down and their ports freed — so a
   newer session taking over knows the ports are clear *before* this server closes. Then
   `server.close()`, bounded.
10. **Release** the signal handlers and the `process.on('exit')` hook, and close the logfile,
   bounded.
11. **Settle `closed`** with **0**, or **1** after a hard kill, after a failed startup, or for a
    `startup-failed` reason.

Every close step is bounded, so one stalled close can't keep the session from settling. The
`process.on('exit')` hook (`killEverything`) is the backstop for an exit by any other path while
the session runs: it takes every group down with the process.

## The screen's part

`useShutdown(session, stdout)` (`tui/shutdown.ts`), the first hook `RunScreen` calls, so its
subscription runs before the collapse renders:

1. **Release the mouse.** When the snapshot's phase turns `stopping`, write `MOUSE_DISABLE` once,
   before the UI collapses.
2. **Collapse.** `RunScreen` renders a single non-fullscreen line,
   `Shutting down… (press Ctrl+C again to force kill)`. A fullscreen final frame would make Ink
   clear the screen on unmount and can leave a blank block on the restored primary screen.
   While stopping, every key but Ctrl+C is ignored and clicks do nothing.
3. **When `closed` settles:**
   - after a hard kill (`session.hardKilled`): `hardExit(1)` — write `MOUSE_DISABLE`, leave the
     alternate screen and show the cursor, then `process.exit(1)` at once. Ink doesn't unmount on
     this path, so no exit line prints.
   - otherwise: arm the **safety net** (`EXIT_SAFETY_NET_MS`, 5 s → `hardExit(code)`) and call
     Ink's `exit()`. The unmount restores the primary screen and resolves `waitUntilExit`. In the
     normal path the exit line prints within milliseconds and the net never fires.

## Process exit and the bookend lines

`renderApp` (`tui/App.tsx`) wraps the whole TUI:

- It pins the tab title, writes **`▶ stackctl started`** to the primary screen *before* Ink enters
  the alternate screen (so it's saved with the primary buffer and reappears on restore), and
  mounts with `alternateScreen: true` and `exitOnCtrlC: false`.
- **`installTerminalRestore()`** adds a `process.on('exit')` writer that releases the mouse, leaves
  the alternate screen and shows the cursor, for an exit by any path but Ink's own unmount. It is
  removed once Ink has left the alternate screen: running it after the exit line would move the
  cursor over it.
- **`crashRestore`** listens on `uncaughtExceptionMonitor`. On a fatal error (one no other
  `uncaughtException` handler or capture callback takes — the workspace's config runs in process,
  and an error reporter it imports may keep stackctl up) it unmounts Ink first, so Node prints the
  error on the primary screen, then drops the exit writer.
- **`waitUntilExit()`** resolves only after Ink's teardown, with the primary screen restored. Then
  `finish(shell, crash, startedAt)` (`tui/app-exit.ts`):
  - **from the picker**, no session: the exit line alone, exit 0;
  - **the session for the picks couldn't be made, or the picker crashed**: `stackctl: <message>`
    on stderr, exit 1;
  - **from the run screen**: if the session isn't already stopping (Ink went first — a render
    crash), print the error and run `shutdown('user')` here; await `closed`; write the exit line
    and the logfile (`session.getLogFile()`), dim, through
    `displayLogFile`; exit with the session's code, or 1 after a crash.

  Each write exits from its flush callback, so the line is out before the process dies.

Result on the primary screen after a session:

```
> pnpm dev
▶ stackctl started
■ stackctl exited after 2 hours 14 minutes
  logfile: node_modules/.stackctl/modes/development/logs/1794149236103-80141-1.log
>
```

## Headless

`--headless` (and `startStack()`'s forked session) uses no alternate screen and no bookend lines.
`runHeadless` starts the session, prints its log through a printer subscribed to the `LogStore`,
and, when `start()` ends with the phase `failed`, calls `shutdown('startup-failed')`. It awaits
`closed`, flushes the printer, drains stdout and stderr, and exits with the code: 0 after a
graceful shutdown, 1 after a hard kill or a failed startup. The same `Session.shutdown` runs, so a
blocking `/command/quit` (and thus a handoff) works identically.

## Invariants to preserve

- **One shutdown path.** Every trigger calls `Session.shutdown`. Don't fork it — a blocking
  `/command/quit` is served by that one path calling `server.ackQuit()`, not by a second handler;
  the screen follows the phase rather than tearing anything down itself.
- **In force from the first moment.** The signal handlers and the exit hook are installed at the
  start of `Session.start()`, before the takeover. A signal during any startup step runs the
  shutdown, which lets the step under way settle and closes what it produced; nothing after it
  starts.
- **Cleanup before exit, always.** Children down, proxy and server closed, logfile closed — all
  before `closed` settles, and so before Ink unmounts or the process exits.
- **Ack the blocking quit between children-down and server-close.** `ackQuit()` runs *after* the
  children are down (so the ack means "ports freed") and *before* `server.close()` (so the held
  response socket is still writable). A handoff relies on that ordering.
- **Nothing spawns once closing.** Every spawn path checks the closing flag.
- **A second request is a hard kill** — SIGKILL to every group, those in their grace period
  included, `closed` settled with 1, the terminal restored, `process.exit(1)` with no waiting and
  no exit line. A `startup-failed` follow-up never escalates.
- **The process always exits.** Ink's unmount → `finish` is the normal exit; the safety net,
  armed once the session has closed, is the fallback. Every close step before it is bounded.
- **The exit line prints after `waitUntilExit`**, never before — otherwise it lands on the
  alternate screen and is discarded on restore.
- **Release the mouse and the screen on every exit path.** SGR mouse reporting is on while the
  picker or the run screen is mounted. `useMouse`'s cleanup (every unmount, the picker's included),
  `useShutdown` at `stopping`, `hardExit`, and the exit writer all write `MOUSE_DISABLE`; the last
  two also leave the alternate screen and show the cursor.
- **Ctrl+C asks once, then exits** — only in a running session. The confirmation window and its
  toast share `QUIT_CONFIRM_MS`. Signals and a quit request never ask.
- **Quitting after a failed startup exits 1**, in the TUI and headless.

## File map

| Concern                                                         | Where                     |
| --------------------------------------------------------------- | ------------------------- |
| The one shutdown path, startup order, `closed`, the exit hook   | `session/session.ts`      |
| Stopping services (`stopAll`), the closing flag                 | `session/supervisor.ts`   |
| One process: SIGTERM to its group, SIGKILL after the grace      | `session/service-process.ts` |
| Infra actions' living commands, their closing flag              | `infra/control.ts`        |
| Signal routing (`SIGHUP`/`SIGINT`/`SIGTERM`)                    | `signals.ts`              |
| Quit's confirmation, the quit effect                            | `tui/ui-state.ts`, `tui/actions.ts` |
| Mouse release, collapse follow-up, safety net, `hardExit`       | `tui/shutdown.ts`         |
| The collapse line                                               | `tui/RunScreen.tsx`       |
| Bookend lines, terminal restore, crash restore, `waitUntilExit` | `tui/App.tsx`, `tui/app-exit.ts` |
| Headless exit                                                   | `session/headless.ts`     |
| Control-API quit (`quitHandler` / `setQuitHandler` / `ackQuit`, held response) | `control-server.ts`  |
| Shutdown timing constants (grace, timeout, handoff)             | `shutdown-timing.ts`      |
| Handoff (blocking quit + pid-poll + force-kill)                 | `session-takeover.ts`     |
