import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { HANDOFF_FORCE_KILL_MS } from '../shutdown-timing.js';
import { type Running, runCommand } from '../spawn.js';
import { resetMode, runReset, runStop, stopSession, stoppedLine } from './stop.js';

/**
 * Starts `command` as these specs run one: this process's environment under `env`, and its output
 * without the newline it printed last, to compare whole.
 */
function start(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {},
): Running {
  const child = runCommand(command, args, { ...opts, env: { ...process.env, ...opts.env } });
  const trim = (text: string) => text.replace(/\r?\n$/, '');
  const done = child.done.then((end) => ({ ...end, stdout: trim(end.stdout), stderr: trim(end.stderr) })); // oxfmt-ignore
  return Object.assign(child, { done });
}

/**
 * `stackctl stop` and `stackctl reset`, against real sessions of the CLI compiled from the current
 * source (as `cli.spec.ts` does, in a directory of this file's own), and against stand-in sessions:
 * a process that answers its control API as a session would, but doesn't do what it's asked.
 */
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const buildDir = path.join(packageDir, 'node_modules', '.cache', 'stop-spec');
const cli = path.join(buildDir, 'cli.js');

let ws: string;
const stateDir = () => path.join(ws, 'node_modules', '.stackctl');
const modeDir = (mode: string) => path.join(stateDir(), 'modes', mode);
/** The latest session folder of the mode. */
const latestSession = (mode: string) => {
  const sessions = path.join(modeDir(mode), 'sessions');
  const ids = fs.readdirSync(sessions).sort((a, b) => Number(a) - Number(b));
  return path.join(sessions, ids.at(-1)!);
};
/** The `session-command` lines of the mode's latest event log. */
const resetLines = (mode: string) =>
  fs
    .readFileSync(path.join(latestSession(mode), 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.type === 'session-command');
const recordOf = (mode: string) => path.join(modeDir(mode), 'running.json');
/** The modes with a session record, as `<mode>/running.json`. */
const records = () =>
  fs.existsSync(path.join(stateDir(), 'modes'))
    ? fs
        .readdirSync(path.join(stateDir(), 'modes'))
        .filter((mode) => fs.existsSync(recordOf(mode)))
        .map((mode) => `${mode}/running.json`)
    : [];
/** `stop` and `reset` in-process, for `mode` as `--mode` names it. */
const flag = (mode = 'development') => ({ mode, source: 'flag' as const });

/**
 * A stand-in session in `mode`: `hang` answers `/query/status` as the session its record names
 * and holds `POST /command/quit` open forever, never exiting; `silent` answers nothing at all;
 * `deaf` answers nothing and ignores a SIGTERM too.
 */
const FAKE_SESSION = `
import http from 'node:http';
const [behavior, mode, sessionId] = process.argv.slice(2);
if (behavior === 'silent' || behavior === 'deaf') {
  if (behavior === 'deaf') process.on('SIGTERM', () => {});
  setInterval(() => {}, 1e9);
  console.log(JSON.stringify({ ready: true }));
} else {
  const server = http.createServer((req, res) => {
    if (req.url === '/query/status') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ pid: process.pid, sessionId, mode, configPath: process.cwd() + '/stackctl.config.ts' }));
    }
    // Anything else, the quit among it, is never answered.
  });
  server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
}
`;

const script = (js: string) => `node --input-type=module -e "${js}"`;

beforeAll(async () => {
  const tsPackage = fileURLToPath(import.meta.resolve('typescript/package.json'));
  const tsc = path.join(path.dirname(tsPackage), 'bin', 'tsc');
  fs.rmSync(buildDir, { recursive: true, force: true });
  const build = await start(
    'node',
    [
      tsc,
      '-p',
      path.join(packageDir, 'tsconfig.build.json'),
      '--outDir',
      buildDir,
      // A build the tests only run: no source maps, which would name sources outside the
      // build's folder, and no declarations.
      '--sourceMap',
      'false',
      '--declaration',
      'false',
    ],
    { cwd: packageDir },
  ).done;
  if (build.exitCode !== 0) {
    throw new Error(`the build failed:\n${build.stdout}${build.stderr}`);
  }

  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-stop-')));
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'stoproot', type: 'module' })); // oxfmt-ignore
  fs.writeFileSync(path.join(ws, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  fs.writeFileSync(
    path.join(ws, 'stackctl.config.ts'),
    "import { defineConfig } from 'stackctl';\nexport default defineConfig({ serviceRootDir: 'packages', services: { web: {}, worker: {} } });\n",
  );
  const standIn = path.join(ws, 'node_modules', 'stackctl');
  fs.mkdirSync(standIn, { recursive: true });
  fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
  fs.symlinkSync(buildDir, path.join(standIn, 'dist'));
  for (const name of ['web', 'worker']) {
    const dir = path.join(ws, 'packages', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, scripts: { dev: script('setInterval(()=>{},1e9)') } }),
    );
  }
  fs.writeFileSync(path.join(ws, 'fake-session.mjs'), FAKE_SESSION);
}, 120_000);

afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(buildDir, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * `pid`'s parent pid, or `null` once it's gone. A cleanup that knows a process only by its pid
 * checks it first, so that it only ever signals a process the test's own process started.
 */
function parentPid(pid: number): number | null {
  const { stdout, status } = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }); // oxfmt-ignore
  const ppid = Number.parseInt(stdout.trim(), 10);
  return status === 0 && ppid > 0 ? ppid : null;
}

/** Sessions and stand-ins a test started, ended after it whatever happened; and the ones that have exited. */
const sessions: Running[] = [];
const ended = new WeakSet<Running>();
const fakes: Running[] = [];
/** Keeps a stand-in the test started, ended after it should it still run. */
function fake(child: Running) {
  fakes.push(child);
  void child.done.then(() => ended.add(child));
}
afterEach(async () => {
  for (const child of fakes.splice(0)) {
    // By its handle, which signals nothing once the process has been reaped.
    if (!ended.has(child)) {
      child.kill('SIGKILL');
    }
    await child.done;
  }
  for (const child of sessions.splice(0)) {
    await endSession(child);
  }
  fs.rmSync(stateDir(), { recursive: true, force: true });
});

/**
 * Ends a session the test started, should it still run: SIGTERM, then SIGKILL, and the process
 * groups of the services its record names whose leader is still its child, which a SIGKILLed
 * session leaves running.
 */
async function endSession(child: Running): Promise<void> {
  if (ended.has(child) || !(child.pid! > 0)) {
    await child.done;
    return;
  }
  const exited = child.done.then(() => true);
  child.kill('SIGTERM');
  if (await Promise.race([exited, new Promise<false>((r) => setTimeout(() => r(false), 15_000))])) {
    return;
  }
  for (const name of records()) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(stateDir(), 'modes', name), 'utf8')) as {
        pid: number;
        children?: { pid: number }[];
      };
      if (record.pid === child.pid) {
        for (const { pid } of record.children ?? []) {
          if (pid > 0 && parentPid(pid) === child.pid) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              /* gone */
            }
          }
        }
      }
    } catch {
      /* not readable */
    }
  }
  child.kill('SIGKILL');
  await child.done;
}

/** Starts a headless session of `service` in `mode`, resolving with its subprocess once the service has started. */
async function startSession(mode: string, service: string, extra: string[] = []) {
  const child = start('node', [cli, '--mode', mode, '--headless', '-s', service, ...extra], {
    cwd: ws,
    env: { CI: '1' },
  });
  sessions.push(child);
  void child.done.then(() => ended.add(child));
  let output = '';
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  // Labels are padded to the longest in the session: `stackctl`, in these fixtures.
  const until = `[${service.padEnd('stackctl'.length)}] started`;
  await new Promise<void>((resolve, reject) => {
    const giveUp = setTimeout(
      () => reject(new Error(`never printed ${until}:\n${output}`)),
      20_000,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(until)) {
        clearTimeout(giveUp);
        resolve();
      }
    });
    void child.done.then(() => {
      clearTimeout(giveUp);
      reject(new Error(`exited before printing ${until}:\n${output}`));
    });
  });
  return { child };
}

/**
 * Starts a stand-in session (see {@link FAKE_SESSION}) and writes the record naming it, with a
 * `startedAt` of when it's written unless `startedAt` says otherwise (`null`: none).
 */
async function startFake(
  behavior: 'hang' | 'silent' | 'deaf',
  { mode = 'development', startedAt }: { mode?: string; startedAt?: number | null } = {},
) {
  const sessionId = `fake-${behavior}`;
  const child = start('node', [path.join(ws, 'fake-session.mjs'), behavior, mode, sessionId], {
    cwd: ws,
  });
  fake(child);
  const first = await new Promise<{ port?: number }>((resolve, reject) => {
    child.stdout.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString()) as { port?: number })); // oxfmt-ignore
    void child.done.then((result) =>
      reject(new Error(`the stand-in exited: ${String(result.stderr)}`)),
    );
  });
  const port = first.port ?? (await freePort());
  fs.mkdirSync(modeDir(mode), { recursive: true });
  const record = { port, pid: child.pid, sessionId, startedAt: startedAt ?? Date.now() };
  if (startedAt === null) {
    delete (record as { startedAt?: number }).startedAt;
  }
  fs.writeFileSync(recordOf(mode), JSON.stringify(record));
  return { pid: child.pid!, port, child };
}

/** What `stop` prints for a silent development session it couldn't confirm as stackctl's. */
const unverifiedLine = (pid: number) =>
  `couldn't confirm development session (pid ${String(pid)}) is stackctl's; not signalled. ` +
  `If no development session of this workspace is running, delete ${recordOf('development')}.`;

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** What `fn` writes with console.log and console.error, line by line. */
async function captured<T>(fn: () => Promise<T>) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void out.push(line));
  vi.spyOn(console, 'error').mockImplementation((line: string) => void err.push(line));
  const value = await fn();
  vi.restoreAllMocks();
  return { value, out, err };
}

describe('stackctl stop', () => {
  test("stops the named mode's session only", async () => {
    const { child: development } = await startSession('development', 'web');
    const { child: testSession } = await startSession('test', 'worker');
    expect(records().sort()).toEqual(['development/running.json', 'test/running.json']);
    // A session records when it started, which is what lets `stop` signal it should it hang.
    for (const name of records()) {
      const { startedAt } = JSON.parse(fs.readFileSync(path.join(stateDir(), 'modes', name), 'utf8')) as { startedAt?: unknown }; // oxfmt-ignore
      expect(startedAt).toBeTypeOf('number');
      expect(startedAt as number).toBeLessThanOrEqual(Date.now());
    }

    const result = await start('node', [cli, '--mode', 'test', 'stop'], { cwd: ws }).done;
    expect(result.stdout).toBe(`stopped test session (pid ${String(testSession.pid)})`);
    expect(result.exitCode).toBe(0);
    // `stop` returned once it was gone, so it has exited; the development one runs on.
    await testSession.done;
    expect(alive(development.pid!)).toBe(true);
    expect(records()).toEqual(['development/running.json']);

    const second = await start('node', [cli, 'stop', '--mode', 'development'], { cwd: ws }).done; // oxfmt-ignore
    expect(second.stdout).toBe(`stopped development session (pid ${String(development.pid)})`);
    await development.done;
    expect(records()).toEqual([]);
  }, 60_000);

  test("with none of its mode running, names the mode's source and the other mode's session", async () => {
    const { child: testSession } = await startSession('test', 'worker');
    const result = await start('node', [cli, 'stop'], { cwd: ws }).done;
    expect(result.stdout.split('\n')).toEqual([
      'No development stackctl session is running (development is the default mode; pass --mode to choose another).',
      `A test session is running (pid ${String(testSession.pid)}): stackctl --mode test stop`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(alive(testSession.pid!)).toBe(true);

    // In CI, the mode is the CI default; from STACKCTL_MODE, it says so.
    const ci = await start('node', [cli, 'stop'], { cwd: ws, env: { CI: 'true', STACKCTL_MODE: '' } }).done; // oxfmt-ignore
    expect(ci.stdout).toContain(`stopped test session (pid ${String(testSession.pid)})`);
    const fromEnv = await start('node', [cli, 'stop'], { cwd: ws, env: { STACKCTL_MODE: 'qa' } }).done; // oxfmt-ignore
    expect(fromEnv.stdout).toBe(
      'No qa stackctl session is running (qa is from STACKCTL_MODE; pass --mode to choose another).',
    );
    const named = await start('node', [cli, '--mode', 'qa', 'stop'], { cwd: ws }).done;
    expect(named.stdout).toBe('No qa stackctl session is running.');
  }, 60_000);

  test("stops a session whose control API doesn't answer", async () => {
    const { pid } = await startFake('silent');
    expect(await stopSession(ws, 'development')).toEqual({ mode: 'development', pid, outcome: 'stopped' }); // oxfmt-ignore
    expect(alive(pid)).toBe(false);
  }, 30_000);

  test("force-kills a session that won't exit", async () => {
    const { pid } = await startFake('hang');
    const { value, out } = await captured(() => runStop(ws, { forceKillAfterMs: 1000 }, flag()));
    expect(out).toEqual([`force-killed development session (pid ${String(pid)}): it didn't exit within 1s`]); // oxfmt-ignore
    expect(value).toBe(0);
    expect(alive(pid)).toBe(false);
    // Its record, which a killed session can't remove, goes with it.
    expect(records()).toEqual([]);
  }, 30_000);

  test("the force-killed line names the takeover's timeout", () => {
    expect(stoppedLine({ mode: 'test', pid: 7, outcome: 'force-killed' })).toBe(
      `force-killed test session (pid 7): it didn't exit within ${String(HANDOFF_FORCE_KILL_MS / 1000)}s`,
    );
  });

  test('stop with nothing running', async () => {
    const result = await start('node', [cli, '--mode', 'development', 'stop'], { cwd: ws }).done; // oxfmt-ignore
    expect(result.stdout).toBe('No development stackctl session is running.');
    expect(result.exitCode).toBe(0);
  });

  test('a record whose session is gone is no session', async () => {
    const gone = start('node', ['-e', '']);
    const pid = gone.pid;
    await gone.done;
    fs.mkdirSync(modeDir('development'), { recursive: true });
    fs.writeFileSync(recordOf('development'), JSON.stringify({ port: await freePort(), pid })); // oxfmt-ignore
    expect(await stopSession(ws, 'development')).toBeNull();
  });

  test('a record outside modes/<mode>/ is no session', async () => {
    const { child } = await startFake('hang');
    const { port } = JSON.parse(fs.readFileSync(recordOf('development'), 'utf8')) as { port: number }; // oxfmt-ignore
    fs.rmSync(recordOf('development'));
    fs.writeFileSync(path.join(stateDir(), 'running.json'), JSON.stringify({ port, pid: child.pid })); // oxfmt-ignore
    expect(await stopSession(ws, 'development', { forceKillAfterMs: 500 })).toBeNull();
    expect(alive(child.pid!)).toBe(true);
  }, 30_000);

  test('a record whose port another session answers on is no session, and its pid is not signalled', async () => {
    // Another session answering on the record's port, as itself.
    const { port } = await startFake('hang');
    // The record's pid: a process of this test's own, in the workspace, standing in for a reused pid.
    const standIn = start('node', ['-e', 'setInterval(()=>{},1e9)'], { cwd: ws });
    const pid = standIn.pid!;
    fake(standIn);
    const record = recordOf('development');
    fs.writeFileSync(record, JSON.stringify({ port, pid, sessionId: 'the-recorded-one' }));

    expect(await stopSession(ws, 'development', { forceKillAfterMs: 500 })).toBeNull();
    expect(alive(pid)).toBe(true);
    expect(fs.existsSync(record)).toBe(true);
  }, 30_000);

  test("force-kills a hung session that won't exit", async () => {
    const { pid } = await startFake('deaf');
    const { value, out } = await captured(() => runStop(ws, { forceKillAfterMs: 1000 }, flag()));
    expect(out).toEqual([`force-killed development session (pid ${String(pid)}): it didn't exit within 1s`]); // oxfmt-ignore
    expect(value).toBe(0);
    expect(alive(pid)).toBe(false);
    expect(records()).toEqual([]);
  }, 30_000);

  test('a hung record whose pid started after the record was written is no session, and is not signalled', async () => {
    // A process of this test's own, in the workspace, answering nothing: a pid the system gave
    // to something else after the session that wrote the record ended.
    const standIn = start('node', ['-e', 'setInterval(()=>{},1e9)'], { cwd: ws });
    const pid = standIn.pid!;
    fake(standIn);
    fs.mkdirSync(modeDir('development'), { recursive: true });
    const record = recordOf('development');
    const startedAt = Date.now() - 60_000;
    fs.writeFileSync(record, JSON.stringify({ port: await freePort(), pid, sessionId: 'gone', startedAt })); // oxfmt-ignore

    const { value, out, err } = await captured(() =>
      runStop(ws, { forceKillAfterMs: 500 }, flag()),
    );
    expect(out).toEqual(['No development stackctl session is running.']);
    expect(err).toEqual([]);
    expect(value).toBe(0);
    expect(alive(pid)).toBe(true);
  }, 30_000);

  test('a hung record with no startedAt is reported, not signalled, and stop fails', async () => {
    const { pid } = await startFake('silent', { startedAt: null });
    const { value, out, err } = await captured(() =>
      runStop(ws, { forceKillAfterMs: 500 }, flag()),
    );
    expect(out).toEqual([]);
    expect(err).toEqual([unverifiedLine(pid)]);
    expect(value).toBe(1);
    expect(alive(pid)).toBe(true);
    expect(records()).toEqual(['development/running.json']);
  }, 30_000);

  // pid 1 stands in for a recycled pid: alive, but another user's (EPERM), its directory unreadable.
  // Not run as root, which can signal pid 1: a real stop is never handed a pid it could kill.
  test.skipIf(process.getuid?.() === 0)(
    "a record whose pid is now another user's process is no session",
    async () => {
      fs.mkdirSync(modeDir('development'), { recursive: true });
      fs.writeFileSync(recordOf('development'), JSON.stringify({ port: await freePort(), pid: 1 })); // oxfmt-ignore
      expect(await stopSession(ws, 'development')).toBeNull();
    },
    30_000,
  );
});

describe('stackctl reset', () => {
  /** Lays out every kind of state: two modes', the shared certificates and debug log. */
  function seedState() {
    for (const mode of ['development', 'test']) {
      const earlier = path.join(modeDir(mode), 'sessions', String(Date.now() - 1000));
      fs.mkdirSync(earlier, { recursive: true });
      fs.writeFileSync(path.join(modeDir(mode), 'selection.json'), JSON.stringify(['web']));
      fs.writeFileSync(path.join(modeDir(mode), 'trusted.pem'), 'pem\n');
      fs.writeFileSync(path.join(earlier, 'logs.txt'), 'a\n');
    }
    fs.mkdirSync(path.join(stateDir(), 'tls'), { recursive: true });
    fs.writeFileSync(path.join(stateDir(), 'tls', 'cert.pem'), 'c\n');
    fs.writeFileSync(path.join(stateDir(), 'debug.log'), 'd\n');
  }

  test("reset stops the mode's session and deletes its folder, and nothing else", async () => {
    seedState();
    const { child: session } = await startSession('development', 'web');
    const { child: other } = await startSession('test', 'worker');

    const result = await start('node', [cli, '--mode', 'development', 'reset'], { cwd: ws }).done; // oxfmt-ignore
    expect(result.stdout.split('\n')).toEqual([
      `stopped development session (pid ${String(session.pid)})`,
      'Removed node_modules/.stackctl/modes/development/; its event log starts again with this reset.',
    ]);
    expect(result.exitCode).toBe(0);
    await session.done;
    // All its state went, the event log too; the reset's own lines open the new one.
    expect(fs.readdirSync(modeDir('development'))).toEqual(['sessions']);
    expect(fs.readdirSync(latestSession('development'))).toEqual(['events.jsonl']);
    expect(resetLines('development')).toMatchObject([
      { type: 'session-command', phase: 'begin', action: 'reset', by: { kind: 'cli', argv: expect.arrayContaining(['reset']) } }, // oxfmt-ignore
      { type: 'session-command', phase: 'end', action: 'reset', ok: true },
    ]);
    // The other mode's session and state, and the shared files, are untouched.
    expect(alive(other.pid!)).toBe(true);
    // The other mode's session goes on: its own event log included.
    expect(fs.readdirSync(modeDir('test')).sort()).toEqual(['running.json', 'selection.json', 'sessions', 'trusted.pem']); // oxfmt-ignore
    expect(fs.readdirSync(path.join(modeDir('test'), 'sessions'))).toHaveLength(2);
    expect(fs.readFileSync(path.join(stateDir(), 'tls', 'cert.pem'), 'utf8')).toBe('c\n');
    expect(fs.readFileSync(path.join(stateDir(), 'debug.log'), 'utf8')).toBe('d\n');
  }, 60_000);

  test('reset needs --mode: STACKCTL_MODE, CI and the default are refused', async () => {
    seedState();
    const message =
      "reset deletes a mode's state: name the mode with --mode (e.g. stackctl --mode development reset)";
    for (const env of [{}, { STACKCTL_MODE: 'development' }, { CI: 'true' }] as Record<
      string,
      string
    >[]) {
      const result = await start('node', [cli, 'reset'], { cwd: ws, env }).done;
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(message);
      expect(result.stdout).toBe('');
    }
    expect(fs.existsSync(modeDir('development'))).toBe(true);
    expect(fs.existsSync(modeDir('test'))).toBe(true);
  }, 30_000);

  test("reset deletes nothing when a session can't be stopped", async () => {
    fs.mkdirSync(modeDir('development'), { recursive: true });
    fs.writeFileSync(path.join(modeDir('development'), 'selection.json'), JSON.stringify(['web']));
    const { pid } = await startFake('hang');
    // A kill that does nothing: the session outlives it.
    const stuck = { forceKillAfterMs: 500, killTree: async () => {} };

    expect(await resetMode(ws, 'development', stuck)).toEqual({
      session: { mode: 'development', pid, outcome: 'still-running' },
      deleted: false,
    });
    const { value, out, err } = await captured(() => runReset(ws, stuck, flag()));
    expect(value).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      `couldn't stop development session (pid ${String(pid)}): it's still running after its process tree was killed`,
      'Left node_modules/.stackctl/modes/development/ in place: the session is still running.',
    ]);
    expect(alive(pid)).toBe(true);
    // Its state is in place; the event log says a reset was asked for and didn't happen.
    expect(fs.readdirSync(modeDir('development')).sort()).toEqual(['running.json', 'selection.json', 'sessions']); // oxfmt-ignore
    expect(resetLines('development').at(-1)).toMatchObject({ type: 'session-command', phase: 'end', action: 'reset', ok: false }); // oxfmt-ignore
  }, 30_000);

  test("reset deletes nothing when a hung record can't be confirmed as stackctl's", async () => {
    fs.mkdirSync(modeDir('development'), { recursive: true });
    fs.writeFileSync(path.join(modeDir('development'), 'selection.json'), JSON.stringify(['web']));
    const { pid } = await startFake('silent', { startedAt: null });

    const { value, out, err } = await captured(() =>
      runReset(ws, { forceKillAfterMs: 500 }, flag()),
    );
    expect(value).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      unverifiedLine(pid),
      'Left node_modules/.stackctl/modes/development/ in place: the recorded session may still be running.',
    ]);
    expect(alive(pid)).toBe(true);
    // Its state is in place; the event log says a reset was asked for and didn't happen.
    expect(fs.readdirSync(modeDir('development')).sort()).toEqual(['running.json', 'selection.json', 'sessions']); // oxfmt-ignore
    expect(resetLines('development').at(-1)).toMatchObject({ type: 'session-command', phase: 'end', action: 'reset', ok: false }); // oxfmt-ignore
  }, 30_000);

  test("a mode named like a running one but for case is that session's: stop and reset leave it alone", async () => {
    // A filesystem that ignores case makes modes/Test/ and modes/test/ one folder: the Test record
    // is the test session's. Written under both names, so this holds on either kind.
    const { pid } = await startFake('hang', { mode: 'test' });
    const record = fs.readFileSync(recordOf('test'), 'utf8');
    fs.mkdirSync(modeDir('Test'), { recursive: true });
    fs.writeFileSync(recordOf('Test'), record);
    fs.writeFileSync(path.join(modeDir('Test'), 'selection.json'), JSON.stringify(['web']));
    const line =
      "the Test record is this workspace's test session (pid " + String(pid) + '), which shares its folder; not signalled. ' +
      'Name its mode as it runs: stackctl --mode test stop'; // oxfmt-ignore

    const stopped = await captured(() => runStop(ws, { forceKillAfterMs: 500 }, flag('Test')));
    expect(stopped.value).toBe(1);
    expect(stopped.err).toEqual([line]);
    const reset = await captured(() => runReset(ws, { forceKillAfterMs: 500 }, flag('Test')));
    expect(reset.value).toBe(1);
    expect(reset.err).toEqual([
      line,
      "Left node_modules/.stackctl/modes/Test/ in place: it is the running test session's.",
    ]);
    expect(alive(pid)).toBe(true);
    expect(fs.existsSync(recordOf('Test'))).toBe(true);
    expect(fs.existsSync(path.join(modeDir('Test'), 'selection.json'))).toBe(true);
  }, 30_000);

  test('reset with nothing to remove', async () => {
    const result = await start('node', [cli, '--mode', 'development', 'reset'], { cwd: ws }).done; // oxfmt-ignore
    expect(result.stdout).toBe(
      "No development stackctl session is running.\nNothing to remove: node_modules/.stackctl/modes/development/ doesn't exist.",
    );
    expect(result.exitCode).toBe(0);
  });
});

describe('a takeover with --kill-others', () => {
  test('never kills a hung record whose pid started after the record was written, and refuses to start', async () => {
    // A process of this test's own, in the workspace, answering nothing: a pid the system gave
    // to something else after the session that wrote the record ended.
    const standIn = start('node', ['-e', 'setInterval(()=>{},1e9)'], { cwd: ws });
    const pid = standIn.pid!;
    fake(standIn);
    fs.mkdirSync(modeDir('development'), { recursive: true });
    const record = recordOf('development');
    const startedAt = Date.now() - 60_000;
    fs.writeFileSync(record, JSON.stringify({ port: await freePort(), pid, sessionId: 'gone', startedAt })); // oxfmt-ignore

    const result = await start(
      'node',
      [cli, '--mode', 'development', '--headless', '-s', 'web', '--kill-others'],
      {
        cwd: ws,
        env: { CI: '1' },
        timeout: 30_000,
      },
    ).done;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `a development session is recorded as running (pid ${String(pid)}), but stackctl can't confirm that process is that session, so it won't kill it. ` +
        `If no development session of this workspace is running, delete ${record} and start again.`,
    );
    expect(alive(pid)).toBe(true);
    expect(fs.existsSync(record)).toBe(true);
  }, 45_000);

  test('never kills a hung record with no startedAt', async () => {
    const { pid } = await startFake('deaf', { startedAt: null });
    const result = await start(
      'node',
      [cli, '--mode', 'development', '--headless', '-s', 'web', '--kill-others'],
      {
        cwd: ws,
        env: { CI: '1' },
        timeout: 30_000,
      },
    ).done;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`(pid ${String(pid)}), but stackctl can't confirm`);
    expect(alive(pid)).toBe(true);
  }, 45_000);

  test('kills a hung session it confirms as the recorded one, and starts', async () => {
    const { pid } = await startFake('deaf');
    const { child } = await startSession('development', 'web', ['--kill-others']);
    expect(alive(pid)).toBe(false);
    // The record is the new session's now.
    const record = JSON.parse(fs.readFileSync(recordOf('development'), 'utf8')) as { pid: number }; // oxfmt-ignore
    expect(record.pid).toBe(child.pid);
  }, 60_000);

  test('startStack({ killOthers }) rejects with the same message, and kills nothing', async () => {
    const standIn = start('node', ['-e', 'setInterval(()=>{},1e9)'], { cwd: ws });
    const pid = standIn.pid!;
    fake(standIn);
    fs.mkdirSync(modeDir('development'), { recursive: true });
    const record = recordOf('development');
    fs.writeFileSync(record, JSON.stringify({ port: await freePort(), pid, sessionId: 'gone', startedAt: Date.now() - 60_000 })); // oxfmt-ignore

    type StackModule = typeof import('../stack.js');
    const { startStack, stackEnvironment } = (await import(
      pathToFileURL(path.join(buildDir, 'stack.js')).href
    )) as StackModule;
    // A stack that does start is stopped here, so it can't outlive the test.
    const outcome = await startStack({
      services: ['web'],
      mode: 'development',
      workspaceDir: ws,
      killOthers: true,
      waitTimeout: 30,
      env: stackEnvironment({ ...process.env, CI: '1' }),
    }).then(
      async (stack) => {
        await stack.stop();
        return 'started';
      },
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(
      `a development session is recorded as running (pid ${String(pid)}), but stackctl can't confirm that process is that session, so it won't kill it. ` +
        `If no development session of this workspace is running, delete ${record} and start again.`,
    );
    expect(alive(pid)).toBe(true);
  }, 45_000);
});
