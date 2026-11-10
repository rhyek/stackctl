import { defineConfig } from 'vitest/config';

// The end-to-end suite (`pnpm test:e2e`): the real CLI on a pseudo-terminal, against a fixture
// workspace. Its files share the fixture's ports, so they run one at a time. See
// `packages/stackctl/e2e/` and CLAUDE.md ("Testing changes").
export default defineConfig({
  test: {
    include: ['packages/stackctl/e2e/**/*.e2e.spec.ts'],
    fileParallelism: false,
    // Not a CI run, whatever runs the suite: see the file.
    setupFiles: ['./vitest.setup.ts'],
    // Compiles the CLI once, for every file.
    globalSetup: ['./packages/stackctl/e2e/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
