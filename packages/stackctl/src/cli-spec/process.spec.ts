import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import {
  packageDir,
  buildDir,
  cli,
  start,
  ws,
  app,
  traced,
  tracedPlainSession,
  script,
  stackctl,
  lastLine,
  setUpCliWorkspace,
} from './harness.js';

/** What a command loads, the stackctl process itself, and `deps` as a callback. See `harness.ts`. */
setUpCliWorkspace('process');

describe('what a command loads', () => {
  const HEAVY = ['valibot', '@dotenvx/primitives', 'pino', '@clack/prompts', 'typescript'];
  // colord paints only the TUI; a config's `import 'stackctl'` doesn't load it.
  const SESSION_ONLY = [
    'pino',
    '@clack/prompts',
    'jsonc-parser',
    'typescript',
    'ink',
    'react',
    'colord',
  ];

  const expectNotLoaded = (packages: Set<string>, names: string[]) => {
    expect(names.filter((name) => packages.has(name))).toEqual([]);
  };

  test('--help prints the usage without loading the config or anything a command needs', async () => {
    const { result, packages, evaluatedConfig } = await traced(['--help']);
    expect(result.stdout).toContain('Usage: stackctl');
    expect(result.exitCode).toBe(0);
    expect(evaluatedConfig).toBe(false);
    expectNotLoaded(packages, HEAVY);
  });

  /** A session that has ended, its log saying `text`: the latest, with no session running. */
  const endedSession = (text: string) => {
    const folder = path.join(ws, 'node_modules', '.stackctl', 'profiles', 'development', 'sessions', String(Date.now() + 60_000)); // oxfmt-ignore
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'logs.txt'), `${text}\n`);
  };

  test("logs --path finds the latest session's log without loading the config", async () => {
    endedSession('ended');
    await stackctl(['exec', 'app', '--', 'true']);
    const { result, packages, evaluatedConfig } = await traced(['logs', '--path'], { cwd: app });
    expect(result.stdout).toMatch(
      /node_modules\/\.stackctl\/profiles\/development\/sessions\/\d+\/logs\.txt$/,
    );
    expect(result.exitCode).toBe(0);
    expect(evaluatedConfig).toBe(false);
    expectNotLoaded(packages, HEAVY);
  });

  test("logs prints that log, not a one-off command's", async () => {
    endedSession('in-the-log');
    await stackctl(['exec', 'app', '--', 'echo', 'from-a-one-off']);
    const result = await stackctl(['logs']);
    expect(result.stdout).toContain('in-the-log');
    expect(result.stdout).not.toContain('from-a-one-off');
    expect(result.exitCode).toBe(0);
  });

  test("reset removes the profile's state without evaluating the config", async () => {
    await stackctl(['exec', 'app', '--', 'true']);
    const { result, packages, evaluatedConfig } = await traced([
      '--profile',
      'development',
      'reset',
    ]);
    expect(result.stdout).toBe(
      'No development stackctl session is running.\nRemoved node_modules/.stackctl/profiles/development/; its event log starts again with this reset.',
    );
    expect(result.exitCode).toBe(0);
    // Nothing of the profile's state is left but the event log the reset opened with its own line.
    const sessions = path.join(
      ws,
      'node_modules',
      '.stackctl',
      'profiles',
      'development',
      'sessions',
    );
    expect(fs.readdirSync(path.dirname(sessions))).toEqual(['sessions']);
    const [folder] = fs.readdirSync(sessions);
    expect(fs.readdirSync(path.join(sessions, folder!))).toEqual(['events.jsonl']);
    expect(evaluatedConfig).toBe(false);
    expectNotLoaded(packages, HEAVY);
  });

  test('exec loads nothing a session needs', async () => {
    const { result, packages } = await traced(['exec', 'app', '--', 'echo', 'ran']);
    expect(result.stdout).toBe('ran');
    expectNotLoaded(packages, [...SESSION_ONLY, 'string-width', 'wrap-ansi']);
  });

  test('run loads nothing a session needs', async () => {
    const { result, packages } = await traced(['run', 'app', 'cwd']);
    expect(lastLine(result.stdout)).toBe(app);
    expectNotLoaded(packages, [...SESSION_ONLY, 'string-width', 'wrap-ansi']);
  });

  test('show-config prints the resolved config, loading nothing that runs a command', async () => {
    const { result, packages } = await traced(['show-config']);
    const config = JSON.parse(result.stdout) as { services: Record<string, { name: string }> };
    expect(config.services.app?.name).toBe('app');
    expectNotLoaded(packages, SESSION_ONLY);
    // The validator is what reading the config loads, so the trace can tell `HEAVY` stays out.
    expect(packages.has('valibot')).toBe(true);
  });

  test('a --headless session loads no TUI, no prompt library and no TypeScript', async () => {
    const { output, packages } = await tracedPlainSession(['app']);
    expect(output).toMatch(/\[app {5}\] started/);
    expectNotLoaded(packages, ['ink', 'react', '@clack/prompts', 'typescript']);
  }, 30_000);

  test('a --headless session still wraps a long line to the terminal width, gutter on every row', async () => {
    const { output, packages } = await tracedPlainSession(['wide'], 'done');
    const rows = output.split('\n').filter((line) => /\[wide {4}\] x+$/.test(line));
    // Piped, the terminal is taken as 120 columns: a 20-column timestamp, `[wide    ] ` (padded
    // to `stackctl`), the text.
    expect(rows.map((row) => row.length)).toEqual([120, 92]);
    expect(rows.map((row) => /x+$/.exec(row)![0].length)).toEqual([89, 61]);
    expect(output).toMatch(/\[wide {4}\] glyphs \u2713 \u4e2d\u6587 done/);
    expect(packages.has('string-width')).toBe(true);
  }, 30_000);

  test("no command loads the env parser's CLI tooling", async () => {
    const { packages } = await traced(['exec', 'app', '--', 'true']);
    expectNotLoaded(packages, ['@dotenvx/dotenvx', '@dotenvx/tooling']);
  });
});

describe('the stackctl process', () => {
  let hookRuns = 0;

  /**
   * Each program a CLI run loaded, in order — one, or two once it starts over: the pid, the
   * directory it started in and the Node.js flags it ran with, recorded by a preload as it starts.
   */
  async function programsOf(args: string[]) {
    const out = path.join(ws, `process-${String(hookRuns++)}.jsonl`);
    const hook = path.join(ws, 'process-hook.mjs');
    fs.writeFileSync(
      hook,
      "import fs from 'node:fs';\nfs.appendFileSync(process.env.PROCESS_OUT, JSON.stringify({ pid: process.pid, cwd: process.cwd(), execArgv: process.execArgv }) + '\\n');\n",
    );
    const child = start('node', ['--import', hook, cli, ...args], {
      cwd: app,
      env: { PROCESS_OUT: out },
    });
    const result = await child.done;
    const programs = fs
      .readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { pid: number; cwd: string; execArgv: string[] });
    return { result, hook, pid: child.pid, programs };
  }

  test('a session starts over with a small young generation, as it was started', async () => {
    // A service that doesn't exist: the session gets as far as checking it, then exits.
    const { result, hook, pid, programs } = await programsOf(['-s', 'nope']);
    expect(result.stderr).toContain('Unknown service: nope');
    expect(programs).toEqual([
      { pid, cwd: app, execArgv: ['--import', hook] },
      { pid, cwd: app, execArgv: ['--max-semi-space-size=2', '--import', hook] },
    ]);
  });

  test('a one-off command runs as it was started', async () => {
    const { result, hook, pid, programs } = await programsOf(['exec', 'app', '--', 'true']);
    expect(result.exitCode).toBe(0);
    expect(programs).toEqual([{ pid, cwd: app, execArgv: ['--import', hook] }]);
  });
});

describe('deps as a callback', () => {
  /**
   * A workspace whose `api` runs `codegen` outside the `test` profile, and `gateway` in every
   * profile.
   */
  let dws: string;
  const marker = (name: string) => path.join(dws, 'packages', name, 'started');

  beforeAll(() => {
    dws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-cli-deps-')));
    fs.writeFileSync(path.join(dws, 'package.json'), JSON.stringify({ name: 'depsroot', type: 'module' })); // oxfmt-ignore
    fs.writeFileSync(path.join(dws, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    fs.writeFileSync(
      path.join(dws, 'stackctl.config.ts'),
      [
        "import { defineConfig } from 'stackctl';",
        'export default defineConfig({',
        "  serviceRootDir: 'packages',",
        '  services: {',
        "    api: { deps: ({ profile }) => (profile === 'test' ? ['gateway'] : ['codegen', 'gateway']) },",
        '    codegen: {},',
        '    gateway: {},',
        '  },',
        '});',
        '',
      ].join('\n'),
    );
    const standIn = path.join(dws, 'node_modules', 'stackctl');
    fs.mkdirSync(standIn, { recursive: true });
    fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
    fs.symlinkSync(buildDir, path.join(standIn, 'dist'));
    for (const name of ['api', 'codegen', 'gateway']) {
      const dir = path.join(dws, 'packages', name);
      fs.mkdirSync(dir, { recursive: true });
      // Marks that it started, then stays up until the session stops it.
      const dev = script("import fs from 'node:fs'; fs.writeFileSync('started', ''); setInterval(() => {}, 1e9)"); // oxfmt-ignore
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, scripts: { dev } }));
    }
  });

  afterAll(() => {
    fs.rmSync(dws, { recursive: true, force: true });
  });

  const depsIn = async (profile: string) => {
    const result = await stackctl(['show-config', '--profile', profile], { cwd: dws });
    expect(result.exitCode).toBe(0);
    return (JSON.parse(result.stdout) as { services: Record<string, { deps?: unknown }> }).services
      .api?.deps;
  };

  test('show-config prints the deps each profile resolves', async () => {
    expect(await depsIn('development')).toEqual([
      { service: 'codegen', wait: false },
      { service: 'gateway', wait: false },
    ]);
    expect(await depsIn('test')).toEqual([{ service: 'gateway', wait: false }]);
  });

  test('a test session does not start a dep only the development deps name', async () => {
    const session = start('node', [cli, '--headless', '--profile', 'test', '-s', 'api'], {
      cwd: dws,
    });
    try {
      const deadline = Date.now() + 20_000;
      while (!(fs.existsSync(marker('api')) && fs.existsSync(marker('gateway')))) {
        expect(Date.now(), 'api and gateway never started').toBeLessThan(deadline);
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      session.kill('SIGTERM');
      const exited = session.done.then(() => true);
      const timedOut = new Promise<false>((r) => setTimeout(() => r(false), 15_000));
      if (!(await Promise.race([exited, timedOut]))) {
        session.kill('SIGKILL');
      }
    }
    // The session has ended: every service it started logged a line when it did.
    const { stdout } = await session.done;
    expect(stdout).toContain('gateway: runtime dep of api');
    expect(stdout).toMatch(/\[api *\] started/);
    expect(stdout).not.toContain('codegen');
    expect(fs.existsSync(marker('codegen'))).toBe(false);
  });
});
