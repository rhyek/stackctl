import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateDirOf } from './log-files.js';
import { findConfigPath } from './workspace-root.js';

// What `start` and `run` do first: type-check `stackctl.config.ts` with the `tsc` of the
// `typescript` beside it, and exit 1 on a type error. A `tsc` process, not the compiler API:
// TypeScript 7 has none.

/** Set over the tsconfig beside the config: check the config only, and write nothing. */
const OVERRIDES = {
  noEmit: true,
  composite: false,
  incremental: false,
  tsBuildInfoFile: null,
  emitDeclarationOnly: false,
  declarationMap: false,
  // Errors inside declaration files, in node_modules say, are no fault of the config's.
  skipLibCheck: true,
};

/** Without a tsconfig. */
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

/**
 * Type-checks the workspace's config at `root` and exits 1, printing tsc's errors, when it has
 * one. A JavaScript config, or one with no `typescript` beside it that runs, passes silently:
 * `run` prints nothing but its script's output.
 */
export async function checkConfigTypes(root: string = process.cwd()): Promise<void> {
  const config = findConfigPath(root);
  const tsc = config !== null && /\.[mc]?ts$/.test(config) ? await findTsc(root) : null;
  if (config === null || tsc === null) {
    return;
  }
  const pretty = ['--pretty', process.stderr.isTTY ? 'true' : 'false'];
  const base = path.join(root, 'tsconfig.json');
  // The tsconfig `-p` takes: the one beside the config, extended. `rootDir` is set since
  // TypeScript 7 defaults it to this file's directory.
  const project = path.join(stateDirOf(root), `tsconfig.check-${String(process.pid)}.json`);
  let args = [...BARE_FLAGS, ...pretty, config];
  if (fs.existsSync(base)) {
    fs.mkdirSync(path.dirname(project), { recursive: true });
    const tsconfig = { extends: base, compilerOptions: { ...OVERRIDES, rootDir: root } };
    fs.writeFileSync(project, JSON.stringify({ ...tsconfig, files: [config], include: [] }));
    args = ['-p', project, ...pretty];
  }
  const result = await run(tsc, args, root).catch(() => null);
  fs.rmSync(project, { force: true });
  if (result !== null && result.code !== 0) {
    console.error(`stackctl: ${path.basename(config)} has type errors:\n\n${result.out.trimEnd()}`);
    process.exit(1);
  }
}

/**
 * The command for the `tsc` of the `typescript` in `dir`, or `null`. TypeScript 7's `tsc` script
 * only starts its native binary, so the binary is run itself, as its `lib/getExePath.js` finds it,
 * which saves a Node.js start-up. Any other `typescript` has its `bin/tsc` run with Node.js.
 */
async function findTsc(dir: string): Promise<string[] | null> {
  const pkg = path.join(dir, 'node_modules', 'typescript');
  try {
    const locator = pathToFileURL(path.join(pkg, 'lib', 'getExePath.js')).href;
    const { default: getExePath } = (await import(locator)) as { default: () => unknown };
    const exe = getExePath();
    if (typeof exe === 'string' && fs.existsSync(exe)) {
      return [exe];
    }
  } catch {
    // Not TypeScript 7, or not as it was.
  }
  const script = path.join(pkg, 'bin', 'tsc');
  return fs.existsSync(script) ? [process.execPath, script] : null;
}

/** Runs `command` in `cwd`; resolves with its exit code and output, rejects if it can't start. */
function run(
  [command, ...prefix]: string[],
  args: string[],
  cwd: string,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command!, [...prefix, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => out.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, out: Buffer.concat(out).toString() }));
  });
}
