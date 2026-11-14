import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test, expect, afterEach } from 'vitest';
import type { Running } from '../spawn.js';
import {
  packageDir,
  buildDir,
  cli,
  start,
  parentPid,
  type Owned,
  own,
  killOwned,
  ws,
  script,
  lastLine,
  setUpCliWorkspace,
} from './harness.js';

/** `startStack()`, the SDK's way to start a stack, and `stackctl wait`. See `harness.ts`. */
setUpCliWorkspace('start-stack');

describe('startStack()', () => {
  type StackModule = typeof import('../stack.js');
  /** The compiled module, so the CLI it runs is the one compiled beside it. */
  const load = () => import(pathToFileURL(path.join(buildDir, 'stack.js')).href) as Promise<StackModule>; // oxfmt-ignore
  const record = () => path.join(ws, 'node_modules', '.stackctl', 'modes', 'development', 'running.json'); // oxfmt-ignore
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (done: () => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!done() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return done();
  };

  /**
   * Processes a test started, stopped after it whatever happened: stacks; helper processes, by
   * their handles; and sessions known only by pid, while each is still the process it was.
   */
  const stacks: { stop: () => Promise<void> }[] = [];
  const helpers: Running[] = [];
  const exited = new WeakSet<Running>();
  const track = (child: Running) => {
    helpers.push(child);
    void child.done.then(() => exited.add(child));
  };
  const owned: Owned[] = [];
  afterEach(async () => {
    for (const stack of stacks.splice(0)) {
      await stack.stop().catch(() => {});
    }
    for (const child of helpers.splice(0)) {
      // By its handle, which signals nothing once the process has been reaped.
      if (!exited.has(child)) {
        child.kill('SIGKILL');
      }
      await child.done;
    }
    for (const session of owned.splice(0)) {
      await killOwned(session);
    }
  });

  /**
   * Keeps `pid`, a session the test started, to be killed after it should it still run: read now,
   * and only while it is still `parent`'s child, so that it surely is that session.
   */
  const keep = async (pid: number, parent: number) => {
    const session = parentPid(pid) === parent ? await own(pid) : null;
    if (session) {
      owned.push(session);
    }
  };

  const startStack = async (
    services: string[],
    extra: { killOthers?: boolean; env?: Record<string, string> } = {},
  ) => {
    const { startStack, stackEnvironment } = await load();
    const { env, ...options } = extra;
    const stack = await startStack({
      services,
      workspaceDir: ws,
      env: { ...stackEnvironment(), ...env },
      ...options,
    });
    stacks.push(stack);
    // Forked by this process.
    await keep(stack.pid, process.pid);
    return stack;
  };

  test("starts a coding agent's suite's stack in the mode its code chose, here none", async () => {
    const stack = await startStack(['wide'], { env: { STACKCTL_STARTED_BY_AGENT: '1' } });
    expect(stack).toMatchObject({ session: 'started', mode: 'development', modeSource: 'default' }); // oxfmt-ignore
    await stack.stop();
  }, 30_000);

  test('starts a stack, and stop() ends its session and deletes its record', async () => {
    const stack = await startStack(['wide']);
    expect(stack).toMatchObject({ session: 'started', mode: 'development', modeSource: 'default', domain: null, services: ['wide'] }); // oxfmt-ignore
    // Every configured service's origin, selected or not.
    expect(stack.origins).toEqual({
      api: 'http://localhost:21053',
      portonly: 'http://localhost:21051',
    });
    const status = await stack.control.query.status();
    expect(status).toMatchObject({ ready: { wide: true }, sessionReady: true });
    // Its record names it, by pid and session id.
    expect(JSON.parse(fs.readFileSync(record(), 'utf8'))).toMatchObject({
      pid: stack.pid,
      port: stack.port,
      sessionId: status!.sessionId,
    });

    await stack.stop();
    expect(alive(stack.pid)).toBe(false);
    expect(fs.existsSync(record())).toBe(false);
  }, 60_000);

  test('refuses while a session of its mode runs, and quits it with killOthers', async () => {
    const first = await startStack(['idle']);
    await expect(startStack(['wide'])).rejects.toThrow(
      new RegExp(`already running \\(pid ${String(first.pid)}\\).*killOthers`),
    );
    expect(await first.control.query.status()).not.toBeNull();

    const second = await startStack(['wide'], { killOthers: true });
    expect(await until(() => !alive(first.pid))).toBe(true);
    expect((await second.control.query.status())?.ready).toMatchObject({ wide: true });
  }, 90_000);

  test("throws stackctl's error, after quitting its session", async () => {
    await expect(startStack(['broken'])).rejects.toThrow(
      /broken stopped while starting.*\(log: .*\/sessions\/\d+\/logs\.txt\)/,
    );
    // Nothing was left running: the next call starts a session of its own.
    expect((await startStack(['idle'])).session).toBe('started');
  }, 90_000);

  test('a picked autostart: false service stays stopped, and the stack comes up without it', async () => {
    const stack = await startStack(['idle', 'manual']);
    expect(stack.services).toEqual(['idle']);
    expect(await stack.control.query.status()).toMatchObject({
      services: { idle: 'running', manual: 'stopped' },
      sessionReady: true,
    });
  }, 60_000);

  test('throws what stackctl printed when its session never came up', async () => {
    await expect(startStack(['nope'])).rejects.toThrow(/before the session was up:\n.*nope/s);
  });

  describe('ends with the process that started it', () => {
    /**
     * A process that starts a stack of `idle` and prints a JSON line as it forks the session
     * (`forked`) and once the stack is ready (`ready`).
     */
    const HELPER = `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const fork = cp.fork;
cp.fork = (...args) => {
  const child = fork(...args);
  console.log(JSON.stringify({ forked: child.pid }));
  return child;
};
syncBuiltinESMExports();
const { startStack, stackEnvironment } = await import(process.argv[2]);
const stack = await startStack({
  services: ['idle'],
  workspaceDir: process.argv[3],
  env: stackEnvironment(),
});
console.log(JSON.stringify({ ready: stack.pid }));
setInterval(() => {}, 1e9);
`;

    /** Runs the helper until it prints `key`, then SIGKILLs it; resolves with the session's pid. */
    async function killParentAt(
      key: 'forked' | 'ready',
    ): Promise<{ session: number; children: number[] }> {
      const helper = path.join(ws, 'stack-helper.mjs');
      fs.writeFileSync(helper, HELPER);
      const parent = start(
        'node',
        [helper, pathToFileURL(path.join(buildDir, 'stack.js')).href, ws],
        { cwd: ws },
      );
      track(parent);
      let output = '';
      let session = 0;
      await new Promise<void>((resolve, reject) => {
        const giveUp = setTimeout(
          () => reject(new Error(`never printed ${key}:\n${output}`)),
          60_000,
        );
        parent.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          for (const line of output.split('\n')) {
            try {
              const message = JSON.parse(line) as { forked?: number; ready?: number };
              session ||= message.forked ?? 0;
              if (message[key] !== undefined) {
                clearTimeout(giveUp);
                resolve();
              }
            } catch {
              /* not one of its lines */
            }
          }
        });
      });
      if (!(session > 0)) {
        throw new Error(`never reported the session's pid:\n${output}`);
      }
      await keep(session, parent.pid!);
      // The services it runs, as its record keeps them.
      const children =
        key === 'ready'
          ? ((JSON.parse(fs.readFileSync(record(), 'utf8')) as { children?: { pid: number }[] }).children ?? []).map((c) => c.pid) // oxfmt-ignore
          : [];
      parent.kill('SIGKILL');
      await parent.done;
      return { session, children };
    }

    test('killed once the stack is ready: the session and its services exit', async () => {
      const { session, children } = await killParentAt('ready');
      expect(children.length).toBeGreaterThan(0);
      expect(await until(() => !alive(session))).toBe(true);
      expect(children.filter(alive)).toEqual([]);
      expect(fs.existsSync(record())).toBe(false);
    }, 90_000);

    test('killed while the session is still starting: it exits all the same', async () => {
      const { session } = await killParentAt('forked');
      expect(await until(() => !alive(session))).toBe(true);
    }, 90_000);
  });

  test('a session started from a shell has no parent to end with', async () => {
    // No channel, so nothing to end with: it runs until it is told to stop.
    const child = start('node', [cli, '--headless', '-s', 'idle'], {
      cwd: ws,
    });
    track(child);
    expect(await until(() => fs.existsSync(record()))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(alive(child.pid!)).toBe(true);
    child.kill('SIGTERM');
    await child.done;
    expect(fs.existsSync(record())).toBe(false);
  }, 60_000);

  test('a session takes the id `start --detach` hands it, and its services never see it', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-cli-handed-')));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'handedroot', type: 'module' })); // oxfmt-ignore
      fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      fs.writeFileSync(
        path.join(dir, 'stackctl.config.ts'),
        "import { defineConfig } from 'stackctl';\nexport default defineConfig({ serviceRootDir: 'packages', services: { tell: {} } });\n", // oxfmt-ignore
      );
      const standIn = path.join(dir, 'node_modules', 'stackctl');
      fs.mkdirSync(standIn, { recursive: true });
      fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
      fs.symlinkSync(buildDir, path.join(standIn, 'dist'));
      const tell = path.join(dir, 'packages', 'tell');
      fs.mkdirSync(tell, { recursive: true });
      // The service prints the variable as it sees it, then idles.
      const dev = script("console.log('handed='+(process.env.STACKCTL_SESSION_ID??'none'));setInterval(()=>{},1e9)"); // oxfmt-ignore
      fs.writeFileSync(path.join(tell, 'package.json'), JSON.stringify({ name: 'tell', scripts: { dev } })); // oxfmt-ignore

      const id = String(Date.now() - 5000);
      const child = start('node', [cli, '--headless', '-s', 'tell'], {
        cwd: dir,
        env: { STACKCTL_SESSION_ID: id },
      });
      track(child);
      let output = '';
      child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()));
      expect(await until(() => output.includes('handed=')), output).toBe(true);
      const recorded = path.join(dir, 'node_modules', '.stackctl', 'modes', 'development', 'running.json'); // oxfmt-ignore
      expect(JSON.parse(fs.readFileSync(recorded, 'utf8'))).toMatchObject({ sessionId: id });
      const folder = path.join(dir, 'node_modules', '.stackctl', 'modes', 'development', 'sessions', id); // oxfmt-ignore
      expect(fs.readFileSync(path.join(folder, 'logs.txt'), 'utf8')).toContain('handed=none');
      expect(output).toContain('handed=none');
      child.kill('SIGTERM');
      await child.done;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  describe('stackctl wait', () => {
    /** A workspace of its own with these services, each `dev` a script. */
    function waitWorkspace(services: Record<string, { dev: string; autostart?: boolean }>) {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-cli-wait-')));
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'waitroot', type: 'module' })); // oxfmt-ignore
      fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      const entries = Object.entries(services).map(([name, { autostart }]) => `${name}: ${autostart === undefined ? '{}' : `{ autostart: ${String(autostart)} }`}`); // oxfmt-ignore
      fs.writeFileSync(
        path.join(dir, 'stackctl.config.ts'),
        `import { defineConfig } from 'stackctl';\nexport default defineConfig({ serviceRootDir: 'packages', services: { ${entries.join(', ')} } });\n`, // oxfmt-ignore
      );
      const standIn = path.join(dir, 'node_modules', 'stackctl');
      fs.mkdirSync(standIn, { recursive: true });
      fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
      fs.symlinkSync(buildDir, path.join(standIn, 'dist'));
      for (const [name, { dev }] of Object.entries(services)) {
        fs.mkdirSync(path.join(dir, 'packages', name), { recursive: true });
        fs.writeFileSync(path.join(dir, 'packages', name, 'package.json'), JSON.stringify({ name, scripts: { dev } })); // oxfmt-ignore
      }
      return dir;
    }

    const idle = script('setInterval(()=>{},1e9)');

    test('waits for a session started after it, and leaves alone a service that never autostarts', async () => {
      const dir = waitWorkspace({ idle: { dev: idle }, later: { dev: idle, autostart: false } });
      try {
        const wait = start('node', [cli, 'wait', '--timeout', '30'], { cwd: dir });
        track(wait);
        // Long enough for `wait` to have found no session.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const session = start('node', [cli, '--headless', '-s', 'idle', '-s', 'later'], { cwd: dir }); // oxfmt-ignore
        track(session);
        let ended = false;
        void session.done.then(() => (ended = true));
        const result = await wait.done;
        expect(result.stderr.split('\n')).toEqual(['stackctl: waiting for idle to be healthy', 'stackctl: everything is healthy']); // oxfmt-ignore
        expect(result.stdout).toMatch(/^development session ready: pid \d+, control API on \d+, log .*\/sessions\/\d+\/logs\.txt$/); // oxfmt-ignore
        expect(result.exitCode).toBe(0);
        // Read-only: the session is still up.
        expect(ended).toBe(false);
        session.kill('SIGTERM');
        await session.done;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    test('fails at once when a service stops while the session starts', async () => {
      const dir = waitWorkspace({ crash: { dev: script('setTimeout(()=>process.exit(3),300)') } });
      try {
        const session = start('node', [cli, '--headless', '-s', 'crash'], { cwd: dir }); // oxfmt-ignore
        track(session);
        const started = Date.now();
        const result = await start('node', [cli, 'wait', '--timeout', '30'], { cwd: dir }).done; // oxfmt-ignore
        expect(lastLine(result.stderr)).toMatch(/^stackctl: crash stopped while starting; see .*\/sessions\/\d+\/logs\.txt$/); // oxfmt-ignore
        expect(result.exitCode).toBe(1);
        expect(Date.now() - started).toBeLessThan(20_000);
        session.kill('SIGTERM');
        await session.done;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    test('says no session started when none did by the timeout', async () => {
      const dir = waitWorkspace({ idle: { dev: idle } });
      try {
        const result = await start('node', [cli, 'wait', '--timeout', '1'], { cwd: dir }).done; // oxfmt-ignore
        expect(result.stderr).toBe('stackctl: no development session started within 1s');
        expect(result.exitCode).toBe(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  });
});
