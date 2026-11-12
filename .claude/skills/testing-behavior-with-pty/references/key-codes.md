# Reference: key codes, ANSI stripping, and gotchas

Read this when a scenario misbehaves or you need a key that isn't already in
`KEYS`.

## Key → bytes

Terminals encode ordinary characters as themselves, but special keys as escape
sequences. These are the ones `pty_driver.py`'s `KEYS` map already covers; the
table is here so you can add or debug others.

| Key | Bytes (Python literal) | Notes |
|---|---|---|
| a–z, 0–9, punctuation | the character itself | e.g. `d.type("npm run x")` |
| ↑ / ↓ | `\x1b[A` / `\x1b[B` | "cursor up/down" |
| → / ← | `\x1b[C` / `\x1b[D` | "cursor forward/back" |
| Enter / Return | `\r` | carriage return, **not** `\n` |
| Esc | `\x1b` | a lone ESC; apps use a short timeout to tell it from a sequence |
| Tab | `\t` | |
| Space | ` ` | 0x20 |
| Backspace | `\x7f` | DEL; some apps also accept `\x08` (Ctrl-H) |
| Delete (forward) | `\x1b[3~` | |
| Home / End | `\x1b[H` / `\x1b[F` | some terminals send `\x1b[1~` / `\x1b[4~` |
| Page Up / Page Down | `\x1b[5~` / `\x1b[6~` | |
| Ctrl-C | `\x03` | SIGINT-as-keystroke; stackctl handles it in-app |
| Ctrl-D | `\x04` | EOF |
| Ctrl-<letter> | `chr(ord(letter) - 96)` | Ctrl-A=`\x01` … Ctrl-Z=`\x1a` |

To discover an unknown key's bytes, run `cat -v` (or `sed -n l`) in a real
terminal and press the key — it prints the sequence (e.g. `^[[C` = `\x1b[C`).

## ANSI stripping

A TUI paints by emitting escape sequences interleaved with text. To assert on
what a human *reads*, strip the sequences. The regex in `pty_driver.py`:

```python
_ANSI = re.compile(
    rb"\x1b\[[0-9;?]*[a-zA-Z]"              # CSI: colors (SGR), cursor moves, clears, mode set/reset
    rb"|\x1b[()][A-Z0-9]"                   # charset selection, e.g. ESC(B
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC strings (titles, OSC-8 links), BEL- or ST-terminated
    rb"|\x1b[=>]"                           # keypad application/normal mode
)
```

The OSC branch stops at the next BEL **or** ST (`ESC \`) **or** ESC. That matters:
an earlier version terminated only on BEL with `[^\x07]*`, so an ST-terminated
OSC (OSC-8 links, some title sequences) would match nothing at its own terminator
and instead run greedily to a far-off BEL — silently deleting the real screen
text in between. Stopping at ESC also keeps one OSC from swallowing a following
escape sequence.

It deliberately does **not** interpret cursor-positioning to reconstruct a 2-D
screen grid — it just removes escapes and keeps the text in emission order. That
is enough for substring/regex assertions because a redraw re-emits the changed
text, and the **newest frame is at the end of the buffer**. So:

- `find_last(r"Commands for (\S+)")` → the *current* menu header.
- `last_line_with("❯")` → the *current* focused row.

**But this only works for *positive* assertions.** Because the buffer retains
many recent frames (not just the current one), `text()` still contains state that
has since been redrawn away — so you cannot conclude "X is gone" from
`"X" not in d.text()` (it will still be there from a moment ago). To assert a thing *closed* or *disappeared*,
`wait_for` a landmark of the **new** state instead (e.g. after `esc` closes the
`m`-menu, wait for a run-phase-only line, don't test that `Commands for` is
absent). For true "what's on screen right now" (negative checks, exact column
alignment), feed the raw capture through a terminal-emulator library such as
`pyte`, which maintains an actual screen grid.

## Gotchas seen in practice (and the fix)

**`script: tcgetattr/ioctl: Operation not supported on socket`.** The `script`
utility wants a real TTY on its own stdin; a pipe/FIFO isn't one. Don't use
`script` to inject keystrokes — use the `pty` module (this skill's whole point).

**0-byte capture / child exits instantly.** The app died before rendering,
almost always a **port clash**: a previous run or another session still holds
the dev/control port. Check and clear:

```bash
lsof -iTCP -sTCP:LISTEN -P | grep -E ':(21060|3001|3002)'   # stackctl example ports
pgrep -fl "stackctl/dist/cli.js"
```

Wait for them to be free (the driver's `close()` `killpg`s the group, but a
crashed prior run may have leaked). Re-run once clean.

**Keys seem ignored.** You're on the wrong phase. A TUI is a phase machine and a
key sent to a screen that doesn't handle it is silently dropped. For stackctl:
`wait_for("Select services to run")` → `press("enter")` → `wait_for("rebuild")`
**before** sending run-phase hotkeys like `m`.

**Footer text is wrapped/truncated in the capture.** The window is too small.
Increase `PtyDriver(..., rows=, cols=)` (default 50×200). Layout is driven by the
`TIOCSWINSZ` ioctl the driver sets on the master fd.

**`OSError: [Errno 5] Input/output error` on write.** The child (and its pty
slave) already exited, so the master gives EIO. Expected after `ctrl-c`; the
driver swallows it in `write()`. If it happens mid-scenario, the app crashed —
inspect the capture tail to see why.

**Flaky timing.** Replace any `time.sleep(n)` you added with a `wait_for` on a
landmark that the expected next state renders. Only fall back to a fixed delay
for a genuinely un-observable settle (e.g. letting a one-key redraw paint), and
keep it small.

## Interpreting results honestly

The point of the exercise is observed behavior, so:

- Assert on transitions (`before != after`), and **print both sides** so the log
  itself is the evidence.
- Quote the actual captured transitions back to the user rather than asserting
  "it works" — e.g. the header going `web → api → worker → isomorphic`.
- If a step didn't do what you expected, say so and show the capture; a PTY run
  that contradicts your assumption is the most valuable outcome it can produce.
