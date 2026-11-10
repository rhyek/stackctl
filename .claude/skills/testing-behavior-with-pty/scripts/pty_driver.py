#!/usr/bin/env python3
r"""
PtyDriver — drive an interactive terminal program through a real pseudo-terminal
so you can press keys and read what it renders, exactly as a human would.

Why this exists: fullscreen TUIs (Ink, ncurses, etc.) only enter interactive
mode when their stdout is a real TTY, and they read keys in the terminal's raw
mode. Pipes don't satisfy either, so you can't drive them with ordinary
subprocess stdin/stdout. A PTY is a kernel-provided terminal pair: give the
*slave* end to the child (it looks like a real terminal), and hold the *master*
end yourself — bytes you write to the master arrive as the child's keystrokes,
and bytes the child "draws" come back when you read the master.

Typical use (see the stackctl example at the bottom, guarded by __main__):

    with PtyDriver(["node", "dist/cli.js"], cwd="/path/to/app") as d:
        d.wait_for("Select services to run")   # sync on an on-screen landmark
        d.press("enter")                        # confirm the selector
        d.wait_for("rebuild", timeout=180)      # run phase is up
        d.press("m")                            # open a menu
        print(d.find_last(r"Commands for (\S+)"))  # read current state

Design notes worth keeping:
  * Synchronize on rendered text (wait_for), never on blind sleeps — build/boot
    timing varies and fixed sleeps are why TUI tests flake.
  * A background thread reads the master continuously into a buffer, so a frame
    is never missed between your polls.
  * text() strips ANSI escapes; the *latest* frame is at the end of the buffer,
    so find_last()/last_line_with() read current state.
"""
from __future__ import annotations

import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import threading
import time
from typing import Optional, Union

# Named keys -> the bytes a terminal actually sends for them. Arrows/nav are
# escape sequences; this is the reference you'd otherwise re-derive every time.
KEYS: dict[str, str] = {
    "up": "\x1b[A",
    "down": "\x1b[B",
    "right": "\x1b[C",
    "left": "\x1b[D",
    "enter": "\r",
    "return": "\r",
    "esc": "\x1b",
    "escape": "\x1b",
    "tab": "\t",
    "space": " ",
    "backspace": "\x7f",
    "delete": "\x1b[3~",
    "home": "\x1b[H",
    "end": "\x1b[F",
    "pageup": "\x1b[5~",
    "pagedown": "\x1b[6~",
    "ctrl-c": "\x03",
    "ctrl-d": "\x04",
}

# Matches the escape sequences a TUI emits to paint the screen (SGR colors,
# cursor moves, alternate-screen switches, OSC titles/hyperlinks). Stripping
# these leaves the plain text you want to assert on. The OSC branch stops at the
# next BEL *or* ST (ESC \) *or* ESC, so an ST-terminated OSC (OSC-8 links, some
# title sequences) can't run greedily across real text to a far-off BEL.
_ANSI = re.compile(
    rb"\x1b\[[0-9;?]*[a-zA-Z]"              # CSI: SGR colors, cursor moves, clears, mode set/reset
    rb"|\x1b[()][A-Z0-9]"                   # charset selection, e.g. ESC(B
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC strings (titles, OSC-8 links), BEL- or ST-terminated
    rb"|\x1b[=>]"                           # keypad application/normal mode
)


class PtyDriver:
    def __init__(
        self,
        cmd: list[str],
        cwd: Optional[str] = None,
        env: Optional[dict] = None,
        rows: int = 50,
        cols: int = 200,
        capture_path: Optional[str] = None,
        max_buffer_bytes: Optional[int] = 1_000_000,
    ):
        self._master, slave = pty.openpty()
        # Set the window size so the UI lays out at a known width/height —
        # otherwise footers wrap or truncate and your text assertions miss.
        fcntl.ioctl(self._master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

        run_env = {**os.environ, "TERM": "xterm-256color"}
        if env:
            run_env.update(env)

        self._proc = subprocess.Popen(
            cmd,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=cwd,
            env=run_env,
            close_fds=True,
            start_new_session=True,  # own process group -> clean killpg() teardown
        )
        os.close(slave)

        self._buf = bytearray()
        # Bound the in-memory buffer so text() stays fast over long, log-heavy
        # sessions (this TUI streams every package's output and repaints at up to
        # 120fps). The FULL transcript is still written to capture_path if given;
        # only the in-memory view is trimmed — from the front, keeping the most
        # recent frames, which is all find_last / last_line_with / wait_for need.
        self._max_buf = max_buffer_bytes
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._cap = open(capture_path, "wb") if capture_path else None
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    # -- reading -----------------------------------------------------------

    def _read_loop(self) -> None:
        while not self._stop.is_set():
            try:
                r, _, _ = select.select([self._master], [], [], 0.2)
                if self._master in r:
                    data = os.read(self._master, 65536)
                    if not data:
                        break
                    with self._lock:
                        self._buf.extend(data)
                        if self._cap:
                            self._cap.write(data)
                            self._cap.flush()
                        if self._max_buf is not None and len(self._buf) > self._max_buf:
                            # Drop oldest bytes, resuming at a line boundary so a
                            # trim never splits a line find_last might read.
                            cut = len(self._buf) - self._max_buf
                            nl = self._buf.find(b"\n", cut)
                            del self._buf[: (nl + 1 if nl != -1 else cut)]
            except OSError:
                break  # master closes with EIO when the child exits

    def text(self) -> str:
        """Recent output, ANSI stripped, newest frame at the end. Bounded to the
        last `max_buffer_bytes` (see __init__); pass a `capture_path` if you need
        the complete transcript on disk."""
        with self._lock:
            b = bytes(self._buf)
        return _ANSI.sub(b"", b).decode("utf-8", "replace")

    def find_last(self, pattern: str, group: int = 1) -> Optional[str]:
        """Last regex match's capture `group` (e.g. the current 'Commands for
        (\\S+)'). Because a redraw re-emits changed text, the last match is the
        current state. `group=0` returns the whole match."""
        last = None
        for last in re.finditer(pattern, self.text()):
            pass
        return last.group(group) if last else None

    def last_line_with(self, needle: str) -> Optional[str]:
        """Last rendered line containing `needle` — handy for the focused row
        (e.g. the line holding the '❯' cursor marker)."""
        lines = [ln.strip() for ln in self.text().replace("\r", "\n").split("\n")]
        hits = [ln for ln in lines if needle in ln]
        return hits[-1] if hits else None

    # -- synchronization ---------------------------------------------------

    def wait_for(
        self, needle: Union[str, re.Pattern], timeout: float = 120.0, poll: float = 0.5
    ) -> bool:
        """Block until `needle` (substring or regex) appears on screen, the
        child exits, or `timeout` elapses. Returns True only if found."""
        deadline = time.time() + timeout
        is_re = isinstance(needle, re.Pattern)
        while time.time() < deadline:
            t = self.text()
            if (needle.search(t) if is_re else needle in t):
                return True
            if self._proc.poll() is not None:
                return False  # child died before the landmark appeared
            time.sleep(poll)
        return False

    @property
    def exited(self) -> bool:
        return self._proc.poll() is not None

    # -- input -------------------------------------------------------------

    def write(self, data: Union[str, bytes]) -> None:
        try:
            os.write(self._master, data if isinstance(data, bytes) else data.encode())
        except OSError:
            pass  # child already gone

    def press(self, *names: str, delay: float = 0.4) -> "PtyDriver":
        """Press keys: named specials from KEYS (`press('down','down','enter')`)
        or a single literal character hotkey (`press('m')`, `press('c')`). A
        multi-character token that isn't a known key name is rejected as a
        likely typo (e.g. 'rihgt') — use `type()` for literal multi-char input."""
        for name in names:
            if name in KEYS:
                self.write(KEYS[name])
            elif len(name) == 1:
                self.write(name)  # a bare hotkey character, e.g. 'm'
            else:
                raise KeyError(f"unknown key {name!r}; known: {', '.join(sorted(KEYS))}")
            time.sleep(delay)
        return self

    def type(self, s: str, delay: float = 0.3) -> "PtyDriver":
        """Type literal text (into a text field, filter, custom command, ...)."""
        self.write(s)
        time.sleep(delay)
        return self

    # -- teardown ----------------------------------------------------------

    def close(self, grace: float = 5.0) -> None:
        self._stop.set()
        try:
            os.killpg(os.getpgid(self._proc.pid), signal.SIGTERM)
        except Exception:
            pass
        try:
            self._proc.wait(timeout=grace)
        except Exception:
            try:
                os.killpg(os.getpgid(self._proc.pid), signal.SIGKILL)
            except Exception:
                pass
        if self._cap:
            self._cap.close()
        try:
            os.close(self._master)
        except Exception:
            pass

    def __enter__(self) -> "PtyDriver":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


# ---------------------------------------------------------------------------
# Example scenario: verify a stackctl run-phase TUI behavior end to end.
# Run:  python3 pty_driver.py /abs/path/to/example
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    app_dir = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    cli = os.path.join(app_dir, "node_modules", "stackctl", "dist", "cli.js")

    with PtyDriver(["node", cli], cwd=app_dir, capture_path="/tmp/pty_capture.txt") as d:
        if not d.wait_for("Select services to run", timeout=30):
            print("FAIL: package selector never appeared")
            sys.exit(1)
        d.press("enter")  # confirm default selection

        if not d.wait_for("rebuild", timeout=180):
            print("FAIL: run phase never reached")
            sys.exit(1)
        print("run phase up")

        d.press("m")  # open the command menu for the focused package
        print("menu header:", d.find_last(r"Commands for (\S+)"))
        before = d.find_last(r"Commands for (\S+)")
        d.press("right")  # switch focused package inside the menu
        after = d.find_last(r"Commands for (\S+)")
        print(f"right: {before} -> {after}  (changed={before != after})")

        d.press("esc")
        d.press("ctrl-c", "ctrl-c")
    print("done; raw capture at /tmp/pty_capture.txt")
