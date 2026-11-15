import { defineConfig } from 'tsdown';

// The package's build (`pnpm build`): one `dist/*.js` per source file, as `tsc` lays it out, with
// the sources' extensionless relative imports written out as `./x.js`. Nothing is bundled, so
// a command still loads only its own modules, and `new URL('./cli.js', import.meta.url)` finds
// the CLI beside the module that asks.
export default defineConfig({
  entry: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.spec.{ts,tsx}',
    '!src/**/*.test-d.ts',
    '!src/cli-spec/**',
    '!src/**/*.d.ts',
  ],
  root: 'src',
  unbundle: true,
  platform: 'node',
  fixedExtension: false,
  tsconfig: 'tsconfig.build.json',
  sourcemap: true,
  // Maps name `../src/*.ts` and carry no copy of it, as `tsc`'s did.
  outputOptions: { sourcemapExcludeSources: true },
  dts: { typecheck: true },
  treeshake: false,
  minify: false,
});
