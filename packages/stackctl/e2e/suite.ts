/**
 * What every e2e file shares: its fixture workspace (one per file, in a temp directory), and the
 * cleanup after each test — every process the test started is ended, and no fixture service may
 * outlive the stackctl that ran it — and after the file, when no fixture port may be left open.
 */
import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { createWorkspace, FIXTURE_PORTS } from './fixture.js';
import { closeAll, killStrayServices, listening } from './processes.js';
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, MOUSE_OFF, MOUSE_ON, Pty, stripAnsi } from './pty.js';

/** Sets up the file's workspace; the function returned gives its path. */
export function fixtureWorkspace(): () => string {
  let ws = '';
  beforeAll(() => {
    ws = createWorkspace();
  });
  afterEach(async () => {
    await closeAll();
    expect(await killStrayServices(ws), 'fixture services left running').toEqual([]);
  });
  afterAll(async () => {
    expect(await listening(FIXTURE_PORTS), 'fixture ports still open').toEqual([]);
    fs.rmSync(ws, { recursive: true, force: true });
  });
  return () => ws;
}

/**
 * The run screen's services row shows every fixture service running and ready: a green `●` for
 * each. A service on its way has a `●` too, but yellow and blinking.
 */
export function allRunning(pty: Pty): boolean {
  return pty.servicesRowDots() === 'api:32 web:32 worker:32';
}

/** Starts a session of every fixture service, past the picker, and waits until all are running. */
export async function startEveryService(
  ws: string,
  opts: { env?: Record<string, string> } = {},
): Promise<Pty> {
  const pty = await Pty.start({
    cwd: ws,
    args: ['-s', 'api', '-s', 'web', '-s', 'worker'],
    ...opts,
  });
  await pty.waitUntil(() => allRunning(pty), 'every service running');
  return pty;
}

/**
 * Asserts the terminal was given back as the CLI exited: mouse reporting switched off after it was
 * last switched on, and the alternate screen left. Returns what was printed after that, on the
 * primary screen, ANSI stripped.
 */
export function expectTerminalRestored(pty: Pty): string {
  const raw = pty.raw();
  expect(raw.lastIndexOf(MOUSE_OFF), 'mouse reporting switched off').toBeGreaterThan(
    raw.lastIndexOf(MOUSE_ON),
  );
  const leftAlt = raw.lastIndexOf(ALT_SCREEN_OFF);
  expect(leftAlt, 'the alternate screen left').toBeGreaterThan(raw.lastIndexOf(ALT_SCREEN_ON));
  expect(pty.screen.modes.get(1006)).toBe(false);
  expect(pty.screen.modes.get(1002)).toBe(false);
  expect(pty.screen.modes.get(1049)).toBe(false);
  return stripAnsi(raw.slice(leftAlt));
}
