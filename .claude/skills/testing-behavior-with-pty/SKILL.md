---
name: testing-behavior-with-pty
description: >-
  Verify interactive terminal-UI behavior by driving the real program through a
  pseudo-terminal (PTY) — pressing actual keystrokes and reading the actual
  rendered frames — instead of only running unit tests or reasoning about the
  code. Use this WHENEVER you make a non-trivial change to stackctl's TUI or any
  interactive terminal UI / keystroke-driven CLI (menus, hotkeys, cursor or
  selection movement, modes like filter/commands, scrolling, the footer,
  live-updating log output) and need to confirm it actually works as the user
  expects. Especially the stackctl fullscreen Ink TUI: the service selector,
  the command (`m`) menu, the log viewport, and per-service hotkeys. Also
  trigger when the user says "verify it works", "make sure it works as
  expected", "test the menu/hotkey/TUI", or when typecheck and unit tests can't
  exercise the real key-input-to-screen behavior. Terminal UIs only — for
  browser/web UIs use browser automation instead.
---

# Testing terminal-UI behavior with a PTY

Unit tests and typecheck confirm the code compiles and pure logic is correct.
They do **not** confirm that pressing `→` in the command menu actually moves the
selection, that the footer re-renders, or that a mode transition looks right.
For a change to an interactive terminal UI, the honest verification is to drive
the **real program** and observe what it renders — this skill is how.

## Why a PTY (and not a pipe or `script`)

A fullscreen TUI (Ink, ncurses, …) only enters interactive mode when its stdout
is a real **TTY**, and it reads keys in the terminal's **raw mode**. Ordinary
`subprocess` pipes satisfy neither, so the app falls back to a non-interactive
"plain" mode (or refuses input entirely). You need something that *looks like a
terminal* to the child but is programmable by you.

A **pseudo-terminal** is exactly that: a kernel-provided master/slave pair.

- Give the **slave** to the child as stdin/stdout/stderr → it believes it's on a
  real terminal and runs the full TUI.
- Hold the **master** yourself → bytes you **write** become the child's
  keystrokes; bytes the child **renders** come back when you **read**.

Do not reach for the macOS/`util-linux` `script` command to feed keystrokes — it
demands a real TTY on *its own* stdin and dies with `tcgetattr/ioctl: Operation
not supported on socket` when fed a pipe/FIFO. Python's built-in `pty` module is
the reliable path (Node has no built-in PTY).

## Use the bundled driver

`scripts/pty_driver.py` packages the whole harness as a reusable `PtyDriver`
class so you don't rebuild it each time. Write a short scenario against it rather
than hand-rolling `openpty`/threads/regex again:

```python
import sys
sys.path.insert(0, "<skill-dir>/scripts")
from pty_driver import PtyDriver

APP = "/Users/you/Dev/.../example"
CLI = f"{APP}/node_modules/stackctl/dist/cli.js"

with PtyDriver(["node", CLI], cwd=APP, capture_path="/tmp/cap.txt") as d:
    d.wait_for("Select services to run")      # sync on a landmark, not a sleep
    d.press("enter")                           # confirm the service selector
    d.wait_for("rebuild", timeout=180)         # run phase is up

    d.press("m")                               # open the command menu
    before = d.find_last(r"Commands for (\S+)")
    d.press("right")                           # switch service inside the menu
    after = d.find_last(r"Commands for (\S+)")
    assert after != before, f"→ did not switch service: {before} -> {after}"
    print(f"OK: right switched {before} -> {after}")

    d.press("esc"); d.press("ctrl-c", "ctrl-c")
```

Run it: `python3 your_scenario.py` (or run `pty_driver.py` directly — it has a
built-in stackctl example under `__main__`). Then **read the printed
transitions** (and `/tmp/cap.txt`) and report what actually happened — that
observed behavior is the verification, so quote it back to the user.

`PtyDriver` API, at a glance:

- `wait_for(needle, timeout=120)` — block until `needle` (substring **or**
  compiled regex) is on screen; returns `False` if the child dies or it times out.
- `press(*keys, delay=0.4)` — named keys: `press("down", "down", "enter")`.
  Names live in `KEYS` (`up/down/left/right/enter/esc/backspace/space/tab/
  home/end/pageup/pagedown/ctrl-c/…`).
- `type(text, delay=0.3)` — literal typing (a filter term, a custom command).
- `find_last(pattern, group=1)` — the last regex match, i.e. **current** state.
- `last_line_with(needle)` — the last line containing `needle`, e.g. the focused
  row holding the `❯` cursor.
- `text()` — recent output (ANSI stripped, newest frame at the end), bounded to
  the last ~1MB so long, log-heavy runs stay fast; pass `capture_path` for the
  full transcript on disk.
- `close()` / context manager — kills the child's whole process group.

## The five things that make it reliable

1. **Synchronize on rendered text, never on blind sleeps.** Build and boot
   timing varies wildly; fixed sleeps are the #1 cause of flaky TUI tests.
   `wait_for("<landmark>")` on a string only the target screen shows.
2. **Set the window size** (the driver defaults to 50×200). A too-narrow
   terminal wraps or truncates the footer and your assertions miss.
3. **Read continuously on a thread.** The driver already does this so a frame
   between polls is never lost; the newest frame is at the end of the buffer,
   which is why `find_last` / `last_line_with` read current state.
4. **Drive it to the right screen first.** A TUI is a phase machine — a key sent
   to the wrong phase is silently dropped. For stackctl: selector → build → run.
   Confirm the selector with `enter` *before* expecting run-phase hotkeys.
5. **Clean up the process group.** The app spawns real child processes (servers,
   watchers). `close()` / the context manager `killpg`s the whole group; if a
   run clashed on a port, an earlier session was still holding it — check
   `lsof -iTCP -sTCP:LISTEN -P | grep :<port>` and confirm no strays after.

## stackctl landmarks

Useful strings to `wait_for` / assert against in this repo's TUI:

- `"Select services to run"` — the service selector (press `enter` to confirm).
- `"rebuild"` — a per-service hotkey hint that only renders in the run phase
  (`NativeRunner`), so it's a good "run phase is up" signal.
- `Commands for (\S+)` — the `m`-menu header; the captured group is the currently
  focused service, so it's how you see `←`/`→` switching services.
- `❯` — the cursor marker on the focused menu row (`last_line_with("❯")`), e.g.
  `❯ > _` is the empty custom-command input row.

The example workspace lives at `example/` and links the package directly, so
after `pnpm build` the freshly built `dist/` is what the CLI runs.

## Deeper reference

`references/key-codes.md` — the full key-byte table, the ANSI-stripping regex
explained, and the concrete gotchas (0-byte captures, `script` failing, wrong
phase) with their fixes. Read it when a scenario behaves unexpectedly or you
need a key not already in `KEYS`.

## Scope

This is for **terminal** UIs. For a browser/web UI, the analogous
"drive-the-real-thing" verification is browser automation (Claude in Chrome),
not a PTY.
