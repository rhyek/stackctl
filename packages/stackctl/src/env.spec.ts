import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import primitives from '@dotenvx/primitives';
import { describe, expect, beforeEach, afterEach, test, vi } from 'vitest';
import type { AnyServiceConfig } from './config.js';
import {
  ambientEnv,
  assignedNames,
  configEnvReader,
  currentMode,
  currentModeSource,
  dropInjectedEnv,
  envCandidatePaths,
  EnvFileSnapshot,
  envFileNames,
  envFileOrder,
  envKeysFile,
  hideDollars,
  packageEnvLayer,
  publishModeSource,
  resolveEnvFrom,
  resolveMode,
  targetEnvLayer,
  workspaceEnvLayer,
} from './env.js';
import type { ResolvedTarget } from './target.js';

/** A layer without its `STACKCTL_INJECTED_ENV` list, for the assertions about what it resolves. */
function withoutList(layer: Record<string, string>): Record<string, string> {
  const { STACKCTL_INJECTED_ENV: _list, ...vars } = layer;
  return vars;
}

let cwd: string;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-env-'));
  fs.mkdirSync(path.join(cwd, 'packages', 'api'), { recursive: true });
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

function write(rel: string, contents: string): void {
  const p = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}

/** Sets ambient vars for one assertion and always restores them. */
function withAmbient(vars: Record<string, string>, fn: () => void): void {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

describe('envFileNames', () => {
  test('is base → local → mode → mode.local, ascending precedence within a scope', () => {
    expect(envFileNames('development')).toEqual([
      '.env',
      '.env.local',
      '.env.development',
      '.env.development.local',
    ]);
  });

  test('substitutes any mode name', () => {
    expect(envFileNames('test')).toEqual(['.env', '.env.local', '.env.test', '.env.test.local']);
    expect(envFileNames('apple')).toEqual(['.env', '.env.local', '.env.apple', '.env.apple.local']);
  });

  test('defaults to the development mode when STACKCTL_MODE is unset', () => {
    withAmbient({}, () => {
      delete process.env.STACKCTL_MODE;
      expect(envFileNames()).toEqual(envFileNames('development'));
    });
  });
});

describe('resolveMode', () => {
  test('reads --mode, --mode=, and -m', () => {
    expect(resolveMode(['node', 'cli', '--mode', 'test']).mode).toBe('test');
    expect(resolveMode(['node', 'cli', '--mode=test']).mode).toBe('test');
    expect(resolveMode(['node', 'cli', '-m', 'test']).mode).toBe('test');
  });

  test('accepts the flag before or after a subcommand', () => {
    expect(resolveMode(['node', 'cli', '--mode', 'test', 'exec']).mode).toBe('test');
    expect(resolveMode(['node', 'cli', 'exec', '--mode', 'test']).mode).toBe('test');
  });

  test('stops at the first `--` so the wrapped command keeps its own flags', () => {
    // `--mode watch` here belongs to vitest, not stackctl.
    withAmbient({}, () => {
      delete process.env.STACKCTL_MODE;
      expect(resolveMode(['node', 'cli', 'exec', '--', 'vitest', '--mode', 'watch']).mode).toBe(
        'development',
      );
      // ...but a mode before the `--` still counts.
      expect(
        resolveMode(['node', 'cli', '--mode', 'test', 'exec', '--', 'vitest', '--mode', 'watch'])
          .mode,
      ).toBe('test');
    });
  });

  test('stops at an `infra <provider>` passthrough, whose flags belong to the provider', () => {
    withAmbient({}, () => {
      delete process.env.STACKCTL_MODE;
      // `-m 2g` is `docker compose build`'s memory limit, not a stackctl mode.
      expect(
        resolveMode(['node', 'cli', 'infra', 'docker-compose', 'build', '-m', '2g']).mode,
      ).toBe('development');
      expect(
        resolveMode(['node', 'cli', 'infra', 'docker-compose', 'run', '--mode=x', 'db']).mode,
      ).toBe('development');
      // ...but a mode before the provider word still counts, in either position.
      expect(
        resolveMode(['node', 'cli', '-m', 'test', 'infra', 'docker-compose', 'build', '-m', '2g'])
          .mode,
      ).toBe('test');
      expect(
        resolveMode(['node', 'cli', 'infra', '-m', 'test', 'docker-compose', '--mode', 'x']).mode,
      ).toBe('test');
      // The other infra subcommands take the mode anywhere, like `exec`.
      expect(resolveMode(['node', 'cli', 'infra', 'up', '--mode', 'test']).mode).toBe('test');
    });
  });

  test('names each source, in order: the flag, STACKCTL_MODE, the CI default, development', () => {
    const argv = ['node', 'cli'];
    const flag = [...argv, '--mode', 'staging'];
    const everything = { STACKCTL_MODE: 'qa', CI: 'true' };
    expect(resolveMode(flag, everything)).toEqual({ mode: 'staging', source: 'flag' });
    expect(resolveMode(argv, everything)).toEqual({ mode: 'qa', source: 'env' });
    expect(resolveMode(argv, { CI: 'true' })).toEqual({ mode: 'test', source: 'ci' });
    expect(resolveMode(argv, {})).toEqual({ mode: 'development', source: 'default' });
  });

  test('any CI value but false or 0 (in any case) is CI; an empty one is not', () => {
    const argv = ['node', 'cli'];
    for (const ci of ['true', '1', 'yes', 'TRUE', 'github']) {
      expect(resolveMode(argv, { CI: ci })).toEqual({ mode: 'test', source: 'ci' });
    }
    for (const ci of ['false', 'FALSE', 'False', '0', '']) {
      expect(resolveMode(argv, { CI: ci })).toEqual({ mode: 'development', source: 'default' });
    }
  });

  test('a flag after `--` is no flag: the mode comes from the environment', () => {
    expect(resolveMode(['node', 'cli', 'exec', '--', 'vitest', '--mode', 'watch'], { CI: '1' })).toEqual({ mode: 'test', source: 'ci' }); // oxfmt-ignore
  });

  test('currentMode() and currentModeSource() follow the same order without a flag', () => {
    vi.stubEnv('STACKCTL_MODE', '');
    vi.stubEnv('CI', 'true');
    expect([currentMode(), currentModeSource()]).toEqual(['test', 'ci']);
    vi.stubEnv('CI', '0');
    expect([currentMode(), currentModeSource()]).toEqual(['development', 'default']);
    vi.stubEnv('STACKCTL_MODE', 'qa');
    expect([currentMode(), currentModeSource()]).toEqual(['qa', 'env']);
    // What the CLI published wins: it saw the flag. It is the process's own, not the environment's.
    publishModeSource('flag');
    try {
      expect(currentModeSource()).toBe('flag');
      expect(Object.values(process.env)).not.toContain('flag');
    } finally {
      publishModeSource(undefined);
    }
    vi.unstubAllEnvs();
  });

  test('rejects a mode name that is not safe as a filename segment', () => {
    expect(() => resolveMode(['node', 'cli', '--mode', '../../etc'])).toThrow(/path separator/);
    expect(() => resolveMode(['node', 'cli', '--mode', '..'])).toThrow(/mode name/);
    expect(() => resolveMode(['node', 'cli', '--mode', ''])).toThrow(/mode name/);
  });

  test('allows dots inside a mode name', () => {
    expect(resolveMode(['node', 'cli', '--mode', 'e2e.ci']).mode).toBe('e2e.ci');
  });
});

describe('envCandidatePaths', () => {
  test('lists all workspace-scope files first, then package-scope files (ascending precedence)', () => {
    const paths = envCandidatePaths({
      cwd,
      relativeDir: 'packages/api',
      files: ['.env', '.env.local'],
    });
    expect(paths).toEqual([
      path.join(cwd, '.env'),
      path.join(cwd, '.env.local'),
      path.join(cwd, 'packages/api', '.env'),
      path.join(cwd, 'packages/api', '.env.local'),
    ]);
  });

  test("collapses to a single scope when relativeDir is '.'", () => {
    const paths = envCandidatePaths({ cwd, relativeDir: '.', files: ['.env', '.env.local'] });
    expect(paths).toEqual([path.join(cwd, '.env'), path.join(cwd, '.env.local')]);
  });

  test('produces the full eight-path order for a mode', () => {
    const paths = envCandidatePaths({
      cwd,
      relativeDir: 'packages/api',
      files: envFileNames('test'),
    });
    expect(paths.map((p) => path.relative(cwd, p))).toEqual([
      '.env',
      '.env.local',
      '.env.test',
      '.env.test.local',
      path.join('packages/api', '.env'),
      path.join('packages/api', '.env.local'),
      path.join('packages/api', '.env.test'),
      path.join('packages/api', '.env.test.local'),
    ]);
  });
});

describe('resolveEnvFrom', () => {
  test('loads only files that exist', () => {
    write('.env', 'A=1\n');
    const { env, files } = resolveEnvFrom({ cwd, relativeDir: 'packages/api' });
    expect(env).toEqual({ A: '1' });
    expect(files).toEqual([path.join(cwd, '.env')]);
  });

  test('package scope overrides workspace scope regardless of file rank', () => {
    write('.env.development', 'KEY=root\n');
    write('packages/api/.env', 'KEY=pkg\n');
    const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api' });
    expect(env.KEY).toBe('pkg');
  });

  test('a mode file outranks .env.local within a scope (Vite order)', () => {
    write('.env.local', 'KEY=local\n');
    write('.env.development', 'KEY=mode\n');
    const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api' });
    expect(env.KEY).toBe('mode');
  });

  test('.env.<mode>.local is the highest-ranked file in a scope', () => {
    write('.env', 'KEY=base\n');
    write('.env.local', 'KEY=local\n');
    write('.env.development', 'KEY=mode\n');
    write('.env.development.local', 'KEY=modelocal\n');
    const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api' });
    expect(env.KEY).toBe('modelocal');
  });

  test('package-scope .env.local outranks a workspace-scope mode file (scope beats mode)', () => {
    write('.env.development', 'KEY=wsmode\n');
    write('packages/api/.env.local', 'KEY=pkglocal\n');
    const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api' });
    expect(env.KEY).toBe('pkglocal');
  });

  test('modes are exclusive: another mode does not load .env.development', () => {
    write('.env', 'KEY=base\n');
    write('.env.development', 'KEY=dev\nDEV_ONLY=yes\n');
    write('.env.test', 'KEY=test\n');
    const { env } = resolveEnvFrom({
      cwd,
      relativeDir: 'packages/api',
      files: envFileNames('test'),
    });
    expect(env.KEY).toBe('test');
    expect(env.DEV_ONLY).toBeUndefined();
  });

  test('loads a custom mode', () => {
    write('.env.apple', 'KEY=apple\n');
    const { env } = resolveEnvFrom({
      cwd,
      relativeDir: 'packages/api',
      files: envFileNames('apple'),
    });
    expect(env.KEY).toBe('apple');
  });

  test('expands ${VAR} against earlier files and process.env', () => {
    withAmbient({ STACKCTL_ENV_SPEC: 'fromproc' }, () => {
      write('.env', 'BASE=hello\n');
      write('packages/api/.env.local', 'GREETING=${BASE} world\nECHO=${STACKCTL_ENV_SPEC}\n');
      const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api' });
      expect(env.GREETING).toBe('hello world');
      expect(env.ECHO).toBe('fromproc');
    });
  });

  test('supports ${VAR:-default} and ${VAR:+alt} operators', () => {
    write(
      '.env',
      'SET=yes\nA=${SET:-fallback}\nB=${MISSING:-fallback}\nC=${SET:+present}\nD=${MISSING:+present}\n',
    );
    const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api' });
    expect(env.A).toBe('yes');
    expect(env.B).toBe('fallback');
    expect(env.C).toBe('present');
    expect(env.D).toBe('');
  });

  test('returns only file-defined keys and does not mutate process.env', () => {
    write('.env', 'STACKCTL_ENV_SPEC_ONLY=x\n');
    const before = { ...process.env };
    const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api' });
    expect(Object.keys(env)).toEqual(['STACKCTL_ENV_SPEC_ONLY']);
    expect(process.env.STACKCTL_ENV_SPEC_ONLY).toBeUndefined();
    expect(process.env).toEqual(before);
  });
});

describe('resolveEnvFrom with a mode', () => {
  beforeEach(() => {
    write('.env', 'BASE=yes\n');
    write('.env.development', 'KEY=development\n');
    write('.env.test', 'KEY=test\n');
    write('.env.apple', 'KEY=apple\n');
  });

  test("loads the given mode's files", () => {
    withAmbient({ STACKCTL_MODE: 'development' }, () => {
      const { env, files } = resolveEnvFrom({ cwd, mode: 'test' });
      expect(env).toEqual({ BASE: 'yes', KEY: 'test' });
      expect(files).toEqual([path.join(cwd, '.env'), path.join(cwd, '.env.test')]);
    });
  });

  test('files take precedence over mode', () => {
    const { env, candidates } = resolveEnvFrom({ cwd, mode: 'test', files: envFileNames('apple') });
    expect(env.KEY).toBe('apple');
    expect(candidates).toEqual(envFileNames('apple').map((f) => path.join(cwd, f)));
  });

  test('without a mode, follows STACKCTL_MODE', () => {
    withAmbient({ STACKCTL_MODE: 'test' }, () => {
      expect(resolveEnvFrom({ cwd }).env.KEY).toBe('test');
    });
    withAmbient({ STACKCTL_MODE: 'apple' }, () => {
      expect(resolveEnvFrom({ cwd }).env.KEY).toBe('apple');
    });
  });

  test("without a relativeDir, reads only the workspace's files", () => {
    write('packages/api/.env.test', 'KEY=pkg\n');
    const { env, candidates } = resolveEnvFrom({ cwd, mode: 'test' });
    expect(env.KEY).toBe('test');
    expect(candidates).toEqual(envFileNames('test').map((f) => path.join(cwd, f)));
  });

  test('rejects a mode that is not a plain name', () => {
    expect(() => resolveEnvFrom({ cwd, mode: '../x' })).toThrow(/invalid --mode/);
  });
});

describe('envFileOrder', () => {
  test("is stackctl's own four files at each scope with nothing added", () => {
    const own = envFileNames('development');
    expect(envFileOrder('development')).toEqual({ workspace: own, service: own });
  });

  test("places a file before 'mode' and one after 'local' where they belong", () => {
    const order = envFileOrder('development', [
      { file: '.env.shared', after: 'local' },
      { file: '.env.development.pre', before: 'mode' },
    ]);
    expect(order.workspace).toEqual([
      '.env',
      '.env.local',
      '.env.shared',
      '.env.development.pre',
      '.env.development',
      '.env.development.local',
    ]);
    expect(order.service).toEqual(order.workspace);
  });

  test('keeps the array order of files on one anchor', () => {
    const order = envFileOrder('test', [
      { file: '.env.test.pre', before: 'mode' },
      { file: '.env.test.pre.local', before: 'mode' },
      { file: '.env.first', before: 'base' },
      { file: '.env.last', after: 'modeLocal' },
    ]);
    expect(order.workspace).toEqual([
      '.env.first',
      '.env',
      '.env.local',
      '.env.test.pre',
      '.env.test.pre.local',
      '.env.test',
      '.env.test.local',
      '.env.last',
    ]);
  });

  test('puts a file at only the scope it names', () => {
    const order = envFileOrder('development', [
      { file: '.env.ports', before: 'mode', scope: 'workspace' },
      { file: '.env.secrets', after: 'modeLocal', scope: 'service' },
    ]);
    expect(order.workspace).toContain('.env.ports');
    expect(order.workspace).not.toContain('.env.secrets');
    expect(order.service).toContain('.env.secrets');
    expect(order.service).not.toContain('.env.ports');
  });
});

describe('resolveEnvFrom with additional files', () => {
  const pre = envFileOrder('development', [
    { file: '.env.development.pre', before: 'mode' },
    { file: '.env.development.pre.local', before: 'mode' },
  ]);

  test('expands a value derived from an input read in an additional file before it', () => {
    write('.env.development.pre', 'P=1\n');
    write('.env.development.pre.local', 'P=2\n');
    write('.env.development', 'URL=x:${P}\n');
    expect(resolveEnvFrom({ cwd, files: pre }).env).toEqual({ P: '2', URL: 'x:2' });
  });

  test("gives a variable a later file of stackctl's own sets that file's value", () => {
    write('.env.development.pre', 'KEY=pre\n');
    write('.env.development.local', 'KEY=mode-local\n');
    expect(resolveEnvFrom({ cwd, files: pre }).env.KEY).toBe('mode-local');
  });

  test('loads them in their place, at both scopes', () => {
    write('.env.development', 'A=1\n');
    write('.env.development.pre', 'A=0\n');
    write('packages/api/.env.development.pre', 'B=1\n');
    const { files } = resolveEnvFrom({ cwd, relativeDir: 'packages/api', files: pre });
    expect(files.map((f) => path.relative(cwd, f))).toEqual([
      '.env.development.pre',
      '.env.development',
      path.join('packages/api', '.env.development.pre'),
    ]);
  });

  test("does not look for a workspace-scope file in a service's directory", () => {
    const files = envFileOrder('development', [
      { file: '.env.ports', before: 'mode', scope: 'workspace' },
    ]);
    write('.env.ports', 'P=root\n');
    write('packages/api/.env.ports', 'P=pkg\n');
    const { env, candidates } = resolveEnvFrom({ cwd, relativeDir: 'packages/api', files });
    expect(env.P).toBe('root');
    expect(candidates).not.toContain(path.join(cwd, 'packages/api', '.env.ports'));
  });

  test("reads the workspace's files for a service at the workspace root", () => {
    const files = envFileOrder('development', [
      { file: '.env.ports', before: 'mode', scope: 'workspace' },
      { file: '.env.secrets', before: 'mode', scope: 'service' },
    ]);
    const { candidates } = resolveEnvFrom({ cwd, relativeDir: '.', files });
    expect(candidates).toContain(path.join(cwd, '.env.ports'));
    expect(candidates).not.toContain(path.join(cwd, '.env.secrets'));
  });
});

describe('resolveEnvFrom precedence against the ambient environment', () => {
  test('the ambient environment wins over a file var of the same name', () => {
    withAmbient({ STACKCTL_ENV_OVERRIDE: 'ambient' }, () => {
      write('.env', 'STACKCTL_ENV_OVERRIDE=fromfile\n');
      const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api' });
      expect(env.STACKCTL_ENV_OVERRIDE).toBe('ambient');
    });
  });

  test('a cross-reference resolves against the ambient value the file lost to', () => {
    withAmbient({ STACKCTL_ENV_CROSS: 'ambient' }, () => {
      write('.env', 'STACKCTL_ENV_CROSS=fromfile\nDERIVED=${STACKCTL_ENV_CROSS}-x\n');
      const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api' });
      expect(env.STACKCTL_ENV_CROSS).toBe('ambient');
      expect(env.DERIVED).toBe('ambient-x');
    });
  });

  test('a file var still wins where the ambient has none', () => {
    write('.env', 'STACKCTL_ENV_FILE_ONLY=fromfile\n');
    const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api' });
    expect(env.STACKCTL_ENV_FILE_ONLY).toBe('fromfile');
  });

  test('override: [name] lets just that var beat the ambient', () => {
    withAmbient({ STACKCTL_ENV_A: 'ambientA', STACKCTL_ENV_B: 'ambientB' }, () => {
      write('.env', 'STACKCTL_ENV_A=fileA\nSTACKCTL_ENV_B=fileB\n');
      const { env } = resolveEnvFrom({
        cwd,
        relativeDir: 'packages/api',
        override: ['STACKCTL_ENV_A'],
      });
      expect(env.STACKCTL_ENV_A).toBe('fileA');
      expect(env.STACKCTL_ENV_B).toBe('ambientB');
    });
  });

  test('override: true restores blanket file-wins', () => {
    withAmbient({ STACKCTL_ENV_A: 'ambientA', STACKCTL_ENV_B: 'ambientB' }, () => {
      write('.env', 'STACKCTL_ENV_A=fileA\nSTACKCTL_ENV_B=fileB\n');
      const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api', override: true });
      expect(env.STACKCTL_ENV_A).toBe('fileA');
      expect(env.STACKCTL_ENV_B).toBe('fileB');
    });
  });

  test('an overridden self-reference extends the ambient value (append pattern)', () => {
    withAmbient({ STACKCTL_ENV_APPEND: '--import /tmp/boot.js' }, () => {
      write('.env', 'STACKCTL_ENV_APPEND=$STACKCTL_ENV_APPEND --disable-warning=Experimental\n');
      const { env } = resolveEnvFrom({
        cwd,
        relativeDir: 'packages/api',
        override: ['STACKCTL_ENV_APPEND'],
      });
      expect(env.STACKCTL_ENV_APPEND).toBe('--import /tmp/boot.js --disable-warning=Experimental');
    });
  });
});

describe('resolveEnvFrom references to an overridden variable', () => {
  const resolve = (override: boolean | string[] | undefined, vars?: Record<string, string>) =>
    resolveEnvFrom({ cwd, relativeDir: 'packages/api', override, vars }).env;

  test("expand to the file's value, not the shell's, in a later file", () => {
    write('.env', 'STACKCTL_ENV_A=/file\n');
    write('.env.local', 'STACKCTL_ENV_B=$STACKCTL_ENV_A/storage\n');
    write('packages/api/.env', 'STACKCTL_ENV_C="${STACKCTL_ENV_A}/cache"\n');
    withAmbient({ STACKCTL_ENV_A: '/shell' }, () => {
      expect(resolve(['STACKCTL_ENV_A'])).toEqual({
        STACKCTL_ENV_A: '/file',
        STACKCTL_ENV_B: '/file/storage',
        STACKCTL_ENV_C: '/file/cache',
      });
      expect(resolve(true)).toEqual({
        STACKCTL_ENV_A: '/file',
        STACKCTL_ENV_B: '/file/storage',
        STACKCTL_ENV_C: '/file/cache',
      });
      expect(resolve(undefined)).toEqual({
        STACKCTL_ENV_A: '/shell',
        STACKCTL_ENV_B: '/shell/storage',
        STACKCTL_ENV_C: '/shell/cache',
      });
    });
  });

  test("expand to the config's own var when that is what the override lets win", () => {
    write('.env', 'STACKCTL_ENV_B=$STACKCTL_ENV_A/storage\n');
    withAmbient({ STACKCTL_ENV_A: '/shell' }, () => {
      const vars = { STACKCTL_ENV_A: '/config' };
      expect(resolve(['STACKCTL_ENV_A'], vars)).toEqual({
        STACKCTL_ENV_A: '/config',
        STACKCTL_ENV_B: '/config/storage',
      });
      expect(resolve(undefined, vars)).toEqual({
        STACKCTL_ENV_A: '/shell',
        STACKCTL_ENV_B: '/shell/storage',
      });
    });
  });

  test('expand to the appended value of a self-referential override', () => {
    write('.env', 'STACKCTL_ENV_APPEND=$STACKCTL_ENV_APPEND --flag\n');
    write('.env.local', 'STACKCTL_ENV_B="node $STACKCTL_ENV_APPEND"\n');
    withAmbient({ STACKCTL_ENV_APPEND: '--import /tmp/boot.js' }, () => {
      expect(resolve(['STACKCTL_ENV_APPEND'])).toEqual({
        STACKCTL_ENV_APPEND: '--import /tmp/boot.js --flag',
        STACKCTL_ENV_B: 'node --import /tmp/boot.js --flag',
      });
    });
  });

  test('keep a dollar in the overridden value literal', () => {
    write('.env', 'STACKCTL_ENV_APPEND=$STACKCTL_ENV_APPEND --flag\n');
    write('.env.local', 'STACKCTL_ENV_B="node $STACKCTL_ENV_APPEND"\n');
    withAmbient({ STACKCTL_ENV_APPEND: "--a '$HOME' ${X}" }, () => {
      expect(resolve(['STACKCTL_ENV_APPEND'])).toEqual({
        STACKCTL_ENV_APPEND: "--a '$HOME' ${X} --flag",
        STACKCTL_ENV_B: "node --a '$HOME' ${X} --flag",
      });
    });
  });
});

describe('resolveEnvFrom with an override in force', () => {
  test("expands an overridden variable's own references by the usual rule: the shell's value", () => {
    write('.env', 'STACKCTL_ENV_A=/file\nSTACKCTL_ENV_B=$STACKCTL_ENV_A/b\n');
    withAmbient({ STACKCTL_ENV_A: '/shell', STACKCTL_ENV_B: '/shell-b' }, () => {
      const { env } = resolveEnvFrom({ cwd, relativeDir: '.', override: ['STACKCTL_ENV_B'] });
      expect(env).toEqual({ STACKCTL_ENV_A: '/shell', STACKCTL_ENV_B: '/shell/b' });
    });
  });

  test('leaves a variable the override names alone when no file sets it', () => {
    write('.env', 'STACKCTL_ENV_B=$STACKCTL_ENV_A/b\n');
    withAmbient({ STACKCTL_ENV_A: '/shell' }, () => {
      const { env } = resolveEnvFrom({ cwd, relativeDir: '.', override: ['STACKCTL_ENV_A'] });
      expect(env).toEqual({ STACKCTL_ENV_B: '/shell/b' });
    });
  });

  test('runs a command substitution once', () => {
    const counter = path.join(cwd, 'counter');
    write('.env', `STACKCTL_ENV_A=$(echo x >> ${counter}; echo ran)\n`);
    const { env } = resolveEnvFrom({ cwd, relativeDir: '.', override: ['STACKCTL_ENV_B'] });
    expect(env).toEqual({ STACKCTL_ENV_A: 'ran' });
    expect(fs.readFileSync(counter, 'utf8')).toBe('x\n');
  });
});

describe('two-stage resolution (anchor merge, then per-package)', () => {
  /**
   * What the CLI does at startup, for the duration of `fn`: note the environment the shell handed
   * over, then merge the workspace's files into `process.env`, under the config's `override`.
   * `fn` gets the shell's environment, to resolve against as the CLI's later resolutions do.
   */
  function anchored(
    override: boolean | string[] | undefined,
    fn: (shell: Record<string, string>) => void,
  ): void {
    const shell = ambientEnv();
    const { env } = resolveEnvFrom({ cwd, relativeDir: '.', ambient: shell, override });
    withAmbient(env, () => fn(shell));
  }

  // The merge puts workspace file values into `process.env`, where they look like the shell's.
  // Only a variable the shell really set may win over a file — `override` is about those alone.
  for (const { shell, override, expected } of [
    { shell: undefined, override: [], expected: '3' },
    { shell: undefined, override: ['STACKCTL_ENV_A'], expected: '3' },
    { shell: '1', override: [], expected: '1' },
    { shell: '1', override: ['STACKCTL_ENV_A'], expected: '3' },
  ]) {
    const given = shell === undefined ? 'unset in the shell' : `${shell} in the shell`;
    const overriding = override.length > 0 ? 'overridden' : 'not overridden';
    test(`a variable ${given} and ${overriding} resolves to ${expected}`, () => {
      write('.env.development', 'STACKCTL_ENV_A=2\n');
      write('packages/api/.env.development', 'STACKCTL_ENV_A=3\n');
      withAmbient(shell === undefined ? {} : { STACKCTL_ENV_A: shell }, () => {
        anchored(override, (ambient) => {
          const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api', override, ambient });
          expect(env.STACKCTL_ENV_A).toBe(expected);
        });
      });
    });
  }

  test('override: true lets the deepest file beat the shell', () => {
    write('.env', 'STACKCTL_ENV_A=2\n');
    write('packages/api/.env', 'STACKCTL_ENV_A=3\n');
    withAmbient({ STACKCTL_ENV_A: '1' }, () => {
      anchored(true, (ambient) => {
        const { env } = resolveEnvFrom({
          cwd,
          relativeDir: 'packages/api',
          override: true,
          ambient,
        });
        expect(env.STACKCTL_ENV_A).toBe('3');
      });
    });
  });

  // A session re-resolves on every restart; the value merged at startup must not shadow the file
  // it came from.
  test('picks up a workspace file edited after the merge', () => {
    write('.env', 'STACKCTL_ENV_A=before\n');
    anchored(undefined, (ambient) => {
      expect(process.env.STACKCTL_ENV_A).toBe('before');
      write('.env', 'STACKCTL_ENV_A=after\n');
      const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api', ambient });
      expect(env.STACKCTL_ENV_A).toBe('after');
    });
  });

  // The self-append pattern `env.override` exists for. The merge itself resolves without the
  // override, and the package pass expands `$VAR` against the shell's value — never against what
  // the merge left in `process.env` — so the flag is appended exactly once either way.
  test('appends a self-referential override exactly once', () => {
    write('.env', 'STACKCTL_ENV_TWOSTAGE=$STACKCTL_ENV_TWOSTAGE --flag\n');
    withAmbient({ STACKCTL_ENV_TWOSTAGE: '--import /boot.js' }, () => {
      anchored(['STACKCTL_ENV_TWOSTAGE'], (ambient) => {
        // stackctl's own environment carries the appended value, for what it starts itself…
        expect(process.env.STACKCTL_ENV_TWOSTAGE).toBe('--import /boot.js --flag');
        // …and a package's is still built from the shell's, so the flag isn't appended again.
        const { env } = resolveEnvFrom({
          cwd,
          relativeDir: 'packages/api',
          override: ['STACKCTL_ENV_TWOSTAGE'],
          ambient,
        });
        expect(env.STACKCTL_ENV_TWOSTAGE).toBe('--import /boot.js --flag');
      });
    });
  });

  test('appends a self-referential override exactly once when the shell has no value', () => {
    write('.env', 'STACKCTL_ENV_TWOSTAGE="$STACKCTL_ENV_TWOSTAGE --flag"\n');
    anchored(['STACKCTL_ENV_TWOSTAGE'], (ambient) => {
      const { env } = resolveEnvFrom({
        cwd,
        relativeDir: 'packages/api',
        override: ['STACKCTL_ENV_TWOSTAGE'],
        ambient,
      });
      expect(env.STACKCTL_ENV_TWOSTAGE).toBe(' --flag');
    });
  });
});

describe('captureShellEnv', () => {
  // A module of its own, so the recorded environment doesn't outlive the test.
  test('makes the environment at that moment the ambient one for later resolutions', async () => {
    vi.resetModules();
    const fresh = await import('./env.js');
    write('.env', 'STACKCTL_ENV_A=2\n');
    write('packages/api/.env', 'STACKCTL_ENV_A=3\n');

    fresh.captureShellEnv();
    const merged = fresh.resolveEnvFrom({ cwd, relativeDir: '.' }).env;
    withAmbient(merged, () => {
      expect(fresh.resolveEnvFrom({ cwd, relativeDir: 'packages/api' }).env.STACKCTL_ENV_A).toBe(
        '3',
      );
    });
  });

  test('keeps a variable the shell set winning over the files', async () => {
    vi.resetModules();
    const fresh = await import('./env.js');
    write('packages/api/.env', 'STACKCTL_ENV_A=3\n');
    withAmbient({ STACKCTL_ENV_A: '1' }, () => {
      fresh.captureShellEnv();
      expect(fresh.resolveEnvFrom({ cwd, relativeDir: 'packages/api' }).env.STACKCTL_ENV_A).toBe(
        '1',
      );
    });
  });
});

describe('hideDollars', () => {
  // This is the primary regression guard, and it is deliberately a property assertion rather than
  // a behavioral one. The bug it prevents is a *synchronous* infinite loop inside dotenvx, which
  // no test timeout can interrupt — a test that just called resolveEnvFrom would hang the whole runner
  // instead of failing (verified: neutering the fix blocks the suite indefinitely). Asserting the
  // invariant directly fails fast and points straight at the cause.
  test('leaves no `$` for the expander to parse', () => {
    const out = hideDollars(
      {
        SELF: '--import /boot.js ${SELF}',
        PLAIN: 'no dollars here',
        MIXED: 'a$b ${C} $D \\$E $(echo pwned)',
      },
      '<dollar>',
    );
    for (const value of Object.values(out)) {
      expect(value).not.toContain('$');
    }
    expect(out.MIXED).toBe('a<dollar>b <dollar>{C} <dollar>D \\<dollar>E <dollar>(echo pwned)');
  });

  test('leaves values without a `$` untouched', () => {
    expect(hideDollars({ A: 'plain', B: '' }, '<dollar>')).toEqual({ A: 'plain', B: '' });
  });
});

describe('resolveEnvFrom expansion safety', () => {
  // Behavioral companions to the invariant test above: with the fix these return immediately and
  // assert the *values* are right. Without it they would hang, which is why they are not the
  // primary guard.
  test(
    'does not hang when an ambient value contains a literal self-reference',
    { timeout: 5000 },
    () => {
      withAmbient({ STACKCTL_ENV_POISON: '--import /boot.js ${STACKCTL_ENV_POISON}' }, () => {
        write('.env', 'STACKCTL_ENV_POISON=$STACKCTL_ENV_POISON --flag\n');
        const { env } = resolveEnvFrom({
          cwd,
          relativeDir: 'packages/api',
          override: ['STACKCTL_ENV_POISON'],
        });
        // The inner literal is preserved verbatim rather than expanded again.
        expect(env.STACKCTL_ENV_POISON).toBe('--import /boot.js ${STACKCTL_ENV_POISON} --flag');
      });
    },
  );

  test('does not hang when the poisoned var is not overridden', { timeout: 5000 }, () => {
    withAmbient({ STACKCTL_ENV_POISON2: 'x ${STACKCTL_ENV_POISON2}' }, () => {
      write('.env', 'STACKCTL_ENV_POISON2=$STACKCTL_ENV_POISON2 --flag\n');
      const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api' });
      // Ambient wins, and comes back as the real value — no stray escape backslash.
      expect(env.STACKCTL_ENV_POISON2).toBe('x ${STACKCTL_ENV_POISON2}');
    });
  });

  test('preserves a `$` inside an ambient value instead of expanding it away', () => {
    withAmbient({ STACKCTL_ENV_DOLLAR: 'hello$world' }, () => {
      write('.env', 'MSG=${STACKCTL_ENV_DOLLAR}!\n');
      const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api' });
      expect(env.MSG).toBe('hello$world!');
    });
  });

  test('returns an ambient-won value without a stray escape backslash', () => {
    withAmbient({ STACKCTL_ENV_ESC: 'a$b' }, () => {
      write('.env', 'STACKCTL_ENV_ESC=fromfile\n');
      const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api' });
      expect(env.STACKCTL_ENV_ESC).toBe('a$b');
    });
  });

  test('round-trips an ambient value that already contains an escaped dollar', () => {
    withAmbient({ STACKCTL_ENV_PREESC: 'lit\\$eral' }, () => {
      write('.env', 'OUT=${STACKCTL_ENV_PREESC}\n');
      const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api' });
      expect(env.OUT).toBe('lit\\$eral');
    });
  });

  test('still expands file-to-file references (escaping is not over-applied)', () => {
    write('.env', 'A=one\nB=${A}/two\n');
    const { env } = resolveEnvFrom({ cwd, relativeDir: 'packages/api' });
    expect(env.B).toBe('one/two');
  });
});

describe('packageEnvLayer', () => {
  const mkPkg = (over: Partial<AnyServiceConfig>): AnyServiceConfig =>
    ({ name: 'api', relativeDir: 'packages/api', path: '/x', ...over }) as AnyServiceConfig;

  test('injects the package port as PORT, below its resolved .env vars', () => {
    write('.env', 'A=1\n');
    const layer = packageEnvLayer(mkPkg({ port: 3001 }), { cwd });
    expect(withoutList(layer)).toEqual({ PORT: '3001', A: '1' });
  });

  test('omits PORT when the package has no port, and an explicit .env PORT wins', () => {
    write('packages/api/.env', 'PORT=9999\n');
    expect(packageEnvLayer(mkPkg({}), { cwd }).PORT).toBe('9999');
    expect(packageEnvLayer(mkPkg({ port: 3001 }), { cwd }).PORT).toBe('9999');
  });

  test("ranks the config's own vars as a file below the .env files", () => {
    write('.env', 'A=1\nB=file\n');
    const layer = packageEnvLayer(mkPkg({ port: 3001 }), {
      cwd,
      vars: { B: 'config', C: 'config' },
    });
    expect(withoutList(layer)).toEqual({ PORT: '3001', A: '1', B: 'file', C: 'config' });
  });

  test("keeps the injected PORT over one set workspace-wide: in a .env file or the config's vars", () => {
    write('.env', 'PORT=9999\n');
    expect(packageEnvLayer(mkPkg({ port: 3001 }), { cwd }).PORT).toBe('3001');
    expect(packageEnvLayer(mkPkg({ port: 3001 }), { cwd, vars: { PORT: '4000' } }).PORT).toBe(
      '3001',
    );
  });

  test('passes a workspace-wide PORT on to a package that has no port of its own', () => {
    write('.env', 'PORT=9999\n');
    expect(packageEnvLayer(mkPkg({}), { cwd }).PORT).toBe('9999');
  });

  test("treats PUBLIC_ORIGIN the same way: only the package's own .env file replaces it", () => {
    const pkg = mkPkg({ publicOrigin: 'http://api.localhost:4000' });
    write('.env', 'PUBLIC_ORIGIN=https://workspace.example\n');
    expect(packageEnvLayer(pkg, { cwd }).PUBLIC_ORIGIN).toBe('http://api.localhost:4000');
    write('packages/api/.env', 'PUBLIC_ORIGIN=https://api.example\n');
    expect(packageEnvLayer(pkg, { cwd }).PUBLIC_ORIGIN).toBe('https://api.example');
  });

  test("counts the workspace's .env file as the package's own when the package is the workspace", () => {
    write('.env', 'PORT=9999\n');
    expect(packageEnvLayer(mkPkg({ relativeDir: '.', port: 3001 }), { cwd }).PORT).toBe('9999');
  });

  test("is not fooled by a PORT line inside another variable's quoted value", () => {
    write('packages/api/.env', 'NOTES="first line\nPORT=9999\nlast line"\n');
    expect(packageEnvLayer(mkPkg({ port: 3001 }), { cwd }).PORT).toBe('3001');
  });

  test('lets the shell win a PORT only where a file of the package sets one', () => {
    withAmbient({ PORT: '5000' }, () => {
      expect(packageEnvLayer(mkPkg({ port: 3001 }), { cwd }).PORT).toBe('3001');
      write('packages/api/.env', 'PORT=9999\n');
      expect(packageEnvLayer(mkPkg({ port: 3001 }), { cwd }).PORT).toBe('5000');
    });
  });

  test("lets the package's own .env file replace a config var the workspace's leaves alone", () => {
    write('packages/api/.env', 'B=package\n');
    const vars = { B: 'config' };
    expect(withoutList(packageEnvLayer(mkPkg({}), { cwd, vars }))).toEqual({ B: 'package' });
    expect(withoutList(workspaceEnvLayer({ cwd, vars }))).toEqual({ B: 'config' });
  });
});

describe('assignedNames', () => {
  test.each([
    ['plain, exported and colon-separated assignments', 'A=1\nexport B=2\nC: 3\n  D = 4 # note\n'],
    ['comments and blank lines', '# A=1\n\nB=2\n#C=3\n'],
    ['a quoted value spanning lines', 'A="one\nB=2\nthree"\nC=\'x\nD=4\'\nE=`y\nF=6`\nG=7\n'],
    ['windows line endings', 'A=1\r\nB="x\r\nC=3"\r\nD=4\r\n'],
    ['an empty value and a repeated name', 'A=\nB=1\nB=2\n'],
    ['an escaped quote inside a quoted value', 'A="say \\"hi\\"\nB=2"\nC=3\n'],
  ])('reads the names dotenvx does, with %s', (_what, source) => {
    const { parsed } = primitives.parseSync(source, { processEnv: {} });
    expect([...assignedNames(source)].sort()).toEqual(Object.keys(parsed).sort());
  });
});

describe('STACKCTL_INJECTED_ENV', () => {
  test("lists what a child gets that the shell didn't set, never STACKCTL_MODE", () => {
    vi.stubEnv('FROM_SHELL', 'shell');
    vi.stubEnv('STACKCTL_MODE', 'test');
    write('.env', 'FROM_FILE=1\nFROM_SHELL=file\n');
    const layer = workspaceEnvLayer({ cwd, vars: { FROM_CONFIG: 'x' } });
    const listed = layer.STACKCTL_INJECTED_ENV!.split(',');
    expect(listed).toEqual(expect.arrayContaining(['FROM_FILE', 'FROM_CONFIG']));
    // The shell's own value wins over the file, so the child's is the shell's: not listed.
    expect(listed).not.toContain('FROM_SHELL');
    expect(listed).not.toContain('STACKCTL_MODE');
  });

  test("a service's layer lists its PORT", () => {
    const pkg = { name: 'api', relativeDir: 'packages/api', path: '/x', port: 3001 } as unknown as AnyServiceConfig; // oxfmt-ignore
    expect(packageEnvLayer(pkg, { cwd }).STACKCTL_INJECTED_ENV!.split(',')).toContain('PORT');
  });

  test('dropInjectedEnv removes the listed variables and the list, keeping STACKCTL_MODE', () => {
    const env: NodeJS.ProcessEnv = {
      STACKCTL_INJECTED_ENV: 'A,PORT,STACKCTL_MODE',
      A: 'outer',
      PORT: '3001',
      STACKCTL_MODE: 'test',
      HOME: '/home/x',
    };
    dropInjectedEnv(env);
    expect(env).toEqual({ STACKCTL_MODE: 'test', HOME: '/home/x' });
  });

  test("a layer carries the shell's value of each variable it replaces", () => {
    vi.stubEnv('STACKCTL_ENV_FLAGS', '--shell');
    write('.env', 'STACKCTL_ENV_FLAGS="${STACKCTL_ENV_FLAGS} --repo"\nFROM_FILE=1\n');
    const layer = workspaceEnvLayer({ cwd, override: ['STACKCTL_ENV_FLAGS'] });
    expect(layer.STACKCTL_ENV_FLAGS).toBe('--shell --repo');
    // Only what the shell had set: FROM_FILE replaces nothing.
    expect(JSON.parse(layer.STACKCTL_REPLACED_ENV!)).toEqual({ STACKCTL_ENV_FLAGS: '--shell' });
    expect(layer.STACKCTL_INJECTED_ENV!.split(',')).toContain('STACKCTL_REPLACED_ENV');
  });

  test('a layer that replaces nothing of the shell carries no STACKCTL_REPLACED_ENV', () => {
    write('.env', 'FROM_FILE=1\n');
    expect(workspaceEnvLayer({ cwd })).not.toHaveProperty('STACKCTL_REPLACED_ENV');
  });

  test("dropInjectedEnv gives a replaced variable the shell's value back", () => {
    const env: NodeJS.ProcessEnv = {
      STACKCTL_INJECTED_ENV: 'A,FLAGS,STACKCTL_REPLACED_ENV',
      STACKCTL_REPLACED_ENV: '{"FLAGS":"--shell"}',
      A: 'outer',
      FLAGS: '--shell --repo',
      HOME: '/home/x',
    };
    dropInjectedEnv(env);
    expect(env).toEqual({ FLAGS: '--shell', HOME: '/home/x' });
  });

  test('dropInjectedEnv drops a STACKCTL_REPLACED_ENV it cannot read, restoring nothing', () => {
    const env: NodeJS.ProcessEnv = {
      STACKCTL_INJECTED_ENV: 'FLAGS,STACKCTL_REPLACED_ENV',
      STACKCTL_REPLACED_ENV: '{not json',
      FLAGS: '--shell --repo',
      HOME: '/home/x',
    };
    dropInjectedEnv(env);
    expect(env).toEqual({ HOME: '/home/x' });
  });

  test('a stackctl started from a child sees the shell the outer one was started in', () => {
    vi.stubEnv('STACKCTL_ENV_FLAGS', '--shell');
    write('.env', 'STACKCTL_ENV_FLAGS="${STACKCTL_ENV_FLAGS} --repo"\nFROM_FILE=1\n');
    const child: NodeJS.ProcessEnv = {
      ...process.env,
      ...workspaceEnvLayer({ cwd, override: ['STACKCTL_ENV_FLAGS'] }),
    };
    dropInjectedEnv(child);
    expect(child).toEqual({ ...process.env });
  });
});

describe('workspaceEnvLayer', () => {
  test("is the workspace-scope .env vars, never a package's", () => {
    write('.env', 'A=1\n');
    write('packages/api/.env', 'A=2\n');
    expect(withoutList(workspaceEnvLayer({ cwd }))).toEqual({ A: '1' });
  });

  test("ranks the config's own vars below the .env files", () => {
    write('.env', 'A=1\nB=file\n');
    expect(withoutList(workspaceEnvLayer({ cwd, vars: { B: 'config', C: 'config' } }))).toEqual({
      A: '1',
      B: 'file',
      C: 'config',
    });
  });
});

describe('targetEnvLayer', () => {
  const dirTarget: ResolvedTarget = {
    kind: 'directory',
    dir: '',
    relativeDir: 'scripts',
  };

  test("a directory target reads the workspace's files then its own", () => {
    write('.env', 'A=ws\nB=ws\n');
    write('scripts/.env', 'B=dir\n');
    const layer = targetEnvLayer({ ...dirTarget, dir: path.join(cwd, 'scripts') }, { cwd });
    expect(withoutList(layer)).toEqual({ A: 'ws', B: 'dir' });
    expect(layer.PORT).toBeUndefined();
    expect(layer.PUBLIC_ORIGIN).toBeUndefined();
  });

  test('a directory target gets service-scoped additional files', () => {
    write('scripts/.env.ports', 'P=dir\n');
    write('.env.ports', 'P=ws\n');
    const files = envFileOrder('development', [
      { file: '.env.ports', before: 'mode', scope: 'service' },
    ]);
    expect(withoutList(targetEnvLayer(dirTarget, { cwd, files }))).toEqual({ P: 'dir' });
  });

  test('a directory target gets the trust file unless a file sets it', () => {
    expect(targetEnvLayer(dirTarget, { cwd, extraCaCerts: '/ca.pem' }).NODE_EXTRA_CA_CERTS).toBe(
      '/ca.pem',
    );
    write('scripts/.env', 'NODE_EXTRA_CA_CERTS=/mine.pem\n');
    expect(targetEnvLayer(dirTarget, { cwd, extraCaCerts: '/ca.pem' }).NODE_EXTRA_CA_CERTS).toBe(
      '/mine.pem',
    );
  });

  test('a directory target lists what it injected', () => {
    write('scripts/.env', 'ZZ_ONLY_HERE=1\n');
    expect(targetEnvLayer(dirTarget, { cwd }).STACKCTL_INJECTED_ENV!.split(',')).toContain(
      'ZZ_ONLY_HERE',
    );
  });

  test('a root target is the workspace layer', () => {
    write('.env', 'A=1\n');
    write('packages/api/.env', 'A=2\n');
    expect(withoutList(targetEnvLayer({ kind: 'root', dir: cwd }, { cwd }))).toEqual({ A: '1' });
  });

  test("a service target is the service's layer, with its port", () => {
    const service = {
      name: 'api',
      relativeDir: 'packages/api',
      path: '/x',
      port: 3001,
    } as unknown as AnyServiceConfig;
    const layer = targetEnvLayer(
      { kind: 'service', dir: path.join(cwd, 'packages/api'), service },
      { cwd },
    );
    expect(layer.PORT).toBe('3001');
  });
});

describe("resolveEnvFrom with the config's own vars", () => {
  const resolve = (vars: Record<string, string>, override?: boolean | string[]) =>
    resolveEnvFrom({ cwd, relativeDir: 'packages/api', vars, override }).env;

  test('is just the vars when no file exists', () => {
    expect(resolve({ A: 'config', B: '' })).toEqual({ A: 'config', B: '' });
  });

  test("lets any file replace a var: the workspace's, then the package's", () => {
    write('.env', 'A=workspace\nB=workspace\n');
    write('packages/api/.env', 'B=package\n');
    expect(resolve({ A: 'config', B: 'config', C: 'config' })).toEqual({
      A: 'workspace',
      B: 'package',
      C: 'config',
    });
  });

  test('gives the ambient environment the win over a var, as over a file', () => {
    withAmbient({ STACKCTL_TEST_AMBIENT: 'shell' }, () => {
      expect(resolve({ STACKCTL_TEST_AMBIENT: 'config' })).toEqual({
        STACKCTL_TEST_AMBIENT: 'shell',
      });
    });
  });

  test('lets env.override hand a var the win back, by name or for all', () => {
    withAmbient({ STACKCTL_TEST_AMBIENT: 'shell' }, () => {
      const vars = { STACKCTL_TEST_AMBIENT: 'config' };
      expect(resolve(vars, ['STACKCTL_TEST_AMBIENT'])).toEqual(vars);
      expect(resolve(vars, true)).toEqual(vars);
      expect(resolve(vars, ['SOMETHING_ELSE'])).toEqual({ STACKCTL_TEST_AMBIENT: 'shell' });
    });
  });

  test('gives the shell the variable when the shell, a file and the config all set it', () => {
    write('.env', 'STACKCTL_TEST_AMBIENT=file\n');
    const vars = { STACKCTL_TEST_AMBIENT: 'config' };
    withAmbient({ STACKCTL_TEST_AMBIENT: 'shell' }, () => {
      expect(resolve(vars)).toEqual({ STACKCTL_TEST_AMBIENT: 'shell' });
      expect(resolve(vars, true)).toEqual({ STACKCTL_TEST_AMBIENT: 'file' });
    });
  });

  test("expands a file's reference to a var", () => {
    write('.env', 'UPLOADS=${DATA_DIR}/uploads\n');
    write('packages/api/.env', 'CACHE="$DATA_DIR/cache"\n');
    expect(resolve({ DATA_DIR: '/srv/data' })).toEqual({
      DATA_DIR: '/srv/data',
      UPLOADS: '/srv/data/uploads',
      CACHE: '/srv/data/cache',
    });
  });

  test("expands that reference to the shell's value when the shell wins the var", () => {
    write('.env', 'UPLOADS=${STACKCTL_TEST_AMBIENT}/uploads\n');
    withAmbient({ STACKCTL_TEST_AMBIENT: '/shell' }, () => {
      expect(resolve({ STACKCTL_TEST_AMBIENT: '/srv/data' }).UPLOADS).toBe('/shell/uploads');
    });
  });

  test.each([
    ['a dollar reference', 'a$b ${c} ${STACKCTL_TEST_AMBIENT}'],
    ['a command substitution', '$(echo pwned)'],
    ['a command substitution next to a single quote', "it's $(echo pwned)"],
    ['a trailing backslash', 'C:\\dir\\'],
    ['a backslash before a single quote', "it\\'s"],
    ['an escaped dollar', 'x\\$y'],
    ['double quotes and backticks', '"q" `b`'],
    ['a single quote', "it's"],
    ['a single quote next to a dollar', "it's $5 ${c}"],
    ['surrounding spaces', '  padded  '],
    ['a hash', 'a #not-a-comment'],
    ['a newline', 'line1\nline2'],
    ['backslashes', 'c:\\n\\t\\\\'],
    ['an equals sign', 'a=b'],
    ['a line that looks like an assignment', "x\nOTHER='y'"],
  ])('takes a value with %s literally', (_what, value) => {
    write('.env', 'FROM_FILE=1\n');
    withAmbient({ STACKCTL_TEST_AMBIENT: 'shell' }, () => {
      expect(resolve({ TRICKY: value, AFTER: 'after' })).toEqual({
        TRICKY: value,
        AFTER: 'after',
        FROM_FILE: '1',
      });
      expect(resolve({ TRICKY: value, AFTER: 'after' }, true)).toEqual({
        TRICKY: value,
        AFTER: 'after',
        FROM_FILE: '1',
      });
    });
  });

  test.each([
    ['', 'a$b ${c}'],
    [' next to a single quote', "it's $b ${c} \\$d"],
    [' in a command substitution next to a single quote', "it's $(echo pwned)"],
  ])('keeps a dollar%s literal when a file references the var', (_what, value) => {
    write('.env', 'COPY=${PRICE}!\n');
    const expected = { PRICE: value, COPY: `${value}!` };
    expect(resolve({ PRICE: value })).toEqual(expected);
    expect(resolve({ PRICE: value }, true)).toEqual(expected);
  });

  test('lets a file replace a var whose value has a single quote and a dollar', () => {
    write('.env', "PRICE='it\\'s \\$b'\n");
    expect(resolve({ PRICE: "it's $b" }).PRICE).toBe("it's \\$b");
  });
});

describe('encrypted values', () => {
  const secret = () => {
    const { publicKey, privateKey } = primitives.keypair();
    write(
      '.env',
      `DOTENV_PUBLIC_KEY="${publicKey}"\nSECRET="${primitives.encrypt(publicKey, 's3cret')}"\nPLAIN=1\n`,
    );
    return privateKey;
  };

  test('decrypts a value whose private key is in the ambient environment', () => {
    const privateKey = secret();
    const { env } = resolveEnvFrom({
      cwd,
      relativeDir: '.',
      ambient: { DOTENV_PRIVATE_KEY: privateKey },
    });
    expect(env).toMatchObject({ SECRET: 's3cret', PLAIN: '1' });
  });

  // A session reads `.env.keys` with its other files, off its own thread, where dotenvx would read
  // it itself, synchronously.
  test('decrypts a value whose private key is in .env.keys, read like the files', async () => {
    const privateKey = secret();
    write('.env.keys', `DOTENV_PRIVATE_KEY="${privateKey}"\n`);
    const readFileSync = vi.spyOn(fs, 'readFileSync');
    const before = process.cwd();
    process.chdir(cwd);
    try {
      const files = new EnvFileSnapshot();
      await files.refresh([envKeysFile(), ...envCandidatePaths({ cwd, relativeDir: '.' })]);
      const layer = workspaceEnvLayer({ cwd, read: files.read });
      expect(layer).toMatchObject({ SECRET: 's3cret', PLAIN: '1' });
    } finally {
      process.chdir(before);
    }
    expect(readFileSync.mock.calls.filter(([p]) => String(p).endsWith('.env.keys'))).toEqual([]);
  });

  test('leaves a value it has no key for as it is, and says which one on stderr', () => {
    secret();
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
    try {
      const { env } = resolveEnvFrom({ cwd, relativeDir: '.', ambient: {} });
      expect(env.SECRET).toMatch(/^encrypted:/);
      expect(env.PLAIN).toBe('1');
    } finally {
      spy.mockRestore();
    }
    expect(errors.join('\n')).toContain('could not decrypt SECRET');
  });
});

describe('ambientEnv', () => {
  test('snapshots process.env and drops undefined values', () => {
    process.env.STACKCTL_TEST_AMBIENT = 'yes';
    delete process.env.STACKCTL_TEST_MISSING;
    try {
      const env = ambientEnv();
      expect(env.STACKCTL_TEST_AMBIENT).toBe('yes');
      expect('STACKCTL_TEST_MISSING' in env).toBe(false);
      // A snapshot, not a live view.
      process.env.STACKCTL_TEST_AMBIENT = 'changed';
      expect(env.STACKCTL_TEST_AMBIENT).toBe('yes');
    } finally {
      delete process.env.STACKCTL_TEST_AMBIENT;
    }
  });

  test('returns real values, not the escaped copies used for expansion', () => {
    withAmbient({ STACKCTL_TEST_RAW: 'a$b' }, () => {
      expect(ambientEnv().STACKCTL_TEST_RAW).toBe('a$b');
    });
  });
});

describe('configEnvReader', () => {
  test('reads plain files as they are asked for', () => {
    write('.env', 'A=1\n');
    const read = configEnvReader([path.join(cwd, '.env'), path.join(cwd, '.env.local')]);
    expect(read(path.join(cwd, '.env'))).toBe('A=1\n');
    expect(read(path.join(cwd, '.env.local'))).toBeNull();
  });

  test('reads them all at once when one is a link', () => {
    write('store/.env.local', 'B=2\n');
    write('.env', 'A=1\n');
    fs.symlinkSync('store/.env.local', path.join(cwd, '.env.local'));
    const files = [path.join(cwd, '.env'), path.join(cwd, '.env.local'), path.join(cwd, '.env.x')];
    const read = configEnvReader(files);
    // Read already: changing them now changes nothing it answers.
    fs.writeFileSync(path.join(cwd, '.env'), 'A=changed\n');
    expect(files.map(read)).toEqual(['A=1\n', 'B=2\n', null]);
  });

  test.skipIf(process.platform === 'win32')(
    "gives up on a linked file that doesn't read in time, naming it",
    () => {
      // A FIFO with no writer stands in for a file macOS holds until access is allowed.
      fs.mkdirSync(path.join(cwd, 'store'));
      execFileSync('mkfifo', [path.join(cwd, 'store', '.env.local')]);
      fs.symlinkSync('store/.env.local', path.join(cwd, '.env.local'));
      const started = Date.now();
      expect(() => configEnvReader([path.join(cwd, '.env.local')], 300)).toThrow(
        new RegExp(`couldn't read ${path.join(cwd, '.env.local')} within 0\\.3s`),
      );
      expect(Date.now() - started).toBeLessThan(3000);
    },
  );
});
