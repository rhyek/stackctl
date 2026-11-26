import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

/** The session's `lifecycle` hooks, from the command line. See `harness.ts`. */
setUpCliWorkspace('session-lifecycle');

describe("the session's hooks", () => {
  let lws: string;
  const hookLog = () => path.join(lws, 'hook.log');
  /** One `done` per run of the session's `afterReady` that finished. */
  const readyLog = () => path.join(lws, 'ready.log');
  /** The modes the hook ran in, one per run; `[]` when it never ran. */
  const runs = () =>
    fs.existsSync(hookLog()) ? fs.readFileSync(hookLog(), 'utf8').trim().split('\n') : [];
  /** The session's stop hooks that ran, in order. */
  const stops = () =>
    fs.existsSync(path.join(lws, 'stop.log'))
      ? fs.readFileSync(path.join(lws, 'stop.log'), 'utf8').trim().split('\n')
      : [];
  /**
   * Runs the CLI in the workspace as a person would, whatever runs the suite: an agent must name
   * the profile on every command, and is refused `start --detach` outside CI.
   */
  const run = (args: string[], env: Record<string, string> = {}) =>
    start('node', [cli, ...args], { cwd: lws, env });

  beforeAll(() => {
    lws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-cli-lifecycle-')));
    fs.writeFileSync(path.join(lws, 'package.json'), JSON.stringify({ name: 'lifecycleroot', type: 'module' })); // oxfmt-ignore
    fs.writeFileSync(path.join(lws, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    fs.writeFileSync(
      path.join(lws, 'stackctl.config.ts'),
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "import { defineConfig } from 'stackctl';",
        'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
        'export default defineConfig({',
        "  serviceRootDir: 'packages',",
        '  services: { web: {} },',
        '  session: {',
        '    lifecycle: {',
        '      beforeStart: ({ mode, log, workspaceDir }) => {',
        "        fs.appendFileSync(path.join(workspaceDir, 'hook.log'), `${mode}\\n`);",
        "        log('tidying the checkout');",
        '        if (process.env.FAIL_HOOK) {',
        "          throw new Error('apps/legacy is not empty');",
        '        }',
        '      },',
        '      afterStart: ({ log }) => {',
        "        log('services launched');",
        '        if (process.env.FAIL_AFTER_START) {',
        "          throw new Error('no seed data');",
        '        }',
        '      },',
        '      afterReady: async ({ log, workspaceDir }) => {',
        // Held, for a test that asks: says it has begun, then goes on once the test lets it.
        '        if (process.env.HOLD_READY) {',
        "          fs.writeFileSync(path.join(workspaceDir, 'ready-started'), '');",
        "          while (!fs.existsSync(path.join(workspaceDir, 'release-ready'))) { await sleep(20); }",
        '        }',
        '        if (process.env.FAIL_AFTER_READY) {',
        "          throw new Error('smoke test failed');",
        '        }',
        "        fs.appendFileSync(path.join(workspaceDir, 'ready.log'), 'done\\n');",
        "        log('smoke test passed');",
        '      },',
        '      beforeStop: ({ log, workspaceDir }) => {',
        "        fs.appendFileSync(path.join(workspaceDir, 'stop.log'), 'beforeStop\\n');",
        "        log('pausing the jobs');",
        '      },',
        // Written late: a quit that didn't wait for it would be seen to have returned early.
        '      afterStop: async ({ workspaceDir }) => {',
        '        await sleep(300);',
        "        fs.appendFileSync(path.join(workspaceDir, 'stop.log'), 'afterStop\\n');",
        '      },',
        '    },',
        '  },',
        '});',
        '',
      ].join('\n'),
    );
    const standIn = path.join(lws, 'node_modules', 'stackctl');
    fs.mkdirSync(standIn, { recursive: true });
    fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
    fs.symlinkSync(buildDir, path.join(standIn, 'dist'));
    const web = path.join(lws, 'packages', 'web');
    fs.mkdirSync(web, { recursive: true });
    fs.writeFileSync(
      path.join(web, 'package.json'),
      JSON.stringify({
        name: 'web',
        scripts: {
          dev: script("console.log('web-up'); setInterval(()=>{},1e9)"),
          once: 'echo once',
        },
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
    for (const file of ['hook.log', 'ready.log', 'stop.log', 'ready-started', 'release-ready']) {
      fs.rmSync(path.join(lws, file), { force: true });
    }
  });

  /** What `child` has printed so far, on `stream`. */
  function printed(child: Running, stream: 'stdout' | 'stderr'): () => string {
    let text = '';
    child[stream].on('data', (chunk: Buffer) => (text += chunk.toString()));
    return () => text;
  }
  /** Resolves once the test's file `name` exists in the workspace. */
  const appears = (name: string) =>
    vi.waitFor(() => expect(fs.existsSync(path.join(lws, name))).toBe(true), { timeout: 20_000, interval: 20 }); // oxfmt-ignore

  /** Starts a `--headless` session and resolves with its output once `until` is printed. */
  async function headlessUntil(until: string): Promise<string> {
    const child = run(['--headless', '-s', 'web']);
    started.push(child);
    let output = '';
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
    });
    return output;
  }

  test(
    'runs once as a --headless session starts, before its services, its output first',
    { timeout: 30_000 },
    async () => {
      const output = await headlessUntil('web-up');
      expect(runs()).toEqual(['headless']);
      expect(output.indexOf('tidying the checkout')).toBeGreaterThan(-1);
      expect(output.indexOf('tidying the checkout')).toBeLessThan(output.indexOf('web-up'));
    },
  );

  test(
    "Ctrl+C runs the session's beforeStop, then its afterStop once its services have stopped, and the session exits 0",
    { timeout: 30_000 },
    async () => {
      await headlessUntil('smoke test passed');
      const session = started[0]!;
      const out = printed(session, 'stdout');
      session.kill('SIGINT');
      expect((await session.done).exitCode).toBe(0);
      expect(stops()).toEqual(['beforeStop', 'afterStop']);
      expect(out()).toContain('pausing the jobs');
    },
  );

  test(
    'stackctl stop returns once the stop hooks of the session it stopped have run',
    { timeout: 30_000 },
    async () => {
      const detached = await run(['start', '--detach', '-s', 'web']).done;
      try {
        expect(detached.exitCode, detached.stderr).toBe(0);
      } finally {
        const stop = await run(['stop']).done;
        expect(stop.exitCode, stop.stderr).toBe(0);
      }
      // Read as `stop` returned: the afterStop, which takes a moment, was waited for.
      expect(stops()).toEqual(['beforeStop', 'afterStop']);
    },
  );

  test(
    'a beforeStart that throws ends the session before its services start, with code 1, and status still says why once it is gone',
    { timeout: 30_000 },
    async () => {
      const child = run(['--headless', '-s', 'web'], { FAIL_HOOK: '1' });
      started.push(child);
      const result = await child.done;
      expect(result.exitCode).toBe(1);
      // Under the session's label, as its other hooks' lines are, and as the start's error.
      expect(result.stderr).toMatch(/\[session \] .*beforeStart failed: apps\/legacy is not empty/);
      expect(result.stderr).toContain('[stackctl] [ERROR] session beforeStart failed: apps/legacy is not empty'); // oxfmt-ignore
      expect(result.stdout).toContain('tidying the checkout');
      expect(result.stdout).not.toContain('web-up');
      expect(fs.existsSync(path.join(lws, 'node_modules', '.stackctl', 'profiles', 'development', 'running.json'))).toBe(false); // oxfmt-ignore
      // Its stop hooks stay out: its start never got past its beforeStart.
      expect(stops()).toEqual([]);

      const status = (await run(['status']).done).stdout.split('\n');
      expect(status[0]).toBe('No development session is running.');
      expect(status[1]).toMatch(/^The last one failed to start \(today \d\d:\d\d:\d\d\): session beforeStart failed: apps\/legacy is not empty$/); // oxfmt-ignore
      // A wait begun after it failed can't tell it from an older session: it waits, then names it.
      const late = await run(['wait', '--timeout', '1']).done;
      expect(late.exitCode).toBe(1);
      expect(late.stderr).toMatch(/^stackctl: no development session started within 1s; the last one failed to start \(today \d\d:\d\d:\d\d\): session beforeStart failed: apps\/legacy is not empty\. See .*logs\.txt$/); // oxfmt-ignore
    },
  );

  test(
    'stackctl wait, begun before a session whose beforeStart throws, fails as soon as it has, with its reason',
    { timeout: 30_000 },
    async () => {
      const waiting = run(['wait', '--timeout', '25']);
      // Its config loaded, it is looking for the session.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const began = Date.now();
      const child = run(['--headless', '-s', 'web'], { FAIL_HOOK: '1' });
      started.push(child);
      const result = await waiting.done;
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/^stackctl: the development session failed to start: session beforeStart failed: apps\/legacy is not empty\. See .*logs\.txt$/); // oxfmt-ignore
      expect(Date.now() - began).toBeLessThan(15_000);
    },
  );

  test('runs in the session start --detach starts, as detached', { timeout: 30_000 }, async () => {
    const result = await run(['start', '--detach', '-s', 'web']).done;
    try {
      expect(result.exitCode, result.stderr).toBe(0);
      expect(runs()).toEqual(['detached']);
    } finally {
      await run(['stop']).done;
    }
  });

  test('a detached session whose hook throws fails the start, saying why', async () => {
    const result = await run(['start', '--detach', '-s', 'web'], { FAIL_HOOK: '1' }).done;
    try {
      expect(result.exitCode).toBe(1);
      // The hook's error is the reason given, not only a line of the log's tail under it.
      expect(result.stderr).toContain('stackctl: start --detach failed: session beforeStart failed: apps/legacy is not empty. See'); // oxfmt-ignore
      expect(result.stderr).not.toContain('while starting');
    } finally {
      await run(['stop']).done;
    }
  });

  test(
    "start --detach returns only once the session's afterReady has finished",
    { timeout: 30_000 },
    async () => {
      const detaching = run(['start', '--detach', '-s', 'web'], { HOLD_READY: '1' });
      let exited = false;
      void detaching.done.then(() => (exited = true));
      try {
        await appears('ready-started');
        // Its service is ready, and has been for longer than a wait on the services alone takes
        // to settle: the session is not, and says which hook it still runs.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(exited).toBe(false);
        const status = JSON.parse((await run(['status', '--json']).done).stdout) as { status: { sessionReady: boolean; sessionStartHooks: string; ready: Record<string, boolean> } }; // oxfmt-ignore
        expect(status.status).toMatchObject({ sessionReady: false, sessionStartHooks: 'afterReady', ready: { web: true } }); // oxfmt-ignore
        expect((await run(['status']).done).stdout).toMatch(/^development session: running( since today [\d:]+)?, its afterReady still to finish/); // oxfmt-ignore
        fs.writeFileSync(path.join(lws, 'release-ready'), '');
        const result = await detaching.done;
        expect(result.exitCode, result.stderr).toBe(0);
        expect(fs.readFileSync(readyLog(), 'utf8')).toBe('done\n');
      } finally {
        fs.writeFileSync(path.join(lws, 'release-ready'), '');
        await detaching.done;
        await run(['stop']).done;
      }
    },
  );

  test.each([
    ['FAIL_AFTER_START', 'session afterStart failed: no seed data'],
    ['FAIL_AFTER_READY', 'session afterReady failed: smoke test failed'],
  ])(
    'a --headless session whose hook throws (%s) stops its services and exits 1, saying why',
    { timeout: 30_000 },
    async (env, message) => {
      const child = run(['--headless', '-s', 'web'], { [env]: '1' });
      started.push(child);
      const result = await child.done;
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`[stackctl] [ERROR] ${message}`);
      expect(result.stdout).toContain('services launched');
      expect(fs.existsSync(path.join(lws, 'node_modules', '.stackctl', 'profiles', 'development', 'running.json'))).toBe(false); // oxfmt-ignore
    },
  );

  test(
    "stackctl wait on a --headless session fails with its afterReady's error, not its services' stop",
    { timeout: 30_000 },
    async () => {
      // The hook is held until the wait follows the session, then throws.
      const child = run(['--headless', '-s', 'web'], { FAIL_AFTER_READY: '1', HOLD_READY: '1' });
      started.push(child);
      await appears('ready-started');
      const waiting = run(['wait', '--timeout', '20']);
      const said = printed(waiting, 'stderr');
      await vi.waitFor(() => expect(said()).toContain('waiting for web to be healthy'), { timeout: 20_000, interval: 20 }); // oxfmt-ignore
      fs.writeFileSync(path.join(lws, 'release-ready'), '');
      const result = await waiting.done;
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'stackctl: session afterReady failed: smoke test failed. See',
      );
      expect((await child.done).exitCode).toBe(1);
    },
  );

  test(
    'a detached session whose afterReady throws fails the start, saying why',
    { timeout: 30_000 },
    async () => {
      const result = await run(['start', '--detach', '-s', 'web'], { FAIL_AFTER_READY: '1' }).done;
      try {
        expect(result.exitCode).toBe(1);
        // The hook's error is the reason, not the session's exit that followed it.
        expect(result.stderr).toContain('start --detach failed: session afterReady failed: smoke test failed. See'); // oxfmt-ignore
        expect(result.stderr).not.toContain('while starting');
      } finally {
        await run(['stop']).done;
      }
    },
  );

  test(
    "startStack() throws the session's afterReady error, not the exit that followed it",
    { timeout: 30_000 },
    async () => {
      type StackModule = typeof import('../stack');
      const { startStack, stackEnvironment } = (await import(pathToFileURL(path.join(buildDir, 'stack.js')).href)) as StackModule; // oxfmt-ignore
      const env = { ...stackEnvironment(), STACKCTL_STARTED_BY_AGENT: '0', FAIL_AFTER_READY: '1' };
      const error = await startStack({ services: ['web'], workspaceDir: lws, env }).then(
        // Not expected: the stack it started must not outlive the test.
        async (stack) => (await stack.stop(), null),
        (err: unknown) => err as Error,
      );
      expect(error?.message).toMatch(/^stackctl: session afterReady failed: smoke test failed\. See /); // oxfmt-ignore
      expect(error?.message).not.toContain('while starting');
    },
  );

  test('does not run for exec, run or show-config', async () => {
    expect((await run(['exec', '-s', 'web', '--', 'node', '-e', '0']).done).exitCode).toBe(0);
    expect((await run(['run', '-s', 'web', 'once']).done).exitCode).toBe(0);
    expect((await run(['show-config']).done).exitCode).toBe(0);
    expect(runs()).toEqual([]);
    expect(stops()).toEqual([]);
  });
});
