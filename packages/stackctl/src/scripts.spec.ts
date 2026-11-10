import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { AnyServiceConfig } from './config.js';
import {
  exitCodeOf,
  runnerOf,
  scriptExec,
  definesScript,
  definesDevScript,
  menuCommandsOf,
  makeTargetsOf,
} from './scripts.js';

let dir: string;
function pkg(over: Partial<AnyServiceConfig> & { absoluteDir: string }): AnyServiceConfig {
  return { name: 'x', relativeDir: 'x', ...over } as AnyServiceConfig;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-scripts-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { dev: 'x', build: 'x', 'build:clean': 'x', codegen: 'x' } }),
  );
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('runner detection', () => {
  test('runs a package.json script as its own text, through /bin/sh', () => {
    expect(runnerOf(pkg({ absoluteDir: dir }))).toBe('sh');
    expect(scriptExec(pkg({ absoluteDir: dir }), 'dev')).toMatchObject({
      cmd: '/bin/sh',
      args: ['-c', 'x'],
    });
  });
  test('hands extra args to the shell as positional parameters, appended to the script', () => {
    expect(scriptExec(pkg({ absoluteDir: dir }), 'build', ['--bank-key=x', 'foo'])).toMatchObject({
      cmd: '/bin/sh',
      args: ['-c', 'x "$@"', 'sh', '--bank-key=x', 'foo'],
    });
  });
  test('reads scripts', () => {
    expect(definesScript(pkg({ absoluteDir: dir }), 'build')).toBe(true);
    expect(definesDevScript(pkg({ absoluteDir: dir }))).toBe(true);
  });
  test('definesDevScript is false for `command: null` even when a dev script exists', () => {
    expect(definesDevScript(pkg({ absoluteDir: dir, command: null }))).toBe(false);
  });
  test('lists build and clean scripts as extra commands', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-extra-'));
    fs.writeFileSync(
      path.join(d, 'package.json'),
      JSON.stringify({ scripts: { dev: 'x', build: 'x', 'build:clean': 'x', clean: 'x' } }),
    );
    try {
      expect(menuCommandsOf(pkg({ absoluteDir: d }))).toEqual(['build', 'build:clean', 'clean']);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
  test('excludes the dev script from extra commands', () => {
    expect(menuCommandsOf(pkg({ absoluteDir: dir }))).toEqual(['build', 'build:clean', 'codegen']);
  });
  test('falls back to sh when nothing present', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-empty-'));
    expect(runnerOf(pkg({ absoluteDir: empty }))).toBe('sh');
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

describe('package script spawn spec', () => {
  let ws: string;
  let app: string; // named + versioned, with its own node_modules/.bin
  let bare: string; // no name, no version, no node_modules
  const run = (p: AnyServiceConfig, script: string, args: string[] = [], env = process.env) => {
    const spec = scriptExec(p, script, args, env);
    return execa(spec.cmd, spec.args, { cwd: p.absoluteDir, env: spec.env, reject: false });
  };
  const PRINT_ARGV = 'node -e "console.log(JSON.stringify(process.argv.slice(1)))" x';

  beforeAll(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-spawn-')));
    app = path.join(ws, 'packages', 'app');
    bare = path.join(ws, 'packages', 'bare');
    fs.mkdirSync(path.join(ws, 'node_modules', '.bin'), { recursive: true });
    fs.mkdirSync(path.join(app, 'node_modules', '.bin'), { recursive: true });
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(
      path.join(app, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.2.3',
        scripts: {
          argv: PRINT_ARGV,
          fail: 'exit 7',
          version: 'node -e "console.log(String(process.env.npm_package_version))"',
        },
      }),
    );
    fs.writeFileSync(
      path.join(bare, 'package.json'),
      JSON.stringify({
        scripts: { version: 'node -e "console.log(String(process.env.npm_package_version))"' },
      }),
    );
  });
  afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

  test("puts each ancestor's node_modules/.bin on PATH, nearest first, ahead of the given PATH", () => {
    const { env } = scriptExec(pkg({ absoluteDir: app }), 'argv', [], { PATH: '/usr/bin:/bin' });
    const entries = env.PATH!.split(':');
    expect(entries.slice(0, 2)).toEqual([
      path.join(app, 'node_modules', '.bin'),
      path.join(ws, 'node_modules', '.bin'),
    ]);
    expect(entries.slice(-2)).toEqual(['/usr/bin', '/bin']);
  });

  test('leaves out ancestors that have no node_modules/.bin', () => {
    const { env } = scriptExec(pkg({ absoluteDir: bare }), 'version', [], { PATH: '/usr/bin' });
    expect(env.PATH!.split(':')[0]).toBe(path.join(ws, 'node_modules', '.bin'));
  });

  test('keeps the given environment, without modifying it', () => {
    const given = { PATH: '/usr/bin', FOO: 'bar' };
    const { env } = scriptExec(pkg({ absoluteDir: app }), 'argv', [], given);
    expect(env.FOO).toBe('bar');
    expect(given).toEqual({ PATH: '/usr/bin', FOO: 'bar' });
  });

  test('describes the package and script being run', () => {
    const { env } = scriptExec(pkg({ absoluteDir: app }), 'fail', [], {});
    expect(env).toMatchObject({
      npm_package_name: 'app',
      npm_package_version: '1.2.3',
      npm_package_json: path.join(app, 'package.json'),
      npm_lifecycle_event: 'fail',
      npm_lifecycle_script: 'exit 7',
      INIT_CWD: app,
      PNPM_SCRIPT_SRC_DIR: app,
    });
  });

  test("does not let another package's version reach a script whose package has none", async () => {
    const result = await run(pkg({ absoluteDir: bare }), 'version', [], {
      ...process.env,
      npm_package_version: '9.9.9',
    });
    expect(result.stdout).toBe('undefined');
  });

  test('extra args reach the script intact, whatever shell syntax they contain', async () => {
    const args = ['a b', '--c=$HOME', "it's", '*', '"q"', ''];
    const result = await run(pkg({ absoluteDir: app }), 'argv', args);
    expect(JSON.parse(result.stdout)).toEqual(['x', ...args]);
  });

  test("the script's exit code is the spawned command's exit code", async () => {
    expect((await run(pkg({ absoluteDir: app }), 'fail')).exitCode).toBe(7);
  });

  test('a script that does not exist fails with exit code 1, naming it', async () => {
    const result = await run(pkg({ absoluteDir: app }), 'nope');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('Missing script: "nope"');
  });

  test('a make target gets the given environment unchanged', () => {
    const mkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-spawn-mk-'));
    fs.writeFileSync(path.join(mkdir, 'Makefile'), 'start:\n\t@true\n');
    const given = { PATH: '/usr/bin', FOO: 'bar' };
    expect(scriptExec(pkg({ absoluteDir: mkdir }), 'start', [], given).env).toEqual(given);
    fs.rmSync(mkdir, { recursive: true, force: true });
  });
});

describe('a script run as scriptExec says', () => {
  let ws: string;
  let app: string;

  beforeAll(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-runscript-')));
    app = path.join(ws, 'packages', 'app');
    for (const [dir, name] of [
      [app, 'appbin'],
      [ws, 'rootbin'],
    ] as const) {
      const bin = path.join(dir, 'node_modules', '.bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name}-OK\n`, { mode: 0o755 });
    }
    fs.writeFileSync(
      path.join(app, 'package.json'),
      JSON.stringify({
        scripts: {
          build: 'appbin && rootbin && node -e "console.log(process.cwd())"',
        },
      }),
    );
  });
  afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

  test("runs the script in the package directory, with the package's and the workspace root's node_modules/.bin on PATH", async () => {
    const { cmd, args, env } = scriptExec(pkg({ absoluteDir: app }), 'build');
    const result = await execa(cmd, args, { cwd: app, env });
    expect(String(result.stdout).split('\n')).toEqual(['appbin-OK', 'rootbin-OK', app]);
  });
});

describe('exitCodeOf', () => {
  test("is the process's own exit code when it exited", () => {
    expect(exitCodeOf({ exitCode: 0 })).toBe(0);
    expect(exitCodeOf({ exitCode: 7 })).toBe(7);
  });

  test('is 128 + the signal number when a signal killed it', () => {
    expect(exitCodeOf({ signal: 'SIGKILL' })).toBe(137);
    expect(exitCodeOf({ signal: 'SIGTERM' })).toBe(143);
  });

  test('is 1 when the process never ran', () => {
    expect(exitCodeOf({})).toBe(1);
  });
});

describe('make targets', () => {
  let mkdir: string;
  beforeAll(() => {
    mkdir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-phony-'));
    fs.writeFileSync(path.join(mkdir, 'Makefile'), '.PHONY: start\nstart:\n\t@go run .\n');
  });
  afterAll(() => fs.rmSync(mkdir, { recursive: true, force: true }));

  test('excludes make special targets like .PHONY', () => {
    expect(makeTargetsOf(pkg({ absoluteDir: mkdir }))).toEqual(['start']);
  });

  test('scriptExec uses `make <target>` and forwards extra args', () => {
    expect(scriptExec(pkg({ absoluteDir: mkdir }), 'start')).toMatchObject({
      cmd: 'make',
      args: ['start'],
    });
    expect(scriptExec(pkg({ absoluteDir: mkdir }), 'start', ['--bank-key=x'])).toMatchObject({
      cmd: 'make',
      args: ['start', '--bank-key=x'],
    });
  });

  test('menuCommandsOf does not surface .PHONY (nor the configured dev target)', () => {
    const p = pkg({
      absoluteDir: mkdir,
      command: { name: 'start', watches: false },
    });
    expect(menuCommandsOf(p)).toEqual([]);
  });
});
