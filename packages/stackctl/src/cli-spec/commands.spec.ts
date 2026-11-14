import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  packageDir,
  buildDir,
  cli,
  start,
  ws,
  app,
  stackctl,
  lastLine,
  setUpCliWorkspace,
} from './harness.js';

/** The commands that run a script or a command once (`run`, `exec`, `infra`), how they find the
 * workspace and the target, and the environment they hand it. See `harness.ts`. */
setUpCliWorkspace('commands');

describe('stackctl run', () => {
  test('forwards the operands to the script, intact', async () => {
    const args = ['a b', '--c=$HOME', "it's", '*'];
    const result = await stackctl(['run', 'app', 'argv', '--', ...args]);
    expect(JSON.parse(lastLine(result.stdout))).toEqual(['x', ...args]);
    expect(result.exitCode).toBe(0);
  });

  test("exits with the script's exit code", async () => {
    expect((await stackctl(['run', 'app', 'fail'])).exitCode).toBe(7);
  });

  test('exits with 128 + the signal number when a signal kills the script', async () => {
    expect((await stackctl(['run', 'app', 'kill'])).exitCode).toBe(137);
  });

  test("gives the script the package's .env values", async () => {
    const result = await stackctl(['run', 'app', 'env']);
    expect(lastLine(result.stdout)).toBe('from-app-env-file');
  });

  test('runs the script in the package directory, wherever it was invoked from', async () => {
    const result = await stackctl(['run', 'app', 'cwd']);
    expect(lastLine(result.stdout)).toBe(app);
  });

  test('infers the package from the directory it is invoked in', async () => {
    const result = await stackctl(['run', 'cwd'], { cwd: app });
    expect(lastLine(result.stdout)).toBe(app);
  });

  test("resolves binaries from the package's and the workspace root's node_modules/.bin", async () => {
    const result = await stackctl(['run', 'app', 'bins']);
    expect(result.stdout.trim().split('\n').slice(-2)).toEqual(['localbin-OK', 'rootbin-OK']);
  });

  test('tells the script which package and script it is', async () => {
    const result = await stackctl(['run', 'app', 'whoami'], {
      // What `pnpm stackctl` at the workspace root would have left in the environment.
      env: { npm_package_name: 'wsroot', npm_package_version: '0.0.1', npm_lifecycle_event: 'x' },
    });
    expect(lastLine(result.stdout)).toBe('app 2.0.0 whoami');
  });

  test("prints nothing but the script's own output", async () => {
    const result = await stackctl(['run', 'app', 'hook']);
    expect(result.stdout).toBe('MAIN');
    expect(result.stderr).toBe('');
  });

  test('does not run pre<name> and post<name> scripts', async () => {
    const result = await stackctl(['run', 'app', 'hook']);
    expect(lastLine(result.stdout)).toBe('MAIN');
    expect(result.stdout).not.toContain('PRE');
    expect(result.stdout).not.toContain('POST');
  });

  test("ignores a package manager's script-shell setting", async () => {
    const result = await stackctl(['run', 'app', 'hook'], {
      env: {
        npm_config_script_shell: '/usr/bin/false',
        pnpm_config_script_shell: '/usr/bin/false',
      },
    });
    expect(lastLine(result.stdout)).toBe('MAIN');
    expect(result.exitCode).toBe(0);
  });

  test('refuses a script the package does not have', async () => {
    const result = await stackctl(['run', 'app', 'nope']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(`No "nope" script or make target found in ${app}`);
  });

  test('fails when no script is named', async () => {
    const result = await stackctl(['run'], { cwd: app });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("missing required argument 'script'");
  });
});

describe('the config type check', () => {
  let typed: string;
  beforeAll(() => {
    // A workspace of its own: a config with a type error, and beside it the repo's typescript,
    // the build's stackctl (which has no declarations, hence `noImplicitAny` off) and a tsconfig.
    typed = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-typed-')));
    fs.writeFileSync(path.join(typed, 'package.json'), '{ "type": "module" }\n');
    fs.writeFileSync(
      path.join(typed, 'stackctl.config.ts'),
      [
        "import { defineConfig } from 'stackctl';",
        // A type error only tsc sees: the config itself is valid.
        "export const label: number = 'x';",
        "export default defineConfig({ services: { api: { relativeDir: '.' } } });",
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(typed, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'nodenext', strict: true, noImplicitAny: false, types: [] } }), // oxfmt-ignore
    );
    fs.mkdirSync(path.join(typed, 'node_modules'));
    fs.symlinkSync(
      path.join(packageDir, '..', '..', 'node_modules', 'typescript'),
      path.join(typed, 'node_modules', 'typescript'),
    );
    fs.symlinkSync(
      fs.realpathSync(path.join(ws, 'node_modules', 'stackctl')),
      path.join(typed, 'node_modules', 'stackctl'),
    );
  });
  afterAll(() => fs.rmSync(typed, { recursive: true, force: true }));

  const refusal = [
    'stackctl: stackctl.config.ts has type errors:',
    '',
    "stackctl.config.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'.",
  ].join('\n');

  test('refuses `start` with type errors, before starting anything', async () => {
    const result = await stackctl(['--profile', 'development', '--headless', '-s', 'api'], {
      cwd: typed,
    });
    expect(result).toMatchObject({ exitCode: 1, stdout: '', stderr: refusal });
    expect(fs.existsSync(path.join(typed, 'node_modules', '.stackctl', 'profiles'))).toBe(false);
  });

  test('refuses `run` with type errors', async () => {
    const result = await stackctl(['run', 'build'], { cwd: typed });
    expect(result).toMatchObject({ exitCode: 1, stdout: '', stderr: refusal });
  });

  test('leaves `exec` alone', async () => {
    const result = await stackctl(['exec', '--', 'node', '-e', "console.log('ran')"], {
      cwd: typed,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'ran', stderr: '' });
  });
});

describe('stackctl exec', () => {
  const PRINT = ['sh', '-c', 'pwd; echo $APP_VAR'];

  test('runs a literal command in the package directory, with its .env values', async () => {
    const result = await stackctl(['exec', 'app', '--', ...PRINT]);
    expect(result.stdout).toBe(`${app}\nfrom-app-env-file`);
    expect(result.exitCode).toBe(0);
  });

  test('infers the package from the directory it is invoked in', async () => {
    const result = await stackctl(['exec', '--', ...PRINT], { cwd: app });
    expect(result.stdout).toBe(`${app}\nfrom-app-env-file`);
  });

  test("exits with the command's exit code", async () => {
    expect((await stackctl(['exec', 'app', '--', 'sh', '-c', 'exit 5'])).exitCode).toBe(5);
  });

  test("writes its two lines to the latest session's event log: where, what (a URL's password masked), its exit", async () => {
    // With no session folder yet, the command makes one of its own, as a session would.
    const sessions = path.join(
      ws,
      'node_modules',
      '.stackctl',
      'profiles',
      'development',
      'sessions',
    );
    fs.rmSync(sessions, { recursive: true, force: true });
    const asked = ['sh', '-c', 'exit 3', 'postgres://app:s3cret@db/app'];
    await stackctl(['exec', 'app', '--', ...asked], { env: { STACKCTL_STARTED_BY_AGENT: '0' } });
    const [folder] = fs.readdirSync(sessions);
    expect(folder).toMatch(/^\d+$/);
    expect(fs.readdirSync(path.join(sessions, folder!, 'commands'))).toHaveLength(1);
    const lines = fs.readFileSync(path.join(sessions, folder!, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>); // oxfmt-ignore
    const command = ['sh', '-c', 'exit 3', 'postgres://app:***@db/app'];
    expect(lines).toMatchObject([
      { type: 'one-off-command', phase: 'begin', kind: 'exec', service: 'app', command, by: { kind: 'cli', cwd: '.', agent: false } }, // oxfmt-ignore
      { type: 'one-off-command', phase: 'end', kind: 'exec', service: 'app', command, ok: false, exitCode: 3, signal: null }, // oxfmt-ignore
    ]);
    expect(JSON.stringify(lines)).not.toContain('s3cret');
  });

  test('fails when no command is given', async () => {
    const result = await stackctl(['exec', 'app']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('exec requires a command (after `--`).');
  });

  test('does not take a script name: -c is not an option', async () => {
    const result = await stackctl(['exec', 'app', '-c', 'hook']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('MAIN');
  });
});

describe('stackctl infra', () => {
  // This workspace declares no infra, so a command that parses gets as far as saying so.
  const NO_INFRA = 'No `infra` in the stackctl config';
  const COMMANDS = ['start', 'stop', 'restart', 'reset', 'destroy'];

  test.each(COMMANDS)('infra %s -s db -s mail reaches the infra', async (command) => {
    const result = await stackctl(['infra', command, '-s', 'db', '-s', 'mail']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(NO_INFRA);
  });

  test.each(COMMANDS)('infra %s with no -s reaches the infra', async (command) => {
    const result = await stackctl(['infra', command]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(NO_INFRA);
  });

  test.each(COMMANDS)(
    'infra %s db fails before touching anything: services are named with -s',
    async (command) => {
      const result = await stackctl(['infra', command, 'db']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/too many arguments/);
      expect(result.stderr).not.toContain(NO_INFRA);
    },
  );

  test.each(['up', 'down'])('infra %s is not a command', async (command) => {
    const result = await stackctl(['infra', command]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/unknown command/);
    expect(result.stderr).not.toContain(NO_INFRA);
  });
});

describe('-f follows one session', () => {
  const sessions = () => path.join(ws, 'node_modules', '.stackctl', 'profiles', 'development', 'sessions'); // oxfmt-ignore
  // Later than any session another test makes, so these two are the profile's latest.
  const followed = String(Date.now() + 1e9);
  const next = String(Number(followed) + 1);
  afterEach(() => {
    for (const id of [followed, next]) {
      fs.rmSync(path.join(sessions(), id), { recursive: true, force: true });
    }
  });

  test.each([
    { command: 'events', file: 'events.jsonl', first: '{"n":1}', second: '{"n":2}' },
    { command: 'logs', file: 'logs.txt', first: 'line one', second: 'line two' },
  ])(
    '$command -f follows the session it began with, and stops when the next one starts',
    async ({ command, file: name, first, second }) => {
      const file = path.join(sessions(), followed, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${first}\n`);
      const child = start('node', [cli, command, '-f'], { cwd: ws, timeout: 4_000 }); // oxfmt-ignore
      let out = '';
      await new Promise<void>((resolve) => {
        child.stdout!.on('data', (chunk: Buffer) => {
          out += String(chunk);
          if (out.includes(first)) {
            resolve();
          }
        });
      });
      // A line the followed session gets just before the next one starts is still printed.
      fs.appendFileSync(file, `${second}\n`);
      fs.mkdirSync(path.join(sessions(), next), { recursive: true });
      const result = await child.done;
      expect(result.signal).toBeNull();
      expect(result.stdout.split('\n')).toEqual([first, second]);
      expect(result.stderr).toBe(`stackctl ${command}: the development session exited; run stackctl ${command} -f again to follow the next one.`); // oxfmt-ignore
      expect(result.exitCode).toBe(0);
    },
  );
});

describe('a coding agent names the profile', () => {
  const agent = { STACKCTL_STARTED_BY_AGENT: '1' };

  test('a command with no profile is refused, saying how to name it', async () => {
    const result = await stackctl(['status'], { env: agent });
    expect(result.stderr).toBe(
      'stackctl: a coding agent names the profile on every command, development included: stackctl --profile development status. ' +
        'STACKCTL_PROFILE=<profile> names it too. (Not an agent? Set STACKCTL_STARTED_BY_AGENT=0.)',
    );
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(1);
  });

  test('so is one in CI, whose default profile is test', async () => {
    const result = await stackctl(['show-config'], { env: { ...agent, CI: 'true' } });
    expect(result.stderr).toContain('stackctl --profile development show-config');
    expect(result.exitCode).toBe(1);
  });

  test.each([
    { how: '--profile', args: ['--profile', 'development', 'status'], env: agent },
    {
      how: 'STACKCTL_PROFILE',
      args: ['status'],
      env: { ...agent, STACKCTL_PROFILE: 'development' },
    },
  ])('a profile named by $how runs', async ({ args, env }) => {
    const result = await stackctl(args, { env });
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  test('--version and help need no profile', async () => {
    expect((await stackctl(['--version'], { env: agent })).exitCode).toBe(0);
    expect((await stackctl(['status', '--help'], { env: agent })).exitCode).toBe(0);
  });
});

describe('exec and run take a target', () => {
  const api = () => path.join(ws, 'packages', 'api');
  /** What api's `build` printed: its directory, the profile, and its arguments. */
  const built = (stdout: string) => JSON.parse(lastLine(stdout)) as [string, string, string[]];

  test("run build runs the current directory target's build", async () => {
    const result = await stackctl(['run', 'build'], { cwd: api() });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(built(result.stdout)).toEqual([api(), 'development', []]);
  });

  test("run api build runs api's build", async () => {
    const result = await stackctl(['run', 'api', 'build']);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(built(result.stdout)).toEqual([api(), 'development', []]);
  });

  test('run api build extra fails: arguments to the script go after --', async () => {
    const result = await stackctl(['run', 'api', 'build', 'extra']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('arguments to the script go after --');
  });

  test('run api build -- --x forwards --x', async () => {
    const result = await stackctl(['run', 'api', 'build', '--', '--x']);
    expect(built(result.stdout)).toEqual([api(), 'development', ['--x']]);
  });

  test("run api build --profile test: the profile is stackctl's", async () => {
    const result = await stackctl(['run', 'api', 'build', '--profile', 'test']);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(built(result.stdout)).toEqual([api(), 'test', []]);
  });

  test('exec -- printenv X runs at the current directory', async () => {
    const result = await stackctl(['exec', '--', 'printenv', 'APP_PINNED']);
    expect(result.stdout).toBe('from-config');
  });

  test("exec api -- printenv PORT prints api's port", async () => {
    const result = await stackctl(['exec', 'api', '--', 'printenv', 'PORT']);
    expect(result.stdout).toBe('21053');
  });

  test('exec api extra -- true fails: the command goes after --', async () => {
    const result = await stackctl(['exec', 'api', 'extra', '--', 'true']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('the command goes after --: stackctl exec [target] -- <command...>');
  });

  test('an unknown target fails', async () => {
    const result = await stackctl(['exec', 'nope', '--', 'true']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('"nope" is neither a service nor a directory in this workspace');
  });

  const EXEC_FORM =
    'exec takes the service or directory as its first argument: stackctl exec api -- <command>';
  const RUN_FORM =
    'run takes the service or directory as its first argument: stackctl run api <script>';

  test.each([
    ['rejects -s on exec', ['exec', '-s', 'api', '--', 'true'], EXEC_FORM],
    ['rejects --service on exec', ['exec', '--service=api', '--', 'true'], EXEC_FORM],
    ['rejects -s given before exec', ['-s', 'api', 'exec', '--', 'true'], EXEC_FORM],
    ['rejects -s on run', ['run', '-s', 'api', 'build'], RUN_FORM],
    ['rejects -s given before run', ['-s', 'api', 'run', 'build'], RUN_FORM],
  ])('%s', async (_, args, message) => {
    const result = await stackctl(args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(message);
    expect(result.stdout).toBe('');
  });

  test('no target inside no service runs in place', async () => {
    const scripts = path.join(ws, 'scripts');
    const result = await stackctl(['exec', '--', 'pwd'], { cwd: scripts });
    expect(result.stdout).toBe(scripts);
  });

  test('a directory inside no service gets its own .env files, and no port', async () => {
    const result = await stackctl([
      'exec',
      'scripts',
      '--',
      'sh',
      '-c',
      'echo "$SCRIPTS_VAR|$PORT"',
    ]);
    expect(result.stdout).toBe('from-scripts|');
  });
});

describe('environment variables', () => {
  test('a stackctl started by a stackctl child drops what the outer one added, not the shell', async () => {
    const result = await stackctl(['run', 'app', 'nested'], {
      env: { NESTED_CLI: cli, FROM_SHELL: 'shell' },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    // APP_VAR came from app's .env file through the outer run: the inner exec, for `wide`, which
    // has no .env file of its own, doesn't see it. FROM_SHELL came from the shell, and survives.
    expect(lastLine(result.stdout)).toBe('undefined|shell');
  });

  const print = (...names: string[]) => ['sh', '-c', names.map((n) => `echo "$${n}"`).join('; ')];

  test('tells a command where stackctl was invoked and where the workspace root is', async () => {
    const result = await stackctl(
      ['exec', '--', ...print('STACKCTL_CWD', 'STACKCTL_WORKSPACE_DIR')],
      { cwd: app },
    );
    expect(result.stdout).toBe(`${app}\n${ws}`);
  });

  test('replaces a STACKCTL_CWD inherited from whatever started stackctl', async () => {
    const result = await stackctl(['exec', '--', ...print('STACKCTL_CWD')], {
      cwd: app,
      env: { STACKCTL_CWD: '/somewhere/else', STACKCTL_WORKSPACE_DIR: '/somewhere/else' },
    });
    expect(result.stdout).toBe(app);
  });

  test('expands a reference to the workspace root in a .env file', async () => {
    const result = await stackctl(['exec', 'app', '--', ...print('APP_DATA')]);
    expect(result.stdout).toBe(`${ws}/data`);
  });

  test("gives a package's command the config's own vars, under its .env file", async () => {
    const result = await stackctl(['exec', 'app', '--', ...print('ROOT_DIR', 'APP_PINNED')]);
    expect(result.stdout).toBe(`${ws}\nfrom-app-env-file`);
  });

  test("lets the shell win over one of the config's own vars", async () => {
    const args = ['exec', 'app', '--', ...print('SHELL_SET')];
    expect((await stackctl(args)).stdout).toBe('from-config');
    expect((await stackctl(args, { env: { SHELL_SET: 'from-shell' } })).stdout).toBe('from-shell');
  });

  test("expands a .env file's reference to one of the config's own vars", async () => {
    const result = await stackctl(['exec', 'app', '--', ...print('APP_ROOT_REF')]);
    expect(result.stdout).toBe(`${ws}/ref`);
  });

  test("gives a package's script the config's own vars", async () => {
    const result = await stackctl(['run', 'app', 'rootdir']);
    expect(lastLine(result.stdout)).toBe(ws);
  });

  test("gives a command run outside every package the config's own vars", async () => {
    const result = await stackctl(['exec', '--', ...print('ROOT_DIR', 'APP_PINNED')]);
    expect(result.stdout).toBe(`${ws}\nfrom-config`);
  });

  describe('with the shell exporting a variable env.override names', () => {
    const env = { PINNED_DIR: '/from/shell' };
    const PRINT = print('PINNED_DIR', 'DERIVED_DIR');
    const expected = '/from/config\n/from/config/storage';

    test("gives a package's command the config's value, and a .env reference to it the same", async () => {
      const result = await stackctl(['exec', 'app', '--', ...PRINT], { env });
      expect(result.stdout).toBe(expected);
    });

    test('does the same for a command run outside every package', async () => {
      expect((await stackctl(['exec', '--', ...PRINT], { env })).stdout).toBe(expected);
    });

    test('extends a variable the shell exports exactly once, for a command and a script', async () => {
      const shell = { APPENDED: '--base' };
      const command = await stackctl(['exec', 'app', '--', ...print('APPENDED')], {
        env: shell,
      });
      expect(command.stdout).toBe('--base --flag');
      const scripted = await stackctl(['run', 'app', 'appended'], { env: shell });
      expect(lastLine(scripted.stdout)).toBe('--base --flag');
    });
  });
});

describe('env.additionalFiles', () => {
  const print = (name: string) => ['sh', '-c', `echo "$${name}"`];

  test("gives exec's command the value derived from them", async () => {
    const result = await stackctl(['exec', 'app', '--', ...print('PRE_URL')]);
    expect(result.stdout).toBe('x:21010');
  });

  test('gives a command outside every service the same', async () => {
    const result = await stackctl(['exec', '--', ...print('PRE_URL')]);
    expect(result.stdout).toBe('x:21010');
  });

  test("gives run's script the value", async () => {
    const result = await stackctl(['run', 'app', 'preurl']);
    expect(lastLine(result.stdout)).toBe('x:21010');
  });

  test("loads the files the callback names for the profile's", async () => {
    const result = await stackctl(['exec', '--profile', 'test', '--', ...print('PRE_URL')]);
    expect(result.stdout).toBe('t:21100');
  });

  test('show-config prints the files looked for at each scope', async () => {
    const result = await stackctl(['show-config']);
    const files = [
      '.env',
      '.env.local',
      '.env.development.pre',
      '.env.development.pre.local',
      '.env.development',
      '.env.development.local',
    ];
    expect((JSON.parse(result.stdout) as { envFiles: unknown }).envFiles).toEqual({
      workspace: files,
      service: files,
    });
  });
});

describe('resolveEnv()', () => {
  type IndexModule = typeof import('../index.js');
  /** The compiled module, so the CLI it runs is the one compiled beside it. */
  const load = () =>
    import(pathToFileURL(path.join(buildDir, 'index.js')).href) as Promise<IndexModule>;

  test('returns the environment stackctl starts the service with', async () => {
    const { resolveEnv } = await load();
    const { env, files } = resolveEnv({ workspaceDir: ws, target: 'portonly' });
    expect(env).toMatchObject({
      PRE_URL: 'x:21010',
      ROOT_DIR: ws,
      PORT: '21051',
      PUBLIC_ORIGIN: 'http://localhost:21051',
      STACKCTL_PROFILE: 'development',
      STACKCTL_WORKSPACE_DIR: ws,
    });
    expect(files).toContain(path.join(ws, '.env.development.pre.local'));
    // Every variable, as the service's own command sees it.
    const printEnv = ['node', '-e', 'process.stdout.write(JSON.stringify(process.env))'];
    const result = await stackctl(['exec', 'portonly', '--', ...printEnv]);
    const real = JSON.parse(result.stdout) as Record<string, string>;
    // STACKCTL_CWD is where stackctl was invoked: here, not the workspace the CLI ran in.
    const { STACKCTL_CWD: calledFrom, ...rest } = env;
    expect(calledFrom).toBe(process.cwd());
    expect(Object.fromEntries(Object.keys(rest).map((name) => [name, real[name]]))).toEqual(rest);
  });

  test("a command stackctl runs gets the profile, and not where stackctl's came from", async () => {
    const printEnv = ['node', '-e', 'process.stdout.write(JSON.stringify(process.env))'];
    const result = await stackctl([
      '--profile',
      'development',
      'exec',
      'portonly',
      '--',
      ...printEnv,
    ]);
    const env = JSON.parse(result.stdout) as Record<string, string>;
    expect(env.STACKCTL_PROFILE).toBe('development');
    expect(Object.keys(env).filter((name) => name.startsWith('STACKCTL_PROFILE'))).toEqual(['STACKCTL_PROFILE']); // oxfmt-ignore
  });

  test("resolves for the profile asked for, whatever this process's", async () => {
    const { resolveEnv } = await load();
    const { env, files } = resolveEnv({ workspaceDir: ws, profile: 'test' });
    expect(env.PRE_URL).toBe('t:21100');
    expect(env.STACKCTL_PROFILE).toBe('test');
    expect(files).toEqual([path.join(ws, '.env.test.pre'), path.join(ws, '.env.test')]);
  });

  test('finds the service from a directory target, as exec finds it', async () => {
    const { resolveEnv } = await load();
    const { env, packageNames } = resolveEnv({ workspaceDir: ws, target: 'packages/app' });
    expect(env).toMatchObject({ APP_VAR: 'from-app-env-file', PRE_URL: 'x:21010' });
    expect(packageNames.has('APP_VAR')).toBe(true);
  });

  test("throws what stackctl said when it can't resolve", async () => {
    const { resolveEnv } = await load();
    expect(() => resolveEnv({ workspaceDir: ws, target: 'nope' })).toThrow(
      /^"nope" is neither a service nor a directory in this workspace/,
    );
  });
});

describe('finding the workspace', () => {
  /** A directory with no stackctl config in it or above it. */
  let empty: string;
  beforeAll(() => {
    empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-noconfig-')));
  });
  afterAll(() => {
    fs.rmSync(empty, { recursive: true, force: true });
  });

  test.each([
    [['exec', '--', 'true']],
    [['run', 'x']],
    [['logs']],
    [['show-config']],
    [['infra', 'start']],
    [['stop']],
    [['reset']],
    [['start', '--headless', '-s', 'a']],
    [['--headless', '-s', 'a']],
  ])('%j fails without a config', async (args) => {
    const result = await stackctl(args, { cwd: empty });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(`No stackctl.config.ts in ${empty} or any directory above it`);
    expect(fs.readdirSync(empty)).toEqual([]);
  });

  test('init, --help and --version work without a config', async () => {
    const version = await stackctl(['--version'], { cwd: empty });
    expect(version.exitCode).toBe(0);
    const { version: expected } = JSON.parse(
      fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
    ) as { version: string };
    expect(version.stdout).toBe(expected);
    expect((await stackctl(['--help'], { cwd: empty })).exitCode).toBe(0);
    expect((await stackctl(['show-config', '--help'], { cwd: empty })).exitCode).toBe(0);
    // The compiled copy looks for the rules file's text and the skill beside its own
    // directory's parent.
    const beside = ['assets', 'skills'].map((dir) => path.join(buildDir, '..', dir));
    for (const dir of beside) {
      fs.cpSync(path.join(packageDir, path.basename(dir)), dir, { recursive: true });
    }
    const init = await stackctl(['init', '-y'], { cwd: empty }).finally(() => {
      for (const dir of beside) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    expect(init.exitCode).toBe(0);
    expect(fs.existsSync(path.join(empty, 'stackctl.config.ts'))).toBe(true);
  });

  test('--workspace-dir names the directory exactly, from anywhere', async () => {
    const result = await stackctl(['show-config', '--workspace-dir', ws], { cwd: '/' });
    expect(result.exitCode).toBe(0);
    const before = await stackctl(['--workspace-dir', ws, 'show-config'], { cwd: '/' });
    expect(before.exitCode).toBe(0);
    const nested = await stackctl(['show-config', '--workspace-dir', app], { cwd: ws });
    expect(nested.exitCode).toBe(1);
    expect(nested.stderr).toBe(`No stackctl.config.ts in ${app}`);
  });

  test('--workspace-dir without a value fails with a message, init included', async () => {
    const show = await stackctl(['show-config', '--workspace-dir='], { cwd: empty });
    expect(show.exitCode).toBe(1);
    expect(show.stderr).toBe('--workspace-dir needs a directory');
    const init = await stackctl(['init', '--workspace-dir'], { cwd: empty });
    expect(init.exitCode).toBe(1);
    expect(init.stderr).toContain('--workspace-dir');
    expect(init.stderr).not.toContain('    at ');
  });

  test('a relative --workspace-dir resolves against the invocation directory', async () => {
    const result = await stackctl(['show-config', '--workspace-dir', path.basename(ws)], {
      cwd: path.dirname(ws),
    });
    expect(result.exitCode).toBe(0);
  });

  test('relative config paths resolve against the config directory', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-rel-')));
    try {
      fs.mkdirSync(path.join(root, 'apps', 'web', 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'stackctl.config.ts'),
        "import { defineConfig } from 'stackctl';\nexport default defineConfig({ serviceRootDir: 'apps', services: { web: {} } });\n",
      );
      const standIn = path.join(root, 'node_modules', 'stackctl');
      fs.mkdirSync(standIn, { recursive: true });
      fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
      fs.symlinkSync(buildDir, path.join(standIn, 'dist'));
      const result = await stackctl(['show-config'], {
        cwd: path.join(root, 'apps', 'web', 'src'),
      });
      expect(result.exitCode).toBe(0);
      const config = JSON.parse(result.stdout) as {
        services: Record<string, { absoluteDir: string }>;
      };
      expect(config.services.web?.absoluteDir).toBe(path.join(root, 'apps', 'web'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('stackctl cmd', () => {
  test('is not a subcommand', async () => {
    const result = await stackctl(['cmd', '-s', 'app', '--', 'echo', 'MAIN']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('MAIN');
  });
});

describe('removed flags are unknown options', () => {
  test.each([['--build'], ['--rebuild'], ['--phase', 'build'], ['--plain']])(
    '%s',
    async (...args) => {
      const result = await stackctl([...args, '-s', 'app']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(`error: unknown option '${args[0]!}'`);
    },
  );
});

describe('resolvedeps is an unknown command', () => {
  test('stackctl resolvedeps <service>', async () => {
    const result = await stackctl(['resolvedeps', 'app']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("error: unknown command 'resolvedeps'");
  });
});
