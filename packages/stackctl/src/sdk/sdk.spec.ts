import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { buildForTests } from '../cli-spec/build';
import { withCliEnv } from '../cli-spec/env';

/**
 * The SDK functions that run a CLI command in a child, against a workspace on disk. They run the
 * CLI compiled beside them, so the package is built from the current source in `beforeAll`, into
 * a directory of this spec's own, and imported from there.
 */
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Laid out as the published package is, `dist/` beside `assets/` and `skills/`, which `init`
// reads from the compiled code's parent directory.
const copyDir = path.join(packageDir, 'node_modules', '.cache', 'sdk-parity-spec');
const buildDir = path.join(copyDir, 'dist');

type IndexModule = typeof import('../index');
let sdk: IndexModule;
let ws: string;
let empty: string;
/** A workspace with infra, whose `docker` is a stub on the PATH that records its calls. */
let infraWs: string;
let dockerCalls: string;
let dockerPath: string;

async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
}

// The SDK's functions start the CLI with this process's environment.
withCliEnv();

beforeAll(async () => {
  fs.rmSync(copyDir, { recursive: true, force: true });
  for (const dir of ['assets', 'skills']) {
    fs.cpSync(path.join(packageDir, dir), path.join(copyDir, dir), { recursive: true });
  }
  await buildForTests(buildDir);
  sdk = (await import(pathToFileURL(path.join(buildDir, 'index.js')).href)) as IndexModule;
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-sdk-parity-')));
  empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-sdk-parity-none-')));
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'root', type: 'module' }));
  fs.writeFileSync(
    path.join(ws, 'stackctl.config.ts'),
    [
      "import { defineConfig } from 'stackctl';",
      'export default defineConfig({',
      "  serviceRootDir: 'apps',",
      '  services: {',
      "    api: { port: 21096, tags: ['backend'] },",
      "    web: { tags: ['browser'] },",
      // Never ready: its healthcheck asks a port nothing listens on.
      "    stuck: { port: 21097, healthcheck: '/health' },",
      '  },',
      '});',
      '',
    ].join('\n'),
  );
  const standIn = path.join(ws, 'node_modules', 'stackctl');
  fs.mkdirSync(standIn, { recursive: true });
  fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
  fs.symlinkSync(buildDir, path.join(standIn, 'dist'));
  // Dev processes that stay up and print a line, with no port to hold.
  const dev = 'node -e "console.log(\\"up\\"); setInterval(() => {}, 1000)"';
  for (const name of ['api', 'web', 'stuck']) {
    fs.mkdirSync(path.join(ws, 'apps', name), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'apps', name, 'package.json'),
      JSON.stringify({ name, scripts: { dev } }),
    );
  }

  infraWs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-sdk-parity-infra-')));
  fs.writeFileSync(path.join(infraWs, 'package.json'), JSON.stringify({ name: 'inf', type: 'module' })); // oxfmt-ignore
  fs.writeFileSync(
    path.join(infraWs, 'stackctl.config.ts'),
    "import { defineConfig } from 'stackctl';\nexport default defineConfig({ infra: { 'docker-compose': { lifecycle: { beforeStart: async ({ exec, workspaceDir }) => { if (process.env.LONG_HOOK) { await exec('sh', ['-c', 'sleep 300 & echo \"$$ $!\" > \"$PIDS\"; wait'], { env: { PIDS: workspaceDir + '/hook.pids' } }); } } }, services: { db: { tags: ['data'], lifecycle: { beforeStop: () => { if (process.env.FAIL_STOP_HOOK) { throw new Error('webhook not removed'); } } } }, cache: { enabled: false } } } }, services: {} });\n", // oxfmt-ignore
  );
  fs.writeFileSync(path.join(infraWs, 'docker-compose.yaml'), 'services:\n  db:\n    image: postgres\n  cache:\n    image: redis\n'); // oxfmt-ignore
  const infraStandIn = path.join(infraWs, 'node_modules', 'stackctl');
  fs.mkdirSync(infraStandIn, { recursive: true });
  fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(infraStandIn, 'package.json'));
  fs.symlinkSync(buildDir, path.join(infraStandIn, 'dist'));
  const bin = path.join(infraWs, 'bin');
  dockerCalls = path.join(infraWs, 'docker-calls');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'docker'),
    [
      '#!/bin/sh',
      `echo "$@" >> '${dockerCalls}'`,
      'case "$*" in',
      '  *"config --services"*) printf "cache\\ndb\\n" ;;',
      '  *"config --format json"*) echo \'{}\' ;;',
      '  *" ps --all --format json"*) echo \'{"ID":"id-db","Service":"db","State":"running","Health":"healthy"}\' ;;',
      '  *" ps") echo "NAME db" ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  dockerPath = `${bin}${path.delimiter}${String(process.env.PATH)}`;
}, 120_000);

/** Runs `fn` in the infra workspace with the stub `docker` first on the PATH. */
async function withDocker<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env.PATH;
  process.env.PATH = dockerPath;
  try {
    return await inDir(infraWs, fn);
  } finally {
    process.env.PATH = before;
  }
}

const dockerCallLines = () =>
  fs.existsSync(dockerCalls) ? fs.readFileSync(dockerCalls, 'utf8').trim().split('\n') : [];

afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
  fs.rmSync(infraWs, { recursive: true, force: true });
  fs.rmSync(copyDir, { recursive: true, force: true });
});

describe('the child CLI', () => {
  test("a child's output goes to the caller's stderr, never its stdout", () => {
    const stub = path.join(empty, 'stub.mjs');
    fs.writeFileSync(
      stub,
      "import fs from 'node:fs';\nconsole.log('progress line');\nfs.writeSync(3, '1');\n",
    );
    const caller = path.join(empty, 'caller.mjs');
    const helper = pathToFileURL(path.join(buildDir, 'sdk', 'cli-child.js')).href;
    fs.writeFileSync(
      caller,
      `import { runCli } from '${helper}';\nconst r = await runCli([${JSON.stringify(stub)}]);\nprocess.stdout.write('result ' + r);\n`,
    );
    const run = spawnSync(process.execPath, [caller], { encoding: 'utf8' });
    expect(run.stdout).toBe('result 1');
    expect(run.stderr).toContain('progress line');
  });
});

/**
 * Runs the built CLI with `args` as an SDK function does, descriptor 3 open for the result, or
 * as a terminal does, with only stdin, stdout and stderr (`channel: false`).
 */
function cliRun(args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; channel?: boolean }) {
  const run = spawnSync(process.execPath, [path.join(buildDir, 'cli.js'), ...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe', ...(opts.channel === false ? [] : ['pipe' as const])],
  });
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    result: (run.output[3] as string | null | undefined) ?? '',
  };
}

describe('the --sdk-result flag', () => {
  test('is the result channel as the last argument', () => {
    const run = cliRun(['show-config', '--sdk-result'], { cwd: ws });
    expect(run.stdout).toBe('');
    expect(Object.keys((JSON.parse(run.result) as { services: object }).services)).toEqual([
      'api',
      'web',
      'stuck',
    ]);
  });

  test("after `--` it is the command's own argument", () => {
    const run = cliRun(['exec', 'api', '--', 'sh', '-c', 'echo "$1"', '_', '--sdk-result'], {
      cwd: ws,
    });
    expect(run.stdout).toBe('--sdk-result\n');
    expect(run.result).toBe('');
  });

  test("after infra docker-compose it is docker compose's own argument", () => {
    fs.rmSync(dockerCalls, { force: true });
    const run = cliRun(['infra', 'docker-compose', 'ps', '--sdk-result'], {
      cwd: infraWs,
      env: { ...process.env, PATH: dockerPath },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(dockerCallLines().at(-1)).toMatch(/ ps --sdk-result$/);
  });

  test('anywhere but last it is an unknown option', () => {
    const run = cliRun(['status', '--sdk-result', '--json'], { cwd: ws });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("unknown option '--sdk-result'");
  });

  test('typed at a terminal, with no result channel, it is an unknown option', () => {
    const run = cliRun(['show-config', '--sdk-result'], { cwd: ws, channel: false });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("unknown option '--sdk-result'");
  });
});

describe('showConfig()', () => {
  test('resolves with the config show-config prints', async () => {
    const config = await inDir(ws, () => sdk.showConfig());
    const printed = spawnSync(process.execPath, [path.join(buildDir, 'cli.js'), 'show-config'], {
      cwd: ws,
      encoding: 'utf8',
    });
    expect(config).toEqual(JSON.parse(printed.stdout));
    expect(Object.keys(config.services)).toEqual(['api', 'web', 'stuck']);
  });

  test('takes a workspaceDir and a profile', async () => {
    const config = await sdk.showConfig({ workspaceDir: ws, profile: 'test' });
    expect(config.profile).toBe('test');
  });

  test("rejects outside a workspace with the CLI's message", async () => {
    await expect(inDir(empty, () => sdk.showConfig())).rejects.toThrow(/No stackctl\.config\.ts/);
  });

  test('rejects an unknown option', async () => {
    await expect(sdk.showConfig({ nope: 1 } as never)).rejects.toThrow(
      'showConfig: unknown option "nope"',
    );
  });
});

describe('infra', () => {
  test("a tag nothing has rejects with the CLI's message, and runs nothing", async () => {
    fs.rmSync(dockerCalls, { force: true });
    await expect(withDocker(() => sdk.infra.reset({ tags: ['nope'] }))).rejects.toThrow(
      'No infra service has the tag: nope',
    );
    expect(dockerCallLines()).toEqual([]);
  });

  test('a disabled service named is refused, and nothing stops', async () => {
    fs.rmSync(dockerCalls, { force: true });
    await expect(withDocker(() => sdk.infra.stop({ services: ['cache'] }))).rejects.toThrow(
      /"cache"[\s\S]*disabled/,
    );
    expect(dockerCallLines().some((line) => line.includes(' down'))).toBe(false);
  });

  test('an empty services or tags array is refused, not read as every service', async () => {
    fs.rmSync(dockerCalls, { force: true });
    await expect(withDocker(() => sdk.infra.destroy({ services: [] }))).rejects.toThrow(
      'infra.destroy: `services` is empty; leave it out to act on every enabled service',
    );
    await expect(withDocker(() => sdk.infra.reset({ tags: [] }))).rejects.toThrow(
      'infra.reset: `tags` is empty; leave it out to act on every enabled service',
    );
    expect(dockerCallLines()).toEqual([]);
  });

  test('start resolves with a result per service', async () => {
    const result = await withDocker(() => sdk.infra.start({ services: ['db'] }));
    expect(result).toEqual({ ok: true, results: [{ service: 'db', status: 'ready' }] });
  });

  test('stop resolves with each enabled service stopped', async () => {
    const result = await withDocker(() => sdk.infra.stop());
    expect(result).toEqual({ ok: true, results: [{ service: 'db', status: 'stopped' }] });
  });

  test("compose with stdio pipe collects the command's output", async () => {
    const result = await withDocker(() => sdk.infra.compose(['ps'], { stdio: 'pipe' }));
    expect(result).toEqual({ exitCode: 0, stdout: 'NAME db\n', stderr: '' });
  });

  /** The infra workspace's event-log lines of `type`, oldest first. */
  const infraEvents = (type: string) => {
    const sessions = path.join(infraWs, 'node_modules', '.stackctl', 'profiles', 'development', 'sessions'); // oxfmt-ignore
    return fs
      .readdirSync(sessions)
      .map((id) => path.join(sessions, id, 'events.jsonl'))
      .filter((file) => fs.existsSync(file))
      .flatMap((file) => fs.readFileSync(file, 'utf8').trim().split('\n'))
      .map((line) => JSON.parse(line) as { type: string; by?: { kind: string; cwd: string } })
      .filter((line) => line.type === type);
  };

  test('an infra call is in the event log, by the SDK', async () => {
    await withDocker(() => sdk.infra.start({ services: ['db'] }));
    expect(infraEvents('infra-command').at(-1)?.by).toMatchObject({ kind: 'sdk', cwd: '.' });
  });

  test('a compose call that changes something is in the event log, by the SDK', async () => {
    await withDocker(() => sdk.infra.compose(['up', '-d'], { stdio: 'pipe' }));
    expect(infraEvents('compose-command').at(-1)?.by).toMatchObject({ kind: 'sdk', cwd: '.' });
  });

  test('rejects an option its command lacks', async () => {
    await expect(sdk.infra.stop({ waitTimeout: 5 } as never)).rejects.toThrow(
      'infra.stop: unknown option "waitTimeout"',
    );
  });

  test.each([
    [{ services: 'db' }, 'infra.start: `services` takes an array of strings'],
    [{ tags: ['data', 3] }, 'infra.start: `tags` takes an array of strings'],
  ])('a malformed selection is refused: %j', async (selection, message) => {
    await expect(sdk.infra.start(selection as never)).rejects.toThrow(message);
  });
});

describe('an infra stop hook that throws, from the command line', () => {
  test("infra stop reports the service stopped, but with the hook's error, and exits 1", () => {
    fs.rmSync(dockerCalls, { force: true });
    const run = cliRun(['infra', 'stop', '-s', 'db'], {
      cwd: infraWs,
      env: { ...process.env, PATH: dockerPath, FAIL_STOP_HOOK: '1' },
      channel: false,
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/db +stopped, but beforeStop failed: webhook not removed/);
    expect(run.stdout).toContain('✖ infra stopped, but a hook failed: db');
    // The stop went ahead all the same.
    expect(dockerCallLines().some((line) => / stop /.test(line) || / down /.test(line))).toBe(true); // oxfmt-ignore
  });
});

describe('a standalone `stackctl infra` command that is ended', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // SIGKILL runs no code of the command; SIGINT is a Ctrl+C that reaches only the command, as its
  // hook's commands are not in the terminal's group.
  test.each(['SIGTERM', 'SIGINT', 'SIGKILL'] as const)(
    'a %s takes the command its hook runs with it, and what that command started',
    { timeout: 60_000 },
    async (signal) => {
      const pidsFile = path.join(infraWs, 'hook.pids');
      fs.rmSync(pidsFile, { force: true });
      const command = spawn(process.execPath, [path.join(buildDir, 'cli.js'), 'infra', 'start'], {
        cwd: infraWs,
        env: { ...process.env, PATH: dockerPath, LONG_HOOK: '1' },
        stdio: 'ignore',
      });
      const pids = () => (fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').trim().split(' ').map(Number) : []); // oxfmt-ignore
      try {
        await vi.waitFor(() => expect(pids()).toHaveLength(2), { timeout: 20_000, interval: 50 });
        expect(pids().map(alive)).toEqual([true, true]);
        command.kill(signal);
        await vi.waitFor(() => expect(pids().map(alive)).toEqual([false, false]), { timeout: 10_000, interval: 50 }); // oxfmt-ignore
      } finally {
        command.kill('SIGKILL');
        // The hook's own command and its child, by the pids it wrote for this test.
        for (const pid of pids()) {
          if (alive(pid)) {
            process.kill(pid, 'SIGKILL');
          }
        }
      }
    },
  );
});

describe('service', () => {
  test.each([
    [{ services: 'api' }, 'service.stop: `services` takes an array of strings'],
    [{ tags: [3] }, 'service.stop: `tags` takes an array of strings'],
  ])('a malformed selection is refused: %j', async (selection, message) => {
    await expect(sdk.service.stop(selection as never)).rejects.toThrow(message);
  });

  test('rejects an option its command lacks', async () => {
    await expect(sdk.service.stop({ services: ['api'], waitTimeout: 5 } as never)).rejects.toThrow(
      'service.stop: unknown option "waitTimeout"',
    );
  });
});

describe('session commands, with no session running', () => {
  test('stop resolves stopped: false', async () => {
    await expect(inDir(ws, () => sdk.stop())).resolves.toEqual({ stopped: false });
  });

  test('status resolves running: false', async () => {
    const report = await inDir(ws, () => sdk.status());
    expect(report).toMatchObject({ profile: 'development', running: false, status: null });
  });

  test('events resolves with no lines before any session of the profile ran', async () => {
    await expect(sdk.events({ profile: 'never-ran', workspaceDir: ws })).resolves.toEqual([]);
  });

  test('logs rejects before any session of the profile ran', async () => {
    await expect(sdk.logs({ profile: 'never-ran', workspaceDir: ws })).rejects.toThrow(
      'stackctl logs: no never-ran session has run here yet.',
    );
  });

  test("service.restart rejects with the CLI's message", async () => {
    await expect(inDir(ws, () => sdk.service.restart({ services: ['api'] }))).rejects.toThrow(
      /No development stackctl session is running/,
    );
  });

  test('resetProfile without a profile rejects', async () => {
    await expect(inDir(ws, () => sdk.resetProfile({} as never))).rejects.toThrow(
      'resetProfile: `profile` names the profile whose state to delete',
    );
  });
});

describe('session commands, in a running session', () => {
  let stack: Awaited<ReturnType<IndexModule['startStack']>>;
  beforeAll(async () => {
    stack = await inDir(ws, () => sdk.startStack({ services: ['api'] }));
  }, 120_000);
  afterAll(async () => {
    await stack?.stop();
  });

  test('status resolves with the session', async () => {
    const report = await inDir(ws, () => sdk.status());
    expect(report.running).toBe(true);
    expect(report.status?.pid).toBe(stack.pid);
  });

  test('service.restart resolves with a result per service, once ready', async () => {
    const result = await inDir(ws, () => sdk.service.restart({ services: ['api'] }));
    expect(result).toEqual({ ok: true, results: [{ service: 'api', status: 'running' }] });
  });

  test('events with lines returns the last lines, parsed', async () => {
    const lines = await inDir(ws, () => sdk.events({ lines: 2 }));
    expect(lines).toHaveLength(2);
    expect(typeof lines[0]?.type).toBe('string');
  });

  test('events with follow yields parsed lines', async () => {
    const seen: string[] = [];
    await inDir(ws, async () => {
      for await (const line of sdk.events({ follow: true })) {
        seen.push(line.type);
        break;
      }
    });
    expect(seen).toHaveLength(1);
  });

  test("logs returns the session's log", async () => {
    const { path: file, text } = await inDir(ws, () => sdk.logs());
    expect(file).toBe(stack.logFile);
    expect(text).toMatch(/\[api\s*\] up/);
  });

  test('logs --path for the SDK hands over the path and prints nothing', () => {
    const run = cliRun(['logs', '--path', '--sdk-result'], { cwd: ws });
    expect(run.stdout).toBe('');
    expect(JSON.parse(run.result)).toEqual({ path: stack.logFile });
  });

  test('logs with follow yields its lines', async () => {
    const seen: string[] = [];
    await inDir(ws, async () => {
      for await (const line of sdk.logs({ follow: true })) {
        seen.push(line);
        break;
      }
    });
    expect(seen).toHaveLength(1);
  });

  test('stop quits it', async () => {
    const other = await inDir(ws, () => sdk.startStack({ services: ['web'], profile: 'other' }));
    await expect(inDir(ws, () => sdk.stop({ profile: 'other' }))).resolves.toEqual({
      stopped: true,
    });
    expect(() => process.kill(other.pid, 0)).toThrow('ESRCH');
  }, 60_000);
});

describe('init()', () => {
  test('sets an empty directory up', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-sdk-init-')));
    try {
      await expect(sdk.init({ workspaceDir: dir })).resolves.toBeUndefined();
      expect(fs.existsSync(path.join(dir, 'stackctl.config.ts'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Runs the built CLI in the spec's workspace and waits for it to exit. */
function cli(args: string[]) {
  return spawnSync(process.execPath, [path.join(buildDir, 'cli.js'), ...args], {
    cwd: ws,
    encoding: 'utf8',
  });
}

/** Starts a headless session in the background, by the pid this spec started. */
function background(args: string[]): ChildProcess {
  return spawn(process.execPath, [path.join(buildDir, 'cli.js'), '--headless', ...args], {
    cwd: ws,
    stdio: 'ignore',
  });
}

/** Until a session of the profile is recorded and answers: started, if not yet ready. */
async function untilRecorded(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await inDir(ws, () => sdk.status())).running) {
    if (Date.now() > deadline) {
      throw new Error('no session was recorded within 30s');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const gone = async (pid: number) => {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe('attach() and wait()', () => {
  test('attach with no session rejects at once', async () => {
    const startedAt = Date.now();
    await expect(inDir(ws, () => sdk.attach())).rejects.toThrow(
      /No development stackctl session is running/,
    );
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  test('attach to a session started with start --detach: attached, its origins and services', async () => {
    const started = cli(['start', '--detach', '-s', 'api']);
    expect(started.status, started.stderr).toBe(0);
    let stack: Awaited<ReturnType<IndexModule['attach']>> | undefined;
    try {
      stack = await inDir(ws, () => sdk.attach());
      expect(stack.session).toBe('attached');
      expect(stack.services).toEqual(['api']);
      expect(stack.origins).toEqual({ api: 'http://localhost:21096', stuck: 'http://localhost:21097' }); // oxfmt-ignore
      const restarted = await stack.service.restart({ services: ['api'] });
      expect(restarted).toEqual({ ok: true, results: [{ service: 'api', status: 'running' }] });
      expect((await stack.status()).running).toBe(true);
    } finally {
      await inDir(ws, () => sdk.stop());
    }
    expect(await gone(stack!.pid)).toBe(true);
  }, 60_000);

  test("an attached session doesn't end with the process that attached", async () => {
    const started = cli(['start', '--detach', '-s', 'web']);
    expect(started.status, started.stderr).toBe(0);
    const caller = path.join(ws, 'attach-and-exit.mjs');
    fs.writeFileSync(
      caller,
      `import { attach } from '${pathToFileURL(path.join(buildDir, 'index.js')).href}';\nconst s = await attach();\nprocess.stdout.write(String(s.pid));\n`,
    );
    const run = spawnSync(process.execPath, [caller], { cwd: ws, encoding: 'utf8' });
    const pid = Number(run.stdout);
    expect(pid).toBeGreaterThan(0);
    try {
      expect((await inDir(ws, () => sdk.status())).running).toBe(true);
    } finally {
      await inDir(ws, () => sdk.stop());
    }
    expect(await gone(pid)).toBe(true);
  }, 60_000);

  test("attach to a session that isn't ready yet waits until it is", async () => {
    const session = background(['-s', 'api']);
    try {
      // Once the session has written its record: attach sees it starting, then waits.
      await untilRecorded();
      const stack = await inDir(ws, () => sdk.attach());
      expect(stack.services).toEqual(['api']);
    } finally {
      await inDir(ws, () => sdk.stop());
      session.kill('SIGTERM');
    }
  }, 60_000);

  test('attach rejects within waitTimeout when the session never gets ready', async () => {
    const session = background(['-s', 'stuck']);
    try {
      await untilRecorded();
      await expect(inDir(ws, () => sdk.attach({ waitTimeout: 3 }))).rejects.toThrow(
        /not ready after 3s/,
      );
    } finally {
      await inDir(ws, () => sdk.stop());
      session.kill('SIGTERM');
    }
  }, 60_000);

  test('wait resolves once a session started later is ready', async () => {
    let session: ChildProcess | undefined;
    const timer = setTimeout(() => (session = background(['-s', 'web'])), 500);
    try {
      const stack = await inDir(ws, () => sdk.wait({ timeout: 30 }));
      expect(stack.session).toBe('attached');
      expect(stack.services).toEqual(['web']);
    } finally {
      clearTimeout(timer);
      await inDir(ws, () => sdk.stop());
      session?.kill('SIGTERM');
    }
  }, 60_000);
});
