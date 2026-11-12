/**
 * The CLI the e2e suite runs: compiled from the current source once per run (by the global setup),
 * as `cli.spec.ts` does, so no test runs against a stale `dist/` and nothing touches it. It goes
 * under the package's own `node_modules`, so its imports resolve the package's dependencies, in a
 * directory of its own: `cli.spec.ts` deletes its `cli-spec` copy as it starts, and may be running
 * at the same time. It is laid out as the published package is, `dist/` beside `assets/` and
 * `skills/`, which the compiled code reads from its own directory's parent.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const copyDir = path.join(packageDir, 'node_modules', '.cache', 'cli-e2e');
export const buildDir = path.join(copyDir, 'dist');
export const cliPath = path.join(buildDir, 'cli.js');

/**
 * TypeScript's `bin/tsc`, from the nearest `node_modules/typescript` at or above `dir`. (The global
 * setup runs where `import.meta.resolve` isn't available, and TypeScript 7 exports no `bin/tsc`.)
 */
function findTsc(dir: string): string {
  const tsc = path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
  if (fs.existsSync(tsc)) {
    return tsc;
  }
  const parent = path.dirname(dir);
  if (parent === dir) {
    throw new Error('typescript is not installed');
  }
  return findTsc(parent);
}

export async function buildCli(): Promise<void> {
  const tsc = findTsc(packageDir);
  fs.rmSync(copyDir, { recursive: true, force: true });
  for (const dir of ['assets', 'skills']) {
    fs.cpSync(path.join(packageDir, dir), path.join(copyDir, dir), { recursive: true });
  }
  await promisify(execFile)(
    process.execPath,
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
}
