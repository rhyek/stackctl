import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { Running } from '../spawn';
import {
  buildDir,
  cli,
  killOwned,
  own,
  packageDir,
  script,
  setUpCliWorkspace,
  start,
} from './harness';

/** An application service's hooks, from the command line. See `harness.ts`. */
setUpCliWorkspace('service-lifecycle');

describe("a service's hooks", () => {
  let lws: string;
  const hookLog = () => path.join(lws, 'hook.log');
  /** Each hook run as `hook:trigger`, in order; `[]` before any ran. */
  const runs = () =>
    fs.existsSync(hookLog()) ? fs.readFileSync(hookLog(), 'utf8').trim().split('\n') : [];
  /**
   * Runs the CLI in the workspace as a person would, whatever runs the suite: an agent must name
   * the profile on every command.
   */
  const run = (args: string[], env: Record<string, string> = {}) =>
    start('node', [cli, ...args], { cwd: lws, env });

  beforeAll(() => {
    lws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-cli-svc-lifecycle-')));
    fs.writeFileSync(path.join(lws, 'package.json'), JSON.stringify({ name: 'svclifecycleroot', type: 'module' })); // oxfmt-ignore
    fs.writeFileSync(path.join(lws, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    fs.writeFileSync(
      path.join(lws, 'stackctl.config.ts'),
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "import { defineConfig } from 'stackctl';",
        // Each hook run, as `hook:trigger`.
        "const note = (ctx, hook) => fs.appendFileSync(path.join(ctx.workspaceDir, 'hook.log'), `${hook}:${ctx.trigger}\\n`);",
        // Resolves once the test has made `file` in the workspace: a hook held until then.
        'const held = async (ctx, file) => { while (!fs.existsSync(path.join(ctx.workspaceDir, file))) { await new Promise((r) => setTimeout(r, 20)); } };',
        'export default defineConfig({',
        "  serviceRootDir: 'packages',",
        '  services: {',
        // Its port is from stackctl's block in the port registry (21050–21099).
        "    api: { healthcheck: 'http://127.0.0.1:21092/', lifecycle: {",
        "      beforeStart: (ctx) => { note(ctx, 'beforeStart'); if (process.env.FAIL_BEFORE_START) { throw new Error('no codegen'); } },",
        "      afterStart: (ctx) => note(ctx, 'afterStart'),",
        // With EXEC_AFTER_READY, it runs a command that takes long, and says, a moment after it is
        // asked to end, that it has.
        // With LONG_AFTER_READY, it runs a command that outlasts the test: a shell, which writes its
        // pid and its child's to hook.pids, and that child.
        "      afterReady: async (ctx) => { note(ctx, 'afterReady'); if (process.env.LONG_AFTER_READY) { await ctx.exec('sh', ['-c', 'sleep 300 & echo \"$$ $!\" > \"$PIDS\"; wait'], { env: { PIDS: path.join(ctx.workspaceDir, 'hook.pids') } }); } if (process.env.EXEC_AFTER_READY) { await ctx.exec('sh', ['-c', `trap 'sleep 0.3; echo exec:ended >> \"$LOG\"; exit 0' TERM; echo exec:started >> \"$LOG\"; sleep 30 & wait`], { env: { LOG: path.join(ctx.workspaceDir, 'hook.log') } }); } if (process.env.HOLD_AFTER_READY) { await held(ctx, 'release-ready'); } if (process.env.FAIL_AFTER_READY) { throw new Error('no DATABASE_URL'); } },",
        "      beforeStop: async (ctx) => { note(ctx, 'beforeStop'); if (process.env.HOLD_BEFORE_STOP) { await held(ctx, 'release-stop'); } },",
        "      afterStop: (ctx) => note(ctx, 'afterStop'),",
        "    }, }, web: { deps: [{ service: 'api', wait: true }] },",
        '  },',
        '});',
        '',
      ].join('\n'),
    );
    const standIn = path.join(lws, 'node_modules', 'stackctl');
    fs.mkdirSync(standIn, { recursive: true });
    fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
    fs.symlinkSync(buildDir, path.join(standIn, 'dist'));
    const api = path.join(lws, 'packages', 'api');
    fs.mkdirSync(api, { recursive: true });
    fs.writeFileSync(
      path.join(api, 'package.json'),
      JSON.stringify({
        name: 'api',
        scripts: {
          dev: script(
            "import('node:http').then((h) => h.createServer((q, r) => r.end('ok')).listen(21092)); console.log('api-up')",
          ),
        },
      }),
    );
    const web = path.join(lws, 'packages', 'web');
    fs.mkdirSync(web, { recursive: true });
    fs.writeFileSync(
      path.join(web, 'package.json'),
      JSON.stringify({
        name: 'web',
        scripts: { dev: script("console.log('web-up'); setInterval(()=>{},1e9)") },
      }),
    );
  });

  afterAll(() => {
    fs.rmSync(lws, { recursive: true, force: true });
  });

  const started: Running[] = [];
  afterEach(async () => {
    for (const child of started.splice(0)) {
      const owned = child.pid === undefined ? null : await own(child.pid);
      child.kill('SIGINT');
      await Promise.race([child.done, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (owned) {
        await killOwned(owned);
      }
    }
    for (const file of ['hook.log', 'hook.pids', 'release-ready', 'release-stop']) {
      fs.rmSync(path.join(lws, file), { force: true });
    }
  });

  const ADVICE = 'Run stackctl service restart -s api once it is fixed; a change to stackctl.config.ts needs a new session.'; // oxfmt-ignore
  const STARTED = ['beforeStart:session', 'afterStart:session', 'afterReady:session'];
  /** A `--headless` session of `api`, once its start hooks have run. */
  async function sessionOfApi(env: Record<string, string> = {}, ran = STARTED): Promise<Running> {
    const session = run(['--headless', '-s', 'api'], env);
    started.push(session);
    await vi.waitFor(() => expect(runs()).toEqual(ran), { timeout: 20_000, interval: 50 });
    return session;
  }
  /** What `child` has printed so far, on `stream`. */
  function printed(child: Running, stream: 'stdout' | 'stderr'): () => string {
    let text = '';
    child[stream].on('data', (chunk: Buffer) => (text += chunk.toString()));
    return () => text;
  }

  test(
    'run in order as a --headless session starts the service, around a service restart, and at a quit',
    { timeout: 60_000 },
    async () => {
      const session = await sessionOfApi();
      const restart = await run(['service', 'restart', '-s', 'api']).done;
      expect(restart.exitCode, restart.stderr).toBe(0);
      const restarted = [
        ...STARTED,
        'beforeStop:restart',
        'afterStop:restart',
        'beforeStart:restart',
        'afterStart:restart',
        'afterReady:restart',
      ];
      expect(runs()).toEqual(restarted);

      // Ctrl+C: the stop hooks run around the stop, and the session still exits 0.
      session.kill('SIGINT');
      expect((await session.done).exitCode).toBe(0);
      expect(runs()).toEqual([...restarted, 'beforeStop:quit', 'afterStop:quit']);
    },
  );

  test(
    'service stop waits for a slow beforeStop, saying which hook and how to abandon it; a second stop abandons it, and both succeed',
    { timeout: 60_000 },
    async () => {
      await sessionOfApi({ HOLD_BEFORE_STOP: '1' });
      const first = run(['service', 'stop', '-s', 'api']);
      const said = printed(first, 'stdout');
      await vi.waitFor(
        () =>
          expect(said()).toContain(
            "api's beforeStop is still running: the stop goes on once it has finished. To abandon the hook, stop the service again: stackctl service stop -s api",
          ),
        { timeout: 20_000, interval: 50 },
      );
      // The status names the hook too, and the service as on its way down.
      expect((await run(['status']).done).stdout).toMatch(/api +stopping: its beforeStop is still running/); // oxfmt-ignore

      const second = await run(['service', 'stop', '-s', 'api']).done;
      expect(second.exitCode, second.stderr).toBe(0);
      expect(second.stdout).toBe('stopped api: its beforeStop was still running, and was abandoned'); // oxfmt-ignore
      const waited = await first.done;
      expect(waited.exitCode, waited.stderr).toBe(0);
      expect(waited.stdout.split('\n').at(-1)).toBe('stopped api');
      expect(runs()).toEqual([...STARTED, 'beforeStop:stop', 'afterStop:stop']);
    },
  );

  test(
    'a service stop while its afterReady still runs abandons the hook, says so, and runs the stop hooks after it',
    { timeout: 60_000 },
    async () => {
      const session = await sessionOfApi({ HOLD_AFTER_READY: '1' });
      const log = printed(session, 'stdout');
      const stop = await run(['service', 'stop', '-s', 'api']).done;
      expect(stop.exitCode, stop.stderr).toBe(0);
      expect(stop.stdout).toBe('stopped api: its afterReady was still running, and was abandoned'); // oxfmt-ignore
      expect(runs()).toEqual([...STARTED, 'beforeStop:stop', 'afterStop:stop']);
      await vi.waitFor(() => expect(log()).toContain('afterReady abandoned: the service was stopped')); // oxfmt-ignore
      expect((await run(['status']).done).stdout).toMatch(/api +stopped\n/);
    },
  );

  test(
    'a service stop ends the command its afterReady still runs, and its beforeStop begins only once that command has ended',
    { timeout: 60_000 },
    async () => {
      await sessionOfApi({ EXEC_AFTER_READY: '1' }, [...STARTED, 'exec:started']);
      const stop = await run(['service', 'stop', '-s', 'api']).done;
      expect(stop.exitCode, stop.stderr).toBe(0);
      // The command got SIGTERM, which it had time to act on, before the stop's own hooks ran.
      expect(runs()).toEqual([...STARTED, 'exec:started', 'exec:ended', 'beforeStop:stop', 'afterStop:stop']); // oxfmt-ignore
    },
  );

  test(
    'a beforeStart that fails: the status and service start say why, and no exit is reported for a process that never ran',
    { timeout: 60_000 },
    async () => {
      const session = await sessionOfApi({ FAIL_BEFORE_START: '1' }, ['beforeStart:session']);
      const out = printed(session, 'stderr');
      const status = await vi.waitFor(
        async () => {
          const now = (await run(['status']).done).stdout;
          expect(now).toMatch(/api +stopped: beforeStart failed: no codegen/);
          return now;
        },
        { timeout: 20_000, interval: 100 },
      );
      expect(status).not.toContain('service-exit');
      const again = await run(['service', 'start', '-s', 'api']).done;
      expect(again.exitCode).toBe(1);
      expect(again.stdout).not.toContain('started api');
      expect(again.stderr).toBe(`api failed to start: beforeStart failed: no codegen. ${ADVICE}`);
      // What waits for it says which service, and why.
      const web = await run(['service', 'start', '-s', 'web']).done;
      expect(web.exitCode).toBe(1);
      expect(web.stderr).toContain(`web is waiting for api, which failed to start: beforeStart failed: no codegen. ${ADVICE}`); // oxfmt-ignore
      expect(out()).toContain('failed to start: beforeStart failed: no codegen');
      expect(out()).not.toContain('exited with code');
    },
  );

  test(
    'start --detach fails at once when a service it waits for fails its afterReady',
    { timeout: 60_000 },
    async () => {
      const started = Date.now();
      const result = await run(['start', '--detach', '-s', 'web'], { FAIL_AFTER_READY: '1' }).done;
      try {
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          `api failed: afterReady failed: no DATABASE_URL. ${ADVICE}`,
        );
        expect(Date.now() - started).toBeLessThan(30_000);
      } finally {
        await run(['stop']).done;
      }
    },
  );

  test(
    'service start of a service waiting for one whose afterReady failed fails at once, naming both',
    { timeout: 60_000 },
    async () => {
      await sessionOfApi({ FAIL_AFTER_READY: '1' });
      const result = await run(['service', 'start', '-s', 'web']).done;
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`web is waiting for api, which failed: afterReady failed: no DATABASE_URL. ${ADVICE}`); // oxfmt-ignore
      const status = await run(['status']).done;
      expect(status.stdout).toContain('failed, not ready: afterReady failed: no DATABASE_URL');
    },
  );

  test(
    'a service start already waiting when the service it waits for fails gives up then, with the reason',
    { timeout: 60_000 },
    async () => {
      // `api`'s afterReady is held, then throws once the test lets it go.
      await sessionOfApi({ HOLD_AFTER_READY: '1', FAIL_AFTER_READY: '1' });
      const status = (await run(['status']).done).stdout;
      expect(status).toMatch(/api +running, not ready: its afterReady is still running/);
      const starting = run(['service', 'start', '-s', 'web']);
      const said = printed(starting, 'stderr');
      await vi.waitFor(() => expect(said()).toContain('waiting for web to be healthy'), { timeout: 20_000, interval: 50 }); // oxfmt-ignore
      const released = Date.now();
      fs.writeFileSync(path.join(lws, 'release-ready'), '');
      const result = await starting.done;
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`web is waiting for api, which failed: afterReady failed: no DATABASE_URL. ${ADVICE}`); // oxfmt-ignore
      // At once: its own timeout is 300 s.
      expect(Date.now() - released).toBeLessThan(15_000);
    },
  );

  test(
    'a session killed outright takes the command its hook runs with it, and what that command started',
    { timeout: 60_000 },
    async () => {
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const pidsFile = path.join(lws, 'hook.pids');
      const session = await sessionOfApi({ LONG_AFTER_READY: '1' });
      // The hook's command, a shell, and the process that shell started: both pids, once written.
      const pids = () => (fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').trim().split(' ').map(Number) : []); // oxfmt-ignore
      await vi.waitFor(() => expect(pids()).toHaveLength(2), { timeout: 20_000, interval: 50 });
      const [shell, child] = pids() as [number, number];
      const owned = [await own(shell), await own(child)];
      // Its service's process is no longer the session's to end once it is killed: the test's.
      const record = JSON.parse(fs.readFileSync(path.join(lws, 'node_modules/.stackctl/profiles/development/running.json'), 'utf8')) as { children?: { pid: number }[] }; // oxfmt-ignore
      const devs = await Promise.all((record.children ?? []).map((c) => own(c.pid)));
      try {
        expect([alive(shell), alive(child)]).toEqual([true, true]);
        // No code of the session runs after this.
        session.kill('SIGKILL');
        await session.done;
        await vi.waitFor(() => expect([alive(shell), alive(child)]).toEqual([false, false]), { timeout: 10_000, interval: 50 }); // oxfmt-ignore
      } finally {
        for (const one of [...owned, ...devs]) {
          if (one) {
            await killOwned(one);
          }
        }
      }
    },
  );
});
