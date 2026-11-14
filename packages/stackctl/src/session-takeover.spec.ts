import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { processCwd } from './process-info.js';
import { writeRunning } from './running.js';
import {
  devPorts,
  freeDevPorts,
  groupMembers,
  pidsFromLsof,
  parsePidPairs,
  pidsFromSs,
  quitSession,
  sortHolders,
  startedSince,
  sweepOrphans,
  sweepableGroups,
  terminateSession,
  treeOf,
} from './session-takeover.js';

const unix = process.platform !== 'win32';

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];

function tmpDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-takeover-')));
  tmpDirs.push(dir);
  return dir;
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

afterEach(() => {
  // Only the children these tests spawned, by their own group, and only while still unreaped.
  for (const child of children.splice(0)) {
    if (running(child)) {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A shell running `script` in `cwd`, leading its own process group. */
function detached(script: string, cwd: string): ChildProcess {
  const child = spawn('sh', ['-c', script], { cwd, detached: true, stdio: 'ignore' });
  children.push(child);
  return child;
}

/** A node process idling, leading its own process group; ends on SIGTERM. */
function idle(cwd: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { cwd, detached: true, stdio: 'ignore' }); // oxfmt-ignore
  children.push(child);
  return child;
}

/** A pid that was a child of this process and is reaped now. */
function reapedPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid!;
}

async function until(check: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('command output', () => {
  test('lsof -t lists one pid per line; empty output lists none', () => {
    expect(pidsFromLsof('1234\n5678\n')).toEqual([1234, 5678]);
    expect(pidsFromLsof('')).toEqual([]);
  });

  test("ss names the listener's pid in its users field", () => {
    expect(pidsFromSs('LISTEN 0 511 *:3000 *:* users:(("node",pid=4242,fd=20))\n')).toEqual([4242]); // oxfmt-ignore
  });

  test('ss pid=0 is dropped, a later pid kept', () => {
    expect(pidsFromSs('LISTEN 0 511 *:3000 *:* users:(("x",pid=0,fd=3),("node",pid=4242,fd=20))')).toEqual([4242]); // oxfmt-ignore
  });

  test('ps pid/group output parses to pairs; a line without two integers is skipped', () => {
    expect(parsePidPairs(' 100 100\n 200 100\n 300 300\n')).toEqual([
      { pid: 100, other: 100 },
      { pid: 200, other: 100 },
      { pid: 300, other: 300 },
    ]);
    expect(parsePidPairs('PID PGID\n 1 x\n\n 7 7 7\n 8 8\n')).toEqual([{ pid: 8, other: 8 }]);
  });

  test('members are grouped by group id', () => {
    const members = groupMembers(parsePidPairs(' 100 100\n 200 100\n 300 300\n'));
    expect(members.get(100)).toEqual([100, 200]);
    expect(members.get(300)).toEqual([300]);
  });
});

describe('tree kill set', () => {
  test('the roots and their transitive descendants, nothing else', () => {
    const table = parsePidPairs('  100     1\n  200   100\n  300   200\n  999     1\n');
    expect(treeOf([100], table).sort((a, b) => a - b)).toEqual([100, 200, 300]);
    expect(treeOf([], table)).toEqual([]);
  });

  test('the walk neither takes this process nor goes below it', () => {
    const table = parsePidPairs('  100     1\n  200   100\n  300   200\n  400   100\n');
    // 200 standing for this process: its child 300 is spared with it, its sibling 400 is not.
    expect(treeOf([100], table, (pid) => pid === 200).sort((a, b) => a - b)).toEqual([100, 400]);
  });
});

test('a pid counts as given to another process only when it started past the slack', () => {
  expect(startedSince(10_000, 10_000)).toBe(false);
  // A second's drift in `ps`'s start time is the same process.
  expect(startedSince(10_000, 11_000)).toBe(false);
  expect(startedSince(10_000, 11_001)).toBe(true);
  expect(startedSince(null, 50_000)).toBe(false);
  expect(startedSince(10_000, null)).toBe(false);
});

test('dev ports are deduplicated, missing and NaN ones dropped', () => {
  expect(devPorts([3000, 3000, undefined, Number.NaN, 4099])).toEqual([3000, 4099]);
});

describe('which recorded groups the sweep considers', () => {
  const cwd = '/work/repo/packages/api';

  test('a group whose leader has exited is found through its remaining member', () => {
    expect(sweepableGroups([{ pid: 100, cwd }], [{ pid: 200, other: 100 }], 1)).toEqual([
      { child: { pid: 100, cwd }, members: [200] },
    ]);
  });

  test('a group with no live member is not', () => {
    expect(sweepableGroups([{ pid: 100, cwd }], [{ pid: 300, other: 300 }], 1)).toEqual([]);
  });

  test('records with pid 0 or negative are skipped', () => {
    const table = [
      { pid: 0, other: 0 },
      { pid: 5, other: -1 },
    ];
    expect(
      sweepableGroups(
        [
          { pid: 0, cwd: '/' },
          { pid: -1, cwd: '/' },
        ],
        table,
        1,
      ),
    ).toEqual([]);
  });

  test("this process's own pid is never swept, even when recorded", () => {
    expect(sweepableGroups([{ pid: 4000, cwd }], [{ pid: 4000, other: 4000 }], 4000)).toEqual([]);
  });

  test('a group this process belongs to is never swept, even when the directory matches', () => {
    const table = [
      { pid: 4000, other: 4000 },
      { pid: 4001, other: 4000 },
    ];
    expect(sweepableGroups([{ pid: 4000, cwd }], table, 4001)).toEqual([]);
  });

  test('a group a live other-profile session recorded, or holding that session, is never swept', () => {
    const table = [
      { pid: 100, other: 100 },
      { pid: 300, other: 300 },
      { pid: 301, other: 300 },
    ];
    const others = { pids: new Map([[301, 'test']]), groups: new Map([[100, 'test']]) };
    const children = [
      { pid: 100, cwd },
      { pid: 300, cwd },
    ];
    expect(sweepableGroups(children, table, 1, others)).toEqual([]);
  });
});

describe('which dev-port holders are killed', () => {
  const root = '/work/repo';
  const none = { pids: new Map<number, string>(), groups: new Map<number, string>() };

  test("the workspace's holders are killed; one in this process's group is left without a word", () => {
    const holders = [
      { pid: 10, cwd: '/work/repo/web', group: 10 },
      { pid: 11, cwd: '/work/repo/api', group: undefined },
      { pid: 12, cwd: '/work/repo', group: 7 },
    ];
    expect(sortHolders(holders, { root, ownGroup: 7, others: none })).toEqual({ kill: [10, 11], messages: [] }); // oxfmt-ignore
  });

  test("a holder whose directory can't be read is another program's", () => {
    expect(
      sortHolders([{ pid: 20, cwd: null, group: 20 }], { root, ownGroup: 7, others: none }),
    ).toEqual({
      // oxfmt-ignore
      kill: [],
      messages: ['dev port held by another program (pid 20) — leaving it alone'],
    });
  });

  test("another profile's session itself is left wherever it runs; its groups, in the workspace", () => {
    const others = { pids: new Map([[30, 'test']]), groups: new Map([[40, 'test']]) };
    const holders = [
      { pid: 30, cwd: '/elsewhere', group: 5 },
      { pid: 41, cwd: '/work/repo/web', group: 40 },
      { pid: 42, cwd: '/elsewhere', group: 40 },
    ];
    expect(sortHolders(holders, { root, ownGroup: 7, others })).toEqual({
      kill: [],
      messages: [
        "dev port held by this project's test session (pid 30) — leaving it alone",
        "dev port held by this project's test session (pid 41) — leaving it alone",
        'dev port held by another program (pid 42) — leaving it alone',
      ],
    });
  });
});

describe.runIf(unix)('the orphan sweep', () => {
  test('does nothing with no previous record, or one with no children', async () => {
    const root = tmpDir();
    expect(await sweepOrphans(root, 'development', null)).toEqual([]);
    expect(await sweepOrphans(root, 'development', { port: 1, pid: reapedPid() })).toEqual([]);
    expect(await sweepOrphans(root, 'development', { port: 1, pid: reapedPid(), children: [] })).toEqual([]); // oxfmt-ignore
  });

  test('leaves a detached child alone while the recording session is alive', async () => {
    const dir = tmpDir();
    const child = detached('sleep 30', dir);
    const record = { port: 1, pid: process.pid, children: [{ pid: child.pid!, cwd: dir }] };
    expect(await sweepOrphans(dir, 'development', record)).toEqual([]);
    expect(alive(child.pid!)).toBe(true);
  });

  test('skips a group a live other-profile session recorded, though a stale record names it', async () => {
    const dir = tmpDir();
    const child = detached('sleep 30', dir);
    // The live `test` session (this process stands in for it) recorded the same group.
    writeRunning(dir, { port: 1, pid: process.pid, children: [{ pid: child.pid!, cwd: dir }] }, 'test'); // oxfmt-ignore
    const stale = { port: 1, pid: reapedPid(), children: [{ pid: child.pid!, cwd: dir }] };
    expect(await sweepOrphans(dir, 'development', stale)).toEqual([]);
    expect(alive(child.pid!)).toBe(true);
  });

  test("kills an orphan's tree but not a live other-profile session below it", async () => {
    const dir = tmpDir();
    // The orphan started a detached process that is now the live `test` session.
    const code = `
      import { spawn } from 'node:child_process';
      const below = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { detached: true, stdio: 'ignore' });
      console.log(below.pid);
      setInterval(() => {}, 1e9);
    `;
    const orphan = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); // oxfmt-ignore
    children.push(orphan);
    const below = Number(((await once(orphan.stdout!, 'data')) as [Buffer])[0].toString().trim());
    try {
      writeRunning(dir, { port: 1, pid: below }, 'test');
      const stale = { port: 1, pid: reapedPid(), children: [{ pid: orphan.pid!, cwd: dir }] };
      const exited = once(orphan, 'exit');
      const killed = await sweepOrphans(dir, 'development', stale);
      await exited;
      expect(killed).toEqual([orphan.pid]);
      expect(alive(below)).toBe(true);
    } finally {
      // Started by this test's own child, and leading its own group.
      if (alive(below)) {
        process.kill(-below, 'SIGKILL');
      }
    }
  });

  test("kills that child once the recording session's pid is dead", async () => {
    const dir = tmpDir();
    // `sleep` itself, not through `sh -c`: Debian's and Ubuntu's `/bin/sh` (dash) stays as its
    // parent, which would make the group two processes there and one on macOS.
    const child = spawn('sleep', ['30'], { cwd: dir, detached: true, stdio: 'ignore' });
    children.push(child);
    const messages: string[] = [];
    const record = { port: 1, pid: reapedPid(), children: [{ pid: child.pid!, cwd: dir }] };
    const exited = once(child, 'exit');
    expect(await sweepOrphans(dir, 'development', record, (m) => messages.push(m))).toContain(child.pid!); // oxfmt-ignore
    await exited;
    expect(messages).toEqual(['cleaning up 1 orphaned process(es) from a previous session']);
  });

  test('kills a recorded group whose script moved into a subdirectory', async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'src'));
    const child = detached('cd src && sleep 30', dir);
    await until(async () => (await processCwd(child.pid!)) === path.join(dir, 'src'));
    const record = { port: 1, pid: reapedPid(), children: [{ pid: child.pid!, cwd: dir }] };
    const exited = once(child, 'exit');
    expect(await sweepOrphans(dir, 'development', record)).toContain(child.pid!);
    await exited;
  });

  test('leaves a recorded group alone when its script moved out of the recorded directory', async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'pkg'));
    const child = detached('cd .. && sleep 30', path.join(dir, 'pkg'));
    await until(async () => (await processCwd(child.pid!)) === dir);
    const record = {
      port: 1,
      pid: reapedPid(),
      children: [{ pid: child.pid!, cwd: path.join(dir, 'pkg') }],
    };
    expect(await sweepOrphans(dir, 'development', record)).toEqual([]);
    expect(alive(child.pid!)).toBe(true);
  });
});

/** A port nothing listened on a moment ago. */
async function deadPort(): Promise<number> {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A process listening on a fresh port from `cwd`, leading its own group; resolves with its port. */
async function listener(cwd: string): Promise<{ child: ChildProcess; port: number }> {
  const code =
    "import net from 'node:net'; const s = net.createServer().listen(0, '127.0.0.1', () => console.log(s.address().port));"; // oxfmt-ignore
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  children.push(child);
  const [chunk] = (await once(child.stdout!, 'data')) as [Buffer];
  return { child, port: Number(chunk.toString().trim()) };
}

describe.runIf(unix)('freeing the dev ports', () => {
  test("kills the workspace's holders and leaves another profile's and a foreign program's", async () => {
    const root = tmpDir();
    const outside = tmpDir();
    fs.mkdirSync(path.join(root, 'web'));
    const own = await listener(path.join(root, 'web'));
    const otherProfile = await listener(root);
    const otherSession = await listener(root);
    const foreign = await listener(outside);
    // A live `test` session, which is the third listener, recorded the second listener's group.
    writeRunning(root, { port: 1, pid: otherSession.child.pid!, children: [{ pid: otherProfile.child.pid!, cwd: root }] }, 'test'); // oxfmt-ignore
    const free = await deadPort();

    const messages: string[] = [];
    const exited = once(own.child, 'exit');
    await freeDevPorts({
      root,
      profile: 'development',
      ports: [own.port, otherProfile.port, otherSession.port, foreign.port, free],
      onStatus: (m) => messages.push(m),
    });
    await exited;

    // Under a loaded suite another test may have taken the released port meanwhile: its holder
    // is no process of this test's, so only the messages naming these are compared.
    const ours = [otherProfile, otherSession, foreign].map(
      ({ child }) => `(pid ${String(child.pid)})`,
    );
    const seen = messages.filter((m, i) => i === 0 || ours.some((p) => m.includes(p)));
    const held = (pid?: number) => `dev port held by this project's test session (pid ${String(pid)}) — leaving it alone`; // oxfmt-ignore
    expect(seen[0]).toBe('freeing dev ports');
    // The other profile's lines, in the order the listeners were found, then the foreign one.
    expect(seen.slice(1, 3).sort()).toEqual([held(otherProfile.child.pid), held(otherSession.child.pid)].sort()); // oxfmt-ignore
    expect(seen.slice(3)).toEqual([`dev port held by another program (pid ${String(foreign.child.pid)}) — leaving it alone`]); // oxfmt-ignore
    expect(running(otherProfile.child)).toBe(true);
    expect(running(otherSession.child)).toBe(true);
    expect(running(foreign.child)).toBe(true);
  }, 20_000);

  test("leaves a holder in another profile's session's own group, which it never recorded", async () => {
    const root = tmpDir();
    // The `test` session's process starts a listener in its own group, not as a recorded child.
    const code = `
      import { spawn } from 'node:child_process';
      const listener = "import net from 'node:net'; const s = net.createServer().listen(0, '127.0.0.1', () => console.log(s.address().port));";
      const child = spawn(process.execPath, ['--input-type=module', '-e', listener], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.once('data', (port) => console.log(JSON.stringify({ port: Number(port), pid: child.pid })));
      setInterval(() => {}, 1e9);
    `;
    const session = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); // oxfmt-ignore
    children.push(session);
    const [chunk] = (await once(session.stdout!, 'data')) as [Buffer];
    const held = JSON.parse(chunk.toString()) as { port: number; pid: number };
    writeRunning(root, { port: 1, pid: session.pid! }, 'test');

    const messages: string[] = [];
    await freeDevPorts({ root, profile: 'development', ports: [held.port], onStatus: (m) => messages.push(m) }); // oxfmt-ignore
    expect(messages).toEqual([
      'freeing dev ports',
      `dev port held by this project's test session (pid ${String(held.pid)}) — leaving it alone`,
    ]);
    expect(alive(held.pid)).toBe(true);
  }, 20_000);

  test("kills a holder's tree but not a live other-profile session below it", async () => {
    const root = tmpDir();
    // The holder started a detached process that is now the live `test` session.
    const code = `
      import net from 'node:net';
      import { spawn } from 'node:child_process';
      const below = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { detached: true, stdio: 'ignore' });
      const s = net.createServer().listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: s.address().port, below: below.pid })));
    `;
    const holder = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); // oxfmt-ignore
    children.push(holder);
    const [chunk] = (await once(holder.stdout!, 'data')) as [Buffer];
    const { port, below } = JSON.parse(chunk.toString()) as { port: number; below: number };
    try {
      writeRunning(root, { port: 1, pid: below }, 'test');
      const exited = once(holder, 'exit');
      await freeDevPorts({ root, profile: 'development', ports: [port], onStatus: () => {} });
      await exited;
      expect(alive(below)).toBe(true);
    } finally {
      // Started by this test's own child, and leading its own group.
      if (alive(below)) {
        process.kill(-below, 'SIGKILL');
      }
    }
  }, 20_000);

  test("kills nothing when the process groups can't be read, and says so", async () => {
    const root = tmpDir();
    const held = await listener(root);
    // A PATH with the listener command and no `ps`.
    const bin = tmpDir();
    const tool = process.platform === 'darwin' ? 'lsof' : 'ss';
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(found, path.join(bin, tool));
    const messages: string[] = [];
    const saved = process.env.PATH;
    process.env.PATH = bin;
    try {
      await freeDevPorts({ root, profile: 'development', ports: [held.port], onStatus: (m) => messages.push(m) }); // oxfmt-ignore
    } finally {
      process.env.PATH = saved;
    }
    expect(messages).toEqual([
      'freeing dev ports',
      "couldn't read process groups — leaving dev ports alone",
    ]);
    expect(running(held.child)).toBe(true);
  }, 20_000);

  test('says so even with no port to free', async () => {
    const messages: string[] = [];
    await freeDevPorts({ root: tmpDir(), profile: 'development', ports: [], onStatus: (m) => messages.push(m) }); // oxfmt-ignore
    expect(messages).toEqual(['freeing dev ports']);
  });
});

/**
 * A session already shutting down, as `quitSession` meets it (the tests' scope: what the
 * preflight asks before is `takeover.ts`'s): it never answers a quit (a second quit is a hard kill
 * for it), and exits 1 `exitAfterMs` after starting, or never. It runs one service process.
 */
async function stoppingSession(
  exitAfterMs: number | 'never',
): Promise<{ child: ChildProcess; port: number; service: number }> {
  const code = `
    import http from 'node:http';
    import { spawn } from 'node:child_process';
    const service = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
    const server = http.createServer(() => {});
    server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port, service: service.pid })));
    ${exitAfterMs === 'never' ? '' : `setTimeout(() => { service.kill('SIGKILL'); process.exit(1); }, ${String(exitAfterMs)});`}
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); // oxfmt-ignore
  children.push(child);
  const [chunk] = (await once(child.stdout!, 'data')) as [Buffer];
  const { port, service } = JSON.parse(chunk.toString()) as { port: number; service: number };
  return { child, port, service };
}

describe('ending a session', () => {
  test('takeover of a session already stopping', async () => {
    // It ends on its own before the deadline: waited for, never killed.
    const late = await stoppingSession(800);
    const killed: number[] = [];
    const killTree = async (pid: number) => void killed.push(pid);
    const started = Date.now();
    expect(await quitSession(late.port, late.child.pid!, { forceKillAfterMs: 6000, killTree })).toBe('stopped'); // oxfmt-ignore
    expect(Date.now() - started).toBeLessThan(6000);
    expect(killed).toEqual([]);

    // It outlives the deadline: the real tree kill takes it and its service, only past the
    // deadline, and nothing beside it: a sibling process of the same parent stays.
    const stuck = await stoppingSession('never');
    const bystander = idle(tmpDir());
    const asked = Date.now();
    expect(await quitSession(stuck.port, stuck.child.pid!, { forceKillAfterMs: 600 })).toBe('force-killed'); // oxfmt-ignore
    expect(Date.now() - asked).toBeGreaterThanOrEqual(600);
    await until(() => !alive(stuck.service));
    expect(alive(bystander.pid!)).toBe(true);
    expect(alive(process.pid)).toBe(true);
  }, 20_000);

  test('a session the kill leaves running is still-running', async () => {
    const stuck = await stoppingSession('never');
    const outcome = await quitSession(stuck.port, stuck.child.pid!, { forceKillAfterMs: 300, killTree: async () => {} }); // oxfmt-ignore
    expect(outcome).toBe('still-running');
    expect(running(stuck.child)).toBe(true);
  }, 10_000);

  test("this process's own pid, and a nonsense one, are never asked or signalled", async () => {
    const killTree = async () => {
      throw new Error('signalled');
    };
    for (const pid of [process.pid, 0, -1, 1.5]) {
      expect(await quitSession(1, pid, { killTree })).toBe('still-running');
      expect(await terminateSession(pid, { killTree })).toBe('still-running');
    }
  });

  test.runIf(unix)('the SIGTERM variant ends a session that exits on SIGTERM', async () => {
    const child = idle(tmpDir());
    expect(await terminateSession(child.pid!, { forceKillAfterMs: 5000 })).toBe('stopped');
  });
});
