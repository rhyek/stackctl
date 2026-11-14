import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { checkConfigTypes } from './config-typecheck.js';

// The repo's own typescript (7), linked into a workspace as the workspace's.
const TYPESCRIPT = path.resolve(import.meta.dirname, '../../../node_modules/typescript');

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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
  fs.mkdirSync(path.join(ws, 'node_modules'));
  if (typescript) {
    fs.symlinkSync(TYPESCRIPT, path.join(ws, 'node_modules', 'typescript'));
  }
  return ws;
}

/** Runs the check in `ws`: what it printed, or `null` when it passed. */
async function check(ws: string): Promise<string | null> {
  let printed: string | null = null;
  vi.spyOn(console, 'error').mockImplementation((message: string) => {
    printed = message;
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  await checkConfigTypes(ws);
  expect(exit.mock.calls).toEqual(printed === null ? [] : [[1]]);
  return printed;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, module: 'nodenext', target: 'esnext', types: [] },
});
const CLEAN = 'const port: number = 3000;\nexport default { port };\n';
const BROKEN = 'const port: number = "3000";\nexport default { port };\n';
const TS2322 =
  "stackctl.config.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.";

describe('checkConfigTypes', () => {
  test('passes a config without type errors, and writes nothing, whatever the tsconfig emits', async () => {
    const tsconfig = JSON.stringify({
      compilerOptions: {
        composite: true,
        incremental: true,
        tsBuildInfoFile: './build.tsbuildinfo',
        emitDeclarationOnly: true,
        declarationMap: true,
        outDir: 'dist',
        module: 'nodenext',
        types: [],
      },
    });
    const ws = workspace({ 'tsconfig.json': tsconfig, 'stackctl.config.ts': CLEAN });
    expect(await check(ws)).toBeNull();
    expect(fs.readdirSync(ws).sort()).toEqual([
      'node_modules',
      'package.json',
      'stackctl.config.ts',
      'tsconfig.json',
    ]);
    expect(fs.readdirSync(path.join(ws, 'node_modules', '.stackctl'))).toEqual([]);
  });

  test("exits 1 with tsc's errors for a config with a type error", async () => {
    const ws = workspace({ 'tsconfig.json': TSCONFIG, 'stackctl.config.ts': BROKEN });
    expect(await check(ws)).toBe(`stackctl: stackctl.config.ts has type errors:\n\n${TS2322}`);
  });

  test('applies the tsconfig beside the config', async () => {
    const tsconfig = JSON.stringify({
      compilerOptions: { module: 'nodenext', types: [], noUnusedLocals: true },
    });
    const config = 'const unused = 1;\nexport default {};\n';
    const ws = workspace({ 'tsconfig.json': tsconfig, 'stackctl.config.ts': config });
    expect(await check(ws)).toContain('error TS6133');
  });

  test('checks the config against declaration files, never the files themselves', async () => {
    const files = {
      'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'nodenext', types: [], skipLibCheck: false } }), // oxfmt-ignore
      'api.d.ts': 'export declare const port: number;\nexport declare const broken: Missing;\n',
      'stackctl.config.ts':
        "import { port } from './api.js';\nexport const label: string = port;\n",
    };
    const printed = await check(workspace(files));
    expect(printed).toContain('stackctl.config.ts(2,14): error TS2322');
    expect(printed).not.toContain('api.d.ts');
  });

  test("checks with stackctl's own flags when no tsconfig sits beside the config", async () => {
    expect(await check(workspace({ 'stackctl.config.ts': CLEAN }))).toBeNull();
    expect(await check(workspace({ 'stackctl.config.ts': BROKEN }))).toContain(TS2322);
  });

  test('skips a JavaScript config, and a workspace without typescript', async () => {
    expect(await check(workspace({ 'stackctl.config.mjs': 'export default {};\n' }))).toBeNull();
    expect(await check(workspace({ 'stackctl.config.ts': BROKEN }, false))).toBeNull();
  });
});

describe('which tsc runs', () => {
  /**
   * A workspace whose `typescript` is a stand-in: its `bin/tsc` prints `from the script` and fails,
   * and `getExePath`, when given, is its `lib/getExePath.js`.
   */
  function standIn(getExePath?: string): string {
    const ws = workspace({ 'tsconfig.json': TSCONFIG, 'stackctl.config.ts': CLEAN }, false);
    const pkg = path.join(ws, 'node_modules', 'typescript');
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{ "type": "module" }\n');
    fs.writeFileSync(
      path.join(pkg, 'bin', 'tsc'),
      "process.stdout.write('from the script');\nprocess.exitCode = 2;\n",
    );
    if (getExePath !== undefined) {
      fs.mkdirSync(path.join(pkg, 'lib'));
      fs.writeFileSync(path.join(pkg, 'lib', 'getExePath.js'), getExePath);
    }
    return ws;
  }
  const fromScript = 'stackctl: stackctl.config.ts has type errors:\n\nfrom the script';

  test('the binary getExePath.js names, as TypeScript 7 has it', async () => {
    const ws = standIn("export default () => new URL('./tsc-binary', import.meta.url).pathname;");
    const binary = path.join(ws, 'node_modules', 'typescript', 'lib', 'tsc-binary');
    fs.writeFileSync(binary, "#!/bin/sh\nprintf 'from the binary'\nexit 2\n", { mode: 0o755 });
    expect(await check(ws)).toBe(
      'stackctl: stackctl.config.ts has type errors:\n\nfrom the binary',
    );
  });

  test('bin/tsc, with Node.js, without getExePath.js, as TypeScript 5 and 6 have it', async () => {
    expect(await check(standIn())).toBe(fromScript);
  });

  test.each([
    ['throws', 'export default () => { throw new Error("no binary"); };'],
    ['names no file', "export default () => '/nonexistent/tsc';"],
    ['returns no string', 'export default () => 42;'],
    ['fails to load', 'export default ('],
  ])('bin/tsc when getExePath.js %s', async (_what, source) => {
    expect(await check(standIn(source))).toBe(fromScript);
  });
});
