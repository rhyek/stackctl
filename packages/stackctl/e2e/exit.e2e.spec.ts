/**
 * How the TUI ends other than by Ctrl+C: a SIGTERM as soon as it is up, a startup that fails, and a
 * crash. Each gives the terminal back.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { expect, test } from 'vitest';
import { PORTS, sessionRecord } from './fixture.js';
import { track } from './processes.js';
import { Pty } from './pty.js';
import { expectTerminalRestored, fixtureWorkspace } from './suite.js';

const ws = fixtureWorkspace();

test('SIGTERM at the first frame: the one shutdown, exit 0, the exit line, no session record left', async () => {
  const pty = await Pty.start({ cwd: ws(), args: ['-s', 'api', '-s', 'web', '-s', 'worker'] });
  // The run screen's first frame, during startup.
  await pty.waitFor('f filter  c clear  │  ^c quit');
  pty.signal('SIGTERM');
  expect(await pty.waitForExit()).toEqual({ code: 0, signal: null });
  expect(expectTerminalRestored(pty)).toContain('■ stackctl exited after');
  expect(sessionRecord(ws())).toBeNull();
});

test('a startup failure stays on screen; one Ctrl+C quits with exit 1', async () => {
  // The test's own listener on the port the config pins the control API to: the control server
  // can't listen, and the session's startup fails.
  const holder = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => holder.listen(PORTS.pinnedControl, '127.0.0.1', resolve));
  track({ close: () => new Promise<void>((resolve) => holder.close(() => resolve())) });

  const pty = await Pty.start({
    cwd: ws(),
    args: ['-s', 'api'],
    env: { E2E_API_PORT: String(PORTS.pinnedControl) },
  });
  // The reason is in the log, and the footer has the service still pending and only the log's
  // keys.
  await pty.waitFor(/\[stackctl\] \[ERROR\] .*EADDRINUSE.*21085/);
  expect(pty.text()).toMatch(/○ api\s*\nlogs: f filter {2}c clear {2}│ {2}\^c quit/);
  expect(pty.text()).not.toContain('r restart');
  // Nothing more started.
  expect(pty.text()).not.toMatch(/\[api\s*\] started/);
  expect(pty.exit).toBeNull();

  pty.press('ctrl-c');
  expect(await pty.waitForExit()).toEqual({ code: 1, signal: null });
  expect(expectTerminalRestored(pty)).toContain('■ stackctl exited after');
});

test('a crash: the terminal is given back, the error printed on the primary screen, exit 1', async () => {
  const trigger = path.join(ws(), 'crash-now');
  const pty = await Pty.start({ cwd: ws(), env: { E2E_CRASH_TRIGGER: trigger } });
  await pty.waitFor('choose services');
  // The config's own timer throws once the file exists.
  fs.writeFileSync(trigger, '');
  expect(await pty.waitForExit()).toEqual({ code: 1, signal: null });
  expect(expectTerminalRestored(pty)).toContain('Error: e2e crash from the config');
});
