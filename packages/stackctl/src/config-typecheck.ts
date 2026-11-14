import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stateDirOf } from './log-files.js';

// `start` and `run` type-check `stackctl.config.ts` with the `tsc` installed beside it before they
// do anything, and refuse a config with type errors. A plain `tsc` process, not the compiler API:
// TypeScript 7 has none.

/** The compiler options stackctl sets over the workspace's tsconfig for its check. */
const OVERRIDES = {
  noEmit: true,
  // An incremental or composite base would write its build info into the workspace.
  composite: false,
  incremental: false,
  tsBuildInfoFile: null,
  // Without `composite`, these need `declaration`, which the base may only get from it.
  emitDeclarationOnly: false,
  declarationMap: false,
};

/** Flags for a workspace without a tsconfig. */
const BARE_FLAGS = [
  '--noEmit',
  '--strict',
  '--target',
  'esnext',
  '--module',
  'nodenext',
  '--skipLibCheck',
  '--allowImportingTsExtensions',
];

/** The `tsc` script of the `typescript` installed in `dir`, or `null` when there is none. */
export function findTsc(dir: string): string | null {
  const manifest = path.join(dir, 'node_modules', 'typescript', 'package.json');
  if (!fs.existsSync(manifest)) {
    return null;
  }
  const { bin } = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const rel = typeof bin === 'string' ? bin : bin?.tsc;
  if (rel === undefined) {
    return null;
  }
  const script = path.resolve(path.dirname(manifest), rel);
  return fs.existsSync(script) ? script : null;
}

/**
 * The tsconfig `tsc -p` checks the config with: the workspace's `tsconfig`, extended, with
 * {@link OVERRIDES}, and the config file its only file. `rootDir` is the config's directory,
 * since TypeScript 7 defaults it to the directory of the tsconfig, which this one isn't in.
 */
export function checkTsconfig(configPath: string, base: string): object {
  return {
    extends: base,
    compilerOptions: { ...OVERRIDES, rootDir: path.dirname(configPath) },
    files: [configPath],
    include: [],
  };
}

/** What a check found: nothing to check with, a clean config, or tsc's report of its errors. */
export type TypecheckResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'ok' }
  | { kind: 'errors'; output: string };

/** Runs `tsc` with `args` in `cwd`, resolving with its exit code and everything it printed. */
function runTsc(tsc: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsc, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) =>
      resolve({
        code: code ?? (signal ? 1 : 0),
        out: Buffer.concat(chunks).toString('utf8'),
      }),
    );
  });
}

/**
 * Type-checks the config at `configPath` in the workspace at `root` with the `tsc` of the
 * `typescript` in the config's directory: against the `tsconfig.json` beside it, or with
 * {@link BARE_FLAGS} when there is none. A JavaScript config, or one without `typescript` beside
 * it, is skipped.
 */
export async function typecheckConfig(
  configPath: string,
  root: string,
  opts: { pretty?: boolean } = {},
): Promise<TypecheckResult> {
  if (!/\.[mc]?ts$/.test(configPath)) {
    return { kind: 'skipped', reason: 'a JavaScript config' };
  }
  const dir = path.dirname(configPath);
  const tsc = findTsc(dir);
  if (tsc === null) {
    return { kind: 'skipped', reason: 'no typescript installed' };
  }
  const pretty = ['--pretty', String(opts.pretty ?? false)];
  const base = path.join(dir, 'tsconfig.json');
  if (!fs.existsSync(base)) {
    const { code, out } = await runTsc(tsc, [...BARE_FLAGS, ...pretty, configPath], dir);
    return code === 0 ? { kind: 'ok' } : { kind: 'errors', output: out };
  }
  const stateDir = stateDirOf(root);
  fs.mkdirSync(stateDir, { recursive: true });
  const project = path.join(stateDir, `tsconfig.check-${String(process.pid)}.json`);
  fs.writeFileSync(project, JSON.stringify(checkTsconfig(configPath, base), null, 2));
  try {
    const { code, out } = await runTsc(tsc, ['-p', project, ...pretty], dir);
    return code === 0 ? { kind: 'ok' } : { kind: 'errors', output: out };
  } finally {
    fs.rmSync(project, { force: true });
  }
}

/**
 * Exits 1, printing tsc's report, when the config at `configPath` has type errors. A config it
 * can't check passes silently: `run` prints nothing but its script's output.
 */
export async function assertConfigTypechecks(configPath: string, root: string): Promise<void> {
  const result = await typecheckConfig(configPath, root, { pretty: process.stderr.isTTY });
  if (result.kind === 'errors') {
    console.error(
      `stackctl: ${path.basename(configPath)} has type errors:\n\n${result.output.trimEnd()}`,
    );
    process.exit(1);
  }
}
