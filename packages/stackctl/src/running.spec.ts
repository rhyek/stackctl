import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CONTROL_PORT_MIN,
  CONTROL_PORT_COUNT,
  readRunning,
  writeRunning,
  updateRunning,
  pickRandomPort,
  decideControlPort,
  readOtherModesRunning,
  runningFilePath,
  removeOwnRunning,
  sessionId,
  type PortEnv,
  type InstanceInfo,
} from './running.js';

let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-running-'));
  // Pinned, so a run from inside a stackctl session of another mode can't change the answers.
  vi.stubEnv('STACKCTL_MODE', 'development');
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(cwd, { recursive: true, force: true });
});

const inRange = (p: number) => p >= CONTROL_PORT_MIN && p < CONTROL_PORT_MIN + CONTROL_PORT_COUNT;

/** A fake {@link PortEnv} whose network behavior is fully scripted. */
function fakeEnv(opts: {
  listening?: number[];
  info?: Record<number, InstanceInfo>;
  onShutdown?: (port: number, pid: number) => void;
}): PortEnv {
  const listening = new Set(opts.listening ?? []);
  return {
    isListening: (port) => Promise.resolve(listening.has(port)),
    probe: (port) => Promise.resolve(opts.info?.[port] ?? null),
    shutdown: (port, pid) => {
      opts.onShutdown?.(port, pid);
      return Promise.resolve();
    },
  };
}

describe('pickRandomPort', () => {
  test('returns a port within the configured range', () => {
    for (let i = 0; i < 50; i++) {
      expect(inRange(pickRandomPort())).toBe(true);
    }
  });
  test('never returns an excluded port', () => {
    const exclude = [];
    for (let p = CONTROL_PORT_MIN; p < CONTROL_PORT_MIN + CONTROL_PORT_COUNT - 1; p++) {
      exclude.push(p);
    }
    // Only the last port is available.
    expect(pickRandomPort(exclude)).toBe(CONTROL_PORT_MIN + CONTROL_PORT_COUNT - 1);
  });
});

describe('readRunning / writeRunning', () => {
  test('round-trips state and returns null when the file is missing', () => {
    expect(readRunning(cwd)).toBeNull();
    writeRunning(cwd, { port: 14042, pid: 1234 });
    expect(readRunning(cwd)).toEqual({ port: 14042, pid: 1234 });
  });
  test('returns null for a malformed file', () => {
    const file = path.join(cwd, 'node_modules', '.stackctl', 'running.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json');
    expect(readRunning(cwd)).toBeNull();
  });
});

describe('updateRunning', () => {
  test('merges a patch into running.json when this process owns it', () => {
    writeRunning(cwd, { port: 14050, pid: process.pid, logDir: '/logs' });
    updateRunning(cwd, { logFile: '/logs/2.log' });
    expect(readRunning(cwd)).toEqual({
      port: 14050,
      pid: process.pid,
      logDir: '/logs',
      logFile: '/logs/2.log',
    });
  });

  test('is a no-op when this process does not own running.json (different pid)', () => {
    writeRunning(cwd, { port: 14050, pid: process.pid + 1, logFile: '/logs/1.log' });
    updateRunning(cwd, { logFile: '/logs/2.log' });
    expect(readRunning(cwd)?.logFile).toBe('/logs/1.log');
  });

  test('is a no-op when there is no running.json', () => {
    updateRunning(cwd, { logFile: '/logs/2.log' });
    expect(readRunning(cwd)).toBeNull();
  });
});

describe('removeOwnRunning', () => {
  test("deletes the mode's record when it is this process's own", () => {
    writeRunning(cwd, { port: 14050, pid: process.pid, sessionId: sessionId() });
    removeOwnRunning(cwd);
    expect(fs.existsSync(runningFilePath(cwd))).toBe(false);
  });

  test("leaves another process's record alone: a newer session's, after a handoff", () => {
    writeRunning(cwd, { port: 14050, pid: process.pid + 1 });
    removeOwnRunning(cwd);
    expect(readRunning(cwd)?.pid).toBe(process.pid + 1);
  });

  test('is a no-op with no record', () => {
    expect(() => removeOwnRunning(cwd)).not.toThrow();
  });
});

describe('sessionId', () => {
  test('is random, and the same for the life of the process', () => {
    expect(sessionId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionId()).toBe(sessionId());
  });
});

describe('decideControlPort — session id', () => {
  test('records the session id beside the pid', async () => {
    const port = await decideControlPort({
      cwd,
      configPath: '/repo/stackctl.config.ts',
      pid: 4242,
      sessionId: 'abc',
      env: fakeEnv({}),
    });
    expect(readRunning(cwd)).toEqual({ port, pid: 4242, sessionId: 'abc' });
  });

  test('records when the session started beside the pid', async () => {
    const port = await decideControlPort({
      cwd,
      configPath: '/repo/stackctl.config.ts',
      pid: 4242,
      sessionId: 'abc',
      startedAt: 1_700_000_000_000,
      env: fakeEnv({}),
    });
    expect(readRunning(cwd)).toEqual({ port, pid: 4242, sessionId: 'abc', startedAt: 1_700_000_000_000 }); // oxfmt-ignore
  });
});

describe('decideControlPort — random mode', () => {
  const configPath = '/repo/stackctl.config.ts';

  test('picks a fresh in-range port and records it when no running.json exists', async () => {
    const port = await decideControlPort({ cwd, configPath, pid: 4242, env: fakeEnv({}) });
    expect(inRange(port)).toBe(true);
    expect(readRunning(cwd)).toEqual({ port, pid: 4242 });
  });

  test('reuses the recorded port (updating pid) when it is not being listened to', async () => {
    writeRunning(cwd, { port: 14050, pid: 111 });
    const port = await decideControlPort({ cwd, configPath, pid: 4242, env: fakeEnv({}) });
    expect(port).toBe(14050);
    expect(readRunning(cwd)).toEqual({ port: 14050, pid: 4242 });
  });

  test('records the logFile (and logDir) in running.json when given', async () => {
    const port = await decideControlPort({
      cwd,
      configPath,
      pid: 4242,
      logDir: '/logs',
      logFile: '/logs/1.log',
      env: fakeEnv({}),
    });
    expect(readRunning(cwd)).toEqual({
      port,
      pid: 4242,
      logDir: '/logs',
      logFile: '/logs/1.log',
    });
  });

  test('hands off (shuts down) and reuses the port when the same workspace is listening', async () => {
    writeRunning(cwd, { port: 14050, pid: 111 });
    const shutdowns: [number, number][] = [];
    const env = fakeEnv({
      listening: [14050],
      info: { 14050: { pid: 999, configPath, mode: 'development' } },
      onShutdown: (p, pid) => shutdowns.push([p, pid]),
    });
    const port = await decideControlPort({ cwd, configPath, pid: 4242, env });
    expect(port).toBe(14050);
    expect(shutdowns).toEqual([[14050, 999]]);
    expect(readRunning(cwd)).toEqual({ port: 14050, pid: 4242 });
  });

  test('relocates without shutting down when a DIFFERENT workspace holds the port', async () => {
    writeRunning(cwd, { port: 14050, pid: 111 });
    let shutdownCalled = false;
    const env = fakeEnv({
      listening: [14050],
      info: { 14050: { pid: 999, configPath: '/other/stackctl.config.ts', mode: 'development' } },
      onShutdown: () => (shutdownCalled = true),
    });
    const port = await decideControlPort({ cwd, configPath, pid: 4242, env });
    expect(shutdownCalled).toBe(false);
    expect(port).not.toBe(14050);
    expect(inRange(port)).toBe(true);
    expect(readRunning(cwd)).toEqual({ port, pid: 4242 });
  });

  test('relocates when the port is held by a non-stackctl listener', async () => {
    writeRunning(cwd, { port: 14050, pid: 111 });
    const env = fakeEnv({ listening: [14050] /* no info → probe returns null */ });
    const port = await decideControlPort({ cwd, configPath, pid: 4242, env });
    expect(port).not.toBe(14050);
    expect(inRange(port)).toBe(true);
  });
});

describe('decideControlPort — explicit apiPort override', () => {
  const configPath = '/repo/stackctl.config.ts';

  test('uses the fixed port and hands off the same workspace', async () => {
    const shutdowns: [number, number][] = [];
    const env = fakeEnv({
      listening: [5000],
      info: { 5000: { pid: 999, configPath, mode: 'development' } },
      onShutdown: (p, pid) => shutdowns.push([p, pid]),
    });
    const port = await decideControlPort({
      cwd,
      configPath,
      pid: 4242,
      apiPortOverride: 5000,
      env,
    });
    expect(port).toBe(5000);
    expect(shutdowns).toEqual([[5000, 999]]);
    expect(readRunning(cwd)).toEqual({ port: 5000, pid: 4242 });
  });

  test('keeps the fixed port but does NOT shut down a foreign occupant', async () => {
    let shutdownCalled = false;
    const env = fakeEnv({
      listening: [5000],
      info: { 5000: { pid: 999, configPath: '/other/stackctl.config.ts', mode: 'development' } },
      onShutdown: () => (shutdownCalled = true),
    });
    const port = await decideControlPort({
      cwd,
      configPath,
      pid: 4242,
      apiPortOverride: 5000,
      env,
    });
    expect(port).toBe(5000);
    expect(shutdownCalled).toBe(false);
  });
});

// A workspace runs one session per mode: each mode has its own record, and a session only ever
// hands off one in its own mode.
describe('per-mode session records', () => {
  const configPath = '/repo/stackctl.config.ts';
  const statePath = (name: string) => path.join(cwd, 'node_modules', '.stackctl', name);

  test("writes and reads the active mode's own modes/<mode>/running.json", () => {
    writeRunning(cwd, { port: 14001, pid: 1 });
    vi.stubEnv('STACKCTL_MODE', 'test');
    expect(readRunning(cwd)).toBeNull();
    writeRunning(cwd, { port: 14002, pid: 2 });
    expect(runningFilePath(cwd)).toBe(statePath('modes/test/running.json'));
    expect(readRunning(cwd)).toEqual({ port: 14002, pid: 2 });
    expect(readRunning(cwd, 'development')).toEqual({ port: 14001, pid: 1 });
    expect(fs.existsSync(statePath('modes/development/running.json'))).toBe(true);
  });

  test("updates only the active mode's record, and only when this process owns it", () => {
    writeRunning(cwd, { port: 14001, pid: 1 }, 'development');
    writeRunning(cwd, { port: 14002, pid: process.pid }, 'test');
    vi.stubEnv('STACKCTL_MODE', 'test');
    updateRunning(cwd, { logFile: '/logs/test/2.log' });
    expect(readRunning(cwd, 'test')).toEqual({ port: 14002, pid: process.pid, logFile: '/logs/test/2.log' }); // oxfmt-ignore
    expect(readRunning(cwd, 'development')).toEqual({ port: 14001, pid: 1 });
  });

  test('reads no record outside modes/<mode>/', () => {
    fs.mkdirSync(statePath(''), { recursive: true });
    fs.writeFileSync(statePath('running.json'), JSON.stringify({ port: 14009, pid: 9 }));
    fs.writeFileSync(
      statePath('running.development.json'),
      JSON.stringify({ port: 14008, pid: 8 }),
    );
    expect(readRunning(cwd, 'development')).toBeNull();
    expect(readOtherModesRunning(cwd, 'test')).toEqual(new Map());
  });

  test("lists the other modes' records, never the active one's", () => {
    writeRunning(cwd, { port: 14001, pid: 1 }, 'development');
    writeRunning(cwd, { port: 14002, pid: 2 }, 'test');
    writeRunning(cwd, { port: 14003, pid: 3 }, 'e2e.ci');
    expect(readOtherModesRunning(cwd, 'test')).toEqual(
      new Map([
        ['development', { port: 14001, pid: 1 }],
        ['e2e.ci', { port: 14003, pid: 3 }],
      ]),
    );
  });

  test("relocates around this project's session in another mode, never shutting it down", async () => {
    writeRunning(cwd, { port: 14050, pid: 111 }, 'development');
    writeRunning(cwd, { port: 14050, pid: 222 }, 'test');
    let shutdownCalled = false;
    const env = fakeEnv({
      listening: [14050],
      info: { 14050: { pid: 111, configPath, mode: 'development' } },
      onShutdown: () => (shutdownCalled = true),
    });
    const port = await decideControlPort({ cwd, configPath, mode: 'test', pid: 4242, env });
    expect(shutdownCalled).toBe(false);
    expect(port).not.toBe(14050);
    expect(readRunning(cwd, 'test')).toEqual({ port, pid: 4242 });
    expect(readRunning(cwd, 'development')).toEqual({ port: 14050, pid: 111 });
  });

  test("refuses a fixed apiPort held by this project's session in another mode", async () => {
    let shutdownCalled = false;
    const env = fakeEnv({
      listening: [5000],
      info: { 5000: { pid: 111, configPath, mode: 'development' } },
      onShutdown: () => (shutdownCalled = true),
    });
    await expect(
      decideControlPort({ cwd, configPath, mode: 'test', pid: 4242, apiPortOverride: 5000, env }),
    ).rejects.toThrow(/apiPort 5000 is in use by this project's development session \(pid 111\)/);
    expect(shutdownCalled).toBe(false);
    expect(readRunning(cwd, 'test')).toBeNull();
  });
});
