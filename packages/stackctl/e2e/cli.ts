/**
 * The CLI the e2e suite runs: compiled from the current source once per run (by the global setup),
 * as the `src/cli-spec/` files do, so no test runs against a stale `dist/` and nothing touches it.
 * It goes under the package's own `node_modules`, so its imports resolve the package's
 * dependencies, in a directory of its own: each `cli-spec` file deletes its own copy as it starts,
 * and may be running at the same time. It is laid out as the published package is, `dist/` beside `assets/` and
 * `skills/`, which the compiled code reads from its own directory's parent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildForTests } from '../src/cli-spec/build';

export const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const copyDir = path.join(packageDir, 'node_modules', '.cache', 'cli-e2e');
export const buildDir = path.join(copyDir, 'dist');
export const cliPath = path.join(buildDir, 'cli.js');

export async function buildCli(): Promise<void> {
  fs.rmSync(copyDir, { recursive: true, force: true });
  for (const dir of ['assets', 'skills']) {
    fs.cpSync(path.join(packageDir, dir), path.join(copyDir, dir), { recursive: true });
  }
  await buildForTests(buildDir);
}
