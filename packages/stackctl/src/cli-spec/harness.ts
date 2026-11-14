import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll } from 'vitest';
import { processStartTime } from '../process-info.js';
import { type Running, runCommand } from '../spawn.js';

/**
 * What the `cli-spec` files share. End-to-end: the real CLI, as a child process, against a
 * workspace on disk — the paths that have no seam to test in-process (`stackctl run`,
 * `stackctl exec`). The specs are several files so that Vitest runs them side by side: each
 * waits on processes far more than it computes.
 *
 * Each file calls {@link setUpCliWorkspace}, which compiles the CLI from the current source in
 * `beforeAll` rather than taking it from `dist/`, so no spec runs against a stale build. It is
 * emitted under the package's own `node_modules`, in a directory of the file's own, so files
 * running at once never replace each other's build: its imports then resolve the package's
 * dependencies, and the output stays out of git and the linter. The workspace reaches that same
 * build as `stackctl` through a stand-in package directory, so its config registers with the
 * module instance the CLI runs.
 */
export const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The calling file's build of the CLI, set by {@link setUpCliWorkspace}. */
export let buildDir: string;
export let cli: string;

/**
 * Starts `command` as these specs run one: this process's environment under `env`, and its output
 * without the newline it printed last, to compare whole.
 */
export function start(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {},
): Running {
  const child = runCommand(command, args, { ...opts, env: { ...process.env, ...opts.env } });
  const trim = (text: string) => text.replace(/\r?\n$/, '');
  const done = child.done.then((end) => ({ ...end, stdout: trim(end.stdout), stderr: trim(end.stderr) })); // oxfmt-ignore
  return Object.assign(child, { done });
}

/**
 * `pid`'s parent pid, or `null` once it's gone. A cleanup that knows a process only by its pid
 * checks it first, so that it only ever signals a process the test's own process started.
 */
export function parentPid(pid: number): number | null {
  const { stdout, status } = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }); // oxfmt-ignore
  const ppid = Number.parseInt(stdout.trim(), 10);
  return status === 0 && ppid > 0 ? ppid : null;
}

/** A process a test started, known by its pid and the start time read while it surely was it. */
export interface Owned {
  pid: number;
  startedAt: number;
}

/** `pid` as {@link Owned}, read now; `null` when its start time can't be read. */
export async function own(pid: number): Promise<Owned | null> {
  const startedAt = await processStartTime(pid);
  return startedAt === null ? null : { pid, startedAt };
}

/** SIGKILLs `owned`, only while its pid is still that process: the same start time. */
export async function killOwned({ pid, startedAt }: Owned): Promise<void> {
  if (pid > 0 && (await processStartTime(pid)) === startedAt) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

export let ws: string;
export let app: string;
export let traceHook: string;

/**
 * A preload that records every module the process loads and writes the URLs to `$TRACE_OUT` as
 * it exits — how the specs below check that a command loads only what it runs.
 */
export const TRACE_HOOK = `
import { registerHooks } from 'node:module';
import fs from 'node:fs';
export const urls = [];
registerHooks({
  load(url, context, nextLoad) {
    urls.push(url);
    return nextLoad(url, context);
  },
});
process.on('exit', () => fs.writeFileSync(process.env.TRACE_OUT, JSON.stringify(urls)));
`;

/** What a traced run loaded: the third-party packages by name, and whether the config ran. */
export function readTrace(file: string): { packages: Set<string>; evaluatedConfig: boolean } {
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

export let traces = 0;
export const nextTraceFile = () => path.join(ws, `trace-${String(traces++)}.json`);

/** Runs the CLI to its exit like {@link stackctl}, also resolving with what it loaded. */
export async function traced(args: string[], opts: { cwd?: string } = {}) {
  const out = nextTraceFile();
  const result = await start('node', ['--import', traceHook, cli, ...args], {
    cwd: opts.cwd ?? ws,
    env: { TRACE_OUT: out },
  }).done;
  return { result, ...readTrace(out) };
}

/**
 * Starts a `--headless` session, stops it once `until` has been printed (a package having started,
 * unless told otherwise), and resolves with its output and what it loaded.
 */
export async function tracedPlainSession(names: string[], until = '] started') {
  const out = nextTraceFile();
  const child = start(
    'node',
    ['--import', traceHook, cli, '--headless', ...names.flatMap((name) => ['-s', name])],
    { cwd: ws, env: { TRACE_OUT: out } },
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
  const result = await child.done;
  if (!fs.existsSync(out)) {
    throw new Error(
      `the session wrote no trace (exit ${String(result.exitCode)}, signal ${String(result.signal)}):\n${output}\n${String(result.stderr)}`,
    );
  }
  return { output, ...readTrace(out) };
}

export const script = (js: string) => `node --input-type=module -e "${js}"`;

/** An executable in `<dir>/node_modules/.bin` that prints `<name>-OK`. */
export function fakeBin(dir: string, name: string): void {
  const bin = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name}-OK\n`, { mode: 0o755 });
}

export function writePackage(name: string, scripts: Record<string, string>): string {
  const dir = path.join(ws, 'packages', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '2.0.0', scripts }),
  );
  return dir;
}

/** Runs the CLI in `cwd` (the workspace root unless given) and resolves with how it ended. */
export function stackctl(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
) {
  return start('node', [cli, ...args], { cwd: opts.cwd ?? ws, env: opts.env }).done;
}

export const lastLine = (text: string) => text.trim().split('\n').at(-1)!;

/**
 * Compiles the CLI into a directory named for the calling file, and lays out the workspace the
 * specs run it in (`ws`), before the file's tests; removes both after them.
 */
export function setUpCliWorkspace(name: string): void {
  beforeAll(async () => {
    buildDir = path.join(packageDir, 'node_modules', '.cache', `cli-spec-${name}`);
    cli = path.join(buildDir, 'cli.js');
    // TypeScript 7 exports no `bin/tsc`, so it's found next to the package.json it does export.
    const tsPackage = fileURLToPath(import.meta.resolve('typescript/package.json'));
    const tsc = path.join(path.dirname(tsPackage), 'bin', 'tsc');
    fs.rmSync(buildDir, { recursive: true, force: true });
    const build = await start(
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
    ).done;
    if (build.exitCode !== 0) {
      throw new Error(`the build failed:\n${build.stdout}${build.stderr}`);
    }

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
        '    additionalFiles: ({ profile }) => [',
        "      { file: `.env.${profile}.pre`, before: 'profile' },",
        "      { file: `.env.${profile}.pre.local`, before: 'profile' },",
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
    // `env.additionalFiles`: a port, read before the profile's file that derives a URL from it, and
    // a checkout's own port, read after the first.
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
      build: `${script('console.log(JSON.stringify([process.cwd(),process.env.STACKCTL_PROFILE,process.argv.slice(2)]))')} first`,
    });
    fs.mkdirSync(path.join(ws, 'scripts'));
    fs.writeFileSync(path.join(ws, 'scripts', '.env.development'), 'SCRIPTS_VAR=from-scripts\n');
  }, 120_000);

  afterAll(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(buildDir, { recursive: true, force: true });
  });
}
