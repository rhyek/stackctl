import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { INJECTED_ENV_VAR } from '../env-base.js';

/**
 * The SDK's `exec()` and `run()`, against a workspace on disk. They resolve by running the CLI
 * compiled beside them, so the package is compiled from the current source in `beforeAll` (under
 * the package's own `node_modules`, a directory of this spec's own) and imported from there.
 */
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const buildDir = path.join(packageDir, 'node_modules', '.cache', 'sdk-spec');
const cli = path.join(buildDir, 'cli.js');

type IndexModule = typeof import('../index.js');
let sdk: IndexModule;
let ws: string;
let apiDir: string;
let empty: string;

/** Runs `fn` with the process in `dir`, and puts it back after. */
async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
}

beforeAll(async () => {
  // TypeScript 7 exports no `bin/tsc`, so it's found next to the package.json it does export.
  const tsPackage = fileURLToPath(import.meta.resolve('typescript/package.json'));
  const tsc = path.join(path.dirname(tsPackage), 'bin', 'tsc');
  fs.rmSync(buildDir, { recursive: true, force: true });
  await execa(
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
  );
  sdk = (await import(pathToFileURL(path.join(buildDir, 'index.js')).href)) as IndexModule;

  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-sdk-')));
  empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-sdk-noconfig-')));
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'sdkroot', type: 'module' })); // oxfmt-ignore
  fs.writeFileSync(
    path.join(ws, 'stackctl.config.ts'),
    [
      "import { defineConfig } from 'stackctl';",
      'export default defineConfig({',
      "  serviceRootDir: 'apps',",
      "  env: { vars: { FROM_CONFIG: 'config' } },",
      '  services: { api: { port: 21054 } },',
      '});',
      '',
    ].join('\n'),
  );
  const standIn = path.join(ws, 'node_modules', 'stackctl');
  fs.mkdirSync(standIn, { recursive: true });
  fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
  fs.symlinkSync(buildDir, path.join(standIn, 'dist'));

  apiDir = path.join(ws, 'apps', 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  fs.writeFileSync(
    path.join(apiDir, 'package.json'),
    JSON.stringify({ name: 'api', scripts: { where: 'pwd' } }),
  );
  fs.writeFileSync(path.join(apiDir, '.env.development'), 'API_VAR=from-api\n');
  fs.mkdirSync(path.join(ws, 'scripts'));
  fs.writeFileSync(path.join(ws, 'scripts', '.env.development'), 'SCRIPTS_VAR=from-scripts\n');
}, 120_000);

afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
  fs.rmSync(buildDir, { recursive: true, force: true });
});

describe('exec()', () => {
  test("exec runs in the target's directory", async () => {
    const result = await inDir(ws, () =>
      sdk.exec({ target: 'api', command: ['pwd'], stdio: 'pipe' }),
    );
    expect(result).toEqual({ exitCode: 0, signal: null, stdout: `${apiDir}\n`, stderr: '' });
  });

  test("resolves with the command's exit code", async () => {
    const result = await inDir(ws, () =>
      sdk.exec({ command: ['sh', '-c', 'exit 4'], stdio: 'pipe' }),
    );
    expect(result).toMatchObject({ exitCode: 4, signal: null });
  });

  test('rejects outside a workspace', async () => {
    await expect(inDir(empty, () => sdk.exec({ command: ['true'] }))).rejects.toThrow(
      `No stackctl.config.ts in ${empty} or any directory above it`,
    );
  });

  test('workspaceDir from outside', async () => {
    const result = await inDir('/', () =>
      sdk.exec({ workspaceDir: ws, command: ['pwd'], stdio: 'pipe' }),
    );
    expect(result.stdout).toBe(`${ws}\n`);
  });

  test('a relative target resolves against workspaceDir', async () => {
    const result = await inDir('/', () =>
      sdk.exec({ workspaceDir: ws, target: 'scripts', command: ['pwd'], stdio: 'pipe' }),
    );
    expect(result.stdout).toBe(`${path.join(ws, 'scripts')}\n`);
  });

  test('an unknown target rejects', async () => {
    await expect(inDir(ws, () => sdk.exec({ target: 'nope', command: ['true'] }))).rejects.toThrow(
      '"nope" is neither a service nor a directory in this workspace',
    );
  });

  test('rejects a command not found', async () => {
    await expect(
      inDir(ws, () => sdk.exec({ command: ['stackctl-no-such-command'], stdio: 'pipe' })),
    ).rejects.toThrow('stackctl-no-such-command');
  });

  test('runs in the mode asked for', async () => {
    const result = await inDir(ws, () =>
      sdk.exec({ mode: 'test', command: ['printenv', 'STACKCTL_MODE'], stdio: 'pipe' }),
    );
    expect(result.stdout).toBe('test\n');
  });

  test("a caller stackctl started gets its target's env, not what stackctl gave it", async () => {
    // What a session leaves a process it started: its values, and the list of what it added.
    process.env.PORT = '1111';
    process.env.API_VAR = 'caller';
    process.env[INJECTED_ENV_VAR] = 'PORT,API_VAR';
    try {
      const print = ['sh', '-c', 'echo "$PORT|$API_VAR"'] as [string, ...string[]];
      const api = await inDir(ws, () => sdk.exec({ target: 'api', command: print, stdio: 'pipe' }));
      // api's port, and api's .env value: the caller's would win over a file, were it ambient.
      expect(api.stdout).toBe('21054|from-api\n');
      const scripts = await inDir(ws, () =>
        sdk.exec({ target: 'scripts', command: print, stdio: 'pipe' }),
      );
      // A directory gets no port: the caller's is dropped, not passed through.
      expect(scripts.stdout).toBe('|\n');
    } finally {
      delete process.env.PORT;
      delete process.env.API_VAR;
      delete process.env[INJECTED_ENV_VAR];
    }
  });

  test("what the config prints goes to the caller's stderr, not its stdout", async () => {
    const noisy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-sdk-noisy-')));
    try {
      fs.writeFileSync(
        path.join(noisy, 'stackctl.config.ts'),
        "import { defineConfig } from 'stackctl';\nconsole.log('from-the-config');\nexport default defineConfig({ services: {} });\n",
      );
      const standIn = path.join(noisy, 'node_modules', 'stackctl');
      fs.mkdirSync(standIn, { recursive: true });
      fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
      fs.symlinkSync(buildDir, path.join(standIn, 'dist'));
      // A caller of its own, whose stdout and stderr are what is checked.
      const index = pathToFileURL(path.join(buildDir, 'index.js')).href;
      const caller = [
        `const { exec } = await import(${JSON.stringify(index)});`,
        `const r = await exec({ workspaceDir: ${JSON.stringify(noisy)}, command: ['echo', 'from-the-command'], stdio: 'pipe' });`,
        'process.stdout.write(JSON.stringify(r.stdout));',
      ].join('\n');
      const result = await execa('node', ['--input-type=module', '-e', caller], {
        cwd: noisy,
        reject: false,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe(JSON.stringify('from-the-command\n'));
      expect(result.stderr).toContain('from-the-config');
    } finally {
      fs.rmSync(noisy, { recursive: true, force: true });
    }
  });

  test("tees to a log file in the latest session's commands/", async () => {
    const sessions = path.join(ws, 'node_modules', '.stackctl', 'modes', 'development', 'sessions');
    const latest = String(Date.now() + 60_000);
    const logDir = path.join(sessions, latest, 'commands');
    fs.mkdirSync(path.join(sessions, latest), { recursive: true });
    const before = new Set<string>();
    await inDir('/', () =>
      sdk.exec({ workspaceDir: ws, command: ['echo', 'logged-by-sdk'], stdio: 'pipe' }),
    );
    const added = fs.readdirSync(logDir).filter((name) => !before.has(name));
    expect(added).toHaveLength(1);
    expect(fs.readFileSync(path.join(logDir, added[0]!), 'utf8')).toContain('logged-by-sdk');
  });

  test.each(['api', 'apps/api', 'scripts', '.'])(
    'the CLI and the SDK agree: %s',
    async (target) => {
      const names = ['PORT', 'SCRIPTS_VAR', 'FROM_CONFIG'];
      const js = `console.log(JSON.stringify([process.cwd(),${names.map((n) => `process.env.${n}??null`).join(',')}]))`; // oxfmt-ignore
      const command: [string, ...string[]] = ['node', '-e', js];
      const viaCli = await execa('node', [cli, 'exec', target, '--', ...command], {
        cwd: ws,
        reject: false,
      });
      expect(viaCli.exitCode, viaCli.stderr).toBe(0);
      const viaSdk = await inDir(ws, () => sdk.exec({ target, command, stdio: 'pipe' }));
      expect(JSON.parse(viaSdk.stdout!)).toEqual(JSON.parse(viaCli.stdout));
    },
  );
});

describe('unknown options', () => {
  test.each(['cwd', 'service', 'bogus'])('exec rejects the option %s', async (name) => {
    const opts = { command: ['true'], [name]: '.' } as never;
    await expect(inDir(ws, () => sdk.exec(opts))).rejects.toThrow(`exec: unknown option "${name}"`);
  });

  test.each(['cwd', 'service', 'bogus'])('run rejects the option %s', async (name) => {
    const opts = { script: 'where', [name]: '.' } as never;
    await expect(inDir(ws, () => sdk.run(opts))).rejects.toThrow(`run: unknown option "${name}"`);
  });

  test.each(['cwd', 'bogus'])('startStack rejects the option %s', async (name) => {
    const opts = { services: ['api'], [name]: '.' } as never;
    await expect(inDir(ws, () => sdk.startStack(opts))).rejects.toThrow(
      `startStack: unknown option "${name}"`,
    );
  });

  test('every documented option is accepted', async () => {
    const all = {
      mode: undefined,
      target: undefined,
      workspaceDir: undefined,
      stdio: 'pipe' as const,
    };
    await expect(inDir(ws, () => sdk.exec({ ...all, command: ['true'] }))).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(
      inDir(ws, () => sdk.run({ ...all, target: 'api', script: 'where', args: [] })),
    ).resolves.toMatchObject({ exitCode: 0 });
  });
});

describe('run()', () => {
  test("runs the target's script", async () => {
    const result = await inDir(ws, () =>
      sdk.run({ target: 'api', script: 'where', stdio: 'pipe' }),
    );
    expect(result.stdout).toBe(`${apiDir}\n`);
  });

  test('run rejects a missing script', async () => {
    await expect(inDir(ws, () => sdk.run({ target: 'api', script: 'nope' }))).rejects.toThrow(
      `No "nope" script or make target found in ${apiDir}`,
    );
  });
});

describe('resolveEnv()', () => {
  test.each(['api', 'scripts', '.'])('resolveEnv matches exec: %s', async (target) => {
    const names = ['PORT', 'SCRIPTS_VAR', 'API_VAR'];
    const js = `console.log(JSON.stringify([${names.map((n) => `process.env.${n}??null`).join(',')}]))`; // oxfmt-ignore
    const viaExec = await inDir(ws, () =>
      sdk.exec({ target, command: ['node', '-e', js], stdio: 'pipe' }),
    );
    const { env } = await inDir(ws, async () => sdk.resolveEnv({ target }));
    expect(names.map((n) => env[n] ?? null)).toEqual(JSON.parse(viaExec.stdout!));
  });

  test('resolves for the current directory, or the root with workspaceDir', async () => {
    const fromApi = await inDir(apiDir, async () => sdk.resolveEnv({}));
    expect(fromApi.env.API_VAR).toBe('from-api');
    const fromRoot = await inDir('/', async () => sdk.resolveEnv({ workspaceDir: ws }));
    expect(fromRoot.env.API_VAR).toBeUndefined();
    expect(fromRoot.env.FROM_CONFIG).toBe('config');
  });

  test('accepts an allowed option set to undefined', async () => {
    const { env } = await inDir(ws, async () => sdk.resolveEnv({ mode: undefined }));
    expect(env.STACKCTL_MODE).toBe('development');
  });

  test("what the config prints goes to the caller's stderr, not its stdout", async () => {
    const noisy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-env-noisy-')));
    try {
      fs.writeFileSync(
        path.join(noisy, 'stackctl.config.ts'),
        "import { defineConfig } from 'stackctl';\nconsole.log('from-the-config');\nexport default defineConfig({ services: {} });\n",
      );
      const standIn = path.join(noisy, 'node_modules', 'stackctl');
      fs.mkdirSync(standIn, { recursive: true });
      fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
      fs.symlinkSync(buildDir, path.join(standIn, 'dist'));
      const index = pathToFileURL(path.join(buildDir, 'index.js')).href;
      const caller = [
        `const { resolveEnv } = await import(${JSON.stringify(index)});`,
        `process.stdout.write(JSON.stringify(Object.keys(resolveEnv({ workspaceDir: ${JSON.stringify(noisy)} }).env)));`,
      ].join('\n');
      const result = await execa('node', ['--input-type=module', '-e', caller], {
        cwd: noisy,
        reject: false,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).not.toContain('from-the-config');
      expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
      expect(result.stderr).toContain('from-the-config');
    } finally {
      fs.rmSync(noisy, { recursive: true, force: true });
    }
  });

  test('rejects with the resolver message, as exec() does', async () => {
    await expect(inDir(ws, async () => sdk.resolveEnv({ target: 'nope' }))).rejects.toThrow(
      /^"nope" is neither a service nor a directory in this workspace/,
    );
    await expect(inDir(empty, async () => sdk.resolveEnv({}))).rejects.toThrow(
      new RegExp(`^No stackctl.config.ts in ${empty} or any directory above it`),
    );
  });

  test('takes no options at all', async () => {
    const { env } = await inDir(apiDir, async () => sdk.resolveEnv());
    expect(env.API_VAR).toBe('from-api');
  });

  test.each([
    'cwd',
    'useConfig',
    'service',
    'relativeDir',
    'files',
    'override',
    'vars',
    'ambient',
    'bogus',
  ])('rejects the option %s at runtime', async (name) => {
    const opts = { [name]: name === 'files' ? ['.env'] : '.' } as never;
    await expect(inDir(ws, async () => sdk.resolveEnv(opts))).rejects.toThrow(
      `resolveEnv: unknown option "${name}"`,
    );
  });
});

describe("inside stackctl's own process", () => {
  /**
   * A workspace whose config calls `call` as it loads. The config counts its loads in a file and
   * gives up past the third, before calling anything: a regression spawns a bounded chain of
   * resolvers, never an endless one.
   */
  function recursiveWorkspace(call: string): { dir: string; loads: () => number } {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-sdk-reentry-')));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'reentry', type: 'module' })); // oxfmt-ignore
    fs.writeFileSync(
      path.join(dir, 'stackctl.config.ts'),
      [
        "import fs from 'node:fs';",
        "import { defineConfig, exec, resolveEnv, run, startStack } from 'stackctl';",
        "const counter = new URL('./loads.txt', import.meta.url);",
        "const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;",
        'fs.writeFileSync(counter, String(n));',
        "if (n > 3) throw new Error('loaded more than three times');",
        'void exec; void run; void resolveEnv; void startStack;',
        `${call};`,
        'export default defineConfig({ services: {} });',
        '',
      ].join('\n'),
    );
    const standIn = path.join(dir, 'node_modules', 'stackctl');
    fs.mkdirSync(standIn, { recursive: true });
    fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
    fs.symlinkSync(buildDir, path.join(standIn, 'dist'));
    const loads = () => Number(fs.readFileSync(path.join(dir, 'loads.txt'), 'utf8'));
    return { dir, loads };
  }

  test.each([
    ['resolveEnv', 'resolveEnv({})'],
    ['exec', "await exec({ command: ['true'] })"],
    ['run', "await run({ script: 'dev' })"],
    ['startStack', 'await startStack({ services: [] })'],
  ])(
    'a config that calls %s() fails as it loads, and starts no resolver',
    async (fn, call) => {
      const { dir, loads } = recursiveWorkspace(call);
      try {
        const result = await execa('node', [cli, 'show-config'], {
          cwd: dir,
          reject: false,
          timeout: 20_000,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(`${fn}() can't be called inside stackctl's own process`);
        expect(loads()).toBe(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test("a script's resolveEnv() on such a workspace fails with the config's error, and starts one resolver", async () => {
    const { dir, loads } = recursiveWorkspace('resolveEnv({})');
    try {
      const index = pathToFileURL(path.join(buildDir, 'index.js')).href;
      const caller = [
        `const { resolveEnv } = await import(${JSON.stringify(index)});`,
        `resolveEnv({ workspaceDir: ${JSON.stringify(dir)} });`,
      ].join('\n');
      const result = await execa('node', ['--input-type=module', '-e', caller], {
        cwd: dir,
        reject: false,
        timeout: 20_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("resolveEnv() can't be called inside stackctl's own process");
      expect(loads()).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
