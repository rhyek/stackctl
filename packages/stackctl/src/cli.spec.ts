import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execa, execaSync } from 'execa';
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { processStartTime } from './process-info.js';

/**
 * End-to-end: the real CLI, as a child process, against a workspace on disk — the paths that have
 * no seam to test in-process (`stackctl run`, `stackctl exec`).
 *
 * The CLI is compiled from the current source in `beforeAll` rather than taken from `dist/`, so
 * the spec never runs against a stale build. It is emitted under the package's own
 * `node_modules`: its imports then resolve the package's dependencies, and the output stays out
 * of git and the linter. The workspace reaches that same build as `stackctl` through a stand-in
 * package directory, so its config registers with the module instance the CLI runs.
 */
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(packageDir, 'node_modules', '.cache', 'cli-spec');
const cli = path.join(buildDir, 'cli.js');

/**
 * `pid`'s parent pid, or `null` once it's gone. A cleanup that knows a process only by its pid
 * checks it first, so that it only ever signals a process the test's own process started.
 */
function parentPid(pid: number): number | null {
  const { stdout, exitCode } = execaSync('ps', ['-o', 'ppid=', '-p', String(pid)], { reject: false }); // oxfmt-ignore
  const ppid = Number.parseInt(String(stdout).trim(), 10);
  return exitCode === 0 && ppid > 0 ? ppid : null;
}

/** A process a test started, known by its pid and the start time read while it surely was it. */
interface Owned {
  pid: number;
  startedAt: number;
}

/** `pid` as {@link Owned}, read now; `null` when its start time can't be read. */
async function own(pid: number): Promise<Owned | null> {
  const startedAt = await processStartTime(pid);
  return startedAt === null ? null : { pid, startedAt };
}

/** SIGKILLs `owned`, only while its pid is still that process: the same start time. */
async function killOwned({ pid, startedAt }: Owned): Promise<void> {
  if (pid > 0 && (await processStartTime(pid)) === startedAt) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

let ws: string;
let app: string;
let traceHook: string;

/**
 * A preload that records every module the process loads and writes the URLs to `$TRACE_OUT` as
 * it exits — how the specs below check that a command loads only what it runs.
 */
const TRACE_HOOK = `
import { registerHooks } from 'node:module';
import fs from 'node:fs';
const urls = [];
registerHooks({
  load(url, context, nextLoad) {
    urls.push(url);
    return nextLoad(url, context);
  },
});
process.on('exit', () => fs.writeFileSync(process.env.TRACE_OUT, JSON.stringify(urls)));
`;

/** What a traced run loaded: the third-party packages by name, and whether the config ran. */
function readTrace(file: string): { packages: Set<string>; evaluatedConfig: boolean } {
  const urls = JSON.parse(fs.readFileSync(file, 'utf8')) as string[];
  const packages = new Set<string>();
  for (const url of urls) {
    const name = /.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(url)?.[1];
    if (name !== undefined && name !== 'stackctl') {
      packages.add(name);
    }
  }
  return { packages, evaluatedConfig: urls.some((url) => url.endsWith('/stackctl.config.ts')) };
}

let traces = 0;
const nextTraceFile = () => path.join(ws, `trace-${String(traces++)}.json`);

/** Runs the CLI to its exit like {@link stackctl}, also resolving with what it loaded. */
async function traced(args: string[], opts: { cwd?: string } = {}) {
  const out = nextTraceFile();
  const result = await execa('node', ['--import', traceHook, cli, ...args], {
    cwd: opts.cwd ?? ws,
    env: { TRACE_OUT: out },
    reject: false,
  });
  return { result, ...readTrace(out) };
}

/**
 * Starts a `--headless` session, stops it once `until` has been printed (a package having started,
 * unless told otherwise), and resolves with its output and what it loaded.
 */
async function tracedPlainSession(names: string[], until = '] started') {
  const out = nextTraceFile();
  const child = execa(
    'node',
    ['--import', traceHook, cli, '--headless', ...names.flatMap((name) => ['-s', name])],
    { cwd: ws, env: { TRACE_OUT: out }, reject: false },
  );
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
  child.kill('SIGINT');
  const result = await child;
  if (!fs.existsSync(out)) {
    throw new Error(
      `the session wrote no trace (exit ${String(result.exitCode)}, signal ${String(result.signal)}):\n${output}\n${String(result.stderr)}`,
    );
  }
  return { output, ...readTrace(out) };
}

const script = (js: string) => `node --input-type=module -e "${js}"`;

/** An executable in `<dir>/node_modules/.bin` that prints `<name>-OK`. */
function fakeBin(dir: string, name: string): void {
  const bin = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name}-OK\n`, { mode: 0o755 });
}

function writePackage(name: string, scripts: Record<string, string>): string {
  const dir = path.join(ws, 'packages', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '2.0.0', scripts }),
  );
  return dir;
}

/** Runs the CLI in `cwd` (the workspace root unless given) and resolves with how it ended. */
function stackctl(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  return execa('node', [cli, ...args], {
    cwd: opts.cwd ?? ws,
    env: opts.env,
    reject: false,
  });
}

const lastLine = (text: string) => text.trim().split('\n').at(-1)!;

beforeAll(async () => {
  // TypeScript 7 exports no `bin/tsc`, so it's found next to the package.json it does export.
  const tsPackage = fileURLToPath(import.meta.resolve('typescript/package.json'));
  const tsc = path.join(path.dirname(tsPackage), 'bin', 'tsc');
  fs.rmSync(buildDir, { recursive: true, force: true });
  await execa(
    'node',
    [tsc, '-p', path.join(packageDir, 'tsconfig.build.json'), '--outDir', buildDir],
    { cwd: packageDir },
  );

  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-cli-')));
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'wsroot', type: 'module' })); // oxfmt-ignore
  fs.writeFileSync(path.join(ws, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  fs.writeFileSync(
    path.join(ws, 'stackctl.config.ts'),
    [
      "import { defineConfig } from 'stackctl';",
      'export default defineConfig({',
      "  serviceRootDir: 'packages',",
      '  env: {',
      '    vars: ({ envs }) => ({',
      '      ROOT_DIR: envs.STACKCTL_WORKSPACE_DIR,',
      "      APP_PINNED: 'from-config',",
      "      SHELL_SET: 'from-config',",
      "      PINNED_DIR: '/from/config',",
      '    }),',
      "    override: ['PINNED_DIR', 'APPENDED'],",
      '    additionalFiles: ({ mode }) => [',
      "      { file: `.env.${mode}.pre`, before: 'mode' },",
      "      { file: `.env.${mode}.pre.local`, before: 'mode' },",
      '    ],',
      '  },',
      '  services: {',
      '    lib: {},',
      '    wide: {},',
      '    app: {},',
      '    broken: {},',
      '    idle: {},',
      // Never healthy: nothing answers its healthcheck.
      "    slow: { healthcheck: 'http://127.0.0.1:9/' },",
      // Never started on its own, picked or not.
      '    manual: { autostart: false },',
      '    portonly: { port: 21051 },',
      '    api: { port: 21053 },',
      '  },',
      '});',
      '',
    ].join('\n'),
  );

  const standIn = path.join(ws, 'node_modules', 'stackctl');
  fs.mkdirSync(standIn, { recursive: true });
  fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
  fs.symlinkSync(buildDir, path.join(standIn, 'dist'));

  traceHook = path.join(ws, 'trace-hook.mjs');
  fs.writeFileSync(traceHook, TRACE_HOOK);

  fakeBin(ws, 'rootbin');
  writePackage('lib', { dev: 'true' });
  app = writePackage('app', {
    dev: 'true',
    argv: `${script('console.log(JSON.stringify(process.argv.slice(1)))')} x`,
    fail: 'exit 7',
    kill: script("process.kill(process.pid,'SIGKILL')"),
    cwd: script('console.log(process.cwd())'),
    env: script('console.log(process.env.APP_VAR)'),
    rootdir: script('console.log(process.env.ROOT_DIR)'),
    appended: script('console.log(process.env.APPENDED)'),
    preurl: script('console.log(process.env.PRE_URL)'),
    // A stackctl started from inside one: the script runs `stackctl exec` for `wide`.
    nested: `node "$NESTED_CLI" exec wide -- ${script("console.log(String(process.env.APP_VAR)+'|'+String(process.env.FROM_SHELL))")}`,
    whoami: script(
      "console.log(process.env.npm_package_name+' '+process.env.npm_package_version+' '+process.env.npm_lifecycle_event)",
    ),
    bins: 'localbin && rootbin',
    prehook: 'echo PRE',
    hook: 'echo MAIN',
    posthook: 'echo POST',
  });
  fakeBin(app, 'localbin');
  fs.writeFileSync(
    path.join(app, '.env.development'),
    'APP_VAR=from-app-env-file\nAPP_PINNED=from-app-env-file\nAPP_DATA=${STACKCTL_WORKSPACE_DIR}/data\nAPP_ROOT_REF=${ROOT_DIR}/ref\n',
  );
  fs.writeFileSync(
    path.join(ws, '.env.development'),
    'DERIVED_DIR=$PINNED_DIR/storage\nAPPENDED="$APPENDED --flag"\nPRE_URL=x:${PRE_PORT}\n',
  );
  // `env.additionalFiles`: a port, read before the mode's file that derives a URL from it, and a
  // checkout's own port, read after the first.
  fs.writeFileSync(path.join(ws, '.env.development.pre'), 'PRE_PORT=21000\n');
  fs.writeFileSync(path.join(ws, '.env.development.pre.local'), 'PRE_PORT=21010\n');
  fs.writeFileSync(path.join(ws, '.env.test.pre'), 'PRE_PORT=21100\n');
  fs.writeFileSync(path.join(ws, '.env.test'), 'PRE_URL=t:${PRE_PORT}\n');
  writePackage('broken', { dev: 'true', build: 'exit 3' });
  // Prints a line wider than any terminal and one with glyphs that are not one column each.
  writePackage('wide', {
    dev: script(
      "console.log('x'.repeat(150));console.log('glyphs \\u2713 \\u4e2d\\u6587 done');setInterval(()=>{},1e9)",
    ),
  });
  writePackage('idle', { dev: script('setInterval(()=>{},1e9)') });
  writePackage('slow', { dev: script('setInterval(()=>{},1e9)') });
  writePackage('manual', { dev: script('setInterval(()=>{},1e9)') });
  // A port, and no process: an origin to report.
  writePackage('portonly', {});
  // A target with a port, and a directory inside no service with an .env file of its own.
  writePackage('api', {
    // A first argument of its own, so node takes the ones forwarded after it as the script's.
    build: `${script('console.log(JSON.stringify([process.cwd(),process.env.STACKCTL_MODE,process.argv.slice(2)]))')} first`,
  });
  fs.mkdirSync(path.join(ws, 'scripts'));
  fs.writeFileSync(path.join(ws, 'scripts', '.env.development'), 'SCRIPTS_VAR=from-scripts\n');
}, 120_000);

afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(buildDir, { recursive: true, force: true });
});

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

describe('exec and run take a target', () => {
  const api = () => path.join(ws, 'packages', 'api');
  /** What api's `build` printed: its directory, the mode, and its arguments. */
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

  test("run api build --mode test: the mode is stackctl's", async () => {
    const result = await stackctl(['run', 'api', 'build', '--mode', 'test']);
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

  test("loads the files the callback names for the mode's", async () => {
    const result = await stackctl(['exec', '--mode', 'test', '--', ...print('PRE_URL')]);
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
  type IndexModule = typeof import('./index.js');
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
      STACKCTL_MODE: 'development',
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

  test("a command stackctl runs gets the mode, and not where stackctl's came from", async () => {
    const printEnv = ['node', '-e', 'process.stdout.write(JSON.stringify(process.env))'];
    const result = await stackctl(['--mode', 'development', 'exec', 'portonly', '--', ...printEnv]);
    const env = JSON.parse(result.stdout) as Record<string, string>;
    expect(env.STACKCTL_MODE).toBe('development');
    expect(Object.keys(env).filter((name) => name.startsWith('STACKCTL_MODE'))).toEqual(['STACKCTL_MODE']); // oxfmt-ignore
  });

  test("resolves for the mode asked for, whatever this process's", async () => {
    const { resolveEnv } = await load();
    const { env, files } = resolveEnv({ workspaceDir: ws, mode: 'test' });
    expect(env.PRE_URL).toBe('t:21100');
    expect(env.STACKCTL_MODE).toBe('test');
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
    [['infra', 'up']],
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
    // The compiled copy looks for the skill's asset beside its own directory's parent.
    const assets = path.join(buildDir, '..', 'assets');
    fs.cpSync(path.join(packageDir, 'assets'), assets, { recursive: true });
    const init = await stackctl(['init', '-y'], { cwd: empty }).finally(() =>
      fs.rmSync(assets, { recursive: true, force: true }),
    );
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

/**
 * A workspace of its own, with `web` and `worker` (each idle once started), for the specs that
 * start sessions and read what they leave behind: the shared one's state is other specs' too.
 */
describe('sessions', () => {
  let sws: string;
  const stateDir = () => path.join(sws, 'node_modules', '.stackctl');
  const recordOf = (mode: string) => path.join(stateDir(), 'modes', mode, 'running.json');
  /** The modes with a session record, as `<mode>/running.json`. */
  const records = () =>
    fs.existsSync(path.join(stateDir(), 'modes'))
      ? fs
          .readdirSync(path.join(stateDir(), 'modes'))
          .filter((mode) => fs.existsSync(recordOf(mode)))
          .map((mode) => `${mode}/running.json`)
      : [];

  beforeAll(() => {
    sws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-cli-sessions-')));
    fs.writeFileSync(path.join(sws, 'package.json'), JSON.stringify({ name: 'sessionsroot', type: 'module' })); // oxfmt-ignore
    fs.writeFileSync(path.join(sws, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    fs.writeFileSync(
      path.join(sws, 'stackctl.config.ts'),
      "import { defineConfig } from 'stackctl';\nexport default defineConfig({ serviceRootDir: 'packages', services: { web: {}, worker: {} } });\n",
    );
    const standIn = path.join(sws, 'node_modules', 'stackctl');
    fs.mkdirSync(standIn, { recursive: true });
    fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
    fs.symlinkSync(buildDir, path.join(standIn, 'dist'));
    for (const name of ['web', 'worker']) {
      const dir = path.join(sws, 'packages', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name, scripts: { dev: script('setInterval(()=>{},1e9)') } }),
      );
    }
  });

  afterAll(() => {
    fs.rmSync(sws, { recursive: true, force: true });
  });

  /** Sessions a test started, ended after it whatever happened; and the ones that have exited. */
  const started: ReturnType<typeof execa>[] = [];
  const ended = new WeakSet<ReturnType<typeof execa>>();
  afterEach(async () => {
    for (const child of started.splice(0)) {
      await endSession(child);
    }
  });

  /**
   * Ends a session: SIGTERM, then — should it not exit — SIGKILL, and the process groups of the
   * services its record names, which a SIGKILLed session leaves running. Only ever its own pid,
   * and the groups it recorded whose leader is still its child: never 0 or below, which would
   * signal whole groups.
   */
  async function endSession(child: ReturnType<typeof execa>): Promise<void> {
    if (ended.has(child) || !(child.pid! > 0)) {
      await child;
      return;
    }
    const exited = child.then(() => true);
    child.kill('SIGTERM');
    if (
      await Promise.race([exited, new Promise<false>((r) => setTimeout(() => r(false), 15_000))])
    ) {
      return;
    }
    for (const name of records()) {
      try {
        const record = JSON.parse(
          fs.readFileSync(path.join(stateDir(), 'modes', name), 'utf8'),
        ) as {
          pid: number;
          children?: { pid: number }[];
        };
        if (record.pid !== child.pid) {
          continue;
        }
        for (const { pid } of record.children ?? []) {
          if (pid > 0 && parentPid(pid) === child.pid) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              /* gone */
            }
          }
        }
      } catch {
        /* not readable */
      }
    }
    child.kill('SIGKILL');
    await child;
  }

  /**
   * Starts a session with `args` in the workspace and resolves, with its subprocess, once `until`
   * has been printed.
   */
  async function startSession(args: string[], until: string) {
    const child = execa('node', [cli, ...args], { cwd: sws, reject: false });
    started.push(child);
    void child.then(() => ended.add(child));
    let output = '';
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
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
      void child.then(() => {
        clearTimeout(giveUp);
        reject(new Error(`exited before printing ${until}:\n${output}`));
      });
    });
    // Wrapped: the subprocess is a thenable, which an async function would wait out.
    return { child };
  }

  /** The session started by `args`, ended once it printed `until`. */
  async function runSession(args: string[], until: string): Promise<void> {
    const { child } = await startSession(args, until);
    await endSession(child);
  }

  describe('start is the default command', () => {
    test.each([
      ['stackctl --headless -s web', ['--headless', '-s', 'web']],
      ['stackctl start --headless -s web', ['start', '--headless', '-s', 'web']],
    ])(
      '%s starts a headless session of web',
      async (_, args) => {
        const { child } = await startSession(args, '[web] started');
        expect(JSON.parse(fs.readFileSync(recordOf('development'), 'utf8'))).toMatchObject({ pid: child.pid }); // oxfmt-ignore
        await endSession(child);
      },
      30_000,
    );

    test.each([
      ['before start', ['--mode', 'test', 'start', '--headless', '-s', 'web']],
      ['after start', ['start', '--mode', 'test', '--headless', '-s', 'web']],
      ['with no start typed', ['--headless', '--mode', 'test', '-s', 'web']],
    ])(
      '--mode %s runs the session in that mode',
      async (_, args) => {
        const { child } = await startSession(args, '[web] started');
        expect(records()).toEqual(['test/running.json']);
        expect(JSON.parse(fs.readFileSync(recordOf('test'), 'utf8'))).toMatchObject({ pid: child.pid }); // oxfmt-ignore
        await endSession(child);
      },
      30_000,
    );

    test.each([
      [
        ['-s', 'web', 'exec', '--', 'true'],
        'exec takes the service or directory as its first argument: stackctl exec api -- <command>',
      ],
      [
        ['-s', 'web', 'run', 'build'],
        'run takes the service or directory as its first argument: stackctl run api <script>',
      ],
      [
        ['start', '-s', 'web', 'exec', '--', 'true'],
        'exec takes the service or directory as its first argument: stackctl exec api -- <command>',
      ],
    ])(
      'stackctl %j fails, saying where the service goes, and starts no session',
      async (args, message) => {
        const result = await execa('node', [cli, ...args], { cwd: sws, reject: false });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toBe(message);
        expect(result.stdout).not.toContain('started');
        expect(records()).toEqual([]);
      },
    );

    test('start takes no other arguments', async () => {
      const result = await execa('node', [cli, 'start', 'web'], { cwd: sws, reject: false });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("error: too many arguments for 'start'");
      expect(records()).toEqual([]);
    });
  });

  describe("headless -s doesn't touch the saved selection", () => {
    const selectionFile = () => path.join(stateDir(), 'modes', 'development', 'selection.json');
    /** Saves `["worker"]` as the selection, dated an hour back so a rewrite shows. */
    const saveWorker = () => {
      fs.mkdirSync(path.dirname(selectionFile()), { recursive: true });
      fs.writeFileSync(selectionFile(), JSON.stringify(['worker']));
      const past = new Date(Date.now() - 3_600_000);
      fs.utimesSync(selectionFile(), past, past);
      return fs.statSync(selectionFile()).mtimeMs;
    };

    test('a session of -s web leaves it as it was', async () => {
      const mtime = saveWorker();
      await runSession(['--headless', '-s', 'web'], '[web] started');
      expect(JSON.parse(fs.readFileSync(selectionFile(), 'utf8'))).toEqual(['worker']);
      expect(fs.statSync(selectionFile()).mtimeMs).toBe(mtime);
    }, 30_000);

    test('a session of --last-answers runs it, and leaves it as it was', async () => {
      const mtime = saveWorker();
      await runSession(['--headless', '--last-answers'], '[worker] started');
      expect(JSON.parse(fs.readFileSync(selectionFile(), 'utf8'))).toEqual(['worker']);
      expect(fs.statSync(selectionFile()).mtimeMs).toBe(mtime);
    }, 30_000);
  });
});

describe('startStack()', () => {
  type StackModule = typeof import('./stack.js');
  /** The compiled module, so the CLI it runs is the one compiled beside it. */
  const load = () => import(pathToFileURL(path.join(buildDir, 'stack.js')).href) as Promise<StackModule>; // oxfmt-ignore
  // Its own log directory: the logfiles here would otherwise be the newest the `logs` tests find.
  const logDir = () => path.join(ws, 'stack-logs');
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
  const helpers: ReturnType<typeof execa>[] = [];
  const exited = new WeakSet<ReturnType<typeof execa>>();
  const track = (child: ReturnType<typeof execa>) => {
    helpers.push(child);
    void child.then(() => exited.add(child));
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
      await child;
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

  const startStack = async (services: string[], extra: { killOthers?: boolean } = {}) => {
    const { startStack, stackEnvironment } = await load();
    const stack = await startStack({
      services,
      workspaceDir: ws,
      logDir: logDir(),
      env: stackEnvironment(),
      ...extra,
    });
    stacks.push(stack);
    // Forked by this process.
    await keep(stack.pid, process.pid);
    return stack;
  };

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
      /broken stopped while starting.*\(log: .*\.log\)/,
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
  logDir: process.argv[4],
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
      const parent = execa(
        'node',
        [helper, pathToFileURL(path.join(buildDir, 'stack.js')).href, ws, logDir()],
        { cwd: ws, reject: false },
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
      await parent;
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
    const child = execa('node', [cli, '--headless', '-s', 'idle', '--log-dir', logDir()], {
      cwd: ws,
      reject: false,
    });
    track(child);
    expect(await until(() => fs.existsSync(record()))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(alive(child.pid!)).toBe(true);
    child.kill('SIGTERM');
    await child;
    expect(fs.existsSync(record())).toBe(false);
  }, 60_000);
});

describe.skipIf(process.platform === 'win32')(
  'a session an .env file of which cannot be read yet',
  () => {
    // macOS holds a read of a File Provider folder (Dropbox, iCloud) until the user answers its
    // prompt to allow access, which can be hours. A FIFO stands in: opening one blocks until a writer
    // opens it, and none does here. Each test has a workspace of its own, so no other session reads
    // its FIFO.
    const made: {
      dir: string;
      fifo: string;
      session?: ReturnType<typeof execa>;
      ended: boolean;
    }[] = [];

    /** A workspace with one service, `idle`, whose `fifoAt` (relative to its root) is a FIFO. */
    function blockedWorkspace(opts: { config: string; fifoAt: string }) {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-cli-blocked-')));
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'blockedroot', type: 'module' })); // oxfmt-ignore
      fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      fs.writeFileSync(
        path.join(dir, 'stackctl.config.ts'),
        `import { defineConfig } from 'stackctl';\nexport default defineConfig(${opts.config});\n`,
      );
      const standIn = path.join(dir, 'node_modules', 'stackctl');
      fs.mkdirSync(standIn, { recursive: true });
      fs.symlinkSync(path.join(packageDir, 'package.json'), path.join(standIn, 'package.json'));
      fs.symlinkSync(buildDir, path.join(standIn, 'dist'));
      const idle = path.join(dir, 'packages', 'idle');
      fs.mkdirSync(idle, { recursive: true });
      fs.writeFileSync(
        path.join(idle, 'package.json'),
        JSON.stringify({ name: 'idle', scripts: { dev: script('setInterval(()=>{},1e9)') } }),
      );
      const fifo = path.join(dir, opts.fifoAt);
      execaSync('mkfifo', [fifo]);
      const entry: (typeof made)[number] = { dir, fifo, ended: false };
      made.push(entry);
      return entry;
    }

    /** Starts a `--headless` session of `idle` in `ws`, collecting its output. */
    function startSession(ws: (typeof made)[number]) {
      const session = execa('node', [cli, '--headless', '-s', 'idle'], {
        cwd: ws.dir,
        reject: false,
      });
      ws.session = session;
      void session.then(() => (ws.ended = true));
      const output = { text: '' };
      session.stdout!.on('data', (chunk: Buffer) => (output.text += chunk.toString()));
      session.stderr!.on('data', (chunk: Buffer) => (output.text += chunk.toString()));
      return { session, output };
    }

    /** Whether `session` ends within 10s of a SIGTERM. */
    async function endsOnSigterm(session: ReturnType<typeof execa>): Promise<boolean> {
      session.kill('SIGTERM');
      const ended = await Promise.race([
        session.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]);
      return ended;
    }

    /**
     * Whether a process has `fifo` open to read, a read blocked in opening it among them. Opening
     * it to write, which succeeds only then, lets that read go on: closed again at once, the file
     * reads as empty, and the reader goes on to exit.
     */
    const releaseReader = (fifo: string): boolean => {
      try {
        fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
        return true;
      } catch {
        return false; // ENXIO: no reader
      }
    };

    afterEach(async () => {
      for (const ws of made.splice(0)) {
        // A session stuck in the read itself only ever ends by SIGKILL, and one killed so leaves its
        // reader behind, blocked on the FIFO: released, it exits by itself, with no signal.
        if (ws.session !== undefined && !ws.ended) {
          ws.session.kill('SIGKILL');
        }
        await ws.session;
        const deadline = Date.now() + 5000;
        while (releaseReader(ws.fifo) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        fs.rmSync(ws.dir, { recursive: true, force: true });
      }
    });

    test("a service's: answers its control API while it waits, and stops on SIGTERM", async () => {
      // No `env` callback: loading the config reads no `.env` file of a service.
      const ws = blockedWorkspace({
        config: "{ serviceRootDir: 'packages', services: { idle: {} } }",
        fifoAt: 'packages/idle/.env.development',
      });
      const { session, output } = startSession(ws);

      const record = path.join(ws.dir, 'node_modules', '.stackctl', 'modes', 'development', 'running.json'); // oxfmt-ignore
      const status = async (): Promise<{
        services?: Record<string, string>;
        logFile?: string;
      } | null> => {
        try {
          const { port } = JSON.parse(fs.readFileSync(record, 'utf8')) as { port: number };
          const res = await fetch(`http://127.0.0.1:${String(port)}/query/status`, {
            signal: AbortSignal.timeout(1000),
          });
          return (await res.json()) as { services?: Record<string, string>; logFile?: string };
        } catch {
          return null;
        }
      };
      const until = async (done: () => Promise<boolean>, what: string) => {
        const deadline = Date.now() + 15_000;
        while (!(await done())) {
          if (Date.now() > deadline) {
            throw new Error(`${what}:\n${output.text}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      };

      // Its control API answers, its service under way, as `startStack()` counts it: not stopped.
      await until(
        async () => (await status())?.services !== undefined,
        'its control API never answered',
      );
      const { services, logFile } = (await status())!;
      expect(services).toEqual({ idle: 'waiting' });
      // The log names the file it waits on.
      await until(
        async () => fs.readFileSync(logFile!, 'utf8').includes(`waiting to read ${ws.fifo}`),
        'it never said what it waits on',
      );

      expect(await endsOnSigterm(session), `still running 10s after SIGTERM:\n${output.text}`).toBe(true); // oxfmt-ignore
      // Nothing is left waiting on the file. Checked once, after a moment for a killed reader to
      // close it: a check that finds one releases it, so a second would always pass.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(releaseReader(ws.fifo)).toBe(false);
    }, 40_000);

    // Loading the config reads its files on the event loop's thread, which only a signal with no
    // handler of the process's own can interrupt: so it must be done before any is installed.
    test("the workspace's, read by a config callback: stops on SIGTERM", async () => {
      const ws = blockedWorkspace({
        config:
        "{ serviceRootDir: 'packages', env: { vars: ({ envs }) => ({ HOME_DIR: envs.HOME ?? '' }) }, services: { idle: {} } }", // oxfmt-ignore
        fifoAt: '.env.development',
      });
      const { session, output } = startSession(ws);
      // Long enough to be well into loading the config, and blocked there: it never got as far as
      // recording a session.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(ws.ended, output.text).toBe(false);
      expect(fs.existsSync(path.join(ws.dir, 'node_modules', '.stackctl'))).toBe(false);
      expect(output.text).not.toContain('freeing dev ports');
      expect(await endsOnSigterm(session), `still running 10s after SIGTERM:\n${output.text}`).toBe(true); // oxfmt-ignore
    }, 40_000);
  },
);

describe('start --detach', () => {
  // Its own log directory: the logfiles here would otherwise be the newest the `logs` tests find.
  const logDir = () => path.join(ws, 'detach-logs');
  const recordOf = (mode: string) => path.join(ws, 'node_modules', '.stackctl', 'modes', mode, 'running.json'); // oxfmt-ignore
  /** Not an agent, whatever runs the suite: the refusal has a test of its own. */
  const human = { STACKCTL_STARTED_BY_AGENT: '0' };
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

  /** Sessions a test detached, by mode and pid: stopped after it, then killed should one still run. */
  const detached: (Owned & { mode: string })[] = [];
  const keep = async (mode: string, pid: number) => {
    const owned = await own(pid);
    if (owned) {
      detached.push({ ...owned, mode });
    }
  };
  afterEach(async () => {
    for (const session of detached.splice(0)) {
      await stackctl(['--mode', session.mode, 'stop']);
      await killOwned(session);
    }
  });

  /** The `<mode> session ready: pid <pid>, control API on <port>, log <logFile>` line, parsed. */
  const readyLine = (stdout: string) => {
    const match = /^(\S+) session ready: pid (\d+), control API on (\d+), log (.+)$/m.exec(stdout);
    expect(match, stdout).not.toBeNull();
    const [, mode, pid, port, logFile] = match!;
    return { mode: mode!, pid: Number(pid), port: Number(port), logFile: logFile! };
  };

  /** `stackctl <args> start --detach --log-dir … <rest>`. */
  const detach = (rest: string[], env: Record<string, string> = human, before: string[] = []) =>
    stackctl([...before, 'start', '--detach', '--log-dir', logDir(), ...rest], { env });

  test('returns once ready, and the session still answers after the command has exited', async () => {
    const result = await detach(['-s', 'idle']);
    expect(result.exitCode, result.stderr).toBe(0);
    const ready = readyLine(result.stdout);
    expect(ready.mode).toBe('development');
    await keep('development', ready.pid);
    // The command has exited; the session hasn't, and answers as itself.
    const status = (await (await fetch(`http://127.0.0.1:${String(ready.port)}/query/status`)).json()) as { pid: number; sessionReady: boolean; mode: string; modeSource: string }; // oxfmt-ignore
    expect(status).toMatchObject({ pid: ready.pid, sessionReady: true, mode: 'development', modeSource: 'default' }); // oxfmt-ignore
    expect(JSON.parse(fs.readFileSync(recordOf('development'), 'utf8'))).toMatchObject({ pid: ready.pid }); // oxfmt-ignore
    // Its log starts with the mode and where it came from.
    expect(fs.readFileSync(ready.logFile as string, 'utf8')).toContain('[stackctl] [INFO] mode development (default)'); // oxfmt-ignore

    // A session of the mode is running: another --detach fails, naming it.
    const again = await detach(['-s', 'idle']);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain(`a development session of this workspace is already running (pid ${String(ready.pid)})`); // oxfmt-ignore
    expect(alive(ready.pid)).toBe(true);

    const stopped = await stackctl(['--mode', 'development', 'stop']);
    expect(stopped.stdout).toBe(`stopped development session (pid ${String(ready.pid)})`);
    expect(alive(ready.pid)).toBe(false);
  }, 90_000);

  test('a $(…) capture returns, with the one line it prints', async () => {
    const result = await execa(
      'sh',
      ['-c', 'out=$(node "$0" --mode test start -d -s idle --log-dir "$1"); echo "$out"', cli, logDir()], // oxfmt-ignore
      { cwd: ws, env: human, reject: false, timeout: 60_000 },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const match = /^test session ready: pid (\d+), control API on (\d+), log (.+\.log)$/.exec(result.stdout); // oxfmt-ignore
    expect(match, result.stdout).not.toBeNull();
    await keep('test', Number(match![1]));
    expect(JSON.parse(fs.readFileSync(recordOf('test'), 'utf8'))).toMatchObject({ pid: Number(match![1]), port: Number(match![2]) }); // oxfmt-ignore
    expect(fs.readFileSync(match![3]!, 'utf8')).toContain('[stackctl] [INFO] mode test (from --mode)'); // oxfmt-ignore
  }, 90_000);

  test('a service that crashes on start: exit 1, the log tail, and nothing left', async () => {
    const result = await detach(['-s', 'broken']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/start --detach failed: broken stopped while starting/);
    expect(result.stderr).toMatch(/\nlog: .*\.log\n/);
    expect(result.stderr).toContain('[stackctl] [INFO] mode development (default)');
    expect(fs.existsSync(recordOf('development'))).toBe(false);
    expect((await stackctl(['--mode', 'development', 'stop'])).stdout).toBe('No development stackctl session is running.'); // oxfmt-ignore
  }, 90_000);

  test('a picked autostart: false service stays stopped, and the start succeeds', async () => {
    const result = await detach(['-s', 'idle', '-s', 'manual']);
    expect(result.exitCode, result.stderr).toBe(0);
    const ready = readyLine(result.stdout);
    await keep('development', ready.pid);
    const status = (await (await fetch(`http://127.0.0.1:${String(ready.port)}/query/status`)).json()) as { services: Record<string, string> }; // oxfmt-ignore
    expect(status.services).toMatchObject({ idle: 'running', manual: 'stopped' });
  }, 90_000);

  test('--wait-timeout 1 against a service never healthy: exit 1, and nothing left', async () => {
    const result = await detach(['-s', 'slow', '--wait-timeout', '1']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/start --detach failed: .*(not healthy after 1s: slow|didn't come up within 1s)/); // oxfmt-ignore
    expect(fs.existsSync(recordOf('development'))).toBe(false);
    expect((await stackctl(['--mode', 'development', 'stop'])).stdout).toBe('No development stackctl session is running.'); // oxfmt-ignore
  }, 90_000);

  test('SIGINT while waiting: exit 130, and nothing left', async () => {
    const child = execa('node', [cli, 'start', '--detach', '-s', 'slow', '--log-dir', logDir()], { cwd: ws, env: human, reject: false }); // oxfmt-ignore
    // Once the session is up, and waiting on slow.
    expect(await until(() => fs.existsSync(recordOf('development')), 30_000)).toBe(true);
    const { pid } = JSON.parse(fs.readFileSync(recordOf('development'), 'utf8')) as { pid: number };
    await keep('development', pid);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    child.kill('SIGINT');
    const result = await child;
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toMatch(/start --detach failed: interrupted/);
    expect(alive(pid)).toBe(false);
    expect(fs.existsSync(recordOf('development'))).toBe(false);
  }, 90_000);

  test('the command killed outright while it waits: the session quits with it', async () => {
    const child = execa('node', [cli, 'start', '--detach', '-s', 'slow', '--log-dir', logDir()], { cwd: ws, env: human, reject: false }); // oxfmt-ignore
    expect(await until(() => fs.existsSync(recordOf('development')), 30_000)).toBe(true);
    const { pid } = JSON.parse(fs.readFileSync(recordOf('development'), 'utf8')) as { pid: number };
    await keep('development', pid);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // No handler of the command's runs: only the closed channel tells the session.
    child.kill('SIGKILL');
    await child;
    expect(await until(() => !alive(pid), 30_000)).toBe(true);
    expect(fs.existsSync(recordOf('development'))).toBe(false);
  }, 90_000);

  test('is refused for a coding agent outside CI, and allowed in CI or with the override', async () => {
    const agent = { CLAUDECODE: '1', CI: '', STACKCTL_STARTED_BY_AGENT: '' };
    const refused = await detach(['-s', 'idle'], agent);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('start --detach is for CI');
    expect(refused.stderr).toContain('STACKCTL_STARTED_BY_AGENT=0');
    expect(fs.existsSync(recordOf('development'))).toBe(false);

    // In CI the mode is the CI default.
    const ci = await detach(['-s', 'idle'], { ...agent, CI: 'true' });
    expect(ci.exitCode, ci.stderr).toBe(0);
    const inCi = readyLine(ci.stdout);
    await keep('test', inCi.pid);
    expect(inCi.mode).toBe('test');
    const ciStatus = (await (await fetch(`http://127.0.0.1:${String(inCi.port)}/query/status`)).json()) as { modeSource: string }; // oxfmt-ignore
    expect(ciStatus.modeSource).toBe('ci');

    const overridden = await detach(['-s', 'idle'], { ...agent, STACKCTL_STARTED_BY_AGENT: '0' }); // oxfmt-ignore
    expect(overridden.exitCode, overridden.stderr).toBe(0);
    await keep('development', readyLine(overridden.stdout).pid);
  }, 90_000);

  test.each([
    [['-s', 'idle', '--ui'], "--ui and --detach can't be combined."],
    [[], '--detach needs services to start: pass --service or --last-answers.'],
  ])('%j is refused', async (rest, message) => {
    const result = await detach(rest);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(message);
  });
});

describe('what a command loads', () => {
  const HEAVY = ['zod', 'execa', '@dotenvx/primitives', 'pino', '@clack/prompts', 'typescript'];
  const SESSION_ONLY = ['pino', '@clack/prompts', 'jsonc-parser', 'typescript', 'ink', 'react'];

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

  test('logs --path finds the newest logfile without loading the config', async () => {
    await stackctl(['exec', 'app', '--', 'true']);
    const { result, packages, evaluatedConfig } = await traced(['logs', '--path'], { cwd: app });
    expect(result.stdout).toMatch(/node_modules\/\.stackctl\/modes\/development\/logs\/.+\.log$/);
    expect(result.exitCode).toBe(0);
    expect(evaluatedConfig).toBe(false);
    expectNotLoaded(packages, HEAVY);
  });

  test('logs prints that logfile', async () => {
    await stackctl(['exec', 'app', '--', 'echo', 'in-the-log']);
    const result = await stackctl(['logs']);
    expect(result.stdout).toContain('in-the-log');
    expect(result.exitCode).toBe(0);
  });

  test("reset removes the mode's state without evaluating the config", async () => {
    await stackctl(['exec', 'app', '--', 'true']);
    const { result, packages, evaluatedConfig } = await traced(['--mode', 'development', 'reset']);
    expect(result.stdout).toBe(
      'No development stackctl session is running.\nRemoved node_modules/.stackctl/modes/development/',
    );
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(ws, 'node_modules', '.stackctl', 'modes', 'development'))).toBe(false); // oxfmt-ignore
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
    expectNotLoaded(packages, ['execa', ...SESSION_ONLY]);
  });

  test('a --headless session loads no TUI, no prompt library and no TypeScript', async () => {
    const { output, packages } = await tracedPlainSession(['app']);
    expect(output).toMatch(/\[app\] started/);
    expectNotLoaded(packages, ['ink', 'react', '@clack/prompts', 'typescript']);
  }, 30_000);

  test('a --headless session still wraps a long line to the terminal width, gutter on every row', async () => {
    const { output, packages } = await tracedPlainSession(['wide'], 'done');
    const rows = output.split('\n').filter((line) => /\[wide\] x+$/.test(line));
    // Piped, the terminal is taken as 120 columns: a 20-column timestamp, `[wide] `, the text.
    expect(rows.map((row) => row.length)).toEqual([120, 84]);
    expect(rows.map((row) => /x+$/.exec(row)![0].length)).toEqual([93, 57]);
    expect(output).toMatch(/\[wide\] glyphs \u2713 \u4e2d\u6587 done/);
    expect(packages.has('string-width')).toBe(true);
  }, 30_000);

  test("no command loads the env parser's CLI tooling", async () => {
    const { packages } = await traced(['exec', 'app', '--', 'true']);
    expectNotLoaded(packages, ['@dotenvx/dotenvx', '@dotenvx/tooling']);
  });
});

describe('the stackctl process', () => {
  /**
   * Each program a CLI run loaded, in order — one, or two once it starts over: the pid, the
   * directory it started in and the Node.js flags it ran with, recorded by a preload as it starts.
   */
  async function programsOf(args: string[]) {
    const out = path.join(ws, `process-${String(traces++)}.jsonl`);
    const hook = path.join(ws, 'process-hook.mjs');
    fs.writeFileSync(
      hook,
      "import fs from 'node:fs';\nfs.appendFileSync(process.env.PROCESS_OUT, JSON.stringify({ pid: process.pid, cwd: process.cwd(), execArgv: process.execArgv }) + '\\n');\n",
    );
    const child = execa('node', ['--import', hook, cli, ...args], {
      cwd: app,
      env: { PROCESS_OUT: out },
      reject: false,
    });
    const result = await child;
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
  /** A workspace whose `api` runs `codegen` outside the `test` mode, and `gateway` in every mode. */
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
        "    api: { deps: ({ mode }) => (mode === 'test' ? ['gateway'] : ['codegen', 'gateway']) },",
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

  const depsIn = async (mode: string) => {
    const result = await stackctl(['show-config', '--mode', mode], { cwd: dws });
    expect(result.exitCode).toBe(0);
    return (JSON.parse(result.stdout) as { services: Record<string, { deps?: unknown }> }).services
      .api?.deps;
  };

  test('show-config prints the deps each mode resolves', async () => {
    expect(await depsIn('development')).toEqual([
      { service: 'codegen', wait: false },
      { service: 'gateway', wait: false },
    ]);
    expect(await depsIn('test')).toEqual([{ service: 'gateway', wait: false }]);
  });

  test('a test session does not start a dep only the development deps name', async () => {
    const session = execa('node', [cli, '--headless', '--mode', 'test', '-s', 'api'], {
      cwd: dws,
      reject: false,
    });
    try {
      const deadline = Date.now() + 20_000;
      while (!(fs.existsSync(marker('api')) && fs.existsSync(marker('gateway')))) {
        expect(Date.now(), 'api and gateway never started').toBeLessThan(deadline);
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      session.kill('SIGTERM');
      const exited = session.then(() => true);
      const timedOut = new Promise<false>((r) => setTimeout(() => r(false), 15_000));
      if (!(await Promise.race([exited, timedOut]))) {
        session.kill('SIGKILL');
      }
    }
    // The session has ended: every service it started logged a line when it did.
    const { stdout } = await session;
    expect(stdout).toContain('gateway: runtime dep of api');
    expect(stdout).toMatch(/\[api *\] started/);
    expect(stdout).not.toContain('codegen');
    expect(fs.existsSync(marker('codegen'))).toBe(false);
  });
});
