import { configDefaults, defineConfig } from 'vitest/config';

// The suite is two projects, so CI can run them side by side (`--project`): `cli`, the real CLI as
// a child process (`packages/stackctl/src/cli-spec/`), and `unit`, everything else. `pnpm test`
// runs both. The end-to-end suite has a config of its own: `vitest.e2e.config.ts`.
const CLI_SPECS = 'packages/stackctl/src/cli-spec/**/*.spec.ts';

export default defineConfig({
  test: {
    // Restore all spies/mocks to their originals after each test, so a spy left
    // unrestored in one test can't leak into later tests.
    restoreMocks: true,
    // Not a CI run, whatever runs the suite: see the file.
    setupFiles: ['./vitest.setup.ts'],
    projects: [
      {
        // Inherits the options above, as every inline project does.
        extends: true,
        test: {
          name: 'unit',
          // the agent eval's guard decides what an agent under test may run: it is tested like the package
          include: ['packages/**/src/**/*.spec.ts', 'maintenance/scripts/agent-eval/**/*.spec.ts'],
          exclude: [...configDefaults.exclude, CLI_SPECS],
        },
      },
      {
        extends: true,
        test: {
          name: 'cli',
          include: [CLI_SPECS],
        },
      },
      {
        extends: true,
        test: {
          name: 'types',
          // Runs no test files: `*.test-d.ts` files assert on types (`expectTypeOf`), which only
          // the type checker enforces — see `pnpm test:types`.
          include: [],
          typecheck: {
            enabled: true,
            only: true,
            include: ['packages/**/src/**/*.test-d.ts'],
            tsconfig: './packages/stackctl/tsconfig.typecheck.json',
          },
        },
      },
    ],
  },
});
