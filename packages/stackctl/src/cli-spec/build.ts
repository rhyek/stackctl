import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Compiles the package from the current source into `outDir`, as `pnpm build` does (the package's
 * `tsdown.config.ts`), for a suite that runs the compiled CLI or imports the compiled package. A
 * build the tests only run: no source maps, which would name sources outside the build's folder,
 * and no declarations.
 */
export async function buildForTests(outDir: string): Promise<void> {
  await build({ cwd: packageDir, outDir, sourcemap: false, dts: false, logLevel: 'warn' });
}
