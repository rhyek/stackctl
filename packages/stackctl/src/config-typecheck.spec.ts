import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { checkTsconfig, findTsc, typecheckConfig } from './config-typecheck.js';

// The repo's own typescript, linked into each workspace as the workspace's.
const TYPESCRIPT = path.resolve(import.meta.dirname, '../../../node_modules/typescript');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A workspace with `files`, and the repo's typescript unless `typescript` is false. */
function workspace(files: Record<string, string>, typescript = true): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stackctl-tsc-')));
  dirs.push(ws);
  fs.writeFileSync(path.join(ws, 'package.json'), '{ "type": "module" }\n');
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(ws, name), content);
  }
  if (typescript) {
    fs.mkdirSync(path.join(ws, 'node_modules'));
    fs.symlinkSync(TYPESCRIPT, path.join(ws, 'node_modules', 'typescript'));
  }
  return ws;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, module: 'nodenext', target: 'esnext', types: [] },
});
const CLEAN = 'const port: number = 3000;\nexport default { port };\n';
const BROKEN = 'const port: number = "3000";\nexport default { port };\n';

const check = (ws: string, name = 'stackctl.config.ts') => typecheckConfig(path.join(ws, name), ws);

describe('typecheckConfig', () => {
  test('passes a config without type errors, against the workspace tsconfig', async () => {
    const ws = workspace({ 'tsconfig.json': TSCONFIG, 'stackctl.config.ts': CLEAN });
    expect(await check(ws)).toEqual({ kind: 'ok' });
  });

  test("reports tsc's errors for a config with type errors", async () => {
    const ws = workspace({ 'tsconfig.json': TSCONFIG, 'stackctl.config.ts': BROKEN });
    const result = await check(ws);
    expect(result.kind).toBe('errors');
    expect(result.kind === 'errors' && result.output).toContain(
      "stackctl.config.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    );
  });

  test('applies the workspace tsconfig: an option it sets is checked', async () => {
    const tsconfig = JSON.stringify({
      compilerOptions: { strict: true, module: 'nodenext', types: [], noUnusedLocals: true },
    });
    const config = 'const unused = 1;\nexport default {};\n';
    const ws = workspace({ 'tsconfig.json': tsconfig, 'stackctl.config.ts': config });
    const result = await check(ws);
    expect(result.kind === 'errors' && result.output).toContain('error TS6133');
  });

  test('writes nothing into the workspace, an incremental, composite base included', async () => {
    const tsconfig = JSON.stringify({
      compilerOptions: {
        composite: true,
        incremental: true,
        tsBuildInfoFile: './build.tsbuildinfo',
        outDir: 'dist',
        module: 'nodenext',
        types: [],
      },
      include: ['src'],
    });
    const ws = workspace({ 'tsconfig.json': tsconfig, 'stackctl.config.ts': CLEAN });
    expect(await check(ws)).toEqual({ kind: 'ok' });
    expect(fs.readdirSync(ws).sort()).toEqual([
      'node_modules',
      'package.json',
      'stackctl.config.ts',
      'tsconfig.json',
    ]);
    expect(fs.readdirSync(path.join(ws, 'node_modules', '.stackctl'))).toEqual([]);
  });

  test('accepts a base that emits only declarations, with their maps', async () => {
    const tsconfig = JSON.stringify({
      compilerOptions: {
        composite: true,
        emitDeclarationOnly: true,
        declarationMap: true,
        outDir: 'dist',
        module: 'nodenext',
        types: [],
      },
    });
    const ws = workspace({ 'tsconfig.json': tsconfig, 'stackctl.config.ts': CLEAN });
    expect(await check(ws)).toEqual({ kind: 'ok' });
  });

  test("checks with stackctl's own flags when no tsconfig sits beside the config", async () => {
    expect(await check(workspace({ 'stackctl.config.ts': CLEAN }))).toEqual({ kind: 'ok' });
    const result = await check(workspace({ 'stackctl.config.ts': BROKEN }));
    expect(result.kind === 'errors' && result.output).toContain('error TS2322');
  });

  test('skips a JavaScript config, and a workspace without typescript', async () => {
    const js = workspace({ 'stackctl.config.mjs': 'export default {};\n' });
    expect(await check(js, 'stackctl.config.mjs')).toEqual({
      kind: 'skipped',
      reason: 'a JavaScript config',
    });
    const none = workspace({ 'stackctl.config.ts': BROKEN }, false);
    expect(await check(none)).toEqual({ kind: 'skipped', reason: 'no typescript installed' });
  });
});

describe('findTsc', () => {
  test('finds the tsc script of the typescript in the directory, never one above it', () => {
    const ws = workspace({});
    const sub = path.join(ws, 'apps', 'web');
    fs.mkdirSync(sub, { recursive: true });
    expect(findTsc(ws)).toBe(path.join(ws, 'node_modules', 'typescript', 'bin', 'tsc'));
    expect(findTsc(sub)).toBeNull();
    expect(findTsc(workspace({}, false))).toBeNull();
  });
});

describe('checkTsconfig', () => {
  test('extends the base, checks only the config and roots it at its directory', () => {
    expect(checkTsconfig('/repo/stackctl.config.ts', '/repo/tsconfig.json')).toEqual({
      extends: '/repo/tsconfig.json',
      compilerOptions: {
        noEmit: true,
        composite: false,
        incremental: false,
        tsBuildInfoFile: null,
        emitDeclarationOnly: false,
        declarationMap: false,
        rootDir: '/repo',
      },
      files: ['/repo/stackctl.config.ts'],
      include: [],
    });
  });
});
