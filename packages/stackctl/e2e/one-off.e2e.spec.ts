/**
 * `stackctl exec` hands the terminal to the command: on a terminal the command sees one, and
 * without one (or for a coding agent) its output is piped and logged, as before.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, expect, test } from 'vitest';
import { cliPath } from './cli.js';
import { PORTS } from './fixture.js';
import { CliProcess, childEnv, runCli } from './processes.js';
import { Pty } from './pty.js';
import { fixtureWorkspace } from './suite.js';

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

/** The development mode's session folders, oldest first. */
const sessionDirs = () => {
  const dir = path.join(ws(), 'node_modules', '.stackctl', 'modes', 'development', 'sessions');
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
  const sessions = path.join(ws(), 'node_modules', '.stackctl', 'modes', 'development', 'sessions');
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
    // An agent names the mode.
    args: ['--mode', 'development', ...probe('agent-tty')],
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
