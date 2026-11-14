import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { connectControlClient, connectSessionControl, findSession } from './find-session.js';
import { writeRunning } from './running.js';

const servers: http.Server[] = [];
const tmpDirs: string[] = [];
const children: ChildProcess[] = [];

function startServer(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
}

/** A port nothing listens on. */
async function deadPort(): Promise<number> {
  const port = await startServer((_req, res) => res.end());
  await new Promise<void>((r) => servers.splice(0)[0]!.close(() => r()));
  return port;
}

function tmpWorkspace(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-find-session-')));
  tmpDirs.push(dir);
  return dir;
}

/** A live process idling in `cwd`, standing in for a session whose loop has stopped. */
function idleProcess(cwd: string): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { cwd });
  children.push(child);
  return child.pid!;
}

const SESSION_ID = '0f8e5a52-6a3b-4f1e-9a52-2d6c1b7e4f10';

/** What a session answers on `/query/status`; this test process stands in as its pid. */
function status(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: process.pid,
    sessionId: SESSION_ID,
    configPath: '/ws/stackctl.config.ts',
    profile: 'test',
    startedByAgent: false,
    logFile: null,
    services: null,
    ready: null,
    infra: null,
    sessionReady: false,
    config: null,
    reverseProxy: null,
    ...over,
  };
}

// Pinned, so a run from inside a stackctl session of another profile can't change the answers.
beforeEach(() => vi.stubEnv('STACKCTL_PROFILE', 'development'));
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      process.kill(child.pid, 'SIGKILL');
    }
  }
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('findSession', () => {
  test('is none with no record', async () => {
    expect(await findSession({ workspaceDir: tmpWorkspace(), profile: 'test' })).toEqual({
      kind: 'none',
    });
  });

  test('is none when the recorded pid is gone', async () => {
    const workspaceDir = tmpWorkspace();
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => child.once('exit', r));
    writeRunning(workspaceDir, { port: await deadPort(), pid: child.pid!, sessionId: SESSION_ID }, 'test'); // oxfmt-ignore
    expect((await findSession({ workspaceDir, profile: 'test' })).kind).toBe('none');
  });

  test('is the session when its pid is alive and it answers with the recorded id', async () => {
    const workspaceDir = tmpWorkspace();
    const port = await startServer((_req, res) => res.end(JSON.stringify(status())));
    writeRunning(workspaceDir, { port, pid: process.pid, sessionId: SESSION_ID }, 'test');
    const found = await findSession({ workspaceDir, profile: 'test' });
    expect(found.kind).toBe('running');
    expect(found.kind === 'running' && found.client.port).toBe(port);
  });

  test('is unresponsive when the pid is alive in the workspace but the API is silent', async () => {
    const workspaceDir = tmpWorkspace();
    const pid = idleProcess(workspaceDir);
    const port = await deadPort();
    writeRunning(workspaceDir, { port, pid, sessionId: SESSION_ID }, 'test');
    expect(await findSession({ workspaceDir, profile: 'test', settleMs: 300 })).toEqual({
      kind: 'unresponsive',
      pid,
      port,
      reason: 'hung',
    });
  });

  test('is unresponsive when what answers is another session', async () => {
    const workspaceDir = tmpWorkspace();
    const pid = idleProcess(workspaceDir);
    const port = await startServer((_req, res) =>
      res.end(JSON.stringify(status({ pid, sessionId: 'another' }))),
    );
    writeRunning(workspaceDir, { port, pid, sessionId: SESSION_ID }, 'test');
    expect(await findSession({ workspaceDir, profile: 'test' })).toMatchObject({
      kind: 'unresponsive',
      reason: 'mismatch',
    });
  });

  test('is none when the recorded pid now belongs to a process outside the workspace', async () => {
    // After a crash, the system may give the pid to anything: that is not the session.
    const workspaceDir = tmpWorkspace();
    const pid = idleProcess(tmpWorkspace());
    writeRunning(workspaceDir, { port: await deadPort(), pid, sessionId: SESSION_ID }, 'test');
    expect((await findSession({ workspaceDir, profile: 'test', settleMs: 300 })).kind).toBe('none');
  });

  test('waits for a session whose control API is about to listen', async () => {
    // The record is written just before the API starts listening.
    const workspaceDir = tmpWorkspace();
    const port = await deadPort();
    writeRunning(workspaceDir, { port, pid: process.pid, sessionId: SESSION_ID }, 'test');
    setTimeout(() => {
      const server = http.createServer((_req, res) => res.end(JSON.stringify(status())));
      servers.push(server);
      server.listen(port, '127.0.0.1');
    }, 300);
    expect((await findSession({ workspaceDir, profile: 'test' })).kind).toBe('running');
  });
});

describe('connectControlClient', () => {
  test('returns null when there is no record', async () => {
    expect(await connectControlClient(tmpWorkspace())).toBeNull();
  });

  test('returns a client bound to the live session', async () => {
    const cwd = tmpWorkspace();
    const port = await startServer((_req, res) =>
      res.end(JSON.stringify(status({ profile: 'development' }))),
    );
    writeRunning(cwd, { port, pid: process.pid, sessionId: SESSION_ID });
    expect((await connectControlClient(cwd))?.port).toBe(port);
  });

  test("finds the given profile's session, not another profile's", async () => {
    const cwd = tmpWorkspace();
    const port = await startServer((_req, res) => res.end(JSON.stringify(status())));
    writeRunning(cwd, { port, pid: process.pid, sessionId: SESSION_ID }, 'test');
    expect(await connectControlClient(cwd)).toBeNull();
    expect((await connectControlClient(cwd, 'test'))?.port).toBe(port);
  });
});

describe('connectSessionControl', () => {
  /** A workspace whose `running.test.json` points at a live server answering `over`. */
  async function session(over: Record<string, unknown> = {}) {
    const workspaceDir = tmpWorkspace();
    const configPath = path.join(workspaceDir, 'stackctl.config.ts');
    fs.writeFileSync(configPath, '');
    const port = await startServer((_req, res) =>
      res.end(JSON.stringify(status({ configPath, ...over }))),
    );
    writeRunning(workspaceDir, { port, pid: process.pid, sessionId: SESSION_ID }, 'test');
    return { workspaceDir, configPath, port };
  }

  test("binds to this config's session in this profile", async () => {
    const { workspaceDir, configPath, port } = await session();
    const client = await connectSessionControl({ workspaceDir, configPath, profile: 'test' });
    expect(client?.port).toBe(port);
  });

  test("leaves another project's session alone, though it answers on the recorded port", async () => {
    const { workspaceDir, configPath } = await session({
      configPath: '/elsewhere/stackctl.config.ts',
    });
    expect(
      await connectSessionControl({ workspaceDir, configPath, profile: 'test' }),
    ).toBeUndefined();
  });

  test('leaves a session of another profile alone', async () => {
    const { workspaceDir, configPath } = await session({ profile: 'development' });
    expect(
      await connectSessionControl({ workspaceDir, configPath, profile: 'test' }),
    ).toBeUndefined();
  });

  test('is undefined when the session answering is not the one recorded', async () => {
    const { workspaceDir, configPath } = await session({ sessionId: 'another' });
    expect(
      await connectSessionControl({ workspaceDir, configPath, profile: 'test' }),
    ).toBeUndefined();
  });

  test('matches the config path through a symlink', async () => {
    const { workspaceDir, configPath } = await session();
    const link = path.join(tmpWorkspace(), 'ws');
    fs.symlinkSync(workspaceDir, link);
    const viaLink = path.join(link, 'stackctl.config.ts');
    expect(
      await connectSessionControl({ workspaceDir, configPath: viaLink, profile: 'test' }),
    ).toBeDefined();
    expect(configPath).not.toBe(viaLink);
  });

  test("goes by the config's apiPort when it pins one", async () => {
    const { configPath, port } = await session();
    const other = tmpWorkspace(); // no record at all
    expect(
      (
        await connectSessionControl({
          workspaceDir: other,
          configPath,
          profile: 'test',
          apiPort: port,
        })
      )?.port,
    ).toBe(port);
  });
});
