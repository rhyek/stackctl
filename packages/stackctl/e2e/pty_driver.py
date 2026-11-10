#!/usr/bin/env python3
r"""
A pseudo-terminal relay for the e2e suite: runs one program on a real PTY and relays its bytes, so
a test written in TypeScript (Node.js has no PTY of its own) can drive a fullscreen TUI the way a
person does. Standard library only.

A fullscreen TUI (Ink here) is interactive only when its stdout is a TTY, and it reads keys in the
terminal's raw mode; a pipe satisfies neither. A PTY is a kernel terminal pair: the program gets
the slave end as its stdin, stdout and stderr, and this relay holds the master end. Bytes written
to the master arrive as the program's keystrokes, and what the program draws comes back on it.

Usage:  python3 -B -u pty_driver.py <rows> <cols> -- <command> [args...]

The command runs in this process's working directory and environment, plus TERM=xterm-256color
and E2E_DRIVER_PID (this relay's pid, so a fixture process can tell when the run it belongs to is
gone). It gets its own session and process group.

- stdout: every byte the program writes to the terminal, unchanged.
- stdin: one JSON request per line:
    {"op": "write", "data": "<base64>"}        bytes to type into the terminal
    {"op": "resize", "rows": 40, "cols": 100}  a new window size, and SIGWINCH to the group
    {"op": "signal", "name": "SIGTERM"}        a signal to the program itself
- fd 3: one JSON event per line:
    {"event": "spawned", "pid": 123}                       once the program is running
    {"event": "exit", "code": 0, "signal": null}           once it has exited and its output is read

The relay exits once it has reported the program's exit. If its stdin closes first (the test
process is gone), or it gets SIGTERM or SIGHUP, it ends the program's process group: SIGTERM, then
SIGKILL after a grace period.
"""
from __future__ import annotations

import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

GRACE_SECONDS = 10.0
# Output still arriving after the program exits (the last frame, the exit line) is read until the
# terminal closes or stays quiet this long; a grandchild holding the terminal open can't hold the
# report up forever.
DRAIN_QUIET_SECONDS = 0.5


def set_size(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main() -> int:
    argv = sys.argv[1:]
    if len(argv) < 4 or argv[2] != "--":
        print("usage: pty_driver.py <rows> <cols> -- <command> [args...]", file=sys.stderr)
        return 2
    rows, cols, cmd = int(argv[0]), int(argv[1]), argv[3:]
    events = os.fdopen(3, "w", buffering=1)
    out = sys.stdout.buffer

    master, slave = pty.openpty()
    set_size(master, rows, cols)
    env = {**os.environ, "TERM": "xterm-256color", "E2E_DRIVER_PID": str(os.getpid())}
    proc = subprocess.Popen(
        cmd,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        close_fds=True,
        start_new_session=True,  # its own process group, ended as one
    )
    os.close(slave)
    events.write(json.dumps({"event": "spawned", "pid": proc.pid}) + "\n")

    def end_group(*_args: object) -> None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except OSError:
            pass
        deadline = time.time() + GRACE_SECONDS
        while proc.poll() is None and time.time() < deadline:
            time.sleep(0.05)
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        sys.exit(1)

    signal.signal(signal.SIGTERM, end_group)
    signal.signal(signal.SIGHUP, end_group)

    stdin = sys.stdin.buffer
    pending = b""
    master_open = True
    exited_at: float | None = None
    last_output = time.time()

    while True:
        if exited_at is None and proc.poll() is not None:
            exited_at = time.time()
        if exited_at is not None and (
            not master_open or time.time() - last_output >= DRAIN_QUIET_SECONDS
        ):
            break
        watched = [stdin] + ([master] if master_open else [])
        readable, _, _ = select.select(watched, [], [], 0.05)
        if master_open and master in readable:
            try:
                data = os.read(master, 65536)
            except OSError:  # EIO once every holder of the slave end has closed it
                data = b""
            if data:
                out.write(data)
                out.flush()
                last_output = time.time()
            else:
                master_open = False
        if stdin in readable:
            chunk = os.read(stdin.fileno(), 65536)
            if not chunk:
                end_group()
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                if line.strip():
                    handle(json.loads(line), master, proc)

    code = proc.returncode
    events.write(
        json.dumps(
            {
                "event": "exit",
                "code": code if code >= 0 else None,
                "signal": signal.Signals(-code).name if code < 0 else None,
            }
        )
        + "\n"
    )
    events.close()
    os.close(master)
    return 0


def handle(request: dict, master: int, proc: subprocess.Popen) -> None:
    op = request.get("op")
    if op == "write":
        try:
            os.write(master, base64.b64decode(request["data"]))
        except OSError:
            pass  # the program is gone
    elif op == "resize":
        set_size(master, int(request["rows"]), int(request["cols"]))
        # The program has no controlling terminal (it was handed the slave end, not given it as
        # one), so the kernel sends no SIGWINCH of its own.
        try:
            os.killpg(proc.pid, signal.SIGWINCH)
        except OSError:
            pass
    elif op == "signal" and proc.poll() is None:
        try:
            os.kill(proc.pid, getattr(signal, request["name"]))
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
