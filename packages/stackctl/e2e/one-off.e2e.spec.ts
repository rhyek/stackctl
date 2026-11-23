/**
 * `stackctl exec` hands the terminal to the command: on a terminal the command sees one, and
 * without one (or for a coding agent) its output is piped and logged, as before. With `-s` or
 * `-t`, `exec` and `run` run the command in several services at once, each line labelled.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { processStartTime } from '../src/process-info';
import { cliPath } from './cli';
import { PORTS } from './fixture';
import { CliProcess, type Owned, childEnv, runCli, signalOwned, track, until } from './processes';
import { Pty, stripAnsi } from './pty';
import { fixtureWorkspace } from './suite';

const ws = fixtureWorkspace();

/**
 * What a wrapped command prints: `STACKCTL_NESTED` as it sees it, the variables of the workspace's
 * and its service's `.env` files, `PORT`, and whether `STACKCTL_INJECTED_ENV` names the service's.
 */
const MARKER = `echo "nested: [$STACKCTL_NESTED] ws=[$E2E_WS_VAR] svc=[$E2E_SVC_VAR] port=[$PORT] injected=[$(echo $STACKCTL_INJECTED_ENV | grep -c E2E_SVC_VAR)]"`;

beforeAll(() => {
  // `stackctl` on the scripts' PATH, as a workspace that installed it has it: the suite's build,
  // whose `cli.js` plain `tsc` leaves without its executable bit, so a shim runs it.
  const bin = path.join(ws(), 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'stackctl'), `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`, { mode: 0o755 }); // oxfmt-ignore
  // `.env` files, the workspace's and a service's, which the wrapped commands must still get.
  fs.writeFileSync(path.join(ws(), '.env.development'), 'E2E_WS_VAR=from-workspace\n');
  for (const name of ['worker', 'api']) {
    fs.writeFileSync(path.join(ws(), 'apps', name, '.env.development'), `E2E_SVC_VAR=from-${name}\n`); // oxfmt-ignore
  }
  // A dev script that wraps its command in `stackctl exec`, and a script that does the same.
  const pkg = (name: string) => path.join(ws(), 'apps', name, 'package.json');
  const worker = JSON.parse(fs.readFileSync(pkg('worker'), 'utf8'));
  worker.scripts.dev = `stackctl exec -- sh -c '${MARKER}; exec node ../../server.ts worker'`;
  fs.writeFileSync(pkg('worker'), JSON.stringify(worker));
  const api = JSON.parse(fs.readFileSync(pkg('api'), 'utf8'));
  api.scripts.wrapped = `stackctl exec -- sh -c 'echo wrapped-out; ${MARKER}'`;
  fs.writeFileSync(pkg('api'), JSON.stringify(api));
  // The many form's scripts: `check` on both `backend` services, `fail` that fails at once on
  // `web` and runs on in `api`, `only-api` on `api` alone, and `wrap-many` running the many form
  // inside a script.
  const addScripts = (name: string, scripts: Record<string, string>) => {
    const json = JSON.parse(fs.readFileSync(pkg(name), 'utf8'));
    Object.assign(json.scripts, scripts);
    fs.writeFileSync(pkg(name), JSON.stringify(json));
  };
  addScripts('api', { check: 'echo check-api', fail: 'sleep 30', 'only-api': 'echo only-api' });
  addScripts('worker', { check: 'echo check-worker' });
  addScripts('web', { fail: 'exit 3', 'wrap-many': 'stackctl exec -s api -- echo inner' });
});

/** The command lines of `pid`'s ancestors below `top`, nearest first. */
function ancestors(pid: number, top: number): string[] {
  const lines: string[] = [];
  for (let at = ppidOf(pid); at !== top && at > 1; at = ppidOf(at)) {
    lines.push(
      execFileSync('ps', ['-o', 'command=', '-p', String(at)], { encoding: 'utf8' }).trim(),
    );
  }
  return lines;
}

function ppidOf(pid: number): number {
  return Number(
    execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
  );
}

/** The development profile's session folders, oldest first. */
const sessionDirs = () => {
  const dir = path.join(ws(), 'node_modules', '.stackctl', 'profiles', 'development', 'sessions');
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .sort()
        .map((id) => path.join(dir, id))
    : [];
};

/** Every one-off log there, as text. */
const oneOffLogs = () =>
  sessionDirs().flatMap((dir) => {
    const commands = path.join(dir, 'commands');
    return fs.existsSync(commands)
      ? fs.readdirSync(commands).map((name) => fs.readFileSync(path.join(commands, name), 'utf8'))
      : [];
  });

/** Every `one-off-command` line of the event logs there. */
const oneOffEvents = () =>
  sessionDirs().flatMap((dir) => {
    const file = path.join(dir, 'events.jsonl');
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((line) => line.type === 'one-off-command')
      : [];
  });

/** A command printing whether its stdout and stderr are terminals, tagged so its log is found. */
const probe = (tag: string) => [
  'exec',
  '--',
  'node',
  '-e',
  `console.log('${tag}', String(process.stdout.isTTY), String(process.stderr.isTTY))`,
];

/** The lines of the one-off log whose first line names `tag`, without their timestamps. */
function logOf(tag: string): string[] {
  const sessions = path.join(
    ws(),
    'node_modules',
    '.stackctl',
    'profiles',
    'development',
    'sessions',
  );
  for (const session of fs.readdirSync(sessions)) {
    const dir = path.join(sessions, session, 'commands');
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const lines = fs.readFileSync(path.join(dir, name), 'utf8').trimEnd().split('\n');
      if (lines[0]?.includes(tag)) {
        return lines.map((line) => line.replace(/^\S+ \S+ /, ''));
      }
    }
  }
  throw new Error(`no one-off log names ${tag}`);
}

test('on a terminal, the command gets the terminal; the log records the run', async () => {
  const pty = await Pty.start({ cwd: ws(), args: probe('on-a-tty') });
  expect(await pty.waitForExit()).toEqual({ code: 0, signal: null });
  expect(pty.text()).toContain('on-a-tty true true');
  const log = logOf('on-a-tty');
  expect(log.slice(1)).toEqual([
    'stdout and stderr went to the terminal, not to this log',
    expect.stringMatching(/^✔ finished in /),
  ]);
});

test('without a terminal, the output is piped and logged', async () => {
  const proc = await runCli(probe('no-tty'), { cwd: ws() });
  expect(await proc.waitForExit()).toEqual({ code: 0, signal: null });
  expect(proc.stdout).toBe('no-tty undefined undefined\n');
  expect(logOf('no-tty').slice(1)).toEqual([
    'no-tty undefined undefined',
    expect.stringMatching(/^✔ finished in /),
  ]);
});

test('a coding agent on a terminal still gets pipes, and its log holds the output', async () => {
  const pty = await Pty.start({
    cwd: ws(),
    // An agent names the profile.
    args: ['--profile', 'development', ...probe('agent-tty')],
    env: { STACKCTL_STARTED_BY_AGENT: '1' },
  });
  expect(await pty.waitForExit()).toEqual({ code: 0, signal: null });
  expect(pty.text()).toContain('agent-tty undefined undefined');
  expect(logOf('agent-tty')[1]).toBe('agent-tty undefined undefined');
});

test("a session's dev script wrapped in exec: its output logged once, and no one-off event", async () => {
  const logsBefore = oneOffLogs().length;
  const eventsBefore = oneOffEvents().length;
  const session = await CliProcess.start(['--headless', '-s', 'worker'], { cwd: ws() });
  await session.waitForOutput(/\[worker\s*\] worker listening on \d+/);
  // Nothing between the session and the worker: the `stackctl exec` became the command.
  const pids = path.join(ws(), '.e2e-pids');
  const server = Number(
    fs
      .readdirSync(pids)
      .find((name) => name.startsWith('worker-'))!
      .slice(7),
  );
  // (A shell may stay between them, where `/bin/sh -c` doesn't exec its last command.)
  expect(ancestors(server, session.child.pid!).filter((line) => line.includes(cliPath))).toEqual(
    [],
  );
  session.child.kill('SIGINT');
  expect(await session.waitForExit()).toEqual({ code: 0, signal: null });
  // The wrapped command didn't get the mark: what it runs is its own.
  // It became the command with the environment resolved for it: both files', and the list a
  // stackctl it starts drops them by.
  expect(session.stdout).toMatch(/\[worker\s*\] nested: \[\] ws=\[from-workspace\] svc=\[from-worker\] port=\[\] injected=\[1\]/); // oxfmt-ignore
  const log = fs.readFileSync(path.join(sessionDirs().at(-1)!, 'logs.txt'), 'utf8');
  expect(log.match(/worker listening on/g)).toHaveLength(1);
  expect(oneOffLogs()).toHaveLength(logsBefore);
  expect(oneOffEvents()).toHaveLength(eventsBefore);
});

test('run of a script wrapping exec: one log and one event, of the run', async () => {
  const logsBefore = oneOffLogs().length;
  const eventsBefore = oneOffEvents().length;
  const proc = await runCli(['run', 'api', 'wrapped'], { cwd: ws() });
  expect(await proc.waitForExit(), proc.stderr).toEqual({ code: 0, signal: null });
  expect(proc.stdout).toBe(
    `wrapped-out\nnested: [] ws=[from-workspace] svc=[from-api] port=[${String(PORTS.api)}] injected=[1]\n`,
  );
  const logs = oneOffLogs().slice(logsBefore);
  expect(logs).toHaveLength(1);
  // The command's output, once: the line the log's first line names it on aside.
  expect(logs[0]!.match(/^\S+ \S+ wrapped-out$/gm)).toHaveLength(1);
  expect(oneOffEvents().slice(eventsBefore)).toEqual([
    expect.objectContaining({ phase: 'begin', kind: 'run', script: 'wrapped' }),
    expect.objectContaining({ phase: 'end', kind: 'run', script: 'wrapped', exitCode: 0 }),
  ]);
});

test('a nested exec becomes the command as a child would start: blocking streams, SIGPIPE at its default', () => {
  // As a dev script's `sctl exec` is: under the mark, every stream a pipe.
  const run = (...command: string[]) =>
    spawnSync(process.execPath, [cliPath, 'exec', '--', ...command], {
      cwd: ws(),
      env: childEnv({ STACKCTL_NESTED: '1' }),
      input: 'from stdin\n',
      encoding: 'utf8',
    });
  const flags = run('python3', '-c', "import os,fcntl,sys;print([bool(fcntl.fcntl(fd,fcntl.F_GETFL)&os.O_NONBLOCK) for fd in (0,1,2)], repr(sys.stdin.read()))"); // oxfmt-ignore
  expect(flags.stdout, flags.stderr).toBe("[False, False, False] 'from stdin\\n'\n");
  // A writer whose reader has gone is ended by SIGPIPE, quietly, as in a shell.
  const pipe = run('sh', '-c', 'yes | head -1');
  expect({ status: pipe.status, stdout: pipe.stdout, stderr: pipe.stderr }).toEqual({
    status: 0,
    stdout: 'y\n',
    stderr: '',
  });
});

/** `pid`'s children, as `ps` lists them now: their pids and command lines. */
function childrenOf(pid: number): { pid: number; command: string }[] {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match !== null && Number(match[2]) === pid)
    .map((match) => ({ pid: Number(match![1]), command: match![3]! }));
}

/** Whether `owned` is still the process it was when its start time was read. */
async function alive(owned: Owned): Promise<boolean> {
  return owned.startedAt !== null && (await processStartTime(owned.pid)) === owned.startedAt;
}

describe('the many form', () => {
  test('run -t backend check: both scripts run, labelled; exit 0', async () => {
    const proc = await runCli(['run', '-t', 'backend', 'check'], { cwd: ws() });
    expect(await proc.waitForExit(), proc.stderr).toEqual({ code: 0, signal: null });
    expect(proc.stdout).toMatch(/\[api\s*\] check-api/);
    expect(proc.stdout).toMatch(/\[worker\s*\] check-worker/);
    expect(proc.stderr).toMatch(/^stackctl: 2 ok$/m);
    // The summary is stderr's alone: stdout has the scripts' lines and nothing else.
    expect(proc.stdout).not.toContain('stackctl:');
  });

  test("exec -s api -s worker -- sh -c 'echo $PORT': each line carries its own service's port", async () => {
    const proc = await runCli(
      ['exec', '-s', 'api', '-s', 'worker', '--', 'sh', '-c', 'echo "port=[$PORT] $E2E_SVC_VAR"'],
      { cwd: ws() },
    );
    expect(await proc.waitForExit(), proc.stderr).toEqual({ code: 0, signal: null });
    expect(proc.stdout).toMatch(new RegExp(`\\[api\\s*\\] port=\\[${String(PORTS.api)}\\] from-api$`, 'm')); // oxfmt-ignore
    // worker has no port.
    expect(proc.stdout).toMatch(/\[worker\s*\] port=\[\] from-worker$/m);
  });

  test('run -s web -s api fail: the first failure stops the rest; exit 1', async () => {
    const started = Date.now();
    const proc = await runCli(['run', '-s', 'web', '-s', 'api', 'fail'], { cwd: ws() });
    expect(await proc.waitForExit(), proc.stderr).toEqual({ code: 1, signal: null });
    // `api`'s `sleep 30` was stopped, not waited for.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(proc.stderr).toMatch(/^stackctl: 1 failed, 1 stopped$/m);
    expect(proc.stderr).toMatch(/^ {2}web\s+failed\s+exit 3, /m);
    expect(proc.stderr).toMatch(/^ {2}api\s+stopped\s+/m);
  });

  test('--ignore-sibling-error lets the others finish', async () => {
    const proc = await runCli(
      [
        'exec',
        '-s',
        'web',
        '-s',
        'api',
        '--ignore-sibling-error',
        '--',
        'sh',
        '-c',
        'if [ "$(basename "$PWD")" = web ]; then exit 3; fi; sleep 1; echo finished',
      ],
      { cwd: ws() },
    );
    expect(await proc.waitForExit(), proc.stderr).toEqual({ code: 1, signal: null });
    expect(proc.stdout).toMatch(/\[api\s*\] finished$/m);
    expect(proc.stderr).toMatch(/^stackctl: 1 ok, 1 failed$/m);
    expect(proc.stderr).toMatch(/^ {2}api\s+ok\s+/m);
    expect(proc.stderr).toMatch(/^ {2}web\s+failed\s+exit 3, /m);
  });

  test('run -t backend only-api: a tagged service without the script is skipped', async () => {
    const proc = await runCli(['run', '-t', 'backend', 'only-api'], { cwd: ws() });
    expect(await proc.waitForExit(), proc.stderr).toEqual({ code: 0, signal: null });
    expect(proc.stderr).toContain('skipping worker: no "only-api" script');
    expect(proc.stdout).toMatch(/\[api\s*\] only-api$/m);
    expect(proc.stdout).not.toContain('worker');
    expect(proc.stderr).toMatch(/^stackctl: 1 ok, 1 skipped$/m);
  });

  test('run -s worker only-api: named, the missing script is an error before anything runs', async () => {
    const proc = await runCli(['run', '-s', 'worker', 'only-api'], { cwd: ws() });
    expect(await proc.waitForExit()).toEqual({ code: 1, signal: null });
    expect(proc.stderr).toContain('No "only-api" script or make target found in');
    expect(proc.stderr).not.toContain('stackctl:');
    expect(proc.stdout).toBe('');
  });

  test('nested: a script that runs the many form prints its lines labelled, with no date stamp of their own', async () => {
    const proc = await runCli(['run', 'web', 'wrap-many'], { cwd: ws() });
    expect(await proc.waitForExit(), proc.stderr).toEqual({ code: 0, signal: null });
    expect(proc.stdout).toMatch(/^\[api\s*\] inner$/m);
  });

  test('Ctrl-C ends every command and gives the terminal back', async () => {
    const pty = await Pty.start({
      cwd: ws(),
      args: ['exec', '-s', 'api', '-s', 'worker', '--', 'sleep', '30'],
    });
    const cli = pty.owned.pid;
    // Both commands running, read off `ps` as the CLI's own children, before the Ctrl-C.
    await until(
      () => childrenOf(cli).filter((child) => child.command === 'sleep 30').length === 2,
      30_000,
      () => `the two sleeps never started: ${JSON.stringify(childrenOf(cli))}`,
    );
    const sleeps: Owned[] = await Promise.all(
      childrenOf(cli)
        .filter((child) => child.command === 'sleep 30')
        .map(async (child) => ({ pid: child.pid, startedAt: await processStartTime(child.pid) })),
    );
    // Should the CLI leave them, the test still ends them: these pids, and no other.
    track({
      close: async () => {
        await Promise.all(sleeps.map((sleep) => signalOwned(sleep, 'SIGKILL')));
      },
    });

    // A Ctrl-C's SIGINT, sent to the CLI as a terminal sends it to the foreground process group
    // (the commands are each in a group of their own). The driver's terminal is no controlling
    // terminal of the CLI, so a typed `\x03` would raise no signal.
    pty.signal('SIGINT');
    expect(await pty.waitForExit()).toEqual({ code: 130, signal: null });
    const text = stripAnsi(pty.raw());
    expect(text).toMatch(/stackctl: 2 stopped/);
    expect(text).toMatch(/^ {2}api\s+stopped\s+/m);
    expect(text).toMatch(/^ {2}worker\s+stopped\s+/m);
    expect(text).not.toContain('failed');
    for (const sleep of sleeps) {
      expect(await alive(sleep), `sleep ${String(sleep.pid)} still running`).toBe(false);
    }
    // The terminal as it was: the many form never turns on mouse reporting or the alternate
    // screen, and leaves neither on.
    expect(pty.screen.modes.get(1006)).not.toBe(true);
    expect(pty.screen.modes.get(1002)).not.toBe(true);
    expect(pty.screen.modes.get(1049)).not.toBe(true);
  });

  test("Ctrl-C ends a script's background job too", async () => {
    const pidFile = path.join(ws(), '.e2e-background-pid');
    fs.rmSync(pidFile, { force: true });
    // A non-interactive shell starts an `&` job with SIGINT ignored, and this one holds none of
    // the command's pipes: only a sweep of its group, once the shell has ended, reaches it.
    const proc = await CliProcess.start(
      ['exec', '-s', 'api', '--', 'sh', '-c', `sleep 25 >/dev/null 2>&1 & echo $! > '${pidFile}'; sleep 25`], // oxfmt-ignore
      { cwd: ws() },
    );
    await until(
      () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').endsWith('\n'),
      30_000,
      () => `the command never wrote its pid\n--- stderr:\n${proc.stderr}`,
    );
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    const background: Owned = { pid, startedAt: await processStartTime(pid) };
    expect(background.startedAt, `no start time for ${String(pid)}`).not.toBeNull();
    // Should the CLI leave it, the test still ends it: this pid, and no other.
    track({ close: () => signalOwned(background, 'SIGKILL') });

    await signalOwned(proc.owned, 'SIGINT');
    expect(await proc.waitForExit(), proc.stderr).toEqual({ code: 130, signal: null });
    expect(proc.stderr).toMatch(/^ {2}api\s+stopped\s+/m);
    await until(
      async () => !(await alive(background)),
      5_000,
      () => `background sleep ${String(pid)} still running`,
    );
  });

  test('a reader that closes early ends the run quietly, with the commands', async () => {
    const pidFile = path.join(ws(), '.e2e-many-pids');
    fs.rmSync(pidFile, { force: true });
    const proc = await CliProcess.start(
      // `api` prints on; `worker` prints nothing, so no write of its own can end it once the
      // reader is gone: only stackctl can.
      ['exec', '-s', 'api', '-s', 'worker', '--', 'sh', '-c', `echo $$ >> '${pidFile}'; if [ "$(basename "$PWD")" = worker ]; then exec sleep 30; fi; while :; do echo tick; sleep 0.05; done`], // oxfmt-ignore
      { cwd: ws() },
    );
    const lines = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : '').split('\n').filter(Boolean); // oxfmt-ignore
    await until(
      () => lines().length === 2,
      30_000,
      () => `the commands never wrote their pids\n--- stderr:\n${proc.stderr}`,
    );
    const shells: Owned[] = await Promise.all(
      lines().map(async (line) => ({ pid: Number(line), startedAt: await processStartTime(Number(line)) })), // oxfmt-ignore
    );
    for (const shell of shells) {
      expect(shell.startedAt, `no start time for ${String(shell.pid)}`).not.toBeNull();
    }
    // Should the CLI leave them, the test still ends them: these groups, and no other.
    track({
      close: async () => {
        await Promise.all(shells.map((shell) => signalOwned(shell, 'SIGKILL', true)));
      },
    });

    // As `| head -2` does once it has its lines: the reading end of the CLI's stdout closes.
    await proc.waitForOutput('tick');
    proc.child.stdout!.destroy();
    expect(await proc.waitForExit(), proc.stderr).toEqual({ code: 141, signal: null });
    expect(proc.stderr).not.toContain('EPIPE');
    expect(proc.stderr).not.toMatch(/^\s+at /m);
    for (const shell of shells) {
      await until(
        async () => !(await alive(shell)),
        5_000,
        () => `command ${String(shell.pid)} still running`,
      );
    }
  });

  test('each command has its own log file and event-log entry', async () => {
    const logsBefore = oneOffLogs().length;
    const eventsBefore = oneOffEvents().length;
    const proc = await runCli(['run', '-t', 'backend', 'check'], { cwd: ws() });
    expect(await proc.waitForExit(), proc.stderr).toEqual({ code: 0, signal: null });
    const logs = oneOffLogs().slice(logsBefore);
    expect(logs).toHaveLength(2);
    expect(logs.some((log) => /^\S+ \S+ check-api$/m.test(log))).toBe(true);
    expect(logs.some((log) => /^\S+ \S+ check-worker$/m.test(log))).toBe(true);
    const events = oneOffEvents().slice(eventsBefore);
    expect(events).toHaveLength(4);
    for (const service of ['api', 'worker']) {
      expect(events).toContainEqual(
        expect.objectContaining({ phase: 'begin', kind: 'run', service, script: 'check' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          phase: 'end',
          kind: 'run',
          service,
          script: 'check',
          exitCode: 0,
        }),
      );
    }
  });

  test("run api check, the single form, prints only the script's output", async () => {
    const proc = await runCli(['run', 'api', 'check'], { cwd: ws() });
    expect(await proc.waitForExit(), proc.stderr).toEqual({ code: 0, signal: null });
    expect(proc.stdout).toBe('check-api\n');
    expect(proc.stderr).toBe('');
  });
});
